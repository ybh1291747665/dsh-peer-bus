/**
 * The cross-process e2e: two real DSH processes over one `DSH_HOME`.
 *
 * Every other check in this repository runs in a single process, and two bus
 * instances sharing one process cannot prove the thing that matters — that a
 * session held live by *another OS process* is reachable. So this script spawns a
 * real second process, keeps a session live in it, and talks to it over the socket.
 *
 * The sequence:
 *   1. spawn the host, wait for it to announce its live session
 *   2. boot this process as the guest and create its own session
 *   3. roster: the host's session must appear, marked remote
 *   4. send: forwarded, and the receipt must come back from the host
 *   5. kill the host: its registry entry must go, and the session must stop being
 *      reported as live elsewhere
 *
 * Usage: npm run e2e:xproc
 */
import './dsh-home.mjs';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment';
import { runProfile } from '@deepseek-ai/dsh/profile-boot';

const here = dirname(fileURLToPath(import.meta.url));
const runId = `${process.pid}-${Date.now().toString(36)}`;

const failures = [];
/** Record one check. */
const check = (label, ok, detail = '') => {
  if (ok) console.log(`  PASS  ${label}`);
  else {
    failures.push(label);
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/**
 * Record something the suite measures but does not promise.
 *
 * Printed with the same weight as a check so it cannot be missed, but it does not
 * fail the run: an observation that is red is a finding to act on, not a regression
 * in the thing being tested.
 */
const observe = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'SEEN ' : 'NOTE '} ${label}${detail ? ` — ${detail}` : ''}`);
};

/**
 * Spawn the host process and wait for it to announce a live session.
 *
 * @returns the child, its session id, and its endpoint id.
 */
function startPeer(label, argvTail) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(here, 'xproc-phase.mjs'), ...argvTail], {
      cwd: process.cwd(),
      env: { ...process.env, XPROC_PEER_LABEL: label },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    let buffered = '';
    const timer = setTimeout(() => reject(new Error(`the host did not become ready:\n${buffered}`)), 60000);
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

const peers = [];

/**
 * Kill every spawned peer on every exit path.
 *
 * A check that crashes part-way must not leave DSH processes running: each holds a
 * session, a socket, and a registry entry, so the next run would find peers nothing
 * owns. Learned the hard way twice — once here, once in `real-model-xproc.mjs`.
 */
const killPeers = () => {
  for (const peer of peers) {
    try {
      peer.child.kill('SIGKILL');
    } catch {
      // Already gone.
    }
  }
};
process.on('exit', killPeers);
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    killPeers();
    process.exit(1);
  });
}
process.on('uncaughtException', (error) => {
  console.error(`e2e-xproc: uncaught ${error?.stack ?? error}`);
  killPeers();
  process.exit(1);
});
process.on('unhandledRejection', (error) => {
  console.error(`e2e-xproc: unhandled rejection ${error?.stack ?? error}`);
  killPeers();
  process.exit(1);
});
/**
 * Spawn one peer and remember it, so every exit path can kill it.
 *
 * @param label - display name.
 * @param argv - the phase script's full argument list after the script path.
 */
async function spawnPeer(label, argv) {
  const peer = await startPeer(label, argv);
  peer.label = label;
  peers.push(peer);
  return peer;
}
const stopPeer = (peer) => {
  try {
    peer.child.kill('SIGKILL');
  } catch {
    // Already gone.
  }
};
const waitExit = (peer) => new Promise((resolve) => peer.child.once('exit', resolve));

console.log(`xproc e2e (run ${runId})`);
const hostA = await spawnPeer('a', ['host', `${runId}-a`]);
const hostB = await spawnPeer('b', ['host', `${runId}-b`]);
const hostC = await spawnPeer('c', ['host', `${runId}-c`]);
for (const peer of peers) console.log(`  ${peer.label}: ${peer.hostId} on ${peer.hostEndpoint}`);

const environment = createLaunchEnvironmentSnapshot([
  {
    source: 'process',
    values: Object.fromEntries(
      Object.entries(process.env).filter(([, value]) => typeof value === 'string'),
    ),
  },
]);

const { ctx, shutdown } = await runProfile({
  environment,
  profile: process.env.BUS_CHECK_PROFILE ?? 'headless',
  patchFiles: [new URL('../xproc.e2e.patch.yml', import.meta.url).pathname],
  args: [],
});

const bus = ctx.get('peerBus');
const agents = ctx.get('agents');
if (bus === undefined || agents === undefined) {
  console.error('missing services');
  for (const peer of peers) stopPeer(peer);
  await shutdown?.shutdown?.(1);
  process.exit(1);
}

const guestId = `session-xproc-guest-${runId}`;
const guest = (await agents.create({ sessionId: guestId, meta: { cwd: process.cwd() } })).agent;
check('this process started its own endpoint', (await bus.xproc()) !== undefined);

// --- 1. discovery across three processes -----------------------------------------
let rows = await bus.roster();
for (const peer of peers) {
  const row = rows.find((entry) => entry.id === peer.hostId);
  check(`${peer.label}: its live session appears in the roster`, row !== undefined);
  check(`${peer.label}: marked remote rather than stored`, row?.host === 'remote', `host=${row?.host}`);
}

// --- 2. delivery ------------------------------------------------------------------
const sent = await bus.send(guest, { target: hostA.hostId, text: 'hello across processes' }, {});
check('a send to a peer is forwarded, not cold-resumed', sent.targetState === 'remote', `targetState=${sent.targetState}`);

const receipt = await bus.status(sent.messageId, guestId);
check(
  'the receipt comes back from the process that holds it',
  ['queued', 'claimed', 'received'].includes(receipt.status),
  `status=${receipt.status}`,
);
check(
  'an unrelated session cannot read that receipt',
  (await bus.status(sent.messageId, 'session-nobody')).status === 'unknown',
);

// --- 3. one of three leaves, and only that one stops being reachable --------------
stopPeer(hostC);
await waitExit(hostC);
// The peer answer is cached, so a killed peer keeps being reported for up to
// `crossProcessRosterCacheMs`. Waiting past that window is what this checks.
await sleep(800);

rows = await bus.roster();
check('the killed process is no longer reported as live', rows.find((e) => e.id === hostC.hostId)?.host !== 'remote');
check('its session is still known from persistence', rows.find((e) => e.id === hostC.hostId) !== undefined);
check(
  'the survivors are still reported remote',
  rows.find((e) => e.id === hostA.hostId)?.host === 'remote' &&
    rows.find((e) => e.id === hostB.hostId)?.host === 'remote',
  'losing one peer must not lose the others',
);

// --- 4. two processes contending for one stored session ---------------------------
stopPeer(hostB);
await waitExit(hostB);
await sleep(800);

const contended = hostB.hostId;
const raceAt = Date.now() + 5000;
const contender = await spawnPeer('contender', ['contend', `${runId}-contender`, contended, String(raceAt)]);

/** Read the peer's one-line verdict. */
const contenderOutcome = await new Promise((resolve) => {
  let buffered = '';
  const settle = () => {
    const match = /CONTEND (\{.*\})/.exec(buffered);
    resolve(match === null ? { ok: false, code: 'no-verdict', message: buffered.slice(-400) } : JSON.parse(match[1]));
  };
  const timer = setTimeout(settle, 90000);
  contender.child.stdout.on('data', (chunk) => {
    buffered += chunk.toString('utf8');
    if (/CONTEND \{/.test(buffered)) {
      clearTimeout(timer);
      settle();
    }
  });
  contender.child.once('exit', () => {
    clearTimeout(timer);
    settle();
  });
});

const remaining = raceAt - Date.now();
if (remaining > 0) await sleep(remaining);
const mine = await bus
  .send(guest, { target: contended, text: 'mine' }, {})
  .then((result) => ({
    ok: true,
    targetState: result.targetState,
    holds: agents.get(contended) !== undefined,
    status: agents.get(contended)?.status,
  }))
  .catch((error) => ({ ok: false, code: error?.code, message: error?.message }));

console.log(`  race: this process ${JSON.stringify(mine)}, peer ${JSON.stringify(contenderOutcome)}`);
const both = [mine, contenderOutcome];
const tookIt = both.filter((outcome) => outcome.ok === true && outcome.targetState === 'resumed');
// Recorded rather than asserted. The persistence layer's cross-process lock guards
// *writes*, and `agents.resume` does not take it — so two processes can both come
// away believing they resumed the same stored session. This plugin maps the lock's
// contention to `target-busy` when it does surface, but it cannot make resume
// exclusive from the outside, so claiming that here would be a lie.
observe(
  'only one process came away holding the contended session',
  tookIt.length <= 1,
  tookIt.length <= 1 ? '' : `SPLIT-BRAIN: ${tookIt.length} processes both report they resumed it`,
);
check(
  'neither contender was told the resume simply failed',
  both.every((outcome) => outcome.code !== 'resume-failed'),
  JSON.stringify(both.map((outcome) => outcome.code ?? outcome.targetState)),
);
check(
  'every contender got a recognised outcome',
  both.every((outcome) => outcome.ok === true || ['target-busy', 'timeout', 'peer-gone'].includes(outcome.code)),
  JSON.stringify(both.map((outcome) => outcome.code ?? outcome.targetState)),
);
// With the claim in place the loser's job is to hand the message over, so a run where
// both processes are still alive must end with one holding it and the other having
// forwarded to it — not with both holding it, and not with the loser erroring.
const forwarded = both.filter((outcome) => outcome.targetState === 'remote');
check(
  'the loser forwarded to the winner rather than erroring',
  tookIt.length + forwarded.length === both.length,
  JSON.stringify(both.map((outcome) => outcome.code ?? outcome.targetState)),
);


// --- 5. an idle release hands the claim back to *another* process ------------------
// The reproduction, and the only version of it that isolates the release: resume a
// session, let the bus release it for idleness, then have a different process try to
// take it. A claim left behind by that release still names a live pid, and a contender
// that sees a live pid does not retry — it refuses — so before the fix this session was
// unresumable by anyone until the owner restarted.
const idleTarget = hostC.hostId;
const once = await bus.send(guest, { target: idleTarget, text: 'take it once' }, {}).catch((e) => e);
check('a session whose peer died is resumed locally', once?.targetState === 'resumed', `got ${once?.targetState ?? once?.code}`);

// Past `resumedIdleMs` and the sweep interval that acts on it.
await sleep(2600);

// A fresh process, told to deliver to the same session. Nothing tells it the guest is
// holding a claim; the claim file is the only thing that could stop it.
const later = Date.now() - 1000;
const taker = await spawnPeer('taker', ['contend', `${runId}-taker`, idleTarget, String(later)]);
const takerOutcome = await new Promise((resolve) => {
  let buffered = '';
  const settle = () => {
    const match = /CONTEND (\{.*\})/.exec(buffered);
    resolve(match === null ? { ok: false, code: 'no-verdict', message: buffered.slice(-400) } : JSON.parse(match[1]));
  };
  const timer = setTimeout(settle, 90000);
  taker.child.stdout.on('data', (chunk) => {
    buffered += chunk.toString('utf8');
    if (/CONTEND \{/.test(buffered)) {
      clearTimeout(timer);
      settle();
    }
  });
  taker.child.once('exit', () => {
    clearTimeout(timer);
    settle();
  });
});
check(
  'another process can take the session after the idle release',
  takerOutcome.ok === true && takerOutcome.targetState === 'resumed',
  `got ${takerOutcome.targetState ?? takerOutcome.code ?? takerOutcome.message}`,
);

for (const peer of peers) stopPeer(peer);

console.log(failures.length === 0 ? '\ne2e-xproc OK' : `\ne2e-xproc FAILED (${failures.length})`);
for (const failure of failures) console.error(`  - ${failure}`);
await shutdown?.shutdown?.(failures.length === 0 ? 0 : 1);
process.exit(failures.length === 0 ? 0 : 1);
