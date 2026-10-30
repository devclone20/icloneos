// How a row's child process hands its result back: a JSON file in the row scratch, never stdout.
//
// On macOS a pipe is asynchronous for Node: a child that writes a large JSON line to stdout and then calls
// process.exit() drops whatever has not drained yet, and the parent sees the line cut at the pipe buffer (64 KiB).
// writeFileSync completes before process.exit() can run, and the parent reads the file only after the whole process
// group is gone, so the result is either complete or missing (a harness error), never truncated.
import { existsSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { HarnessError } from './stats.mjs'
import { clipTail } from './table.mjs'

/** A fresh result path under `scratch` for one child run (its own directory, so two runs never share a file). */
export function newResultFile(scratch) {
  return join(mkdtempSync(join(scratch, 'result-')), 'result.json')
}

/** Child side: write `value` as JSON to `file` (written to a temporary name, then renamed into place). */
export function writeResult(file, value) {
  if (!file) {
    throw new Error('no result file was given to this child (args.result)')
  }
  const tmp = `${file}.partial`
  writeFileSync(tmp, `${JSON.stringify(value)}\n`)
  renameSync(tmp, file)
}

/** Parent side: the child's result after `run()` settled; a non-zero exit or a missing file is a harness error. */
export function readResult(file, res, label) {
  if (res.code !== 0) {
    throw new HarnessError(`${label} exited ${res.code}: ${clipTail(String(res.stderr), 600)}`)
  }
  if (!existsSync(file)) {
    throw new HarnessError(`${label} exited 0 without writing its result file`)
  }
  return JSON.parse(readFileSync(file, 'utf8'))
}
