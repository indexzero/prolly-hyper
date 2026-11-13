// `npm run build`: regenerate `spec/hyperschema/` from `schema/index.js`.
const path = require('path')
const { build } = require('../schema')

const dir = path.join(__dirname, '..', 'spec', 'hyperschema')
build(dir)
console.log(`wrote ${path.relative(process.cwd(), dir)}`)
