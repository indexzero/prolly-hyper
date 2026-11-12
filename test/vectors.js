// Acceptance test 2: the hand-derived node vectors first, then the six
// independent tree vectors. `test/vectors.json` is the truth. A disagreement
// is a port defect until a cited reading of the Wire encoding section proves
// the vector wrong. Never regenerate a vector.
const test = require('brittle')
const b4a = require('b4a')
const vectors = require('./vectors.json')
const { encodeNode, decodeNode, encodeEntry } = require('../lib/encoding')
const { address, identity } = require('../lib/hash')
const { bf } = require('../lib/chunker')
const { create, Entry } = require('../lib/tree')
const { storage, collectNodes } = require('./helpers')

const hex = (buf) => b4a.toString(buf, 'hex')
const unhex = (str) => b4a.from(str, 'hex')

function toEntries(node) {
  return node.entries.map((e) => {
    const out = { key: unhex(e.key) }
    if (e.value !== undefined) out.value = unhex(e.value)
    if (e.address !== undefined) out.address = unhex(e.address)
    return out
  })
}

for (const node of vectors.nodes) {
  test(`hand-derived node vector: ${node.name}`, (t) => {
    const bytes = encodeNode({
      kind: node.kind,
      closed: node.closed,
      distance: node.distance,
      entries: toEntries(node)
    })
    t.is(hex(bytes), node.bytes, 'bytes')
    t.is(hex(address(bytes)), node.address, 'address')
    const decoded = decodeNode(unhex(node.bytes))
    t.is(decoded.kind, node.kind)
    t.is(decoded.closed, node.closed)
    t.is(decoded.distance, node.distance)
    t.alike(decoded.entries, toEntries(node))
  })
}

test('hand-derived entry identity: [a = b]', (t) => {
  const v = vectors.entryIdentity['a = b']
  const bytes = encodeEntry(v.kind, { key: unhex(v.key), value: unhex(v.value) })
  t.is(hex(bytes), v.bytes)
  t.is(hex(address(bytes)), v.hash)
  t.is(identity(bytes), v.identity)
  t.is(Math.floor(0xffffffff / 3), v.threshold3)
  const entry = new Entry({ key: unhex(v.key), value: unhex(v.value) }, { kind: v.kind })
  t.is(bf(3)(entry), v.boundary3)
})

test('hand-derived entry identity: set entry with a 300-byte key', (t) => {
  const v = vectors.entryIdentity['set entry, 300-byte key']
  const bytes = encodeEntry(v.kind, { key: b4a.alloc(v.keyLength) })
  t.is(hex(bytes).slice(0, 6), v.prefix)
  t.is(bytes.byteLength, 3 + v.keyLength)
})

test('independent identity example: key-00/val-00 and the two wrong windows', (t) => {
  const v = vectors.trees.identityExample
  const bytes = encodeEntry(0, { key: b4a.from('key-00'), value: b4a.from('val-00') })
  t.is(hex(bytes), v.entryBytesHex)
  const hash = address(bytes)
  t.is(hex(hash), v.blake2b256Hex)
  t.is(identity(bytes), v.identityLE_last4, 'little-endian read of the last 4 bytes')
  t.is(hash.readUInt32BE(28), v.identityBE_last4_wrong)
  t.is(hash.readUInt32LE(0), v.identityLE_first4_wrong)
  t.not(identity(bytes), v.identityBE_last4_wrong, 'a big-endian read is wrong')
  t.not(identity(bytes), v.identityLE_first4_wrong, 'a read of the first 4 bytes is wrong')
  t.is(Math.floor(0xffffffff / 2), v.threshold2)
  t.is(Math.floor(0xffffffff / 32), v.threshold32)
})

// The fixed list: 16 keys `key-00` to `key-15`, values `val-00` to `val-15`.
function fixedList() {
  const list = []
  for (let i = 0; i < 16; i++) {
    const n = String(i).padStart(2, '0')
    list.push({ key: b4a.from(`key-${n}`), value: b4a.from(`val-${n}`) })
  }
  return list.sort((a, b) => b4a.compare(a.key, b.key))
}

for (const factor of [32, 3, 2]) {
  for (const kind of ['map', 'set']) {
    const name = `${kind}-factor${factor}`
    const v = vectors.trees[name]
    test(`independent tree vector: ${kind}, factor ${factor}`, async (t) => {
      const list = kind === 'map' ? fixedList() : fixedList().map(({ key }) => ({ key }))
      const chunker = bf(factor)
      const store = storage()
      const nodes = []
      let root = null
      for await (const node of create({ list, storage: store, chunker, kind })) {
        nodes.push(node)
        root = node
      }
      t.is(hex(root.address), v.root, 'root address')
      t.is(hex(root.bytes), v.rootBytesHex, 'root bytes')
      t.is(nodes.length, v.nodes, 'node count')
      t.is(nodes.filter((n) => n.distance === 0).length, v.leaves, 'leaf count')
      t.is(root.distance, v.rootDistance, 'root distance')
      t.is(root.closed, v.rootClosed, 'root closed')
      const leafKind = kind === 'map' ? 0 : 2
      const boundaries = list
        .filter((e) => chunker(new Entry(e, { kind: leafKind })))
        .map((e) => b4a.toString(e.key))
      t.alike(boundaries, v.boundaryEntries, 'boundary entries')

      // Load the tree back and check that every node reads back the same bytes.
      await store.commit({
        blocks: nodes.map((n) => ({ address: n.address, bytes: n.bytes })),
        root: root.address,
        expected: null
      })
      const { load } = require('../lib/tree')
      const loaded = await load({ address: root.address, storage: store, chunker, kind })
      t.is(hex(loaded.bytes), v.rootBytesHex)
      const levels = await collectNodes(loaded)
      let count = 0
      for (const level of levels.values()) count += level.length
      t.is(count, v.nodes, 'node count after load')
    })
  }
}
