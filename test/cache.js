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
  t.is(cache.get(root), node)
  await node.getAllEntries()
  const afterAll = gets
  t.ok(afterAll > 1)
  await node.getAllEntries()
  t.is(gets, afterAll, 'every node came from the cache')
  const again = await load({ address: root, storage: counting, chunker, kind: 'map', cache })
  t.is(again, node, 'the same object')
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
