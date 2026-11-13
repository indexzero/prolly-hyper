// The cache of decision 10 and the port of upstream test/test-cache.js.
const test = require('brittle')
const b4a = require('b4a')
const { Cache, nocache, DEFAULT_MAX } = require('../lib/cache')
const { load } = require('../lib/tree')
const { bf } = require('../lib/chunker')
const { storage, randomEntries, sortEntries, build } = require('./helpers')

const fake = (n) => ({ address: b4a.alloc(32, n), n })

test('nocache get error', (t) => {
  t.exception(() => nocache.get(b4a.alloc(32)), /Cannot ask for entries from nocache/)
  t.is(nocache.has(b4a.alloc(32)), false)
  t.execution(() => nocache.set(fake(1)))
  t.is(nocache.has(b4a.alloc(32, 1)), false)
})

test('a missing address is Not found', (t) => {
  const cache = new Cache()
  t.exception(() => cache.get(b4a.alloc(32)), /Not found/)
})

test('set, has and get, keyed by the address bytes', (t) => {
  const cache = new Cache()
  const node = fake(1)
  cache.set(node)
  t.is(cache.has(b4a.alloc(32, 1)), true, 'another buffer with the same bytes')
  t.is(cache.has(new Uint8Array(32).fill(1)), true)
  t.is(cache.get(b4a.alloc(32, 1)), node)
  t.is(cache.has(b4a.alloc(32, 2)), false)
  t.is(cache.size, 1)
  cache.set(fake(1))
  t.is(cache.size, 1, 'a second set of the same address replaces the entry')
})

test('the default bound is 1024 and the bound is checked', (t) => {
  t.is(new Cache().max, 1024)
  t.is(DEFAULT_MAX, 1024)
  t.exception.all(() => new Cache(0), RangeError)
  t.exception.all(() => new Cache(1.5), RangeError)
  t.exception.all(() => new Cache(-1), RangeError)
})

test('an insert past the bound evicts the least recently used entry', (t) => {
  const cache = new Cache(3)
  cache.set(fake(1))
  cache.set(fake(2))
  cache.set(fake(3))
  t.is(cache.size, 3)
  cache.set(fake(4))
  t.is(cache.size, 3)
  t.is(cache.has(fake(1).address), false, 'the first entry is evicted')
  t.is(cache.has(fake(2).address), true)
  // A get moves the entry to the end.
  cache.get(fake(2).address)
  cache.set(fake(5))
  t.is(cache.has(fake(3).address), false, 'the oldest untouched entry is evicted')
  t.is(cache.has(fake(2).address), true, 'the touched entry survives')
  t.is(cache.has(fake(4).address), true)
  t.is(cache.has(fake(5).address), true)
  cache.clear()
  t.is(cache.size, 0)
})

test('load fills the cache and a second load reads from it', async (t) => {
  const store = storage()
  const list = sortEntries(randomEntries(12, 60))
  const chunker = bf(3)
  const root = await build({ list, storage: store, chunker })
  let gets = 0
  const counting = { get: (a) => (gets++, store.get(a)) }
  const cache = new Cache()
  const node = await load({ address: root, storage: counting, chunker, kind: 'map', cache })
  t.is(gets, 1)
  t.is(cache.size, 1)
  const cached = cache.get(root)
  t.alike(cached.address, node.address, 'the cache holds the decoded block of the root')
  t.alike(cached.bytes, node.bytes)
  t.not(cached, node, 'the cache holds no node')
  await node.getAllEntries()
  const afterAll = gets
  t.ok(afterAll > 1)
  await node.getAllEntries()
  t.is(gets, afterAll, 'every node came from the cache')
  const again = await load({ address: root, storage: counting, chunker, kind: 'map', cache })
  t.not(again, node, 'a new node bound to this load')
  t.alike(again.address, node.address)
  t.alike(again.bytes, node.bytes)
  t.is(gets, afterAll)
})

test('a small cache still gives right answers', async (t) => {
  const store = storage()
  const list = sortEntries(randomEntries(13, 80))
  const chunker = bf(3)
  const root = await build({ list, storage: store, chunker })
  const cache = new Cache(2)
  const node = await load({ address: root, storage: store, chunker, kind: 'map', cache })
  for (const { key, value } of list) t.alike((await node.getEntry(key)).result.value, value)
  t.ok(cache.size <= 2)
})

// D-011 F-02. The cache is keyed by the address alone. A hit must not hand
// back a node bound to the kind, chunker or storage of an earlier load.

test('a shared cache across two kinds throws KIND_MISMATCH on the second load', async (t) => {
  const store = storage()
  const chunker = bf(3)
  const cache = new Cache()
  // A one-leaf map: the leaf kind is checked when the root loads.
  const leafRoot = await build({
    list: [{ key: b4a.from('a'), value: b4a.from('1') }],
    storage: store,
    chunker
  })
  const leaf = await load({ address: leafRoot, storage: store, chunker, kind: 'map', cache })
  t.is(leaf.kind, 'map')
  t.ok(leaf.isLeaf)
  await t.exception(load({ address: leafRoot, storage: store, chunker, kind: 'set', cache }), {
    code: 'KIND_MISMATCH'
  })
  // A map with branches: the root loads for both kinds. The read that reaches
  // a cached leaf throws.
  const list = sortEntries(randomEntries(12, 60))
  const root = await build({ list, storage: store, chunker })
  const asMap = await load({ address: root, storage: store, chunker, kind: 'map', cache })
  t.ok(asMap.isBranch)
  t.is((await asMap.getAllEntries()).result.length, 60, 'every leaf is in the cache')
  const asSet = await load({ address: root, storage: store, chunker, kind: 'set', cache })
  t.is(asSet.kind, 'set')
  await t.exception(asSet.getEntry(list[0].key), { code: 'KIND_MISMATCH' })
  await t.exception(asSet.getAllEntries(), { code: 'KIND_MISMATCH' })
  t.alike((await asMap.getEntry(list[0].key)).result.value, list[0].value, 'the map still reads')
})

test('a shared cache across two chunkers gives the root of the uncached load for each', async (t) => {
  const store = storage()
  const list = sortEntries(randomEntries(13, 60))
  const root = await build({ list, storage: store, chunker: bf(3) })
  const ops = randomEntries(14, 16)
  const want = {}
  for (const factor of [3, 32]) {
    const node = await load({ address: root, storage: store, chunker: bf(factor), kind: 'map' })
    want[factor] = (await node.bulk(ops)).root.address
  }
  t.unlike(want[3], want[32], 'the two chunkers give different roots for the same bulk')
  for (const order of [
    [3, 32],
    [32, 3]
  ]) {
    const cache = new Cache()
    for (const factor of order) {
      const node = await load({
        address: root,
        storage: store,
        chunker: bf(factor),
        kind: 'map',
        cache
      })
      t.alike(
        (await node.bulk(ops)).root.address,
        want[factor],
        `factor ${factor}, loaded ${order.indexOf(factor) === 0 ? 'first' : 'second'}, through the shared cache`
      )
    }
  }
})

test('a shared cache across two storages reads children from the storage of the load', async (t) => {
  const list = sortEntries(randomEntries(15, 60))
  const chunker = bf(3)
  const storeA = storage()
  const storeB = storage()
  const root = await build({ list, storage: storeA, chunker })
  t.alike(await build({ list, storage: storeB, chunker }), root, 'the same entries, the same root')
  let getsA = 0
  let getsB = 0
  let gone = false
  const countA = {
    get: (a) => {
      if (gone) throw new Error('storage A is gone')
      getsA++
      return storeA.get(a)
    }
  }
  const countB = { get: (a) => (getsB++, storeB.get(a)) }
  const cache = new Cache()
  const fromA = await load({ address: root, storage: countA, chunker, kind: 'map', cache })
  t.is(getsA, 1)
  const fromB = await load({ address: root, storage: countB, chunker, kind: 'map', cache })
  t.is(getsB, 0, 'the root came from the cache')
  t.alike(fromB.address, fromA.address)
  gone = true
  const { result } = await fromB.getAllEntries()
  t.is(result.length, 60, 'the node from the second load reads every entry')
  t.is(getsA, 1, 'no child was read from storage A')
  t.ok(getsB > 0, 'every child came from storage B')
})

// D-011 F-05. A bad cache size throws `INVALID_CACHE_SIZE`, with a code.
test('a bad cache size throws INVALID_CACHE_SIZE', (t) => {
  for (const max of [0, -1, 1.5, NaN, 'x', Infinity]) {
    t.exception.all(() => new Cache(max), { code: 'INVALID_CACHE_SIZE' }, `max ${String(max)}`)
    t.exception.all(() => new Cache(max), RangeError, `max ${String(max)} is a RangeError`)
  }
  t.is(new Cache(1).max, 1)
})
