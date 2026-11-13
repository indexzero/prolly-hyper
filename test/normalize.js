// Acceptance test 6: the normalization of decision 5.
const test = require('brittle')
const b4a = require('b4a')
const { ProllyMap } = require('../lib/map')
const { create, normalizeOps, KINDS } = require('../lib/tree')
const { bf } = require('../lib/chunker')
const { storage, randomEntries, sortEntries, seeded, shuffle, build } = require('./helpers')

const key = (str) => b4a.from(str)
const val = (str) => b4a.from(str)
const str = (buf) => b4a.toString(buf)
const hex = (buf) => (buf === null ? null : b4a.toString(buf, 'hex'))

// A storage that counts commits.
function countingStorage() {
  const store = storage()
  const commit = store.commit.bind(store)
  store.commits = 0
  store.commit = async (args) => {
    store.commits++
    return commit(args)
  }
  return store
}

async function open() {
  return ProllyMap.open(countingStorage(), { chunker: bf(3) })
}

test('a put then a delete of the same key in one batch ends deleted', async (t) => {
  const map = await open()
  await map.put(key('x'), val('0'))
  await map.batch([
    { key: key('a'), value: val('1') },
    { key: key('a'), del: true }
  ])
  t.is(await map.get(key('a')), null)
  t.alike(await map.get(key('x')), val('0'))
})

test('a delete then a put of the same key in one batch ends with the put', async (t) => {
  const map = await open()
  await map.put(key('a'), val('0'))
  await map.batch([
    { key: key('a'), del: true },
    { key: key('a'), value: val('1') }
  ])
  t.alike(await map.get(key('a')), val('1'))
  await map.batch([
    { key: key('b'), del: true },
    { key: key('b'), value: val('2') },
    { key: key('b'), value: val('3') }
  ])
  t.alike(await map.get(key('b')), val('3'), 'the last operation wins')
})

test('a put then a delete on an empty tree leaves the root null', async (t) => {
  const map = await open()
  const { root } = await map.batch([
    { key: key('a'), value: val('1') },
    { key: key('a'), del: true }
  ])
  t.is(root, null)
  t.is(map.storage.commits, 0, 'nothing was committed')
})

test('a delete of an absent key leaves the root unchanged and commits nothing', async (t) => {
  const map = await open()
  await map.put(key('a'), val('1'))
  const before = hex(map.root)
  const commits = map.storage.commits
  const { root, previous } = await map.delete(key('zzz'))
  t.is(hex(root), before)
  t.is(hex(map.root), before)
  t.alike(previous, [])
  t.is(map.storage.commits, commits)
  await map.batch([
    { key: key('b'), del: true },
    { key: key('c'), del: true }
  ])
  t.is(hex(map.root), before)
  t.is(map.storage.commits, commits)
})

test('an empty batch leaves the root unchanged and commits nothing', async (t) => {
  const map = await open()
  const empty = await map.batch([])
  t.is(empty.root, null)
  t.is(map.storage.commits, 0)
  await map.put(key('a'), val('1'))
  const before = hex(map.root)
  const commits = map.storage.commits
  const { root, previous } = await map.batch([])
  t.is(hex(root), before)
  t.alike(previous, [])
  t.is(map.storage.commits, commits)
})

test('a put equal to the stored value keeps the root and reports previous', async (t) => {
  const map = await open()
  await map.put(key('a'), val('1'))
  const before = hex(map.root)
  const commits = map.storage.commits
  const { root, previous } = await map.put(key('a'), val('1'))
  t.is(hex(root), before, 'the root does not change')
  t.alike(previous, [{ key: key('a'), value: val('1') }], 'previous reports the prior entry')
  t.is(map.storage.commits, commits, 'nothing was committed')
})

test('create with duplicate keys throws DUPLICATE_KEY', async (t) => {
  const list = [
    { key: key('a'), value: val('1') },
    { key: key('b'), value: val('2') },
    { key: key('a'), value: val('3') }
  ]
  await t.exception(
    async () => {
      for await (const node of create({ list, storage: storage(), chunker: bf(3), kind: 'map' })) {
        t.fail(`unexpected node ${hex(node.address)}`)
      }
    },
    { code: 'DUPLICATE_KEY' }
  )
  // An equal key and value is a duplicate too.
  await t.exception(
    async () => {
      for await (const node of create({
        list: [list[0], list[0]],
        storage: storage(),
        chunker: bf(3),
        kind: 'map'
      })) {
        t.fail(`unexpected node ${hex(node.address)}`)
      }
    },
    { code: 'DUPLICATE_KEY' }
  )
})

test('create sorts an unsorted list and does not change the input', async (t) => {
  const list = randomEntries(3, 40)
  const input = list.map((e) => ({ key: e.key, value: e.value }))
  const unsorted = await build({ list: input, storage: storage(), chunker: bf(3) })
  const sorted = await build({ list: sortEntries(list), storage: storage(), chunker: bf(3) })
  t.alike(unsorted, sorted)
  t.alike(
    input.map((e) => hex(e.key)),
    list.map((e) => hex(e.key)),
    'the input order is unchanged'
  )
})

test('previous lists the prior entries in key order', async (t) => {
  const list = sortEntries(randomEntries(4, 60))
  const map = await open()
  await map.batch(list)
  const random = seeded(4)
  const touched = shuffle(list, random).slice(0, 25)
  const ops = touched.map((e, i) =>
    i % 2 === 0 ? { key: e.key, del: true } : { key: e.key, value: val('new') }
  )
  ops.push({ key: key('absent-1'), del: true })
  ops.push({ key: b4a.alloc(32, 0xff), value: val('fresh') })
  const { previous } = await map.batch(ops)
  const want = sortEntries(touched)
  t.alike(
    previous.map((e) => hex(e.key)),
    want.map((e) => hex(e.key))
  )
  for (let i = 0; i < want.length; i++) t.alike(previous[i].value, want[i].value)
})

test('normalizeOps copies, dedupes and sorts', (t) => {
  const a = key('a')
  const ops = normalizeOps(
    [
      { key: key('b'), value: val('1') },
      { key: a, value: val('x') },
      { key: a, del: true },
      { key: key('c'), del: true },
      { key: key('c'), value: val('3') }
    ],
    KINDS.map
  )
  t.alike(
    ops.map((op) => [str(op.key), op.del === true, op.value && str(op.value)]),
    [
      ['a', true, undefined],
      ['b', false, '1'],
      ['c', false, '3']
    ]
  )
  a.fill(0)
  t.is(str(ops[0].key), 'a', 'the key is a copy')
  t.alike(normalizeOps([{ key: key('a') }, { key: key('a'), del: true }], KINDS.set), [
    { key: key('a'), del: true }
  ])
  t.exception.all(() => normalizeOps([{ key: key('a') }], KINDS.map), { code: 'INVALID_VALUE' })
  t.exception.all(() => normalizeOps([null], KINDS.map), { code: 'INVALID_KEY' })
  t.exception.all(() => normalizeOps({}, KINDS.map), TypeError)
})
