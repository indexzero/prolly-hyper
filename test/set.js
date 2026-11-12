// The port of upstream test/test-cid-set.js, plus the high-level set of
// TECHNICAL.DESIGN.md decision 8 and acceptance test 1 for the set.
//
// Upstream edits cid bytes to force boundaries (test-cid-set.js:17-28). The
// port hashes the encoded key (decision 7), so edited bytes force nothing.
// The three keys below were found by search (sslop/D-004/find-set-keys.js):
// blake2b-256 of the decimal strings "3", "6" and "9". The first two are
// boundaries at factor 3 and the third is not. The three branch entries over
// the three one-entry leaves are not boundaries, so the root is one open
// branch with three entries. The test asserts those facts before it uses them.
const test = require('brittle')
const b4a = require('b4a')
const { ProllySet, SetLeafEntry, SetBranchEntry } = require('../lib/set')
const { create, load, BranchEntry } = require('../lib/tree')
const { bf } = require('../lib/chunker')
const { Cache, nocache } = require('../lib/cache')
const {
  storage,
  randomEntries,
  sortEntries,
  seeded,
  shuffle,
  build,
  checkInvariants
} = require('./helpers')

const FACTOR = 3
const threshold = Math.floor(0xffffffff / FACTOR)
const key = (str) => b4a.from(str)
const str = (buf) => b4a.toString(buf)
const hex = (buf) => (buf === null ? null : b4a.toString(buf, 'hex'))
const unhex = (str) => b4a.from(str, 'hex')

const PINNED = [
  '581348337b0f3e148620173daaa5f94d00d881705dcbf0aa83efdaba61d2ede1',
  '7bee3bbfb37286d6a41378082e08c12af0084f0b1b92f77983f4c3394e91b5e9',
  'bcfd554527e31708adfbfdcaa46092238b452331f9c438a3f8b2d891648252a2'
].map(unhex)

async function open(opts = {}) {
  return ProllySet.open(storage(), { chunker: bf(FACTOR), ...opts })
}

async function collect(iterator) {
  const out = []
  for await (const item of iterator) out.push(item)
  return out
}

// The set oracle: `create` over the sorted keys.
async function oracle(keys) {
  return build({
    list: sortEntries(keys.map((key) => ({ key }))),
    storage: storage(),
    chunker: bf(FACTOR),
    kind: 'set'
  })
}

async function assertSameRoot(t, set, keys, label) {
  const want = await oracle(keys)
  t.is(hex(set.root), hex(want), label)
  if (set.root === null) return
  const root = await load({
    address: set.root,
    storage: set.storage,
    chunker: bf(FACTOR),
    kind: 'set'
  })
  await t.execution(() => checkInvariants(root), `${label}: invariants`)
}

// test-cid-set.js

test('cid set: the pinned keys have the pinned boundary pattern', (t) => {
  const chunker = bf(FACTOR)
  t.is(PINNED.length, 3)
  for (const k of PINNED) t.is(k.byteLength, 32)
  t.ok(b4a.compare(PINNED[0], PINNED[1]) < 0, 'the keys are sorted')
  t.ok(b4a.compare(PINNED[1], PINNED[2]) < 0, 'the keys are sorted')
  const identities = PINNED.map((k) => new SetLeafEntry({ key: k }).identity())
  t.ok(identities[0] <= threshold, 'the first key is a boundary')
  t.ok(identities[1] <= threshold, 'the second key is a boundary')
  t.ok(identities[2] > threshold, 'the third key is not a boundary')
  t.alike(
    PINNED.map((k) => chunker(new SetLeafEntry({ key: k }))),
    [true, true, false]
  )
  // Decision 7: the identity hashes the encoded key, not the key bytes.
  for (const k of PINNED) t.not(new SetLeafEntry({ key: k }).identity(), k.readUInt32LE(28))
})

for (const doCache of [true, false]) {
  test(`cid set: basic create cache=${doCache}`, async (t) => {
    const store = storage()
    const chunker = bf(FACTOR)
    const cache = doCache ? new Cache() : nocache
    // Upstream gives the list unsorted (threshold + 1, threshold - 2,
    // threshold + 2 with ascending sort bytes). `create` sorts it.
    const list = [PINNED[2], PINNED[0], PINNED[1]].map((key) => ({ key }))
    const checks = [
      { isLeaf: true, isBranch: false, entries: 1, closed: true },
      { isLeaf: true, isBranch: false, entries: 1, closed: true },
      { isLeaf: true, isBranch: false, entries: 1, closed: false },
      { isLeaf: false, isBranch: true, entries: 3, closed: false }
    ]
    const blocks = []
    let root = null
    for await (const node of create({ list, storage: store, chunker, kind: 'set', cache })) {
      const check = checks.shift()
      t.is(node.isLeaf, check.isLeaf)
      t.is(node.isBranch, check.isBranch)
      t.is(node.entryList.entries.length, check.entries)
      t.is(node.closed, check.closed)
      t.is(node.address.byteLength, 32)
      blocks.push({ address: node.address, bytes: node.bytes })
      root = node
    }
    t.is(checks.length, 0, 'every expected node was yielded')
    await store.commit({ blocks, root: root.address, expected: null })
    const n = await root.getNode(root.address)
    t.is(hex(n.address), hex(root.address))
    for (const entry of root.entryList.entries) {
      t.ok(entry instanceof BranchEntry)
      t.ok(entry instanceof SetBranchEntry)
    }
    const loaded = await load({
      address: root.address,
      storage: store,
      chunker,
      kind: 'set',
      cache
    })
    t.is(hex(loaded.address), hex(root.address))
    t.is(hex(loaded.bytes), hex(root.bytes))
    for (const { key } of list) {
      const { result } = await loaded.getEntry(key)
      t.alike(result.key, key)
      t.ok(result instanceof SetLeafEntry)
      t.is(result.value, undefined, 'a set entry has no value')
    }
    t.alike(
      (await loaded.getAllEntries()).result.map((e) => hex(e.key)),
      PINNED.map(hex)
    )
    await t.exception(loaded.getEntry(b4a.alloc(32)), { code: 'NOT_FOUND', message: 'Not found' })
  })
}

test('cid set: a set leaf encodes the key only, as wire kind 2', async (t) => {
  const nodes = []
  for await (const node of create({
    list: [{ key: PINNED[2] }],
    storage: storage(),
    chunker: bf(FACTOR),
    kind: 'set'
  })) {
    nodes.push(node)
  }
  t.is(nodes.length, 1)
  const [leaf] = nodes
  t.ok(leaf.isLeaf)
  t.is(leaf.bytes[1], 2, 'wire kind 2')
  // version, kind, flags, distance, count, key length, 32 key bytes.
  t.is(leaf.bytes.byteLength, 5 + 1 + 32)
  const asMap = create({
    list: [{ key: PINNED[2], value: b4a.alloc(0) }],
    storage: storage(),
    chunker: bf(FACTOR),
    kind: 'map'
  })
  const [mapLeaf] = await collect(asMap)
  t.unlike(mapLeaf.address, leaf.address, 'a set root differs from a map of empty values')
})

// ProllySet, decision 8

test('open on an empty storage gives an empty set', async (t) => {
  const set = await open()
  t.is(set.root, null)
  t.is(await set.has(key('a')), false)
  t.alike(await collect(set.keys()), [])
  const { root, previous } = await set.delete(key('a'))
  t.is(root, null, 'a delete on an empty tree leaves the root null')
  t.alike(previous, [])
  t.is(await set.storage.root(), null, 'nothing was committed')
})

test('add, has and delete', async (t) => {
  const set = await open()
  const r1 = await set.add(key('a'))
  t.ok(r1.root, 'a root after the first add')
  t.alike(r1.previous, [])
  t.is(await set.has(key('a')), true)
  t.is(await set.has(key('b')), false)
  t.alike(await set.storage.root(), set.root, 'the root is committed')

  const r2 = await set.add(key('a'))
  t.alike(r2.previous, [{ key: key('a') }], 'an add of a present key reports it')
  t.is(hex(r2.root), hex(r1.root), 'and leaves the root unchanged')

  await set.add(key('b'))
  const r3 = await set.delete(key('a'))
  t.alike(r3.previous, [{ key: key('a') }])
  t.is(await set.has(key('a')), false)
  t.is(await set.has(key('b')), true)

  const r4 = await set.delete(key('b'))
  t.is(r4.root, null, 'deleting the last key gives a null root')
  t.is(set.root, null)
  t.is(await set.storage.root(), null)
  t.is(await set.has(key('b')), false)
})

test('batch returns the new root and the prior keys in key order', async (t) => {
  const set = await open()
  await set.batch([{ key: key('c') }, { key: key('a') }, { key: key('b') }])
  const { root, previous } = await set.batch([
    { key: key('c') },
    { key: key('a'), del: true },
    { key: key('d') },
    { key: key('b') }
  ])
  t.alike(root, set.root)
  t.alike(
    previous.map((e) => str(e.key)),
    ['a', 'b', 'c']
  )
  t.alike((await collect(set.keys())).map(str), ['b', 'c', 'd'])
})

test('duplicate keys in one batch collapse, and the last op for a key wins', async (t) => {
  const set = await open()
  const r1 = await set.batch([{ key: key('a') }, { key: key('a') }, { key: key('a') }])
  t.alike((await collect(set.keys())).map(str), ['a'])
  t.is(hex(r1.root), hex(await oracle([key('a')])))
  await set.batch([{ key: key('b') }, { key: key('b'), del: true }])
  t.alike((await collect(set.keys())).map(str), ['a'], 'put then delete ends deleted')
  await set.batch([{ key: key('b'), del: true }, { key: key('b') }])
  t.alike((await collect(set.keys())).map(str), ['a', 'b'], 'delete then put ends present')
  const before = set.root
  const r2 = await set.batch([{ key: key('zz'), del: true }])
  t.is(hex(r2.root), hex(before), 'a delete of an absent key changes nothing')
  t.alike(r2.previous, [])
  const r3 = await set.batch([])
  t.is(hex(r3.root), hex(before), 'an empty batch changes nothing')
})

test('keys yields copies in key order inside the bounds', async (t) => {
  const set = await open()
  const names = ['a', 'b', 'c', 'd', 'e', 'f', 'g']
  await set.batch(names.map((k) => ({ key: key(k) })))
  const keys = async (bounds) => (await collect(set.keys(bounds))).map(str)
  t.alike(await keys(), names, 'no bounds yields everything')
  t.alike(await keys({ gte: key('c') }), ['c', 'd', 'e', 'f', 'g'])
  t.alike(await keys({ gt: key('c') }), ['d', 'e', 'f', 'g'])
  t.alike(await keys({ lte: key('c') }), ['a', 'b', 'c'])
  t.alike(await keys({ lt: key('c') }), ['a', 'b'])
  t.alike(await keys({ gte: key('b'), lte: key('e') }), ['b', 'c', 'd', 'e'])
  t.alike(await keys({ gt: key('b'), lt: key('e') }), ['c', 'd'])
  t.alike(await keys({ gt: key('e'), lt: key('b') }), [], 'gt above lt yields nothing')
  const [first] = await collect(set.keys({ lte: key('a') }))
  first.fill(0)
  t.alike(await keys({ lte: key('a') }), ['a'], 'a yielded key is a copy')
})

test('keys over a tree with branches matches a filter over the sorted list', async (t) => {
  const list = sortEntries(randomEntries(11, 200)).map(({ key }) => key)
  const set = await open()
  await set.batch(list.map((key) => ({ key })))
  const random = seeded(99)
  for (let i = 0; i < 30; i++) {
    const [lo, hi] = shuffle(list, random).slice(0, 2).sort(b4a.compare)
    const bounds = i % 2 === 0 ? { gte: lo, lte: hi } : { gt: lo, lt: hi }
    const want = list.filter((k) => {
      const a = b4a.compare(k, lo)
      const b = b4a.compare(k, hi)
      return i % 2 === 0 ? a >= 0 && b <= 0 : a > 0 && b < 0
    })
    t.alike((await collect(set.keys(bounds))).map(hex), want.map(hex))
  }
  t.alike((await collect(set.keys())).map(hex), list.map(hex))
})

test('string keys throw TypeError with a code, and a value is ignored', async (t) => {
  const set = await open()
  await t.exception.all(set.add('a'), { code: 'INVALID_KEY' })
  await t.exception.all(set.add('a'), TypeError)
  await t.exception.all(set.has(1), { code: 'INVALID_KEY' })
  await t.exception.all(set.delete('a'), { code: 'INVALID_KEY' })
  await t.exception.all(set.batch([{ key: key('a') }, { key: 'b' }]), { code: 'INVALID_KEY' })
  await t.exception.all(set.batch('a'), TypeError)
  await t.exception.all(collect(set.keys({ gte: 'a' })), { code: 'INVALID_KEY' })
  t.is(set.root, null, 'nothing was committed')
  await set.batch([{ key: key('a'), value: key('ignored') }])
  t.is(hex(set.root), hex(await oracle([key('a')])), 'a value on a set op is ignored')
  await t.exception.all(set.add('b'), { code: 'INVALID_KEY' })
  t.is(await set.has(key('a')), true, 'the set still works after a rejected op')
})

test('Uint8Array keys and a zero-length key are accepted', async (t) => {
  const set = await open()
  await set.add(new Uint8Array([1, 2]))
  t.is(await set.has(b4a.from([1, 2])), true)
  await set.add(b4a.alloc(0))
  t.is(await set.has(b4a.alloc(0)), true)
  t.alike((await collect(set.keys())).map(hex), ['', '0102'], 'the zero-length key sorts first')
})

test('two instances on one storage: the second writer sees CONFLICT', async (t) => {
  const store = storage()
  const a = await ProllySet.open(store, { chunker: bf(FACTOR) })
  const b = await ProllySet.open(store, { chunker: bf(FACTOR) })
  await a.add(key('a'))
  await t.exception(b.add(key('b')), { code: 'CONFLICT' })
  t.is(b.root, null, 'the loser keeps the root it read')
  t.alike(await store.root(), a.root, 'the winner is committed')
  const c = await ProllySet.open(store, { chunker: bf(FACTOR) })
  t.alike(c.root, a.root)
  t.is(await c.has(key('a')), true)
  t.is(await c.has(key('b')), false)
})

test('concurrent adds on one instance all land', async (t) => {
  const set = await open()
  const list = sortEntries(randomEntries(21, 60)).map(({ key }) => key)
  await Promise.all(list.map((key) => set.add(key)))
  await assertSameRoot(t, set, list, 'sixty concurrent adds')
  for (const k of list) t.is(await set.has(k), true)
})

test('reopen reads the committed root, with the cache on and off', async (t) => {
  const store = storage()
  const list = sortEntries(randomEntries(5, 50)).map(({ key }) => key)
  const a = await ProllySet.open(store, { chunker: bf(FACTOR) })
  for (const k of list) await a.add(k)
  const b = await ProllySet.open(store, { chunker: bf(FACTOR), cache: nocache })
  t.alike(b.root, a.root)
  for (const k of list) t.is(await b.has(k), true)
  const c = await ProllySet.open(store, { chunker: bf(FACTOR), cache: new Cache(4) })
  for (const k of list) t.is(await c.has(k), true)
  t.alike((await collect(c.keys())).map(hex), list.map(hex))
})

test('the default chunker is bf(32) and the default cache is bounded', async (t) => {
  const set = await ProllySet.open(storage())
  t.is(typeof set.chunker, 'function')
  t.ok(set.cache instanceof Cache)
  t.is(set.cache.max, 1024)
  await set.add(key('a'))
  t.is(await set.has(key('a')), true)
})

test('open rejects a storage without the interface', async (t) => {
  await t.exception.all(ProllySet.open({}), TypeError)
  await t.exception.all(ProllySet.open(null), TypeError)
})

test('root and previous are copies', async (t) => {
  const set = await open()
  const k = key('a')
  await set.add(k)
  const root = set.root
  root.fill(0)
  t.unlike(set.root, root)
  t.alike(set.root, await set.storage.root())
  const { previous } = await set.add(k)
  previous[0].key.fill(0)
  t.is(await set.has(key('a')), true, 'a returned key is a copy')
  k.fill(0)
  t.is(await set.has(key('a')), true, 'the key given to add is copied')
})

test('a set and a map over the same keys have different roots', async (t) => {
  const list = sortEntries(randomEntries(31, 40))
  const set = await open()
  await set.batch(list.map(({ key }) => ({ key })))
  const mapRoot = await build({
    list: list.map(({ key }) => ({ key, value: b4a.alloc(0) })),
    storage: storage(),
    chunker: bf(FACTOR),
    kind: 'map'
  })
  t.unlike(set.root, mapRoot)
})

// Acceptance test 1 for the set

for (const seed of [1, 2, 3]) {
  test(`set history independence, seed ${seed}, 200 keys, factor ${FACTOR}`, async (t) => {
    const random = seeded(seed * 1000)
    const list = randomEntries(seed, 200).map(({ key }) => key)
    const sorted = [...list].sort(b4a.compare)
    const rootA = await oracle(list)
    t.ok(rootA, 'build A has a root')

    // Build B: single adds in shuffled order.
    const setB = await open()
    for (const k of shuffle(list, random)) await setB.add(k)
    await assertSameRoot(t, setB, list, 'build B, shuffled adds')

    // Build C: batches of size 1 to 20 in shuffled order.
    const setC = await open()
    const shuffled = shuffle(list, random)
    let i = 0
    while (i < shuffled.length) {
      const size = 1 + Math.floor(random() * 20)
      await setC.batch(shuffled.slice(i, i + size).map((key) => ({ key })))
      i += size
    }
    await assertSameRoot(t, setC, list, 'build C, shuffled batches')

    // Build D: single adds in descending key order.
    const setD = await open()
    for (const k of [...sorted].reverse()) await setD.add(k)
    await assertSameRoot(t, setD, list, 'build D, descending adds')

    // Build E: the 180 largest keys ascending, then the 20 smallest descending.
    const setE = await open()
    for (const k of sorted.slice(20)) await setE.add(k)
    for (const k of sorted.slice(0, 20).reverse()) await setE.add(k)
    await assertSameRoot(t, setE, list, 'build E, leftmost inserts')

    // Delete a random half from B and compare with create over the rest.
    const toDelete = shuffle(list, random).slice(0, 100)
    const deleted = new Set(toDelete.map(hex))
    for (const k of toDelete) await setB.delete(k)
    const remaining = list.filter((k) => !deleted.has(hex(k)))
    await assertSameRoot(t, setB, remaining, 'B after deleting half')
    for (const k of remaining) t.is(await setB.has(k), true)
    for (const k of toDelete) t.is(await setB.has(k), false)

    // Delete everything.
    await setB.batch(remaining.map((key) => ({ key, del: true })))
    t.is(setB.root, null, 'B after deleting everything has a null root')
  })
}

test('set history independence, crash-seed3-C through ProllySet.batch in batches of 7', async (t) => {
  const fixture = require('./fixtures/crash-seed3-C.min.json')
  t.is(fixture.factor, FACTOR)
  t.is(fixture.batchSize, 7)
  t.is(fixture.ops.length, 36)
  const base = fixture.base.map((k) => b4a.from(k))
  const ops = fixture.ops.map((k) => b4a.from(k))
  const set = await open()
  await set.batch(base.map((key) => ({ key })))
  for (let i = 0; i < ops.length; i += fixture.batchSize) {
    await set.batch(ops.slice(i, i + fixture.batchSize).map((key) => ({ key })))
    await assertSameRoot(t, set, [...base, ...ops.slice(0, i + fixture.batchSize)], `after op ${i}`)
  }
  await assertSameRoot(t, set, [...base, ...ops], 'crash-seed3-C, ProllySet')
})

// Random histories against a reference JavaScript Set of hex keys.

for (const seed of [41, 42, 43]) {
  test(`set add, delete and batch history against a reference Set, seed ${seed}`, async (t) => {
    const random = seeded(seed)
    const pool = randomEntries(seed, 120).map(({ key }) => key)
    const reference = new Set()
    const set = await open()
    for (let step = 0; step < 60; step++) {
      const pick = () => pool[Math.floor(random() * pool.length)]
      const mode = random()
      if (mode < 0.4) {
        const k = pick()
        const { previous } = await set.add(k)
        t.alike(
          previous.map((e) => hex(e.key)),
          reference.has(hex(k)) ? [hex(k)] : [],
          `step ${step}: add previous`
        )
        reference.add(hex(k))
      } else if (mode < 0.7) {
        const k = pick()
        const { previous } = await set.delete(k)
        t.alike(
          previous.map((e) => hex(e.key)),
          reference.has(hex(k)) ? [hex(k)] : [],
          `step ${step}: delete previous`
        )
        reference.delete(hex(k))
      } else {
        const size = 1 + Math.floor(random() * 15)
        const ops = []
        for (let j = 0; j < size; j++) ops.push({ key: pick(), del: random() < 0.3 })
        const { previous } = await set.batch(ops)
        // The last op for a key wins. `previous` lists the keys that existed.
        const last = new Map()
        for (const op of ops) last.set(hex(op.key), op.del)
        const existed = [...last.keys()].filter((h) => reference.has(h)).sort()
        t.alike(
          previous.map((e) => hex(e.key)),
          existed,
          `step ${step}: batch previous`
        )
        for (const [h, del] of last) {
          if (del) reference.delete(h)
          else reference.add(h)
        }
      }
      const want = [...reference].sort()
      t.alike((await collect(set.keys())).map(hex), want, `step ${step}: keys`)
      t.is(hex(set.root), hex(await oracle(want.map(unhex))), `step ${step}: root equals create`)
    }
    for (const k of pool) t.is(await set.has(k), reference.has(hex(k)))
  })
}

// D-011 F-01, the set variant. A delayed read must not restore a key that a
// later delete removed.
test('a delayed read does not restore a key that a later delete removed', async (t) => {
  const store = storage()
  const writer = await ProllySet.open(store, { chunker: bf(FACTOR) })
  await writer.batch([{ key: key('a') }, { key: key('b') }])

  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  let entered
  const seen = new Promise((resolve) => {
    entered = resolve
  })
  let pending = true
  const delayed = {
    get: async (address) => {
      const bytes = await store.get(address)
      if (pending) {
        pending = false
        entered()
        await gate
      }
      return bytes
    },
    commit: (args) => store.commit(args),
    root: () => store.root()
  }

  const set = await ProllySet.open(delayed, { chunker: bf(FACTOR) })
  const read = set.has(key('a'))
  await seen
  await set.delete(key('a'))
  const committed = set.root
  release()
  t.is(await read, true, 'the pending read returns its earlier snapshot')
  t.is(await set.has(key('a')), false, 'a read after the commit sees the delete')
  t.alike(set.root, committed)
  await set.add(key('c'))
  t.is(await set.has(key('a')), false, 'the next add keeps the delete')
  const reopened = await ProllySet.open(store, { chunker: bf(FACTOR) })
  t.alike(reopened.root, set.root)
  t.is(await reopened.has(key('a')), false, 'the storage holds the delete')
  t.is(await reopened.has(key('b')), true)
  t.is(await reopened.has(key('c')), true)
})
