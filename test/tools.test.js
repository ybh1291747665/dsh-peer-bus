/**
 * Tool-executor tests.
 *
 * The unit tests in peer-bus.test.js cover the bus core; these drive the
 * registered tool definitions themselves, which is where a wrong event type or a
 * read of a non-existent session property hides.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import { Config, apply } from '../src/index.js';

/**
 * Whether a fake session append is currently publishing its `session/event`.
 *
 * The real `Session.append` invokes `session/event` observers while it is still
 * publishing, rejects any nested append on that session until it returns, and
 * contains (logs) whatever an observer throws. The fakes below mirror all three,
 * because a listener that appends inline — as `bus_wait` once did through
 * `inbox.remove` — only fails under that guard, and the failure is silent.
 */
const publication = { active: false };

/**
 * Build a context with fake services plus a controllable `session/event` seam.
 *
 * @param options - live agents the fake registry should return.
 * @returns the context, captured tools, and a function to emit a session event.
 */
function harness({ liveAgents = [] } = {}) {
  const ctx = new Context();
  const tools = new Map();
  const listeners = new Set();
  const contained = [];
  const live = new Map(liveAgents.map((agent) => [agent.id, agent]));

  ctx.provide('agents', {
    list: () => [...live.values()],
    get: (id) => live.get(id),
  });
  ctx.provide('sessionPersistence', { list: async () => [] });
  ctx.provide('tools', {
    register(definition) {
      tools.set(definition.name, definition);
      return () => {};
    },
    get: (toolName) => tools.get(toolName),
  });

  // Intercept the context seam so a test can drive delivery events directly.
  const originalOn = ctx.on.bind(ctx);
  ctx.on = (eventName, handler) => {
    if (eventName !== 'session/event') return originalOn(eventName, handler);
    listeners.add(handler);
    return () => listeners.delete(handler);
  };

  return {
    ctx,
    tools,
    /** Emit one session event the way `Session.append` publishes it. */
    emit(session, event) {
      publication.active = true;
      try {
        for (const listener of [...listeners]) {
          try {
            listener(session, event);
          } catch (error) {
            contained.push(error);
          }
        }
      } finally {
        publication.active = false;
      }
    },
    listenerCount: () => listeners.size,
    /** Errors observers threw during publication, which the real session only logs. */
    contained,
  };
}

/**
 * Build a fake calling agent plus a tool execution context.
 *
 * @param sessionId - session the calling agent drives.
 * @param signal - caller cancellation signal.
 * @param pending - messages already sitting in the agent's inbox.
 * @param header - extra session header fields.
 */
function execFor(
  sessionId = 'session-me',
  signal = new AbortController().signal,
  pending = {},
  header = {},
) {
  const session = { id: sessionId, header: { id: sessionId, cwd: '/tmp/ws', ...header } };
  const removed = [];
  const inbox = {
    nextStep: pending.nextStep ?? [],
    nextTurn: pending.nextTurn ?? [],
    /** Mirror the real Inbox: remove by id from either list, reporting whether it was there. */
    remove(messageId) {
      for (const key of ['nextStep', 'nextTurn']) {
        const at = inbox[key].findIndex((message) => message.id === messageId);
        if (at === -1) continue;
        // A found message is removed with a logged splice, i.e. an append.
        if (publication.active) {
          throw new Error('session append cannot reenter while another append is being published');
        }
        inbox[key].splice(at, 1);
        removed.push(messageId);
        return true;
      }
      return false;
    },
  };
  return { agent: { id: sessionId, status: 'running', session, inbox }, signal, callId: 'call-1', removed };
}

/** One bus message in the shape `createBusMessage` builds. */
const busMessage = (senderSessionId, text, askId) => ({
  role: 'user',
  id: `msg-${text}`,
  source: {
    kind: 'peer-bus-message',
    form: 'relay',
    senderSessionId,
    ...(askId === undefined ? {} : { askId }),
  },
  content: [
    { type: 'text', text: `Agent ${senderSessionId} sent a message: ` },
    { type: 'text', text },
  ],
});

/** A delivery as the loop records it: an inbox splice. This is the first signal. */
const spliceEvent = (senderSessionId, text, target = 'next-turn') => ({
  type: 'agent/inbox/spliced',
  seq: 1,
  data: { target, start: 0, inserted: [busMessage(senderSessionId, text)] },
});

/** A delivery as the loop later appends it to the transcript. */
const busEvent = (senderSessionId, text) => ({
  type: 'user/message',
  seq: 2,
  data: busMessage(senderSessionId, text),
});

test('bus_wait resolves on an inbox splice, the first delivery signal', async () => {
  // The splice is what matters: it is recorded immediately, whereas the
  // transcript append only follows once the receiving turn reaches it.
  const { ctx, tools, emit } = harness();
  apply(ctx, new Config({}));
  const wait = tools.get('bus_wait');

  const promise = wait.execute({ timeoutMs: 5000 }, execFor('session-me'));
  emit({ id: 'session-me' }, spliceEvent('session-sender', 'hello'));

  const result = await promise;
  assert.equal(result.received, true);
  assert.equal(result.from, 'session-sender');
  assert.match(result.text, /hello/);
});

test('bus_wait also resolves on the later transcript append', async () => {
  const { ctx, tools, emit } = harness();
  apply(ctx, new Config({}));
  const wait = tools.get('bus_wait');

  const promise = wait.execute({ timeoutMs: 5000 }, execFor('session-me'));
  emit({ id: 'session-me' }, busEvent('session-sender', 'appended'));

  const result = await promise;
  assert.equal(result.from, 'session-sender');
  assert.match(result.text, /appended/);
});

test('bus_wait returns immediately for a message already pending in the inbox', async () => {
  // The caller is inside a turn, so an earlier delivery is parked in the inbox and
  // has no transcript append yet. Without this check the tool would time out.
  const { ctx, tools } = harness();
  apply(ctx, new Config({}));
  const wait = tools.get('bus_wait');

  const pending = busMessage('session-early', 'arrived before the wait');
  const result = await wait.execute(
    { timeoutMs: 5000 },
    execFor('session-me', new AbortController().signal, { nextTurn: [pending] }),
  );
  assert.equal(result.received, true);
  assert.equal(result.from, 'session-early');
  assert.match(result.text, /arrived before the wait/);
});

test('bus_wait ignores foreign sources in the inbox and in events', async () => {
  const { ctx, tools, emit } = harness();
  apply(ctx, new Config({}));
  const wait = tools.get('bus_wait');

  // dsh-subagent traffic shares the shape but not the kind; a plain user message
  // is not bus traffic either.
  const foreign = [
    { role: 'user', id: 'x', source: { kind: 'agent-message', form: 'relay', senderSessionId: 's' }, content: [] },
    { role: 'user', id: 'y', source: { kind: 'user' }, content: [] },
  ];
  const promise = wait.execute(
    { timeoutMs: 30 },
    execFor('session-me', new AbortController().signal, { nextStep: foreign, nextTurn: foreign }),
  );
  emit({ id: 'session-me' }, { type: 'user/message', data: foreign[0] });
  emit({ id: 'session-me' }, { type: 'agent/inbox/spliced', data: { target: 'next-turn', inserted: foreign } });

  const result = await promise;
  assert.equal(result.received, false, 'foreign traffic must not satisfy a bus wait');
});

test('bus_wait resolves on a delivered bus message for this session', async () => {
  const { ctx, tools, emit } = harness();
  apply(ctx, new Config({}));
  const wait = tools.get('bus_wait');

  const promise = wait.execute({ timeoutMs: 5000 }, execFor('session-me'));
  // A different session's event must not satisfy this waiter.
  emit({ id: 'session-other' }, busEvent('session-sender', 'not for you'));
  // A non-bus message must not satisfy it either.
  emit({ id: 'session-me' }, { type: 'user/message', data: { source: { kind: 'user' }, content: [] } });
  emit({ id: 'session-me' }, busEvent('session-sender', 'hello'));

  const result = await promise;
  assert.equal(result.received, true);
  assert.equal(result.from, 'session-sender');
  assert.match(result.text, /hello/);
});

test('bus_wait honours the from filter', async () => {
  const { ctx, tools, emit } = harness();
  apply(ctx, new Config({}));
  const wait = tools.get('bus_wait');

  const promise = wait.execute({ from: 'session-wanted', timeoutMs: 5000 }, execFor());
  // `from` is resolved against the roster before the listener subscribes.
  await new Promise((resolve) => setImmediate(resolve));
  emit({ id: 'session-me' }, busEvent('session-unwanted', 'ignore me'));
  emit({ id: 'session-me' }, busEvent('session-wanted', 'accept me'));

  const result = await promise;
  assert.equal(result.from, 'session-wanted');
  assert.match(result.text, /accept me/);
});

test('bus_wait reports a timeout and detaches its listener', async () => {
  const { ctx, tools, listenerCount } = harness();
  apply(ctx, new Config({}));
  const wait = tools.get('bus_wait');

  const result = await wait.execute({ timeoutMs: 20 }, execFor());
  assert.equal(result.received, false);
  assert.equal(listenerCount(), 0, 'the listener must be released on timeout');
});

test('bus_wait rejects on an already-aborted signal instead of hanging', async () => {
  const { ctx, tools } = harness();
  apply(ctx, new Config({}));
  const wait = tools.get('bus_wait');

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => wait.execute({ timeoutMs: 5000 }, execFor('session-me', controller.signal)),
    /cancelled/,
  );
});

test('bus_wait rejects and detaches when cancelled mid-wait', async () => {
  const { ctx, tools, listenerCount } = harness();
  apply(ctx, new Config({}));
  const wait = tools.get('bus_wait');

  const controller = new AbortController();
  const promise = wait.execute({ timeoutMs: 5000 }, execFor('session-me', controller.signal));
  assert.equal(listenerCount(), 1);
  controller.abort();
  await assert.rejects(() => promise, /cancelled/);
  assert.equal(listenerCount(), 0);
});

test('bus_wait requires a calling agent', async () => {
  const { ctx, tools } = harness();
  apply(ctx, new Config({}));
  const wait = tools.get('bus_wait');

  await assert.rejects(
    () => wait.execute({}, { signal: new AbortController().signal }),
    /requires a calling agent/,
  );
});

test('bus_send rejects a caller with no agent', async () => {
  const { ctx, tools } = harness();
  apply(ctx, new Config({}));
  const send = tools.get('bus_send');

  await assert.rejects(
    () => send.execute({ target: 'x', text: 'y' }, { signal: new AbortController().signal }),
    /requires a calling agent/,
  );
});

test('bus_send surfaces the bus error code, checking liveness before permission', async () => {
  const exec = execFor();
  // The sender must be live (liveness is checked first) and the target must be
  // addressable, so resolution succeeds and default-deny is what rejects the call.
  const target = { ...execFor('session-other').agent, followup() {}, steer() {} };
  const { ctx, tools } = harness({ liveAgents: [exec.agent, target] });
  apply(ctx, new Config({}));
  const send = tools.get('bus_send');

  await assert.rejects(
    () => send.execute({ target: 'session-other', text: 'y' }, exec),
    /denied/,
  );
});

test('bus_send rejects an unregistered sender as unauthorized', async () => {
  const { ctx, tools } = harness();
  apply(ctx, new Config({}));
  const send = tools.get('bus_send');

  await assert.rejects(
    () => send.execute({ target: 'session-other', text: 'y' }, execFor()),
    /unauthorized/,
  );
});

test('bus_roster shows the caller its own row even when nothing else is reachable', async () => {
  const { ctx, tools } = harness();
  apply(ctx, new Config({}));
  const roster = tools.get('bus_roster');

  const value = await roster.execute({}, execFor());
  assert.deepEqual(value.sessions, [
    { id: 'session-me', live: true, status: 'running', cwd: '/tmp/ws', subagent: false, self: true, allowed: false },
  ]);
  const rendered = roster.output.render({}, value);
  assert.equal(rendered[0].type, 'text');
  assert.match(rendered[0].text, /session-me.*\[you\]/);
});

test('bus_roster hides sessions the caller may not message by default', async () => {
  const me = execFor('session-me');
  const peer = execFor('session-peer').agent;
  const stranger = execFor('session-stranger', undefined, {}, { cwd: '/tmp/other-project' }).agent;
  const child = execFor('session-child', undefined, {}, { origin: 'subagent', delegationDepth: 1 }).agent;
  const { ctx, tools } = harness({ liveAgents: [me.agent, peer, stranger, child] });
  apply(ctx, new Config({ allow: [{ sameWorkspace: true }] }));

  const value = await tools.get('bus_roster').execute({}, me);
  // The other project's session and the same-workspace subagent are not reachable.
  assert.deepEqual(value.sessions.map((row) => row.id), ['session-me', 'session-peer']);
  assert.equal(value.sessions[1].allowed, true);
  assert.ok(!JSON.stringify(value).includes('/tmp/other-project'), 'no foreign workspace path leaks');
});

test('rosterScope all lists every session, flagging what the caller may message', async () => {
  const me = execFor('session-me');
  const peer = execFor('session-peer').agent;
  const stranger = execFor('session-stranger', undefined, {}, { cwd: '/tmp/other-project' }).agent;
  const child = execFor('session-child', undefined, {}, { origin: 'subagent', delegationDepth: 1 }).agent;
  const { ctx, tools } = harness({ liveAgents: [me.agent, peer, stranger, child] });
  apply(ctx, new Config({ allow: [{ sameWorkspace: true }], rosterScope: 'all' }));
  const roster = tools.get('bus_roster');

  const value = await roster.execute({}, me);
  const byId = Object.fromEntries(value.sessions.map((row) => [row.id, row]));
  assert.equal(value.sessions.length, 4);
  assert.equal(byId['session-peer'].allowed, true);
  assert.equal(byId['session-stranger'].allowed, false);
  assert.equal(byId['session-child'].allowed, false);
  assert.equal(byId['session-child'].subagent, true);
  const text = roster.output.render({}, value)[0].text;
  assert.match(text, /session-child.*subagent, not-allowed/);
});

test('bus_roster requires a calling agent', async () => {
  const { ctx, tools } = harness();
  apply(ctx, new Config({}));

  await assert.rejects(
    () => tools.get('bus_roster').execute({}, { signal: new AbortController().signal }),
    /requires a calling agent/,
  );
});

test('bus_wait returns the body without re-framing the attribution prefix', async () => {
  // The renderer already says "Message from <id>: ", and createBusMessage frames
  // the body with "Agent <id> sent a message: " for the transcript. Returning both
  // would double the framing in the result the model reads.
  const { ctx, tools } = harness();
  apply(ctx, new Config({}));
  const wait = tools.get('bus_wait');

  const pending = busMessage('session-sender', 'the actual body');
  const result = await wait.execute(
    { timeoutMs: 5000 },
    execFor('session-me', new AbortController().signal, { nextTurn: [pending] }),
  );
  assert.equal(result.text, 'the actual body');
  assert.ok(!result.text.includes('sent a message'), 'the attribution prefix must be stripped');
});

test('bus_wait consumes a pending message so it cannot also run as a turn', async () => {
  const { ctx, tools } = harness();
  apply(ctx, new Config({}));
  const wait = tools.get('bus_wait');

  const pending = busMessage('session-sender', 'take me');
  const exec = execFor('session-me', new AbortController().signal, { nextTurn: [pending] });
  const result = await wait.execute({ timeoutMs: 5000 }, exec);

  assert.equal(result.text, 'take me');
  // The removal is what stops the queued turn from delivering the same content again.
  assert.deepEqual(exec.removed, [pending.id]);
  assert.equal(exec.agent.inbox.nextTurn.length, 0);
});


test('bus_wait with askId takes only the late answer to that question', async () => {
  // A caller whose bus_ask came back 'pending' has an askId, and a busy inbox may
  // hold unrelated traffic by the time the answer lands. The filter is what keeps
  // it from taking the wrong message.
  const { ctx, tools, emit } = harness();
  apply(ctx, new Config({}));
  const wait = tools.get('bus_wait');

  const unrelated = busMessage('session-other', 'unrelated traffic');
  const answer = busMessage('session-target', 'the late answer', 'ask-abc-1');
  const exec = execFor('session-me', new AbortController().signal, { nextTurn: [unrelated, answer] });
  const result = await wait.execute({ askId: 'ask-abc-1', timeoutMs: 5000 }, exec);

  assert.equal(result.received, true);
  assert.equal(result.text, 'the late answer');
  assert.equal(result.askId, 'ask-abc-1');
  // The unrelated message is still pending: the filter must not consume it.
  assert.deepEqual(exec.agent.inbox.nextTurn.map((message) => message.id), ['msg-unrelated traffic']);
});

test('bus_wait with an askId that never arrives reports a timeout, not someone else\'s message', async () => {
  const { ctx, tools } = harness();
  apply(ctx, new Config({}));
  const wait = tools.get('bus_wait');

  const other = busMessage('session-target', 'a different answer', 'ask-other-9');
  const exec = execFor('session-me', new AbortController().signal, { nextTurn: [other] });
  const result = await wait.execute({ askId: 'ask-abc-1', timeoutMs: 1 }, exec);

  assert.equal(result.received, false);
  assert.deepEqual(exec.agent.inbox.nextTurn.map((message) => message.id), ['msg-a different answer']);
});

test('bus_wait consumes a message that arrives on the splice', async () => {
  // Regression: the listener runs while the delivering append is still being
  // published. Removing inline threw inside the (contained) observer after the
  // timer and abort hook were already detached, so the call never settled.
  const { ctx, tools, emit, contained } = harness();
  apply(ctx, new Config({}));
  const wait = tools.get('bus_wait');

  const arriving = busMessage('session-sender', 'mid-wait');
  const exec = execFor('session-me', new AbortController().signal, { nextTurn: [] });
  const promise = wait.execute({ timeoutMs: 5000 }, exec);
  // The delivery lands in the inbox and is published in the same append.
  exec.agent.inbox.nextTurn.push(arriving);
  emit({ id: 'session-me' }, {
    type: 'agent/inbox/spliced',
    data: { target: 'next-turn', start: 0, inserted: [arriving] },
  });

  const result = await promise;
  assert.equal(result.text, 'mid-wait');
  assert.deepEqual(exec.removed, [arriving.id], 'taken out of the inbox after the append unwound');
  assert.deepEqual(contained, [], 'the observer must not throw inside the publishing append');
});

test('bus_wait rejects instead of hanging when taking the message fails', async () => {
  const { ctx, tools, emit } = harness();
  apply(ctx, new Config({}));
  const wait = tools.get('bus_wait');

  const exec = execFor('session-me');
  exec.agent.inbox.remove = () => {
    throw new Error('inbox exploded');
  };
  const promise = wait.execute({ timeoutMs: 5000 }, exec);
  emit({ id: 'session-me' }, spliceEvent('session-sender', 'boom'));

  await assert.rejects(() => promise, /inbox exploded/);
});

test('bus_wait caps timeoutMs at maxWaitMs and clamps negatives to zero', async () => {
  const { ctx, tools, listenerCount } = harness();
  apply(ctx, new Config({ maxWaitMs: 20 }));
  const wait = tools.get('bus_wait');

  const started = Date.now();
  // Above 2^31-1 a raw setTimeout would fire at once; above maxWaitMs it would
  // hold the turn open for as long as the model asked.
  const capped = await wait.execute({ timeoutMs: 1e12 }, execFor());
  assert.equal(capped.received, false);
  assert.ok(Date.now() - started < 2000, 'a huge timeout is capped');

  const negative = await wait.execute({ timeoutMs: -5 }, execFor());
  assert.equal(negative.received, false);
  assert.equal(listenerCount(), 0);
});

test('bus_wait defaults to waitTimeoutMs rather than the rate window', async () => {
  const { ctx, tools } = harness();
  apply(ctx, new Config({ waitTimeoutMs: 20, rateWindowMs: 60000 }));
  const wait = tools.get('bus_wait');

  const started = Date.now();
  const result = await wait.execute({}, execFor());
  assert.equal(result.received, false);
  assert.ok(Date.now() - started < 2000);
});

test('bus_wait resolves a from prefix the way bus_send resolves a target', async () => {
  const me = execFor('session-me');
  const sender = execFor('session-wanted-123').agent;
  const other = execFor('session-other-9').agent;
  const { ctx, tools, emit } = harness({ liveAgents: [me.agent, sender, other] });
  apply(ctx, new Config({}));
  const wait = tools.get('bus_wait');

  const promise = wait.execute({ from: 'session-wanted', timeoutMs: 5000 }, me);
  await new Promise((resolve) => setImmediate(resolve));
  emit({ id: 'session-me' }, busEvent('session-other-9', 'ignore me'));
  emit({ id: 'session-me' }, busEvent('session-wanted-123', 'accept me'));

  const result = await promise;
  assert.equal(result.from, 'session-wanted-123');
  assert.match(result.text, /accept me/);

  await assert.rejects(
    () => wait.execute({ from: 'session-', timeoutMs: 20 }, me),
    /ambiguous-target/,
  );
});

test('bus_wait still reports a message the loop already claimed', async () => {
  const { ctx, tools, emit } = harness();
  apply(ctx, new Config({}));
  const wait = tools.get('bus_wait');

  // The transcript append means the loop consumed it at a step boundary, so the
  // inbox removal finds nothing. The content is still worth reporting.
  const claimed = busMessage('session-sender', 'already claimed');
  const exec = execFor('session-me');
  const promise = wait.execute({ timeoutMs: 5000 }, exec);
  emit({ id: 'session-me' }, { type: 'user/message', data: claimed });

  const result = await promise;
  assert.equal(result.received, true);
  assert.equal(result.text, 'already claimed');
  assert.deepEqual(exec.removed, [], 'nothing was pending to remove');
});

test('bus_wait leaves other sessions and foreign traffic untouched', async () => {
  const { ctx, tools } = harness();
  apply(ctx, new Config({}));
  const wait = tools.get('bus_wait');

  const mine = busMessage('session-sender', 'mine');
  const foreign = {
    role: 'user',
    id: 'foreign',
    source: { kind: 'agent-message', form: 'relay', senderSessionId: 'session-sub' },
    content: [{ type: 'text', text: 'from a subagent' }],
  };
  const exec = execFor('session-me', new AbortController().signal, {
    nextTurn: [foreign, mine],
  });
  const result = await wait.execute({ timeoutMs: 5000 }, exec);

  assert.equal(result.text, 'mine');
  assert.deepEqual(exec.removed, [mine.id], 'only our own message is taken');
  assert.deepEqual(exec.agent.inbox.nextTurn, [foreign], 'subagent traffic is left in place');
});

test('bus_wait never takes a bus_ask question that a caller is blocked on', async () => {
  // The question belongs to the asker's in-flight bus_ask: its answer is read from
  // the turn that claims it. If bus_wait consumed it instead, no turn would ever
  // claim it — the asker would see "discarded" (the removal is a discard) or wait
  // out its whole timeout, and the question would never be answered.
  const { ctx, tools } = harness();
  apply(ctx, new Config({}));
  const bus = ctx.get('peerBus');
  bus.asks.pending.set('ask-q', {
    askId: 'ask-q',
    askerId: 'session-asker',
    targetId: 'session-me',
    answer: [],
    settled: false,
  });
  const question = busMessage('session-asker', 'what is the build status?', 'ask-q');
  const exec = execFor('session-me', new AbortController().signal, { nextTurn: [question] });

  const result = await tools.get('bus_wait').execute({ timeoutMs: 20 }, exec);
  assert.equal(result.received, false, 'the question must be left for the turn that answers it');
  assert.deepEqual(exec.removed, []);
  assert.deepEqual(exec.agent.inbox.nextTurn, [question]);
});

test('bus_wait still takes a late answer to the caller\'s own pending ask', async () => {
  // The other direction of the same askId: an answer delivered to the asker after
  // its bus_ask reported "pending". That one is exactly what bus_wait is for.
  const { ctx, tools } = harness();
  apply(ctx, new Config({}));
  const answer = busMessage('session-target', 'build is green', 'ask-late');
  const exec = execFor('session-me', new AbortController().signal, { nextTurn: [answer] });

  const result = await tools.get('bus_wait').execute({ askId: 'ask-late', timeoutMs: 20 }, exec);
  assert.equal(result.received, true);
  assert.equal(result.text, 'build is green');
});

test('a message bus_wait takes reports received, not the discard its removal causes', async () => {
  // Removing a pending message is logged as a discard, and the receipt book hears
  // that discard. The receipt must already say "received" by then.
  const { ctx, tools } = harness();
  apply(ctx, new Config({}));
  const bus = ctx.get('peerBus');
  const message = busMessage('session-sender', 'take me');
  bus.receipts.record(message, 'session-sender', 'session-me');
  const exec = execFor('session-me', new AbortController().signal, { nextTurn: [message] });

  const result = await tools.get('bus_wait').execute({ timeoutMs: 20 }, exec);
  assert.equal(result.received, true);
  bus.receipts.onDiscarded({ message }); // what the real inbox removal emits
  assert.equal(bus.receipts.statusFor(message.id, 'session-sender').status, 'received');
});

test('bus_wait returns a late answer without its framing', async () => {
  const { ctx, tools } = harness();
  apply(ctx, new Config({}));
  const { createBusMessage } = await import('../src/message.js');
  const late = createBusMessage('session-target', 'build is green', { askId: 'ask-z', role: 'answer' });
  const exec = execFor('session-me', new AbortController().signal, { nextTurn: [late] });

  const result = await tools.get('bus_wait').execute({ askId: 'ask-z', timeoutMs: 20 }, exec);
  assert.equal(result.text, 'build is green');
  assert.equal(result.askId, 'ask-z');
});
