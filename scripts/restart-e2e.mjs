/**
 * Cross-restart acceptance test.
 *
 * Runs scripts/restart-phase.mjs twice as SEPARATE processes over one DSH_HOME:
 * `seed` has two independent sessions exchange a message, then the process exits;
 * `verify` boots a fresh process and proves the conversation is still in the
 * persisted log and that a stored session can still be woken.
 *
 * A real process boundary is the point: resuming in place would not test
 * durability, and durability is what the acceptance criterion names.
 *
 * Usage: DSH_HOME=<test home> node scripts/restart-e2e.mjs
 */
// Pin DSH_HOME to the repo test home before the DSH loader reads it.
import "./dsh-home.mjs";
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const phaseScript = join(here, 'restart-phase.mjs');
const runId = `${process.pid}-${Date.now().toString(36)}`;

if (process.env.DSH_HOME === undefined) {
  console.error('DSH_HOME must point at a test home (e.g. $PWD/.dsh-test)');
  process.exit(2);
}

/** Run one phase to completion, streaming its output. */
function runPhase(phase) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [phaseScript, phase, runId], {
      stdio: 'inherit',
      env: process.env,
    });
    child.on('exit', (code) => resolve(code ?? 1));
  });
}

console.log(`restart-e2e: run ${runId} over DSH_HOME=${process.env.DSH_HOME}\n`);
const seedCode = await runPhase('seed');
if (seedCode !== 0) {
  console.error('\nrestart-e2e FAILED: the seed phase did not complete');
  process.exit(1);
}
console.log('');
const verifyCode = await runPhase('verify');

console.log(
  verifyCode === 0
    ? '\nrestart-e2e OK: the conversation survived a real process restart'
    : '\nrestart-e2e FAILED: the verify phase did not pass',
);
process.exit(verifyCode === 0 ? 0 : 1);
