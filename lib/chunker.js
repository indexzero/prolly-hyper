// The chunker of decision 4. A port of upstream `bf` (src/utils.js:11-26)
// with factor validation. The factor is a consensus parameter. It is not
// stored in the tree.
const { createError, INVALID_FACTOR } = require('./errors')

const MAX_UINT32 = 0xffffffff

// An ESTIMATE that targets about 32 entries per node.
const DEFAULT_FACTOR = 32

// How many consecutive levels with two or more entries may produce one node
// per entry before `create` and `bulk` throw `CHUNKER_NO_PROGRESS`.
const NO_PROGRESS_LEVELS = 32

// boundary(entry, factor) = identity(entry) <= floor(0xFFFFFFFF / factor)
function bf(factor) {
  if (!Number.isSafeInteger(factor) || factor < 2 || factor > MAX_UINT32) {
    throw createError(
      INVALID_FACTOR,
      `factor must be a safe integer from 2 to ${MAX_UINT32}, got ${String(factor)}`
    )
  }
  const threshold = Math.floor(MAX_UINT32 / factor)
  // Upstream awaits `entry.identity()` (src/utils.js:14). The port's identity
  // is synchronous, so the chunker is too. `Node.from` still awaits the result,
  // so a custom asynchronous chunker works.
  return (entry) => entry.identity() <= threshold
}

module.exports = { bf, DEFAULT_FACTOR, MAX_UINT32, NO_PROGRESS_LEVELS }
