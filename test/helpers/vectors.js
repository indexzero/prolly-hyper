// Print what the port computes for the inputs of `test/vectors.json`, in the
// shape of `spec-vector.json`, so that a human can compare the two by eye.
// No test reads this output as truth. Run: node test/helpers/vectors.js
const b4a = require('b4a')
const c = require('compact-encoding')
const { create, Entry } = require('../../lib/tree')
const { encodeEntry } = require('../../lib/encoding')
const { address, identity } = require('../../lib/hash')
const { bf } = require('../../lib/chunker')
const { MemoryStorage } = require('../../lib/storage/memory')

const hex = (buf) => b4a.toString(buf, 'hex')

async function main() {
  const list = []
  for (let i = 0; i < 16; i++) {
    const n = String(i).padStart(2, '0')
    list.push({ key: b4a.from(`key-${n}`), value: b4a.from(`val-${n}`) })
  }
  list.sort((a, b) => b4a.compare(a.key, b.key))
  const out = {}
  for (const factor of [2, 3, 32]) {
    for (const [name, kind, l] of [
      ['map', 'map', list],
      ['set', 'set', list.map(({ key }) => ({ key }))]
    ]) {
      const chunker = bf(factor)
      const all = []
      let root = null
      for await (const node of create({ list: l, storage: new MemoryStorage(), chunker, kind })) {
        all.push(node)
        root = node
      }
      const leafKind = kind === 'map' ? 0 : 2
      out[`${name}-factor${factor}`] = {
        root: hex(root.address),
        rootBytesHex: hex(root.bytes),
        nodes: all.length,
        leaves: all.filter((n) => n.distance === 0).length,
        rootDistance: root.distance,
        rootClosed: root.closed,
        boundaryEntries: l
          .filter((e) => chunker(new Entry(e, { kind: leafKind })))
          .map((e) => b4a.toString(e.key))
      }
    }
  }
  const e0 = list[0]
  const bytes = encodeEntry(0, e0)
  const h0 = address(bytes)
  out.identityExample = {
    entry: 'key-00/val-00',
    entryBytesHex: hex(bytes),
    blake2b256Hex: hex(h0),
    identityLE_last4: identity(bytes),
    identityBE_last4_wrong: h0.readUInt32BE(28),
    identityLE_first4_wrong: h0.readUInt32LE(0),
    threshold2: Math.floor(0xffffffff / 2),
    threshold32: Math.floor(0xffffffff / 32)
  }
  out.uintCheck = { 'c.uint 300': hex(c.encode(c.uint, 300)) }
  console.log(JSON.stringify(out, null, 2))
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
