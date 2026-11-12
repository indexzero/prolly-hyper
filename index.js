// prolly-hyper: a port of mikeal/prolly-trees to hyperschema codecs, BLAKE2b
// and the hyper stack. The set, the diff and the hyperbee2 storage land in
// later dispatches.
const tree = require('./lib/tree')
const map = require('./lib/map')
const encoding = require('./lib/encoding')
const hash = require('./lib/hash')
const chunker = require('./lib/chunker')
const cache = require('./lib/cache')
const errors = require('./lib/errors')
const { MemoryStorage } = require('./lib/storage/memory')

module.exports = {
  // the low-level API
  create: tree.create,
  load: tree.load,
  Entry: tree.Entry,
  EntryList: tree.EntryList,
  Node: tree.Node,
  Leaf: tree.Leaf,
  Branch: tree.Branch,
  BranchEntry: tree.BranchEntry,
  MapLeafEntry: map.MapLeafEntry,
  MapBranchEntry: map.MapBranchEntry,
  SetLeafEntry: tree.SetLeafEntry,

  // the high-level API
  ProllyMap: map.ProllyMap,
  MemoryStorage,

  // the consensus parameters
  bf: chunker.bf,
  DEFAULT_FACTOR: chunker.DEFAULT_FACTOR,
  MAX_UINT32: chunker.MAX_UINT32,

  // the encoding
  VERSION: encoding.VERSION,
  KIND_MAP_LEAF: encoding.KIND_MAP_LEAF,
  KIND_BRANCH: encoding.KIND_BRANCH,
  KIND_SET_LEAF: encoding.KIND_SET_LEAF,
  encodeNode: encoding.encodeNode,
  decodeNode: encoding.decodeNode,
  encodeEntry: encoding.encodeEntry,
  address: hash.address,
  identity: hash.identity,

  // the cache and the errors
  Cache: cache.Cache,
  nocache: cache.nocache,
  errors
}
