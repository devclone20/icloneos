#!/usr/bin/env node
// @ts-check
import { main } from '../src/cli.js';
import { abortOnTerminationSignals } from '../src/signals.js';
import { realSystem } from '../src/system.js';

process.exitCode = await main(process.argv.slice(2), realSystem(abortOnTerminationSignals()), {
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
});
