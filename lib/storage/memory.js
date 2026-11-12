// The in-memory storage of the Storage interface section of
// TECHNICAL.DESIGN.md. A port of the `storage()` helper of the upstream
// tests (test/test-map.js:13-24) with the compare-and-swap commit of
// decision 6. Every buffer is copied on the way in and on the way out.
const b4a = require('b4a')
const { isBytes, copy } = require('../encoding')
const { createError, CONFLICT } = require('../errors')

const hex = (bytes) => b4a.toString(bytes, 'hex')

function sameRoot(a, b) {
  if (a === null || b === null) return a === b
  return b4a.equals(a, b)
}

function checkRoot(root, name) {
  if (root === null) return
  if (!isBytes(root) || root.byteLength !== 32) {
    throw new TypeError(`${name} must be null or a 32-byte address`)
  }
}

class MemoryStorage {
  constructor() {
    this._blocks = new Map()
    this._root = null
  }

  get size() {
    return this._blocks.size
  }

  async get(address) {
    if (!isBytes(address)) throw new TypeError('address must be a Buffer or Uint8Array')
    const bytes = this._blocks.get(hex(address))
    return bytes === undefined ? null : copy(bytes)
  }

  // Writes every block and the root in one step, or throws and writes nothing.
  // Throws `CONFLICT` when the stored root is not `expected`.
  async commit({ blocks = [], root, expected }) {
    if (root === undefined) throw new TypeError('root is required, null for an empty tree')
    if (expected === undefined) throw new TypeError('expected is required, null for an empty tree')
    checkRoot(root, 'root')
    checkRoot(expected, 'expected')
    if (!Array.isArray(blocks)) throw new TypeError('blocks must be an array')
    for (const block of blocks) {
      if (
        !block ||
        !isBytes(block.address) ||
        block.address.byteLength !== 32 ||
        !isBytes(block.bytes)
      ) {
        throw new TypeError('a block is { address: 32 bytes, bytes }')
      }
    }
    if (!sameRoot(this._root, expected)) {
      throw createError(CONFLICT, 'the stored root is not the expected root')
    }
    for (const { address, bytes } of blocks) {
      const key = hex(address)
      if (!this._blocks.has(key)) this._blocks.set(key, copy(bytes))
    }
    this._root = root === null ? null : copy(root)
  }

  async root() {
    return this._root === null ? null : copy(this._root)
  }
}

module.exports = { MemoryStorage }
