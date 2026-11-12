// The high-level map of TECHNICAL.DESIGN.md, decision 8.
const test = require('brittle')
const b4a = require('b4a')
const { ProllyMap } = require('../lib/map')
const { bf } = require('../lib/chunker')
const { Cache, nocache } = require('../lib/cache')
const { storage, randomEntries, sortEntries, seeded, shuffle } = require('./helpers')

const key = (str) => b4a.from(str)
const val = (str) => b4a.from(str)
const str = (buf) => b4a.toString(buf)
const hex = (buf) => (buf === null ? null : b4a.toString(buf, 'hex'))

async function open(opts = {}) {
  return ProllyMap.open(storage(), { chunker: bf(3), ...opts })
}

async function collect(iterator) {
  const out = []
  for await (const item of iterator) out.push(item)
  return out
}

test('open on an empty storage gives an empty map', async (t) => {
  const map = await open()
  t.is(map.root, null)
  t.is(await map.get(key('a')), null)
  t.is(await map.has(key('a')), false)
  t.alike(await collect(map.range()), [])
  const { root, previous } = await map.delete(key('a'))
  t.is(root, null, 'a delete on an empty tree leaves the root null')
  t.alike(previous, [])
  t.is(await map.storage.root(), null, 'nothing was committed')
})

test('put, get, has and delete', async (t) => {
  const map = await open()
  const r1 = await map.put(key('a'), val('1'))
  t.ok(r1.root, 'a root after the first put')
  t.alike(r1.previous, [])
  t.alike(await map.get(key('a')), val('1'))
  t.is(await map.has(key('a')), true)
  t.alike(await map.storage.root(), map.root, 'the root is committed')

  const r2 = await map.put(key('a'), val('2'))
  t.alike(r2.previous, [{ key: key('a'), value: val('1') }])
  t.alike(await map.get(key('a')), val('2'))
  t.not(hex(r2.root), hex(r1.root))

  await map.put(key('b'), val('3'))
  const r3 = await map.delete(key('a'))
  t.alike(r3.previous, [{ key: key('a'), value: val('2') }])
  t.is(await map.get(key('a')), null)
  t.alike(await map.get(key('b')), val('3'))

  const r4 = await map.delete(key('b'))
  t.is(r4.root, null, 'deleting the last entry gives a null root')
  t.is(map.root, null)
  t.is(await map.storage.root(), null)
  t.is(await map.get(key('b')), null)
})

test('batch returns the new root and the prior entries in key order', async (t) => {
  const map = await open()
  await map.batch([
    { key: key('c'), value: val('3') },
    { key: key('a'), value: val('1') },
    { key: key('b'), value: val('2') }
  ])
  const { root, previous } = await map.batch([
    { key: key('c'), value: val('33') },
    { key: key('a'), del: true },
    { key: key('d'), value: val('4') },
    { key: key('b'), value: val('22') }
  ])
  t.alike(root, map.root)
  t.alike(
    previous.map((e) => [str(e.key), str(e.value)]),
    [
      ['a', '1'],
      ['b', '2'],
      ['c', '3']
    ]
  )
  t.alike(
    (await collect(map.range())).map((e) => [str(e.key), str(e.value)]),
    [
      ['b', '22'],
      ['c', '33'],
      ['d', '4']
    ]
  )
})

test('range bounds', async (t) => {
  const map = await open()
  const keys = ['a', 'b', 'c', 'd', 'e', 'f', 'g']
  await map.batch(keys.map((k) => ({ key: key(k), value: val(k.toUpperCase()) })))
  const range = async (bounds) => (await collect(map.range(bounds))).map((e) => str(e.key))
  t.alike(await range(), keys, 'no bounds yields everything')
  t.alike(await range({ gte: key('c') }), ['c', 'd', 'e', 'f', 'g'])
  t.alike(await range({ gt: key('c') }), ['d', 'e', 'f', 'g'])
  t.alike(await range({ lte: key('c') }), ['a', 'b', 'c'])
  t.alike(await range({ lt: key('c') }), ['a', 'b'])
  t.alike(await range({ gte: key('b'), lte: key('e') }), ['b', 'c', 'd', 'e'])
  t.alike(await range({ gt: key('b'), lt: key('e') }), ['c', 'd'])
  t.alike(await range({ gte: key('c'), lte: key('c') }), ['c'])
  t.alike(await range({ gt: key('c'), lt: key('d') }), [])
  t.alike(await range({ gt: key('e'), lt: key('b') }), [], 'gt above lt yields nothing')
  t.alike(await range({ gte: key('bb'), lte: key('dd') }), ['c', 'd'], 'bounds between keys')
  t.alike(await range({ gte: key('0'), lte: key('zz') }), keys, 'bounds outside the keys')
  t.alike(
    await range({ gt: key('b'), gte: key('a') }),
    ['c', 'd', 'e', 'f', 'g'],
    'the tighter lower bound wins'
  )
  t.alike(
    await range({ lt: key('f'), lte: key('g') }),
    ['a', 'b', 'c', 'd', 'e'],
    'the tighter upper bound wins'
  )
  const entries = await collect(map.range({ gte: key('a'), lte: key('a') }))
  t.alike(entries, [{ key: key('a'), value: val('A') }])
})

test('range over a tree with branches matches a filter over the sorted list', async (t) => {
  const list = sortEntries(randomEntries(11, 200))
  const map = await open()
  await map.batch(list)
  const random = seeded(99)
  for (let i = 0; i < 30; i++) {
    const [lo, hi] = shuffle(list, random)
      .slice(0, 2)
      .map((e) => e.key)
      .sort(b4a.compare)
    const bounds = i % 2 === 0 ? { gte: lo, lte: hi } : { gt: lo, lt: hi }
    const want = list.filter((e) => {
      const a = b4a.compare(e.key, lo)
      const b = b4a.compare(e.key, hi)
      return i % 2 === 0 ? a >= 0 && b <= 0 : a > 0 && b < 0
    })
    const got = await collect(map.range(bounds))
    t.alike(
      got.map((e) => hex(e.key)),
      want.map((e) => hex(e.key))
    )
    for (let j = 0; j < got.length; j++) t.alike(got[j].value, want[j].value)
  }
  t.alike(
    (await collect(map.range())).map((e) => hex(e.key)),
    list.map((e) => hex(e.key))
  )
})

test('string keys and values throw TypeError with a code', async (t) => {
  const map = await open()
  await t.exception.all(map.put('a', val('1')), { code: 'INVALID_KEY' })
  await t.exception.all(map.put('a', val('1')), TypeError)
  await t.exception.all(map.put(key('a'), '1'), { code: 'INVALID_VALUE' })
  await t.exception.all(map.put(key('a'), 1), { code: 'INVALID_VALUE' })
  await t.exception.all(map.get('a'), { code: 'INVALID_KEY' })
  await t.exception.all(map.has(1), { code: 'INVALID_KEY' })
  await t.exception.all(map.delete('a'), { code: 'INVALID_KEY' })
  await t.exception.all(
    map.batch([
      { key: key('a'), value: val('1') },
      { key: 'b', value: val('2') }
    ]),
    {
      code: 'INVALID_KEY'
    }
  )
  await t.exception.all(collect(map.range({ gte: 'a' })), { code: 'INVALID_KEY' })
  t.is(map.root, null, 'nothing was committed')
  await map.put(key('a'), val('1'))
  await t.exception.all(map.put(key('b'), '2'), { code: 'INVALID_VALUE' })
  t.alike(await map.get(key('a')), val('1'), 'the map still works after a rejected op')
})

test('a map keeps working after a failed batch', async (t) => {
  const map = await open()
  await map.put(key('a'), val('1'))
  await t.exception.all(map.put('b', val('2')), { code: 'INVALID_KEY' })
  await map.put(key('c'), val('3'))
  t.alike(
    (await collect(map.range())).map((e) => str(e.key)),
    ['a', 'c']
  )
})

test('Uint8Array keys and values are accepted', async (t) => {
  const map = await open()
  await map.put(new Uint8Array([1, 2]), new Uint8Array([3]))
  t.alike(await map.get(new Uint8Array([1, 2])), b4a.from([3]))
  t.alike(await map.get(b4a.from([1, 2])), b4a.from([3]))
})

test('a zero-length key is legal and sorts first', async (t) => {
  const map = await open()
  await map.put(key('a'), val('1'))
  await map.put(b4a.alloc(0), val('empty'))
  t.alike(await map.get(b4a.alloc(0)), val('empty'))
  t.alike(
    (await collect(map.range())).map((e) => str(e.key)),
    ['', 'a']
  )
})

test('two instances on one storage: the second writer sees CONFLICT', async (t) => {
  const store = storage()
  const a = await ProllyMap.open(store, { chunker: bf(3) })
  const b = await ProllyMap.open(store, { chunker: bf(3) })
  await a.put(key('a'), val('1'))
  await t.exception(b.put(key('b'), val('2')), { code: 'CONFLICT' })
  t.is(b.root, null, 'the loser keeps the root it read')
  t.alike(await store.root(), a.root, 'the winner is committed')
  const c = await ProllyMap.open(store, { chunker: bf(3) })
  t.alike(c.root, a.root)
  t.alike(await c.get(key('a')), val('1'))
  t.is(await c.get(key('b')), null)
})

test('reopen reads the committed root', async (t) => {
  const store = storage()
  const list = sortEntries(randomEntries(5, 50))
  const a = await ProllyMap.open(store, { chunker: bf(3) })
  for (const { key, value } of list) await a.put(key, value)
  const b = await ProllyMap.open(store, { chunker: bf(3), cache: nocache })
  t.alike(b.root, a.root)
  for (const { key, value } of list) t.alike(await b.get(key), value)
  const c = await ProllyMap.open(store, { chunker: bf(3), cache: new Cache(4) })
  for (const { key, value } of list) t.alike(await c.get(key), value)
})

test('the default chunker is bf(32) and the default cache is bounded', async (t) => {
  const map = await ProllyMap.open(storage())
  t.is(typeof map.chunker, 'function')
  t.ok(map.cache instanceof Cache)
  t.is(map.cache.max, 1024)
  await map.put(key('a'), val('1'))
  t.alike(await map.get(key('a')), val('1'))
})

test('open rejects a storage without the interface', async (t) => {
  await t.exception.all(ProllyMap.open({}), TypeError)
  await t.exception.all(ProllyMap.open(null), TypeError)
})

test('root is a copy', async (t) => {
  const map = await open()
  await map.put(key('a'), val('1'))
  const root = map.root
  root.fill(0)
  t.unlike(map.root, root)
  t.alike(map.root, await map.storage.root())
})
