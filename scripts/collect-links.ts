import { collectLinks } from '../src/collect/run'

await collectLinks(process.argv.slice(2))
