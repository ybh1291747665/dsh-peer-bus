/**
 * Tests for `bus_ask`: answer correlation, the wait-for graph, and late delivery.
 *
 * The correlation these pin is exact rather than heuristic. The ask id travels on
 * the question itself, the answer is read from the turn that *claimed* that
 * question, and a turn that happens to run later must not be mistaken for it.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { SessionBusError } from '../src/peer-bus.js';
import { baseConfig, fakeAgent, fakeCtx, makeBus } from './helpers.js';

/** Let every already-queued microtask and the send path finish. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * A bus over fake agents, with the two event seams the registry listens on.
 *
 * @param options - live agents, the allowlist, and policy overrides.
 * @returns the bus, the agents, an emitter for each seam, and the seam sizes.
 */
function askHarness({ liveAgents = [], allow = [], ...policy } = {}) {
  const { ctx } = fakeCtx({ liveAgents });
  const bus = makeBus(ctx, baseConfig({ allow, ...policy }));
  // The registry listens on the context the bus was constructed with, which is an
  // isolated child of the one `fakeCtx` returns. Overriding `ctx.on` on the parent
  // would install a seam nothing ever subscribes to, and every ask would simply
  // wait out its timeout.
  const listening = bus.pluginCtx;
  const seams = new Map([
    ['session/event', new Set()],
    ['agent/inbox/claimed', new Set()],
    ['agent/inbox/discarded', new Set()],
  ]);
  const originalOn = listening.on.bind(listening);
  listening.on = (eventName, handler) => {
    const seam = seams.get(eventName);
    if (seam === undefined) return originalOn(eventName, handler);
    seam.add(handler);
    return () => seam.delete(handler);
  };
  return {
    ctx,
    bus,
    /** Deliver one event to that seam's listeners, as the real publisher would. */
    emit: (name, ...args) => {
      for (const handler of [...(seams.get(name) ?? [])]) handler(...args);
    },
    seamSize: (name) => seams.get(name)?.size ?? 0,
  };
}

/** The one message a fake agent received, or a clear failure. */
function onlyMessage(agent) {
  assert.equal(agent.delivered.length, 1, `expected exactly one delivery, got ${agent.delivered.length}`);
  return agent.delivered[0].message;
}

/** One assistant text block for a turn. */
const assistantTurn = (turn, text) => ({
  type: 'assistant/message',
  data: { turn, step: 1, message: { role: 'assistant', content: [{ type: 'text', text }] } },
});

/** The end of one turn. */
const turnEnd = (turn) => ({ type: 'turn/end', data: { turn, reason: { kind: 'completed' } } });

/** Claim one message for a turn, as the agent loop announces it. */
const claim = (agent, message, turn) => ({ message, turn, agent });

test('bus_ask answers with the text of the turn that claimed the question', async () => {
  const alice = fakeAgent('session-alice');
  const bob = fakeAgent('session-bob');
  const { bus, emit } = askHarness({
    liveAgents: [alice, bob],
    allow: [{ from: 'session-alice', to: 'session-bob' }],
  });

  const pending = bus.asks.ask(alice, { target: bob.id, text: 'what is the answer?' }, {});
  await tick();
  const question = onlyMessage(bob);
  // The correlation key travels on the message, which is what makes the ordering
  // of registration and delivery irrelevant.
  assert.equal(typeof question.source.askId, 'string');

  emit('agent/inbox/claimed', claim(bob, question, 1));
  emit('session/event', bob.session, assistantTurn(1, 'the answer'));
  emit('session/event', bob.session, turnEnd(1));

  const result = await pending;
  assert.equal(result.status, 'answered');
  assert.equal(result.from, bob.id);
  assert.equal(result.text, 'the answer');
  assert.equal(result.turn, 1);
});

test('a later turn is not mistaken for the answer', async () => {
  const alice = fakeAgent('session-alice');
  const bob = fakeAgent('session-bob');
  const { bus, emit } = askHarness({
    liveAgents: [alice, bob],
    allow: [{ from: 'session-alice', to: 'session-bob' }],
  });

  const pending = bus.asks.ask(alice, { target: bob.id, text: 'q' }, {});
  await tick();
  emit('agent/inbox/claimed', claim(bob, onlyMessage(bob), 3));
  // A turn that has nothing to do with the question.
  emit('session/event', bob.session, assistantTurn(2, 'unrelated work'));
  emit('session/event', bob.session, assistantTurn(3, 'the real answer'));
  emit('session/event', bob.session, turnEnd(2));
  emit('session/event', bob.session, turnEnd(3));

  const result = await pending;
  assert.equal(result.text, 'the real answer');
  assert.equal(result.turn, 3);
});

test('several assistant messages in one turn are joined', async () => {
  const alice = fakeAgent('session-alice');
  const bob = fakeAgent('session-bob');
  const { bus, emit } = askHarness({
    liveAgents: [alice, bob],
    allow: [{ from: 'session-alice', to: 'session-bob' }],
  });

  const pending = bus.asks.ask(alice, { target: bob.id, text: 'q' }, {});
  await tick();
  emit('agent/inbox/claimed', claim(bob, onlyMessage(bob), 1));
  emit('session/event', bob.session, assistantTurn(1, 'first'));
  emit('session/event', bob.session, assistantTurn(1, 'second'));
  emit('session/event', bob.session, turnEnd(1));

  assert.equal((await pending).text, 'first\n\nsecond');
});

test('bus_ask reports pending on timeout and delivers the late answer as a message', async () => {
  const alice = fakeAgent('session-alice');
  const bob = fakeAgent('session-bob');
  const { bus, emit } = askHarness({
    liveAgents: [alice, bob],
    allow: [{ from: 'session-alice', to: 'session-bob' }],
  });

  const result = await bus.asks.ask(alice, { target: bob.id, text: 'q', timeoutMs: 10 }, {});
  assert.equal(result.status, 'pending');
  assert.equal(typeof result.askId, 'string');
  assert.deepEqual(alice.delivered, [], 'nothing is delivered before the answer exists');

  // The target answers long after the caller gave up.
  const question = onlyMessage(bob);
  emit('agent/inbox/claimed', claim(bob, question, 1));
  emit('session/event', bob.session, assistantTurn(1, 'late answer'));
  emit('session/event', bob.session, turnEnd(1));
  await tick();

  assert.equal(alice.delivered.length, 1);
  const late = alice.delivered[0].message;
  assert.equal(late.source.askId, result.askId);
  assert.equal(late.source.senderSessionId, bob.id);
  assert.match(late.content.map((block) => block.text).join(''), /late answer/);
});

test('a busy target is bounded by askBusyTimeoutMs, not waitTimeoutMs', async () => {
  const alice = fakeAgent('session-alice');
  const busyBob = fakeAgent('session-bob', 'running');
  const { bus } = askHarness({
    liveAgents: [alice, busyBob],
    allow: [{ from: 'session-alice', to: 'session-bob' }],
    askBusyTimeoutMs: 10,
    waitTimeoutMs: 60000,
  });

  const started = Date.now();
  const result = await bus.asks.ask(alice, { target: busyBob.id, text: 'q' }, {});
  assert.equal(result.status, 'pending');
  assert.ok(Date.now() - started < 5000, 'the busy bound must be the short one');
});

test('an idle target is bounded by waitTimeoutMs', async () => {
  const alice = fakeAgent('session-alice');
  const bob = fakeAgent('session-bob', 'idle');
  const { bus } = askHarness({
    liveAgents: [alice, bob],
    allow: [{ from: 'session-alice', to: 'session-bob' }],
    askBusyTimeoutMs: 60000,
    waitTimeoutMs: 10,
  });

  const result = await bus.asks.ask(alice, { target: bob.id, text: 'q' }, {});
  assert.equal(result.status, 'pending');
});

test('a discarded question settles immediately instead of timing out', async () => {
  const alice = fakeAgent('session-alice');
  const bob = fakeAgent('session-bob');
  const { bus, emit } = askHarness({
    liveAgents: [alice, bob],
    allow: [{ from: 'session-alice', to: 'session-bob' }],
  });

  const pending = bus.asks.ask(alice, { target: bob.id, text: 'q', timeoutMs: 60000 }, {});
  await tick();
  emit('agent/inbox/discarded', { message: onlyMessage(bob), agent: bob });

  const result = await pending;
  assert.equal(result.status, 'discarded');
  assert.equal(result.from, bob.id);
});

test('a direct question and its answer are refused as a wait cycle', async () => {
  const alice = fakeAgent('session-alice');
  const bob = fakeAgent('session-bob');
  const { bus } = askHarness({
    liveAgents: [alice, bob],
    allow: [
      { from: 'session-alice', to: 'session-bob' },
      { from: 'session-bob', to: 'session-alice' },
    ],
  });

  const first = bus.asks.ask(alice, { target: bob.id, text: 'q', timeoutMs: 60000 }, {});
  first.catch(() => {});

  await tick();

  const error = await bus.asks
    .ask(bob, { target: alice.id, text: 'q back', timeoutMs: 60000 }, {})
    .catch((thrown) => thrown);
  assert.ok(error instanceof SessionBusError);
  assert.equal(error.code, 'ask-cycle');
  // The chain starts from the ask being refused, so it reads as the cycle it is.
  assert.match(error.message, /session-bob -> session-alice -> session-bob/);
  // The refused ask must not have been delivered.
  assert.equal(alice.delivered.length, 0);

  // The first ask is still blocked on purpose; tear it down rather than leaving a
  // real 60s wait timer holding the test process open.
  bus.asks.dispose();
  await tick();
});

test('a longer wait cycle is refused too', async () => {
  const alice = fakeAgent('session-alice');
  const bob = fakeAgent('session-bob');
  const carol = fakeAgent('session-carol');
  const { bus } = askHarness({
    liveAgents: [alice, bob, carol],
    allow: [
      { from: 'session-alice', to: 'session-bob' },
      { from: 'session-bob', to: 'session-carol' },
      { from: 'session-carol', to: 'session-alice' },
    ],
  });

  const first = bus.asks.ask(alice, { target: bob.id, text: 'q1', timeoutMs: 60000 }, {});
  first.catch(() => {});
  await tick();
  const second = bus.asks.ask(bob, { target: carol.id, text: 'q2', timeoutMs: 60000 }, {});
  second.catch(() => {});
  await tick();

  const error = await bus.asks
    .ask(carol, { target: alice.id, text: 'q3', timeoutMs: 60000 }, {})
    .catch((thrown) => thrown);
  assert.equal(error?.code, 'ask-cycle');
  assert.match(error.message, /session-carol -> session-alice -> session-bob -> session-carol/);

  bus.asks.dispose();
  await tick();
});

test('the wait edge is released once an ask settles', async () => {
  const alice = fakeAgent('session-alice');
  const bob = fakeAgent('session-bob');
  const { bus, emit } = askHarness({
    liveAgents: [alice, bob],
    allow: [
      { from: 'session-alice', to: 'session-bob' },
      { from: 'session-bob', to: 'session-alice' },
    ],
  });

  const pending = bus.asks.ask(alice, { target: bob.id, text: 'q', timeoutMs: 60000 }, {});
  await tick();
  emit('agent/inbox/claimed', claim(bob, onlyMessage(bob), 1));
  emit('session/event', bob.session, assistantTurn(1, 'done'));
  emit('session/event', bob.session, turnEnd(1));
  await pending;

  // Bob may now ask back: nobody is blocked any more.
  const back = bus.asks.ask(bob, { target: alice.id, text: 'q back', timeoutMs: 10 }, {});
  const result = await back;
  assert.equal(result.status, 'pending');
});

test('bus_reply settles the ask with the explicit text, ahead of the turn text', async () => {
  const alice = fakeAgent('session-alice');
  const bob = fakeAgent('session-bob');
  const { bus, emit } = askHarness({
    liveAgents: [alice, bob],
    allow: [{ from: 'session-alice', to: 'session-bob' }],
  });

  const pending = bus.asks.ask(alice, { target: bob.id, text: 'q', timeoutMs: 60000 }, {});
  await tick();
  emit('agent/inbox/claimed', claim(bob, onlyMessage(bob), 1));
  const replied = await bus.asks.reply(bob, 'explicit answer');
  assert.equal(replied.to, alice.id);

  // The turn's own text arrives afterwards and must not overwrite the reply.
  emit('session/event', bob.session, assistantTurn(1, 'turn text'));
  emit('session/event', bob.session, turnEnd(1));

  const result = await pending;
  assert.equal(result.status, 'answered');
  assert.equal(result.text, 'explicit answer');
});

test('bus_reply without a question in flight is refused', async () => {
  const bob = fakeAgent('session-bob');
  const { bus } = askHarness({ liveAgents: [bob] });
  const error = await bus.asks.reply(bob, 'nobody asked').catch((thrown) => thrown);
  assert.equal(error?.code, 'no-pending-ask');
});

test('bus_reply refuses blank text', async () => {
  const bob = fakeAgent('session-bob');
  const { bus } = askHarness({ liveAgents: [bob] });
  const error = await bus.asks.reply(bob, '   ').catch((thrown) => thrown);
  assert.equal(error?.code, 'invalid-text');
});

test('a blank question, a self-ask, and an unknown target are all refused', async () => {
  const alice = fakeAgent('session-alice');
  const { bus } = askHarness({ liveAgents: [alice] });

  assert.equal(
    (await bus.asks.ask(alice, { target: alice.id, text: '  ' }, {}).catch((e) => e))?.code,
    'invalid-text',
  );
  assert.equal(
    (await bus.asks.ask(alice, { target: alice.id, text: 'q' }, {}).catch((e) => e))?.code,
    'self-send',
  );
  assert.equal(
    (await bus.asks.ask(alice, { target: 'session-nobody', text: 'q' }, {}).catch((e) => e))?.code,
    'unknown-target',
  );
});

test('a refused delivery leaves no ask behind', async () => {
  const alice = fakeAgent('session-alice');
  const bob = fakeAgent('session-bob');
  const { bus } = askHarness({ liveAgents: [alice, bob], allow: [] });

  const error = await bus.asks.ask(alice, { target: bob.id, text: 'q' }, {}).catch((thrown) => thrown);
  assert.equal(error?.code, 'denied');
  assert.equal(bus.asks.pending.size, 0);
  assert.equal(bus.asks.waiting.size, 0);
  assert.equal(bob.delivered.length, 0);
});

test('cancellation rejects the ask instead of leaving it hanging', async () => {
  const alice = fakeAgent('session-alice');
  const bob = fakeAgent('session-bob');
  const { bus } = askHarness({
    liveAgents: [alice, bob],
    allow: [{ from: 'session-alice', to: 'session-bob' }],
  });

  const controller = new AbortController();
  const pending = bus.asks.ask(alice, { target: bob.id, text: 'q', timeoutMs: 60000 }, {
    signal: controller.signal,
  });
  await tick();
  controller.abort();
  await assert.rejects(() => pending, /cancelled/);
  // The edge is released in the same promise chain that rejects, so give that
  // continuation its turn before asserting.
  await tick();
  assert.equal(bus.asks.waiting.size, 0);
  assert.equal(bus.asks.pending.size, 0);
});

test('the listeners are installed once and released on dispose', async () => {
  const alice = fakeAgent('session-alice');
  const bob = fakeAgent('session-bob');
  const { bus, seamSize } = askHarness({
    liveAgents: [alice, bob],
    allow: [{ from: 'session-alice', to: 'session-bob' }],
  });

  assert.equal(seamSize('agent/inbox/claimed'), 0, 'nothing is listened for until an ask exists');
  await bus.asks.ask(alice, { target: bob.id, text: 'q', timeoutMs: 1 }, {});
  // Two owners, one listener each: the ask registry, and the receipt book that
  // tracks the question as an ordinary delivery.
  assert.equal(seamSize('agent/inbox/claimed'), 2);
  assert.equal(seamSize('session/event'), 1);
  await bus.asks.ask(alice, { target: bob.id, text: 'q2', timeoutMs: 1 }, {});
  assert.equal(seamSize('agent/inbox/claimed'), 2, 'a second ask installs nothing new');

  bus.asks.dispose();
  assert.equal(seamSize('agent/inbox/claimed'), 1, "only the receipt book's listener remains");
  assert.equal(seamSize('session/event'), 0);
  bus.receipts.dispose();
  assert.equal(seamSize('agent/inbox/claimed'), 0);
});

test('dispose fails an in-flight ask instead of hanging it', async () => {
  const alice = fakeAgent('session-alice');
  const bob = fakeAgent('session-bob');
  const { bus } = askHarness({
    liveAgents: [alice, bob],
    allow: [{ from: 'session-alice', to: 'session-bob' }],
  });

  const pending = bus.asks.ask(alice, { target: bob.id, text: 'q', timeoutMs: 60000 }, {});
  await tick();
  bus.asks.dispose();
  const error = await pending.catch((thrown) => thrown);
  assert.equal(error?.code, 'disposed');
});
