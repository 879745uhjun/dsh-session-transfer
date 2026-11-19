/**
 * Preflight syntax check used by `npm pretest`.
 *
 * The plugin is installed through `link:`, so this working tree is production:
 * a syntax error in `index.js` or `client.js` makes the host entry fail to load
 * or the client module disappear. `node --check` every source before the test
 * suite so that class of mistake fails loudly here, not in the running app.
 */
import { execFileSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'

const files = ['index.js', 'client.js']
for (const directory of ['lib', 'test']) {
  let names = []
  try {
    names = readdirSync(directory)
  } catch {
    continue
  }
  for (const name of names) {
    if (/\.(mjs|js)$/u.test(name)) files.push(join(directory, name))
  }
}

const failed = []
for (const file of files) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' })
  } catch (error) {
    failed.push({ file, output: `${error?.stderr ?? ''}${error?.stdout ?? ''}`.trim() })
  }
}

if (failed.length > 0) {
  for (const row of failed) {
    console.error(`syntax check failed: ${row.file}`)
    if (row.output !== '') console.error(row.output)
  }
  process.exit(1)
}
console.log(`syntax check passed: ${files.length} files`)
