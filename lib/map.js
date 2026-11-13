// A port of upstream src/map.js. The entry classes live in `lib/tree.js`,
// because `create` and `load` take the collection kind. `ProllyMap` is the
// High-level API of TECHNICAL.DESIGN.md, decision 8. It owns the root, runs
// every mutation through one promise chain and commits with `expected` set
// to the root it read.
const b4a = require('b4a')
const { MapLeafEntry, BranchEntry, create, load, normalizeOps, KINDS } = require('./tree')
const { copy, isBytes } = require('./encoding')
const { bf, DEFAULT_FACTOR } = require('./chunker')
const { Cache } = require('./cache')
const { createError, NOT_FOUND, INVALID_KEY } = require('./errors')

const KIND = 'map'
const MapBranchEntry = BranchEntry

function sameRoot(a, b) {
  if (a === null || b === null) return a === b
  return b4a.equals(a, b)
}

function checkKey(key) {
  if (!isBytes(key)) throw createError(INVALID_KEY, 'key must be a Buffer or Uint8Array')
}

class ProllyMap {
  constructor(storage, { chunker, cache, root }) {
    this.storage = storage
    this.chunker = chunker
    this.cache = cache
    this._root = root
    this._rootNode = null
    this._queue = Promise.resolve()
  }

  // Read the root from storage. A null root is an empty tree.
  static async open(storage, { chunker = bf(DEFAULT_FACTOR), cache = new Cache() } = {}) {
    if (!storage || typeof storage.root !== 'function') {
      throw new TypeError('storage must implement get, commit and root')
    }
    const root = await storage.root()
    return new ProllyMap(storage, { chunker, cache, root: root === null ? null : copy(root) })
  }

  // The committed root, a copy, or null.
  get root() {
    return this._root === null ? null : copy(this._root)
  }

  // Load the root node once and keep it. A load that started from an older
  // root must not replace the kept node: a mutation can commit while the load
  // is pending, and the next mutation would build on the stale node and lose
  // the committed write (D-011 F-01). The pending read returns its earlier
  // snapshot.
  async _node() {
    const address = this._root
    if (address === null) return null
    if (this._rootNode !== null) return this._rootNode
    const node = await load({
      address,
      storage: this.storage,
      chunker: this.chunker,
      kind: KIND,
      cache: this.cache
    })
    if (sameRoot(this._root, address)) this._rootNode = node
    return node
  }

  // The value for `key`, a copy, or null.
  async get(key) {
    checkKey(key)
    const node = await this._node()
    if (node === null) return null
    try {
      const { result } = await node.getEntry(key)
      return copy(result.value)
    } catch (err) {
      if (err.code === NOT_FOUND) return null
      throw err
    }
  }

  async has(key) {
    return (await this.get(key)) !== null
  }

  put(key, value) {
    return this.batch([{ key, value }])
  }

  delete(key) {
    return this.batch([{ key, del: true }])
  }

  // One commit per batch. Returns `{ root, previous }`. `previous` lists the
  // prior entries of the keys that existed, in key order, as copies.
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
      // An empty tree: the deletes are dropped and `create` runs over the puts.
      const puts = normalizeOps(ops, KINDS[KIND]).filter((op) => !op.del)
      result = { root: null, blocks: [], previous: [] }
      if (puts.length) {
        for await (const built of create({
          list: puts,
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
      previous: result.previous.map((entry) => ({ key: copy(entry.key), value: copy(entry.value) }))
    }
  }

  // Every entry inside the bounds, in key order. `gt`, `gte`, `lt` and `lte`
  // are all optional. No bounds yields everything.
  async *range(bounds = {}) {
    for (const name of ['gt', 'gte', 'lt', 'lte']) {
      if (bounds[name] !== undefined) checkKey(bounds[name])
    }
    const node = await this._node()
    if (node === null) return
    for await (const entry of node.iterate(bounds)) {
      yield { key: copy(entry.key), value: copy(entry.value) }
    }
  }
}

module.exports = { ProllyMap, MapLeafEntry, MapBranchEntry }
