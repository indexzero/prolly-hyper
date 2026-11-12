# prolly-hyper

a port of mikeal/prolly-trees using hyperbee2 / hypercore

`prolly-hyper` is a port of [mikeal/prolly-trees](https://github.com/mikeal/prolly-trees) to the hyper stack. A prolly tree decides every chunk boundary from the hash of the entry at that position, so two peers that hold the same entries hold the same root. The port keeps upstream's read paths and `create`. It replaces upstream's incremental `bulk` with a canonical algorithm, so that every mutation lands on the root that `create` gives for the same entries. Node bytes use hyperschema-generated compact-encoding codecs. The address of a node is the BLAKE2b-256 hash of its bytes. Keys and values are bytes. The chunk factor and the collection kind, `map` or `set`, are consensus parameters: every peer must use the same ones, and the tree does not store them.

This stub is the state after dispatch D-003: the core tree, the map, the encoding, the chunker and the in-memory storage. Dispatch D-004 adds the set and `diff`. Dispatch D-005 adds the hyperbee2 storage and completes the docs: the API, the consensus parameters, the storage contract and the limits of the library.
