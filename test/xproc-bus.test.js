/**
 * Tests for the bus over a real cross-process transport.
 *
 * Two bus instances in one process, each with its own endpoint and its own
 * agents, sharing one `DSH_HOME`. Everything except the OS process boundary is
 * real: the socket, the registry files, the handshake, the frames, and the
 * receiving side's own admission checks. The process boundary itself is covered
 * by `scripts/e2e-xproc.mjs` and by the registry's pid tests.
 *
 * `DSH_HOME` is redirected to a throwaway directory for the whole file. That is
 * not tidiness: the transport resolves the home from the environment, so a test
 * that forgot this would bind sockets inside the developer's real DSH home.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionBus, SessionBusError } from '../src/peer-bus.js';
import { baseConfig, fakeAgent, fakeCtx, makeBus } from './helpers.js';

/** The home the transport will resolve while this file runs. */
const originalHome = process.env.DSH_HOME;
const home = await mkdtemp(join(tmpdir(), 'peer-bus-xproc-bus-'));
process.env.DSH_HOME = home;

test.after(async () => {
  if (originalHome === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = originalHome;
  await rm(home, { recursive: true, force: true });
});

/**
 * Two buses over one shared home, each with its own live agent.
 *
 * @param options - allow rules per side.
 * @returns both buses, their agents, and a disposer.
 */
async function twoBuses({ allowA = [], allowB = [], cacheMs } = {}) {
  const agentA = fakeAgent('session-a');
  const agentB = fakeAgent('session-b');
  const a = fakeCtx({ liveAgents: [agentA] });
  const b = fakeCtx({ liveAgents: [agentB] });
  const cache = cacheMs === undefined ? {} : { crossProcessRosterCacheMs: cacheMs };
  const busA = makeBus(a.ctx, baseConfig({ crossProcess: true, allow: allowA, ...cache }));
  const busB = makeBus(b.ctx, baseConfig({ crossProcess: true, allow: allowB, ...cache }));
  // Discovery is eventually consistent: an endpoint publishes on construction but
  // a peer that started a moment later is only visible on the next roster. Every
  // test here states its precondition explicitly instead of sleeping.
  const ea = await busA.xproc();
  const eb = await busB.xproc();
  const peersA = await ea.peers();
  const peersB = await eb.peers();
  if (peersA.length !== 1 || peersB.length !== 1) {
    throw new Error(
      `DISCOVERY: A sees ${JSON.stringify(peersA.map((p) => p.endpointId))} (self ${ea.endpointId}), ` +
        `B sees ${JSON.stringify(peersB.map((p) => p.endpointId))} (self ${eb.endpointId}), ` +
        `dir=${ea.registry.dir}`,
    );
  }
  return {
    busA,
    busB,
    agentA,
    agentB,
    dispose: async () => {
      await busA.dispose();
      await busB.dispose();
    },
  };
}

test('a session live in another bus shows as a remote live row', async () => {
  const { busA, busB, dispose } = await twoBuses();
  try {
    const rows = await busA.roster();
    const remote = rows.find((row) => row.id === 'session-b');
    assert.notEqual(remote, undefined, 'the peer session must appear in the roster');
    assert.equal(remote.live, true);
    assert.equal(remote.host, 'remote', 'a peer-held session must be marked as remote');
    // And the other side sees this one the same way.
    const back = (await busB.roster()).find((row) => row.id === 'session-a');
    assert.equal(back?.host, 'remote');
  } finally {
    await dispose();
  }
});

test('a send to a peer-held session is forwarded and lands in its inbox', async () => {
  const { busA, agentA, agentB, dispose } = await twoBuses({
    allowA: [{ from: 'session-a', to: 'session-b' }],
    allowB: [{ from: 'session-a', to: 'session-b' }],
  });
  try {
    const result = await busA
      .send(agentA, { target: 'session-b', text: 'across the socket' }, {})
      .catch((error) => error);
    assert.ok(!(result instanceof Error), `send failed: ${result?.message}`);
    assert.equal(result.target, 'session-b');
    assert.equal(result.targetState, 'remote');
    assert.equal(agentB.delivered.length, 1, 'the peer must have routed it into the inbox');
    assert.match(JSON.stringify(agentB.delivered[0].message.content), /across the socket/);
  } finally {
    await dispose();
  }
});

test('the receiving side decides: its own allowlist can refuse the pair', async () => {
  // The sender permits the pair; the receiver does not. The receiver is
  // authoritative, so the delivery must be refused with the receiver's own code.
  const { busA, agentA, agentB, dispose } = await twoBuses({
    allowA: [{ from: 'session-a', to: 'session-b' }],
    allowB: [],
  });
  try {
    const error = await busA
      .send(agentA, { target: 'session-b', text: 'should be refused' }, {})
      .catch((thrown) => thrown);
    assert.ok(error instanceof SessionBusError);
    assert.equal(error.code, 'denied');
    assert.equal(agentB.delivered.length, 0, 'nothing may reach the peer inbox');
  } finally {
    await dispose();
  }
});

test('the receiving side decides: its own archive set refuses the target', async () => {
  const agentA = fakeAgent('session-a');
  const agentB = fakeAgent('session-b');
  const a = fakeCtx({ liveAgents: [agentA] });
  const b = fakeCtx({ liveAgents: [agentB], archived: ['session-b'] });
  const busA = makeBus(a.ctx, baseConfig({ crossProcess: true, allow: [{ from: 'session-a', to: 'session-b' }] }));
  const busB = makeBus(b.ctx, baseConfig({ crossProcess: true, allow: [{ from: 'session-a', to: 'session-b' }] }));
  await Promise.all([busA.xproc(), busB.xproc()]);
  try {
    const error = await busA.send(agentA, { target: 'session-b', text: 'archived' }, {}).catch((thrown) => thrown);
    assert.equal(error?.code, 'target-archived');
    assert.equal(agentB.delivered.length, 0);
  } finally {
    await busA.dispose();
    await busB.dispose();
  }
});

test('with the transport off, a peer session is not discovered at all', async () => {
  // The default must stay a true no-op: no endpoint, no socket, no remote rows.
  const agentA = fakeAgent('session-a');
  const agentB = fakeAgent('session-b');
  const a = fakeCtx({ liveAgents: [agentA] });
  const b = fakeCtx({ liveAgents: [agentB] });
  const busA = makeBus(a.ctx, baseConfig({ allow: [{ from: 'session-a', to: 'session-b' }] }));
  const busB = makeBus(b.ctx, baseConfig({ allow: [{ from: 'session-a', to: 'session-b' }] }));
  try {
    assert.equal(await busA.xproc(), undefined);
    const rows = await busA.roster();
    assert.equal(rows.find((row) => row.id === 'session-b')?.host, undefined);
    assert.equal(busA.xprocStart, undefined, 'nothing may have been started');
  } finally {
    await busA.dispose();
    await busB.dispose();
  }
});

test('a peer that stops is no longer reported live', async () => {
  // Caching off: this is about what the merge does with a peer that has gone, and the
  // cache deliberately outlives that for a few seconds (covered by its own test).
  const { busA, busB, dispose } = await twoBuses({ cacheMs: 0 });
  try {
    assert.equal((await busA.roster()).find((row) => row.id === 'session-b')?.host, 'remote');
    await busB.dispose();
    const after = await busA.roster();
    const row = after.find((entry) => entry.id === 'session-b');
    // Either gone (never stored here) or back to being just stored — but never
    // still claimed as live by a process that has stopped.
    assert.notEqual(row?.host, 'remote');
  } finally {
    await dispose();
  }
});

test('a locked session explains why forwarding could not help', async () => {
  // Reaching a `target-busy` refusal with the transport on means every peer was
  // asked and none claimed the session, so the refusal should say why forwarding
  // is not an option instead of just repeating that the lock exists.
  const { busA, dispose } = await twoBuses();
  try {
    // In the real path this always follows the roster pass inside `authorize`,
    // which is what populates the remote-owner map. State the precondition.
    await busA.roster();
    const unclaimed = await busA.busyMessage('session-nowhere');
    assert.match(unclaimed, /no reachable peer-bus endpoint claims it/);
    assert.match(unclaimed, /not running peer-bus, or has crossProcess disabled/);

    // A peer that *does* hold the session must not have the transport blamed.
    const claimed = await busA.busyMessage('session-b');
    assert.ok(!claimed.includes('no reachable peer-bus endpoint'), claimed);
  } finally {
    await dispose();
  }
});

test('with the transport off, the lock is the whole story', async () => {
  const bus = makeBus(fakeCtx({ liveAgents: [fakeAgent('session-a')] }).ctx, baseConfig());
  try {
    const message = await bus.busyMessage('session-nowhere');
    assert.match(message, /can only be messaged from that process/);
    assert.ok(!message.includes('crossProcess'), 'nothing about a transport that is off');
  } finally {
    await bus.dispose();
  }
});

test('a forwarded message receipt is read back from the peer that holds it', async () => {
  // The receipt lives where the message was actually put in an inbox, so the query
  // has to travel. Without this the sender would report `unknown` for a message it
  // successfully delivered.
  const { busA, agentA, agentB, dispose } = await twoBuses({
    allowA: [{ from: 'session-a', to: 'session-b' }],
    allowB: [{ from: 'session-a', to: 'session-b' }],
  });
  try {
    const sent = await busA.send(agentA, { target: 'session-b', text: 'tracked' }, {});
    assert.equal(sent.targetState, 'remote');
    assert.equal(agentB.delivered.length, 1);

    const receipt = await busA.status(sent.messageId, 'session-a');
    assert.equal(receipt.messageId, sent.messageId);
    assert.equal(receipt.status, 'queued', 'the peer reports its own view of the delivery');
    assert.equal(receipt.to, 'session-b');
    assert.notEqual(receipt.status, 'unknown');
  } finally {
    await dispose();
  }
});

test('a peer refuses to show a receipt to anyone but the sender', async () => {
  // The check is the peer's, not ours: an unrelated session in the sending process
  // must not be able to read another pair's receipt through a reachable peer.
  const { busA, agentA, dispose } = await twoBuses({
    allowA: [{ from: 'session-a', to: 'session-b' }],
    allowB: [{ from: 'session-a', to: 'session-b' }],
  });
  try {
    const sent = await busA.send(agentA, { target: 'session-b', text: 'private' }, {});
    const receipt = await busA.status(sent.messageId, 'session-nosy');
    assert.equal(receipt.status, 'unknown');
  } finally {
    await dispose();
  }
});

test('a receipt whose peer has gone reports unknown with a reason', async () => {
  const { busA, agentA, busB, dispose } = await twoBuses({
    allowA: [{ from: 'session-a', to: 'session-b' }],
    allowB: [{ from: 'session-a', to: 'session-b' }],
  });
  try {
    const sent = await busA.send(agentA, { target: 'session-b', text: 'soon gone' }, {});
    await busB.dispose();

    const receipt = await busA.status(sent.messageId, 'session-a');
    assert.equal(receipt.status, 'unknown');
    assert.match(String(receipt.reason), /no longer running|no longer reach/, 'the model must see why');
  } finally {
    await dispose();
  }
});

test('a peer that does not hold the session answers not-here', async () => {
  // This is the trigger for the sender's re-resolve: the peer had it a moment ago
  // and does not now, so the sender must look again rather than report a failure.
  const { busB, dispose } = await twoBuses();
  try {
    const error = await busB
      .deliverRemote({ senderSessionId: 'session-a', targetId: 'session-nowhere', text: 'x' })
      .catch((thrown) => thrown);
    assert.equal(error?.code, 'not-here');

    // A session that exists but is not live *here* is the same answer: this process
    // cannot deliver it, and the sender is the one that must decide what next.
    const stale = await busB
      .deliverRemote({ senderSessionId: 'session-a', targetId: 'session-a', text: 'x' })
      .catch((thrown) => thrown);
    assert.equal(stale?.code, 'not-here');
  } finally {
    await dispose();
  }
});

test('a retried delivery is taken once, not twice', async () => {
  // A sender whose request timed out cannot know whether it arrived, so it may resend.
  // Only the receiver can tell, and delivering twice would run the target's turn twice
  // for one message.
  const { busB, agentB, dispose } = await twoBuses({
    allowA: [{ from: 'session-a', to: 'session-b' }],
    allowB: [{ from: 'session-a', to: 'session-b' }],
  });
  try {
    const payload = {
      deliveryId: 'delivery-1',
      senderSessionId: 'session-a',
      targetId: 'session-b',
      text: 'only once',
      mode: 'followup',
    };
    const first = await busB.deliverRemote({ ...payload });
    assert.equal(first.duplicate, undefined);
    const second = await busB.deliverRemote({ ...payload });

    assert.equal(second.duplicate, true, 'the retry must be recognised as a duplicate');
    assert.equal(second.messageId, first.messageId, 'and must report the original delivery');
    assert.equal(agentB.delivered.length, 1, 'the target must have been woken exactly once');
  } finally {
    await dispose();
  }
});

test('a different delivery id is a different message', async () => {
  const { busB, agentB, dispose } = await twoBuses({
    allowA: [{ from: 'session-a', to: 'session-b' }],
    allowB: [{ from: 'session-a', to: 'session-b' }],
  });
  try {
    const base = { senderSessionId: 'session-a', targetId: 'session-b', text: 'hi', mode: 'followup' };
    await busB.deliverRemote({ ...base, deliveryId: 'delivery-1' });
    await busB.deliverRemote({ ...base, deliveryId: 'delivery-2' });
    assert.equal(agentB.delivered.length, 2);
  } finally {
    await dispose();
  }
});

test('a forward that times out reports an unknown outcome, not a failure', async () => {
  // The dangerous shape is an error: the model would read "failed" and send again, for
  // a message the peer may already have taken. "Unknown" plus the id to ask about is
  // the honest answer, and bus_status can then settle it.
  const agentA = fakeAgent('session-a');
  const agentB = fakeAgent('session-b');
  const a = fakeCtx({ liveAgents: [agentA] });
  const b = fakeCtx({ liveAgents: [agentB] });
  const busA = makeBus(a.ctx, baseConfig({
    crossProcess: true,
    crossProcessDeliverTimeoutMs: 150,
    allow: [{ from: 'session-a', to: 'session-b' }],
  }));
  const busB = makeBus(b.ctx, baseConfig({ crossProcess: true, allow: [{ from: 'session-a', to: 'session-b' }] }));
  try {
    await Promise.all([busA.xproc(), busB.xproc()]);
    // A peer that accepts the request and never answers.
    busB.deliverRemote = () => new Promise(() => {});

    const result = await busA.send(agentA, { target: 'session-b', text: 'slow peer' }, {});
    assert.equal(result.targetState, 'unknown');
    assert.match(result.note, /may or may not have been delivered/);
    assert.match(result.note, /bus_status/);

    // The id it hands back is one the peer can be asked about.
    const receipt = await busA.status(result.messageId, 'session-a');
    assert.equal(receipt.status, 'unknown', 'nothing was delivered, so nothing is known');
  } finally {
    await busA.dispose();
    await busB.dispose();
  }
});

test("a peer's archive state is visible here, so the refusal comes before the trip", async () => {
  // Without this the roster would show a session that the peer has archived as
  // reachable, and the refusal would only arrive after a round trip — which reads as
  // "the send failed" rather than "that session is archived".
  const agentA = fakeAgent('session-a');
  const agentB = fakeAgent('session-b');
  const a = fakeCtx({ liveAgents: [agentA] });
  const b = fakeCtx({ liveAgents: [agentB], archived: ['session-b'] });
  const busA = makeBus(a.ctx, baseConfig({ crossProcess: true, allow: [{ from: 'session-a', to: 'session-b' }] }));
  const busB = makeBus(b.ctx, baseConfig({ crossProcess: true, allow: [{ from: 'session-a', to: 'session-b' }] }));
  try {
    await Promise.all([busA.xproc(), busB.xproc()]);
    const row = (await busA.roster()).find((entry) => entry.id === 'session-b');
    assert.equal(row?.host, 'remote', 'it is still reported as held elsewhere');
    assert.equal(row?.archived, true, "the peer's archive set must come with the row");

    const error = await busA.send(agentA, { target: 'session-b', text: 'nope' }, {}).catch((thrown) => thrown);
    assert.equal(error?.code, 'target-archived');
    assert.equal(agentB.delivered.length, 0, 'and nothing may reach the peer');
  } finally {
    await busA.dispose();
    await busB.dispose();
  }
});

test('a runtime grant in the receiving process is honoured', async () => {
  // Each side evaluates its own allowlist, so a `/bus allow` made in the receiving
  // process does not have to be visible to the sender: the receiver is the one that
  // checks it. This is what makes the two-sided model work without replicating grants.
  const agentA = fakeAgent('session-a');
  const agentB = fakeAgent('session-b');
  const a = fakeCtx({ liveAgents: [agentA] });
  const b = fakeCtx({ liveAgents: [agentB] });
  const busA = makeBus(a.ctx, baseConfig({ crossProcess: true, allow: [{ from: 'session-a', to: 'session-b' }] }));
  // No config rule at all on the receiving side: only a runtime grant.
  const busB = makeBus(b.ctx, baseConfig({ crossProcess: true, allow: [] }));
  try {
    await Promise.all([busA.xproc(), busB.xproc()]);

    const refused = await busA.send(agentA, { target: 'session-b', text: 'first' }, {}).catch((e) => e);
    assert.equal(refused?.code, 'denied', 'an empty allowlist permits nothing');

    await busB.allowlist.grant('session-a', 'session-b');
    const allowed = await busA.send(agentA, { target: 'session-b', text: 'second' }, {});
    assert.equal(allowed.targetState, 'remote');
    assert.equal(agentB.delivered.length, 1, 'the grant lives in the receiving process and it checked it');
  } finally {
    await busA.dispose();
    await busB.dispose();
  }
});

/** Count how many times a peer is asked what it holds. */
async function countPeerQueries(peerBus) {
  const endpoint = await peerBus.xproc();
  const original = endpoint.handlers['roster.live'];
  const counter = { calls: 0 };
  endpoint.handlers['roster.live'] = async (payload) => {
    counter.calls += 1;
    return await original(payload);
  };
  return counter;
}

test('a burst of rosters asks each peer once, not once per roster', async () => {
  // Without this every send pays a query per peer, and each query is a full roster of
  // that process's live sessions.
  const { busA, busB, dispose } = await twoBuses();
  try {
    const counter = await countPeerQueries(busB);
    await busA.roster();
    await busA.roster();
    await busA.roster();
    assert.equal(counter.calls, 1, 'the peer answer must have been reused');
  } finally {
    await dispose();
  }
});

test('the cache can be turned off', async () => {
  const agentA = fakeAgent('session-a');
  const agentB = fakeAgent('session-b');
  const busA = makeBus(
    fakeCtx({ liveAgents: [agentA] }).ctx,
    baseConfig({ crossProcess: true, crossProcessRosterCacheMs: 0 }),
  );
  const busB = makeBus(fakeCtx({ liveAgents: [agentB] }).ctx, baseConfig({ crossProcess: true }));
  try {
    await Promise.all([busA.xproc(), busB.xproc()]);
    const counter = await countPeerQueries(busB);
    await busA.roster();
    await busA.roster();
    assert.equal(counter.calls, 2, 'zero means ask every time');
  } finally {
    await busA.dispose();
    await busB.dispose();
  }
});

test('a cached owner that has died is corrected on the next send', async () => {
  // The cache is allowed to be wrong precisely because being wrong is recoverable: the
  // peer is gone, the sender learns it, and the session is resumed locally instead.
  const stored = [{ id: 'session-b', cwd: '/tmp/ws' }];
  const agentA = fakeAgent('session-a');
  const agentB = fakeAgent('session-b');
  const busA = makeBus(fakeCtx({ liveAgents: [agentA], stored }).ctx, baseConfig({
    crossProcess: true,
    allow: [{ from: 'session-a', to: 'session-b' }],
  }));
  const busB = makeBus(fakeCtx({ liveAgents: [agentB] }).ctx, baseConfig({
    crossProcess: true,
    allow: [{ from: 'session-a', to: 'session-b' }],
  }));
  try {
    await Promise.all([busA.xproc(), busB.xproc()]);
    assert.equal((await busA.roster()).find((row) => row.id === 'session-b')?.host, 'remote');

    // The peer goes away inside the cache window: the cached answer is now a lie.
    await busB.dispose();

    const result = await busA.send(agentA, { target: 'session-b', text: 'still works' }, {});
    assert.equal(result.targetState, 'resumed', `expected the local path, got ${result.targetState}`);
    assert.equal(busA.remoteCache, undefined, 'the stale peer answer was dropped, not kept for the rest of the window');
  } finally {
    await busA.dispose();
  }
});

test('learning that a peer moved on invalidates the cached answer', async () => {
  const { busA, busB, dispose } = await twoBuses();
  try {
    await busA.roster();
    assert.notEqual(busA.remoteCache, undefined, 'a cache must exist to invalidate');
    await busA.deliverRemote({ senderSessionId: 'session-a', targetId: 'session-nowhere', text: 'x' }).catch(() => {});
    // A `not-here` from a peer that the cache credits with a session must not survive
    // the rest of the window.
    busA.invalidateRemoteCache();
    assert.equal(busA.remoteCache, undefined);
  } finally {
    await dispose();
  }
});

test('a cached peer answer expires on its own', async () => {
  // The cache is allowed to be briefly wrong; it is not allowed to stay wrong. A short
  // window proves the expiry path without waiting the production three seconds.
  const { busA, busB, dispose } = await twoBuses({ cacheMs: 60 });
  try {
    assert.equal((await busA.roster()).find((row) => row.id === 'session-b')?.host, 'remote');
    await busB.dispose();
    // Still inside the window, so the answer has not changed yet.
    assert.equal((await busA.roster()).find((row) => row.id === 'session-b')?.host, 'remote');

    await new Promise((resolve) => setTimeout(resolve, 120));
    const after = (await busA.roster()).find((row) => row.id === 'session-b');
    assert.notEqual(after?.host, 'remote', 'past the window the peer answer must be re-asked');
  } finally {
    await dispose();
  }
});

test("the receiving process's runtime grant is what decides a cross-process send", async () => {
  // The consent model is receiver consent, and a receiver grants inside its own process
  // with `/bus allow`. If the sender decided instead, that grant would be invisible to it
  // and the send would be refused before the receiver ever saw it — which is what made
  // cross-process messaging work only for pairs written into both configs.
  const agentA = fakeAgent('session-a');
  const agentB = fakeAgent('session-b');
  const a = fakeCtx({ liveAgents: [agentA] });
  const b = fakeCtx({ liveAgents: [agentB] });
  // The sender permits nothing at all.
  const busA = makeBus(a.ctx, baseConfig({ crossProcess: true, allow: [] }));
  const busB = makeBus(b.ctx, baseConfig({ crossProcess: true, allow: [] }));
  try {
    await Promise.all([busA.xproc(), busB.xproc()]);

    const before = await busA.send(agentA, { target: 'session-b', text: 'not yet' }, {}).catch((e) => e);
    assert.equal(before?.code, 'denied', 'with no grant anywhere, the receiver refuses');

    // The receiver's user consents, in the receiver's process.
    await busB.allowlist.grant('session-a', 'session-b');
    const after = await busA.send(agentA, { target: 'session-b', text: 'now allowed' }, {});
    assert.equal(after.targetState, 'remote');
    assert.equal(agentB.delivered.length, 1);
  } finally {
    await busA.dispose();
    await busB.dispose();
  }
});

test('a remote target the peer has archived is still refused before the trip', async () => {
  // Deferring *permission* must not defer the archive gate: the peer's archive state
  // travels with its row, so this refusal is still local and still immediate.
  const agentA = fakeAgent('session-a');
  const agentB = fakeAgent('session-b');
  const a = fakeCtx({ liveAgents: [agentA] });
  const b = fakeCtx({ liveAgents: [agentB], archived: ['session-b'] });
  const busA = makeBus(a.ctx, baseConfig({ crossProcess: true, allow: [{ from: 'session-a', to: 'session-b' }] }));
  const busB = makeBus(b.ctx, baseConfig({ crossProcess: true, allow: [{ from: 'session-a', to: 'session-b' }] }));
  try {
    await Promise.all([busA.xproc(), busB.xproc()]);
    const error = await busA.send(agentA, { target: 'session-b', text: 'no' }, {}).catch((e) => e);
    assert.equal(error?.code, 'target-archived');
    assert.equal(agentB.delivered.length, 0);
  } finally {
    await busA.dispose();
    await busB.dispose();
  }
});
