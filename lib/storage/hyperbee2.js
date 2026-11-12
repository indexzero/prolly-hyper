// The hyperbee2 storage of the Storage interface section of
// TECHNICAL.DESIGN.md. Tree nodes live in a hyperbee2 under their address.
// One `write()` batch carries every block and the root pointer of a commit,
// and one `flush()` appends them as one checkpoint. The compare-and-swap of
// decision 6 runs inside the batch lock. The hyperbee2 is the unit of
// replication: a replica opened with `{ key, writable: false }` reads the
// same keys after `core.update({ wait: true })`.
//
// Key layout, from the design:
//   block key: 0x01 || address    value: the node bytes
//   root key:  0x00               value: the 32-byte root address, deleted
//                                        when the root is null
//
// Every hyperbee2 citation is `node_modules/hyperbee2/<path>:<line>` at 2.22.0.
const b4a = require('b4a')
const { isBytes, copy } = require('../encoding')
const { createError, CONFLICT } = require('../errors')

const ROOT_KEY = b4a.from([0x00])
const BLOCK_PREFIX = b4a.from([0x01])

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

function blockKey(address) {
  return b4a.concat([BLOCK_PREFIX, address])
}

class Hyperbee2Storage {
  // `bee` is a hyperbee2, or a checkout or snapshot of one. The caller owns
  // the bee, its corestore and its lifetime. The storage never closes it.
  constructor(bee) {
    if (!bee || typeof bee.get !== 'function' || typeof bee.write !== 'function') {
      throw new TypeError('bee must be a hyperbee2')
    }
    this.bee = bee
  }

  // `bee.get` returns `{ key, value, seq, core, offset }` or null (index.js:365).
  // On a replica it downloads only the core blocks the lookup touches.
  async _value(key) {
    const entry = await this.bee.get(key)
    return entry === null ? null : copy(entry.value)
  }

  async get(address) {
    if (!isBytes(address)) throw new TypeError('address must be a Buffer or Uint8Array')
    return this._value(blockKey(address))
  }

  async root() {
    return this._value(ROOT_KEY)
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

    // `write()` throws `Not writable` on a replica (index.js:155-156).
    const batch = this.bee.write()
    // Take the context lock before the read of the root, so that no other
    // flush lands between the compare and the swap (lib/write.js:72-76).
    // `flush()` takes the same lock, and `lock()` returns at once when the
    // batch holds it (lib/write.js:73, :86).
    await batch.lock()
    let flushed = false
    try {
      // The lock belongs to this `Hyperbee2` object (lib/context.js:19), and
      // a writable bee never follows the appends of its core (index.js:46,
      // :187-189). Another `Hyperbee2` on the same hypercore can append under
      // this one. Refuse to build on a head this bee has not seen (D-010 F-01).
      const head = this.bee.head()
      if (head === null || head.length !== this.bee.core.length) {
        throw createError(CONFLICT, 'the bee is behind its core: another Hyperbee2 wrote to it')
      }
      // The bee root is the last flushed one. `flush()` sets it before it
      // releases the lock (lib/write.js:118-120).
      const current = await this.root()
      if (!sameRoot(current, expected)) {
        throw createError(CONFLICT, 'the stored root is not the expected root')
      }
      // A put of the value already stored under a key applies nothing
      // (lib/write.js:156-158, :175-180), so a block already present is not
      // rewritten. A batch that applies nothing appends nothing
      // (lib/write.js:435).
      for (const { address, bytes } of blocks) {
        batch.tryPut(blockKey(address), copy(bytes))
      }
      if (root === null) batch.tryDelete(ROOT_KEY)
      else batch.tryPut(ROOT_KEY, copy(root))
      // One `core.append` of every encoded block (lib/write.js:541-549).
      // `flush()` closes the batch and releases the lock in its `finally`
      // (lib/write.js:121-124), on success and on failure.
      flushed = true
      await batch.flush()
    } finally {
      if (!flushed) {
        // `close()` marks the batch closed and closes its snapshot. It does
        // not release the lock (lib/write.js:127-130). Release it here, or
        // the next commit waits forever (lib/write.js:78-82).
        await batch.close()
        batch._unlock()
      }
    }
  }
}

module.exports = { Hyperbee2Storage, ROOT_KEY, BLOCK_PREFIX }
