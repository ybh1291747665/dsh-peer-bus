/**
 * Real-machine check: does `supersede` actually replace a pending message?
 *
 * The unit tests drive a fake inbox, so all they can assert is the mutation the bus
 * *asks for*. This runs the same request against the real host — a real `Agent`, the
 * real durable inbox from `@deepseek-ai/dsh-agent-loop`, and the real driver — and
 * checks what the host does with it, and where the window to do it even exists.
 *
 * Two scenarios, because they turn out to be different questions:
 *
 *   A. **busy target.** A turn is held open by the scripted adapter, so a delivered
 *      message stays pending for as long as that turn lasts. This is the only state
 *      in which a message can be withdrawn, and the replacement is checked end to
 *      end: the durable `agent/inbox/spliced` event marked `canceled`, the superseded
 *      message never entering the transcript, and its receipt turning `discarded`.
 *
 *   B. **idle target.** `followup()` starts the driver synchronously and the driver
 *      claims its first batch before its first `await` — so a message sent to an idle
 *      target is *already claimed* when `bus.send` returns. The "1 ms" this project
 *      measured is the receipt bookkeeping around that synchronous claim, not a
 *      window to withdraw in. This scenario sends twice back to back and shows there
 *      is nothing left to replace, however fast the second send is.
 *
 * No model calls and no network: the adapter is scripted.
 *
 * Usage: node scripts/supersede-e2e.mjs
 */
// Pin DSH_HOME to the repo test home before the DSH loader reads it.
import './dsh-home.mjs';
import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm';
import { createLaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment';
import { runProfile } from '@deepseek-ai/dsh/profile-boot';

const PROFILE = process.env.BUS_CHECK_PROFILE ?? 'headless';
const PATCHES = (process.env.BUS_CHECK_PATCH ?? '../bus.e2e.patch.yml')
  .split(',')
  .map((entry) => entry.trim())
  .filter((entry) => entry !== '');
const RUN = `${process.pid}-${Date.now().toString(36)}`;
const PROVIDER = 'stub';
const MODEL = 'stub-model';

// Distinct on purpose: `'do not do A'` contains `'do A'`, so a substring check
// would report the correction as the stale instruction having run.
const STALE = 'ALPHA-STALE-INSTRUCTION';
const CORRECTION = 'BETA-CORRECTED-INSTRUCTION';
const IDLE_FIRST = 'GAMMA-IDLE-FIRST';
const IDLE_SECOND = 'DELTA-IDLE-SECOND';

/** Stream chunks for a plain text answer. */
const textChunks = (text) => [
  { type: 'block-start', index: 0, blockType: 'text' },
  { type: 'text-delta', index: 0, text },
  { type: 'block-end', index: 0, block: { type: 'text', text } },
  { type: 'finish', reason: 'stop' },
];

/** Every bus message body in one assembled request, oldest first. */
const inboundTexts = (options) =>
  (options.messages ?? [])
    .filter((message) => message.role === 'user' && message.source?.kind === 'peer-bus-message')
    .map((message) =>
      (message.content ?? [])
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join(''),
    );

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Adapter that serves one session from a script, and records what each model call
 * was actually shown. Recording is the point: "the superseded message never ran" is
 * asserted against the assembled conversation, not against the inbox it left.
 */
class StubAdapter extends LlmAdapter {
  constructor(scripts, calls) {
    super();
    this.scripts = scripts;
    this.calls = calls;
  }

  providerInfo(provider) {
    return { id: provider, name: 'Stub' };
  }

  async *stream(options) {
    const script = this.scripts.get(options.sessionId);
    if (script !== undefined) {
      yield* await script(options);
      return;
    }
    yield* textChunks('ready');
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
  profile: PROFILE,
  patchFiles: PATCHES.map((entry) => new URL(entry, import.meta.url).pathname),
  args: PROFILE === 'web' ? ['--no-open'] : [],
});

const failures = [];
const check = (label, condition, detail = '') => {
  if (condition) {
    console.log(`  PASS  ${label}`);
  } else {
    failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
};
const note = (message) => console.log(`  ....  ${message}`);

/** Per-session stream scripts, keyed by session id. */
const scripts = new Map();
/** What each model call was shown, in order. */
const calls = [];
/** Events observed per session id. */
const seen = new Map();
const eventsOf = (id) => seen.get(id) ?? [];
/** `agent/inbox/claimed` observations, with the wall-clock moment each arrived. */
const claims = [];

const bus = ctx.get('peerBus');
const llm = ctx.get('llm');
const agents = ctx.get('agents');
const tools = ctx.get('tools');
if (bus === undefined || llm === undefined || agents === undefined || tools === undefined) {
  console.error(
    'missing services: bus=%s llm=%s agents=%s tools=%s',
    !!bus,
    !!llm,
    !!agents,
    !!tools,
  );
  await shutdown?.shutdown?.(1);
  process.exit(1);
}

/**
 * Run one bus tool directly, as the loop would, for the given calling agent. The
 * correction in scenario A goes through here rather than through `bus.send`, because
 * the tool argument is the only path a model can actually take and nothing else
 * covers it.
 */
const runTool = (name, args, agent) =>
  tools.get(name, agent).execute(args, {
    agent,
    signal: new AbortController().signal,
    callId: `supersede-${name}-${Math.random().toString(36).slice(2)}`,
    deferContext() {},
    concludeTurn() {},
  });

/** The text a tool result would show the model. */
const renderedText = (name, args, value, agent) =>
  (tools.get(name, agent).output.render(args, value) ?? [])
    .map((block) => block.text ?? '')
    .join('\n');

ctx.on('session/event', (session, event) => {
  const rows = seen.get(session.id) ?? [];
  rows.push(event);
  seen.set(session.id, rows);
});
// Durable events carry the splice; this carries the claim, which is not persisted.
ctx.on('agent/inbox/claimed', (event) => {
  claims.push({ id: event?.message?.id, at: Date.now() });
});

llm.registerAdapter([PROVIDER], new StubAdapter(scripts, calls));

const senderHandle = await agents.create({
  sessionId: `session-supersede-sender-${RUN}`,
  meta: { cwd: process.cwd() },
  agentOptions: { provider: PROVIDER, model: MODEL },
});
const targetHandle = await agents.create({
  sessionId: `session-supersede-target-${RUN}`,
  meta: { cwd: process.cwd() },
  agentOptions: { provider: PROVIDER, model: MODEL },
});
const sender = senderHandle.agent;
const target = targetHandle.agent;

/** The text of every bus message any model call was shown. */
const shown = () => calls.flatMap((call) => call.texts);
/** Ids of bus messages that entered the target's transcript as a real user message. */
const transcriptIds = () =>
  eventsOf(target.id)
    .filter((event) => event.type === 'user/message')
    .map((event) => event.data?.id);

// ---------------------------------------------------------------- scenario A
console.log('scenario A: supersede replaces a pending message on a busy target');

// Hold the target's first turn open. While it is inside this stream the target is
// running, so a `followup` message stays in `next-turn` instead of being claimed.
const gate = Promise.withResolvers();
const entered = Promise.withResolvers();
let holdNext = true;
scripts.set(target.id, async function* (options) {
  calls.push({ sessionId: options.sessionId, texts: inboundTexts(options) });
  if (holdNext) {
    holdNext = false;
    entered.resolve();
    await gate.promise;
  }
  yield* textChunks('ok');
});

target.followup(
  createUserMessage({ content: [{ type: 'text', text: 'hold this turn open' }], source: { kind: 'user' } }),
);
await entered.promise;
check('the target is running a turn, so its inbox cannot claim', target.status === 'running', `status=${target.status}`);

const staleSentAt = Date.now();
const stale = await bus.send(sender, { target: target.id, text: STALE }, {});
check(
  'the first message stays pending while the target is busy',
  stale.replaced === false && stale.pendingFromYou === 1,
  `replaced=${stale.replaced} pendingFromYou=${stale.pendingFromYou}`,
);

// Hold the window open deliberately, then re-read the inbox. Without this the
// replacement below could be dismissed as having won a microsecond race; with it,
// the window is a measured interval the message demonstrably survived.
const HOLD_MS = 150;
await sleep(HOLD_MS);
const heldIds = bus.pendingBusMessages(target, sender.id).map((message) => message.id);
check(
  `the message is still pending ${HOLD_MS} ms later, so the window is open and not a race`,
  heldIds.length === 1 && heldIds[0] === stale.messageId,
  `pending=${JSON.stringify(heldIds)}`,
);

// Through the tool, because the tool argument is the only path a model can take.
const correctionArgs = { target: target.id, text: CORRECTION, supersede: true };
const correctionSentAt = Date.now();
const correction = await runTool('bus_send', correctionArgs, sender);
check(
  'bus_send {supersede: true} reports a replacement against the real inbox',
  correction.replaced === true,
  JSON.stringify(correction),
);
check(
  'the replacement did not deepen the queue',
  correction.pendingFromYou === 1,
  `pendingFromYou=${correction.pendingFromYou}`,
);
check(
  'the result the model reads says the message was replaced',
  renderedText('bus_send', correctionArgs, correction, sender).startsWith(
    'Replaced the previous message with ',
  ),
  renderedText('bus_send', correctionArgs, correction, sender),
);

// Read the real inbox, not the bus's own bookkeeping.
const pendingIds = bus.pendingBusMessages(target, sender.id).map((message) => message.id);
check(
  'the real inbox now holds exactly the correction',
  pendingIds.length === 1 && pendingIds[0] === correction.messageId,
  `pending=${JSON.stringify(pendingIds)}`,
);
check('the superseded message is gone from the real inbox', !pendingIds.includes(stale.messageId));

// The cancellation must be durable, not just an in-memory edit.
const cancelSplice = eventsOf(target.id).filter(
  (event) => event.type === 'agent/inbox/spliced' && event.data?.outcome === 'canceled',
);
check(
  'the session log records the cancellation as a canceled splice',
  cancelSplice.some(
    (event) =>
      event.data.removedCount === 1 &&
      event.data.inserted?.some((message) => message.id === correction.messageId),
  ),
  `${cancelSplice.length} canceled splice(s)`,
);

const staleReceipt = await bus.status(stale.messageId, sender.id);
check(
  'the superseded message is reported discarded, not claimed',
  staleReceipt.status === 'discarded',
  `status=${staleReceipt.status}`,
);

// Release the held turn: the target must run the correction and nothing else.
const gateAt = Date.now();
gate.resolve();
await target.whenIdle();

const correctionClaim = claims.find((claim) => claim.id === correction.messageId);
check(
  'the correction waited in the queue until the turn ended, then was claimed',
  correctionClaim !== undefined && correctionClaim.at >= gateAt,
  correctionClaim === undefined
    ? 'no claim event observed'
    : `claimedAt=${new Date(correctionClaim.at).toISOString()} releasedAt=${new Date(gateAt).toISOString()}`,
);
if (correctionClaim !== undefined) {
  note(
    `the window this scenario used: the correction sat pending ${correctionClaim.at - correctionSentAt} ms ` +
      `(the stale message ${gateAt - staleSentAt} ms) before a turn claimed it`,
  );
}
check('the target never saw the superseded instruction', !shown().some((text) => text.includes(STALE)));
check(
  'the target ran the correction exactly once',
  shown().filter((text) => text.includes(CORRECTION)).length === 1,
  `saw ${shown().filter((text) => text.includes(CORRECTION)).length}`,
);
check('the superseded message never entered the transcript', !transcriptIds().includes(stale.messageId));
check('the correction entered the transcript', transcriptIds().includes(correction.messageId));
check(
  'the superseded message was never claimed by any turn',
  !claims.some((claim) => claim.id === stale.messageId),
  `${claims.length} claim(s) observed`,
);
const correctionReceipt = await bus.status(correction.messageId, sender.id);
check(
  'the correction was claimed by a real turn',
  correctionReceipt.status === 'claimed' && Number.isInteger(correctionReceipt.turn),
  `status=${correctionReceipt.status} turn=${correctionReceipt.turn}`,
);
if (Number.isInteger(correctionReceipt.turn)) {
  note(`the correction ran in turn ${correctionReceipt.turn}; the superseded message ran in no turn at all`);
}

// ---------------------------------------------------------------- scenario B
console.log('\nscenario B: on an idle target there is no window to replace in');
check(
  'claims are observable at the context, so this measurement is direct',
  claims.length > 0,
  `${claims.length} claim event(s)`,
);

const IDLE_ROUNDS = 3;
let idleReplaced = 0;
const idleLatencies = [];
for (let round = 1; round <= IDLE_ROUNDS; round += 1) {
  await target.whenIdle();
  const before = Date.now();
  const first = await bus.send(sender, { target: target.id, text: `${IDLE_FIRST}-${round}` }, {});
  const after = Date.now();
  // Back to back, with no model round trip and nothing but an await in between.
  const gap = Date.now() - after;
  const second = await bus.send(
    sender,
    { target: target.id, text: `${IDLE_SECOND}-${round}`, supersede: true },
    {},
  );
  if (second.replaced) idleReplaced += 1;

  const receipt = await bus.status(first.messageId, sender.id);
  const settled = Date.parse(receipt.settledAt);
  idleLatencies.push(receipt.latencyMs);
  const claim = claims.find((entry) => entry.id === first.messageId);
  console.log(
    `  round ${round}: sent, claimed, then superseded ${gap} ms later — ` +
      `receipt latency ${receipt.latencyMs} ms, replaced=${second.replaced}`,
  );
  check(
    `round ${round}: the idle target claimed it inside the send call, so there was nothing to replace`,
    receipt.status === 'claimed' && settled <= after && second.replaced === false,
    `status=${receipt.status} settledAt=${receipt.settledAt} returnedAt=${new Date(after).toISOString()} replaced=${second.replaced}`,
  );
  check(
    `round ${round}: the claim arrived before the send returned`,
    claim !== undefined && claim.at <= after,
    claim === undefined ? 'no claim event observed' : `claimedAt=${new Date(claim.at).toISOString()}`,
  );
  check(
    `round ${round}: the correction was queued as its own turn instead`,
    second.replaced === false && second.pendingFromYou === 1,
    `replaced=${second.replaced} pendingFromYou=${second.pendingFromYou}`,
  );
  await target.whenIdle();
}

note(`supersede replaced ${idleReplaced}/${IDLE_ROUNDS} idle-target sends`);
note(`measured receipt latency on an idle target: ${idleLatencies.join(', ')} ms`);check(
  'a message already claimed cannot be replaced, so both ran',
  idleReplaced === 0 &&
    shown().some((text) => text.includes(`${IDLE_FIRST}-1`)) &&
    shown().some((text) => text.includes(`${IDLE_SECOND}-1`)),
  `replaced=${idleReplaced}`,
);

// ---------------------------------------------------------------- cleanup
const root = process.env.DSH_HOME;
let cleaned = 0;
if (root !== undefined) {
  const sessionsDir = join(root, 'sessions');
  for (const bucket of await readdir(sessionsDir).catch(() => [])) {
    for (const sessionId of await readdir(join(sessionsDir, bucket)).catch(() => [])) {
      if (!sessionId.includes(RUN)) continue;
      await rm(join(sessionsDir, bucket, sessionId), { recursive: true, force: true }).catch(() => {});
      cleaned += 1;
    }
  }
  const cacheDir = join(root, 'storages', 'session_projcache', 'sessions');
  for (const cached of await readdir(cacheDir).catch(() => [])) {
    if (!cached.includes(RUN)) continue;
    await rm(join(cacheDir, cached), { force: true }).catch(() => {});
  }
}

console.log(failures.length === 0 ? '\nsupersede-e2e OK' : `\nsupersede-e2e FAILED (${failures.length})`);
if (cleaned > 0) console.log(`  cleaned ${cleaned} session(s) created by this run`);
for (const failure of failures) console.error(`  - ${failure}`);
await shutdown?.shutdown?.(failures.length === 0 ? 0 : 1);
process.exit(failures.length === 0 ? 0 : 1);
