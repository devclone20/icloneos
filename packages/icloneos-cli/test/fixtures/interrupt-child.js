// @ts-check
// Runs `icloneos update` through the real signal wiring against the fake system, and sends itself a real
// signal right before the swap (the second pgrep). Prints the exit code and the fake's root as JSON.
import { dirname, join } from 'node:path';

import { main } from '../../src/cli.js';
import { RELEASE_CONTRACT } from '../../src/contract.js';
import { abortOnTerminationSignals } from '../../src/signals.js';
import { makeFakeSystem, writeFakeApp } from '../fake-system.js';

const signal = process.argv[2] === 'SIGTERM' ? 'SIGTERM' : 'SIGINT';
let pgreps = 0;
const fake = await makeFakeSystem({
  feedVersion: '0.0.4',
  abortSignal: abortOnTerminationSignals(),
  async onCommand(command) {
    if (command !== 'pgrep' || (pgreps += 1) !== 2) return;
    process.kill(process.pid, signal);
    await new Promise((resolve) => setTimeout(resolve, 50));
  },
});
await writeFakeApp(join(fake.dest, RELEASE_CONTRACT.appBundleName), { bundleId: RELEASE_CONTRACT.bundleId, version: '0.0.3' });
const code = await main(['update'], fake.sys, { out: () => {}, err: (line) => process.stderr.write(`${line}\n`) });
process.stdout.write(JSON.stringify({ code, root: dirname(fake.home), dest: fake.dest, tmpRoot: fake.tmpRoot }));
