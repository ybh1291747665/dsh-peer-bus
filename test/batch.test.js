/**
 * Batch delivery: several parts, one turn.
 *
 * A `followup` costs a whole turn, and a turn resends the target's entire context to
 * the model. So sending five updates as five messages costs five of those; sending
 * them as one batch costs one. These tests hold down that the batch really is a single
 * delivery, because that equivalence is the whole reason the feature exists.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
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

/** The text of every block in a delivered message. */
const blocksOf = (message) => message.content.map((block) => block.text);

test('a batch of five parts is delivered as one turn, not five', async () => {
  const { bus, sender, target } = harness();
  const parts = ['one', 'two', 'three', 'four', 'five'];

  const result = await bus.send(sender, { target: 'session-t', texts: parts }, {});

  assert.equal(target.delivered.length, 1, 'one delivery, so one turn');
  assert.equal(target.delivered[0].mode, 'followup');
  assert.equal(result.messageId !== undefined, true);

  const blocks = blocksOf(target.delivered[0].message);
  // A lead-in block, then one per part.
  assert.equal(blocks.length, parts.length + 1);
  for (const part of parts) {
    assert.equal(blocks.includes(part), true, `"${part}" survived the batch`);
  }
});

test('a single text is still one block, so nothing changes for the common case', async () => {
  const { bus, sender, target } = harness();

  await bus.send(sender, { target: 'session-t', text: 'just one' }, {});

  const blocks = blocksOf(target.delivered[0].message);
  assert.equal(blocks.length, 2, 'a lead-in and the body');
  assert.equal(blocks[1], 'just one');
});

test('the size ceiling measures the whole batch, not one part', async () => {
  // Five parts that are each small but add up past the limit must still be refused:
  // the ceiling exists to bound what the target has to read in one turn.
  const { bus, sender } = harness({ maxMessageBytes: 20 });

  const refused = await bus
    .send(sender, { target: 'session-t', texts: ['1234567890', '1234567890', '1234567890'] }, {})
    .catch((error) => error);

  assert.equal(refused?.code, 'message-too-large');
  assert.match(refused.message, /30 bytes/);
});

test('a blank part is refused rather than silently dropped', async () => {
  const { bus, sender, target } = harness();

  const refused = await bus
    .send(sender, { target: 'session-t', texts: ['fine', '   '] }, {})
    .catch((error) => error);

  assert.equal(refused?.code, 'invalid-text');
  assert.equal(target.delivered.length, 0, 'nothing was delivered');
});

test('an absurd batch is refused before it reaches the target', async () => {
  const { bus, sender, target } = harness();
  const tooMany = Array.from({ length: 51 }, (_value, index) => `part ${index}`);

  const refused = await bus
    .send(sender, { target: 'session-t', texts: tooMany }, {})
    .catch((error) => error);

  assert.equal(refused?.code, 'invalid-text');
  assert.match(refused.message, /at most 50 parts/);
  assert.equal(target.delivered.length, 0);
});

test('a batch can supersede a pending message like any other send', async () => {
  const { bus, sender, target } = harness();
  const stale = createStale(target);

  const result = await bus.send(
    sender,
    { target: 'session-t', texts: ['revised one', 'revised two'], supersede: true },
    {},
  );

  assert.equal(result.replaced, true);
  assert.equal(target.inbox.nextTurn.some((message) => message.id === stale.id), false);
  assert.equal(blocksOf(target.inbox.nextTurn[0]).includes('revised two'), true);
});

/**
 * Queue one bus message in the target's inbox as if delivered and not yet claimed.
 *
 * @param target - the receiving fake agent.
 * @returns the queued message.
 */
function createStale(target) {
  const message = {
    id: 'stale-1',
    content: [{ type: 'text', text: 'do A' }],
    source: { kind: 'peer-bus-message', form: 'relay', senderSessionId: 'session-s' },
  };
  target.inbox.nextTurn.push(message);
  return message;
}
