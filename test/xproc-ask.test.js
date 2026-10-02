/**
 * A question asked across the process boundary.
 *
 * Two buses, one shared `DSH_HOME`, one real socket between them. The target's
 * turn is simulated the way the real agent loop announces it: a claim, then the
 * assistant's text, then the end of the turn.
 *
 * What this covers that a same-process ask does not: the asking process cannot see
 * the target's session events at all, so the answer has to be captured by the
 * *target's* process and pushed back as a frame. Everything after that — settling
 * the caller's wait, or falling back to a late message if it already gave up — is
 * the existing same-process machinery.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { baseConfig, fakeAgent, fakeCtx, makeBus } from './helpers.js';

const originalHome = process.env.DSH_HOME;
const home = await mkdtemp(join(tmpdir(), 'peer-bus-xproc-ask-'));
process.env.DSH_HOME = home;

test.after(async () => {
  if (originalHome === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = originalHome;
  await rm(home, { recursive: true, force: true });
});

/**
 * Install the event seams a bus subscribes to.
 *
 * The registry listens on the context the bus was constructed with, so the seam
 * has to go on `bus.pluginCtx` rather than on the context `fakeCtx` returned.
 *
 * @param bus - the bus to instrument.
 * @returns an emitter for those seams.
 */
function seam(bus) {
  const listening = bus.pluginCtx;
  const seams = new Map([
    ['session/event', new Set()],
    ['agent/inbox/claimed', new Set()],
    ['agent/inbox/discarded', new Set()],
  ]);
  const originalOn = listening.on.bind(listening);
  listening.on = (eventName, handler) => {
    const installed = seams.get(eventName);
    if (installed === undefined) return originalOn(eventName, handler);
    installed.add(handler);
    return () => installed.delete(handler);
  };
  return (name, ...args) => {
    for (const handler of [...(seams.get(name) ?? [])]) handler(...args);
  };
}

/** One assistant text block for a turn. */
const assistantTurn = (turn, text) => ({
  type: 'assistant/message',
  data: { turn, step: 1, message: { role: 'assistant', content: [{ type: 'text', text }] } },
});

/** The end of one turn. */
const turnEnd = (turn) => ({ type: 'turn/end', data: { turn, reason: { kind: 'completed' } } });

/**
 * Two seamed buses over one home, each with a live agent.
 *
 * @param options - allow rules per side.
 * @returns both buses, agents, emitters, and a disposer.
 */
async function pair({ allowA = [], allowB = [], askBusyTimeoutMs = 30000, maxWaitMs = 600000 } = {}) {
  const agentA = fakeAgent('session-a');
  const agentB = fakeAgent('session-b');
  const busA = makeBus(fakeCtx({ liveAgents: [agentA] }).ctx, baseConfig({
    crossProcess: true,
    allow: allowA,
    askBusyTimeoutMs,
    maxWaitMs,
  }));
  const busB = makeBus(fakeCtx({ liveAgents: [agentB] }).ctx, baseConfig({
    crossProcess: true,
    allow: allowB,
    askBusyTimeoutMs,
    maxWaitMs,
  }));
  const emitA = seam(busA);
  const emitB = seam(busB);
  await Promise.all([busA.xproc(), busB.xproc()]);
  return {
    busA,
    busB,
    agentA,
    agentB,
    emitA,
    emitB,
    dispose: async () => {
      await busA.dispose();
      await busB.dispose();
    },
  };
}

const ALLOW_BOTH = [
  { from: 'session-a', to: 'session-b' },
  { from: 'session-b', to: 'session-a' },
];

test('a question asked across the socket is answered back across it', async () => {
  const { busA, agentA, agentB, emitB, dispose } = await pair({
    allowA: ALLOW_BOTH,
    allowB: ALLOW_BOTH,
  });
  try {
    const asking = busA.asks.ask(agentA, { target: 'session-b', text: 'what is the answer?' }, {});
    // Let the question travel, then answer it the way the agent loop would.
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(agentB.delivered.length, 1, 'the question must reach the peer inbox');
    const question = agentB.delivered[0].message;

    emitB('agent/inbox/claimed', { message: question, turn: 7, agent: agentB });
    emitB('session/event', agentB.session, assistantTurn(7, 'forty-two'));
    emitB('session/event', agentB.session, turnEnd(7));

    const result = await asking;
    assert.equal(result.status, 'answered');
    assert.equal(result.from, 'session-b');
    assert.equal(result.text, 'forty-two');
    assert.equal(result.turn, 7);
  } finally {
    await dispose();
  }
});

test("the target's explicit bus_reply also crosses back", async () => {
  const { busA, busB, agentA, agentB, emitB, dispose } = await pair({
    allowA: ALLOW_BOTH,
    allowB: ALLOW_BOTH,
  });
  try {
    const asking = busA.asks.ask(agentA, { target: 'session-b', text: 'ping' }, {});
    await new Promise((resolve) => setTimeout(resolve, 50));
    const question = agentB.delivered[0].message;
    // The target answers deliberately rather than by ending its turn.
    emitB('agent/inbox/claimed', { message: question, turn: 3, agent: agentB });
    const replied = await busB.asks.reply(agentB, 'pong');

    const result = await asking;
    assert.equal(result.status, 'answered');
    assert.equal(result.text, 'pong');
    assert.equal(replied.to, 'session-a', 'the reply is addressed to the asking session');
  } finally {
    await dispose();
  }
});

test('an answer that arrives after the asker gave up becomes a normal message', async () => {
  // The asker stops waiting, then the peer answers. Nothing may be lost: the
  // existing late-delivery path takes over, so the text lands in the asker's
  // session tagged with the ask id.
  const { busA, agentA, agentB, emitB, dispose } = await pair({
    allowA: ALLOW_BOTH,
    allowB: ALLOW_BOTH,
    askBusyTimeoutMs: 120,
  });
  try {
    // An idle target uses `waitTimeoutMs`, not `askBusyTimeoutMs`, so the bound has
    // to be stated explicitly or this waits a full minute for nothing.
    const result = await busA.asks.ask(agentA, { target: 'session-b', text: 'slow?', timeoutMs: 120 }, {});
    assert.equal(result.status, 'pending', 'the asker gives up quickly');

    const question = agentB.delivered[0].message;
    emitB('agent/inbox/claimed', { message: question, turn: 5, agent: agentB });
    emitB('session/event', agentB.session, assistantTurn(5, 'eventually'));
    emitB('session/event', agentB.session, turnEnd(5));

    // The push fails to settle a wait that is gone, so it is delivered instead.
    await new Promise((resolve) => setTimeout(resolve, 80));
    const late = agentA.delivered.at(-1);
    assert.notEqual(late, undefined, 'the late answer must still arrive');
    assert.match(JSON.stringify(late.message.content), /eventually/);
    assert.equal(late.message.source.askId, result.askId);
  } finally {
    await dispose();
  }
});

test('the peer holds a proxy for the question, and releases it on cancel', async () => {
  // The receiving process must track the question — that is what lets a claim
  // attach a turn to it and `bus_wait` skip it — and must let go of it once the
  // asker stops waiting, or an unanswered question lives as long as the peer.
  const { busA, agentA, busB, dispose } = await pair({
    allowA: ALLOW_BOTH,
    allowB: ALLOW_BOTH,
    maxWaitMs: 400,
  });
  try {
    const result = await busA.asks.ask(agentA, { target: 'session-b', text: 'ignored', timeoutMs: 80 }, {});
    assert.equal(result.status, 'pending');
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.ok(
      busB.asks.pending.has(result.askId),
      'the peer must be tracking the question on the asker behalf',
    );

    // The asker's own entry is dropped after `maxWaitMs`, which is the point past
    // which nothing here could receive the answer.
    await new Promise((resolve) => setTimeout(resolve, 600));
    assert.equal(
      busB.asks.pending.has(result.askId),
      false,
      'the cancel must have released the peer proxy',
    );
  } finally {
    await dispose();
  }
});

test('a proxy nobody answers is bounded by its own ceiling', async () => {
  // The asker may be killed rather than polite: no cancel will ever arrive. The
  // receiving side has to bound the entry itself.
  const { busA, agentA, busB, dispose } = await pair({
    allowA: ALLOW_BOTH,
    allowB: ALLOW_BOTH,
    maxWaitMs: 200,
  });
  try {
    const result = await busA.asks.ask(agentA, { target: 'session-b', text: 'into the void', timeoutMs: 60 }, {});
    assert.equal(result.status, 'pending');
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.ok(busB.asks.pending.has(result.askId));

    // Drop the asker's side entirely so no cancel can be sent.
    await busA.dispose();
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(
      busB.asks.pending.has(result.askId),
      false,
      'the proxy must expire on its own',
    );
  } finally {
    await busB.dispose();
  }
});

test('upstreamOf walks the wait graph backwards, transitively', async () => {
  const bus = makeBus(fakeCtx({ liveAgents: [] }).ctx, baseConfig());
  try {
    bus.asks.addEdge('x', 'y'); // x waits on y
    bus.asks.addEdge('y', 'z'); // y waits on z
    assert.deepEqual(bus.asks.upstreamOf('z').sort(), ['x', 'y'], 'both waiters, transitively');
    assert.deepEqual(bus.asks.upstreamOf('y'), ['x']);
    assert.deepEqual(bus.asks.upstreamOf('x'), [], 'nobody waits on x');
    assert.ok(!bus.asks.upstreamOf('z').includes('z'), 'a session is not its own upstream');
  } finally {
    await bus.dispose();
  }
});

test('a wait cycle that runs through two processes is refused', async () => {
  // The interesting case: neither process can see the whole loop. A's graph holds
  // A→B; B's graph holds nothing, because a proxy question is not a wait edge. Only
  // by checking the sender's graph against the arriving question does it surface.
  const { busA, busB, agentA, agentB, dispose } = await pair({
    allowA: ALLOW_BOTH,
    allowB: ALLOW_BOTH,
  });
  try {
    // A asks B and stays waiting, so the A→B edge is live in A's process.
    const waiting = busA.asks.ask(agentA, { target: 'session-b', text: 'first', timeoutMs: 700 });
    await new Promise((resolve) => setTimeout(resolve, 90));
    assert.equal(agentB.delivered.length, 1, 'the first question must have arrived');

    const error = await busB.asks
      .ask(agentB, { target: 'session-a', text: 'second', timeoutMs: 200 }, {})
      .catch((thrown) => thrown);
    assert.equal(error?.code, 'ask-cycle', `expected ask-cycle, got ${error?.code ?? error?.message}`);
    assert.match(error.message, /wait cycle/);
    assert.equal(agentA.delivered.length, 0, 'a refused cycle must not reach an inbox');

    assert.equal((await waiting).status, 'pending', 'the first ask is untouched by the refusal');
  } finally {
    await dispose();
  }
});

test('a cycle carried in by the peer is refused before delivery', async () => {
  // The branch the local check cannot reach. In A's process nothing waits on the
  // sender, so `wouldCycle(sender, target)` is false; the loop only closes through
  // a session the peer reports as waiting on it.
  const { busA, busB, agentA, agentB, dispose } = await pair({
    allowA: ALLOW_BOTH,
    allowB: ALLOW_BOTH,
  });
  try {
    // A waits on C. Nothing in A's graph waits on the sender, so the local check
    // cannot fire.
    busA.asks.addEdge('session-a', 'session-c');
    // In B's process, C waits on B — so B reports {session-c} upstream, and A sees
    // its target reach that session.
    busB.asks.addEdge('session-c', 'session-b');
    assert.deepEqual(
      busB.asks.upstreamOf('session-b'),
      ['session-c'],
      'the peer must report a non-empty upstream, or this tests nothing new',
    );

    const error = await busB.asks
      .ask(agentB, { target: 'session-a', text: 'back', timeoutMs: 200 }, {})
      .catch((thrown) => thrown);
    assert.equal(error?.code, 'ask-cycle', `expected ask-cycle, got ${error?.code ?? error?.message}`);
    assert.equal(agentA.delivered.length, 0, 'a refused cycle must not reach an inbox');
  } finally {
    await dispose();
  }
});
