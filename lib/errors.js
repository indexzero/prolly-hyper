// The error codes of TECHNICAL.DESIGN.md decision 13. Every thrown error
// carries a `code`. `INVALID_KEY` and `INVALID_VALUE` are a `TypeError`.
// `INVALID_FACTOR` is a `RangeError`. The others are a plain `Error`.

const CODES = Object.freeze({
  NOT_FOUND: 'NOT_FOUND',
  BLOCK_MISSING: 'BLOCK_MISSING',
  ADDRESS_MISMATCH: 'ADDRESS_MISMATCH',
  CONFLICT: 'CONFLICT',
  DUPLICATE_KEY: 'DUPLICATE_KEY',
  KIND_MISMATCH: 'KIND_MISMATCH',
  INVALID_FACTOR: 'INVALID_FACTOR',
  CHUNKER_NO_PROGRESS: 'CHUNKER_NO_PROGRESS',
  INVALID_KEY: 'INVALID_KEY',
  INVALID_VALUE: 'INVALID_VALUE',
  UNSUPPORTED_VERSION: 'UNSUPPORTED_VERSION',
  DECODE_ERROR: 'DECODE_ERROR'
})

const CONSTRUCTORS = {
  INVALID_KEY: TypeError,
  INVALID_VALUE: TypeError,
  INVALID_FACTOR: RangeError
}

// Make an error with `code`. The constructor follows decision 13.
function createError(code, message) {
  if (!Object.hasOwn(CODES, code)) throw new Error(`Unknown error code: ${code}`)
  const Ctor = CONSTRUCTORS[code] || Error
  const err = new Ctor(message)
  err.code = code
  return err
}

module.exports = { ...CODES, CODES, createError }
