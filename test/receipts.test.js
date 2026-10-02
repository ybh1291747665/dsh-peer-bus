/**
 * Tests for delivery receipts (`bus_status`).
 *
 * The ordering these pin matters most: an idle target claims a `followup`
 * synchronously, inside the `followup()` call itself, so a receipt has to exist
 * before the message is routed or it would miss its own claim.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import { Config, apply } from '../src/index.js';
import { ReceiptBook } from '../src/receipts.js';
import { baseConfig, fakeAgent, fakeCtx, makeBus } from './helpers.js';

/**
 * A bus over fake agents, with the inbox event seams the receipt book listens on.
 *
 * @param options - live agents and the allowlist.
 * @returns the bus and an emitter for the seams.
 */
function receiptHarness({ liveAgents = [], allow = [{ from: '*', to: '*' }] } = {}) {
  const { ctx } = fakeCtx({ liveAgents });
  const bus = makeBus(ctx, baseConfig({ allow }));
  const listening = bus.pluginCtx;
  const seams = new Map([
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
    bus,
    emit: (name, payload) => {
      for (const handler of [...(seams.get(name) ?? [])]) handler(payload);
    },
    seamSize: (name) => seams.get(name)?.size ?? 0,
  };
}

test('a message claimed synchronously inside followup still gets its claim', async () => {
  // This is how a real idle agent behaves: followup() wakes the driver, and the
  // driver claims its first batch before its first await.
  const sender = fakeAgent('session-a');
  const target = fakeAgent('session-b');
  let emit;
  target.followup = (message) => emit('agent/inbox/claimed', { message, turn: 7, agent: target });
  const harness = receiptHarness({ liveAgents: [sender, target] });
  emit = harness.emit;

  const { messageId } = await harness.bus.send(sender, { target: 'session-b', text: 'hi' });
  const status = harness.bus.receipts.statusFor(messageId, 'session-a');
  assert.equal(status.status, 'claimed');
  assert.equal(status.turn, 7);
  assert.equal(status.to, 'session-b');
  assert.ok(status.latencyMs >= 0);
});

test('a message to a busy target is queued until its turn claims it', async () => {
  const sender = fakeAgent('session-a');
  const target = fakeAgent('session-b', 'running');
  const { bus, emit } = receiptHarness({ liveAgents: [sender, target] });

  const { messageId } = await bus.send(sender, { target: 'session-b', text: 'later' });
  assert.equal(bus.receipts.statusFor(messageId, 'session-a').status, 'queued');
  assert.equal(bus.receipts.statusFor(messageId, 'session-a').settledAt, undefined);

  emit('agent/inbox/claimed', { message: target.delivered[0].message, turn: 3, agent: target });
  assert.equal(bus.receipts.statusFor(messageId, 'session-a').status, 'claimed');
});

test('a discarded message reports discarded, and a later claim cannot revive it', async () => {
  const sender = fakeAgent('session-a');
  const target = fakeAgent('session-b', 'running');
  const { bus, emit } = receiptHarness({ liveAgents: [sender, target] });

  const { messageId } = await bus.send(sender, { target: 'session-b', text: 'cancel me' });
  const message = target.delivered[0].message;
  emit('agent/inbox/discarded', { message, agent: target });
  emit('agent/inbox/claimed', { message, turn: 9, agent: target });
  assert.equal(bus.receipts.statusFor(messageId, 'session-a').status, 'discarded');
});

test('received survives the discard that bus_wait\'s own removal reports', () => {
  const book = new ReceiptBook(new Context());
  book.record({ id: 'm1' }, 'session-a', 'session-b');
  book.markReceived('m1');
  book.onDiscarded({ message: { id: 'm1' } });
  assert.equal(book.statusFor('m1', 'session-a').status, 'received');
});

test('only the sender can read a receipt; everyone else sees unknown', async () => {
  const sender = fakeAgent('session-a');
  const target = fakeAgent('session-b', 'running');
  const { bus } = receiptHarness({ liveAgents: [sender, target] });

  const { messageId } = await bus.send(sender, { target: 'session-b', text: 'private' });
  // The target, and any third party, get exactly the answer a bogus id gets.
  assert.deepEqual(bus.receipts.statusFor(messageId, 'session-b'), { messageId, status: 'unknown' });
  assert.deepEqual(bus.receipts.statusFor(messageId, 'session-x'), { messageId, status: 'unknown' });
  assert.deepEqual(bus.receipts.statusFor('no-such-id', 'session-a'), {
    messageId: 'no-such-id',
    status: 'unknown',
  });
});

test('a delivery that fails leaves no receipt behind', async () => {
  const sender = fakeAgent('session-a');
  const target = fakeAgent('session-b');
  target.followup = () => {
    throw new Error('session detached');
  };
  const { bus } = receiptHarness({ liveAgents: [sender, target] });

  await assert.rejects(
    () => bus.send(sender, { target: 'session-b', text: 'x' }),
    (error) => error.code === 'delivery-failed',
  );
  assert.equal(bus.receipts.receipts.size, 0);
});

test('the receipt book is bounded and forgets the oldest first', () => {
  const book = new ReceiptBook(new Context(), 3);
  for (const id of ['m1', 'm2', 'm3', 'm4']) book.record({ id }, 'session-a', 'session-b');
  assert.equal(book.statusFor('m1', 'session-a').status, 'unknown');
  assert.equal(book.statusFor('m4', 'session-a').status, 'queued');
  assert.equal(book.receipts.size, 3);
});

test('listeners are installed on the first receipt and released on dispose', async () => {
  const sender = fakeAgent('session-a');
  const target = fakeAgent('session-b', 'running');
  const { bus, seamSize } = receiptHarness({ liveAgents: [sender, target] });

  assert.equal(seamSize('agent/inbox/claimed'), 0, 'a bus that never sent listens to nothing');
  await bus.send(sender, { target: 'session-b', text: 'one' });
  await bus.send(sender, { target: 'session-b', text: 'two' });
  assert.equal(seamSize('agent/inbox/claimed'), 1);
  await bus.dispose();
  assert.equal(seamSize('agent/inbox/claimed'), 0);
  assert.equal(seamSize('agent/inbox/discarded'), 0);
});

test('bus_status reports through the tool, for the calling session only', async () => {
  const ctx = new Context();
  const tools = new Map();
  const sender = { id: 'session-a', status: 'idle', session: { id: 'session-a', header: { id: 'session-a', cwd: '/w' } } };
  ctx.provide('agents', { list: () => [sender], get: (id) => (id === 'session-a' ? sender : undefined) });
  ctx.provide('sessionPersistence', { list: async () => [] });
  ctx.provide('tools', {
    register(definition) {
      tools.set(definition.name, definition);
      return () => {};
    },
  });
  apply(ctx, new Config({}));
  const bus = ctx.get('peerBus');
  bus.receipts.record({ id: 'm1' }, 'session-a', 'session-b');

  const statusTool = tools.get('bus_status');
  const mine = await statusTool.execute({ messageId: 'm1' }, { agent: sender });
  assert.equal(mine.status, 'queued');
  assert.match(statusTool.output.render({}, mine)[0].text, /to session-b: queued/);

  const theirs = await statusTool.execute({ messageId: 'm1' }, { agent: { id: 'session-b' } });
  assert.equal(theirs.status, 'unknown');
  await assert.rejects(() => statusTool.execute({ messageId: 'm1' }, {}), /requires a calling agent/);
});
