// The cache of decision 10. A port of upstream src/cache.js. Upstream keys
// the `global` cache on `cid.toString()` (src/cache.js:7). The port keys on
// the hex of the 32-byte address and bounds the size, least recently used.
//
// An entry is a verified decoded block, `{ address, bytes, kind, closed,
// distance, entries }`, as `decodeBlock` in `lib/tree.js` returns it. It is
// never a node: a node is bound to a collection kind, a chunker and a
// storage, and one cache serves every loader (D-011 F-02).
const b4a = require('b4a')
const { createError, INVALID_CACHE_SIZE } = require('./errors')

const DEFAULT_MAX = 1024

const toKey = (address) => b4a.toString(address, 'hex')

class Cache {
  constructor(max = DEFAULT_MAX) {
    if (!Number.isSafeInteger(max) || max < 1) {
      throw createError(INVALID_CACHE_SIZE, `max must be a positive integer, got ${String(max)}`)
    }
    this.max = max
    this._nodes = new Map()
  }

  get size() {
    return this._nodes.size
  }

  has(address) {
    return this._nodes.has(toKey(address))
  }

  // A `get` moves the entry to the end.
  get(address) {
    const key = toKey(address)
    const node = this._nodes.get(key)
    if (node === undefined) throw new Error('Not found')
    this._nodes.delete(key)
    this._nodes.set(key, node)
    return node
  }

  // An insert past the bound evicts the first entry. `block` has an `address`.
  set(block) {
    const key = toKey(block.address)
    if (this._nodes.has(key)) this._nodes.delete(key)
    this._nodes.set(key, block)
    if (this._nodes.size > this.max) {
      const first = this._nodes.keys().next().value
      this._nodes.delete(first)
    }
  }

  clear() {
    this._nodes.clear()
  }
}

// As upstream src/cache.js:1-5.
const nocache = Object.freeze({
  has: () => false,
  get: () => {
    throw new Error('Cannot ask for entries from nocache')
  },
  set: () => {}
})

module.exports = { Cache, nocache, DEFAULT_MAX }
