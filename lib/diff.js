// `diff(a, b, opts)` of TECHNICAL.DESIGN.md decision 9. Not in upstream.
//
// A lazy two-cursor merge over the leaf entries of two trees. Each cursor is
// a stack of frames, root first. A frame is a node and the index of its first
// unconsumed entry. The cursor stands at the first unconsumed entry of a node
// when that node's frame, and every frame below it, has index 0. It also
// stands at the start of the child that the top frame points to, which is not
// loaded yet.
//
// The skip rule. When both cursors stand at the start of nodes with equal
// addresses, both skip that node. The check runs before every descent, and
// the higher cursor descends first, so both cursors compare children at one
// level. The skip happens at the highest level where it holds and a skipped
// node is never loaded. A partially consumed node is never skipped, because a
// frame with index above 0 ends the candidate list. Two nodes with equal
// addresses hold equal subtrees: the address is the hash of the node bytes,
// and those bytes hold the child addresses.
//
// `visited` counts the roots given and every node that `getNode` loaded.
const b4a = require('b4a')
const { compare } = require('./tree')
const { copy, isBytes } = require('./encoding')
const { createError, KIND_MISMATCH } = require('./errors')

const hex = (bytes) => b4a.toString(bytes, 'hex')

function checkRoot(root, name) {
  if (root === null) return
  if (
    root === undefined ||
    typeof root !== 'object' ||
    !root.entryList ||
    typeof root.getNode !== 'function' ||
    typeof root.kind !== 'string' ||
    !isBytes(root.address)
  ) {
    throw new TypeError(`${name} must be a root node as load returns it, or null`)
  }
}

class Cursor {
  constructor(root, visited) {
    this.frames = []
    this.visited = visited
    if (root !== null) {
      this.frames.push({ node: root, index: 0 })
      visited.add(hex(root.address))
    }
  }

  get done() {
    return this.frames.length === 0
  }

  get top() {
    return this.frames[this.frames.length - 1]
  }

  get atLeaf() {
    return this.top.node.isLeaf
  }

  get entry() {
    const { node, index } = this.top
    return node.entryList.entries[index]
  }

  // Pop every exhausted frame. Afterwards the top frame has an unconsumed
  // entry, or the cursor is done.
  settle() {
    while (this.frames.length) {
      const { node, index } = this.top
      if (index < node.entryList.entries.length) return
      this.frames.pop()
      if (this.frames.length) this.top.index++
    }
  }

  // The nodes whose start the cursor stands at, lowest level first. `frame`
  // is the index of the frame, or -1 for the unloaded child of the top frame.
  candidates() {
    const out = []
    const top = this.top
    if (top.node.isBranch) {
      out.push({ hex: hex(this.entry.address), frame: -1 })
    }
    for (let i = this.frames.length - 1; i >= 0 && this.frames[i].index === 0; i--) {
      out.push({ hex: hex(this.frames[i].node.address), frame: i })
    }
    return out
  }

  // Skip the node of a candidate: step past the child, or drop the frame and
  // every frame above it, then step the parent past it.
  skip(candidate) {
    if (candidate.frame === -1) {
      this.top.index++
      return
    }
    this.frames.length = candidate.frame
    if (this.frames.length) this.top.index++
  }

  async descend() {
    const { node } = this.top
    const child = await node.getNode(this.entry.address)
    this.visited.add(hex(child.address))
    this.frames.push({ node: child, index: 0 })
  }

  advance() {
    this.top.index++
  }

  // Load the next leaf entry, or return null when the cursor is done.
  async next() {
    for (;;) {
      this.settle()
      if (this.done) return null
      if (this.atLeaf) return this.entry
      await this.descend()
    }
  }
}

// The highest-level pair of equal addresses, or null.
function sharedNode(left, right) {
  const lc = left.candidates()
  const rc = new Map(right.candidates().map((c) => [c.hex, c]))
  for (let i = lc.length - 1; i >= 0; i--) {
    const match = rc.get(lc[i].hex)
    if (match) return [lc[i], match]
  }
  return null
}

// Yields `{ key, left, right }` for every key whose presence or value differs,
// in key order. A side is null when the key is absent there. For a map the
// sides are values. For a set they are the key. Every buffer is a copy.
// `a` and `b` are root nodes as `load` returns them, or null for an empty
// tree. They may live in different storages. They must share the chunker and
// the collection kind. `opts.stats`, when given, receives `visitedLeft` and
// `visitedRight` as sets of hex addresses.
async function* diff(a, b, opts = {}) {
  checkRoot(a, 'a')
  checkRoot(b, 'b')
  if (a !== null && b !== null && a.kind !== b.kind) {
    throw createError(KIND_MISMATCH, `cannot diff a ${a.kind} against a ${b.kind}`)
  }
  const kind = a !== null ? a.kind : b !== null ? b.kind : null
  const visitedLeft = new Set()
  const visitedRight = new Set()
  if (opts.stats) {
    opts.stats.visitedLeft = visitedLeft
    opts.stats.visitedRight = visitedRight
  }
  const side = kind === 'map' ? (entry) => copy(entry.value) : (entry) => copy(entry.key)
  const left = new Cursor(a, visitedLeft)
  const right = new Cursor(b, visitedRight)

  for (;;) {
    left.settle()
    right.settle()
    if (left.done || right.done) break
    const shared = sharedNode(left, right)
    if (shared !== null) {
      left.skip(shared[0])
      right.skip(shared[1])
      continue
    }
    // Descend the higher cursor first, so that both compare children at one
    // level and a shared child is found before either side loads it.
    const ld = left.top.node.distance
    const rd = right.top.node.distance
    if (ld > 0 || rd > 0) {
      if (ld >= rd) await left.descend()
      else await right.descend()
      continue
    }
    const l = left.entry
    const r = right.entry
    const c = compare(l.key, r.key)
    if (c < 0) {
      yield { key: copy(l.key), left: side(l), right: null }
      left.advance()
    } else if (c > 0) {
      yield { key: copy(r.key), left: null, right: side(r) }
      right.advance()
    } else {
      if (kind === 'map' && !b4a.equals(l.value, r.value)) {
        yield { key: copy(l.key), left: side(l), right: side(r) }
      }
      left.advance()
      right.advance()
    }
  }

  // One side is done. Every remaining entry of the other side differs.
  for (let l = await left.next(); l !== null; l = await left.next()) {
    yield { key: copy(l.key), left: side(l), right: null }
    left.advance()
  }
  for (let r = await right.next(); r !== null; r = await right.next()) {
    yield { key: copy(r.key), left: null, right: side(r) }
    right.advance()
  }
}

module.exports = { diff }
