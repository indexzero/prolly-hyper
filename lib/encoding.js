// The wrapper over the generated hyperschema codecs. Decision 3. It replaces
// the `multiformats/block` use of upstream src/base.js:1 and :763-769.
//
// `decodeNode` reads `version` and `kind` first, selects the struct, decodes,
// asserts that every byte was consumed, applies the Decode rules of the
// design and re-encodes to reject every non-canonical form.
const c = require('compact-encoding')
const b4a = require('b4a')
const { getStruct } = require('../spec/hyperschema')
const {
  createError,
  DECODE_ERROR,
  UNSUPPORTED_VERSION,
  INVALID_KEY,
  INVALID_VALUE
} = require('./errors')

const VERSION = 1

const KIND_MAP_LEAF = 0
const KIND_BRANCH = 1
const KIND_SET_LEAF = 2

const FLAG_CLOSED = 1
const FLAGS_KNOWN = FLAG_CLOSED

const NODE_STRUCT = {
  [KIND_MAP_LEAF]: getStruct('@prolly-hyper/map-leaf'),
  [KIND_BRANCH]: getStruct('@prolly-hyper/branch'),
  [KIND_SET_LEAF]: getStruct('@prolly-hyper/set-leaf')
}

const ENTRY_STRUCT = {
  [KIND_MAP_LEAF]: getStruct('@prolly-hyper/map-entry'),
  [KIND_BRANCH]: getStruct('@prolly-hyper/branch-entry'),
  [KIND_SET_LEAF]: getStruct('@prolly-hyper/set-entry')
}

function isBytes(value) {
  return b4a.isBuffer(value) || value instanceof Uint8Array
}

function isKind(kind) {
  return kind === KIND_MAP_LEAF || kind === KIND_BRANCH || kind === KIND_SET_LEAF
}

// A copy, never a slice of the input. Decision 12.
function copy(bytes) {
  const out = b4a.allocUnsafeSlow(bytes.byteLength)
  out.set(bytes)
  return out
}

function assertKind(kind) {
  if (!isKind(kind)) throw createError(DECODE_ERROR, `Unknown node kind ${String(kind)}`)
}

// Check the fields of one entry of `kind` before encoding. Decision 5.
function checkEntry(kind, entry) {
  if (!isBytes(entry.key)) {
    throw createError(INVALID_KEY, 'key must be a Buffer or Uint8Array')
  }
  if (kind === KIND_MAP_LEAF && !isBytes(entry.value)) {
    throw createError(INVALID_VALUE, 'value must be a Buffer or Uint8Array')
  }
  if (kind === KIND_BRANCH && (!isBytes(entry.address) || entry.address.byteLength !== 32)) {
    throw createError(DECODE_ERROR, 'address must be 32 bytes')
  }
}

// The entry codec output alone: the length-prefixed fields, no count, no
// kind and no version. This is what `identity` hashes.
function encodeEntry(kind, entry) {
  assertKind(kind)
  checkEntry(kind, entry)
  return c.encode(ENTRY_STRUCT[kind], entry)
}

// `node` is `{ kind, closed, distance, entries }`.
function encodeNode(node) {
  assertKind(node.kind)
  if (!Array.isArray(node.entries) || node.entries.length === 0) {
    throw createError(DECODE_ERROR, 'a node has one or more entries')
  }
  for (const entry of node.entries) checkEntry(node.kind, entry)
  return c.encode(NODE_STRUCT[node.kind], {
    version: VERSION,
    kind: node.kind,
    flags: node.closed ? FLAG_CLOSED : 0,
    distance: node.distance,
    entries: node.entries
  })
}

// Decode `bytes` into `{ version, kind, closed, distance, entries }`. Every
// key, value and address is a copy. Every refusal of the Decode rules throws.
function decodeNode(bytes) {
  if (!isBytes(bytes)) throw createError(DECODE_ERROR, 'node bytes must be a Buffer or Uint8Array')
  const state = c.state(0, bytes.byteLength, bytes)

  let version
  let kind
  try {
    version = c.uint.decode(state)
    kind = c.uint.decode(state)
  } catch (err) {
    throw decodeError(err)
  }
  if (version !== VERSION) {
    throw createError(UNSUPPORTED_VERSION, `Unsupported node version ${version}`)
  }
  if (!isKind(kind)) throw createError(DECODE_ERROR, `Unknown node kind ${kind}`)

  state.start = 0
  let raw
  try {
    raw = NODE_STRUCT[kind].decode(state)
  } catch (err) {
    throw decodeError(err)
  }
  if (state.start !== state.end) {
    throw createError(DECODE_ERROR, `${state.end - state.start} trailing bytes`)
  }
  if ((raw.flags & ~FLAGS_KNOWN) !== 0) {
    throw createError(DECODE_ERROR, `Unknown flags ${raw.flags}`)
  }
  if (kind === KIND_BRANCH && raw.distance < 1) {
    throw createError(DECODE_ERROR, 'a branch has distance 1 or more')
  }
  if (kind !== KIND_BRANCH && raw.distance !== 0) {
    throw createError(DECODE_ERROR, 'a leaf has distance 0')
  }
  if (raw.entries.length === 0) throw createError(DECODE_ERROR, 'a node has one or more entries')

  // A non-canonical form, for example an overlong uint, decodes to a value
  // that re-encodes differently.
  const again = c.encode(NODE_STRUCT[kind], raw)
  if (!b4a.equals(again, bytes)) throw createError(DECODE_ERROR, 'non-canonical node bytes')

  const entries = raw.entries.map((entry) => {
    const out = { key: copy(entry.key) }
    if (kind === KIND_MAP_LEAF) out.value = copy(entry.value)
    if (kind === KIND_BRANCH) out.address = copy(entry.address)
    return out
  })

  return {
    version,
    kind,
    closed: (raw.flags & FLAG_CLOSED) !== 0,
    distance: raw.distance,
    entries
  }
}

function decodeError(err) {
  if (err && err.code) return err
  const out = createError(DECODE_ERROR, err && err.message ? err.message : 'decode failed')
  out.cause = err
  return out
}

module.exports = {
  VERSION,
  KIND_MAP_LEAF,
  KIND_BRANCH,
  KIND_SET_LEAF,
  FLAG_CLOSED,
  isBytes,
  isKind,
  copy,
  encodeNode,
  decodeNode,
  encodeEntry
}
