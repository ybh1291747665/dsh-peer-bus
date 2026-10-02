/**
 * Integration test: two independent (non-parent/child) sessions hold a
 * conversation through the bus, driven by a scripted stub LLM adapter.
 *
 * What this proves that the unit tests cannot:
 *   - the message reaches the target's real session log with `peer-bus-message`
 *     attribution to the true sender;
 *   - an idle target is actually woken and runs a turn;
 *   - a stored, unloaded target is cold-resumed and then runs a turn, and is
 *     resumed again (not served from a stale cache) after it is unloaded;
 *   - `bus_wait`, called by the model inside a real turn, takes a delivery that
 *     arrives mid-wait or earlier in that turn, without hanging the turn and
 *     without the message also running as its own turn;
 *   - the `sameWorkspace` rule refuses a subagent child that shares the workspace;
 *   - the whole round trip survives with no model calls and no network.
 *
 * Usage: DSH_HOME=<workspace>/.dsh-test node scripts/e2e-bus.mjs
 */
// Pin DSH_HOME to the repo test home before the DSH loader reads it.
import "./dsh-home.mjs";
import { readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm';
import { createLaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment';
import { runProfile } from '@deepseek-ai/dsh/profile-boot';

const PROFILE = process.env.BUS_CHECK_PROFILE ?? 'headless';
// Overlays, comma-separated, applied in order. Defaults to the e2e overlay alone;
// running on the `web` profile appends `../web-noserver.patch.yml` so the check
// does not bind the port a running DSH already holds.
const PATCHES = (process.env.BUS_CHECK_PATCH ?? '../bus.e2e.patch.yml')
  .split(',')
  .map((entry) => entry.trim())
  .filter((entry) => entry !== '');
// Per-run suffix: sessions persist to disk, so a fixed id would collide on a
// second run. The overlay's allowlist matches this prefix instead of exact ids.
const RUN = `${process.pid}-${Date.now().toString(36)}`;
// A workspace that is NOT the package directory, for the deny probe.
const OTHER_WORKSPACE = tmpdir();
const PROVIDER = 'stub';
const MODEL = 'stub-model';

/** Stream chunks for a plain text answer. */
const textChunks = (text) => [
  { type: 'block-start', index: 0, blockType: 'text' },
  { type: 'text-delta', index: 0, text },
  { type: 'block-end', index: 0, block: { type: 'text', text } },
  { type: 'finish', reason: 'stop' },
];

/** Stream chunks for one model-issued tool call. */
const toolCallChunks = (id, name, args) => {
  const json = JSON.stringify(args);
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: json },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: json } },
    { type: 'finish', reason: 'tool-calls' },
  ];
};

/** Whether the request already carries the result of one tool call. */
const hasToolResult = (options, callId) =>
  (options.messages ?? []).some((message) => message.role === 'tool' && message.toolCallId === callId);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Poll a predicate until it holds, or give up after `ms`. */
async function waitUntil(predicate, ms = 15000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(50);
  }
  return predicate();
}

/**
 * Scripted adapter. It inspects the assembled conversation and answers:
 * a bus message gets a bus reply back to its sender; anything else is acknowledged.
 * A session with an entry in `scripts` is driven by that script instead.
 */
class StubAdapter extends LlmAdapter {
  constructor(bus, agents, replies, scripts) {
    super();
    this.bus = bus;
    this.agents = agents;
    this.replies = replies;
    this.scripts = scripts;
  }

  providerInfo(provider) {
    return { id: provider, name: 'Stub' };
  }

  /** Read the bus message out of the request, if this turn was woken by one. */
  inbound(options) {
    const messages = options.messages ?? [];
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message.role !== 'user') continue;
      if (message.source?.kind !== 'peer-bus-message') continue;
      const text = (message.content ?? [])
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('');
      return { senderSessionId: message.source.senderSessionId, text };
    }
    return undefined;
  }

  async *stream(options) {
    const script = this.scripts.get(options.sessionId);
    if (script !== undefined) {
      yield* await script(options);
      return;
    }
    const inbound = this.inbound(options);
    let reply;
    if (inbound !== undefined) {
      // Reply through the bus, which is the behaviour under test.
      const to = inbound.senderSessionId;
      reply = `ack from ${options.sessionId ?? 'target'}`;
      try {
        const self = this.agents.get(options.sessionId);
        if (self === undefined) throw new Error(`no live agent for ${options.sessionId}`);
        await this.bus.send(self, { target: to, text: reply }, {});
        this.replies.push({ from: options.sessionId, to, reply });
      } catch (error) {
        this.replies.push({ from: options.sessionId, to, error: error.code ?? error.message });
      }
    } else {
      reply = 'ready';
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

const replies = [];
/** Per-session stream scripts, keyed by session id. */
const scripts = new Map();
/** Events observed per session id, via the same seam bus_wait listens on. */
const seen = new Map();
const eventsOf = (id) => seen.get(id) ?? [];
const bus = ctx.get('peerBus');
const llm = ctx.get('llm');
const agents = ctx.get('agents');

if (bus === undefined || llm === undefined || agents === undefined) {
  console.error('missing services: bus=%s llm=%s agents=%s', !!bus, !!llm, !!agents);
  await shutdown?.shutdown?.(1);
  process.exit(1);
}

ctx.on('session/event', (session, event) => {
  const rows = seen.get(session.id) ?? [];
  rows.push(event);
  seen.set(session.id, rows);
});

// Contained observer failures are only logged, so capture them: a listener that
// appends while an append is publishing fails silently this way.
const warnings = [];
for (const logger of new Set([ctx.logger, ctx.get('sessions')?.ctx?.logger].filter(Boolean))) {
  const warn = logger.warn.bind(logger);
  logger.warn = (...args) => {
    warnings.push(args.map(String).join(' '));
    return warn(...args);
  };
}

llm.registerAdapter([PROVIDER], new StubAdapter(bus, agents, replies, scripts));

// Three root agents with no parent/child relationship between any of them.
const aliceHandle = await agents.create({
  sessionId: `session-e2e-alice-${RUN}`,
  meta: { cwd: process.cwd() },
  agentOptions: { provider: PROVIDER, model: MODEL },
});
const bobHandle = await agents.create({
  sessionId: `session-e2e-bob-${RUN}`,
  meta: { cwd: process.cwd() },
  agentOptions: { provider: PROVIDER, model: MODEL },
});
// carol is the deny probe: she lives in a DIFFERENT workspace, so the single
// `sameWorkspace` rule that grants the conversation above must refuse her.
const carolHandle = await agents.create({
  sessionId: `session-e2e-carol-${RUN}`,
  meta: { cwd: OTHER_WORKSPACE },
  agentOptions: { provider: PROVIDER, model: MODEL },
});

const alice = aliceHandle.agent;
const bob = bobHandle.agent;
const carol = carolHandle.agent;

// The package's ./invariant companion must have activated. `register` reserves the
// package name and throws on a duplicate, so a second registration of our own name
// is direct evidence the companion is live (and it throws before any state change).
const invariants = ctx.get('invariants');
let companionLive = false;
if (invariants !== undefined) {
  try {
    invariants.register('dsh-peer-bus', () => {});
  } catch (error) {
    companionLive = /already registered/.test(String(error?.message));
  }
}
check('the ./invariant companion registered with the invariant service', companionLive);

console.log('scenario: two independent sessions exchange a message');
check('alice and bob are unrelated roots', alice.session.header.parentSession === undefined && bob.session.header.parentSession === undefined);

// Allow the pair only, then deliver.
const result = await bus.send(
  alice,
  { target: bob.id, text: 'ping from alice' },
  {},
);
check('bus.send delivered to bob', result.target === bob.id && result.targetState === 'live');

// The delivered message must be in bob's own log, credited to alice.
const delivered = eventsOf(bob.id).filter(
  (event) =>
    event.type === 'agent/inbox/spliced' &&
    event.data?.inserted?.some((message) => message.source?.kind === 'peer-bus-message'),
);
check('bob logged the message with peer-bus-message attribution', delivered.length >= 1);
check(
  'the log credits alice as the sender',
  delivered.some((event) =>
    event.data.inserted.some((message) => message.source.senderSessionId === alice.id),
  ),
);

// Bob must have actually run, and replied back through the bus.
await bob.whenIdle();
const bobRan = eventsOf(bob.id).some((event) => event.type === 'turn/start');
check('bob ran a turn from the delivered message', bobRan);

await alice.whenIdle();
const aliceInbound = eventsOf(alice.id).filter(
  (event) =>
    event.type === 'agent/inbox/spliced' &&
    event.data?.inserted?.some((message) => message.source?.kind === 'peer-bus-message'),
);
check(
  'alice received bob\'s reply with attribution',
  aliceInbound.some((event) =>
    event.data.inserted.some((message) => message.source.senderSessionId === bob.id),
  ),
  JSON.stringify(replies),
);

// Default-deny must still hold for a target with no allow rule.
let deniedCode;
try {
  await bus.send(alice, { target: carol.id, text: 'should be denied' }, {});
} catch (error) {
  deniedCode = error.code;
}
check(
  'the sameWorkspace rule refuses a session in another workspace',
  deniedCode === 'denied',
  `got ${deniedCode}`,
);

console.log('\nscenario: the roster and sameWorkspace rule treat a subagent child as untrusted');
// A child inherits its parent's cwd; build one the way dsh-subagent stamps it.
const childHandle = await agents.create({
  sessionId: `session-e2e-child-${RUN}`,
  meta: { cwd: process.cwd(), origin: 'subagent', parentSession: alice.id, delegationDepth: 1 },
  agentOptions: { provider: PROVIDER, model: MODEL },
});
const child = childHandle.agent;
let childCode;
try {
  await bus.send(child, { target: alice.id, text: 'instructions from untrusted input' }, {});
} catch (error) {
  childCode = error.code;
}
check('a same-workspace subagent child is denied by the sameWorkspace rule', childCode === 'denied', `got ${childCode}`);
const visible = (await bus.visibleRoster(alice)).map((row) => row.id);
check(
  'alice\'s roster shows peers but not the other workspace or the subagent',
  visible.includes(alice.id) && visible.includes(bob.id) && !visible.includes(carol.id) && !visible.includes(child.id),
  JSON.stringify(visible),
);
await childHandle.dispose();

/** Wait for one session's tool/call event, or give up. */
async function toolCallSeen(sessionId, callId, ms = 5000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (eventsOf(sessionId).some((event) => event.type === 'tool/call' && event.data?.callId === callId)) return true;
    await sleep(10);
  }
  return false;
}

/** Resolve true once the agent is idle, false if it stays busy past `ms`. */
const idleWithin = (agent, ms) =>
  Promise.race([agent.whenIdle().then(() => true), sleep(ms).then(() => false)]);

/** The bus_wait tool result recorded in a session log, as text. */
const toolResultText = (sessionId, callId) =>
  eventsOf(sessionId)
    .filter((event) => event.type === 'tool/result' && event.data?.message?.toolCallId === callId)
    .map((event) => JSON.stringify(event.data.message.content))
    .join('');

/** Bus deliveries that reached a session's transcript as their own user message. */
const transcriptDeliveries = (sessionId, text) =>
  eventsOf(sessionId).filter(
    (event) =>
      event.type === 'user/message' &&
      event.data?.source?.kind === 'peer-bus-message' &&
      JSON.stringify(event.data.content).includes(text),
  );

const userPrompt = (text) => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } });

console.log('\nscenario: bus_wait inside a real turn takes a delivery that arrives mid-wait');
{
  const erinHandle = await agents.create({
    sessionId: `session-e2e-erin-${RUN}`,
    meta: { cwd: process.cwd() },
    agentOptions: { provider: PROVIDER, model: MODEL },
  });
  const erin = erinHandle.agent;
  const callId = `call-wait-mid-${RUN}`;
  scripts.set(erin.id, (options) =>
    hasToolResult(options, callId)
      ? textChunks('done waiting')
      : toolCallChunks(callId, 'bus_wait', { from: alice.id, timeoutMs: 8000 }),
  );
  erin.followup(userPrompt('wait for alice'));
  check('erin\'s model called bus_wait inside a turn', await toolCallSeen(erin.id, callId));
  // Give the tool body time to subscribe, so the delivery is a genuine mid-wait arrival.
  await sleep(150);
  const warningsBefore = warnings.length;
  await bus.send(alice, { target: erin.id, text: 'mid-wait hello' }, {});

  check('the waiting turn completed instead of hanging', await idleWithin(erin, 10000));
  check(
    'bus_wait returned the mid-wait message',
    /mid-wait hello/.test(toolResultText(erin.id, callId)),
    toolResultText(erin.id, callId),
  );
  check(
    'bus_wait stripped the transcript attribution prefix',
    !/sent a message/.test(toolResultText(erin.id, callId)),
  );
  check(
    'the message was consumed, not also run as its own turn',
    transcriptDeliveries(erin.id, 'mid-wait hello').length === 0,
  );
  check(
    'no observer failed while the delivery was published',
    !warnings.slice(warningsBefore).some((line) => /cannot reenter/.test(line)),
    warnings.slice(warningsBefore).join(' | '),
  );
  await erinHandle.dispose();
}

console.log('\nscenario: bus_wait inside a real turn takes a delivery that arrived earlier in that turn');
{
  const fionaHandle = await agents.create({
    sessionId: `session-e2e-fiona-${RUN}`,
    meta: { cwd: process.cwd() },
    agentOptions: { provider: PROVIDER, model: MODEL },
  });
  const fiona = fionaHandle.agent;
  const callId = `call-wait-early-${RUN}`;
  let sentEarly = false;
  scripts.set(fiona.id, async (options) => {
    if (hasToolResult(options, callId)) return textChunks('done');
    // fiona is mid-turn, so this parks in her inbox before bus_wait runs. Once
    // only: DSH's session-title plugin also calls the model for a first prompt,
    // and a second send would (correctly) run as its own turn.
    if (!sentEarly) {
      sentEarly = true;
      await bus.send(alice, { target: fiona.id, text: 'early hello' }, {});
    }
    return toolCallChunks(callId, 'bus_wait', { from: alice.id, timeoutMs: 8000 });
  });
  fiona.followup(userPrompt('check for alice'));

  check('the turn completed', await idleWithin(fiona, 10000));
  check(
    'bus_wait returned the message that was already pending',
    /early hello/.test(toolResultText(fiona.id, callId)),
    toolResultText(fiona.id, callId),
  );
  check(
    'the pending message did not also run as its own turn',
    transcriptDeliveries(fiona.id, 'early hello').length === 0,
  );
  await fionaHandle.dispose();
}

console.log('\nscenario: a stored, unloaded session is cold-resumed and woken');
const daveHandle = await agents.create({
  sessionId: `session-e2e-dave-${RUN}`,
  meta: { cwd: process.cwd() },
  agentOptions: { provider: PROVIDER, model: MODEL },
});
const daveId = daveHandle.agent.id;
// Persist something so the session has a durable log, then unload the agent.
await daveHandle.agent.whenIdle();
await daveHandle.dispose();
check('dave is unloaded from the registry', agents.get(daveId) === undefined);

const coldResult = await bus.send(alice, { target: daveId, text: 'wake up' }, {});
check('the bus resumed the unloaded session', coldResult.targetState === 'resumed', coldResult.targetState);

const revived = agents.get(daveId);
check('the resumed session is live again', revived !== undefined);
if (revived !== undefined) {
  await revived.whenIdle();
  const wokeByBus = eventsOf(daveId).some(
    (event) =>
      event.type === 'agent/inbox/spliced' &&
      event.data?.inserted?.some((message) => message.source?.kind === 'peer-bus-message'),
  );
  check('the resumed session received the bus message', wokeByBus);
  check(
    'the resumed session ran a turn',
    eventsOf(daveId).some((event) => event.type === 'turn/start'),
  );

  console.log('\nscenario: a resumed session that is unloaded again is re-resumed, not served stale');
  // Which half of this scenario applies depends on the resume path. The manual
  // path hands this plugin the handle, so the plugin can unload the session and
  // has to prove it re-resumes rather than serving a stale cache. The host path
  // deliberately holds nothing — that is what delegating the resume buys — so
  // there is nothing to unload here and the freshness property belongs to the
  // host's lookup, which re-resolves on every call.
  const ownedDave = bus.owned.get(daveId);
  if (ownedDave === undefined) {
    check('the host resume path left dave host-owned, with no handle held here', bus.owned.has(daveId) === false);
    check('dave is still live under the host', agents.get(daveId) !== undefined);
  } else {
    await ownedDave.dispose();
    check('dave is unloaded again', agents.get(daveId) === undefined);
    const again = await bus.send(alice, { target: daveId, text: 'wake up again' }, {});
    const revivedAgain = agents.get(daveId);
    check('the second send resumed dave', again.targetState === 'resumed' && revivedAgain !== undefined);
    if (revivedAgain !== undefined) {
      await revivedAgain.whenIdle();
      check(
        'the second message reached the live session log',
        eventsOf(daveId).some(
          (event) =>
            event.type === 'agent/inbox/spliced' &&
            event.data?.inserted?.some((message) => JSON.stringify(message.content).includes('wake up again')),
        ),
      );
    }
  }
}

console.log('\nscenario: cold resume restores the preset a session was composed with');
// DSH's own resume installs the model selection AND mounts the preset. A resumed
// agent without its preset runs on the wrong system prompt and a reduced toolset,
// silently, because the turn still completes. The overlay declares two presets and
// neither is named here, so falling back to the default would be visible.
const presets = ctx.get('agentPresets');
check('the preset registry is mounted', presets !== undefined);
if (presets !== undefined) {
  const probeHandle = await agents.create({
    sessionId: `session-e2e-preset-${RUN}`,
    meta: { cwd: process.cwd(), agentPreset: 'e2e-probe' },
    agentOptions: { provider: PROVIDER, model: MODEL },
  });
  const probeId = probeHandle.agent.id;
  // `agents.create()` is the low-level registry call: it bypasses the session
  // controller's `composeAgent`, so it records the preset in the header but mounts
  // nothing. That makes the before/after below a real test of the resume path —
  // undefined before, the recorded preset after.
  check(
    'the probe session recorded its preset in the header',
    probeHandle.agent.session.header.agentPreset === 'e2e-probe',
    String(probeHandle.agent.session.header.agentPreset),
  );
  check(
    'a directly created session has no preset mounted yet',
    presets.composedPreset(probeHandle.agent.ctx) === undefined,
    String(presets.composedPreset(probeHandle.agent.ctx)),
  );

  await probeHandle.agent.whenIdle();
  await probeHandle.dispose();
  check('the probe session is unloaded', agents.get(probeId) === undefined);

  const presetCold = await bus.send(alice, { target: probeId, text: 'wake the probe' }, {});
  check('the bus resumed the probe session', presetCold.targetState === 'resumed', presetCold.targetState);
  const probeRevived = agents.get(probeId);
  check('the probe session is live again', probeRevived !== undefined);
  if (probeRevived !== undefined) {
    const restored = presets.composedPreset(probeRevived.ctx);
    check(
      'cold resume mounted the RECORDED preset, not the default',
      restored === 'e2e-probe',
      `got ${String(restored)}`,
    );
    await probeRevived.whenIdle();
  }
}

console.log('\nscenario: bus_ask returns the answer in the caller\'s tool result');
// Two real turns, driven by the model: the asker calls bus_ask, and the target's
// own turn is what answers it. Both roles are FRESH sessions: reusing one from an
// earlier scenario means a turn still queued there would run the script installed
// here and ask first, which is exactly the cycle this scenario is trying to prove
// is refused — for the wrong reason.
const ivyHandle = await agents.create({
  sessionId: `session-e2e-ivy-${RUN}`,
  meta: { cwd: process.cwd() },
  agentOptions: { provider: PROVIDER, model: MODEL },
});
const milesHandle = await agents.create({
  sessionId: `session-e2e-miles-${RUN}`,
  meta: { cwd: process.cwd() },
  agentOptions: { provider: PROVIDER, model: MODEL },
});
const ivy = ivyHandle.agent;
const miles = milesHandle.agent;
const askCallId = `call-ask-${RUN}`;
const cycleCallId = `call-ask-cycle-${RUN}`;

// Both scripts are one-shot: DSH's session-title plugin also calls the model for
// a first prompt, and a second emission of the same tool call would ask twice.
let ivyAsked = false;
scripts.set(ivy.id, (options) => {
  if (hasToolResult(options, askCallId) || ivyAsked) return textChunks('ivy is done');
  ivyAsked = true;
  return toolCallChunks(askCallId, 'bus_ask', {
    target: miles.id,
    text: 'what is your status?',
    timeoutMs: 20000,
  });
});
// miles answers by trying to ask straight back, which is the mutual case: ivy is
// blocked inside its own bus_ask, so miles's ask must be refused as a cycle rather
// than deadlock both turns until their timeouts.
let milesAsked = false;
scripts.set(miles.id, (options) => {
  if (hasToolResult(options, cycleCallId) || milesAsked) return textChunks('miles could not ask back');
  milesAsked = true;
  return toolCallChunks(cycleCallId, 'bus_ask', { target: ivy.id, text: 'and yours?', timeoutMs: 5000 });
});
ivy.followup(userPrompt('ask miles what is going on'));

check('ivy\'s model called bus_ask inside a turn', await toolCallSeen(ivy.id, askCallId));
check('the asking turn completed instead of hanging', await idleWithin(ivy, 20000));
const askResult = toolResultText(ivy.id, askCallId);
check('bus_ask returned the answer in the tool result', /miles could not ask back/.test(askResult), askResult);
check(
  'the answer is attributed to the session that was asked',
  /Answer from session-e2e-miles-/.test(askResult),
  askResult,
);
check(
  'the question was delivered carrying its own ask id',
  eventsOf(miles.id).some(
    (event) =>
      event.type === 'agent/inbox/spliced' &&
      event.data?.inserted?.some(
        (message) =>
          message.source?.kind === 'peer-bus-message' && typeof message.source.askId === 'string',
      ),
  ),
);
check(
  'the mutual ask was refused as a cycle inside a real turn',
  /ask-cycle/.test(toolResultText(miles.id, cycleCallId)),
  toolResultText(miles.id, cycleCallId),
);
await ivyHandle.dispose();
await milesHandle.dispose();

console.log('\nscenario: a busy target turns bus_ask into a pending ask answered later');
{
  // jane is deliberately occupied, so the question cannot start its own turn
  // until she finishes. The overlay sets askBusyTimeoutMs to 300ms, so the ask
  // hands back `pending` instead of holding kate's turn open.
  const janeHandle = await agents.create({
    sessionId: `session-e2e-jane-${RUN}`,
    meta: { cwd: process.cwd() },
    agentOptions: { provider: PROVIDER, model: MODEL },
  });
  const jane = janeHandle.agent;
  let janeTurns = 0;
  scripts.set(jane.id, async () => {
    janeTurns += 1;
    // Slow only on the turn that is already running when kate asks; the queued
    // question is the next turn and must answer promptly.
    if (janeTurns === 1) {
      await sleep(1500);
      return textChunks('jane was busy');
    }
    return textChunks('jane is free now');
  });
  jane.followup(userPrompt('do something slow'));

  const kateHandle = await agents.create({
    sessionId: `session-e2e-kate-${RUN}`,
    meta: { cwd: process.cwd() },
    agentOptions: { provider: PROVIDER, model: MODEL },
  });
  const kate = kateHandle.agent;
  const busyAskCallId = `call-ask-busy-${RUN}`;
  let kateAsked = false;
  scripts.set(kate.id, (options) => {
    if (hasToolResult(options, busyAskCallId) || kateAsked) return textChunks('kate moved on');
    kateAsked = true;
    return toolCallChunks(busyAskCallId, 'bus_ask', { target: jane.id, text: 'are you free?' });
  });

  // Only ask once jane is genuinely mid-turn.
  check('jane is running before the ask', jane.status !== 'idle', jane.status);
  kate.followup(userPrompt('ask jane if she is free'));
  check('kate\'s model called bus_ask while jane was busy', await toolCallSeen(kate.id, busyAskCallId));
  check('the asking turn completed instead of waiting jane out', await idleWithin(kate, 20000));

  const busyResult = toolResultText(kate.id, busyAskCallId);
  check(
    'bus_ask reported a pending ask instead of an answer',
    /No answer from session-e2e-jane-/.test(busyResult) && /is still open/.test(busyResult),
    busyResult,
  );
  const pendingAskId = /Ask (ask-[^ ]+) is still open/.exec(busyResult)?.[1];
  check('the pending result carries an ask id', typeof pendingAskId === 'string', busyResult);

  // jane finishes her slow turn, then runs the question's turn and answers it.
  const lateArrived = () =>
    eventsOf(kate.id).some(
      (event) =>
        event.type === 'agent/inbox/spliced' &&
        event.data?.inserted?.some(
          (message) =>
            message.source?.kind === 'peer-bus-message' && message.source.askId === pendingAskId,
        ),
    );
  await waitUntil(lateArrived);
  const late = eventsOf(kate.id).filter(
    (event) =>
      event.type === 'agent/inbox/spliced' &&
      event.data?.inserted?.some(
        (message) =>
          message.source?.kind === 'peer-bus-message' && message.source.askId === pendingAskId,
      ),
  );
  check('the late answer reached kate as a bus message tagged with the ask id', late.length >= 1);
  check(
    'the late answer carries jane\'s own words',
    JSON.stringify(late).includes('jane'),
    JSON.stringify(late).slice(0, 200),
  );
  await kateHandle.dispose();
  await janeHandle.dispose();
}

console.log('\nscenario: a session title works as a target');
// Titles are an auxiliary address: ids stay canonical, and the roster is where a
// caller learns the title to use. A fresh session keeps this off the alice/bob
// pair's rate budget, which earlier scenarios have already spent.
const titles = ctx.get('sessionTitle');
check('the session title service is mounted', titles !== undefined);
if (titles !== undefined) {
  const noahHandle = await agents.create({
    sessionId: `session-e2e-noah-${RUN}`,
    meta: { cwd: process.cwd() },
    agentOptions: { provider: PROVIDER, model: MODEL },
  });
  const noah = noahHandle.agent;
  titles.rename(noah.session, 'E2E Deploy Runbook');

  const titled = (await bus.roster()).find((row) => row.id === noah.id);
  check('the roster carries the live title', titled?.title === 'E2E Deploy Runbook', String(titled?.title));
  check(
    'a unique title resolves to its session id',
    (await bus.resolve('E2E Deploy Runbook')) === noah.id,
  );
  const titledSend = await bus.send(alice, { target: 'E2E Deploy Runbook', text: 'titled delivery' }, {});
  check('bus.send accepts a title as its target', titledSend.target === noah.id, JSON.stringify(titledSend));
  // A stored session reports no title rather than forcing a log read per row.
  check(
    'a stored row carries no title',
    (await bus.roster()).every((row) => row.live === true || row.title === undefined),
  );
  await noahHandle.dispose();
}

console.log('\nscenario: /bus edits the allowlist without a config edit');
// The deny probe lives in another workspace, so the overlay's single
// `sameWorkspace` rule refuses her. Only a runtime grant can change that, which
// makes her the honest subject for this scenario.
const commands = ctx.get('commands');
check('the commands service is mounted', commands !== undefined);
if (commands !== undefined) {
  check(
    '/bus is registered as a command for a session',
    commands.list(alice).some((command) => command.name === 'bus'),
    JSON.stringify(commands.list(alice).map((command) => command.name)),
  );

  const beforeGrant = await bus
    .send(alice, { target: carol.id, text: 'must be refused' }, {})
    .catch((error) => error.code);
  check('alice cannot message the other-workspace session yet', beforeGrant === 'denied', `got ${beforeGrant}`);

  // Count every command execution, so "a bus message is not a command" can be
  // asserted directly rather than inferred from the absence of an effect.
  let executions = 0;
  const executeCommand = commands.execute.bind(commands);
  commands.execute = (...args) => {
    executions += 1;
    return executeCommand(...args);
  };
  const signal = new AbortController().signal;

  // carol's user grants alice: "alice may message me". Receiver consent, so the
  // grant is made from carol's side, not alice's.
  const granted = await commands.execute(carol, `/bus allow ${alice.id}`, [], signal);
  check(
    'carol can grant alice access with /bus allow',
    granted?.result?.kind === 'success',
    JSON.stringify(granted?.result),
  );

  const afterGrant = await bus
    .send(alice, { target: carol.id, text: 'admitted by a runtime grant' }, {})
    .catch((error) => ({ code: error.code }));
  check(
    'a runtime grant admits a pair the config refuses',
    afterGrant?.targetState === 'live',
    JSON.stringify(afterGrant),
  );

  const storageDomain = ctx.get('storageDomain');
  check('the storage domain facility is mounted', storageDomain !== undefined);
  const domain = storageDomain?.get('peer_bus_allowlist');
  check('the runtime allowlist domain is open', domain !== undefined);
  check(
    'the grant was written through to the storage domain',
    domain?.global.get().grants.some((grant) => grant.from === alice.id && grant.to === carol.id) === true,
    JSON.stringify(domain?.global.get()),
  );

  // The security property: this message body is exactly a command that would
  // revoke the grant. Delivery must treat it as text.
  const executionsBefore = executions;
  await bus.send(alice, { target: carol.id, text: `/bus revoke ${alice.id}` }, {});
  await carol.whenIdle();
  check(
    'delivering a command-shaped message executes no command',
    executions === executionsBefore,
    `execute() ran ${executions - executionsBefore} time(s)`,
  );
  check(
    'the command-shaped message changed nothing',
    bus.allowlist.has(alice.id, carol.id),
  );

  const listed = await commands.execute(carol, '/bus list', [], signal);
  check(
    '/bus list names the runtime source',
    /runtime/.test(listed?.result?.text ?? ''),
    listed?.result?.text,
  );

  const revoked = await commands.execute(carol, `/bus revoke ${alice.id}`, [], signal);
  check(
    '/bus revoke takes the grant back',
    /may no longer message/.test(revoked?.result?.text ?? ''),
    revoked?.result?.text,
  );
  const afterRevoke = await bus
    .send(alice, { target: carol.id, text: 'must be refused again' }, {})
    .catch((error) => error.code);
  check('the pair is refused again after the revoke', afterRevoke === 'denied', `got ${afterRevoke}`);
}

console.log('\nscenario: an archived session is refused and never woken');
// Archiving is the durable "do not wake this" gate. Only the web bundle mounts
// `workspaceRegistry`, so this is also the check that the bus reads it when it IS
// there — while the rest of this run, on a profile that has none, is the check
// that behaviour is unchanged when it is absent.
const registry = ctx.get('workspaceRegistry');
check('the workspace registry is mounted', registry !== undefined);
if (registry !== undefined) {
  const graceHandle = await agents.create({
    sessionId: `session-e2e-grace-${RUN}`,
    meta: { cwd: process.cwd() },
    agentOptions: { provider: PROVIDER, model: MODEL },
  });
  const graceId = graceHandle.agent.id;
  await graceHandle.agent.whenIdle();
  await graceHandle.dispose();
  check('the archive probe is stored and unloaded', agents.get(graceId) === undefined);

  await registry.archiveSession(graceId, { stopActivity: true });
  check('the probe is in the registry archive set', registry.archivedSessionIds.includes(graceId));

  let archivedCode;
  try {
    await bus.send(alice, { target: graceId, text: 'must not wake an archived session' }, {});
  } catch (error) {
    archivedCode = error.code;
  }
  check(
    'bus.send refuses an archived stored target as target-archived',
    archivedCode === 'target-archived',
    `got ${archivedCode}`,
  );
  check('the archived target was NOT cold-resumed', agents.get(graceId) === undefined);
  check(
    'the archived target ran no turn',
    !eventsOf(graceId).some((event) => event.type === 'turn/start'),
  );

  const visibleAfterArchive = (await bus.visibleRoster(alice)).map((row) => row.id);
  check(
    'the archived session is not in the model-visible roster',
    !visibleAfterArchive.includes(graceId),
    JSON.stringify(visibleAfterArchive),
  );

  // Archiving does not have to unload a session, so a LIVE archived one must be
  // refused the same way rather than being woken in place.
  const hopeHandle = await agents.create({
    sessionId: `session-e2e-hope-${RUN}`,
    meta: { cwd: process.cwd() },
    agentOptions: { provider: PROVIDER, model: MODEL },
  });
  const hopeId = hopeHandle.agent.id;
  await hopeHandle.agent.whenIdle();
  await registry.archiveSession(hopeId, { stopActivity: true });
  let liveArchivedCode;
  try {
    await bus.send(alice, { target: hopeId, text: 'must not reach a live archived session' }, {});
  } catch (error) {
    liveArchivedCode = error.code;
  }
  check(
    'a LIVE archived target is refused the same way',
    liveArchivedCode === 'target-archived',
    `got ${liveArchivedCode}`,
  );
  check(
    'the live archived target received nothing',
    !eventsOf(hopeId).some(
      (event) =>
        event.type === 'agent/inbox/spliced' &&
        event.data?.inserted?.some((message) => message.source?.kind === 'peer-bus-message'),
    ),
  );
  await hopeHandle.dispose();

  // Leave the shared test home as it was found, and prove the refusal was tied to
  // the archive set rather than to something else about the target.
  await registry.unarchiveSession(graceId);
  await registry.unarchiveSession(hopeId);
  let afterUnarchive;
  try {
    afterUnarchive = await bus.send(alice, { target: graceId, text: 'reachable again' }, {});
  } catch (error) {
    afterUnarchive = { code: error.code };
  }
  check(
    'unarchiving restores reachability',
    afterUnarchive?.targetState === 'resumed',
    JSON.stringify(afterUnarchive),
  );
  await agents.get(graceId)?.whenIdle();
}

const toolsRegistry = ctx.get('tools');
/** Run one bus tool directly, as the loop would, for the given calling agent. */
const runTool = (name, args, agent) =>
  toolsRegistry.get(name, agent).execute(args, {
    agent,
    signal: new AbortController().signal,
    callId: `e2e-${name}-${Math.random().toString(36).slice(2)}`,
    deferContext() {},
    concludeTurn() {},
  });

console.log('\nscenario: bus_status follows a message after it is delivered');
{
  const oscarHandle = await agents.create({
    sessionId: `session-e2e-oscar-${RUN}`,
    meta: { cwd: process.cwd() },
    agentOptions: { provider: PROVIDER, model: MODEL },
  });
  const patHandle = await agents.create({
    sessionId: `session-e2e-pat-${RUN}`,
    meta: { cwd: process.cwd() },
    agentOptions: { provider: PROVIDER, model: MODEL },
  });
  const oscar = oscarHandle.agent;
  const pat = patHandle.agent;
  await pat.whenIdle();

  // An idle target claims the message synchronously inside followup(), so this
  // is the receipt that would be lost if it were recorded after routing.
  const idleSend = await bus.send(oscar, { target: pat.id, text: 'receipt probe' }, {});
  await pat.whenIdle();
  const claimed = await runTool('bus_status', { messageId: idleSend.messageId }, oscar);
  check('an idle target reports claimed, with the real turn', claimed.status === 'claimed' && Number.isInteger(claimed.turn), JSON.stringify(claimed));
  check('the receipt records the delivery latency', Number.isInteger(claimed.latencyMs) && claimed.latencyMs >= 0, JSON.stringify(claimed));
  const foreign = await runTool('bus_status', { messageId: idleSend.messageId }, pat);
  check('nobody but the sender can read the receipt', foreign.status === 'unknown', JSON.stringify(foreign));

  // Busy target: queued while pat's slow turn runs, claimed by the next one.
  let patTurns = 0;
  scripts.set(pat.id, async () => {
    patTurns += 1;
    if (patTurns === 1) await sleep(800);
    return textChunks('pat done');
  });
  pat.followup(userPrompt('slow work'));
  await waitUntil(() => pat.status !== 'idle', 5000);
  const busySend = await bus.send(oscar, { target: pat.id, text: 'wait your turn' }, {});
  const queued = await runTool('bus_status', { messageId: busySend.messageId }, oscar);
  check('a message to a busy target is queued', queued.status === 'queued', JSON.stringify(queued));
  await waitUntil(() => bus.receipts.statusFor(busySend.messageId, oscar.id).status !== 'queued', 10000);
  check(
    'it is claimed once the busy turn ends',
    bus.receipts.statusFor(busySend.messageId, oscar.id).status === 'claimed',
    JSON.stringify(bus.receipts.statusFor(busySend.messageId, oscar.id)),
  );
  await pat.whenIdle();

  // A real cancellation clears the inbox, which is the "discarded" path.
  scripts.set(pat.id, async () => {
    await sleep(800);
    return textChunks('pat interrupted');
  });
  pat.followup(userPrompt('more slow work'));
  await waitUntil(() => pat.status !== 'idle', 5000);
  const doomed = await bus.send(oscar, { target: pat.id, text: 'about to be discarded' }, {});
  pat.cancel({ kind: 'user' });
  await pat.whenIdle();
  check(
    'a message cleared by a cancellation reports discarded',
    bus.receipts.statusFor(doomed.messageId, oscar.id).status === 'discarded',
    JSON.stringify(bus.receipts.statusFor(doomed.messageId, oscar.id)),
  );

  // bus_wait taking a message reports received, not the discard its removal logs.
  const waitCall = `call-status-wait-${RUN}`;
  scripts.set(pat.id, (options) =>
    hasToolResult(options, waitCall)
      ? textChunks('pat got it')
      : toolCallChunks(waitCall, 'bus_wait', { from: oscar.id, timeoutMs: 8000 }),
  );
  pat.followup(userPrompt('wait for oscar'));
  check('pat called bus_wait inside a turn', await toolCallSeen(pat.id, waitCall));
  await sleep(150);
  const taken = await bus.send(oscar, { target: pat.id, text: 'take this one' }, {});
  await idleWithin(pat, 10000);
  check(
    'a message bus_wait takes reports received',
    bus.receipts.statusFor(taken.messageId, oscar.id).status === 'received',
    JSON.stringify(bus.receipts.statusFor(taken.messageId, oscar.id)),
  );
  await oscarHandle.dispose();
  await patHandle.dispose();
}

console.log('\nscenario: bus_wait never takes a bus_ask question meant for its own turn');
{
  // rita sits inside bus_wait (no filter) when sam asks her something. Her wait
  // must not swallow the question: the answer is read from the turn that claims
  // it, so taking it would strand sam until his timeout.
  const ritaHandle = await agents.create({
    sessionId: `session-e2e-rita-${RUN}`,
    meta: { cwd: process.cwd() },
    agentOptions: { provider: PROVIDER, model: MODEL },
  });
  const samHandle = await agents.create({
    sessionId: `session-e2e-sam-${RUN}`,
    meta: { cwd: process.cwd() },
    agentOptions: { provider: PROVIDER, model: MODEL },
  });
  const rita = ritaHandle.agent;
  const sam = samHandle.agent;
  const ritaWait = `call-rita-wait-${RUN}`;
  const samAsk = `call-sam-ask-${RUN}`;
  // The claimed, unsettled ask is the discriminator for "this turn is answering
  // the question" — sturdier than reading the request, which also carries history.
  const answeringQuestion = () =>
    [...bus.asks.pending.values()].some(
      (ask) => ask.targetId === rita.id && ask.turn !== undefined && ask.settled !== true,
    );
  scripts.set(rita.id, (options) => {
    if (answeringQuestion()) return textChunks('rita answers: all green');
    if (hasToolResult(options, ritaWait)) return textChunks('rita stopped waiting');
    return toolCallChunks(ritaWait, 'bus_wait', { timeoutMs: 1500 });
  });
  let samAsked = false;
  scripts.set(sam.id, (options) => {
    if (hasToolResult(options, samAsk) || samAsked) return textChunks('sam is done');
    samAsked = true;
    return toolCallChunks(samAsk, 'bus_ask', { target: rita.id, text: 'status?', timeoutMs: 15000 });
  });

  rita.followup(userPrompt('wait for anything'));
  check('rita is inside bus_wait', await toolCallSeen(rita.id, ritaWait));
  await sleep(150);
  sam.followup(userPrompt('ask rita'));
  check('sam called bus_ask while rita was waiting', await toolCallSeen(sam.id, samAsk));
  check('sam\'s asking turn completed', await idleWithin(sam, 20000));
  check(
    'rita\'s bus_wait did not take the question',
    /No bus message arrived/.test(toolResultText(rita.id, ritaWait)),
    toolResultText(rita.id, ritaWait),
  );
  check(
    'sam got rita\'s answer from the turn that claimed the question',
    /rita answers: all green/.test(toolResultText(sam.id, samAsk)),
    toolResultText(sam.id, samAsk),
  );
  await rita.whenIdle();
  await ritaHandle.dispose();
  await samHandle.dispose();
}

console.log('\nscenario: an idle cold-resumed session is released and its log lock freed');
{
  const persistence = ctx.get('sessionPersistence');
  const tessHandle = await agents.create({
    sessionId: `session-e2e-tess-${RUN}`,
    meta: { cwd: process.cwd() },
    agentOptions: { provider: PROVIDER, model: MODEL },
  });
  const tessId = tessHandle.agent.id;
  await tessHandle.agent.whenIdle();
  await tessHandle.dispose();
  const woke = await bus.send(alice, { target: tessId, text: 'wake for the release probe' }, {});
  check('tess was cold-resumed', woke.targetState === 'resumed', JSON.stringify(woke));
  await agents.get(tessId)?.whenIdle();

  /** Whether this process can open tess's log for writing right now. */
  const canOpenForWrite = async () => {
    try {
      const handle = await persistence.open(tessId, 'write');
      await handle.close();
      return true;
    } catch (error) {
      return error?.name ?? String(error);
    }
  };

  if (bus.owned.has(tessId)) {
    // Manual resume path: the bus owns the agent, so it is the one to release it.
    check('while resumed, the log is locked', (await canOpenForWrite()) !== true);
    await bus.sweepIdle(Date.now() + bus.config.resumedIdleMs + 1);
    check('the idle resumed session was released', agents.get(tessId) === undefined && !bus.owned.has(tessId));
    const opened = await canOpenForWrite();
    check('after the release the log can be opened for writing again', opened === true, String(opened));
    const again = await bus.send(alice, { target: tessId, text: 'back again' }, {});
    check('the next message resumes it again', again.targetState === 'resumed' && agents.get(tessId) !== undefined, JSON.stringify(again));
    await agents.get(tessId)?.whenIdle();
  } else {
    // Host resume path: the host owns the agent; the bus must leave it alone.
    await bus.sweepIdle(Date.now() + bus.config.resumedIdleMs + 1);
    check('a host-resumed session is not released by the bus', agents.get(tessId) !== undefined);
  }
}

/**
 * Remove the sessions and projection caches this run created.
 *
 * The test home is shared and every run creates a couple of dozen sessions, so
 * without this the roster grows without bound — and the roster is rebuilt on every
 * send, so a polluted home silently makes the whole suite slower and makes the
 * documented linear cost unmeasurable. Ids are run-scoped, so only this run's
 * artifacts match. Best-effort: cleanup must never fail the run.
 *
 * @returns how many session directories were removed.
 */
async function cleanUpRun() {
  const root = process.env.DSH_HOME;
  if (root === undefined) return 0;
  let removed = 0;
  const sessionsDir = join(root, 'sessions');
  for (const bucket of await readdir(sessionsDir).catch(() => [])) {
    const bucketDir = join(sessionsDir, bucket);
    for (const sessionId of await readdir(bucketDir).catch(() => [])) {
      if (!sessionId.includes(RUN)) continue;
      await rm(join(bucketDir, sessionId), { recursive: true, force: true }).catch(() => {});
      removed += 1;
    }
  }
  const cacheDir = join(root, 'storages', 'session_projcache', 'sessions');
  for (const cached of await readdir(cacheDir).catch(() => [])) {
    if (!cached.includes(RUN)) continue;
    await rm(join(cacheDir, cached), { force: true }).catch(() => {});
  }
  return removed;
}

const cleaned = await cleanUpRun();
console.log(failures.length === 0 ? '\ne2e-bus OK' : `\ne2e-bus FAILED (${failures.length})`);
if (cleaned > 0) console.log(`  cleaned ${cleaned} session(s) created by this run`);
for (const failure of failures) console.error(`  - ${failure}`);
await shutdown?.shutdown?.(failures.length === 0 ? 0 : 1);
process.exit(failures.length === 0 ? 0 : 1);
