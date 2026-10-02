/**
 * The real-model cross-process check: a real model in another OS process.
 *
 * `scripts/e2e-xproc.mjs` proves the transport with a stub adapter. This proves the
 * thing a stub cannot: that a message arriving over the socket from a *different
 * process* wakes a **real model turn** in the process that holds the session, and
 * that the real answer travels back.
 *
 * Two processes, one real route:
 *   - the host (spawned) holds a session on the real model route
 *   - this process asks it a question with `bus_ask` and waits for the answer
 *   - the answer is produced by the real model in the host process, captured there,
 *     and pushed back over the socket
 *
 * Prompts never name a bus tool. Which tool the model chooses is recorded as an
 * observation; the mechanism checks are hard failures. This costs real tokens.
 *
 * Usage: npm run real-model-xproc
 */
import './dsh-home.mjs';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { createLaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment';
import { runProfile } from '@deepseek-ai/dsh/profile-boot';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..');
const yaml = createRequire(join(repo, 'node_modules/@deepseek-ai/dsh/package.json'))('js-yaml');

const SOURCE_PATCH =
  process.env.REAL_MODEL_SOURCE_PATCH ?? join(homedir(), '.dsh/profiles/web/cordis.patch.yml');
const CREDENTIALS = process.env.REAL_MODEL_CREDENTIALS ?? join(homedir(), '.dsh/.credentials.yaml');
const RUN = `${process.pid}-${Date.now().toString(36)}`;
const SCENARIO_TIMEOUT_MS = 300_000;

// ---------------------------------------------------------------------------
// Model route: the same rows the single-process check copies out of the real profile.
// ---------------------------------------------------------------------------
const sourceRows = yaml.load(readFileSync(SOURCE_PATCH, 'utf8')) ?? [];
const llmRow = sourceRows.find((row) => row?.id === 'llm-pi-ai');
const defaultModelRow = sourceRows.find((row) => row?.id === 'agent-default-model');
if (llmRow === undefined || defaultModelRow === undefined) {
  console.error(`real-model-xproc: ${SOURCE_PATCH} has no llm-pi-ai / agent-default-model rows`);
  process.exit(2);
}
const PROVIDER = process.env.REAL_MODEL_PROVIDER ?? defaultModelRow.config.provider;
const MODEL = process.env.REAL_MODEL_MODEL ?? defaultModelRow.config.model;
const EFFORT = process.env.REAL_MODEL_EFFORT ?? 'low';
process.env.REAL_MODEL_PROVIDER = PROVIDER;
process.env.REAL_MODEL_MODEL = MODEL;
process.env.REAL_MODEL_EFFORT = EFFORT;

const keyName = llmRow.config?.providers?.[PROVIDER]?.apiKeyEnv;
if (typeof keyName === 'string' && process.env[keyName] === undefined) {
  try {
    const stored = yaml.load(readFileSync(CREDENTIALS, 'utf8'))?.refs?.[keyName];
    if (typeof stored === 'string' && stored !== '') process.env[keyName] = stored;
  } catch {
    // Reported below as a missing key rather than as a parse error.
  }
}
if (typeof keyName === 'string' && process.env[keyName] === undefined) {
  console.error(`real-model-xproc: ${keyName} is neither exported nor stored in ${CREDENTIALS}`);
  process.exit(2);
}

// The overlay both processes boot from. `crossProcess` is the whole point; the rest
// matches the single-process check so the model route is identical.
const overlay = join(process.env.DSH_HOME, 'real-model-xproc.patch.yml');
writeFileSync(
  overlay,
  yaml.dump([
    llmRow,
    defaultModelRow,
    {
      id: 'peer-bus',
      config: {
        allow: [{ sameWorkspace: true }],
        crossProcess: true,
        crossProcessTimeoutMs: 2000,
        crossProcessDeliverTimeoutMs: 120000,
      },
    },
  ]),
);

/**
 * A real workspace for both sessions to work in, so `sameWorkspace` holds.
 *
 * Resolved through `realpath` on purpose. On macOS `/var` is a symlink to
 * `/private/var`, and a child process's `process.cwd()` reports the physical path
 * while the string this process built still contains the symlink — so the two
 * sessions would look like they were in different directories and the
 * `sameWorkspace` rule would refuse a pair that is genuinely co-located.
 */
const workspace = realpathSync(mkdtempSync(join(tmpdir(), 'peer-bus-real-xproc-')));

const results = [];
const record = (kind, label, ok, detail = '') => {
  results.push({ kind, label, ok, detail });
  const tag = kind === 'check' ? (ok ? 'PASS ' : 'FAIL ') : ok ? 'SEEN ' : 'NOTE ';
  console.log(`  ${tag} ${label}${detail ? ` — ${detail}` : ''}`);
};
const check = (label, ok, detail) => record('check', label, ok, detail);
const observe = (label, ok, detail) => record('observe', label, ok, detail);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Spawn the host and wait for it to announce a live session on the real route. */
function startHost() {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [join(here, 'real-model-xproc-phase.mjs'), 'host', RUN],
      {
        cwd: workspace,
        // Passed explicitly rather than relying on the child's `process.cwd()`, so
        // both sides record the identical string.
        env: { ...process.env, REAL_MODEL_XPROC_WORKSPACE: workspace },
        stdio: ['ignore', 'pipe', 'inherit'],
      },
    );
    let buffered = '';
    const timer = setTimeout(
      () => reject(new Error(`the host did not become ready:\n${buffered}`)),
      SCENARIO_TIMEOUT_MS,
    );
    child.stdout.on('data', (chunk) => {
      buffered += chunk.toString('utf8');
      process.stdout.write(chunk);
      const session = /HOST-READY (\S+)/.exec(buffered);
      const endpoint = /HOST-ENDPOINT (\S+)/.exec(buffered);
      if (session !== null && endpoint !== null) {
        clearTimeout(timer);
        resolve({ child, hostId: session[1], hostEndpoint: endpoint[1] });
      }
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`the host exited early with code ${code}:\n${buffered}`));
    });
  });
}

/**
 * The spawned host, tracked so every exit path can kill it.
 *
 * A check that fails part-way must not leave a DSH process running: it holds a
 * session, a socket, and a registry entry, and the next run would find a peer that
 * nothing owns. The first version of this script only killed the host on the happy
 * path, and a crash left one behind.
 */
let host;
const killHost = () => {
  try {
    host?.kill('SIGKILL');
  } catch {
    // Already gone.
  }
};
process.on('exit', killHost);
process.on('uncaughtException', (error) => {
  console.error(`real-model-xproc: uncaught ${error?.stack ?? error}`);
  killHost();
  process.exit(1);
});
process.on('unhandledRejection', (error) => {
  console.error(`real-model-xproc: unhandled rejection ${error?.stack ?? error}`);
  killHost();
  process.exit(1);
});

console.log(`real-model xproc check (run ${RUN}, ${PROVIDER}/${MODEL})`);
const started = await startHost();
host = started.child;
const { hostId, hostEndpoint } = started;
console.log(`  host: ${hostId} on endpoint ${hostEndpoint}`);

const environment = createLaunchEnvironmentSnapshot([
  {
    source: 'process',
    values: Object.fromEntries(Object.entries(process.env).filter(([, value]) => typeof value === 'string')),
  },
]);
const { ctx, shutdown } = await runProfile({
  environment,
  profile: 'web',
  patchFiles: [join(repo, 'web-noserver.patch.yml'), overlay],
  args: ['--no-open'],
});

const agents = ctx.get('agents');
const bus = ctx.get('peerBus');
const presets = ctx.get('agentPresets');
if (agents === undefined || bus === undefined) {
  console.error('real-model-xproc: missing services');
  host.kill('SIGKILL');
  await shutdown?.shutdown?.(1);
  process.exit(1);
}

const seen = new Map();
ctx.on('session/event', (session, event) => {
  const rows = seen.get(session.id) ?? [];
  rows.push(event);
  seen.set(session.id, rows);
});
const eventsOf = (id) => seen.get(id) ?? [];

const presetId = presets === undefined ? undefined : (await presets.resolve()).id;
const guestId = `session-real-xproc-guest-${RUN}`;
const guest = (
  await agents.create({
    sessionId: guestId,
    meta: { cwd: workspace, ...(presetId === undefined ? {} : { agentPreset: presetId }) },
    agentOptions: { provider: PROVIDER, model: MODEL, reasoningEffort: EFFORT },
    setup:
      presetId === undefined
        ? undefined
        : async (agentCtx) => {
            await presets.mount(agentCtx, presetId);
          },
  })
).agent;

// --- 1. discovery across a real process boundary ---------------------------------
const rows = await bus.roster();
const hostRow = rows.find((row) => row.id === hostId);
check("the other process's real session appears in the roster", hostRow !== undefined);
check('it is marked remote rather than stored', hostRow?.host === 'remote', `host=${hostRow?.host}`);

// --- 2. a real model turn in the other process, woken from here ------------------
// The prompt never names a bus tool: the host answers as it would any question, and
// the transport is what carries it back.
const QUESTION = 'Reply with exactly one short sentence: what is 17 multiplied by 3?';
const asked = await bus.asks
  .ask(guest, { target: hostId, text: QUESTION, timeoutMs: 180_000 }, {})
  .catch((error) => error);
check('bus_ask across processes did not fail', !(asked instanceof Error), asked?.message);
check('the question was answered rather than left pending', asked?.status === 'answered', `status=${asked?.status}`);
const answer = String(asked?.text ?? '');
check('the answer came back with content', answer.trim() !== '', JSON.stringify(answer.slice(0, 120)));
check(
  'the answer is the real model\'s arithmetic',
  /51/.test(answer),
  `answer=${JSON.stringify(answer.slice(0, 160))}`,
);
check('the answer carries the turn it came from', Number.isInteger(asked?.turn), `turn=${asked?.turn}`);

// The turn ran in the host, so this process has no events for it at all — which is
// exactly why the answer had to be pushed back rather than read locally.
observe(
  'this process saw none of the host turn\'s events',
  eventsOf(hostId).length === 0,
  `events=${eventsOf(hostId).length}`,
);

// --- 3. the receipt lives in the host --------------------------------------------
const sent = await bus
  .send(guest, { target: hostId, text: 'A second message, no reply needed.' }, {})
  .catch((error) => error);
check('a plain send is forwarded too', sent?.targetState === 'remote', `got ${sent?.targetState ?? sent?.code ?? sent?.message}`);
const receipt = await bus.status(sent.messageId, guestId);
check(
  'the receipt is read back from the process that holds it',
  ['queued', 'claimed', 'received'].includes(receipt.status),
  `status=${receipt.status}`,
);

// Let the host finish that second turn before it is killed, so nothing is torn down
// mid-request.
await sleep(5000);

// --- 4. the peer goes away -------------------------------------------------------
host.kill('SIGKILL');
await new Promise((resolve) => host.once('exit', resolve));
await sleep(300);
const after = await bus.roster();
const afterRow = after.find((row) => row.id === hostId);
check('the killed process is no longer reported as live', afterRow?.host !== 'remote', `host=${afterRow?.host}`);
check('its session is still known from persistence', afterRow !== undefined);

const failed = results.filter((entry) => entry.kind === 'check' && !entry.ok);
const observed = results.filter((entry) => entry.kind === 'observe');
console.log(
  `\nreal-model-xproc: ${results.filter((e) => e.kind === 'check').length - failed.length} checks passed, ` +
    `${failed.length} failed, ${observed.length} observations`,
);
for (const failure of failed) console.error(`  - ${failure.label}`);
await shutdown?.shutdown?.(failed.length === 0 ? 0 : 1);
process.exit(failed.length === 0 ? 0 : 1);
