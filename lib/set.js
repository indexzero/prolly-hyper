// A port of upstream src/cid-set.js. The set entry class lives in
// `lib/tree.js`, because `create` and `load` take the collection kind.
// `ProllySet` is the High-level API of TECHNICAL.DESIGN.md, decision 8. It
// owns the root, runs every mutation through one promise chain and commits
// with `expected` set to the root it read, as `ProllyMap` does.
//
// Identity, decision 7. Upstream `CIDEntry.identity()` (cid-set.js:16-19)
// reads `readUInt32LE` of the cid multihash bytes and hashes nothing. The port
// hashes the encoded entry, the length-prefixed key, and reads the last four
// bytes little-endian, the same rule as the map. So a set root differs from
// a map of empty values, and edited key bytes do not force a boundary.
//
// Keys, upstream cid-set.js:4. Upstream compares cid bytes with
// `binaryCompare`. The port's keys are bytes and the comparator is
// `b4a.compare`. A set entry encodes the key only, as wire kind 2.
const b4a = require('b4a')
const { SetLeafEntry, BranchEntry, create, load, normalizeOps, KINDS } = require('./tree')
const { copy, isBytes } = require('./encoding')
const { bf, DEFAULT_FACTOR } = require('./chunker')
const { Cache } = require('./cache')
const { createError, NOT_FOUND, INVALID_KEY } = require('./errors')

const KIND = 'set'
// Upstream `CIDNodeEntry` (cid-set.js:22). A branch entry is the same for
// both collection kinds.
const SetBranchEntry = BranchEntry

function sameRoot(a, b) {
  if (a === null || b === null) return a === b
  return b4a.equals(a, b)
}

function checkKey(key) {
  if (!isBytes(key)) throw createError(INVALID_KEY, 'key must be a Buffer or Uint8Array')
}

class ProllySet {
  constructor(storage, { chunker, cache, root }) {
    this.storage = storage
    this.chunker = chunker
    this.cache = cache
    this._root = root
    this._rootNode = null
    this._queue = Promise.resolve()
  }

  // Read the root from storage. A null root is an empty set.
  static async open(storage, { chunker = bf(DEFAULT_FACTOR), cache = new Cache() } = {}) {
    if (!storage || typeof storage.root !== 'function') {
      throw new TypeError('storage must implement get, commit and root')
    }
    const root = await storage.root()
    return new ProllySet(storage, { chunker, cache, root: root === null ? null : copy(root) })
  }

  // The committed root, a copy, or null.
  get root() {
    return this._root === null ? null : copy(this._root)
  }

  async _node() {
    if (this._root === null) return null
    if (this._rootNode === null) {
      this._rootNode = await load({
        address: this._root,
        storage: this.storage,
        chunker: this.chunker,
        kind: KIND,
        cache: this.cache
      })
    }
    return this._rootNode
  }

  async has(key) {
    checkKey(key)
    const node = await this._node()
    if (node === null) return false
    try {
      await node.getEntry(key)
      return true
    } catch (err) {
      if (err.code === NOT_FOUND) return false
      throw err
    }
  }

  add(key) {
    return this.batch([{ key }])
  }

  delete(key) {
    return this.batch([{ key, del: true }])
  }

  // One commit per batch. Returns `{ root, previous }`. `previous` lists the
  // keys that existed, in key order, as `{ key }` copies. A `value` on an op
  // is ignored. Duplicate keys in one batch collapse, decision 5.
  batch(ops) {
    const run = this._queue.then(() => this._batch(ops))
    this._queue = run.catch(() => {})
    return run
  }

  async _batch(ops) {
    const expected = this._root
    const node = await this._node()
    let result
    if (node === null) {
      // An empty set: the deletes are dropped and `create` runs over the adds.
      const adds = normalizeOps(ops, KINDS[KIND]).filter((op) => !op.del)
      result = { root: null, blocks: [], previous: [] }
      if (adds.length) {
        for await (const built of create({
          list: adds,
          storage: this.storage,
          chunker: this.chunker,
          kind: KIND,
          cache: this.cache
        })) {
          result.blocks.push({ address: built.address, bytes: built.bytes })
          result.root = built
        }
      }
    } else {
      result = await node.bulk(ops)
    }
    const root = result.root === null ? null : result.root.address
    // A batch that changes nothing commits nothing and returns the current root.
    if (!sameRoot(root, expected)) {
      await this.storage.commit({ blocks: result.blocks, root, expected })
      this._root = root === null ? null : copy(root)
      this._rootNode = result.root
    }
    return {
      root: this.root,
      previous: result.previous.map((entry) => ({ key: copy(entry.key) }))
    }
  }

  // Every key inside the bounds, in key order, as copies. `gt`, `gte`, `lt`
  // and `lte` are all optional. No bounds yields everything.
  async *keys(bounds = {}) {
    for (const name of ['gt', 'gte', 'lt', 'lte']) {
      if (bounds[name] !== undefined) checkKey(bounds[name])
    }
    const node = await this._node()
    if (node === null) return
    for await (const entry of node.iterate(bounds)) {
      yield copy(entry.key)
    }
  }
}

module.exports = { ProllySet, SetLeafEntry, SetBranchEntry }
