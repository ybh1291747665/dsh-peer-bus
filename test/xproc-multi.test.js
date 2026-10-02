/**
 * Cross-process behaviour that needs more than two processes, or needs two of them
 * to want the same thing at the same time.
 *
 * The two-process tests cannot reach either: a wait cycle that spans three processes
 * has no single process that can see the whole loop, and a race is only a race when
 * the contenders are genuinely independent.
 *
 * Three buses over one `DSH_HOME`, each with its own endpoint and its own agents, so
 * every hop here is a real socket and a real registry lookup.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaimBook } from '../src/xproc/claims.js';
import { baseConfig, fakeAgent, fakeCtx, makeBus } from './helpers.js';

const originalHome = process.env.DSH_HOME;
const home = await mkdtemp(join(tmpdir(), 'peer-bus-xproc-multi-'));
process.env.DSH_HOME = home;

test.after(async () => {
  if (originalHome === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = originalHome;
  await rm(home, { recursive: true, force: true });
});

const ALLOW_ALL = [
  { from: 'session-a', to: 'session-b' },
  { from: 'session-a', to: 'session-c' },
  { from: 'session-b', to: 'session-a' },
  { from: 'session-b', to: 'session-c' },
  { from: 'session-c', to: 'session-a' },
  { from: 'session-c', to: 'session-b' },
];

/**
 * Build `count` buses over the shared home, each with one live agent.
 *
 * @param count - how many processes to simulate.
 * @returns the buses and agents, keyed by letter, plus a disposer.
 */
async function fleet(count) {
  const letters = ['a', 'b', 'c', 'd'].slice(0, count);
  const built = [];
  for (const letter of letters) {
    const agent = fakeAgent(`session-${letter}`);
    const bus = makeBus(
      fakeCtx({ liveAgents: [agent] }).ctx,
      baseConfig({ crossProcess: true, allow: ALLOW_ALL }),
    );
    built.push({ letter, agent, bus });
  }
  // Discovery is eventually consistent; state the precondition rather than sleep.
  await Promise.all(built.map((entry) => entry.bus.xproc()));
  return {
    ...Object.fromEntries(built.map((entry) => [entry.letter, entry.bus])),
    agent: Object.fromEntries(built.map((entry) => [entry.letter, entry.agent])),
    dispose: async () => {
      for (const entry of built) await entry.bus.dispose();
    },
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('with three processes, each one sees both of the others as remote', async () => {
  const fleetOf = await fleet(3);
  try {
    const rows = await fleetOf.a.roster();
    for (const id of ['session-b', 'session-c']) {
      const row = rows.find((entry) => entry.id === id);
      assert.equal(row?.host, 'remote', `${id} must be reported as held elsewhere`);
      assert.equal(row?.live, true);
    }
    // And the view is symmetric.
    const fromC = await fleetOf.c.roster();
    assert.equal(fromC.find((entry) => entry.id === 'session-a')?.host, 'remote');
  } finally {
    await fleetOf.dispose();
  }
});

test('a send reaches a session held by the third process', async () => {
  const fleetOf = await fleet(3);
  try {
    const result = await fleetOf.a.send(fleetOf.agent.a, { target: 'session-c', text: 'three hops' }, {});
    assert.equal(result.targetState, 'remote');
    assert.equal(fleetOf.agent.c.delivered.length, 1, 'the third process must have received it');
  } finally {
    await fleetOf.dispose();
  }
});

test('a wait cycle spanning three processes is refused', async () => {
  // A waits on B, B waits on C, C asks A. No single process can see the whole loop:
  // A's graph has only A→B, B's only B→C, and C's nothing at all. It is detectable
  // only because each receiver records the wait edges the question implies and
  // reports them onward.
  const fleetOf = await fleet(3);
  try {
    const first = fleetOf.a.asks.ask(fleetOf.agent.a, { target: 'session-b', text: 'a→b', timeoutMs: 2000 });
    await sleep(90);
    assert.equal(fleetOf.agent.b.delivered.length, 1, 'the first hop must land');

    const second = fleetOf.b.asks.ask(fleetOf.agent.b, { target: 'session-c', text: 'b→c', timeoutMs: 2000 });
    await sleep(90);
    assert.equal(fleetOf.agent.c.delivered.length, 1, 'the second hop must land');

    const error = await fleetOf.c.asks
      .ask(fleetOf.agent.c, { target: 'session-a', text: 'c→a', timeoutMs: 300 }, {})
      .catch((thrown) => thrown);
    assert.equal(error?.code, 'ask-cycle', `expected ask-cycle, got ${error?.code ?? error?.message}`);
    assert.equal(fleetOf.agent.a.delivered.length, 0, 'a refused cycle must not reach an inbox');

    await first;
    await second;
  } finally {
    await fleetOf.dispose();
  }
});

test('the edges a question implies are released when it settles', async () => {
  // A proxy that keeps its edges would leave a phantom "someone is blocked" behind,
  // and a later, perfectly legal question would be refused for a deadlock that no
  // longer exists.
  const fleetOf = await fleet(2);
  try {
    // A asks B and gives up, so B holds a proxy whose edges must go with it.
    const asked = await fleetOf.a.asks.ask(fleetOf.agent.a, { target: 'session-b', text: 'ignored', timeoutMs: 80 }, {});
    assert.equal(asked.status, 'pending');
    await sleep(60);
    assert.ok(fleetOf.b.asks.waiting.has('session-a'), 'B must have recorded that A waits on it');

    // Release it the way a cancel would.
    assert.deepEqual(fleetOf.b.asks.cancelProxy(asked.askId), { cancelled: true });
    assert.equal(fleetOf.b.asks.waiting.has('session-a'), false, 'the edge must be gone with the proxy');

    // The same pair may now ask in the other direction without a phantom cycle.
    const back = await fleetOf.b.asks
      .ask(fleetOf.agent.b, { target: 'session-a', text: 'now legal', timeoutMs: 120 }, {})
      .catch((thrown) => thrown);
    assert.notEqual(back?.code, 'ask-cycle', `a released edge must not block: ${back?.code ?? back?.message}`);
  } finally {
    await fleetOf.dispose();
  }
});

test('two processes racing for one stored session leave exactly one owner', async () => {
  // Neither process holds it, so both try the local path. The log lock is what
  // arbitrates, and the loser must get a clean refusal rather than a second agent
  // over the same session.
  const stored = [{ id: 'session-contested', cwd: '/tmp/ws' }];
  const first = fakeCtx({ stored });
  // Matched by NAME, not by code: `dsh-session-persistence` is not a dependency of
  // this package, so the class cannot be imported and the manual resume path
  // identifies the lock conflict by the error's name.
  const second = fakeCtx({
    stored,
    resumeFails: true,
    resumeError: Object.assign(new Error('the log is held by another owner'), {
      name: 'SessionAlreadyOwnedError',
    }),
  });
  const busA = makeBus(first.ctx, baseConfig({ crossProcess: true, allow: ALLOW_ALL }));
  const busB = makeBus(second.ctx, baseConfig({ crossProcess: true, allow: ALLOW_ALL }));
  try {
    await Promise.all([busA.xproc(), busB.xproc()]);

    // Neither process holds the session, so both take the local path.
    const contender = (bus, id) =>
      bus
        .deliverLocal('session-contested', { id, source: { senderSessionId: 'session-a' } }, 'followup', {})
        .catch((error) => error);
    const winner = await contender(busA, 'm1');
    const loser = await contender(busB, 'm2');

    assert.equal(winner?.targetState, 'resumed', 'the first process must win the session');
    assert.equal(loser?.code, 'target-busy', `the loser must be refused cleanly, got ${loser?.code ?? loser?.message}`);
    assert.equal(first.resumedIds.length, 1, 'exactly one resume');
    assert.equal(second.resumedIds.length, 1, 'the loser attempted exactly one resume, and did not retry');
  } finally {
    await busA.dispose();
    await busB.dispose();
  }
});

test('answering a peer costs no persistence read', async () => {
  // A peer only needs to know what is held *here*. Making that answer scan every
  // stored session would make one `bus_send` do as many full scans as there are
  // peers, for rows that are then filtered away.
  const agent = fakeAgent('session-a');
  const fake = fakeCtx({ liveAgents: [agent] });
  const bus = makeBus(fake.ctx, baseConfig({ crossProcess: true, allow: ALLOW_ALL }));
  try {
    const persistence = fake.ctx.get('sessionPersistence');
    assert.notEqual(persistence, undefined, 'the fixture must provide one, or this proves nothing');
    persistence.list = () => {
      throw new Error('liveRows must not read persistence');
    };

    const rows = bus.liveRows();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, 'session-a');
    assert.equal(rows[0].live, true);

    // The patch is live: the full roster, which does need stored sessions, now fails.
    await assert.rejects(() => bus.roster(), /must not read persistence/);
  } finally {
    await bus.dispose();
  }
});

test('releasing an idle session gives its claim back', async () => {
  // A claim held for a session nobody owns any more blocks every process, including
  // the one that left it behind: `acquire` sees a live pid and refuses, and the
  // session can never be resumed again until that process restarts.
  const stored = [{ id: 'session-idle', cwd: '/tmp/ws' }];
  const fake = fakeCtx({ stored });
  const bus = makeBus(fake.ctx, baseConfig({ crossProcess: true, crossProcessRosterCacheMs: 0 }));
  try {
    const endpoint = await bus.xproc();
    const agent = fakeAgent('session-caller');
    // Resuming is what takes the claim.
    await bus.deliverWithClaim(
      { targetId: 'session-idle', message: { id: 'm1', source: { senderSessionId: agent.id } }, mode: 'followup' },
      {},
    );
    assert.notEqual(
      await endpoint.claims.ownerOf('session-idle'),
      undefined,
      'the resume must have taken the claim, or this proves nothing',
    );

    await bus.releaseIdle('session-idle');
    assert.equal(
      await endpoint.claims.ownerOf('session-idle'),
      undefined,
      'an idle release must give the claim back',
    );

    // And a second process must now be able to take it.
    const other = new ClaimBook({ home, endpointId: 'ep-other' });
    assert.deepEqual(await other.acquire('session-idle'), { acquired: true });
  } finally {
    await bus.dispose();
  }
});

test('a claim this process left behind is reclaimable by itself', async () => {
  // The safety net for a release path nobody has written yet: a claim naming this very
  // process, for a session this process is not running, is stale by definition.
  const book = new ClaimBook({ home, endpointId: 'ep-self' });
  await book.acquire('session-orphan');
  // Forget the in-memory handle, as a missed release path would.
  book.held.clear();
  const again = new ClaimBook({ home, endpointId: 'ep-self' });
  assert.deepEqual(
    await again.acquire('session-orphan'),
    { acquired: true },
    'our own stale claim must not block us',
  );
});
