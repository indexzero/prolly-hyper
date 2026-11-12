// A port of the read paths and `create` of mikeal/prolly-trees src/base.js
// (4c7c81a), plus the canonical `bulk` of TECHNICAL.DESIGN.md decision 11.
//
// Upstream names that change. `cids` in a read result is `visited`, a Set of
// hex addresses. `entry.constructor.name` checks are a `kind` field.
// `block.cid` is `node.address`. The `codec`, `hasher` and `compare` options
// vanish. The comparator is `b4a.compare`. Keys and values are bytes.
//
// Upstream `bulk` (src/base.js:665-721), `processRoot` (:152), `transactionBranch`
// (:436), `handlePrepend` (:484) and `mergeFirstLeftEntries` (:535) are not
// ported. They are not canonical. See the section Canonical bulk of the design.
const b4a = require('b4a')
const {
  KIND_MAP_LEAF,
  KIND_BRANCH,
  KIND_SET_LEAF,
  encodeNode,
  decodeNode,
  encodeEntry,
  isBytes,
  copy
} = require('./encoding')
const { address: hashAddress, identity: hashIdentity } = require('./hash')
const { NO_PROGRESS_LEVELS } = require('./chunker')
const { nocache } = require('./cache')
const {
  createError,
  NOT_FOUND,
  BLOCK_MISSING,
  ADDRESS_MISMATCH,
  DUPLICATE_KEY,
  KIND_MISMATCH,
  CHUNKER_NO_PROGRESS,
  INVALID_KEY,
  INVALID_VALUE,
  INVALID_OPS
} = require('./errors')

const compare = b4a.compare
const hex = (bytes) => b4a.toString(bytes, 'hex')

// Decision 5. A key that is not bytes throws `INVALID_KEY` before any
// traversal, so that `b4a.compare` never sees it (D-011 F-05).
function checkKey(key) {
  if (!isBytes(key)) throw createError(INVALID_KEY, 'key must be a Buffer or Uint8Array')
}

// Upstream src/base.js:4-15. The port adds `kind`, the wire kind of the entry,
// and the identity of src/map.js:5-9: the last four bytes of the hash of the
// encoded entry, little-endian.
class Entry {
  constructor({ key, value, address }, { kind }) {
    if (!isBytes(key)) throw createError(INVALID_KEY, 'key must be a Buffer or Uint8Array')
    this.key = key
    this.kind = kind
    if (kind === KIND_MAP_LEAF) {
      if (!isBytes(value)) throw createError(INVALID_VALUE, 'value must be a Buffer or Uint8Array')
      this.value = value
    } else if (kind === KIND_BRANCH) {
      this.address = address
    }
    this._identity = -1
  }

  get isEntry() {
    return true
  }

  // Upstream src/map.js:18-20 and :30-32 return `[key, value]` and
  // `[key, address]`. The port returns the entry codec bytes.
  encodeNode() {
    return encodeEntry(this.kind, this)
  }

  identity() {
    if (this._identity === -1) this._identity = hashIdentity(this.encodeNode())
    return this._identity
  }
}

class MapLeafEntry extends Entry {
  constructor(entry) {
    super(entry, { kind: KIND_MAP_LEAF })
  }
}

class SetLeafEntry extends Entry {
  constructor(entry) {
    super(entry, { kind: KIND_SET_LEAF })
  }
}

class BranchEntry extends Entry {
  constructor(entry) {
    if (!isBytes(entry.address) || entry.address.byteLength !== 32) {
      throw new Error('Cannot create a branch entry without a 32-byte address')
    }
    super(entry, { kind: KIND_BRANCH })
  }
}

// The collection kinds. A branch node has the same wire kind for both.
const KINDS = {
  map: { leafKind: KIND_MAP_LEAF, LeafEntryClass: MapLeafEntry },
  set: { leafKind: KIND_SET_LEAF, LeafEntryClass: SetLeafEntry }
}

// The entry class of a wire kind. A branch entry is the same for both
// collection kinds.
const ENTRY_CLASS = {
  [KIND_MAP_LEAF]: MapLeafEntry,
  [KIND_BRANCH]: BranchEntry,
  [KIND_SET_LEAF]: SetLeafEntry
}

// Decision 12: a returned entry is a copy. The key, value and address are
// new buffers, so a change by the caller never reaches the shared node data
// (D-011 F-03). The identity is a function of the bytes, so it is kept.
function cloneEntry(entry) {
  const fields = { key: copy(entry.key) }
  if (entry.kind === KIND_MAP_LEAF) fields.value = copy(entry.value)
  if (entry.kind === KIND_BRANCH) fields.address = copy(entry.address)
  const clone = new ENTRY_CLASS[entry.kind](fields)
  clone._identity = entry._identity
  return clone
}

function kindInfo(kind) {
  const info = KINDS[kind]
  if (!info) throw createError(KIND_MISMATCH, `kind must be 'map' or 'set', got ${String(kind)}`)
  return info
}

// Upstream src/base.js:17-102, with byte keys.
class EntryList {
  constructor({ entries, closed }) {
    if (typeof closed !== 'boolean') throw new Error('Missing required argument "closed"')
    this.entries = entries
    this.closed = closed
    this.startKey = entries[0].key
  }

  find(key, compare) {
    const { entries } = this
    for (let i = entries.length - 1; i > -1; i--) {
      const entry = entries[i]
      const comp = compare(key, entry.key)
      if (comp > -1) {
        return [i, entry]
      }
    }
    return null
  }

  findMany(keys, compare, sorted = false, strict = false) {
    const { entries } = this
    const results = new Map()
    // Note: object based entries must be sorted
    if (!sorted) {
      keys = [...keys].sort(compare)
    } else {
      keys = [...keys]
    }
    for (let i = entries.length - 1; i > -1; i--) {
      if (!keys.length) break
      const entry = entries[i]
      const found = []
      while (keys.length) {
        let key = keys[keys.length - 1]
        key = key.key ? key.key : key
        const comp = compare(key, entry.key)
        if (!strict) {
          if (comp > -1) {
            found.push(keys.pop())
          } else {
            break
          }
        } else {
          if (comp === 0) {
            found.push(keys.pop())
          } else if (comp > 0) {
            keys.pop()
          } else {
            break
          }
        }
      }
      if (found.length) {
        results.set(i, [entry, found])
      }
    }
    return results
  }

  // `end` is exclusive, as upstream src/base.js:83.
  findRange(start, end, compare) {
    const { entries } = this
    let last
    let first = 0
    for (let i = entries.length - 1; i > -1; i--) {
      const entry = entries[i]
      const comp = compare(end, entry.key)
      if (comp > 0) {
        last = i
        break
      }
    }
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i]
      const comp = compare(start, entry.key)
      if (comp === 0) {
        first = i
        break
      } else if (comp < 0) {
        break
      }
      first = i
    }
    return { first, last, entries: entries.slice(first, last + 1) }
  }
}

// Upstream src/base.js:199-207 and :744-756. The encoding is synchronous, so
// `bytes` and `address` are plain values, not promises.
class Node {
  constructor({ entryList, chunker, distance, getNode, cache, kind, bytes, address }) {
    this.entryList = entryList
    this.chunker = chunker
    this.distance = distance
    this.getNode = getNode
    this.compare = compare
    this.cache = cache
    this.kind = kind
    this.bytes = bytes || this.encode()
    this.address = address || hashAddress(this.bytes)
  }

  get closed() {
    return this.entryList.closed
  }

  // A branch entry's key is the first key of its child. Upstream :213-215.
  get key() {
    return this.entryList.startKey
  }

  get isLeaf() {
    return false
  }

  get isBranch() {
    return false
  }

  encode() {
    return encodeNode({
      kind: this.wireKind,
      closed: this.closed,
      distance: this.distance,
      entries: this.entryList.entries
    })
  }

  // Upstream :217-237. The leaf equality uses the comparator, never
  // `toString()` (upstream :233-234), decision 12. The result is a copy. The
  // `_` methods below traverse the shared node data and copy nothing.
  async getEntry(key, visited = new Set()) {
    checkKey(key)
    const result = await this._getEntry(key, visited)
    return { result: cloneEntry(result), visited }
  }

  async _getEntry(key, visited) {
    visited.add(hex(this.address))
    let node = this
    while (!node.isLeaf) {
      const result = node.entryList.find(key, this.compare)
      if (result === null) throw createError(NOT_FOUND, 'Not found')
      const [, entry] = result
      node = await this.getNode(entry.address)
      visited.add(hex(node.address))
    }
    const result = node.entryList.find(key, this.compare)
    if (result === null || this.compare(result[1].key, key) !== 0) {
      throw createError(NOT_FOUND, 'Not found')
    }
    const [, entry] = result
    return entry
  }

  // Upstream :239-256. The result is a new array of copies.
  async getAllEntries(visited = new Set()) {
    const result = await this._getAllEntries(visited)
    return { result: result.map(cloneEntry), visited }
  }

  _getAllEntries(visited) {
    visited.add(hex(this.address))
    if (this.isLeaf) {
      return this.entryList.entries
    } else {
      const { entries } = this.entryList
      const mapper = async (entry) =>
        this.getNode(entry.address).then((node) => node._getAllEntries(visited))
      return Promise.all(entries.map(mapper)).then((results) => results.flat())
    }
  }

  // Upstream :303-322. The result is a new array of copies.
  async getEntries(keys, sorted = false, visited = new Set()) {
    if (!Array.isArray(keys)) throw createError(INVALID_KEY, 'keys must be an array of bytes')
    for (const key of keys) checkKey(key)
    const result = await this._getEntries(keys, sorted, visited)
    return { result: result.map(cloneEntry), visited }
  }

  async _getEntries(keys, sorted, visited) {
    visited.add(hex(this.address))
    if (!sorted) keys = [...keys].sort(this.compare)
    const results = this.entryList.findMany(keys, this.compare, true, this.isLeaf)
    if (this.isLeaf) {
      return [...results.values()].map(([entry]) => entry)
    }
    let entries = []
    for (const [entry, keys] of [...results.values()].reverse()) {
      const p = this.getNode(entry.address)
      entries.push(p.then((node) => node._getEntries(keys.reverse(), true, visited)))
    }
    entries = await Promise.all(entries)
    return entries.flat()
  }

  // Upstream :324-359. `start` inclusive, `end` exclusive. The result is a
  // new array of copies.
  async getRangeEntries(start, end, visited = new Set()) {
    checkKey(start)
    checkKey(end)
    const result = await this._getRangeEntries(start, end, visited)
    return { result: result.map(cloneEntry), visited }
  }

  _getRangeEntries(start, end, visited) {
    visited.add(hex(this.address))
    const { entries } = this.entryList.findRange(start, end, this.compare)
    if (this.isLeaf) {
      return entries.filter((entry) => {
        const s = this.compare(start, entry.key)
        const e = this.compare(end, entry.key)
        if (s <= 0 && e > 0) return true
        return false
      })
    }

    if (!entries.length) return []
    const thenRange = async (entry) =>
      this.getNode(entry.address).then((node) => node._getRangeEntries(start, end, visited))

    const results = [thenRange(entries.shift())]

    if (!entries.length) return results[0]
    const last = thenRange(entries.pop())

    while (entries.length) {
      const thenAll = async (entry) =>
        this.getNode(entry.address).then(async (node) => node._getAllEntries(visited))
      results.push(thenAll(entries.shift()))
    }
    results.push(last)
    return Promise.all(results).then((results) => results.flat())
  }

  // Not in upstream. A lazy walk in key order over the entries inside the
  // bounds `gt`, `gte`, `lt` and `lte`. The public `range` of the design
  // uses it. The low-level `getRangeEntries` keeps upstream's exclusive end.
  // Every yielded entry is a copy.
  async *iterate(bounds = {}) {
    const { lower, upper } = resolveBounds(bounds)
    for await (const entry of this._iterate(lower, upper)) yield cloneEntry(entry)
  }

  async *_iterate(lower, upper) {
    const { entries } = this.entryList
    if (this.isLeaf) {
      for (const entry of entries) {
        if (lower !== null) {
          const c = this.compare(entry.key, lower.key)
          if (c < 0 || (c === 0 && !lower.inclusive)) continue
        }
        if (upper !== null) {
          const c = this.compare(entry.key, upper.key)
          if (c > 0 || (c === 0 && !upper.inclusive)) return
        }
        yield entry
      }
      return
    }
    for (let i = 0; i < entries.length; i++) {
      // Every key of child i is at or above its own key and below the next key.
      if (upper !== null && this.compare(entries[i].key, upper.key) > 0) return
      if (
        lower !== null &&
        i + 1 < entries.length &&
        this.compare(entries[i + 1].key, lower.key) <= 0
      ) {
        continue
      }
      const child = await this.getNode(entries[i].address)
      yield* child._iterate(lower, upper)
    }
  }

  // The canonical bulk of decision 11. It writes nothing. The caller commits
  // `blocks`. `root` is the new root node, or null when every entry is gone.
  // `previous` holds copies of the prior entries of the keys that existed.
  async bulk(ops) {
    const info = kindInfo(this.kind)
    const { chunker } = this
    const opts = { getNode: this.getNode, cache: this.cache, kind: this.kind }

    // 1. Normalize the ops by decision 5.
    ops = normalizeOps(ops, info)
    if (!ops.length) return { root: this, blocks: [], previous: [], nodes: [] }

    // 2. The leaf list in key order, and every address of the old tree.
    const { leaves, oldAddresses } = await this._leafList()

    // Map every op to the leaf that holds its key. A key below the first key
    // maps to the first leaf. A key above every key maps to the last leaf.
    const opsByLeaf = new Map()
    let index = 0
    for (const op of ops) {
      while (index + 1 < leaves.length && compare(leaves[index + 1].key, op.key) <= 0) index++
      if (!opsByLeaf.has(index)) opsByLeaf.set(index, [])
      opsByLeaf.get(index).push(op)
    }

    // 3. Process the affected leaves left to right in runs.
    const previous = []
    const nodes = []
    const newLeaves = []
    let cursor = 0
    for (const start of [...opsByLeaf.keys()].sort((a, b) => a - b)) {
      if (start < cursor) continue // absorbed by the run before it
      for (; cursor < start; cursor++) newLeaves.push(leaves[cursor])

      let end = start
      let entries = await this._applyOps(leaves[start], opsByLeaf.get(start), previous, info)
      let run = await Node.from({ entries, chunker, NodeClass: Leaf, distance: 0, opts })
      // The last chunk is open and a leaf follows: absorb it and chunk again.
      while (run.length && !run[run.length - 1].closed && end + 1 < leaves.length) {
        end++
        const more = await this._applyOps(leaves[end], opsByLeaf.get(end) || [], previous, info)
        entries = entries.concat(more)
        run = await Node.from({ entries, chunker, NodeClass: Leaf, distance: 0, opts })
      }
      cursor = end + 1
      for (const node of run) {
        nodes.push(node)
        newLeaves.push({ key: node.key, address: node.address, node })
      }
    }
    for (; cursor < leaves.length; cursor++) newLeaves.push(leaves[cursor])

    // 4. Rebuild every branch level from the leaf list, as `create` does.
    let root = null
    if (newLeaves.length === 1) {
      root = newLeaves[0].node || (await this.getNode(newLeaves[0].address))
    } else if (newLeaves.length > 1) {
      const entries = newLeaves.map(({ key, address }) => new BranchEntry({ key, address }))
      for await (const node of branchLevels(entries, chunker, opts, 0)) {
        nodes.push(node)
        root = node
      }
    }

    // 5. `blocks` holds every node that did not exist before.
    const blocks = nodes
      .filter((node) => !oldAddresses.has(hex(node.address)))
      .map((node) => ({ address: node.address, bytes: node.bytes }))
    return { root, blocks, previous: previous.map(cloneEntry), nodes }
  }

  // The `[key, address]` of every leaf in key order, read from the branches
  // at distance 1, and the set of every address in the tree.
  async _leafList() {
    const oldAddresses = new Set([hex(this.address)])
    const leaves = []
    const walk = async (node) => {
      oldAddresses.add(hex(node.address))
      const { entries } = node.entryList
      if (node.distance === 1) {
        for (const entry of entries) {
          leaves.push({ key: entry.key, address: entry.address })
          oldAddresses.add(hex(entry.address))
        }
        return
      }
      const children = await Promise.all(entries.map((entry) => this.getNode(entry.address)))
      for (const child of children) await walk(child)
    }
    if (this.isLeaf) {
      leaves.push({ key: this.key, address: this.address })
    } else {
      await walk(this)
    }
    return { leaves, oldAddresses }
  }

  // Load one leaf and apply its sorted ops. A port of `processLeafEntries`
  // (upstream :400-433) as a merge of two sorted lists. Prior entries of the
  // keys that existed go to `previous`, in key order.
  async _applyOps(leaf, ops, previous, info) {
    const node = leaf.node || (await this.getNode(leaf.address))
    const entries = node.entryList.entries
    const out = []
    let i = 0
    let j = 0
    while (i < entries.length || j < ops.length) {
      if (j >= ops.length) {
        out.push(entries[i++])
        continue
      }
      if (i >= entries.length) {
        const op = ops[j++]
        if (!op.del) out.push(new info.LeafEntryClass(op))
        continue
      }
      const c = compare(entries[i].key, ops[j].key)
      if (c < 0) {
        out.push(entries[i++])
      } else if (c > 0) {
        const op = ops[j++]
        if (!op.del) out.push(new info.LeafEntryClass(op))
      } else {
        previous.push(entries[i++])
        const op = ops[j++]
        if (!op.del) out.push(new info.LeafEntryClass(op))
      }
    }
    return out
  }

  // Upstream :723-741. The chunker decides every boundary from the entry alone.
  static async from({ entries, chunker, NodeClass, distance, opts }) {
    if (!entries.every((entry) => entry.kind === entries[0].kind)) {
      throw new Error('all entries must be of the same type')
    }
    const parts = []
    let chunk = []
    for (const entry of entries) {
      chunk.push(entry)
      if (await chunker(entry, distance)) {
        parts.push(new EntryList({ entries: chunk, closed: true }))
        chunk = []
      }
    }
    if (chunk.length) {
      parts.push(new EntryList({ entries: chunk, closed: false }))
    }
    return parts.map((entryList) => new NodeClass({ entryList, chunker, distance, ...opts }))
  }
}

class Leaf extends Node {
  get isLeaf() {
    return true
  }

  get wireKind() {
    return kindInfo(this.kind).leafKind
  }
}

class Branch extends Node {
  get isBranch() {
    return true
  }

  get wireKind() {
    return KIND_BRANCH
  }
}

// Bounds for `iterate`. When two bounds on one side are given, the tighter wins.
function resolveBounds({ gt, gte, lt, lte }) {
  for (const bound of [gt, gte, lt, lte]) {
    if (bound !== undefined && !isBytes(bound)) {
      throw createError(INVALID_KEY, 'a range bound must be a Buffer or Uint8Array')
    }
  }
  let lower = null
  if (gte !== undefined) lower = { key: gte, inclusive: true }
  if (gt !== undefined && (lower === null || compare(gt, lower.key) >= 0)) {
    lower = { key: gt, inclusive: false }
  }
  let upper = null
  if (lte !== undefined) upper = { key: lte, inclusive: true }
  if (lt !== undefined && (upper === null || compare(lt, upper.key) <= 0)) {
    upper = { key: lt, inclusive: false }
  }
  return { lower, upper }
}

// Decision 5. Copy every key and value, check the types, let the last op for
// a key win, and sort by key.
function normalizeOps(ops, info) {
  if (!Array.isArray(ops)) throw createError(INVALID_OPS, 'ops must be an array')
  const byKey = new Map()
  for (const op of ops) {
    if (op === null || typeof op !== 'object' || !isBytes(op.key)) {
      throw createError(INVALID_KEY, 'key must be a Buffer or Uint8Array')
    }
    const key = copy(op.key)
    if (op.del) {
      byKey.set(hex(key), { key, del: true })
      continue
    }
    if (info.leafKind === KIND_MAP_LEAF) {
      if (!isBytes(op.value)) {
        throw createError(INVALID_VALUE, 'value must be a Buffer or Uint8Array')
      }
      byKey.set(hex(key), { key, value: copy(op.value) })
    } else {
      byKey.set(hex(key), { key })
    }
  }
  return [...byKey.values()].sort((a, b) => compare(a.key, b.key))
}

// The list given to `create`. Copied, checked, sorted. A map throws
// `DUPLICATE_KEY` on two equal keys. A set collapses them.
function prepareList(list, info) {
  if (!Array.isArray(list)) throw new TypeError('list must be an array')
  const entries = list.map((item) => {
    if (item === null || typeof item !== 'object' || !isBytes(item.key)) {
      throw createError(INVALID_KEY, 'key must be a Buffer or Uint8Array')
    }
    const entry = { key: copy(item.key) }
    if (info.leafKind === KIND_MAP_LEAF) {
      if (!isBytes(item.value)) {
        throw createError(INVALID_VALUE, 'value must be a Buffer or Uint8Array')
      }
      entry.value = copy(item.value)
    }
    return new info.LeafEntryClass(entry)
  })
  entries.sort((a, b) => compare(a.key, b.key))
  const out = []
  for (const entry of entries) {
    if (out.length && compare(out[out.length - 1].key, entry.key) === 0) {
      if (info.leafKind === KIND_MAP_LEAF) {
        throw createError(DUPLICATE_KEY, `Duplicate key ${hex(entry.key)}`)
      }
      continue
    }
    out.push(entry)
  }
  return out
}

// The branch levels above a list of `[key, address]` entries, one level at a
// time until one node remains. Upstream `create` :806-813. `stalled` counts the
// consecutive levels with two or more entries that gave one node per entry.
async function* branchLevels(entries, chunker, opts, stalled) {
  let distance = entries.length ? 1 : 0
  let nodes = null
  while (nodes === null || nodes.length > 1) {
    if (stalled >= NO_PROGRESS_LEVELS) {
      throw createError(
        CHUNKER_NO_PROGRESS,
        `the chunker made no progress for ${NO_PROGRESS_LEVELS} consecutive levels`
      )
    }
    if (nodes !== null) {
      entries = nodes.map((node) => new BranchEntry({ key: node.key, address: node.address }))
    }
    nodes = await Node.from({ entries, chunker, NodeClass: Branch, distance, opts })
    stalled = entries.length >= 2 && nodes.length === entries.length ? stalled + 1 : 0
    yield* nodes
    distance++
  }
}

// Verify and decode one block. Decision 12: the hash is checked and
// `ADDRESS_MISMATCH` is thrown before the cache sees the block. The result is
// the record the cache holds: `{ address, bytes, kind, closed, distance,
// entries }`, with `kind` the wire kind. It is bound to no collection kind, no
// chunker and no storage (D-011 F-02), so one cache can serve every loader.
function decodeBlock(address, bytes) {
  if (!isBytes(bytes)) throw createError(BLOCK_MISSING, `Block ${hex(address)} is not bytes`)
  if (!b4a.equals(hashAddress(bytes), address)) {
    throw createError(ADDRESS_MISMATCH, `Block ${hex(address)} hashes to another address`)
  }
  const raw = decodeNode(bytes)
  const EntryClass = ENTRY_CLASS[raw.kind]
  return {
    address: copy(address),
    bytes: copy(bytes),
    kind: raw.kind,
    closed: raw.closed,
    distance: raw.distance,
    entries: raw.entries.map((entry) => new EntryClass(entry))
  }
}

// Upstream src/map.js:79-92 and :119-145. Decision 12: `load` computes the
// hash and throws `ADDRESS_MISMATCH` before the cache sees the node. A null
// block throws `BLOCK_MISSING`. A leaf of the wrong wire kind throws
// `KIND_MISMATCH`, on a cache hit as on a miss. Every load builds a node for
// its own kind, chunker and storage. The cache holds decoded blocks only.
function createGetNode({ storage, cache, chunker, kind }) {
  const info = kindInfo(kind)
  if (!storage || typeof storage.get !== 'function') {
    throw new TypeError('storage must have a get method')
  }
  if (typeof chunker !== 'function') throw new TypeError('chunker must be a function')

  const getNode = async (address) => {
    if (!isBytes(address) || address.byteLength !== 32) {
      throw createError(BLOCK_MISSING, 'address must be 32 bytes')
    }
    let block
    if (cache.has(address)) {
      block = cache.get(address)
    } else {
      const bytes = await storage.get(address)
      if (bytes === null || bytes === undefined) {
        throw createError(BLOCK_MISSING, `Block ${hex(address)} is missing`)
      }
      block = decodeBlock(address, bytes)
      cache.set(block)
    }
    return build(block)
  }

  // A node of this loader over a decoded block. The entries are shared with
  // the block. No read path changes them.
  const build = (block) => {
    let NodeClass
    if (block.kind === KIND_BRANCH) {
      NodeClass = Branch
    } else if (block.kind === info.leafKind) {
      NodeClass = Leaf
    } else {
      throw createError(
        KIND_MISMATCH,
        `Leaf of wire kind ${block.kind} does not belong to a ${kind} tree`
      )
    }
    return new NodeClass({
      entryList: new EntryList({ entries: block.entries, closed: block.closed }),
      chunker,
      distance: block.distance,
      getNode,
      cache,
      kind,
      bytes: block.bytes,
      address: block.address
    })
  }

  return getNode
}

// Upstream src/base.js:800-814 and src/map.js:94-112. Yields every node,
// leaves first, root last. Writes nothing.
async function* create({ list, storage, chunker, kind, cache = nocache }) {
  const info = kindInfo(kind)
  const getNode = createGetNode({ storage, cache, chunker, kind })
  const opts = { getNode, cache, kind }
  const entries = prepareList(list, info)
  if (!entries.length) return
  const nodes = await Node.from({ entries, chunker, NodeClass: Leaf, distance: 0, opts })
  yield* nodes
  const stalled = entries.length >= 2 && nodes.length === entries.length ? 1 : 0
  if (nodes.length > 1) {
    const branchEntries = nodes.map(
      (node) => new BranchEntry({ key: node.key, address: node.address })
    )
    yield* branchLevels(branchEntries, chunker, opts, stalled)
  }
}

// Upstream src/map.js:114-117. `kind` is a consensus parameter.
async function load({ address, storage, chunker, kind, cache = nocache }) {
  return createGetNode({ storage, cache, chunker, kind })(address)
}

module.exports = {
  Entry,
  MapLeafEntry,
  SetLeafEntry,
  BranchEntry,
  EntryList,
  Node,
  Leaf,
  Branch,
  KINDS,
  create,
  load,
  createGetNode,
  normalizeOps,
  prepareList,
  compare
}
