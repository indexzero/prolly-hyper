// The hash of the Wire encoding section. Decision 2: the address is the
// BLAKE2b-256 of the encoded node bytes, from hypercore-crypto, with no prefix.
// Upstream takes a `hasher` option (src/base.js:5-9). The port fixes it.
const crypto = require('hypercore-crypto')

// address(node) = blake2b-256(encode(node)). 32 bytes.
function address(bytes) {
  return crypto.hash(bytes)
}

// identity(entry) = readUInt32LE(blake2b-256(encode(entry)), length - 4).
// The last four bytes, little-endian, as upstream `readUInt32LE` (src/utils.js:1-7).
function identity(bytes) {
  const hash = crypto.hash(bytes)
  const offset = hash.byteLength - 4
  return (
    (hash[offset] | (hash[offset + 1] << 8) | (hash[offset + 2] << 16)) +
    hash[offset + 3] * 0x1000000
  )
}

module.exports = { address, identity }
