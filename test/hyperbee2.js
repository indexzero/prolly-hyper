// Acceptance test 8: the hyperbee2 storage. A map written through
// `Hyperbee2Storage` in corestore A replicates to corestore B and reads there.
// The key layout, the compare-and-swap commit and the atomicity of one
// `write()` batch per commit are checked on observable bee state: the key
// count, `core.length`, `core.append` calls and `checkout` views.
const test = require('brittle')
const b4a = require('b4a')
const fs = require('fs/promises')
const os = require('os')
const path = require('path')
const Hyperbee2 = require('hyperbee2')
const Corestore = require('corestore')
const { ProllyMap } = require('../lib/map')
const { load } = require('../lib/tree')
const { bf } = require('../lib/chunker')
const { nocache } = require('../lib/cache')
const { Hyperbee2Storage, ROOT_KEY, BLOCK_PREFIX } = require('../lib/storage/hyperbee2')
const { randomEntries, sortEntries, collectNodes } = require('./helpers')

const key = (str) => b4a.from(str)
const val = (str) => b4a.from(str)
const hex = (buf) => (buf === null ? null : b4a.toString(buf, 'hex'))
const chunker = bf(3)
const PREFIX = 'prolly-hyper-test-'

// Two corestores under the operating system temporary directory, the one
// allowed use of it (RAILS rule 24). The teardown closes every bee and store,
// removes both directories and lists the parent to prove that they are gone.
async function setup(t) {
  const dirs = []
  const bees = []
  const streams = []
  const mkdir = async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), PREFIX))
    dirs.push(dir)
    return dir
  }
  const storeA = new Corestore(await mkdir())
  const storeB = new Corestore(await mkdir())
  const track = (bee) => {
    bees.push(bee)
    return bee
  }
  t.teardown(async () => {
    for (const s of streams) s.destroy()
    for (const bee of bees.reverse()) await bee.close()
    await storeA.close()
    await storeB.close()
    for (const dir of dirs) await fs.rm(dir, { recursive: true, force: true })
    const left = (await fs.readdir(os.tmpdir())).filter((name) =>
      dirs.some((dir) => path.basename(dir) === name)
    )
    if (left.length) throw new Error(`corestore directories left behind: ${left.join(', ')}`)
  })
  // Pipe a replication stream between the two stores. Both ends are destroyed
  // in the teardown, as the hyperbee2 test helper does.
  const replicate = (a, b) => {
    const s1 = a.replicate(true)
    const s2 = b.replicate(false)
    s1.pipe(s2).pipe(s1)
    streams.push(s1, s2)
  }
  return { storeA, storeB, track, replicate }
}

async function writer(t) {
  const ctx = await setup(t)
  const bee = ctx.track(new Hyperbee2(ctx.storeA))
  await bee.ready()
  return { ...ctx, bee, storage: new Hyperbee2Storage(bee) }
}

// Every key in the bee, as hex, through a read stream over the whole range.
async function beeKeys(bee) {
  const out = []
  for await (const { key } of bee.createReadStream()) out.push(hex(key))
  return out.sort()
}

const blockKey = (address) => hex(b4a.concat([BLOCK_PREFIX, address]))

// Every node address reachable from `root`, as hex.
async function addresses(root) {
  const out = new Set()
  for (const nodes of (await collectNodes(root)).values()) {
    for (const node of nodes) out.add(hex(node.address))
  }
  return out
}

test('Hyperbee2Storage: the key layout of the Storage interface section', async (t) => {
  t.alike(ROOT_KEY, b4a.from([0x00]))
  t.alike(BLOCK_PREFIX, b4a.from([0x01]))
  await t.exception.all(() => new Hyperbee2Storage(), TypeError)
  await t.exception.all(() => new Hyperbee2Storage({}), TypeError)
})

test('a 1-key tree writes exactly two keys into the bee, the root and one block', async (t) => {
  const { bee, storage } = await writer(t)
  t.is(await storage.root(), null, 'an empty bee has no root')
  t.is(await storage.get(b4a.alloc(32)), null)
  const map = await ProllyMap.open(storage, { chunker })
  await map.put(key('a'), val('b'))
  const root = map.root
  t.ok(root)
  t.alike(await beeKeys(bee), [hex(ROOT_KEY), blockKey(root)].sort())
  t.alike((await bee.get(ROOT_KEY)).value, root, 'the root key holds the 32-byte address')
  t.alike(await storage.root(), root)
  const bytes = await storage.get(root)
  t.alike(bytes, (await bee.get(b4a.concat([BLOCK_PREFIX, root]))).value)
  bytes.fill(0)
  t.alike(
    await storage.get(root),
    (await bee.get(b4a.concat([BLOCK_PREFIX, root]))).value,
    'get returns a copy'
  )
  const r = await storage.root()
  r.fill(0)
  t.alike(await storage.root(), root, 'root returns a copy')
  t.alike(await map.get(key('a')), val('b'))
})

test('a commit with root null deletes the root key and keeps the blocks', async (t) => {
  const { bee, storage } = await writer(t)
  const map = await ProllyMap.open(storage, { chunker })
  await map.put(key('a'), val('b'))
  const root = map.root
  await map.delete(key('a'))
  t.is(map.root, null)
  t.is(await storage.root(), null)
  t.is(await bee.get(ROOT_KEY), null, 'the root key is absent')
  t.alike(await beeKeys(bee), [blockKey(root)], 'the block stays')
  t.alike(await storage.get(root), (await bee.get(b4a.concat([BLOCK_PREFIX, root]))).value)
  // The tree is still readable at the old root.
  const old = await load({ address: root, storage, chunker, kind: 'map' })
  t.alike((await old.getEntry(key('a'))).result.value, val('b'))
})

test('a second commit of the same blocks changes no bee key count', async (t) => {
  const { bee, storage } = await writer(t)
  const list = sortEntries(randomEntries(1, 60))
  const map = await ProllyMap.open(storage, { chunker })
  await map.batch(list)
  const root = map.root
  const node = await load({ address: root, storage, chunker, kind: 'map' })
  const blocks = []
  for (const nodes of (await collectNodes(node)).values()) {
    for (const n of nodes) blocks.push({ address: n.address, bytes: n.bytes })
  }
  t.ok(blocks.length > 1)
  const keys = await beeKeys(bee)
  t.is(keys.length, blocks.length + 1, 'one key per block plus the root')
  const length = bee.core.length
  await storage.commit({ blocks, root, expected: root })
  t.alike(await beeKeys(bee), keys, 'no bee key changed')
  t.is(bee.core.length, length, 'nothing was appended')
  t.alike(await storage.root(), root)
})

test('a commit with a stale expected throws CONFLICT and changes no bee key', async (t) => {
  const { bee, storage } = await writer(t)
  const list = sortEntries(randomEntries(2, 60))
  const map = await ProllyMap.open(storage, { chunker })
  await map.batch(list)
  const root = map.root
  const node = await load({ address: root, storage, chunker, kind: 'map' })
  const { root: next, blocks } = await node.bulk([{ key: key('new'), value: val('1') }])
  const keys = await beeKeys(bee)
  const length = bee.core.length
  await t.exception(storage.commit({ blocks, root: next.address, expected: null }), {
    code: 'CONFLICT'
  })
  await t.exception(storage.commit({ blocks, root: next.address, expected: next.address }), {
    code: 'CONFLICT'
  })
  t.alike(await beeKeys(bee), keys, 'no bee key changed')
  t.is(bee.core.length, length)
  t.alike(await storage.root(), root, 'the root is unchanged')
  // The lock is released: the right expected commits.
  await storage.commit({ blocks, root: next.address, expected: root })
  t.alike(await storage.root(), next.address)
  t.is((await beeKeys(bee)).length, keys.length + blocks.length)
  // A second instance on the same bee gets CONFLICT through ProllyMap.
  const other = await ProllyMap.open(new Hyperbee2Storage(bee), { chunker })
  const mine = await ProllyMap.open(new Hyperbee2Storage(bee), { chunker })
  await mine.put(key('x'), val('1'))
  await t.exception(other.put(key('y'), val('2')), { code: 'CONFLICT' })
  t.alike(await storage.root(), mine.root)
})

test('an empty bee: a commit with a stale expected throws CONFLICT and appends nothing', async (t) => {
  const { bee, storage } = await writer(t)
  const bytes = val('node')
  const address = require('../lib/hash').address(bytes)
  await t.exception(
    storage.commit({ blocks: [{ address, bytes }], root: address, expected: address }),
    { code: 'CONFLICT' }
  )
  t.is(bee.core.length, 0, 'no genesis block was appended')
  t.is(await storage.root(), null)
  await storage.commit({ blocks: [{ address, bytes }], root: address, expected: null })
  t.alike(await storage.root(), address)
})

test('commit checks its arguments and writes nothing on a bad one', async (t) => {
  const { bee, storage } = await writer(t)
  const bytes = val('node')
  const address = require('../lib/hash').address(bytes)
  await t.exception.all(storage.commit({ blocks: [], root: address }), TypeError)
  await t.exception.all(storage.commit({ blocks: [], expected: null }), TypeError)
  await t.exception.all(
    storage.commit({ blocks: [{ address: b4a.alloc(4), bytes }], root: address, expected: null }),
    TypeError
  )
  await t.exception.all(
    storage.commit({ blocks: [], root: b4a.alloc(4), expected: null }),
    TypeError
  )
  await t.exception.all(storage.get('x'), TypeError)
  t.is(bee.core.length, 0)
  t.is(await storage.root(), null)
})

test('a 500-key map replicates to a second corestore and every key reads there', async (t) => {
  const { bee, storage, storeB, track, replicate } = await writer(t)
  const list = sortEntries(randomEntries(3, 500))
  const map = await ProllyMap.open(storage, { chunker })
  await map.batch(list)
  const root = map.root
  t.ok(root)

  // The replica pins an empty root at ready() (index.js:45-46, :186). Open it
  // read-only, replicate, and update the core before the first read.
  const replica = track(new Hyperbee2(storeB, { key: bee.core.key, writable: false }))
  await replica.ready()
  replicate(bee, replica)
  await replica.core.update({ wait: true })
  t.is(replica.core.length, bee.core.length, 'the replica knows the length')

  const remote = new Hyperbee2Storage(replica)
  t.alike(await remote.root(), root, 'the root replicates')
  const copy = await ProllyMap.open(remote, { chunker, cache: nocache })
  t.alike(copy.root, root)
  for (const { key, value } of list) t.alike(await copy.get(key), value)
  t.is(await copy.get(b4a.alloc(32, 0xff)), null)
  let count = 0
  for await (const { key, value } of copy.range()) {
    t.alike(key, list[count].key)
    t.alike(value, list[count].value)
    count++
  }
  t.is(count, 500)
  // The replica cannot write.
  await t.exception(remote.commit({ blocks: [], root: null, expected: root }), /Not writable/)
  // A later write in A reaches B after an update.
  await map.put(key('late'), val('1'))
  await replica.core.update({ wait: true })
  t.alike(await remote.root(), map.root)
  const again = await ProllyMap.open(remote, { chunker })
  t.alike(await again.get(key('late')), val('1'))
})

test('atomicity: one append per batch, checkouts, and a failed flush', async (t) => {
  const { bee, storage } = await writer(t)
  const list = sortEntries(randomEntries(4, 250))
  const map = await ProllyMap.open(storage, { chunker })
  await map.batch(list.slice(0, 50))
  const oldRoot = map.root
  const oldNode = await load({ address: oldRoot, storage, chunker, kind: 'map' })
  const oldAddresses = await addresses(oldNode)
  const before = bee.core.length

  // One `core.append` call per commit. `_flush` collects every block of the
  // batch and appends them in one call (lib/write.js:528-549). One call can
  // carry more than one core block, so the block count is not asserted.
  const core = bee.core
  const append = core.append.bind(core)
  let calls = 0
  core.append = (...args) => {
    calls++
    return append(...args)
  }
  await map.batch(list.slice(50))
  core.append = append
  t.is(calls, 1, 'a 200-key batch makes exactly one append call')
  const newRoot = map.root
  const after = bee.core.length
  t.ok(after > before)
  const newNode = await load({ address: newRoot, storage, chunker, kind: 'map' })
  const newAddresses = await addresses(newNode)
  const added = [...newAddresses].filter((a) => !oldAddresses.has(a))
  t.ok(added.length > 0)

  // The checkout at `before` holds the old root and no new block.
  const viewBefore = bee.checkout({ length: before })
  const storageBefore = new Hyperbee2Storage(viewBefore)
  t.alike(await storageBefore.root(), oldRoot, 'the old checkout holds the old root')
  for (const a of added) t.is(await storageBefore.get(b4a.from(a, 'hex')), null)
  const oldTree = await load({
    address: oldRoot,
    storage: storageBefore,
    chunker,
    kind: 'map',
    cache: nocache
  })
  t.is(
    (await oldTree.getAllEntries()).result.length,
    50,
    'the old tree reads from the old checkout'
  )
  await viewBefore.close()

  // The checkout at `after` holds the new root and every block it reaches.
  const viewAfter = bee.checkout({ length: after })
  const storageAfter = new Hyperbee2Storage(viewAfter)
  t.alike(await storageAfter.root(), newRoot, 'the new checkout holds the new root')
  for (const a of newAddresses) t.ok(await storageAfter.get(b4a.from(a, 'hex')))
  const newTree = await load({
    address: newRoot,
    storage: storageAfter,
    chunker,
    kind: 'map',
    cache: nocache
  })
  const { result } = await newTree.getAllEntries()
  t.is(result.length, 250)
  for (let i = 0; i < list.length; i++) t.alike(result[i].value, list[i].value)
  await viewAfter.close()

  // A failed flush. The double makes `core.append` throw once, so `flush()`
  // throws at lib/write.js:549 and releases the lock in its finally block.
  // `core.length` stays at `before`, and the old root stays readable.
  const before2 = bee.core.length
  core.append = async () => {
    core.append = append
    throw new Error('disk full')
  }
  await t.exception(map.put(key('fail'), val('1')), /disk full/)
  t.is(bee.core.length, before2, 'nothing was appended')
  t.alike(await storage.root(), newRoot, 'the root is unchanged')
  t.alike(map.root, newRoot)
  t.is(await map.get(key('fail')), null)
  for (const { key, value } of list) t.alike(await map.get(key), value)
  const reopened = await ProllyMap.open(new Hyperbee2Storage(bee), { chunker, cache: nocache })
  t.alike(reopened.root, newRoot)
  t.alike(await reopened.get(list[0].key), list[0].value)
  // The storage recovers.
  await map.put(key('fail'), val('1'))
  t.alike(await map.get(key('fail')), val('1'))
  t.is(bee.core.length > before2, true)
})

// D-010 F-01. The lock that `commit` takes belongs to the `Hyperbee2` object
// (lib/context.js:19). Two `Hyperbee2` objects on one hypercore share the
// core and not the lock or the head. A writable bee never follows the appends
// of its core. So the second bee reads root null, equal to its `expected`,
// and without a guard it flushes from its stale root and the first write is
// unreachable from the new head.
test('two Hyperbee2 objects on one hypercore: the bee that is behind gets CONFLICT', async (t) => {
  const { storeA, track } = await setup(t)
  const beeA = track(new Hyperbee2(storeA))
  const beeB = track(new Hyperbee2(storeA))
  await beeA.ready()
  await beeB.ready()
  t.alike(beeA.core.key, beeB.core.key, 'one hypercore')
  t.not(beeA.context.lock, beeB.context.lock, 'two locks')
  const storageA = new Hyperbee2Storage(beeA)
  const storageB = new Hyperbee2Storage(beeB)
  const mapA = await ProllyMap.open(storageA, { chunker })
  const mapB = await ProllyMap.open(storageB, { chunker })

  await mapA.put(key('a'), val('1'))
  const length = beeA.core.length
  t.is(length, 1)
  t.is(await storageB.root(), null, 'the second bee does not see the head')

  // The second bee is behind its core. Its commit throws and appends nothing.
  await t.exception(mapB.put(key('b'), val('2')), { code: 'CONFLICT' })
  t.is(beeA.core.length, length, 'nothing was appended')
  await t.exception(storageB.commit({ blocks: [], root: null, expected: null }), {
    code: 'CONFLICT',
    message: 'the bee is behind its core: another Hyperbee2 wrote to it'
  })
  t.is(beeA.core.length, length, 'the guard appends nothing')

  // A fresh bee reads the head. The first write is there.
  const beeC = track(new Hyperbee2(storeA))
  await beeC.ready()
  const storageC = new Hyperbee2Storage(beeC)
  t.alike(await storageC.root(), mapA.root, 'the head holds the first write')
  const mapC = await ProllyMap.open(storageC, { chunker })
  t.alike(await mapC.get(key('a')), val('1'))
  t.is(await mapC.get(key('b')), null)

  // The first bee is at its head. It still commits.
  await mapA.put(key('c'), val('3'))
  t.is(beeA.core.length, length + 1)
  t.alike(await mapA.get(key('c')), val('3'))
})

// D-010 F-05 and F-07. A failed `flush()` unlocks in its finally and does not
// close the batch (lib/write.js:115-124), so the batch snapshot view stayed
// open. The no-flush path released the lock through the private
// `batch._unlock()` alone.
test('commit closes its batch on both paths and releases the lock without _unlock', async (t) => {
  const { bee, storage } = await writer(t)
  const map = await ProllyMap.open(storage, { chunker })
  await map.put(key('a'), val('1'))
  const batches = []
  const write = bee.write.bind(bee)
  bee.write = (...args) => {
    const batch = write(...args)
    batches.push(batch)
    return batch
  }

  // A failed flush. The double makes `core.append` throw once.
  const core = bee.core
  const append = core.append.bind(core)
  core.append = async () => {
    core.append = append
    throw new Error('disk full')
  }
  await t.exception(map.put(key('b'), val('2')), /disk full/)
  t.is(batches.length, 1)
  t.is(batches[0].closed, true, 'the batch is closed after a failed flush')
  t.is(bee.context.lock.locked, false, 'the lock is released after a failed flush')

  // A batch without `_unlock`. The no-flush path falls back to the context lock.
  bee.write = (...args) => {
    const batch = write(...args)
    batch._unlock = undefined
    batches.push(batch)
    return batch
  }
  // `exception.all`: without the fallback the finally throws a TypeError.
  await t.exception.all(storage.commit({ blocks: [], root: null, expected: null }), {
    code: 'CONFLICT'
  })
  t.is(batches.length, 2)
  t.is(batches[1].closed, true, 'the batch is closed on the no-flush path')
  t.is(bee.context.lock.locked, false, 'the lock is released without _unlock')
  bee.write = write

  // The storage recovers. A held lock would make the put wait forever.
  const outcome = await Promise.race([
    map.put(key('c'), val('3')).then(() => 'committed'),
    new Promise((resolve) => setTimeout(() => resolve('hung'), 2000))
  ])
  t.is(outcome, 'committed')
  t.alike(await map.get(key('c')), val('3'))
  t.alike(await map.get(key('a')), val('1'))
})
