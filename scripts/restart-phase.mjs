/**
 * One phase of the cross-restart acceptance test.
 *
 * Phase `seed` boots DSH, has two independent sessions exchange a message, and
 * prints the ids it used. Phase `verify` boots a **fresh process** over the same
 * DSH_HOME and proves the earlier conversation is still in the persisted log and
 * that a stored session can still be woken.
 *
 * Driven by scripts/restart-e2e.mjs, which runs the two phases as separate
 * processes so "restart" means a real process boundary, not a resume in place.
 *
 * Usage: DSH_HOME=<test home> node scripts/restart-phase.mjs <seed|verify> <runId>
 */
// Pin DSH_HOME to the repo test home before the DSH loader reads it.
import "./dsh-home.mjs";
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createLaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment';
import { runProfile } from '@deepseek-ai/dsh/profile-boot';

const run = promisify(execFile);

const PROVIDER = 'stub';
const MODEL = 'stub-model';
const [phase, runId] = process.argv.slice(2);

if (!['seed', 'verify'].includes(phase) || runId === undefined) {
  console.error('usage: node scripts/restart-phase.mjs <seed|verify> <runId>');
  process.exit(2);
}

const aliceId = `session-restart-alice-${runId}`;
const bobId = `session-restart-bob-${runId}`;

/**
 * Scripted adapter: a bus message gets a bus reply back to its sender.
 * No network and no model call, so the test is deterministic and offline.
 */
class StubAdapter extends LlmAdapter {
  constructor(bus, agents) {
    super();
    this.bus = bus;
    this.agents = agents;
  }

  /** Read the inbound bus message out of the assembled request, if any. */
  inbound(options) {
    const messages = options.messages ?? [];
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message.role !== 'user') continue;
      if (message.source?.kind !== 'peer-bus-message') continue;
      return {
        senderSessionId: message.source.senderSessionId,
        text: (message.content ?? [])
          .filter((block) => block.type === 'text')
          .map((block) => block.text)
          .join(''),
      };
    }
    return undefined;
  }

  async *stream(options) {
    const inbound = this.inbound(options);
    let reply = 'ready';
    if (inbound !== undefined) {
      reply = 'ack';
      const self = this.agents.get(options.sessionId);
      if (self !== undefined) {
        await this.bus.send(self, { target: inbound.senderSessionId, text: reply }, {});
      }
    }
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text: reply };
    yield { type: 'block-end', index: 0, block: { type: 'text', text: reply } };
    yield { type: 'finish', reason: 'stop' };
  }
}

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
  patchFiles: [new URL('../bus.e2e.patch.yml', import.meta.url).pathname],
  args: [],
});

const failures = [];
const check = (label, ok, detail = '') => {
  if (ok) console.log(`  PASS  ${label}`);
  else {
    failures.push(label);
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
};

const bus = ctx.get('peerBus');
const agents = ctx.get('agents');
const llm = ctx.get('llm');
const query = ctx.get('sessionQuery');
if (bus === undefined || agents === undefined || llm === undefined) {
  console.error('missing services');
  await shutdown?.shutdown?.(1);
  process.exit(1);
}

/**
 * Read one session's events straight out of its persisted log on disk.
 *
 * This is the durability authority: the log file is what survives the process,
 * whereas `sessionQuery.readSession` can hand back a stale in-process snapshot.
 *
 * @param sessionId - session whose stored log to decode.
 * @returns parsed events, or undefined when no log file exists.
 */
const persisted = async (sessionId) => {
  const root = process.env.DSH_HOME;
  const dir = join(root, 'sessions');
  const buckets = await readdir(dir).catch(() => []);
  for (const bucket of buckets) {
    const file = join(dir, bucket, sessionId, 'session.v4.jsonl.zstd');
    if (!existsSync(file)) continue;
    const { stdout } = await run('zstd', ['-dc', file], { maxBuffer: 64 * 1024 * 1024 });
    return stdout
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line))
      .filter((event) => event.type !== undefined && event.type !== 'session');
  }
  return undefined;
};

/**
 * Wait until one session's persisted log satisfies a predicate, or give up.
 * A single `whenIdle()` can return before a freshly delivered turn starts.
 *
 * @param sessionId - session whose log to poll.
 * @param predicate - receives the decoded events; true ends the wait.
 * @param timeoutMs - give up after this long.
 * @returns the last decoded events, whatever the outcome.
 */
const waitForLog = async (sessionId, predicate, timeoutMs = 8000) => {
  const deadline = Date.now() + timeoutMs;
  let events = await persisted(sessionId);
  while (Date.now() < deadline) {
    if (predicate(events ?? [])) return events;
    await new Promise((resolve) => setTimeout(resolve, 100));
    events = await persisted(sessionId);
  }
  return events;
};

if (phase === 'seed') {
  console.log(`seed: two independent sessions exchange a message (run ${runId})`);
  llm.registerAdapter([PROVIDER], new StubAdapter(bus, agents));

  const alice = (
    await agents.create({
      sessionId: aliceId,
      meta: { cwd: process.cwd() },
      agentOptions: { provider: PROVIDER, model: MODEL },
    })
  ).agent;
  const bob = (
    await agents.create({
      sessionId: bobId,
      meta: { cwd: process.cwd() },
      agentOptions: { provider: PROVIDER, model: MODEL },
    })
  ).agent;

  await bus.send(alice, { target: bob.id, text: 'ping from alice' }, {});

  // Confirm the round trip reached disk before the process exits.
  const creditedTo = (events, sender) =>
    (events ?? []).some(
      (event) =>
        event.type === 'user/message' &&
        event.data?.source?.kind === 'peer-bus-message' &&
        event.data.source.senderSessionId === sender,
    );
  const bobLog = await waitForLog(bobId, (events) => creditedTo(events, aliceId));
  check('bob persisted a message credited to alice', creditedTo(bobLog, aliceId));
  const aliceLog = await waitForLog(aliceId, (events) => creditedTo(events, bobId));
  check('alice persisted the reply credited to bob', creditedTo(aliceLog, bobId));

  // Grant through the human command, so the runtime allowlist has something to
  // carry across the process boundary. The config rule already permits this pair,
  // so only the stored grant itself can prove persistence.
  const commands = ctx.get('commands');
  check('the commands service is mounted', commands !== undefined);
  if (commands !== undefined) {
    const granted = await commands.execute(alice, `/bus allow ${bobId}`, [], new AbortController().signal);
    check(
      'the seed process granted bob access with /bus allow',
      granted?.result?.kind === 'success',
      JSON.stringify(granted?.result),
    );
    check('the grant is held at runtime', bus.allowlist.has(bobId, aliceId));
    // This run's own pair, not the whole set: the shared test home accumulates
    // grants from earlier runs, each with its own run-scoped session ids.
    check(
      'the grant was written through to the storage domain',
      ctx
        .get('storageDomain')
        ?.get('peer_bus_allowlist')
        ?.global.get()
        .grants.some((grant) => grant.from === bobId && grant.to === aliceId) === true,
    );
  }

  console.log(`seed: done, ids ${aliceId} ${bobId}`);
} else {
  console.log(`verify: fresh process over the same DSH_HOME (run ${runId})`);
  // Nothing was created in this process: every id must come from persistence.
  check('neither session is loaded in the fresh process', agents.get(aliceId) === undefined && agents.get(bobId) === undefined);

  // The prior conversation must still be readable from the persisted log.
  const bobLog = await persisted(bobId);
  check(
    'the earlier conversation survived the restart',
    (bobLog ?? []).some(
      (event) =>
        event.type === 'user/message' &&
        event.data?.source?.kind === 'peer-bus-message' &&
        event.data.source.senderSessionId === aliceId,
    ),
    `events=${(bobLog ?? []).length}`,
  );

  // The runtime allowlist is durable. This process never ran `/bus allow`, so the
  // only way the grant can be here is if it was read back from storage.
  await bus.roster();
  check('the allowlist domain opened in the fresh process', bus.allowlist.domain !== undefined);
  check('the runtime grant survived the restart', bus.allowlist.has(bobId, aliceId));
  check(
    'the grant was read back from the storage domain',
    ctx
      .get('storageDomain')
      ?.get('peer_bus_allowlist')
      ?.global.get()
      .grants.some((grant) => grant.from === bobId && grant.to === aliceId) === true,
  );

  // And a stored session must still be wakeable after the restart.
  llm.registerAdapter([PROVIDER], new StubAdapter(bus, agents));
  const alice = agents.get(aliceId);
  // A resumed agent needs its route restated: without agentOptions the loop has
  // no provider/model, so a delivered message produces an empty turn.
  const sender =
    alice ??
    (
      await agents.resume({
        resumeSessionId: aliceId,
        agentOptions: { provider: PROVIDER, model: MODEL },
      })
    ).agent;
  const result = await bus.send(sender, { target: bobId, text: 'ping after restart' }, {});
  check('a stored session was resumed after the restart', result.targetState === 'resumed', result.targetState);
  const revived = agents.get(bobId);
  check('the resumed session is live again', revived !== undefined);
  if (revived !== undefined) {
    const arrived = (events) =>
      events.some(
        (event) =>
          event.type === 'user/message' &&
          event.data?.source?.kind === 'peer-bus-message' &&
          event.data.source.senderSessionId === aliceId &&
          (event.data.content ?? []).some((block) =>
            (block.text ?? '').includes('ping after restart'),
          ),
      );
    // Await quiescence first: the inbox splice and turn/start land immediately,
    // but the transcript `user/message` append follows once the turn runs.
    await revived.whenIdle();
    const after = await waitForLog(bobId, arrived);
    check('the post-restart message landed in the persisted log', arrived(after ?? []));
    check(
      'the resumed session ran a turn after the restart',
      (after ?? []).some((event) => event.type === 'turn/start'),
    );
  }
}

console.log(failures.length === 0 ? `restart-${phase} OK` : `restart-${phase} FAILED (${failures.length})`);
for (const failure of failures) console.error(`  - ${failure}`);
await shutdown?.shutdown?.(failures.length === 0 ? 0 : 1);
process.exit(failures.length === 0 ? 0 : 1);
