# prolly-hyper

a port of mikeal/prolly-trees using hyperbee2 / hypercore

`prolly-hyper` is a port of [mikeal/prolly-trees](https://github.com/mikeal/prolly-trees) to the hyper stack. A prolly tree decides every chunk boundary from the hash of the entry at that position. So two peers that hold the same entries hold the same root. The port keeps upstream's read paths and `create`. It replaces upstream's incremental `bulk` with a canonical algorithm, so that every mutation lands on the root that `create` gives for the same entries. Node bytes use hyperschema-generated compact-encoding codecs. The address of a node is the BLAKE2b-256 hash of its bytes. Keys and values are bytes. The chunk factor and the collection kind, `map` or `set`, are consensus parameters. Every peer must use the same ones, and the tree does not store them.

## Install

```sh
npm install prolly-hyper
```

`hyperbee2` is a dependency. `corestore` is not. Install it when you use `Hyperbee2Storage`:

```sh
npm install corestore
```

The package is CommonJS and needs Node 22 or later.

## Usage with `MemoryStorage`

```js
const { ProllyMap, MemoryStorage, bf } = require('prolly-hyper')

const storage = new MemoryStorage()
const map = await ProllyMap.open(storage, { chunker: bf(32) })

await map.put(Buffer.from('a'), Buffer.from('1'))
await map.batch([
  { key: Buffer.from('b'), value: Buffer.from('2') },
  { key: Buffer.from('a'), del: true }
])

await map.get(Buffer.from('b')) // <Buffer 32>
await map.has(Buffer.from('a')) // false
for await (const { key, value } of map.range({ gte: Buffer.from('a') })) {
  // key and value are Buffers, in key order
}
map.root // the 32-byte root address, or null when the map is empty
```

`MemoryStorage` keeps every node in process. It is the storage for tests and for trees that need no persistence. Two maps that hold the same entries have the same `root`, whatever the order of the writes.

## Usage with `Hyperbee2Storage` and replication

```js
const Corestore = require('corestore')
const Hyperbee2 = require('hyperbee2')
const { ProllyMap, Hyperbee2Storage, bf } = require('prolly-hyper')

// The writer.
const storeA = new Corestore('./store-a')
const beeA = new Hyperbee2(storeA)
await beeA.ready()
const mapA = await ProllyMap.open(new Hyperbee2Storage(beeA), { chunker: bf(32) })
await mapA.put(Buffer.from('a'), Buffer.from('1'))

// The reader, in another corestore. Open the bee read-only by its key.
const storeB = new Corestore('./store-b')
const beeB = new Hyperbee2(storeB, { key: beeA.core.key, writable: false })
await beeB.ready()

// Replicate the two corestores over any duplex stream.
const s1 = storeA.replicate(true)
const s2 = storeB.replicate(false)
s1.pipe(s2).pipe(s1)

// A replica holds an empty root until its core updates. Update it before the first read.
await beeB.core.update({ wait: true })
const mapB = await ProllyMap.open(new Hyperbee2Storage(beeB), { chunker: bf(32) })
await mapB.get(Buffer.from('a')) // <Buffer 31>
Buffer.compare(mapA.root, mapB.root) // 0
```

The hyperbee2 is the unit of replication. A read on the replica downloads only the core blocks that the lookup touches. `ProllyMap.open` reads the root once. To see a later write, open a new map or call `storage.root()`. The storage never closes the bee. The caller owns the bee, its corestore and their lifetime.

## API

Every key and value is a `Buffer` or a `Uint8Array`. A string throws `TypeError` with code `INVALID_KEY` or `INVALID_VALUE`. Every returned key, value and root is a copy.

### `ProllyMap`

```js
const map = await ProllyMap.open(storage, { chunker, cache })
```

`chunker` defaults to `bf(32)`. `cache` defaults to `new Cache()`, a least-recently-used cache of 1024 decoded nodes. Pass `nocache` to disable it. `open` reads the root from `storage.root()`. A null root is an empty map.

| Call                              | Result                                             |
| --------------------------------- | -------------------------------------------------- |
| `await map.get(key)`              | the value, or `null`                               |
| `await map.has(key)`              | `true` or `false`                                  |
| `await map.put(key, value)`       | `{ root, previous }`, one commit                   |
| `await map.delete(key)`           | `{ root, previous }`, one commit                   |
| `await map.batch(ops)`            | `{ root, previous }`, one commit for every op      |
| `map.range({ gt, gte, lt, lte })` | an async iterator of `{ key, value }` in key order |
| `map.root`                        | the root address, or `null`                        |
| `map.storage`                     | the storage given to `open`                        |

An op is `{ key, value }` or `{ key, del: true }`. A batch is normalized before any tree work. The last op for a key wins. A delete of an absent key is dropped. A put equal to the stored value changes no root, but `previous` reports it. `previous` holds the prior `{ key, value }` of every key that existed, in key order. A batch that changes nothing commits nothing. Every bound of `range` is optional. No bound yields everything.

### `ProllySet`

```js
const set = await ProllySet.open(storage, { chunker, cache })
```

A set holds keys only. A set leaf is its own node kind, so a set root differs from the root of a map with empty values.

| Call                             | Result                                        |
| -------------------------------- | --------------------------------------------- |
| `await set.has(key)`             | `true` or `false`                             |
| `await set.add(key)`             | `{ root, previous }`, one commit              |
| `await set.delete(key)`          | `{ root, previous }`, one commit              |
| `await set.batch(ops)`           | `{ root, previous }`, one commit for every op |
| `set.keys({ gt, gte, lt, lte })` | an async iterator of keys in key order        |
| `set.root`                       | the root address, or `null`                   |

An op is `{ key }` or `{ key, del: true }`. A `value` on an op is ignored. `previous` holds `{ key }` for every key that existed, in key order.

### `diff(a, b, opts)`

```js
const { load, diff } = require('prolly-hyper')

const a = await load({ address: mapA.root, storage: storageA, chunker, kind: 'map' })
const b = await load({ address: mapB.root, storage: storageB, chunker, kind: 'map' })
const stats = {}
for await (const { key, left, right } of diff(a, b, { stats })) {
  // left or right is null when the key is absent on that side
}
```

`diff` takes two root nodes as `load` returns them, or `null` for an empty tree. The two trees can live in different storages. They must share the chunker and the collection kind. `kind` is `'map'` or `'set'`. A map root against a set root throws `KIND_MISMATCH`. The call is an async generator. It yields `{ key, left, right }` in key order for every key whose presence or value differs. For a map the sides are values. For a set the sides are the key. The merge is lazy. It skips every shared subtree by address, so a skipped subtree is never loaded. When `opts.stats` is given, it receives `visitedLeft` and `visitedRight`, two sets of hex addresses of the nodes that were loaded.

### Errors

Every thrown error carries a `code`. The codes are exported as `errors`.

| Code                           | When                                                           |
| ------------------------------ | -------------------------------------------------------------- |
| `CONFLICT`                     | `commit` found a stored root that is not `expected`            |
| `NOT_FOUND`                    | the low-level `getEntry` found no entry for the key            |
| `BLOCK_MISSING`                | storage returned `null` for a reachable block                  |
| `ADDRESS_MISMATCH`             | storage returned bytes whose hash is not the requested address |
| `KIND_MISMATCH`                | a map and a set were mixed, in `diff` or in `load`             |
| `DUPLICATE_KEY`                | `create` got a list with two equal keys                        |
| `INVALID_KEY`, `INVALID_VALUE` | a key or a value that is not bytes                             |
| `INVALID_FACTOR`               | `bf` got a factor outside 2 to 4294967295                      |
| `INVALID_OPS`                  | `batch` got ops that are not an array                          |
| `INVALID_CACHE_SIZE`           | `new Cache(max)` got a max that is not a positive integer      |
| `CHUNKER_NO_PROGRESS`          | 32 consecutive levels produced one node per entry              |
| `UNSUPPORTED_VERSION`          | a node with a `version` other than 1                           |
| `DECODE_ERROR`                 | a node that breaks a decode rule                               |

## The storage interface

```js
// address: Buffer, 32 bytes. bytes: Buffer, the encoded node.
interface Storage {
  async get (address) -> Buffer | null              // the node bytes, or null when absent
  async commit ({ blocks, root, expected }) -> void   // blocks: [{ address, bytes }], root: Buffer | null,
                                                      // expected: Buffer | null, the root the writer read
  async root () -> Buffer | null                     // the last committed root, or null when empty
}
```

`commit` writes every block and the root pointer in one atomic step, or throws and writes nothing. It throws `CONFLICT` when the stored root is not `expected`, compared by bytes, with `null` equal to `null`. A reader that sees the new root sees every block that the root reaches. A block already present under its address is not rewritten. Any object with these three methods works as a storage.

`MemoryStorage` keeps a `Map` from the hex address to a copy of the bytes. `Hyperbee2Storage` takes a hyperbee2, or a `checkout` or `snapshot` of one, and uses one `write()` batch per commit. The batch takes the hyperbee2 lock, reads the root key, compares it with `expected`, queues every block and the root, and flushes. One flush is one append to the hypercore, so a reader at any committed length sees a whole commit or none of it.

| Key                                    | Value                                                     |
| -------------------------------------- | --------------------------------------------------------- |
| `0x01` followed by the 32-byte address | the node bytes                                            |
| `0x00`                                 | the 32-byte root address. Deleted when the root is `null` |

## Consensus parameters

Two peers hold the same root for the same entries only when they agree on every parameter below. The tree stores none of them. A change to any of them changes every root and is a breaking change.

**The hash.** `address(node) = blake2b-256(encode(node))`, from `hypercore-crypto` `hash`, 32 bytes, with no prefix.

**The node encoding.** Version 1. The structs are registered with hyperschema in the namespace `prolly-hyper` and generated into `spec/hyperschema/`. Every integer is a compact-encoding `uint`. Every byte string is a length-prefixed `buffer`. An address is a `fixed32`. `entries` is a `uint` count followed by the entries.

```
map-entry:    key buffer, value buffer
set-entry:    key buffer
branch-entry: key buffer, address fixed32

map-leaf:   version uint = 1, kind uint = 0, flags uint, distance uint = 0, entries array of map-entry
branch:     version uint = 1, kind uint = 1, flags uint, distance uint >= 1, entries array of branch-entry
set-leaf:   version uint = 1, kind uint = 2, flags uint, distance uint = 0, entries array of set-entry

flags: bit 0 = closed. Other bits must be 0.
```

A branch entry's key is the first key of its child. Every node except the last of its level is closed. The decoder is canonical. It rejects:

- an unknown version or an unknown kind
- a flag other than bit 0
- a leaf with a distance above 0, or a branch with distance 0
- an empty entry list
- trailing bytes
- any form that does not re-encode to the same bytes

**The chunk factor.** `bf(factor)` is the chunker. `identity(entry)` is the last four bytes of `blake2b-256(encode(entry))`, read as a little-endian uint32. A boundary falls after an entry when `identity(entry) <= floor(0xFFFFFFFF / factor)`. The default factor is 32, so a node holds about 32 entries. `factor` must be a safe integer from 2 to 4294967295. Any other value throws `INVALID_FACTOR`. A custom chunker must be a deterministic function of the entry bytes.

**The comparator.** Keys sort by `b4a.compare`, byte by byte, with the shorter key first on a shared prefix. A zero-length key is legal and sorts first. Key equality uses the same comparison, never a string conversion.

**The collection kind.** `map` or `set`. A branch node does not say which collection it belongs to, so the caller gives the kind to `load` and to `diff`.

## One writer per storage

`ProllyMap` and `ProllySet` read the root on `open` and commit every mutation with `expected` set to the root they last wrote. Mutations on one instance run in order through one internal queue, so concurrent calls on one instance all land. Two instances on one storage are the caller's problem. The second writer gets `CONFLICT` from `commit`, and the storage is unchanged. Catch the error, open a new instance to read the current root, and retry the mutation.

With `Hyperbee2Storage`, the lock that `commit` takes belongs to the `Hyperbee2` object, not to the hypercore. Two `ProllyMap` instances on one `Hyperbee2` get `CONFLICT`. Two `Hyperbee2` objects on one hypercore, in one process or in two, do not share a head. A writable bee never follows the appends of its core, so the second object does not see the first one's write. `commit` refuses to build on a head that its bee has not seen. When the bee is behind its core, it throws `CONFLICT` with the message `the bee is behind its core: another Hyperbee2 wrote to it` and appends nothing. The rule is one `Hyperbee2` per hypercore per process. Give that one object to every `Hyperbee2Storage` that writes. A replica opened with `writable: false` cannot commit. Its `write()` throws `Not writable`.

## Old nodes are never deleted

A tree is persistent. A commit writes the new nodes and moves the root pointer. It never removes a node, so an old root stays readable as long as its blocks stay in the storage. `MemoryStorage` grows with every commit. `Hyperbee2Storage` appends to the hypercore and never truncates it. Garbage collection is out of scope.

## License

Apache-2.0, see `LICENSE`. `prolly-hyper` is a port of [mikeal/prolly-trees](https://github.com/mikeal/prolly-trees) by Mikeal Rogers, licensed `(Apache-2.0 AND MIT)`, at the upstream commit `4c7c81a`. See `NOTICE`.
