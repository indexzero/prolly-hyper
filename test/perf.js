// The benchmark of the Performance Analysis section. Skipped unless
// PROLLY_PERF=1. 100000 random 32-byte keys: the `create` time and the time
// of 100 single `put` calls, printed.
const { test, skip } = require('brittle')
const b4a = require('b4a')
const { ProllyMap } = require('../lib/map')
const { create } = require('../lib/tree')
const { bf, DEFAULT_FACTOR } = require('../lib/chunker')
const { storage, randomEntries, sortEntries } = require('./helpers')

const COUNT = 100000
const PUTS = 100

if (!process.env.PROLLY_PERF) {
  skip(`perf: ${COUNT} keys, create and ${PUTS} puts (set PROLLY_PERF=1)`, () => {})
} else {
  test(`perf: ${COUNT} keys, create and ${PUTS} puts, factor ${DEFAULT_FACTOR}`, async (t) => {
    const chunker = bf(DEFAULT_FACTOR)
    const list = sortEntries(randomEntries(42, COUNT + PUTS))
    const base = list.slice(0, COUNT)
    const extra = list.slice(COUNT)

    const store = storage()
    const blocks = []
    let root = null
    let nodes = 0
    const t0 = process.hrtime.bigint()
    for await (const node of create({ list: base, storage: store, chunker, kind: 'map' })) {
      blocks.push({ address: node.address, bytes: node.bytes })
      root = node
      nodes++
    }
    const t1 = process.hrtime.bigint()
    await store.commit({ blocks, root: root.address, expected: null })
    const createMs = Number(t1 - t0) / 1e6
    t.comment(
      `create: ${COUNT} entries, ${nodes} nodes, root distance ${root.distance}, ${createMs.toFixed(1)} ms`
    )

    const map = await ProllyMap.open(store, { chunker })
    t.alike(map.root, root.address)
    const t2 = process.hrtime.bigint()
    for (const { key, value } of extra) await map.put(key, value)
    const t3 = process.hrtime.bigint()
    const putMs = Number(t3 - t2) / 1e6
    t.comment(
      `${PUTS} single puts: ${putMs.toFixed(1)} ms, ${(putMs / PUTS).toFixed(2)} ms per put`
    )

    for (const { key, value } of extra.slice(0, 10)) t.alike(await map.get(key), value)
    t.alike(await map.get(base[0].key), base[0].value)
    t.alike(await map.get(base[COUNT - 1].key), base[COUNT - 1].value)
    t.is(b4a.toString(map.root, 'hex').length, 64)
  })
}
