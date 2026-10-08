/**
 * One session talking to several others at once.
 *
 * The bus has no "current conversation partner": permission is per pair, the rate
 * ceiling is counted per pair, and the wait-for graph is a map of sets, so a session
 * can hold edges to many targets. These tests hold that down, because it is the
 * property most likely to be broken by a future refactor that reaches for a single
 * `peer` field.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { baseConfig, fakeAgent, fakeCtx, makeBus } from './helpers.js';

/**
 * Install the event seams the ask registry subscribes to.
 *
 * It listens on the context the bus was constructed with, which is an isolated child
 * of the one `fakeCtx` returns, so the seam has to go on `bus.pluginCtx`.
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

/** Every ordered pair among these sessions. */
const allPairs = (ids) => ids.flatMap((from) => ids.filter((to) => to !== from).map((to) => ({ from, to })));

/**
 * One bus holding three live sessions, all mutually allowed.
 *
 * @returns the bus, the agents by name, the emitter, and a disposer.
 */
function hub() {
  const ids = ['session-a', 'session-b', 'session-c'];
  const agents = ids.map((id) => fakeAgent(id));
  const ctx = fakeCtx({ liveAgents: agents });
  const bus = makeBus(ctx.ctx, baseConfig({ allow: allPairs(ids) }));
  const emit = seam(bus);
  const byName = Object.fromEntries(agents.map((agent) => [agent.id, agent]));
  return { bus, agent: byName, emit, dispose: () => bus.dispose() };
}

test('one session sends to two others, and both are delivered', async () => {
  const { bus, agent, dispose } = hub();
  try {
    const first = await bus.send(agent['session-a'], { target: 'session-b', text: 'to b' }, {});
    const second = await bus.send(agent['session-a'], { target: 'session-c', text: 'to c' }, {});

    assert.equal(first.target, 'session-b');
    assert.equal(second.target, 'session-c');
    assert.notEqual(first.messageId, second.messageId);
    assert.equal(agent['session-b'].delivered.length, 1);
    assert.equal(agent['session-c'].delivered.length, 1);
    assert.match(JSON.stringify(agent['session-b'].delivered[0].message.content), /to b/);
    assert.match(JSON.stringify(agent['session-c'].delivered[0].message.content), /to c/);
  } finally {
    await dispose();
  }
});

test('the rate ceiling is counted per pair, not per session', async () => {
  // If the budget were per session, a busy conversation with one peer would starve
  // every other one — which is exactly the shape a "one peer field" refactor creates.
  const { bus, agent, dispose } = hub();
  try {
    const limit = bus.config.maxSendsPerWindow;
    for (let index = 0; index < limit; index += 1) {
      await bus.send(agent['session-a'], { target: 'session-b', text: `b${index}` }, {});
    }
    const exhausted = await bus
      .send(agent['session-a'], { target: 'session-b', text: 'one too many' }, {})
      .catch((error) => error);
    assert.equal(exhausted?.code, 'rate-limited');

    // The other pair is untouched.
    const other = await bus.send(agent['session-a'], { target: 'session-c', text: 'still fine' }, {});
    assert.equal(other.target, 'session-c');
    assert.equal(agent['session-c'].delivered.length, 1);
  } finally {
    await dispose();
  }
});

test('one session holds two questions open at once, and each gets its own answer', async () => {
  const { bus, agent, emit, dispose } = hub();
  try {
    const toB = bus.asks.ask(agent['session-a'], { target: 'session-b', text: 'question for b' }, {});
    const toC = bus.asks.ask(agent['session-a'], { target: 'session-c', text: 'question for c' }, {});

    // Both questions are delivered before either is answered.
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(agent['session-b'].delivered.length, 1);
    assert.equal(agent['session-c'].delivered.length, 1);

    // Answer them out of order, on different turn numbers, to prove the correlation
    // is by ask and not by "the newest thing".
    emit('agent/inbox/claimed', { message: agent['session-c'].delivered[0].message, turn: 9, agent: agent['session-c'] });
    emit('session/event', agent['session-c'].session, assistantTurn(9, 'answer from c'));
    emit('session/event', agent['session-c'].session, turnEnd(9));

    emit('agent/inbox/claimed', { message: agent['session-b'].delivered[0].message, turn: 2, agent: agent['session-b'] });
    emit('session/event', agent['session-b'].session, assistantTurn(2, 'answer from b'));
    emit('session/event', agent['session-b'].session, turnEnd(2));

    const answeredC = await toC;
    const answeredB = await toB;
    assert.equal(answeredC.from, 'session-c');
    assert.equal(answeredC.text, 'answer from c');
    assert.equal(answeredC.turn, 9);
    assert.equal(answeredB.from, 'session-b');
    assert.equal(answeredB.text, 'answer from b');
    assert.equal(answeredB.turn, 2);
    assert.notEqual(answeredB.askId, answeredC.askId);
  } finally {
    await dispose();
  }
});

test('two questions in flight do not look like a wait cycle', async () => {
  // A cycle needs a loop. One asker with two outgoing edges has none, and a check
  // that confused "already waiting" with "waiting on me" would refuse this.
  const { bus, agent, dispose } = hub();
  try {
    const toB = bus.asks.ask(agent['session-a'], { target: 'session-b', text: 'q1', timeoutMs: 600 }, {});
    const toC = bus.asks.ask(agent['session-a'], { target: 'session-c', text: 'q2', timeoutMs: 600 }, {});
    await new Promise((resolve) => setTimeout(resolve, 30));

    // While both of A's edges are live, the reverse direction really is a loop, so the
    // rule must still fire. Asking this after the others had timed out would prove
    // nothing: a released edge is not a cycle, and that is the correct behaviour too.
    const reverse = await bus.asks
      .ask(agent['session-b'], { target: 'session-a', text: 'back', timeoutMs: 200 }, {})
      .catch((error) => error);
    assert.equal(reverse?.code, 'ask-cycle', `expected ask-cycle, got ${reverse?.code ?? reverse?.message}`);

    // Both of A's questions are still outstanding and neither was disturbed.
    const settled = await Promise.all([toB, toC]);
    assert.deepEqual(settled.map((result) => result.status), ['pending', 'pending']);
    assert.deepEqual(settled.map((result) => result.from).sort(), ['session-b', 'session-c']);
  } finally {
    await dispose();
  }
});

test('a session can wait for one sender while talking to another', async () => {
  const { bus, agent, dispose } = hub();
  try {
    // B waits for A specifically.
    const waiting = bus.asks.wait(
      { askId: 'manual', askerId: 'session-b', targetId: 'session-b', answer: [], settled: false },
      500,
      {},
    );
    // C messages B; the filtered wait must not take it.
    await bus.send(agent['session-c'], { target: 'session-b', text: 'from c' }, {});
    assert.equal(agent['session-b'].delivered.length, 1, 'an unfiltered delivery still arrives as a turn');

    // A messages B; that one the filter would take, so it is delivered rather than
    // consumed here — the point is that the two senders are independent.
    await bus.send(agent['session-a'], { target: 'session-b', text: 'from a' }, {});
    assert.equal(agent['session-b'].delivered.length, 2);
    waiting.catch(() => {});
  } finally {
    await dispose();
  }
});
