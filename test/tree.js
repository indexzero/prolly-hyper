// Acceptance test 4: the ports of upstream test/test-base.js, test-map.js and
// test-first-leaf.js with byte keys. Node shapes that depend on upstream's
// sha256 and dag-cbor identity are not asserted. In their place every
// mutation is checked against the invariants of the Canonical bulk section
// and against `create` over the same entries, the oracle.
//
// Upstream passes a chunker per `bulk` call. In the port the chunker is a
// consensus parameter of the tree, so the tests that used a custom chunker
// build the tree with that chunker from the start.
const test = require('brittle')
const b4a = require('b4a')
const { Entry, EntryList, create, load, MapLeafEntry } = require('../lib/tree')
const { bf, MAX_UINT32 } = require('../lib/chunker')
const { Cache, nocache } = require('../lib/cache')
const { storage, build, checkInvariants, sortEntries, collectNodes } = require('./helpers')

const compare = b4a.compare
const key = (str) => b4a.from(str)
const val = (n) => b4a.from(String(n))
const hex = (buf) => b4a.toString(buf, 'hex')
const str = (buf) => b4a.toString(buf)

const createList = (entries) => entries.map(([k, v]) => ({ key: key(k), value: val(v) }))

const list = createList([
  ['a', 1],
  ['b', 1],
  ['bb', 2],
  ['c', 1],
  ['cc', 2],
  ['d', 1],
  ['ff', 2],
  ['h', 1],
  ['z', 1],
  ['zz', 2]
])

// A tree under test: the storage, the chunker, the root node and the entries
// it holds, so that every step can be checked against `create`.
class Tree {
  constructor({ chunker = bf(3), cache = nocache, kind = 'map' } = {}) {
    this.storage = storage()
    this.chunker = chunker
    this.cache = cache
    this.kind = kind
    this.root = null
    this.entries = new Map()
  }

  static async create(list, opts) {
    const tree = new Tree(opts)
    await tree.build(list)
    return tree
  }

  async build(list) {
    const blocks = []
    const nodes = []
    for await (const node of create({
      list,
      storage: this.storage,
      chunker: this.chunker,
      kind: this.kind,
      cache: this.cache
    })) {
      blocks.push({ address: node.address, bytes: node.bytes })
      nodes.push(node)
    }
    const root = nodes.length ? nodes[nodes.length - 1] : null
    await this.storage.commit({
      blocks,
      root: root && root.address,
      expected: await this.storage.root()
    })
    this.root = root
    for (const { key, value } of list) this.entries.set(hex(key), { key, value })
    return nodes
  }

  async load(address = this.root.address) {
    return load({
      address,
      storage: this.storage,
      chunker: this.chunker,
      kind: this.kind,
      cache: this.cache
    })
  }

  async get(k) {
    const { result } = await this.root.getEntry(k)
    return result.value
  }

  // Apply `ops` with `bulk`, commit, then check the invariants and the oracle.
  async bulk(t, ops) {
    const expected = this.root.address
    const result = await this.root.bulk(ops)
    const { root, blocks, previous } = result
    await this.storage.commit({ blocks, root: root && root.address, expected })
    for (const op of ops) {
      if (op.del) this.entries.delete(hex(op.key))
      else this.entries.set(hex(op.key), { key: op.key, value: op.value })
    }
    this.root = root
    if (root !== null) {
      await t.execution(() => checkInvariants(root), 'invariants hold')
      // The returned root reads back from storage with the same bytes.
      const loaded = await this.load()
      t.is(hex(loaded.bytes), hex(root.bytes), 'root reads back')
    }
    const want = await build({
      list: sortEntries([...this.entries.values()]),
      storage: storage(),
      chunker: this.chunker
    })
    t.is(root && hex(root.address), want && hex(want), 'root equals create over the same entries')
    return result
  }

  async expectNotFound(t, k) {
    await t.exception(this.root.getEntry(k), { code: 'NOT_FOUND', message: 'Not found' })
  }
}

// test-base.js

test('base: basic create with a custom chunker', async (t) => {
  // The chunker closes a chunk after the entry whose first key byte is 1.
  const chunker = (entry) => entry.key[0] === 1
  const list = [0, 1, 2].map((n) => ({ key: b4a.from([n]), value: b4a.from([n]) }))
  const checks = [
    { entries: 2, closed: true, distance: 0 },
    { entries: 1, closed: false, distance: 0 },
    { entries: 2, closed: false, distance: 1 }
  ]
  for await (const node of create({ list, storage: storage(), chunker, kind: 'map' })) {
    const check = checks.shift()
    t.is(node.entryList.entries.length, check.entries)
    t.is(node.closed, check.closed)
    t.is(node.distance, check.distance)
  }
  t.is(checks.length, 0)
})

test('base: EntryList must have closed argument', (t) => {
  t.exception(() => new EntryList({ entries: [] }), /Missing required argument "closed"/)
})

const fixtureEntries = [0, 1, 2, 3, 4, 5, 6, 7, 8].map(
  (n) => new Entry({ key: b4a.from([n]), value: b4a.from([n]) }, { kind: 0 })
)
const entryListFixture = new EntryList({ entries: fixtureEntries, closed: true })

test('base: entryList find', (t) => {
  const [i, entry] = entryListFixture.find(b4a.from([1]), compare)
  t.is(i, 1)
  t.alike(entry.key, b4a.from([1]))
  t.is(entryListFixture.find(b4a.alloc(0), compare), null, 'a key below every entry')
  t.is(entryListFixture.find(b4a.from([9]), compare)[0], 8, 'a key above every entry')
})

test('base: entryList findMany', (t) => {
  const keys = [1, 3, 5].map((n) => b4a.from([n]))
  const results = entryListFixture.findMany(keys, compare)
  const comp = [...results.keys()]
    .sort((a, b) => a - b)
    .map((i) => [i, results.get(i)[0].key[0], ...results.get(i)[1].map((k) => k[0])])
  t.alike(comp, [
    [1, 1, 1],
    [3, 3, 3],
    [5, 5, 5]
  ])
})

test('base: entryList findRange', (t) => {
  const results = entryListFixture.findRange(b4a.from([2]), b4a.from([5]), compare)
  t.is(results.first, 2)
  t.is(results.last, 4)
  t.alike(
    results.entries.map((e) => e.key[0]),
    [2, 3, 4]
  )
})

// test-map.js

test('map: basic create', async (t) => {
  const tree = new Tree()
  const nodes = await tree.build(list)
  t.ok(nodes.length > 1, 'more than one node at factor 3')
  let sawBranch = false
  for (const node of nodes) {
    t.is(node.address.byteLength, 32)
    t.is(node.isLeaf, !node.isBranch)
    if (node.isBranch) sawBranch = true
    else t.is(sawBranch, false, 'leaves come before branches')
  }
  t.ok(tree.root.isBranch, 'the root is a branch')
  await t.execution(() => checkInvariants(tree.root))
  const root = await tree.load()
  t.is(hex(root.bytes), hex(tree.root.bytes))
  for (const { key, value } of list) {
    const { result } = await root.getEntry(key)
    t.alike(result.value, value)
    t.ok(result instanceof MapLeafEntry)
  }
})

test('map: getEntries', async (t) => {
  const tree = await Tree.create(list)
  const { result: entries, visited } = await tree.root.getEntries([key('a'), key('zz')])
  t.ok(visited.has(hex(tree.root.address)), 'visited holds the root')
  t.ok(visited.size >= 3, 'visited holds the root and two leaves at least')
  t.is(entries.length, 2)
  const [a, zz] = entries
  t.alike(a.key, key('a'))
  t.alike(a.value, val(1))
  t.alike(zz.key, key('zz'))
  t.alike(zz.value, val(2))
  const { result: reversed } = await tree.root.getEntries([key('zz'), key('a')])
  t.alike(
    reversed.map((e) => str(e.key)),
    ['a', 'zz'],
    'unsorted keys give sorted entries'
  )
  const { result: partial } = await tree.root.getEntries([key('a'), key('nope'), key('zz')])
  t.alike(
    partial.map((e) => str(e.key)),
    ['a', 'zz'],
    'a missing key is skipped'
  )
})

test('map: getRangeEntries keeps the exclusive end', async (t) => {
  const tree = await Tree.create(list)
  const verify = (entries, start, end) => {
    t.alike(
      entries.map((e) => str(e.key)),
      list.slice(start, end).map(({ key }) => str(key))
    )
  }
  const range = async (a, b) => (await tree.root.getRangeEntries(key(a), key(b))).result
  verify(await range('b', 'z'), 1, 8)
  verify(await range('', 'zzz'))
  verify(await range('a', 'zz'), 0, 9)
  verify(await range('a', 'c'), 0, 3)
  verify(await range('a', 'a'), 0, 0)
})

test('map: getAllEntries propagates a storage error', async (t) => {
  const tree = await Tree.create(list)
  let count = 0
  const faulty = {
    get: async (address) => {
      count++
      if (count === 3) throw new Error('Faulty address encountered')
      return tree.storage.get(address)
    }
  }
  const root = await load({
    address: tree.root.address,
    storage: faulty,
    chunker: tree.chunker,
    kind: 'map'
  })
  await t.exception(root.getAllEntries(), /Faulty address encountered/)
})

test('map: getAllEntries gives every entry in key order', async (t) => {
  const tree = await Tree.create(list)
  const { result, visited } = await tree.root.getAllEntries()
  t.alike(
    result.map((e) => str(e.key)),
    list.map(({ key }) => str(key))
  )
  t.ok(visited.size > 1)
})

test('map: bulk with delete', async (t) => {
  const tree = await Tree.create(list)
  const notDeleted = list.map(({ key }) => key)
  const deleted = []
  for (const { key } of list) {
    notDeleted.splice(
      notDeleted.findIndex((k) => compare(k, key) === 0),
      1
    )
    deleted.push(key)
    const { previous } = await tree.bulk(t, [{ key, del: true }])
    t.is(previous.length, 1)
    if (notDeleted.length > 0) {
      for (const k of notDeleted) {
        t.alike(await tree.get(k), list.find((e) => compare(e.key, k) === 0).value)
      }
      for (const k of deleted) await tree.expectNotFound(t, k)
    } else {
      t.is(tree.root, null, 'deleting the last entry gives a null root')
    }
  }
})

test('map: bulk with missing delete', async (t) => {
  const tree = await Tree.create(list)
  const notDeleted = list.map(({ key }) => str(key))
  const deleted = []
  let prevKey = str(list[0].key)
  for (const { key: k } of list) {
    const k0 = str(k)
    const missingKey = k0 + 'missing-key'
    const bulk = [
      { key: key(k0), del: true },
      { key: key(k0 + 'add'), value: val('add') },
      { key: key(k0 + 'del'), del: true },
      { key: key(prevKey), del: true },
      { key: key(missingKey), value: val(missingKey) },
      { key: key(prevKey + 'add'), value: val('add') },
      { key: key(missingKey), del: true }
    ]
    prevKey = k0
    notDeleted.splice(notDeleted.indexOf(k0), 1)
    deleted.push(k0)
    await tree.bulk(t, bulk)
    const all = (await tree.root.getAllEntries()).result
    for (const op of bulk) {
      if (!op.del) {
        if (str(op.key) === missingKey) {
          // The later delete of the same key wins, decision 5.
          t.absent(all.find((e) => compare(e.key, op.key) === 0))
          await tree.expectNotFound(t, op.key)
        } else {
          t.alike(all.find((e) => compare(e.key, op.key) === 0).value, op.value)
          t.alike(await tree.get(op.key), op.value)
        }
      } else {
        await tree.expectNotFound(t, op.key)
      }
    }
    for (const k of notDeleted) {
      t.alike(await tree.get(key(k)), list.find((e) => str(e.key) === k).value)
    }
    for (const k of deleted) await tree.expectNotFound(t, key(k))
  }
})

test('map: bulk insert 2', async (t) => {
  const tree = await Tree.create(list)
  await tree.bulk(t, [
    { key: key('dd'), value: val(2) },
    { key: key('d'), value: val(-1) }
  ])
  t.alike(await tree.get(key('dd')), val(2))
  t.alike(await tree.get(key('d')), val(-1))
  for (const [k, v] of [
    ['a', 1],
    ['b', 1],
    ['bb', 2],
    ['c', 1],
    ['cc', 2],
    ['ff', 2],
    ['h', 1],
    ['z', 1],
    ['zz', 2]
  ]) {
    t.alike(await tree.get(key(k)), val(v))
  }
})

test('map: bulk insert unsorted', async (t) => {
  const tree = await Tree.create(list)
  await tree.bulk(t, [
    { key: key('dd'), value: val(2) },
    { key: key('d'), value: val(-1) },
    { key: key('0'), value: val(0) }
  ])
  t.alike(await tree.get(key('dd')), val(2))
  t.alike(await tree.get(key('d')), val(-1))
  t.alike(await tree.get(key('0')), val(0))
  const { result } = await tree.root.getAllEntries()
  t.alike(
    result.map((e) => str(e.key)),
    ['0', 'a', 'b', 'bb', 'c', 'cc', 'd', 'dd', 'ff', 'h', 'z', 'zz']
  )
})

function hundred() {
  const list = []
  for (let i = 0; i < 100; i++) list.push({ key: key(String(i)), value: val(true) })
  return sortEntries(list)
}

test('map: bulk insert 100 update 1*100', async (t) => {
  const tree = await Tree.create(hundred(), { cache: new Cache() })
  const expected = hundred().map(({ key }) => str(key))
  const verify = (entries, updated) => {
    const want = [...expected]
    let count = 0
    for (const { key, value } of entries) {
      t.alike(value, val(str(key) !== updated))
      t.is(want.shift(), str(key))
      count++
    }
    t.is(count, 100)
  }
  verify((await tree.root.getAllEntries()).result, null)
  const base = tree.root
  for (let i = 0; i < 100; i++) {
    const { root, blocks } = await base.bulk([{ key: key(String(i)), value: val(false) }])
    await tree.storage.commit({ blocks, root: root.address, expected: await tree.storage.root() })
    verify((await root.getAllEntries()).result, String(i))
    await t.execution(() => checkInvariants(root))
  }
})

test('map: bulk insert 100 delete 1*100', async (t) => {
  const tree = await Tree.create(hundred(), { cache: new Cache() })
  const expected = hundred().map(({ key }) => str(key))
  const base = tree.root
  for (let i = 0; i < 100; i++) {
    const k = String(i)
    const { root, blocks, previous } = await base.bulk([{ key: key(k), del: true }])
    t.is(previous.length, 1)
    t.is(str(previous[0].key), k)
    t.alike(previous[0].value, val(true))
    await tree.storage.commit({ blocks, root: root.address, expected: await tree.storage.root() })
    const { result } = await root.getAllEntries()
    t.alike(
      result.map((e) => str(e.key)),
      expected.filter((e) => e !== k)
    )
  }
})

test('map: brute ranges', async (t) => {
  const tree = await Tree.create(hundred(), { cache: new Cache() })
  const expected = hundred().map(({ key }) => str(key))
  const range = async (a, b) =>
    (await tree.root.getRangeEntries(key(a), key(b))).result.map((e) => str(e.key))
  const front = [...expected]
  while (front.length) {
    t.alike(await range(front[0], front[front.length - 1] + '999'), front)
    front.shift()
  }
  const back = [...expected]
  while (back.length) {
    t.alike(await range(back[0], back[back.length - 1] + '.'), back)
    back.pop()
  }
  t.alike(await range('9999999', '9999999999999999'), [])
  t.alike(await range('.', '.'), [])
  t.alike(await range('', '0'), [], 'the end is exclusive')
  t.alike(await range('0', '0.'), ['0'])
})

test('map: getEntry', async (t) => {
  const tree = new Tree()
  const nodes = await tree.build(list)
  const leaf = nodes.find((n) => n.isLeaf)
  await tree.expectNotFound(t, key('.'))
  await t.exception(leaf.getEntry(key('.')), { code: 'NOT_FOUND' })
  await tree.expectNotFound(t, key('missing'))
  const { result, visited } = await tree.root.getEntry(key('cc'))
  t.alike(result.value, val(2))
  t.ok(visited.has(hex(tree.root.address)))
})

test('map: leaf', async (t) => {
  // A factor so large that no entry is a boundary: the root is one leaf.
  const tree = await Tree.create(list, { chunker: bf(MAX_UINT32) })
  t.ok(tree.root.isLeaf)
  t.alike(await tree.get(key('c')), val(1))
  const { result } = await tree.root.getEntries([key('c'), key('cc'), key('d')])
  t.alike(
    result.map((e) => e.value),
    [val(1), val(2), val(1)]
  )
  await tree.bulk(t, [{ key: key('aaa'), value: val(3) }])
  t.alike(await tree.get(key('aaa')), val(3))
  t.ok(tree.root.isLeaf, 'still one leaf')
})

test('map: load non-existent key', async (t) => {
  const tree = await Tree.create(list)
  await tree.expectNotFound(t, key('non_existent_key'))
})

test('map: a lookup that differs in a byte that is not valid UTF-8 is not found', async (t) => {
  // Upstream compares `key.toString()` (src/base.js:233-234), so ff41 and
  // fe41 read as equal. The port uses the comparator, decision 12.
  const tree = await Tree.create([{ key: b4a.from('ff41', 'hex'), value: val(1) }])
  await tree.expectNotFound(t, b4a.from('fe41', 'hex'))
  t.alike(await tree.get(b4a.from('ff41', 'hex')), val(1))
  await tree.bulk(t, [{ key: b4a.from('fe41', 'hex'), value: val(2) }])
  t.alike(await tree.get(b4a.from('fe41', 'hex')), val(2))
  t.alike(await tree.get(b4a.from('ff41', 'hex')), val(1))
  const { result } = await tree.root.getAllEntries()
  t.is(result.length, 2)
  // D-010 F-03. The lookup above: `find` returns the stored key fe41 for the
  // search key ff41, so the equality check runs. Under upstream's
  // `toString()` equality the two read as equal and the lookup would return
  // fe41. The comparator says NOT_FOUND.
  const below = await Tree.create([{ key: b4a.from('fe41', 'hex'), value: val(1) }])
  t.is(
    b4a.toString(b4a.from('fe41', 'hex')),
    b4a.toString(b4a.from('ff41', 'hex')),
    'same toString'
  )
  await below.expectNotFound(t, b4a.from('ff41', 'hex'))
  t.alike(await below.get(b4a.from('fe41', 'hex')), val(1))
})

test('map: delete multiple entries', async (t) => {
  const tree = await Tree.create(list)
  const keysToDelete = ['b', 'cc', 'z']
  const { previous } = await tree.bulk(
    t,
    keysToDelete.map((k) => ({ key: key(k), del: true }))
  )
  t.alike(
    previous.map((e) => str(e.key)),
    keysToDelete
  )
  t.alike(
    previous.map((e) => e.value),
    [val(1), val(2), val(1)]
  )
  for (const k of keysToDelete) await tree.expectNotFound(t, key(k))
  const { result } = await tree.root.getEntries([key('a'), key('zz')])
  t.alike(
    result.map((e) => str(e.key)),
    ['a', 'zz']
  )
})

test('map: delete multiple entries within range', async (t) => {
  const updated = createList([
    ['a', 1],
    ['b', 1],
    ['bb', 2],
    ['c', 1],
    ['cc', 2],
    ['d', -1],
    ['ff', 2],
    ['h', 1],
    ['z', 1],
    ['zz', 2]
  ])
  const tree = await Tree.create(updated)
  const keysToDelete = ['b', 'cc', 'd', 'z']
  const { previous } = await tree.bulk(
    t,
    keysToDelete.map((k) => ({ key: key(k), del: true }))
  )
  t.alike(
    previous.map((e) => str(e.key)),
    keysToDelete
  )
  t.alike(
    previous.map((e) => e.value),
    [val(1), val(2), val(-1), val(1)]
  )
  for (const k of keysToDelete) await tree.expectNotFound(t, key(k))
  const { result } = await tree.root.getAllEntries()
  t.alike(
    result.map((e) => str(e.key)),
    ['a', 'bb', 'c', 'ff', 'h', 'zz']
  )
})

test('map: delete multiple entries with some outside leaf range', async (t) => {
  const tree = await Tree.create(list)
  const keysToDelete = ['b', 'cc', 'z', 'xxx']
  const { previous } = await tree.bulk(
    t,
    keysToDelete.map((k) => ({ key: key(k), del: true }))
  )
  t.alike(
    previous.map((e) => str(e.key)),
    ['b', 'cc', 'z']
  )
  for (const k of keysToDelete) await tree.expectNotFound(t, key(k))
  const { result } = await tree.root.getEntries([key('a'), key('zz')])
  t.alike(
    result.map((e) => str(e.key)),
    ['a', 'zz']
  )
})

test('map: big map', async (t) => {
  const tree = await Tree.create(list)
  t.alike(await tree.get(key('c')), val(1))
  await tree.bulk(t, [{ key: key('ok'), value: val(200) }])
  t.alike(await tree.get(key('ok')), val(200))
  for (const prefix of ['b', 'A', '0', '']) {
    for (let index = 30; index > 0; index--) {
      const k = key(prefix + String(index))
      await tree.bulk(t, [{ key: k, value: val(index) }])
      t.alike(await tree.get(k), val(index))
    }
  }
  t.is((await tree.root.getAllEntries()).result.length, list.length + 1 + 120)
})

test('map: inner node splitting', async (t) => {
  const tree = await Tree.create(list)
  const code = (k) => val(k.charCodeAt(0))
  const initialKeys = ['a', 'c', 'e', 'g', 'i', 'k', 'm', 'o', 'q', 's']
  await tree.bulk(
    t,
    initialKeys.map((k) => ({ key: key(k), value: code(k) }))
  )
  for (const k of initialKeys) t.alike(await tree.get(key(k)), code(k))
  const additionalKeys = ['b', 'd', 'f', 'h', 'j', 'l', 'n', 'p', 'r']
  await tree.bulk(
    t,
    additionalKeys.map((k) => ({ key: key(k), value: code(k) }))
  )
  for (const k of [...initialKeys, ...additionalKeys]) t.alike(await tree.get(key(k)), code(k))
  const extraKeys = ['t', 'u', 'v', 'w', 'x', 'y', 'z']
  await tree.bulk(
    t,
    extraKeys.map((k) => ({ key: key(k), value: code(k) }))
  )
  for (const k of [...initialKeys, ...additionalKeys, ...extraKeys]) {
    t.alike(await tree.get(key(k)), code(k))
  }
})

// test-first-leaf.js

test('first-leaf: minimal test case with leftmost key insertion', async (t) => {
  const tree = await Tree.create([{ key: key('original'), value: val(1) }])
  t.alike(await tree.get(key('original')), val(1))
  await tree.bulk(t, [{ key: key('before'), value: val(2) }])
  t.alike(await tree.get(key('before')), val(2))
  t.alike(await tree.get(key('original')), val(1))
})

test('first-leaf: leftmost key insertion with an always-split leaf chunker', async (t) => {
  // Every leaf closes after one entry. Branches never close.
  const chunker = (entry, distance) => distance < 1
  const tree = await Tree.create([{ key: key('original'), value: val(1) }], { chunker })
  await tree.bulk(t, [{ key: key('before'), value: val(2) }])
  t.alike(await tree.get(key('before')), val(2))
  t.alike(await tree.get(key('original')), val(1))
  t.ok(tree.root.isBranch)
  t.is(tree.root.entryList.entries.length, 2)
})

test('first-leaf: big map with inner nodes', async (t) => {
  const tree = await Tree.create(list)
  const keys = Array.from({ length: 100 }, (_, i) => String.fromCharCode(i + 32))
  for (const k of keys) {
    await tree.bulk(t, [{ key: key(k), value: val(k.charCodeAt(0)) }])
    t.alike(await tree.get(key(k)), val(k.charCodeAt(0)))
  }
  t.ok(tree.root.isBranch)
  const { result } = await tree.root.getEntry(key(keys[50]))
  t.alike(result.value, val(keys[50].charCodeAt(0)))
  t.is((await tree.root.getAllEntries()).result.length, tree.entries.size)
  const some = keys.slice(20, 30).map((k) => key(k))
  t.is((await tree.root.getEntries(some)).result.length, 10)
  const range = (await tree.root.getRangeEntries(key(keys[10]), key(keys[20]))).result
  t.is(range.length, 10, 'ten keys, the end is exclusive')
})

test('first-leaf: basic numeric string key with specific keys and no loops inline', async (t) => {
  const tree = await Tree.create(
    createList([
      ['b', 1],
      ['bb', 2],
      ['c', 1],
      ['cc', 2]
    ])
  )
  t.alike(await tree.get(key('c')), val(1))
  await tree.expectNotFound(t, key('a'))
  t.is((await tree.root.getAllEntries()).result.length, 4)
  const value2 = val('32-a')
  await tree.bulk(t, [{ key: key('a'), value: value2 }])
  const stored = await tree.storage.get(tree.root.address)
  t.alike(stored, tree.root.bytes, 'the root bytes are in storage')
  t.is((await tree.root.getAllEntries()).result.length, 5)
  t.alike(await tree.get(key('a')), value2)
})

for (const [name, keys, count] of [
  ['minimal nonreproduction of duplicate CID issue', ['b', 'c'], 3],
  ['minimal reproduction of duplicate CID issue', ['b', 'c', 'd'], 4]
]) {
  test(`first-leaf: ${name}`, async (t) => {
    const tree = await Tree.create(createList(keys.map((k) => [k, 1])))
    const value2 = val('32-a')
    await tree.bulk(t, [{ key: key('a'), value: value2 }])
    t.alike(await tree.storage.get(tree.root.address), tree.root.bytes)
    t.is((await tree.root.getAllEntries()).result.length, count)
    t.alike(await tree.get(key('a')), value2)
  })
}

test('first-leaf: minimal test case', async (t) => {
  const tree = await Tree.create(list)
  for (let rowCount = 76; rowCount < 100; rowCount++) {
    const k = key(String.fromCharCode(rowCount))
    const value = val(`${rowCount}-${String.fromCharCode(rowCount)}`)
    await tree.bulk(t, [{ key: k, value }])
    t.alike(await tree.get(k), value)
  }
})

test('first-leaf: next test case two', async (t) => {
  const tree = await Tree.create(list)
  for (let rowCount = 77; rowCount < 200; rowCount++) {
    const k = key(String.fromCharCode(rowCount))
    const value = val(`${rowCount}-${String.fromCharCode(rowCount)}`)
    await tree.bulk(t, [{ key: k, value }])
    t.alike(await tree.get(k), value)
  }
})

test('first-leaf: basic numeric string key', async (t) => {
  const tree = await Tree.create(list)
  const errors = []
  for (let rowCount = 33; rowCount < 500; rowCount++) {
    const k = key(String.fromCharCode(rowCount))
    const value = val(`${rowCount}-${String.fromCharCode(rowCount)}`)
    await tree.bulk(t, [{ key: k, value }])
    try {
      await tree.root.getEntry(k)
    } catch (err) {
      errors.push({ rowCount, err })
    }
  }
  t.is(errors.length, 0)
})

test('first-leaf: basic decreasing string key', async (t) => {
  const tree = await Tree.create(list)
  const bigLim = 102
  for (let rowCount = bigLim; rowCount > 33; rowCount--) {
    const k = key(String(rowCount))
    const value = val(`${rowCount}-${rowCount}`)
    await tree.bulk(t, [{ key: k, value }])
    t.alike(await tree.get(k), value)
    t.is((await tree.root.getAllEntries()).result.length, 11 + bigLim - rowCount)
  }
})

test('first-leaf: big decreasing string key normal', async (t) => {
  const tree = await Tree.create(list)
  const bulk = []
  const bigLim = 111
  for (let rowCount = bigLim; rowCount > 33; rowCount--) {
    const k = key(String(rowCount))
    const value = val(`${rowCount}-${rowCount}`)
    bulk.push({ key: k, value })
    // The growing batch re-puts every earlier key with its stored value.
    await tree.bulk(t, bulk)
    t.alike(await tree.get(k), value)
    t.is((await tree.root.getAllEntries()).result.length, 11 + bigLim - rowCount)
  }
})

test('first-leaf: inserts with uninitialized node', async (t) => {
  const tree = await Tree.create(list)
  const keysToInsert = ['1', '2', '3']
  await tree.bulk(
    t,
    keysToInsert.map((k) => ({ key: key(k), value: val(parseInt(k)) }))
  )
  for (const k of keysToInsert) t.alike(await tree.get(key(k)), val(parseInt(k)))
  const { result } = await tree.root.getAllEntries()
  t.alike(
    result.map((e) => str(e.key)),
    ['1', '2', '3', 'a', 'b', 'bb', 'c', 'cc', 'd', 'ff', 'h', 'z', 'zz']
  )
})

test('first-leaf: insert multiple entries within range with a chunker that never closes a leaf', async (t) => {
  // Leaves never close, so the whole tree is one leaf.
  const chunker = (entry, distance) => distance > 0
  const tree = await Tree.create(
    createList([
      ['a', 1],
      ['b', 1],
      ['bb', 2],
      ['c', 1],
      ['cc', 2],
      ['d', -1],
      ['ff', 2],
      ['h', 1],
      ['z', 1],
      ['zz', 2]
    ]),
    { chunker }
  )
  t.ok(tree.root.isLeaf)
  await tree.bulk(t, [
    { key: key('aa'), value: val(3) },
    { key: key('ca'), value: val(4) },
    { key: key('da'), value: val(5) }
  ])
  const expected = [
    ['a', 1],
    ['aa', 3],
    ['b', 1],
    ['bb', 2],
    ['c', 1],
    ['ca', 4],
    ['cc', 2],
    ['d', -1],
    ['da', 5],
    ['ff', 2],
    ['h', 1],
    ['z', 1],
    ['zz', 2]
  ]
  for (const [k, v] of expected) t.alike(await tree.get(key(k)), val(v))
  const { result } = await tree.root.getAllEntries()
  t.alike(
    result.map((e) => str(e.key)),
    expected.map(([k]) => k)
  )
})

test('first-leaf: insert into a tree whose leaves always close and whose branches never do', async (t) => {
  const chunker = (entry, distance) => distance < 1
  const tree = await Tree.create([{ key: key('A'), value: val(1) }], { chunker })
  await tree.bulk(
    t,
    ['B', 'C', 'D', 'F', 'G', 'H'].map((k, i) => ({
      key: key(k),
      value: val(k.charCodeAt(0) - 64)
    }))
  )
  t.ok(tree.root.isBranch)
  t.is(tree.root.distance, 1)
  t.is(tree.root.entryList.entries.length, 7)
  await tree.bulk(t, [{ key: key('E'), value: val(5) }])
  t.is(tree.root.entryList.entries.length, 8)
  for (const [k, v] of [
    ['A', 1],
    ['B', 2],
    ['C', 3],
    ['D', 4],
    ['E', 5],
    ['F', 6],
    ['G', 7],
    ['H', 8]
  ]) {
    t.alike(await tree.get(key(k)), val(v))
  }
})

test('first-leaf: loopless shorter decreasing logic branch in getAllEntries', async (t) => {
  const tree = await Tree.create([{ key: key('2000'), value: val(1) }])
  await tree.bulk(t, [{ key: key('1999'), value: val(1) }])
  t.alike(await tree.get(key('1999')), val(1))
  t.is((await tree.root.getAllEntries()).result.length, 2)
})

test('first-leaf: decreasing logic branch in getAllEntries with alphabetic keys', async (t) => {
  const tree = await Tree.create([{ key: key('f'), value: val(1) }])
  const keys = ['e', 'd', 'c', 'b', 'a']
  for (let index = 0; index < keys.length; index++) {
    await tree.bulk(t, [{ key: key(keys[index]), value: val(index + 1) }])
    t.alike(await tree.get(key(keys[index])), val(index + 1))
  }
  for (let index = 0; index < keys.length; index++) {
    t.alike(await tree.get(key(keys[index])), val(index + 1))
  }
  t.is((await tree.root.getAllEntries()).result.length, keys.length + 1)
})

test('first-leaf: decreasing logic branch in getAllEntries og', async (t) => {
  const tree = await Tree.create([{ key: key('2000'), value: val(1) }])
  const size = 50
  for (let index = 1; index < size; index++) {
    const k = key(String(2000 - index))
    await tree.bulk(t, [{ key: k, value: val(index) }])
    t.alike(await tree.get(k), val(index))
  }
  for (let index = 1; index < size; index++) {
    t.alike(await tree.get(key(String(2000 - index))), val(index))
  }
  t.is((await tree.root.getAllEntries()).result.length, size)
})

test('first-leaf: increasing logic branch in getAllEntries', async (t) => {
  const tree = await Tree.create([{ key: key('2000'), value: val(1) }])
  const size = 50
  for (let index = 0; index < size; index++) {
    const k = key(String(1000 + index))
    await tree.bulk(t, [{ key: k, value: val(index) }])
    t.alike(await tree.get(k), val(index))
  }
  for (let index = 0; index < size; index++) {
    t.alike(await tree.get(key(String(1000 + index))), val(index))
  }
  t.is((await tree.root.getAllEntries()).result.length, size + 1)
})

test('first-leaf: updates with a chunker that never closes', async (t) => {
  const chunker = (entry, distance) => distance > 1
  const tree = await Tree.create(list, { chunker })
  await tree.bulk(t, [
    { key: key('a'), value: val(10) },
    { key: key('c'), value: val(20) },
    { key: key('h'), value: val(30) },
    { key: key('z'), value: val(40) }
  ])
  const expected = [
    ['a', 10],
    ['b', 1],
    ['bb', 2],
    ['c', 20],
    ['cc', 2],
    ['d', 1],
    ['ff', 2],
    ['h', 30],
    ['z', 40],
    ['zz', 2]
  ]
  for (const [k, v] of expected) t.alike(await tree.get(key(k)), val(v))
  const { result } = await tree.root.getAllEntries()
  t.alike(
    result.map((e) => str(e.key)),
    expected.map(([k]) => k)
  )
})

// bulk results

test('bulk: blocks hold only the nodes that did not exist before', async (t) => {
  const tree = await Tree.create(hundred())
  const before = new Set()
  for (const node of (await tree.load()).entryList.entries) before.add(hex(node.address))
  const { root, blocks, nodes } = await tree.root.bulk([{ key: key('new-key'), value: val(1) }])
  t.ok(blocks.length >= 1)
  t.ok(blocks.length <= nodes.length)
  for (const block of blocks) {
    t.is(await tree.storage.get(block.address), null, 'a new block is not in storage yet')
    t.alike(block.bytes, nodes.find((n) => compare(n.address, block.address) === 0).bytes)
  }
  t.is(hex(nodes[nodes.length - 1].address), hex(root.address), 'the root is the last node')
})

test('bulk: a batch that changes nothing gives the same root and no blocks', async (t) => {
  const tree = await Tree.create(list)
  const same = await tree.root.bulk([
    { key: key('a'), value: val(1) },
    { key: key('nope'), del: true }
  ])
  t.is(hex(same.root.address), hex(tree.root.address))
  t.is(same.blocks.length, 0)
  t.is(same.previous.length, 1, 'the put equal to the stored value is reported')
  const empty = await tree.root.bulk([])
  t.is(hex(empty.root.address), hex(tree.root.address))
  t.is(empty.blocks.length, 0)
})

test('bulk: ops that are not bytes throw', async (t) => {
  const tree = await Tree.create(list)
  await t.exception.all(tree.root.bulk([{ key: 'a', value: val(1) }]), { code: 'INVALID_KEY' })
  await t.exception.all(tree.root.bulk([{ key: key('a'), value: 'b' }]), { code: 'INVALID_VALUE' })
  await t.exception.all(tree.root.bulk([{ key: key('a') }]), { code: 'INVALID_VALUE' })
  await t.exception.all(tree.root.bulk('a'), TypeError)
})

// load

test('load: a leaf of the wrong wire kind throws KIND_MISMATCH', async (t) => {
  // One-leaf trees: the root is the leaf, so `load` itself throws.
  const set = await Tree.create(
    list.map(({ key }) => ({ key })),
    { kind: 'set', chunker: bf(MAX_UINT32) }
  )
  t.ok(set.root.isLeaf)
  await t.exception(
    load({ address: set.root.address, storage: set.storage, chunker: set.chunker, kind: 'map' }),
    { code: 'KIND_MISMATCH' }
  )
  const map = await Tree.create(list, { chunker: bf(MAX_UINT32) })
  t.ok(map.root.isLeaf)
  await t.exception(
    load({ address: map.root.address, storage: map.storage, chunker: map.chunker, kind: 'set' }),
    { code: 'KIND_MISMATCH' }
  )
  // The root of a larger set is a branch, which belongs to both kinds, so the
  // mismatch surfaces on the read that reaches a leaf.
  const bigSet = await Tree.create(
    hundred().map(({ key }) => ({ key })),
    { kind: 'set' }
  )
  t.ok(bigSet.root.isBranch)
  const wrong = await load({
    address: bigSet.root.address,
    storage: bigSet.storage,
    chunker: bigSet.chunker,
    kind: 'map'
  })
  await t.exception(wrong.getEntry(key('5')), { code: 'KIND_MISMATCH' })
  await t.exception(wrong.getAllEntries(), { code: 'KIND_MISMATCH' })
})

test('load: an unknown collection kind throws', async (t) => {
  const tree = await Tree.create(list)
  await t.exception(
    load({
      address: tree.root.address,
      storage: tree.storage,
      chunker: tree.chunker,
      kind: 'list'
    }),
    { code: 'KIND_MISMATCH' }
  )
})

test('create: an empty list yields nothing', async (t) => {
  let count = 0
  for await (const node of create({ list: [], storage: storage(), chunker: bf(3), kind: 'map' })) {
    count++
    t.fail(`unexpected node ${hex(node.address)}`)
  }
  t.is(count, 0)
})

test('create: the set kind collapses duplicate keys and encodes kind 2 leaves', async (t) => {
  const tree = new Tree({ kind: 'set', chunker: bf(MAX_UINT32) })
  await tree.build([{ key: key('a') }, { key: key('a') }, { key: key('b') }])
  t.ok(tree.root.isLeaf)
  t.is(tree.root.entryList.entries.length, 2)
  t.is(tree.root.bytes[1], 2, 'wire kind 2')
  t.alike(
    (await tree.root.getAllEntries()).result.map((e) => str(e.key)),
    ['a', 'b']
  )
})

// D-011 F-03. Decision 12: every returned key, value and array is a copy.
// A change to a result must not change a later read under the same root.
for (const [label, makeCache] of [
  ['cache on', () => new Cache()],
  ['cache off', () => nocache]
]) {
  test(`low-level reads return copies, ${label}`, async (t) => {
    // The value under `k`, or the error code, so that a changed key fails an
    // assertion instead of the test.
    const valueOf = (root, k) =>
      root.getEntry(k).then(
        ({ result }) => result.value,
        (err) => err.code
      )
    const forms = {
      getEntry: async (root) => (await root.getEntry(key('b'))).result,
      getEntries: async (root) => (await root.getEntries([key('b')])).result[0],
      getAllEntries: async (root) =>
        (await root.getAllEntries()).result.find((e) => str(e.key) === 'b'),
      getRangeEntries: async (root) => (await root.getRangeEntries(key('b'), key('bb'))).result[0],
      iterate: async (root) => (await root.iterate({ gte: key('b'), lte: key('b') }).next()).value,
      'bulk().previous': async (root) =>
        (await root.bulk([{ key: key('b'), value: val(9) }])).previous[0]
    }
    for (const [name, read] of Object.entries(forms)) {
      const tree = await Tree.create(list, { cache: makeCache() })
      const root = await tree.load()
      const entry = await read(root)
      t.alike(entry.key, key('b'), `${name}: the entry key`)
      t.alike(entry.value, val(1), `${name}: the entry value`)
      entry.key.fill(0x78)
      entry.value.fill(0x78)
      t.alike(await valueOf(root, key('b')), val(1), `${name}: getEntry after`)
      t.alike(
        (await root.getAllEntries()).result.map((e) => str(e.key)),
        list.map((e) => str(e.key)),
        `${name}: getAllEntries keys after`
      )
      const again = await tree.load()
      t.alike(await valueOf(again, key('b')), val(1), `${name}: a reload`)
    }
    // One leaf: the array of `getAllEntries` and the bytes of the node.
    const leafTree = await Tree.create(list, { chunker: bf(MAX_UINT32), cache: makeCache() })
    const leaf = await leafTree.load()
    t.ok(leaf.isLeaf)
    const { result } = await leaf.getAllEntries()
    result[0].value.fill(0x78)
    result.length = 0
    t.is((await leaf.getAllEntries()).result.length, list.length, 'a fresh array')
    t.alike(await valueOf(leaf, key('a')), val(1))
    let encoded
    try {
      encoded = hex(leaf.encode())
    } catch (err) {
      encoded = err.code
    }
    t.is(encoded, hex(leaf.bytes), 'the node still encodes to its bytes')
    // A set entry key is a copy.
    const setTree = await Tree.create(
      list.map(({ key }) => ({ key })),
      { kind: 'set', cache: makeCache() }
    )
    const setRoot = await setTree.load()
    const setEntry = (await setRoot.getEntry(key('b'))).result
    setEntry.key.fill(0x78)
    t.alike(
      await setRoot.getEntry(key('b')).then(
        ({ result }) => result.key,
        (err) => err.code
      ),
      key('b'),
      'a set key is a copy'
    )
  })
}

// D-011 F-05. A key that is not bytes throws `INVALID_KEY` before any
// traversal, on the low-level reads as on the high-level ones.
test('low-level reads with a key that is not bytes throw INVALID_KEY', async (t) => {
  const tree = await Tree.create(list)
  const root = tree.root
  await t.exception.all(root.getEntry('a'), { code: 'INVALID_KEY' })
  await t.exception.all(root.getEntry('a'), TypeError)
  await t.exception.all(root.getEntry(1), { code: 'INVALID_KEY' })
  await t.exception.all(root.getEntries(['a']), { code: 'INVALID_KEY' })
  await t.exception.all(root.getEntries([key('a'), 'b']), { code: 'INVALID_KEY' })
  await t.exception.all(root.getEntries('a'), { code: 'INVALID_KEY' })
  await t.exception.all(root.getRangeEntries('a', key('z')), { code: 'INVALID_KEY' })
  await t.exception.all(root.getRangeEntries(key('a'), 'z'), { code: 'INVALID_KEY' })
  await t.exception.all(root.iterate({ gte: 'a' }).next(), { code: 'INVALID_KEY' })
  // The leaf path too.
  const leaf = (await collectNodes(root)).get(0)[0]
  await t.exception.all(leaf.getEntry('a'), { code: 'INVALID_KEY' })
  await t.exception.all(leaf.getEntries(['a']), { code: 'INVALID_KEY' })
  await t.exception.all(leaf.getRangeEntries('a', key('z')), { code: 'INVALID_KEY' })
  t.alike(await tree.get(key('a')), val(1), 'the tree still reads')
})
