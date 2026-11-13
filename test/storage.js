// Acceptance test 7: storage and integrity, with `MemoryStorage` and with
// failing storage doubles.
const test = require('brittle')
const b4a = require('b4a')
const { ProllyMap } = require('../lib/map')
const { create, load } = require('../lib/tree')
const { bf } = require('../lib/chunker')
const { Cache, nocache } = require('../lib/cache')
const { MemoryStorage } = require('../lib/storage/memory')
const { address } = require('../lib/hash')
const { storage, randomEntries, sortEntries, build, collectNodes } = require('./helpers')

const key = (str) => b4a.from(str)
const val = (str) => b4a.from(str)
const hex = (buf) => (buf === null ? null : b4a.toString(buf, 'hex'))
const chunker = bf(3)

// A double that delegates to `store` and lets a test override one method.
function double(store, overrides) {
  return {
    get: (a) => store.get(a),
    commit: (args) => store.commit(args),
    root: () => store.root(),
    ...overrides
  }
}

async function tree(count = 60, seed = 1) {
  const store = storage()
  const list = sortEntries(randomEntries(seed, count))
  const root = await build({ list, storage: store, chunker })
  return { store, list, root }
}

test('MemoryStorage: get, commit and root', async (t) => {
  const store = new MemoryStorage()
  t.is(await store.root(), null)
  t.is(await store.get(b4a.alloc(32)), null)
  const bytes = val('node')
  const addr = address(bytes)
  await store.commit({ blocks: [{ address: addr, bytes }], root: addr, expected: null })
  t.alike(await store.get(addr), bytes)
  t.alike(await store.root(), addr)
  t.is(store.size, 1)
  // A second commit of the same block adds nothing.
  await store.commit({ blocks: [{ address: addr, bytes }], root: addr, expected: addr })
  t.is(store.size, 1)
  // A commit with root null deletes the root pointer, the blocks stay.
  await store.commit({ blocks: [], root: null, expected: addr })
  t.is(await store.root(), null)
  t.alike(await store.get(addr), bytes)
})

test('MemoryStorage: commit checks its arguments and writes nothing on a bad one', async (t) => {
  const store = new MemoryStorage()
  const bytes = val('node')
  const addr = address(bytes)
  await t.exception.all(store.commit({ blocks: [], root: addr }), TypeError, 'expected is required')
  await t.exception.all(store.commit({ blocks: [], expected: null }), TypeError, 'root is required')
  await t.exception.all(
    store.commit({ blocks: [{ address: b4a.alloc(4), bytes }], root: addr, expected: null }),
    TypeError,
    'a short address'
  )
  await t.exception.all(
    store.commit({ blocks: [{ address: addr, bytes }], root: b4a.alloc(4), expected: null }),
    TypeError,
    'a short root'
  )
  await t.exception.all(
    store.commit({ blocks: [{ address: addr, bytes: 'x' }], root: addr, expected: null }),
    TypeError,
    'bytes that are not bytes'
  )
  t.is(store.size, 0)
  t.is(await store.root(), null)
})

test('MemoryStorage: stored and returned buffers are copies', async (t) => {
  const store = new MemoryStorage()
  const bytes = val('node')
  const addr = address(bytes)
  const addrCopy = b4a.from(addr)
  await store.commit({ blocks: [{ address: addr, bytes }], root: addr, expected: null })
  bytes.fill(0)
  addr.fill(0)
  t.alike(await store.get(addrCopy), val('node'), 'the input buffers were copied')
  t.alike(await store.root(), addrCopy)
  const got = await store.get(addrCopy)
  got.fill(0)
  t.alike(await store.get(addrCopy), val('node'), 'the returned buffer is a copy')
  const root = await store.root()
  root.fill(0)
  t.alike(await store.root(), addrCopy)
})

test('a storage that returns the wrong bytes makes load throw ADDRESS_MISMATCH', async (t) => {
  const { store, root } = await tree()
  const other = await build({ list: [{ key: key('x'), value: val('y') }], storage: store, chunker })
  const wrong = double(store, { get: () => store.get(other) })
  const cache = new Cache()
  await t.exception(load({ address: root, storage: wrong, chunker, kind: 'map', cache }), {
    code: 'ADDRESS_MISMATCH'
  })
  t.is(cache.size, 0, 'the node never entered the cache')
  // A mismatch deeper in the tree surfaces on the read that reaches it.
  const good = await load({ address: root, storage: store, chunker, kind: 'map' })
  const leaf = (await collectNodes(good)).get(0)[0]
  const partial = double(store, {
    get: (a) => (b4a.equals(a, leaf.address) ? store.get(other) : store.get(a))
  })
  const node = await load({ address: root, storage: partial, chunker, kind: 'map' })
  await t.exception(node.getAllEntries(), { code: 'ADDRESS_MISMATCH' })
  await t.exception(node.getEntry(leaf.key), { code: 'ADDRESS_MISMATCH' })
})

test('a storage that returns null for a reachable block makes a read throw BLOCK_MISSING', async (t) => {
  const { store, root, list } = await tree()
  const good = await load({ address: root, storage: store, chunker, kind: 'map' })
  const leaf = (await collectNodes(good)).get(0)[1]
  const missing = double(store, {
    get: (a) => (b4a.equals(a, leaf.address) ? null : store.get(a))
  })
  const node = await load({ address: root, storage: missing, chunker, kind: 'map' })
  await t.exception(node.getAllEntries(), { code: 'BLOCK_MISSING' })
  await t.exception(node.getEntry(leaf.key), { code: 'BLOCK_MISSING' })
  await t.exception(node.getRangeEntries(leaf.key, b4a.alloc(32, 0xff)), { code: 'BLOCK_MISSING' })
  await t.exception(node.bulk([{ key: leaf.key, del: true }]), { code: 'BLOCK_MISSING' })
  // A key in another leaf still reads, and a missing key is NOT_FOUND, not BLOCK_MISSING.
  const otherLeaf = (await collectNodes(good)).get(0)[0]
  await t.execution(node.getEntry(otherLeaf.key))
  const absent = b4a.alloc(32, 0)
  if (!list.some((e) => b4a.equals(e.key, absent))) {
    const err = await node.getEntry(absent).catch((e) => e)
    t.ok(err.code === 'NOT_FOUND' || err.code === 'BLOCK_MISSING')
  }
  await t.exception(load({ address: b4a.alloc(32, 1), storage: store, chunker, kind: 'map' }), {
    code: 'BLOCK_MISSING'
  })
})

test('changing a key buffer, a returned value or a returned root changes nothing stored', async (t) => {
  const map = await ProllyMap.open(storage(), { chunker })
  const k = key('key')
  const v = val('value')
  await map.put(k, v)
  k.fill(0)
  v.fill(0)
  t.alike(await map.get(key('key')), val('value'), 'the input buffers were copied')
  t.is(await map.get(k), null, 'the zeroed key is another key')
  const got = await map.get(key('key'))
  got.fill(0)
  t.alike(await map.get(key('key')), val('value'), 'the returned value is a copy')
  const root = map.root
  root.fill(0)
  t.alike(map.root, await map.storage.root())
  for await (const entry of map.range()) {
    entry.key.fill(0)
    entry.value.fill(0)
  }
  t.alike(await map.get(key('key')), val('value'), 'range yields copies')
  const { previous } = await map.put(key('key'), val('value'))
  previous[0].value.fill(0)
  t.alike(await map.get(key('key')), val('value'), 'previous holds copies')
})

test('commit with a stale expected throws CONFLICT and changes nothing', async (t) => {
  const { store, root } = await tree()
  const node = await load({ address: root, storage: store, chunker, kind: 'map' })
  const { root: next, blocks } = await node.bulk([{ key: key('new'), value: val('1') }])
  const size = store.size
  await t.exception(store.commit({ blocks, root: next.address, expected: null }), {
    code: 'CONFLICT'
  })
  await t.exception(store.commit({ blocks, root: next.address, expected: next.address }), {
    code: 'CONFLICT'
  })
  t.is(store.size, size, 'no block was written')
  t.alike(await store.root(), root, 'the root is unchanged')
  await store.commit({ blocks, root: next.address, expected: root })
  t.alike(await store.root(), next.address)
})

test('a storage whose commit throws midway leaves the root unchanged and readable', async (t) => {
  const store = storage()
  const list = sortEntries(randomEntries(2, 40))
  let fail = false
  const flaky = double(store, {
    commit: async ({ blocks, root, expected }) => {
      if (!fail) return store.commit({ blocks, root, expected })
      // Half of the blocks land, then the write fails before the root.
      await store.commit({
        blocks: blocks.slice(0, Math.ceil(blocks.length / 2)),
        root: expected,
        expected
      })
      throw new Error('disk full')
    }
  })
  const map = await ProllyMap.open(flaky, { chunker })
  await map.batch(list)
  const before = map.root
  fail = true
  await t.exception(map.put(key('new'), val('1')), /disk full/)
  t.alike(map.root, before, 'the map keeps the old root')
  t.alike(await store.root(), before, 'the storage keeps the old root')
  t.is(await map.get(key('new')), null)
  for (const { key, value } of list) t.alike(await map.get(key), value)
  const reopened = await ProllyMap.open(store, { chunker, cache: nocache })
  t.alike(reopened.root, before)
  t.is(
    (await collectNodes(await load({ address: before, storage: store, chunker, kind: 'map' })))
      .size > 0,
    true
  )
  for (const { key, value } of list) t.alike(await reopened.get(key), value)
  fail = false
  await map.put(key('new'), val('1'))
  t.alike(await map.get(key('new')), val('1'), 'the map recovers')
})

test('concurrent put calls on one instance all land', async (t) => {
  const list = sortEntries(randomEntries(8, 100))
  const map = await ProllyMap.open(storage(), { chunker })
  await Promise.all(list.map(({ key, value }) => map.put(key, value)))
  for (const { key, value } of list) t.alike(await map.get(key), value)
  const want = await build({ list, storage: storage(), chunker })
  t.alike(map.root, want, 'the root equals create over the same entries')
  await Promise.all(list.slice(0, 50).map(({ key }) => map.delete(key)))
  const rest = await build({ list: list.slice(50), storage: storage(), chunker })
  t.alike(map.root, rest)
})

test('old roots stay readable after later mutations, with the cache on and off', async (t) => {
  const store = storage()
  const list = sortEntries(randomEntries(9, 100))
  for (const cache of [new Cache(), nocache, new Cache(2)]) {
    const map = await ProllyMap.open(store, { chunker, cache })
    await map.batch(list.slice(0, 50))
    const first = map.root
    await map.batch(list.slice(50))
    await map.batch(list.slice(0, 25).map(({ key }) => ({ key, del: true })))
    const old = await load({ address: first, storage: store, chunker, kind: 'map', cache })
    const { result } = await old.getAllEntries()
    t.alike(
      result.map((e) => hex(e.key)),
      list.slice(0, 50).map((e) => hex(e.key))
    )
    for (const { key, value } of list.slice(0, 50)) {
      t.alike((await old.getEntry(key)).result.value, value)
    }
    const want = await build({ list: list.slice(0, 50), storage: storage(), chunker })
    t.alike(first, want)
    await map.batch(list.map(({ key }) => ({ key, del: true })))
    t.is(map.root, null)
  }
})

test('create writes nothing to storage', async (t) => {
  const store = storage()
  const list = sortEntries(randomEntries(10, 20))
  let count = 0
  for await (const node of create({ list, storage: store, chunker, kind: 'map' })) {
    count++
    t.is(await store.get(node.address), null)
  }
  t.ok(count > 0)
  t.is(store.size, 0)
  t.is(await store.root(), null)
})
