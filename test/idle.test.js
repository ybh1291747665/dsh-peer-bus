/**
 * Tests for releasing idle cold-resumed agents (`resumedIdleMs`).
 *
 * A session the bus resumed itself used to stay loaded — holding its log lock —
 * for the life of the plugin. These pin when it is released, when it must not be,
 * and that a send racing a release still lands in a live agent.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { baseConfig, fakeAgent, fakeCtx, makeBus } from './helpers.js';

const IDLE = 1000;
const allowAll = { allow: [{ from: '*', to: '*' }] };

/**
 * A bus that has cold-resumed `session-cold` on the manual path.
 *
 * @param overrides - policy overrides.
 * @param ctxOptions - extra fixture options.
 * @returns the bus, the fixture, the sender, and the resumed agent.
 */
async function resumedHarness(overrides = {}, ctxOptions = {}) {
  const sender = fakeAgent('session-s');
  const fixture = fakeCtx({ liveAgents: [sender], stored: [{ id: 'session-cold' }], ...ctxOptions });
  const bus = makeBus(fixture.ctx, baseConfig({ ...allowAll, resumedIdleMs: IDLE, ...overrides }));
  await bus.send(sender, { target: 'session-cold', text: 'wake up' });
  return { bus, fixture, sender, resumed: fixture.ctx.agents.get('session-cold') };
}

test('a resumed agent is released once it has been idle for resumedIdleMs', async () => {
  const { bus, fixture } = await resumedHarness();
  assert.equal(bus.owned.size, 1);
  assert.notEqual(bus.idleSweep, undefined, 'the sweep runs while something is owned');

  await bus.sweepIdle(Date.now() + IDLE + 1);
  assert.equal(fixture.state.disposed, 1);
  assert.equal(fixture.ctx.agents.get('session-cold'), undefined, 'the agent is unloaded');
  assert.equal(bus.owned.size, 0);
  assert.equal(bus.idleSweep, undefined, 'the sweep stops once nothing is owned');
  assert.equal(bus.activityOff, undefined, 'and so does its activity listener');
});

test('a resumed agent is kept before the idle period has elapsed', async () => {
  const { bus, fixture } = await resumedHarness();
  await bus.sweepIdle(Date.now() + IDLE - 100);
  assert.equal(fixture.state.disposed, 0);
  assert.equal(bus.owned.size, 1);
});

test('a running agent is kept, and its idle clock restarts', async () => {
  const { bus, fixture, resumed } = await resumedHarness();
  resumed.status = 'running';
  const later = Date.now() + IDLE * 5;
  await bus.sweepIdle(later);
  assert.equal(fixture.state.disposed, 0);

  // Back to idle: a full quiet period is needed again, measured from the last
  // time it was seen busy rather than from the original resume.
  resumed.status = 'idle';
  await bus.sweepIdle(later + IDLE - 1);
  assert.equal(fixture.state.disposed, 0);
  await bus.sweepIdle(later + IDLE);
  assert.equal(fixture.state.disposed, 1);
});

test('an agent with pending inbox work is kept', async () => {
  const { bus, fixture, resumed } = await resumedHarness();
  resumed.inbox = { hasPending: true };
  await bus.sweepIdle(Date.now() + IDLE * 5);
  assert.equal(fixture.state.disposed, 0);
});

test('an agent taking part in an unsettled ask is kept', async () => {
  const { bus, fixture } = await resumedHarness();
  bus.asks.pending.set('ask-1', { askId: 'ask-1', askerId: 'session-s', targetId: 'session-cold', settled: false });
  await bus.sweepIdle(Date.now() + IDLE * 5);
  assert.equal(fixture.state.disposed, 0);

  bus.asks.pending.delete('ask-1');
  await bus.sweepIdle(Date.now() + IDLE * 10);
  assert.equal(fixture.state.disposed, 1);
});

test('a message delivered to an owned agent restarts its idle clock', async () => {
  const { bus, fixture, sender } = await resumedHarness();
  const start = Date.now();
  bus.lastActivity.set('session-cold', start - IDLE * 2); // long idle already
  await bus.send(sender, { target: 'session-cold', text: 'still there?' });
  await bus.sweepIdle(Date.now() + IDLE - 100);
  assert.equal(fixture.state.disposed, 0);
});

test('a send racing a release waits for it and resumes the session again', async () => {
  const { bus, fixture, sender, resumed } = await resumedHarness();
  // A real agent's dispose is asynchronous — it drains the final turn before the
  // registry drops the agent — so model a release that is still in progress.
  const handle = bus.owned.get('session-cold');
  const realDispose = handle.dispose;
  handle.dispose = async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
    await realDispose();
  };
  const release = bus.sweepIdle(Date.now() + IDLE + 1); // not awaited: the race
  assert.equal(bus.releasing.has('session-cold'), true);
  assert.equal(fixture.ctx.agents.get('session-cold'), resumed, 'still registered mid-release');

  const result = await bus.send(sender, { target: 'session-cold', text: 'are you there?' });
  await release;
  assert.equal(result.targetState, 'resumed', 'the send resumed a fresh agent');
  assert.deepEqual(fixture.resumedIds, ['session-cold', 'session-cold']);
  const fresh = fixture.ctx.agents.get('session-cold');
  assert.notEqual(fresh, resumed);
  assert.match(fresh.delivered[0].message.content[1].text, /are you there/);
  assert.equal(resumed.delivered.length, 1, 'nothing reached the agent being released');
});

test('an owned agent unloaded behind the bus has its stale handle released', async () => {
  const { bus, fixture } = await resumedHarness();
  fixture.unload('session-cold');
  await bus.sweepIdle(Date.now()); // no idle period needed for a stale handle
  assert.equal(bus.owned.size, 0);
});

test('resumedIdleMs 0 keeps resumed agents loaded and runs no sweep', async () => {
  const { bus, fixture } = await resumedHarness({ resumedIdleMs: 0 });
  assert.equal(bus.idleSweep, undefined);
  assert.equal(bus.activityOff, undefined);
  await bus.sweepIdle(Date.now() + 10 ** 9);
  assert.equal(fixture.state.disposed, 0);
  assert.equal(bus.owned.size, 1);
});

test('a session resumed through the host lookup is host-owned and never released', async () => {
  const sender = fakeAgent('session-s');
  const hostAgent = fakeAgent('session-cold');
  const fixture = fakeCtx({
    liveAgents: [sender],
    stored: [{ id: 'session-cold' }],
    hostLookup: {
      resolve: async (id) => {
        fixture.install(hostAgent);
        return id === 'session-cold' ? hostAgent : undefined;
      },
    },
  });
  const bus = makeBus(fixture.ctx, baseConfig({ ...allowAll, resumedIdleMs: IDLE }));
  await bus.send(sender, { target: 'session-cold', text: 'wake' });
  assert.equal(bus.owned.size, 0);
  assert.equal(bus.idleSweep, undefined);
  await bus.sweepIdle(Date.now() + IDLE * 5);
  assert.equal(fixture.ctx.agents.get('session-cold'), hostAgent);
});

test('the sweep timer releases an idle agent on its own', async () => {
  const { bus, fixture } = await resumedHarness({ resumedIdleMs: 60 });
  const deadline = Date.now() + 2000;
  while (fixture.state.disposed === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(fixture.state.disposed, 1);
  assert.equal(bus.idleSweep, undefined);
});

test('dispose stops the sweep and releases what is still owned', async () => {
  const { bus, fixture } = await resumedHarness();
  await bus.dispose();
  assert.equal(bus.idleSweep, undefined);
  assert.equal(bus.activityOff, undefined);
  assert.equal(fixture.state.disposed, 1);
});
