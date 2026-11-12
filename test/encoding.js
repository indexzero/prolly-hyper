// Acceptance test 5: round trip of every kind and refusal of each malformed input.
const test = require('brittle')
const b4a = require('b4a')
const {
  VERSION,
  KIND_MAP_LEAF,
  KIND_BRANCH,
  KIND_SET_LEAF,
  encodeNode,
  decodeNode,
  encodeEntry
} = require('../lib/encoding')

const a = b4a.from('a')
const b = b4a.from('b')
const addr = b4a.alloc(32, 7)
const hex = (buf) => b4a.toString(buf, 'hex')

test('constants', (t) => {
  t.is(VERSION, 1)
  t.is(KIND_MAP_LEAF, 0)
  t.is(KIND_BRANCH, 1)
  t.is(KIND_SET_LEAF, 2)
})

test('round trip of every kind', (t) => {
  const nodes = [
    { kind: KIND_MAP_LEAF, closed: true, distance: 0, entries: [{ key: a, value: b }] },
    { kind: KIND_MAP_LEAF, closed: false, distance: 0, entries: [{ key: a, value: b }] },
    { kind: KIND_SET_LEAF, closed: true, distance: 0, entries: [{ key: a }, { key: b }] },
    { kind: KIND_BRANCH, closed: false, distance: 3, entries: [{ key: a, address: addr }] }
  ]
  for (const node of nodes) {
    const bytes = encodeNode(node)
    const decoded = decodeNode(bytes)
    t.is(decoded.version, 1)
    t.is(decoded.kind, node.kind)
    t.is(decoded.closed, node.closed)
    t.is(decoded.distance, node.distance)
    t.is(decoded.entries.length, node.entries.length)
    for (let i = 0; i < node.entries.length; i++) {
      const want = node.entries[i]
      const got = decoded.entries[i]
      t.alike(got.key, want.key)
      if (want.value) t.alike(got.value, want.value)
      if (want.address) t.alike(got.address, want.address)
    }
  }
})

test('decoded buffers are copies, not slices of the node bytes', (t) => {
  const bytes = encodeNode({
    kind: KIND_BRANCH,
    closed: true,
    distance: 1,
    entries: [{ key: a, address: addr }]
  })
  const decoded = decodeNode(bytes)
  bytes.fill(0)
  t.alike(decoded.entries[0].key, a)
  t.alike(decoded.entries[0].address, addr)
})

test('zero-length key and value encode and decode', (t) => {
  const empty = b4a.alloc(0)
  const bytes = encodeNode({
    kind: KIND_MAP_LEAF,
    closed: false,
    distance: 0,
    entries: [{ key: empty, value: empty }]
  })
  t.is(hex(bytes), '010000000100' + '00')
  const decoded = decodeNode(bytes)
  t.is(decoded.entries[0].key.byteLength, 0)
  t.is(decoded.entries[0].value.byteLength, 0)
})

test('encodeEntry gives the entry codec output alone', (t) => {
  t.is(hex(encodeEntry(KIND_MAP_LEAF, { key: a, value: b })), '01610162')
  t.is(hex(encodeEntry(KIND_SET_LEAF, { key: a })), '0161')
  t.is(hex(encodeEntry(KIND_BRANCH, { key: a, address: addr })), '0161' + hex(addr))
})

test('encodeEntry and encodeNode reject keys and values that are not bytes', (t) => {
  t.exception.all(() => encodeEntry(KIND_MAP_LEAF, { key: 'a', value: b }), { code: 'INVALID_KEY' })
  t.exception.all(() => encodeEntry(KIND_MAP_LEAF, { key: a, value: 'b' }), {
    code: 'INVALID_VALUE'
  })
  t.exception.all(() => encodeEntry(KIND_SET_LEAF, { key: 1 }), { code: 'INVALID_KEY' })
  t.exception.all(
    () =>
      encodeNode({
        kind: KIND_MAP_LEAF,
        closed: true,
        distance: 0,
        entries: [{ key: 'a', value: b }]
      }),
    { code: 'INVALID_KEY' }
  )
})

test('encodeNode rejects an unknown kind', (t) => {
  t.exception(
    () => encodeNode({ kind: 3, closed: true, distance: 0, entries: [{ key: a, value: b }] }),
    { code: 'DECODE_ERROR' }
  )
})

// The hand-derived closed map leaf `[a = b]`: 01 00 01 00 01 01 61 01 62
const LEAF = '010001000101610162'

const refusals = [
  ['version 2', '02' + LEAF.slice(2), 'UNSUPPORTED_VERSION'],
  ['version 0', '00' + LEAF.slice(2), 'UNSUPPORTED_VERSION'],
  ['kind 3', '0103' + LEAF.slice(4), 'DECODE_ERROR'],
  ['flags 2', '010002' + LEAF.slice(6), 'DECODE_ERROR'],
  ['flags 3, bit 1 set with bit 0', '010003' + LEAF.slice(6), 'DECODE_ERROR'],
  ['a trailing byte', LEAF + '00', 'DECODE_ERROR'],
  ['a truncated buffer', LEAF.slice(0, -2), 'DECODE_ERROR'],
  ['a truncated buffer, inside the count', LEAF.slice(0, 8), 'DECODE_ERROR'],
  ['an empty buffer', '', 'DECODE_ERROR'],
  ['an empty entries array', '0100010000', 'DECODE_ERROR'],
  ['a leaf with distance 1', '01000101' + LEAF.slice(8), 'DECODE_ERROR'],
  ['a set leaf with distance 1', '01020101010161', 'DECODE_ERROR'],
  [
    'a branch with distance 0',
    '01010000010161' + '177caacf4842030c869daea02854cec4b3273e57af99a3e8d99f4e059b83dc5a',
    'DECODE_ERROR'
  ],
  ['the overlong uint fd0100 for version 1', 'fd0100' + LEAF.slice(2), 'DECODE_ERROR'],
  [
    'the overlong uint fd0100 for the entry count',
    LEAF.slice(0, 8) + 'fd0100' + LEAF.slice(10),
    'DECODE_ERROR'
  ],
  [
    'the overlong uint fd0100 for a key length',
    LEAF.slice(0, 10) + 'fd010061' + LEAF.slice(14),
    'DECODE_ERROR'
  ]
]

for (const [name, input, code] of refusals) {
  test(`decodeNode refuses ${name}`, (t) => {
    t.exception(() => decodeNode(b4a.from(input, 'hex')), { code })
  })
}

test('decodeNode accepts the hand-derived leaf', (t) => {
  const decoded = decodeNode(b4a.from(LEAF, 'hex'))
  t.is(decoded.kind, KIND_MAP_LEAF)
  t.is(decoded.closed, true)
  t.is(decoded.distance, 0)
  t.alike(decoded.entries, [{ key: a, value: b }])
})
