// Test helpers: a seeded random source, random keys, a shuffle, a storage
// factory and the structural invariants of the Canonical bulk section.
const b4a = require('b4a')
const { MemoryStorage } = require('../../lib/storage/memory')
const { create, load } = require('../../lib/tree')

// mulberry32, the same generator upstream uses in test/test-map.js:785.
function seeded(seed) {
  let a = seed >>> 0
  return function random() {
    let t = (a += 0x6d2b79f5)
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function randomBytes(random, size) {
  const out = b4a.alloc(size)
  for (let i = 0; i < size; i++) out[i] = Math.floor(random() * 256)
  return out
}

// `count` unique keys of `size` bytes with values of `size` bytes.
function randomEntries(seed, count, size = 32) {
  const random = seeded(seed)
  const seen = new Set()
  const list = []
  while (list.length < count) {
    const key = randomBytes(random, size)
    const hex = b4a.toString(key, 'hex')
    if (seen.has(hex)) continue
    seen.add(hex)
    list.push({ key, value: randomBytes(random, size) })
  }
  return list
}

function shuffle(list, random) {
  const out = [...list]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    const tmp = out[i]
    out[i] = out[j]
    out[j] = tmp
  }
  return out
}

function sortEntries(list) {
  return [...list].sort((a, b) => b4a.compare(a.key, b.key))
}

function storage() {
  return new MemoryStorage()
}

// Build a tree with `create`, commit every node and return the root address.
async function build({ list, storage, chunker, kind = 'map' }) {
  const blocks = []
  let root = null
  for await (const node of create({ list, storage, chunker, kind })) {
    blocks.push({ address: node.address, bytes: node.bytes })
    root = node
  }
  if (root === null) return null
  await storage.commit({ blocks, root: root.address, expected: await storage.root() })
  return root.address
}

// Walk a tree and collect every node by level, root first.
async function collectNodes(root) {
  const levels = new Map()
  const queue = [root]
  while (queue.length) {
    const node = queue.shift()
    if (!levels.has(node.distance)) levels.set(node.distance, [])
    levels.get(node.distance).push(node)
    if (node.isBranch) {
      for (const entry of node.entryList.entries) {
        queue.push(await node.getNode(entry.address))
      }
    }
  }
  return levels
}

// The invariants of the Canonical bulk section. Throws on the first failure.
async function checkInvariants(root) {
  if (root === null) return
  const levels = await collectNodes(root)
  if (root.isBranch && root.entryList.entries.length < 2) {
    throw new Error('a root branch has two or more entries')
  }
  for (const [distance, nodes] of levels) {
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i]
      if (node.entryList.entries.length === 0) throw new Error('no node is empty')
      if (i < nodes.length - 1 && !node.closed) {
        throw new Error(`every node except the last of level ${distance} is closed`)
      }
      if (node.isBranch) {
        for (const entry of node.entryList.entries) {
          const child = await node.getNode(entry.address)
          if (child.distance !== distance - 1) {
            throw new Error(`a child of distance ${distance} has distance ${distance - 1}`)
          }
          if (b4a.compare(entry.key, child.key) !== 0) {
            throw new Error('every branch key equals the first key of its child')
          }
        }
      }
    }
  }
  return levels
}

module.exports = {
  seeded,
  randomBytes,
  randomEntries,
  shuffle,
  sortEntries,
  storage,
  build,
  collectNodes,
  checkInvariants,
  load
}
