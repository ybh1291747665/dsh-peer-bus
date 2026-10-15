/**
 * Supersede: replacing an instruction the target has not started yet.
 *
 * This is a millisecond race in production — an idle target claims a message in about
 * 1 ms, a busy one took 3.7 s in a live check — which is exactly why it is tested here
 * rather than against a real session. The inbox is driven directly, so "still pending"
 * and "already claimed" are states a test can simply assert, with no timing at all.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createBusMessage } from '../src/message.js';
import { baseConfig, fakeAgent, fakeCtx, makeBus } from './helpers.js';

const allowAll = [{ from: '*', to: '*' }];

/**
 * One bus with a sender and an idle live target.
 *
 * @param overrides - config keys to override.
 * @returns the bus and both agents.
 */
function harness(overrides = {}) {
  const sender = fakeAgent('session-s');
  const target = fakeAgent('session-t');
  const ctx = fakeCtx({ liveAgents: [sender, target] });
  const bus = makeBus(ctx.ctx, baseConfig({ allow: allowAll, ...overrides }));
  return { bus, sender, target };
}

/**
 * Put a bus message in the target's inbox as if it had been delivered and not yet
 * claimed. The fixture's `followup` deliberately does not queue, so this is how a test
 * says "the target has not got to this yet".
 *
 * @param target - the receiving fake agent.
 * @param senderId - who sent it.
 * @param text - the body.
 * @param options - forwarded to the message builder, e.g. an `askId`.
 * @returns the queued message.
 */
function queue(target, senderId, text, options) {
  const message = createBusMessage(senderId, text, options);
  target.inbox.nextTurn.push(message);
  return message;
}

test('supersede replaces a message that is still pending', async () => {
  const { bus, sender, target } = harness();
  const stale = queue(target, 'session-s', 'do A');

  const result = await bus.send(sender, { target: 'session-t', text: 'do not do A', supersede: true }, {});

  assert.equal(result.replaced, true);
  assert.equal(target.inbox.nextTurn.length, 1, 'the queue did not grow');
  assert.equal(target.inbox.nextTurn[0].id, result.messageId, 'the replacement took its place');
  assert.equal(
    target.inbox.nextTurn.some((message) => message.id === stale.id),
    false,
    'the superseded message is gone, so the target can never start it',
  );
  // A replacement is placed in the queue rather than handed to followup, so it is not
  // recorded as a delivery — the queue edit is the delivery. No extra wake is needed:
  // the append that put the original there had already woken the driver, and a pending
  // message is claimed in about a millisecond.
  assert.equal(target.delivered.length, 0);
});

test('supersede replaces the newest pending message, not the oldest', async () => {
  const { bus, sender, target } = harness();
  const first = queue(target, 'session-s', 'step one');
  const second = queue(target, 'session-s', 'step two');

  await bus.send(sender, { target: 'session-t', text: 'revised step two', supersede: true }, {});

  const pending = target.inbox.nextTurn.map((message) => message.id);
  assert.deepEqual(pending.length, 2);
  assert.equal(pending.includes(first.id), true, 'the older message is untouched');
  assert.equal(pending.includes(second.id), false, 'the newest one was the one replaced');
});

test('supersede only replaces this sender own messages', async () => {
  const { bus, sender, target } = harness();
  const other = queue(target, 'session-other', 'from someone else');

  const result = await bus.send(sender, { target: 'session-t', text: 'mine', supersede: true }, {});

  assert.equal(result.replaced, false, 'another session queue is not ours to rewrite');
  assert.equal(target.inbox.nextTurn.some((message) => message.id === other.id), true);
});

test('supersede appends when the previous message was already claimed', async () => {
  // Nothing pending means nothing to replace — a message already being worked on
  // cannot be unsent. This is the ordinary case on an idle target.
  const { bus, sender, target } = harness();

  const result = await bus.send(sender, { target: 'session-t', text: 'first', supersede: true }, {});

  assert.equal(result.replaced, false);
  assert.equal(target.delivered.length, 1);
});

test('supersede never touches a question, because the answer is correlated to it', async () => {
  // Replacing a pending question would orphan the ask on the asking side: the answer
  // is matched to the ask id carried by that exact message.
  const { bus, sender, target } = harness();
  const question = queue(target, 'session-s', 'what is the status?', { askId: 'ask-1', role: 'question' });

  const incoming = createBusMessage('session-s', 'a plain message', { askId: 'ask-1' });
  const result = await bus.deliverLocal('session-t', incoming, 'followup', { supersede: true });

  assert.equal(result.replaced, false);
  assert.equal(target.inbox.nextTurn.some((message) => message.id === question.id), true);
});

test('pendingFromYou reports how deep this sender queue has grown', async () => {
  const { bus, sender, target } = harness();
  queue(target, 'session-s', 'one');
  queue(target, 'session-s', 'two');
  queue(target, 'session-other', 'not mine');

  const result = await bus.send(sender, { target: 'session-t', text: 'three' }, {});

  // The fixture records a delivery without queueing it, so this counts the three
  // already pending; against a real driver it would include the new one as well.
  assert.equal(result.pendingFromYou, 2, 'only this sender messages are counted');
});

test('maxPendingPerPair refuses a send that would deepen the queue further', async () => {
  const { bus, sender, target } = harness({ maxPendingPerPair: 2 });
  queue(target, 'session-s', 'one');
  queue(target, 'session-s', 'two');

  const refused = await bus
    .send(sender, { target: 'session-t', text: 'three' }, {})
    .catch((error) => error);

  assert.equal(refused?.code, 'target-backlog');
  assert.match(refused.message, /supersede: true/, 'the error says how to get through anyway');
  assert.equal(target.inbox.nextTurn.length, 2, 'nothing was queued');
});

test('supersede is allowed through a full queue, because it does not deepen it', async () => {
  const { bus, sender, target } = harness({ maxPendingPerPair: 2 });
  queue(target, 'session-s', 'one');
  const stale = queue(target, 'session-s', 'two');

  const result = await bus.send(sender, { target: 'session-t', text: 'revised two', supersede: true }, {});

  assert.equal(result.replaced, true);
  assert.equal(target.inbox.nextTurn.length, 2, 'still two, so the ceiling is not what it guards');
  assert.equal(target.inbox.nextTurn.some((message) => message.id === stale.id), false);
});

test('the superseded message is reported as discarded, not as claimed', async () => {
  // The receipt book learns about the replacement from the inbox's own discarded
  // event, so the sender can see that its earlier instruction never ran.
  const { bus, sender, target } = harness();
  const stale = queue(target, 'session-s', 'do A');

  await bus.send(sender, { target: 'session-t', text: 'do not do A', supersede: true }, {});

  // The fixture cannot dispatch the inbox's own event, so what is asserted here is the
  // mutation that produces it: the bus asked the inbox to drop that exact message.
  assert.deepEqual(target.inbox.discarded, [stale.id]);
});
