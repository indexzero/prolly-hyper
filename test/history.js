// Acceptance tests 1 and 3: history independence and factor sensitivity.
// The oracle is `create` over the sorted list. Every incremental build must
// land on the same root. Do not weaken a failing case. Find the defect.
const test = require('brittle')
const b4a = require('b4a')
const { ProllyMap } = require('../lib/map')
const { bf } = require('../lib/chunker')
const { create, load } = require('../lib/tree')
const {
  seeded,
  randomEntries,
  shuffle,
  sortEntries,
  storage,
  build,
  checkInvariants
} = require('./helpers')

const FACTOR = 3
const hex = (buf) => (buf === null ? null : b4a.toString(buf, 'hex'))

async function oracle(list, kind = 'map') {
  return build({ list: sortEntries(list), storage: storage(), chunker: bf(FACTOR), kind })
}

async function openMap(opts = {}) {
  return ProllyMap.open(storage(), { chunker: bf(FACTOR), ...opts })
}

async function assertSameRoot(t, map, list, label) {
  const want = await oracle(list)
  t.is(hex(map.root), hex(want), label)
  const root = await load({
    address: map.root,
    storage: map.storage,
    chunker: bf(FACTOR),
    kind: 'map'
  })
  await t.execution(() => checkInvariants(root), `${label}: invariants`)
}

for (const seed of [1, 2, 3]) {
  test(`history independence, seed ${seed}, 200 keys, factor ${FACTOR}`, async (t) => {
    const random = seeded(seed * 1000)
    const list = randomEntries(seed, 200)
    const sorted = sortEntries(list)
    const rootA = await oracle(list)
    t.ok(rootA, 'build A has a root')

    // Build B: single puts in shuffled order.
    const mapB = await openMap()
    for (const { key, value } of shuffle(list, random)) await mapB.put(key, value)
    await assertSameRoot(t, mapB, list, 'build B, shuffled puts')

    // Build C: batches of size 1 to 20 in shuffled order.
    const mapC = await openMap()
    const shuffled = shuffle(list, random)
    let i = 0
    while (i < shuffled.length) {
      const size = 1 + Math.floor(random() * 20)
      await mapC.batch(shuffled.slice(i, i + size))
      i += size
    }
    await assertSameRoot(t, mapC, list, 'build C, shuffled batches')

    // Build D: single puts in descending key order.
    const mapD = await openMap()
    for (const { key, value } of [...sorted].reverse()) await mapD.put(key, value)
    await assertSameRoot(t, mapD, list, 'build D, descending puts')

    // Build E: the 180 largest keys ascending, then the 20 smallest descending,
    // so that each of the last 20 is smaller than every existing key.
    const mapE = await openMap()
    for (const { key, value } of sorted.slice(20)) await mapE.put(key, value)
    for (const { key, value } of sorted.slice(0, 20).reverse()) await mapE.put(key, value)
    await assertSameRoot(t, mapE, list, 'build E, leftmost inserts')

    // Delete a random half from B and compare with create over the rest.
    const toDelete = shuffle(list, random).slice(0, 100)
    const deleted = new Set(toDelete.map((e) => hex(e.key)))
    for (const { key } of toDelete) await mapB.delete(key)
    const remaining = list.filter((e) => !deleted.has(hex(e.key)))
    await assertSameRoot(t, mapB, remaining, 'B after deleting half')
    for (const { key, value } of remaining) t.alike(await mapB.get(key), value)
    for (const { key } of toDelete) t.is(await mapB.get(key), null)

    // Delete everything.
    await mapB.batch(remaining.map(({ key }) => ({ key, del: true })))
    t.is(mapB.root, null, 'B after deleting everything has a null root')
  })
}

test('history independence, crash-seed3-C fixture, batches of 7 over a one-key base', async (t) => {
  const fixture = require('./fixtures/crash-seed3-C.min.json')
  t.is(fixture.factor, FACTOR)
  const toEntry = (key) => ({ key: b4a.from(key), value: b4a.from(key.slice(0, 4)) })
  const base = fixture.base.map(toEntry)
  const ops = fixture.ops.map(toEntry)

  const map = await openMap()
  await map.batch(base)
  for (let i = 0; i < ops.length; i += fixture.batchSize) {
    await map.batch(ops.slice(i, i + fixture.batchSize))
  }
  await assertSameRoot(t, map, [...base, ...ops], 'crash-seed3-C')

  // The same sequence through the low-level set kind.
  const setStorage = storage()
  const setChunker = bf(FACTOR)
  let setRoot = await build({
    list: base.map(({ key }) => ({ key })),
    storage: setStorage,
    chunker: setChunker,
    kind: 'set'
  })
  for (let i = 0; i < ops.length; i += fixture.batchSize) {
    const node = await load({
      address: setRoot,
      storage: setStorage,
      chunker: setChunker,
      kind: 'set'
    })
    const { root, blocks } = await node.bulk(
      ops.slice(i, i + fixture.batchSize).map(({ key }) => ({ key }))
    )
    await setStorage.commit({ blocks, root: root.address, expected: setRoot })
    setRoot = root.address
  }
  const setWant = await build({
    list: sortEntries([...base, ...ops]).map(({ key }) => ({ key })),
    storage: storage(),
    chunker: setChunker,
    kind: 'set'
  })
  t.is(hex(setRoot), hex(setWant), 'crash-seed3-C, set kind')
})

test('history independence on tiny trees: the three-key case of decision 11', async (t) => {
  // Upstream bulk over ['02'] then ['01'] then ['00'] gives root keys ['00', '01'].
  // create over the three gives ['00', '02']. The port must give the create root.
  const list = ['00', '01', '02'].map((k) => ({ key: b4a.from(k), value: b4a.from(k) }))
  const map = await openMap()
  for (const e of [...list].reverse()) await map.put(e.key, e.value)
  await assertSameRoot(t, map, list, 'three keys inserted in descending order')
})

test('factor sensitivity: factor 3 and factor 32 give different roots', async (t) => {
  const list = randomEntries(7, 50)
  const root3 = await build({ list: sortEntries(list), storage: storage(), chunker: bf(3) })
  const root32 = await build({ list: sortEntries(list), storage: storage(), chunker: bf(32) })
  t.unlike(root3, root32)
})

test('bf rejects factors outside 2 to 0xFFFFFFFF with INVALID_FACTOR', (t) => {
  for (const factor of [1, 0, -1, 1.5, NaN, Infinity, '3', 2 ** 32, 2 ** 53]) {
    t.exception.all(() => bf(factor), { code: 'INVALID_FACTOR' }, `bf(${String(factor)})`)
    t.exception.all(() => bf(factor), RangeError, `bf(${String(factor)}) is a RangeError`)
  }
  t.execution(() => bf(2))
  t.execution(() => bf(0xffffffff))
})

test('a chunker that always returns true makes create throw CHUNKER_NO_PROGRESS', async (t) => {
  const list = [
    { key: b4a.from('a'), value: b4a.from('1') },
    { key: b4a.from('b'), value: b4a.from('2') }
  ]
  const chunker = () => true
  let levels = 0
  await t.exception(
    async () => {
      for await (const node of create({ list, storage: storage(), chunker, kind: 'map' })) {
        if (node.entryList.entries.length !== 1) t.fail('every node has one entry')
        levels = Math.max(levels, node.distance + 1)
      }
    },
    { code: 'CHUNKER_NO_PROGRESS' }
  )
  t.is(levels, 32, 'throws after 32 levels')
})

test('a chunker that always returns true makes bulk throw CHUNKER_NO_PROGRESS', async (t) => {
  const store = storage()
  const chunker = () => true
  const one = [{ key: b4a.from('a'), value: b4a.from('1') }]
  const address = await build({ list: one, storage: store, chunker })
  const root = await load({ address, storage: store, chunker, kind: 'map' })
  await t.exception(root.bulk([{ key: b4a.from('b'), value: b4a.from('2') }]), {
    code: 'CHUNKER_NO_PROGRESS'
  })
})
