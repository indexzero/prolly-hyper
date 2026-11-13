// Acceptance test 9: `diff(a, b, opts)` of TECHNICAL.DESIGN.md decision 9.
// The expected output comes from a merge of the two sorted lists. The bound
// test on the fixture `diff-counterexample.json` is the one that catches a
// diff that descends into every node. Do not weaken it.
const test = require('brittle')
const b4a = require('b4a')
const { diff } = require('../lib/diff')
const { ProllySet } = require('../lib/set')
const { load } = require('../lib/tree')
const { bf } = require('../lib/chunker')
const { nocache } = require('../lib/cache')
const {
  storage,
  randomEntries,
  sortEntries,
  seeded,
  shuffle,
  build,
  collectNodes
} = require('./helpers')
const fixture = require('./fixtures/diff-counterexample.json')

const FACTOR = 3
const hex = (buf) => (buf === null ? null : b4a.toString(buf, 'hex'))
const unhex = (str) => b4a.from(str, 'hex')

async function collect(iterator) {
  const out = []
  for await (const item of iterator) out.push(item)
  return out
}

// A tree in its own storage. `root` is the loaded root node, or null.
async function tree(list, { kind = 'map', chunker = bf(FACTOR), cache = nocache } = {}) {
  const store = storage()
  const address = await build({ list: sortEntries(list), storage: store, chunker, kind })
  if (address === null) return { root: null, store, address }
  const root = await load({ address, storage: store, chunker, kind, cache })
  return { root, store, address }
}

// The expected diff: a merge of two sorted lists. For a set, pass lists of
// `{ key }` and the sides are the keys.
function expectedDiff(left, right, kind = 'map') {
  const side = (e) => (kind === 'map' ? e.value : e.key)
  const l = sortEntries(left)
  const r = sortEntries(right)
  const out = []
  let i = 0
  let j = 0
  while (i < l.length || j < r.length) {
    if (j >= r.length || (i < l.length && b4a.compare(l[i].key, r[j].key) < 0)) {
      out.push({ key: l[i].key, left: side(l[i]), right: null })
      i++
    } else if (i >= l.length || b4a.compare(l[i].key, r[j].key) > 0) {
      out.push({ key: r[j].key, left: null, right: side(r[j]) })
      j++
    } else {
      if (!b4a.equals(side(l[i]), side(r[j]))) {
        out.push({ key: l[i].key, left: side(l[i]), right: side(r[j]) })
      }
      i++
      j++
    }
  }
  return out
}

function toHex(list) {
  return list.map(({ key, left, right }) => ({ key: hex(key), left: hex(left), right: hex(right) }))
}

function assertSorted(t, list, label) {
  for (let i = 1; i < list.length; i++) {
    if (b4a.compare(list[i - 1].key, list[i].key) >= 0) {
      t.fail(`${label}: keys are not in ascending order at ${i}`)
      return
    }
  }
  t.pass(`${label}: keys are in ascending order`)
}

async function assertDiff(t, a, b, want, label) {
  const stats = {}
  const got = await collect(diff(a, b, { stats }))
  t.alike(toHex(got), toHex(want), label)
  assertSorted(t, got, label)
  t.ok(stats.visitedLeft instanceof Set, `${label}: visitedLeft is a Set`)
  t.ok(stats.visitedRight instanceof Set, `${label}: visitedRight is a Set`)
  for (const s of [...stats.visitedLeft, ...stats.visitedRight]) {
    if (typeof s !== 'string' || s.length !== 64) {
      t.fail(`${label}: ${String(s)} is not a hex address`)
    }
  }
  return { got, stats }
}

async function nodeAddresses(root) {
  const out = new Set()
  if (root === null) return out
  for (const level of (await collectNodes(root)).values()) {
    for (const node of level) out.add(hex(node.address))
  }
  return out
}

// Equal trees

test('diff(a, a) yields nothing and visits only the root', async (t) => {
  const list = randomEntries(1, 200)
  const { root } = await tree(list)
  const { stats } = await assertDiff(t, root, root, [], 'same node')
  t.alike([...stats.visitedLeft], [hex(root.address)])
  t.alike([...stats.visitedRight], [hex(root.address)])
})

test('two equal trees in two storages yield nothing', async (t) => {
  const list = randomEntries(2, 200)
  const a = await tree(list)
  const b = await tree(shuffle(list, seeded(7)))
  t.is(hex(a.address), hex(b.address))
  const { stats } = await assertDiff(t, a.root, b.root, [], 'equal roots')
  t.is(stats.visitedLeft.size, 1)
  t.is(stats.visitedRight.size, 1)
})

test('diff(null, null) yields nothing', async (t) => {
  const stats = {}
  t.alike(await collect(diff(null, null, { stats })), [])
  t.is(stats.visitedLeft.size, 0)
  t.is(stats.visitedRight.size, 0)
  t.alike(await collect(diff(null, null)), [], 'stats are optional')
})

// Inserted, deleted and changed keys

for (const seed of [3, 4, 5]) {
  test(`k inserted, k deleted and k changed keys, both directions, seed ${seed}`, async (t) => {
    const k = 5
    const random = seeded(seed * 77)
    const base = randomEntries(seed, 200)
    const extra = randomEntries(seed + 100, k)
    const picked = shuffle(base, random)
    const deleted = new Set(picked.slice(0, k).map((e) => hex(e.key)))
    const changed = new Set(picked.slice(k, 2 * k).map((e) => hex(e.key)))
    const right = base
      .filter((e) => !deleted.has(hex(e.key)))
      .map((e) => (changed.has(hex(e.key)) ? { key: e.key, value: b4a.from([0, 1, 2]) } : e))
      .concat(extra)
    const a = await tree(base)
    const b = await tree(right)
    const want = expectedDiff(base, right)
    t.is(want.length, 3 * k, `exactly ${3 * k} keys differ`)
    t.is(want.filter((e) => e.left !== null && e.right !== null).length, k, `${k} changed`)
    t.is(want.filter((e) => e.left === null).length, k, `${k} inserted`)
    t.is(want.filter((e) => e.right === null).length, k, `${k} deleted`)
    const { got } = await assertDiff(t, a.root, b.root, want, 'a against b')
    for (const e of got) {
      if (e.left !== null) t.alike(e.left, base.find((x) => b4a.equals(x.key, e.key)).value)
      if (e.right !== null) t.alike(e.right, right.find((x) => b4a.equals(x.key, e.key)).value)
    }
    await assertDiff(t, b.root, a.root, expectedDiff(right, base), 'b against a')
    const flipped = want.map(({ key, left, right }) => ({ key, left: right, right: left }))
    t.alike(toHex(expectedDiff(right, base)), toHex(flipped), 'the reverse diff swaps the sides')
  })
}

test('yielded keys and values are copies', async (t) => {
  const list = randomEntries(8, 30)
  const a = await tree(list)
  const b = await tree(list.slice(0, 20))
  const first = await collect(diff(a.root, b.root))
  for (const e of first) {
    e.key.fill(0)
    if (e.left) e.left.fill(0)
    if (e.right) e.right.fill(0)
  }
  const second = await collect(diff(a.root, b.root))
  t.alike(toHex(second), toHex(expectedDiff(list, list.slice(0, 20))))
})

// An empty tree against a full one

test('an empty tree against a full one yields every key with one null side', async (t) => {
  const list = randomEntries(6, 200)
  const b = await tree(list)
  const total = (await nodeAddresses(b.root)).size
  const { stats } = await assertDiff(
    t,
    null,
    b.root,
    sortEntries(list).map((e) => ({ key: e.key, left: null, right: e.value })),
    'null against b'
  )
  t.is(stats.visitedLeft.size, 0)
  t.is(stats.visitedRight.size, total, 'every node of b is visited')
  const back = await assertDiff(
    t,
    b.root,
    null,
    sortEntries(list).map((e) => ({ key: e.key, left: e.value, right: null })),
    'b against null'
  )
  t.is(back.stats.visitedLeft.size, total)
  t.is(back.stats.visitedRight.size, 0)
})

test('diff is lazy: the first key comes out before the whole tree is visited', async (t) => {
  const list = randomEntries(9, 500)
  const b = await tree(list)
  const total = (await nodeAddresses(b.root)).size
  const stats = {}
  const iterator = diff(null, b.root, { stats })
  const { value, done } = await iterator.next()
  t.is(done, false)
  t.is(hex(value.key), hex(sortEntries(list)[0].key))
  t.ok(stats.visitedRight.size < total / 2, `${stats.visitedRight.size} of ${total} nodes visited`)
  await iterator.return()
})

// Disjoint ranges

test('disjoint key ranges yield everything', async (t) => {
  const left = randomEntries(10, 100).map((e) => ({
    key: b4a.concat([b4a.from('a'), e.key]),
    value: e.value
  }))
  const right = randomEntries(11, 100).map((e) => ({
    key: b4a.concat([b4a.from('b'), e.key]),
    value: e.value
  }))
  const a = await tree(left)
  const b = await tree(right)
  const want = expectedDiff(left, right)
  t.is(want.length, 200)
  await assertDiff(t, a.root, b.root, want, 'disjoint, a then b')
  await assertDiff(t, b.root, a.root, expectedDiff(right, left), 'disjoint, b then a')
  // Interleaved disjoint ranges: every other key.
  const all = sortEntries(randomEntries(12, 200))
  const even = all.filter((e, i) => i % 2 === 0)
  const odd = all.filter((e, i) => i % 2 === 1)
  const c = await tree(even)
  const d = await tree(odd)
  await assertDiff(t, c.root, d.root, expectedDiff(even, odd), 'interleaved')
})

// The bound on the fixture

test('bound: diff-counterexample.json visits at most 2 * unmatched + height + 1 nodes per side', async (t) => {
  t.is(fixture.list.length, 1005)
  t.is(fixture.newer.length, 1005)
  t.alike(fixture.changed, [16, 230, 420, 620, 846])
  const toEntry = (e) => ({ key: unhex(e.key), value: unhex(e.value) })
  const left = fixture.list.map(toEntry)
  const right = fixture.newer.map(toEntry)
  const a = await tree(left)
  const b = await tree(right)
  t.not(hex(a.address), hex(b.address))

  // Count, by full traversal, the nodes of each tree whose address is absent
  // from the other tree.
  const leftAddresses = await nodeAddresses(a.root)
  const rightAddresses = await nodeAddresses(b.root)
  let unmatchedLeft = 0
  for (const s of leftAddresses) if (!rightAddresses.has(s)) unmatchedLeft++
  let unmatchedRight = 0
  for (const s of rightAddresses) if (!leftAddresses.has(s)) unmatchedRight++
  const heightLeft = a.root.distance
  const heightRight = b.root.distance
  t.comment(
    `left: ${leftAddresses.size} nodes, ${unmatchedLeft} unmatched, height ${heightLeft}. ` +
      `right: ${rightAddresses.size} nodes, ${unmatchedRight} unmatched, height ${heightRight}`
  )
  t.is(unmatchedLeft, 39, 'the fixture has 39 unmatched nodes on the left')
  t.is(unmatchedRight, 26, 'the fixture has 26 unmatched nodes on the right')

  const want = expectedDiff(left, right)
  t.is(want.length, 5)
  t.alike(
    want.map((e) => hex(e.key)),
    fixture.changed.map((i) => fixture.list[i].key)
  )
  const { stats } = await assertDiff(t, a.root, b.root, want, 'the five changed values')
  const boundLeft = 2 * unmatchedLeft + heightLeft + 1
  const boundRight = 2 * unmatchedRight + heightRight + 1
  t.comment(
    `visitedLeft ${stats.visitedLeft.size} <= ${boundLeft}, ` +
      `visitedRight ${stats.visitedRight.size} <= ${boundRight}`
  )
  t.ok(stats.visitedLeft.size <= boundLeft, `visitedLeft ${stats.visitedLeft.size} <= ${boundLeft}`)
  t.ok(
    stats.visitedRight.size <= boundRight,
    `visitedRight ${stats.visitedRight.size} <= ${boundRight}`
  )
  // A leaf-only skip visits 179 and 166 nodes on this fixture.
  t.ok(stats.visitedLeft.size < 179, 'fewer than a leaf-only skip on the left')
  t.ok(stats.visitedRight.size < 166, 'fewer than a leaf-only skip on the right')
  // Every visited address is a node of its own tree.
  for (const s of stats.visitedLeft) {
    if (!leftAddresses.has(s)) t.fail(`${s} is not in the left tree`)
  }
  for (const s of stats.visitedRight) {
    if (!rightAddresses.has(s)) t.fail(`${s} is not in the right tree`)
  }

  const back = await assertDiff(t, b.root, a.root, expectedDiff(right, left), 'the other direction')
  t.ok(back.stats.visitedLeft.size <= boundRight)
  t.ok(back.stats.visitedRight.size <= boundLeft)
})

// Different heights and a shared subtree under a different parent slot

test('trees of different height with a shared subtree under a different parent slot', async (t) => {
  // B holds every key of A plus 400 keys that sort below all of them, so the
  // leaves of A sit under other parents in B, and B is taller. The seeds come
  // from sslop/D-004/probe-heights.out: A has height 4 and B has height 9.
  const listA = randomEntries(29, 200).map((e) => ({
    key: b4a.concat([b4a.from([0xff]), e.key]),
    value: e.value
  }))
  const below = randomEntries(30, 400).map((e) => ({
    key: b4a.concat([b4a.from([0x00]), e.key]),
    value: e.value
  }))
  const listB = listA.concat(below)
  const a = await tree(listA)
  const b = await tree(listB)
  t.ok(b.root.distance > a.root.distance, `heights ${a.root.distance} and ${b.root.distance}`)
  const addressesA = await nodeAddresses(a.root)
  const addressesB = await nodeAddresses(b.root)
  const totalA = addressesA.size
  const shared = [...addressesA].filter((s) => addressesB.has(s))
  const unmatchedA = totalA - shared.length
  t.ok(shared.length > 0, `${shared.length} of ${totalA} nodes of A also exist in B`)
  const want = expectedDiff(listA, listB)
  t.is(want.length, 400)
  const { stats } = await assertDiff(t, a.root, b.root, want, 'a against taller b')
  const boundA = 2 * unmatchedA + a.root.distance + 1
  t.comment(`visitedLeft ${stats.visitedLeft.size} <= ${boundA}, ${unmatchedA} unmatched in A`)
  t.ok(
    stats.visitedLeft.size <= boundA,
    `${stats.visitedLeft.size} of ${totalA} nodes of A visited`
  )
  const back = await assertDiff(t, b.root, a.root, expectedDiff(listB, listA), 'taller b against a')
  t.ok(back.stats.visitedRight.size <= boundA)

  // A shared middle: C holds A's keys with 200 keys below and 200 above.
  const above = randomEntries(31, 200).map((e) => ({
    key: b4a.concat([b4a.from([0xff, 0xff]), e.key]),
    value: e.value
  }))
  const listC = below.slice(0, 200).concat(listA, above)
  const c = await tree(listC)
  t.not(c.root.distance, a.root.distance, `heights ${a.root.distance} and ${c.root.distance}`)
  const middle = await assertDiff(t, a.root, c.root, expectedDiff(listA, listC), 'a against c')
  t.ok(middle.stats.visitedLeft.size < totalA, `${middle.stats.visitedLeft.size} of ${totalA}`)
  await assertDiff(t, c.root, a.root, expectedDiff(listC, listA), 'c against a')
})

// Sets

test('a one-leaf set against a many-leaf set', async (t) => {
  const keys = sortEntries(randomEntries(16, 100)).map(({ key }) => ({ key }))
  const small = [keys[10], keys[50]]
  const a = await tree(small, { kind: 'set' })
  const b = await tree(keys, { kind: 'set' })
  t.ok(a.root.isLeaf, 'a one-leaf set root is the leaf')
  t.is(a.root.bytes[1], 2, 'wire kind 2')
  t.ok(b.root.isBranch)
  t.is(b.root.bytes[1], 1, 'wire kind 1')
  const want = expectedDiff(small, keys, 'set')
  t.is(want.length, 98)
  const { got } = await assertDiff(t, a.root, b.root, want, 'one leaf against many')
  for (const e of got) {
    t.is(e.left, null)
    t.alike(e.right, e.key, 'for a set the present side is the key')
  }
  await assertDiff(t, b.root, a.root, expectedDiff(keys, small, 'set'), 'many against one leaf')
  await assertDiff(t, a.root, a.root, [], 'one leaf against itself')
  const other = await tree([keys[10], keys[51]], { kind: 'set' })
  await assertDiff(
    t,
    a.root,
    other.root,
    expectedDiff(small, [keys[10], keys[51]], 'set'),
    'two one-leaf sets'
  )
  await assertDiff(t, null, a.root, expectedDiff([], small, 'set'), 'null against one leaf')
})

test('two sets built through ProllySet in two storages', async (t) => {
  const keys = randomEntries(17, 150).map(({ key }) => key)
  const setA = await ProllySet.open(storage(), { chunker: bf(FACTOR) })
  const setB = await ProllySet.open(storage(), { chunker: bf(FACTOR) })
  await setA.batch(keys.map((key) => ({ key })))
  await setB.batch(keys.slice(20).map((key) => ({ key })))
  await setB.batch(randomEntries(18, 10).map(({ key }) => ({ key })))
  const a = await load({
    address: setA.root,
    storage: setA.storage,
    chunker: bf(FACTOR),
    kind: 'set'
  })
  const b = await load({
    address: setB.root,
    storage: setB.storage,
    chunker: bf(FACTOR),
    kind: 'set'
  })
  const left = keys.map((key) => ({ key }))
  const right = keys
    .slice(20)
    .concat(randomEntries(18, 10).map(({ key }) => key))
    .map((key) => ({ key }))
  await assertDiff(t, a, b, expectedDiff(left, right, 'set'), 'set a against set b')
  await assertDiff(t, b, a, expectedDiff(right, left, 'set'), 'set b against set a')
})

// Kind mismatch

test('a map root against a set root throws KIND_MISMATCH, whatever the wire kinds', async (t) => {
  const list = sortEntries(randomEntries(19, 100))
  const keys = list.map(({ key }) => ({ key }))
  const mapLeaf = await tree(list.slice(0, 1))
  const setLeaf = await tree(keys.slice(0, 1), { kind: 'set' })
  const mapBranch = await tree(list)
  const setBranch = await tree(keys, { kind: 'set' })
  t.ok(mapLeaf.root.isLeaf && setLeaf.root.isLeaf)
  t.ok(mapBranch.root.isBranch && setBranch.root.isBranch)
  t.is(mapBranch.root.bytes[1], setBranch.root.bytes[1], 'both branch roots have wire kind 1')
  const pairs = [
    [mapLeaf, setLeaf, 'map leaf against set leaf'],
    [setLeaf, mapLeaf, 'set leaf against map leaf'],
    [mapBranch, setBranch, 'map branch against set branch, equal wire kinds'],
    [setBranch, mapBranch, 'set branch against map branch, equal wire kinds'],
    [mapLeaf, setBranch, 'map leaf against set branch'],
    [setLeaf, mapBranch, 'set leaf against map branch'],
    [mapBranch, setLeaf, 'map branch against set leaf']
  ]
  for (const [x, y, label] of pairs) {
    await t.exception(collect(diff(x.root, y.root)), { code: 'KIND_MISMATCH' }, label)
  }
  // The same wire kinds and the same collection kind do not throw.
  await t.execution(collect(diff(mapLeaf.root, mapBranch.root)), 'map leaf against map branch')
  await t.execution(collect(diff(setLeaf.root, setBranch.root)), 'set leaf against set branch')
  await t.execution(collect(diff(null, setLeaf.root)), 'null against a set leaf')
})

test('diff rejects a side that is not a node or null', async (t) => {
  const { root } = await tree(randomEntries(20, 10))
  await t.exception.all(collect(diff(root, {})), TypeError)
  await t.exception.all(collect(diff('a', root)), TypeError)
  await t.exception.all(collect(diff(root, undefined)), TypeError)
  await t.exception.all(collect(diff(root)), TypeError)
})
