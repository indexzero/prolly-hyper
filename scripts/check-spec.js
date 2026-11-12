// `npm run check:spec`: run the build into a temporary directory and fail
// when the bytes differ from `spec/hyperschema/`.
//
// The build is seeded with the committed `schema.json`, as `Hyperschema.from`
// does on a rebuild, so a changed struct is detected as a version bump or an
// append-only violation and a stale `index.js` as a byte difference.
const fs = require('fs')
const os = require('os')
const path = require('path')
const { build } = require('../schema')

const FILES = ['schema.json', 'index.js']

const spec = path.join(__dirname, '..', 'spec', 'hyperschema')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'prolly-hyper-spec-'))

let failed = false
try {
  const committedJson = path.join(spec, 'schema.json')
  if (fs.existsSync(committedJson)) {
    fs.copyFileSync(committedJson, path.join(tmp, 'schema.json'))
  }
  try {
    build(tmp)
  } catch (err) {
    // hyperschema refuses a change that breaks its append-only rule.
    console.error(`check:spec: the build failed against the committed schema.json: ${err.message}`)
    failed = true
  }
  for (const name of FILES) {
    if (failed) break
    const want = path.join(spec, name)
    const got = path.join(tmp, name)
    if (!fs.existsSync(want)) {
      console.error(
        `check:spec: ${path.relative(process.cwd(), want)} is missing. Run npm run build.`
      )
      failed = true
      continue
    }
    if (!fs.readFileSync(want).equals(fs.readFileSync(got))) {
      console.error(
        `check:spec: ${path.relative(process.cwd(), want)} is stale. Run npm run build.`
      )
      failed = true
    }
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true })
}

if (failed) process.exit(1)
console.log('check:spec: spec/hyperschema is current')
