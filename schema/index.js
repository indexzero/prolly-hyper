// The hyperschema structs of the Wire encoding section of TECHNICAL.DESIGN.md.
// `npm run build` writes `spec/hyperschema/`. `npm run check:spec` fails when
// this file and `spec/` disagree.
//
// Every field is `required`, so no struct writes a flags byte. Every struct is
// `compact`, so an entry inside an `entries` array is not length framed. The
// hand-derived vectors of the design pin both choices. The vectors win.
const Hyperschema = require('hyperschema')

const NAMESPACE = 'prolly-hyper'

function nodeStruct(name, entryType) {
  return {
    name,
    compact: true,
    fields: [
      { name: 'version', type: 'uint', required: true },
      { name: 'kind', type: 'uint', required: true },
      { name: 'flags', type: 'uint', required: true },
      { name: 'distance', type: 'uint', required: true },
      { name: 'entries', type: entryType, array: true, required: true }
    ]
  }
}

// Register the structs on `schema`, a `Hyperschema` instance.
function register(schema) {
  const ns = schema.namespace(NAMESPACE)

  // map-entry: key buffer, value buffer
  ns.register({
    name: 'map-entry',
    compact: true,
    fields: [
      { name: 'key', type: 'buffer', required: true },
      { name: 'value', type: 'buffer', required: true }
    ]
  })

  // set-entry: key buffer
  ns.register({
    name: 'set-entry',
    compact: true,
    fields: [{ name: 'key', type: 'buffer', required: true }]
  })

  // branch-entry: key buffer, address fixed32
  ns.register({
    name: 'branch-entry',
    compact: true,
    fields: [
      { name: 'key', type: 'buffer', required: true },
      { name: 'address', type: 'fixed32', required: true }
    ]
  })

  // map-leaf: version 1, kind 0, flags, distance 0, entries of map-entry
  ns.register(nodeStruct('map-leaf', `@${NAMESPACE}/map-entry`))
  // branch: version 1, kind 1, flags, distance >= 1, entries of branch-entry
  ns.register(nodeStruct('branch', `@${NAMESPACE}/branch-entry`))
  // set-leaf: version 1, kind 2, flags, distance 0, entries of set-entry
  ns.register(nodeStruct('set-leaf', `@${NAMESPACE}/set-entry`))

  return schema
}

// Build the schema from `dir` and write `schema.json` and `index.js` there.
function build(dir) {
  const schema = register(Hyperschema.from(dir))
  Hyperschema.toDisk(schema)
  return schema
}

module.exports = { NAMESPACE, register, build }
