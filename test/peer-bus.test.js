/**
 * Unit tests for the peer-bus core.
 *
 * These drive {@link SessionBus} against the shared fakes in ./helpers.js, so the
 * addressing, permission, rate, routing, and archive decisions are pinned without
 * booting a real harness or spending model calls.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { SessionBus, SessionBusError, createBusMessage } from '../src/peer-bus.js';
import { FRAMING_BLOCK } from '../src/message.js';
import { baseConfig, fakeAgent, fakeCtx, fakeStorageDomain, makeBus } from './helpers.js';

test('createBusMessage attributes the true sender, not the routing hop', () => {
  const message = createBusMessage('session-sender-1', 'hello');
  assert.equal(message.role, 'user');
  assert.equal(message.source.kind, 'peer-bus-message');
  assert.equal(message.source.form, 'relay');
  assert.equal(message.source.senderSessionId, 'session-sender-1');
  const text = message.content.map((block) => block.text).join('');
  assert.match(text, /session-sender-1 sent a message/);
  assert.match(text, /hello/);
});

test('a bus_ask question tells the target its reply goes back automatically', () => {
  // A real model, shown a question framed like an ordinary message, answered in
  // its turn AND re-sent the answer with bus_send — a duplicate delivery. The
  // question framing is what prevents that.
  const question = createBusMessage('session-asker', 'which version?', { askId: 'ask-1', role: 'question' });
  const text = question.content.map((block) => block.text).join('');
  assert.match(text, /^Agent session-asker asked you a question: which version\?/);
  assert.match(text, /returned to the asker automatically/);
  assert.match(text, /do not also send it with bus_send/);
  assert.equal(question.source.askId, 'ask-1');

  const answer = createBusMessage('session-target', '4.2.0', { askId: 'ask-1', role: 'answer' });
  const answerText = answer.content.map((block) => block.text).join('');
  assert.equal(answerText, 'Agent session-target answered your earlier question: 4.2.0');
  assert.equal(answer.source.askId, 'ask-1');

  // An ordinary message carries no ask id and no note.
  const plain = createBusMessage('session-a', 'hi');
  assert.equal(plain.source.askId, undefined);
  assert.equal(plain.content.length, 2);
});

test('FRAMING_BLOCK matches every framing block and never the body', () => {
  for (const role of ['message', 'question', 'answer']) {
    const message = createBusMessage('session-x', 'the body', { askId: 'a', role });
    const body = message.content.filter((block) => !FRAMING_BLOCK.test(block.text));
    assert.deepEqual(body.map((block) => block.text), ['the body'], role);
  }
  // A body that merely looks like a lead-in is still body when it carries more.
  assert.equal(FRAMING_BLOCK.test('Agent x sent a message: and more'), false);
});

test('send frames a question only when an ask id travels with it', async () => {
  const sender = fakeAgent('session-a');
  const target = fakeAgent('session-b');
  const { ctx } = fakeCtx({ liveAgents: [sender, target] });
  const bus = makeBus(ctx, baseConfig({ allow: [{ from: '*', to: '*' }] }));

  await bus.send(sender, { target: 'session-b', text: 'plain' });
  await bus.send(sender, { target: 'session-b', text: 'asked', askId: 'ask-9' });
  const [plain, asked] = target.delivered.map((entry) => entry.message.content[0].text);
  assert.match(plain, /sent a message/);
  assert.match(asked, /asked you a question/);
});

test('roster merges live agents ahead of stored sessions without duplicating', async () => {
  const { ctx } = fakeCtx({
    liveAgents: [fakeAgent('session-live')],
    stored: [{ id: 'session-live', cwd: '/tmp/ws' }, { id: 'session-stored', cwd: '/tmp/other' }],
  });
  const bus = makeBus(ctx, baseConfig());

  const rows = await bus.roster();
  assert.equal(rows.length, 2);
  const liveRow = rows.find((row) => row.id === 'session-live');
  const storedRow = rows.find((row) => row.id === 'session-stored');
  assert.equal(liveRow.live, true);
  assert.equal(liveRow.status, 'idle');
  assert.equal(storedRow.live, false);
  assert.equal(storedRow.cwd, '/tmp/other');
});

test('roster still lists live agents when persistence is not mounted', async () => {
  const { ctx } = fakeCtx({ liveAgents: [fakeAgent('session-live')], noPersistence: true });
  const bus = makeBus(ctx, baseConfig());

  const rows = await bus.roster();
  assert.deepEqual(rows.map((row) => row.id), ['session-live']);
});

test('service lookups still resolve after an await that crosses a macrotask', async () => {
  // Reaching the bus through \`ctx.get('peerBus')\` is what every real caller
  // does — the model tools are the only ones holding the raw instance — so the
  // proxied shape has to keep working across an await that crosses a macrotask.
  //
  // This pins the shape, not Cordis's shadow mechanism: a bare Context does not
  // reproduce the per-call shadow. \`npm run boot-check\` does, because it boots a
  // real profile and calls \`roster()\` through the service proxy as its first bus
  // operation — which is the exact call that crashed when a lookup went through
  // the shadowed \`this.ctx\` after the allowlist domain opened on real I/O.
  const facility = fakeStorageDomain({ grants: [] }, { slowOpenMs: 25 });
  const { ctx } = fakeCtx({
    liveAgents: [fakeAgent('session-live')],
    stored: [{ id: 'session-gone', cwd: '/tmp/ws' }],
    archived: ['session-gone'],
    storageDomain: facility,
  });
  new SessionBus(ctx, baseConfig());
  const bus = ctx.get('peerBus');
  assert.notEqual(bus, undefined);

  const rows = await bus.roster();
  assert.deepEqual(rows.map((row) => row.id).sort(), ['session-gone', 'session-live']);
  assert.equal(rows.find((row) => row.id === 'session-gone').archived, true);
});

test('roster flags an archived session instead of dropping it, so send can name the refusal', async () => {
  const { ctx } = fakeCtx({
    liveAgents: [fakeAgent('session-live')],
    stored: [{ id: 'session-gone', cwd: '/tmp/ws' }],
    archived: ['session-gone'],
  });
  const bus = makeBus(ctx, baseConfig());

  const rows = await bus.roster();
  assert.equal(rows.find((row) => row.id === 'session-gone').archived, true);
  assert.equal(rows.find((row) => row.id === 'session-live').archived, false);
});

test('no workspace registry means nothing is archived', async () => {
  const { ctx } = fakeCtx({ liveAgents: [fakeAgent('session-live')] });
  const bus = makeBus(ctx, baseConfig());

  assert.equal(bus.archivedIds().size, 0);
  const rows = await bus.roster();
  assert.equal(rows.every((row) => row.archived === false), true);
});

test('a registry that has not loaded its state yet is treated as nothing archived', async () => {
  const { ctx } = fakeCtx({
    liveAgents: [fakeAgent('session-live')],
    archived: [],
    registryThrows: true,
  });
  const bus = makeBus(ctx, baseConfig());

  assert.equal(bus.archivedIds().size, 0);
  const rows = await bus.roster();
  assert.equal(rows.every((row) => row.archived === false), true);
});

test('send refuses an archived stored target as target-archived and never resumes it', async () => {
  const sender = fakeAgent('session-sender');
  const { ctx, resumedIds } = fakeCtx({
    liveAgents: [sender],
    stored: [{ id: 'session-archived', cwd: '/tmp/ws' }],
    archived: ['session-archived'],
  });
  const bus = makeBus(ctx, baseConfig({ allow: [{ from: 'session-sender', to: 'session-archived' }] }));

  const error = await bus
    .send(sender, { target: 'session-archived', text: 'hello' }, {})
    .catch((thrown) => thrown);
  assert.ok(error instanceof SessionBusError);
  assert.equal(error.code, 'target-archived');
  assert.deepEqual(resumedIds, []);
});

test('send refuses a live target that was archived without being unloaded', async () => {
  const sender = fakeAgent('session-sender');
  const archivedTarget = fakeAgent('session-target');
  const { ctx } = fakeCtx({ liveAgents: [sender, archivedTarget], archived: ['session-target'] });
  const bus = makeBus(ctx, baseConfig({ allow: [{ from: 'session-sender', to: 'session-target' }] }));

  const error = await bus
    .send(sender, { target: 'session-target', text: 'hello' }, {})
    .catch((thrown) => thrown);
  assert.equal(error?.code, 'target-archived');
  assert.deepEqual(archivedTarget.delivered, []);
});

test('an archived target is refused only after the allowlist, so denial is not bypassed', async () => {
  const sender = fakeAgent('session-sender');
  const { ctx } = fakeCtx({
    liveAgents: [sender, fakeAgent('session-target')],
    archived: ['session-target'],
  });
  const bus = makeBus(ctx, baseConfig({ allow: [] }));

  const error = await bus
    .send(sender, { target: 'session-target', text: 'hello' }, {})
    .catch((thrown) => thrown);
  assert.equal(error?.code, 'denied');
});

test('a refused archived target does not spend the pair rate budget', async () => {
  const sender = fakeAgent('session-sender');
  const { ctx } = fakeCtx({
    liveAgents: [sender],
    stored: [{ id: 'session-archived', cwd: '/tmp/ws' }],
    archived: ['session-archived'],
  });
  const bus = makeBus(
    ctx,
    baseConfig({
      allow: [{ from: 'session-sender', to: 'session-archived' }],
      maxSendsPerWindow: 1,
    }),
  );

  for (const attempt of [1, 2]) {
    const error = await bus
      .send(sender, { target: 'session-archived', text: 'hello' }, {})
      .catch((thrown) => thrown);
    assert.equal(error?.code, 'target-archived', `attempt ${attempt}`);
  }
});

test('visibleRoster hides archived sessions, and an archived caller is shown nothing', async () => {
  const caller = fakeAgent('session-caller');
  const { ctx } = fakeCtx({
    liveAgents: [caller, fakeAgent('session-peer')],
    stored: [{ id: 'session-archived', cwd: '/tmp/ws' }],
    archived: ['session-archived'],
  });
  const bus = makeBus(ctx, baseConfig({ rosterScope: 'all' }));

  const visible = await bus.visibleRoster(caller);
  assert.deepEqual(visible.map((row) => row.id).sort(), ['session-caller', 'session-peer']);

  const archivedCaller = fakeAgent('session-archived-live');
  const { ctx: archivedCtx } = fakeCtx({
    liveAgents: [archivedCaller],
    archived: ['session-archived-live'],
  });
  const archivedBus = makeBus(archivedCtx, baseConfig({ rosterScope: 'all' }));
  assert.deepEqual(await archivedBus.visibleRoster(archivedCaller), []);
});


test('roster carries a live title and leaves a stored row without one', async () => {
  const { ctx } = fakeCtx({
    liveAgents: [fakeAgent('session-live')],
    stored: [{ id: 'session-stored', cwd: '/tmp/ws' }],
    titles: new Map([['session-live', 'Deploy runbook']]),
  });
  const bus = makeBus(ctx, baseConfig());

  const rows = await bus.roster();
  assert.equal(rows.find((row) => row.id === 'session-live').title, 'Deploy runbook');
  // Reading a stored session's title would be a log read per roster row, so a
  // stored row reports no title rather than forcing one.
  assert.equal(rows.find((row) => row.id === 'session-stored').title, undefined);
});

test('a title unique among the reachable sessions resolves to its id', async () => {
  const { ctx } = fakeCtx({
    liveAgents: [fakeAgent('session-a'), fakeAgent('session-b')],
    titles: new Map([['session-b', 'Deploy runbook']]),
  });
  const bus = makeBus(ctx, baseConfig());

  assert.equal(await bus.resolve('Deploy runbook'), 'session-b');
  assert.equal(await bus.resolve('deploy RUNBOOK'), 'session-b');
});

test('an ambiguous title is refused with its candidates', async () => {
  const { ctx } = fakeCtx({
    liveAgents: [fakeAgent('session-a'), fakeAgent('session-b')],
    titles: new Map([
      ['session-a', 'Deploy'],
      ['session-b', 'Deploy'],
    ]),
  });
  const bus = makeBus(ctx, baseConfig());

  const error = await bus.resolve('Deploy').catch((thrown) => thrown);
  assert.ok(error instanceof SessionBusError);
  assert.equal(error.code, 'ambiguous-target');
  assert.match(error.message, /session-a, session-b/);
});

test('a title that matches nothing is still unknown-target', async () => {
  const { ctx } = fakeCtx({
    liveAgents: [fakeAgent('session-a')],
    titles: new Map([['session-a', 'Deploy']]),
  });
  const bus = makeBus(ctx, baseConfig());
  const error = await bus.resolve('Release').catch((thrown) => thrown);
  assert.equal(error?.code, 'unknown-target');
});

test('an id prefix is resolved as an id before any title is considered', async () => {
  const { ctx } = fakeCtx({
    liveAgents: [fakeAgent('session-aaa-1'), fakeAgent('session-bbb-2')],
    // A title that happens to look like the other session's prefix must not
    // hijack id addressing.
    titles: new Map([['session-bbb-2', 'session-aaa']]),
  });
  const bus = makeBus(ctx, baseConfig());

  assert.equal(await bus.resolve('session-aaa'), 'session-aaa-1');
  assert.equal(await bus.resolve('session-bbb-2'), 'session-bbb-2');
});

test('bus_send accepts a unique title as its target', async () => {
  const sender = fakeAgent('session-sender');
  const target = fakeAgent('session-target');
  const { ctx } = fakeCtx({
    liveAgents: [sender, target],
    titles: new Map([['session-target', 'Release checklist']]),
  });
  const bus = makeBus(
    ctx,
    baseConfig({ allow: [{ from: 'session-sender', to: 'session-target' }] }),
  );

  const result = await bus.send(sender, { target: 'Release checklist', text: 'ping' }, {});
  assert.equal(result.target, 'session-target');
  assert.equal(target.delivered.length, 1);
});

test('no title service means every row simply has no title', async () => {
  const { ctx } = fakeCtx({ liveAgents: [fakeAgent('session-live')] });
  const bus = makeBus(ctx, baseConfig());
  const rows = await bus.roster();
  assert.equal(rows[0].title, undefined);
  assert.equal(await bus.resolve('session-live'), 'session-live');
});

test('resolve accepts a full id and an unambiguous prefix, rejects unknown and ambiguous', async () => {
  const { ctx } = fakeCtx({ stored: [{ id: 'session-aaa-111' }, { id: 'session-aab-222' }] });
  const bus = makeBus(ctx, baseConfig());

  assert.equal(await bus.resolve('session-aaa-111'), 'session-aaa-111');
  assert.equal(await bus.resolve('session-aab'), 'session-aab-222');
  await assert.rejects(() => bus.resolve('session-zzz'), (error) => {
    assert.ok(error instanceof SessionBusError);
    assert.equal(error.code, 'unknown-target');
    return true;
  });
  await assert.rejects(() => bus.resolve('session-aa'), (error) => {
    assert.equal(error.code, 'ambiguous-target');
    return true;
  });
});

test('permission is default-deny and an allowlist row unlocks exactly one direction', async () => {
  const sender = fakeAgent('session-from');
  const target = fakeAgent('session-to');
  const { ctx } = fakeCtx({ liveAgents: [sender, target] });

  const denied = makeBus(ctx, baseConfig());
  await assert.rejects(
    () => denied.send(sender, { target: 'session-to', text: 'hi' }),
    (error) => {
      assert.equal(error.code, 'denied');
      return true;
    },
  );
  assert.equal(target.delivered.length, 0);

  const allowed = makeBus(
    ctx,
    baseConfig({ allow: [{ from: 'session-from', to: 'session-to' }] }),
  );
  const result = await allowed.send(sender, { target: 'session-to', text: 'hi' });
  assert.equal(result.targetState, 'live');
  assert.equal(result.target, 'session-to');
  assert.equal(target.delivered.length, 1);
  assert.equal(target.delivered[0].mode, 'followup');

  // The reverse direction is a different pair and stays denied.
  await assert.rejects(
    () => allowed.send(target, { target: 'session-from', text: 'hi back' }),
    (error) => {
      assert.equal(error.code, 'denied');
      return true;
    },
  );
});

test('wildcard allow rules cover every pair', async () => {
  const sender = fakeAgent('session-a');
  const target = fakeAgent('session-b');
  const { ctx } = fakeCtx({ liveAgents: [sender, target] });
  const bus = makeBus(ctx, baseConfig({ allow: [{ from: '*', to: '*' }] }));

  await bus.send(sender, { target: 'session-b', text: 'hi' });
  await bus.send(target, { target: 'session-a', text: 'back' });
  assert.equal(target.delivered.length, 1);
  assert.equal(sender.delivered.length, 1);
});

test('steer mode routes to the step boundary instead of a fresh turn', async () => {
  const sender = fakeAgent('session-s');
  const target = fakeAgent('session-t');
  const { ctx } = fakeCtx({ liveAgents: [sender, target] });
  const bus = makeBus(ctx, baseConfig({ allow: [{ from: '*', to: '*' }] }));

  await bus.send(sender, { target: 'session-t', text: 'mid-turn', mode: 'steer' });
  assert.equal(target.delivered[0].mode, 'steer');
});

test('a stored target is cold-resumed, woken, and the handle is owned for disposal', async () => {
  const sender = fakeAgent('session-s');
  const { ctx, state, resumedIds } = fakeCtx({
    liveAgents: [sender],
    stored: [{ id: 'session-cold' }],
  });
  const bus = makeBus(ctx, baseConfig({ allow: [{ from: '*', to: '*' }] }));

  const result = await bus.send(sender, { target: 'session-cold', text: 'wake up' });
  assert.equal(result.targetState, 'resumed');
  assert.deepEqual(resumedIds, ['session-cold']);
  assert.equal(ctx.agents.get('session-cold').delivered.length, 1);

  await bus.dispose();
  assert.equal(state.disposed, 1);
});

test('concurrent sends to one cold target share a single resume', async () => {
  const sender = fakeAgent('session-s');
  const { ctx, resumedIds } = fakeCtx({
    liveAgents: [sender],
    stored: [{ id: 'session-cold' }],
  });
  const bus = makeBus(ctx, baseConfig({ allow: [{ from: '*', to: '*' }] }));

  await Promise.all([
    bus.send(sender, { target: 'session-cold', text: 'one' }),
    bus.send(sender, { target: 'session-cold', text: 'two' }),
  ]);
  assert.deepEqual(resumedIds, ['session-cold']);
  assert.equal(ctx.agents.get('session-cold').delivered.length, 2);
});

test('a failed resume reports resume-failed and is retried on the next attempt', async () => {
  const sender = fakeAgent('session-s');
  const { ctx, resumedIds } = fakeCtx({
    liveAgents: [sender],
    stored: [{ id: 'session-cold' }],
    resumeFails: true,
  });
  const bus = makeBus(ctx, baseConfig({ allow: [{ from: '*', to: '*' }] }));

  await assert.rejects(
    () => bus.send(sender, { target: 'session-cold', text: 'x' }),
    (error) => {
      assert.equal(error.code, 'resume-failed');
      return true;
    },
  );
  // The cached rejection must be dropped so a later attempt tries the load again.
  await assert.rejects(
    () => bus.send(sender, { target: 'session-cold', text: 'x' }),
    (error) => {
      assert.equal(error.code, 'resume-failed');
      return true;
    },
  );
  assert.equal(resumedIds.length, 2);
});

test('cold resume without a persistence backend reports resume-unavailable', async () => {
  const sender = fakeAgent('session-s');
  const { ctx } = fakeCtx({ liveAgents: [sender], noPersistence: true });
  // Resolve a stored-looking address by hand: the roster cannot list it without
  // persistence, so the target is reached through an explicit full id.
  ctx.provide('sessionPersistence', undefined);
  const bus = makeBus(ctx, baseConfig({ allow: [{ from: '*', to: '*' }] }));

  await assert.rejects(
    () => bus.send(sender, { target: 'session-missing', text: 'x' }),
    (error) => {
      assert.equal(error.code, 'unknown-target');
      return true;
    },
  );
});


test('authorize resolves, admits, and builds a message without delivering it', async () => {
  // The sender-side half of a delivery, split out so a cross-process forward can
  // reuse it. It must not touch the target's inbox: the receiving process does
  // that, after its own admission checks.
  const sender = fakeAgent('session-sender');
  const target = fakeAgent('session-target');
  const { ctx } = fakeCtx({ liveAgents: [sender, target] });
  const bus = makeBus(ctx, baseConfig({ allow: [{ from: 'session-sender', to: 'session-target' }] }));

  const admitted = await bus.authorize(sender, { target: target.id, text: 'hello' }, {});
  assert.equal(admitted.targetId, 'session-target');
  assert.equal(admitted.mode, 'followup');
  assert.equal(typeof admitted.release, 'function');
  assert.equal(admitted.message.source.kind, 'peer-bus-message');
  assert.equal(admitted.message.source.senderSessionId, 'session-sender');
  assert.deepEqual(target.delivered, [], 'authorize must not deliver');
});

test('deliverLocal hands a pre-built message over without re-admitting it', async () => {
  // The receiving half, used both by send() and by the cross-process deliver
  // handler. It reads the sender off the message, so it needs no sender object.
  const sender = fakeAgent('session-sender');
  const target = fakeAgent('session-target');
  const { ctx } = fakeCtx({ liveAgents: [sender, target] });
  const bus = makeBus(ctx, baseConfig());

  const message = createBusMessage('session-sender', 'forwarded', { role: 'message' });
  const result = await bus.deliverLocal('session-target', message, 'followup', {});
  assert.deepEqual(result, { target: 'session-target', messageId: message.id, targetState: 'live' });
  assert.equal(target.delivered.length, 1);
  assert.equal(target.delivered[0].message.id, message.id);
});

test('deliverLocal cold-resumes a stored target and reports how it got there', async () => {
  const { ctx, resumedIds } = fakeCtx({ stored: [{ id: 'session-stored', cwd: '/tmp/ws' }] });
  const bus = makeBus(ctx, baseConfig());

  const message = createBusMessage('session-sender', 'wake', { role: 'message' });
  const result = await bus.deliverLocal('session-stored', message, 'followup', {});
  assert.equal(result.targetState, 'resumed');
  assert.deepEqual(resumedIds, ['session-stored']);
});

test('self-send is rejected even when the allowlist would permit it', async () => {
  const sender = fakeAgent('session-s');
  const { ctx } = fakeCtx({ liveAgents: [sender] });
  const bus = makeBus(ctx, baseConfig({ allow: [{ from: '*', to: '*' }] }));

  await assert.rejects(() => bus.send(sender, { target: 'session-s', text: 'x' }), (error) => {
    assert.equal(error.code, 'self-send');
    return true;
  });
  assert.equal(sender.delivered.length, 0);
});

test('blank and non-string text is rejected as invalid-text', async () => {
  const sender = fakeAgent('session-s');
  const target = fakeAgent('session-t');
  const { ctx } = fakeCtx({ liveAgents: [sender, target] });
  const bus = makeBus(ctx, baseConfig({ allow: [{ from: '*', to: '*' }] }));

  for (const text of ['', '   ', '\n\t ', 42, undefined]) {
    await assert.rejects(() => bus.send(sender, { target: 'session-t', text }), (error) => {
      assert.equal(error.code, 'invalid-text');
      return true;
    });
  }
  assert.equal(target.delivered.length, 0);
});

test('oversized payloads are rejected before any delivery', async () => {
  const sender = fakeAgent('session-s');
  const target = fakeAgent('session-t');
  const { ctx } = fakeCtx({ liveAgents: [sender, target] });
  const bus = makeBus(
    ctx,
    baseConfig({ allow: [{ from: '*', to: '*' }], maxMessageBytes: 16 }),
  );

  await assert.rejects(
    () => bus.send(sender, { target: 'session-t', text: 'x'.repeat(64) }),
    (error) => {
      assert.equal(error.code, 'message-too-large');
      return true;
    },
  );
  assert.equal(target.delivered.length, 0);
});

test('the per-pair rate ceiling blocks a runaway loop and is per direction', async () => {
  const sender = fakeAgent('session-s');
  const target = fakeAgent('session-t');
  const { ctx } = fakeCtx({ liveAgents: [sender, target] });
  const bus = makeBus(
    ctx,
    baseConfig({ allow: [{ from: '*', to: '*' }], maxSendsPerWindow: 3, rateWindowMs: 60000 }),
  );

  for (let index = 0; index < 3; index += 1) {
    await bus.send(sender, { target: 'session-t', text: `m${index}` });
  }
  await assert.rejects(
    () => bus.send(sender, { target: 'session-t', text: 'one too many' }),
    (error) => {
      assert.equal(error.code, 'rate-limited');
      return true;
    },
  );
  // The reverse direction has its own budget.
  await bus.send(target, { target: 'session-s', text: 'reply' });
  assert.equal(sender.delivered.length, 1);
});

test('a sender that is no longer registered is rejected as unauthorized', async () => {
  const sender = fakeAgent('session-s');
  const { ctx } = fakeCtx({ liveAgents: [] });
  const bus = makeBus(ctx, baseConfig({ allow: [{ from: '*', to: '*' }] }));

  await assert.rejects(
    () => bus.send(sender, { target: 'session-x', text: 'x' }),
    (error) => {
      assert.equal(error.code, 'unauthorized');
      return true;
    },
  );
});


test('cold resume prefers the host agent lookup and takes no handle', async () => {
  // The host path is the one the GUI uses: model selection installed, preset
  // mounted, lifecycle host-owned. Taking a handle here would make this plugin
  // dispose an agent the host still believes it owns.
  const sender = fakeAgent('session-sender');
  const revived = fakeAgent('session-stored');
  const { ctx, resumedIds, install } = fakeCtx({
    liveAgents: [sender],
    stored: [{ id: 'session-stored', cwd: '/tmp/ws' }],
    // A real host resume publishes the agent into the registry, which is what
    // `send` re-reads liveness from after the load.
    hostLookup: {
      resolve: async (id) => {
        if (id !== 'session-stored') return undefined;
        install(revived);
        return revived;
      },
    },
  });
  const bus = makeBus(ctx, baseConfig({ allow: [{ from: 'session-sender', to: 'session-stored' }] }));

  const result = await bus.send(sender, { target: 'session-stored', text: 'wake' }, {});
  assert.equal(result.targetState, 'resumed');
  assert.deepEqual(resumedIds, [], 'the manual resume must not run');
  assert.equal(bus.owned.size, 0, 'the host owns the lifecycle, not this plugin');
  assert.equal(revived.delivered.length, 1);
});

test('a lookup that cannot answer for a stored session falls back to the manual path', async () => {
  // This is the bare \`dsh-agent\` provider: registered everywhere, but it only
  // answers for an agent that is already live.
  const sender = fakeAgent('session-sender');
  const { ctx, resumedIds } = fakeCtx({
    liveAgents: [sender],
    stored: [{ id: 'session-stored', cwd: '/tmp/ws' }],
    hostLookup: { resolve: async () => undefined },
  });
  const bus = makeBus(ctx, baseConfig({ allow: [{ from: 'session-sender', to: 'session-stored' }] }));

  const result = await bus.send(sender, { target: 'session-stored', text: 'wake' }, {});
  assert.equal(result.targetState, 'resumed');
  assert.deepEqual(resumedIds, ['session-stored']);
  assert.equal(bus.owned.size, 1);
});

test('session/writer-held from the host path reports target-busy without retrying', async () => {
  const sender = fakeAgent('session-sender');
  const { ctx, resumedIds } = fakeCtx({
    liveAgents: [sender],
    stored: [{ id: 'session-stored', cwd: '/tmp/ws' }],
    hostLookup: {
      resolve: async () => {
        const error = new Error('session is owned elsewhere');
        error.isDSHRemoteError = true;
        error.code = 'session/writer-held';
        throw error;
      },
    },
  });
  const bus = makeBus(ctx, baseConfig({ allow: [{ from: 'session-sender', to: 'session-stored' }] }));

  const error = await bus
    .send(sender, { target: 'session-stored', text: 'wake' }, {})
    .catch((thrown) => thrown);
  assert.equal(error?.code, 'target-busy');
  assert.deepEqual(resumedIds, [], 'a locked log must not be retried through the manual path');
});

test('any other host-path failure falls back to the manual resume', async () => {
  const sender = fakeAgent('session-sender');
  const { ctx, resumedIds } = fakeCtx({
    liveAgents: [sender],
    stored: [{ id: 'session-stored', cwd: '/tmp/ws' }],
    hostLookup: {
      resolve: async () => {
        throw new Error('the host path is not usable here');
      },
    },
  });
  const bus = makeBus(ctx, baseConfig({ allow: [{ from: 'session-sender', to: 'session-stored' }] }));

  const result = await bus.send(sender, { target: 'session-stored', text: 'wake' }, {});
  assert.equal(result.targetState, 'resumed');
  assert.deepEqual(resumedIds, ['session-stored']);
});

test('hostAgentLookup ignores a registry with no agent lookup', async () => {
  const { ctx } = fakeCtx({ liveAgents: [fakeAgent('session-live')] });
  ctx.provide('typert', { lookups: { get: () => undefined } });
  const bus = makeBus(ctx, baseConfig());
  assert.equal(bus.hostAgentLookup(), undefined);
});

test('cold resume restores the model route recorded in the session log', async () => {
  const sender = fakeAgent('session-s');
  const { ctx, resumeOptions } = fakeCtx({
    liveAgents: [sender],
    stored: [{ id: 'session-cold' }],
    storedEvents: {
      'session-cold': [
        { type: 'request/context', data: { provider: 'opencode-go', model: 'deepseek-v4-pro' } },
        // The newest request wins.
        { type: 'request/context', data: { provider: 'stub', model: 'stub-model' } },
      ],
    },
  });
  const bus = makeBus(ctx, baseConfig({ allow: [{ from: '*', to: '*' }] }));

  await bus.send(sender, { target: 'session-cold', text: 'wake' });
  assert.deepEqual(resumeOptions[0].agentOptions, { provider: 'stub', model: 'stub-model' });
});

test('cold resume omits agentOptions when the log records no route', async () => {
  const sender = fakeAgent('session-s');
  const { ctx, resumeOptions } = fakeCtx({
    liveAgents: [sender],
    stored: [{ id: 'session-cold' }],
    storedEvents: { 'session-cold': [{ type: 'user/message', data: { content: [] } }] },
  });
  const bus = makeBus(ctx, baseConfig({ allow: [{ from: '*', to: '*' }] }));

  await bus.send(sender, { target: 'session-cold', text: 'wake' });
  assert.equal(resumeOptions[0].agentOptions, undefined);
});

test('cold resume still works when no sessionQuery service is mounted', async () => {
  const sender = fakeAgent('session-s');
  const { ctx, resumeOptions } = fakeCtx({
    liveAgents: [sender],
    stored: [{ id: 'session-cold' }],
    noQuery: true,
  });
  const bus = makeBus(ctx, baseConfig({ allow: [{ from: '*', to: '*' }] }));

  const result = await bus.send(sender, { target: 'session-cold', text: 'wake' });
  assert.equal(result.targetState, 'resumed');
  assert.equal(resumeOptions[0].agentOptions, undefined);
});

test('an unreadable log does not block resume', async () => {
  const sender = fakeAgent('session-s');
  const { ctx, resumeOptions } = fakeCtx({
    liveAgents: [sender],
    stored: [{ id: 'session-cold' }],
    readSessionImpl: async () => {
      throw new Error('log corrupt');
    },
  });
  const bus = makeBus(ctx, baseConfig({ allow: [{ from: '*', to: '*' }] }));

  const result = await bus.send(sender, { target: 'session-cold', text: 'wake' });
  assert.equal(result.targetState, 'resumed');
  assert.equal(resumeOptions[0].agentOptions, undefined);
});

test('sameWorkspace allows two sessions that share a workspace', async () => {
  const sender = fakeAgent('session-a', 'idle', '/tmp/project');
  const target = fakeAgent('session-b', 'idle', '/tmp/project');
  const { ctx } = fakeCtx({ liveAgents: [sender, target] });
  const bus = makeBus(ctx, baseConfig({ allow: [{ sameWorkspace: true }] }));

  const result = await bus.send(sender, { target: 'session-b', text: 'hi' });
  assert.equal(result.targetState, 'live');
  assert.equal(target.delivered.length, 1);
});

test('sameWorkspace denies sessions in different workspaces', async () => {
  const sender = fakeAgent('session-a', 'idle', '/tmp/project-one');
  const target = fakeAgent('session-b', 'idle', '/tmp/project-two');
  const { ctx } = fakeCtx({ liveAgents: [sender, target] });
  const bus = makeBus(ctx, baseConfig({ allow: [{ sameWorkspace: true }] }));

  await assert.rejects(
    () => bus.send(sender, { target: 'session-b', text: 'hi' }),
    (error) => {
      assert.equal(error.code, 'denied');
      return true;
    },
  );
  assert.equal(target.delivered.length, 0);
});

test('sameWorkspace with cwd narrows the rule to one workspace', async () => {
  const inside = fakeAgent('session-inside', 'idle', '/tmp/project');
  const alsoInside = fakeAgent('session-also', 'idle', '/tmp/project');
  const elsewhere = fakeAgent('session-elsewhere', 'idle', '/tmp/other');
  const { ctx } = fakeCtx({ liveAgents: [inside, alsoInside, elsewhere] });
  const bus = makeBus(ctx, baseConfig({ allow: [{ sameWorkspace: true, cwd: '/tmp/project' }] }));

  await bus.send(inside, { target: 'session-also', text: 'hi' });
  assert.equal(alsoInside.delivered.length, 1);

  // Both ends share /tmp/other, but the rule names /tmp/project.
  await assert.rejects(
    () => bus.send(elsewhere, { target: 'session-elsewhere', text: 'hi' }),
    (error) => {
      assert.ok(['denied', 'self-send'].includes(error.code));
      return true;
    },
  );
});

test('sameWorkspace never matches when a workspace is missing on either side', async () => {
  // Two unlocated sessions are not "in the same workspace" — matching them would
  // silently authorize every session whose cwd DSH did not record.
  const located = fakeAgent('session-located', 'idle', '/tmp/project');
  const unlocated = fakeAgent('session-unlocated', 'idle', null);
  const alsoUnlocated = fakeAgent('session-unlocated-2', 'idle', null);
  const { ctx } = fakeCtx({ liveAgents: [located, unlocated, alsoUnlocated] });
  const bus = makeBus(ctx, baseConfig({ allow: [{ sameWorkspace: true }] }));

  await assert.rejects(
    () => bus.send(located, { target: 'session-unlocated', text: 'hi' }),
    (error) => {
      assert.equal(error.code, 'denied');
      return true;
    },
  );
  await assert.rejects(
    () => bus.send(unlocated, { target: 'session-unlocated-2', text: 'hi' }),
    (error) => {
      assert.equal(error.code, 'denied');
      return true;
    },
  );
  assert.equal(unlocated.delivered.length, 0);
  assert.equal(alsoUnlocated.delivered.length, 0);
});

test('sameWorkspace tolerates a trailing separator on either side', async () => {
  const sender = fakeAgent('session-a', 'idle', '/tmp/project/');
  const target = fakeAgent('session-b', 'idle', '/tmp/project');
  const { ctx } = fakeCtx({ liveAgents: [sender, target] });
  const bus = makeBus(ctx, baseConfig({ allow: [{ sameWorkspace: true, cwd: '/tmp/project/' }] }));

  await bus.send(sender, { target: 'session-b', text: 'hi' });
  assert.equal(target.delivered.length, 1);
});

test('a stored target keeps its workspace for the sameWorkspace rule', async () => {
  const sender = fakeAgent('session-a', 'idle', '/tmp/project');
  const { ctx } = fakeCtx({
    liveAgents: [sender],
    stored: [{ id: 'session-stored', cwd: '/tmp/project' }],
  });
  const bus = makeBus(ctx, baseConfig({ allow: [{ sameWorkspace: true }] }));

  const result = await bus.send(sender, { target: 'session-stored', text: 'wake' });
  assert.equal(result.targetState, 'resumed');
});

test('a stored target in another workspace is still denied', async () => {
  const sender = fakeAgent('session-a', 'idle', '/tmp/project');
  const { ctx } = fakeCtx({
    liveAgents: [sender],
    stored: [{ id: 'session-stored', cwd: '/tmp/elsewhere' }],
  });
  const bus = makeBus(ctx, baseConfig({ allow: [{ sameWorkspace: true }] }));

  await assert.rejects(
    () => bus.send(sender, { target: 'session-stored', text: 'wake' }),
    (error) => {
      assert.equal(error.code, 'denied');
      return true;
    },
  );
});

test('id rules and workspace rules can coexist in one allowlist', async () => {
  const sender = fakeAgent('session-a', 'idle', '/tmp/project');
  const byId = fakeAgent('session-b', 'idle', '/tmp/elsewhere');
  const { ctx } = fakeCtx({ liveAgents: [sender, byId] });
  const bus = makeBus(
    ctx,
    baseConfig({
      allow: [{ from: 'session-a', to: 'session-b' }, { sameWorkspace: true }],
    }),
  );

  // Allowed by the id rule even though the workspaces differ.
  await bus.send(sender, { target: 'session-b', text: 'hi' });
  assert.equal(byId.delivered.length, 1);
});

test('a resumed target that was unloaded is resumed again instead of served from a stale cache', async () => {
  // Regression: the settled resume stayed cached, so a later send "delivered" to
  // an agent that was no longer live and reported success.
  const sender = fakeAgent('session-s');
  const { ctx, state, resumedIds, unload } = fakeCtx({
    liveAgents: [sender],
    stored: [{ id: 'session-cold' }],
  });
  const bus = makeBus(ctx, baseConfig({ allow: [{ from: '*', to: '*' }] }));

  await bus.send(sender, { target: 'session-cold', text: 'first' });
  const firstAgent = ctx.agents.get('session-cold');
  unload('session-cold');

  const result = await bus.send(sender, { target: 'session-cold', text: 'second' });
  assert.equal(result.targetState, 'resumed');
  assert.deepEqual(resumedIds, ['session-cold', 'session-cold']);
  assert.equal(state.disposed, 1, 'the stale handle is released before the new resume');
  const secondAgent = ctx.agents.get('session-cold');
  assert.notEqual(secondAgent, firstAgent);
  assert.equal(secondAgent.delivered.length, 1);
  assert.match(secondAgent.delivered[0].message.content[1].text, /second/);
  assert.equal(firstAgent.delivered.length, 1, 'nothing more reached the unloaded agent');
});

test('a settled resume is not kept as an in-flight load', async () => {
  const sender = fakeAgent('session-s');
  const { ctx } = fakeCtx({ liveAgents: [sender], stored: [{ id: 'session-cold' }] });
  const bus = makeBus(ctx, baseConfig({ allow: [{ from: '*', to: '*' }] }));

  await bus.send(sender, { target: 'session-cold', text: 'wake' });
  assert.equal(bus.resuming.size, 0);
});

test('a target locked by another process reports target-busy', async () => {
  const sender = fakeAgent('session-s');
  const owned = Object.assign(new Error('session is owned'), { name: 'SessionAlreadyOwnedError' });
  const { ctx } = fakeCtx({
    liveAgents: [sender],
    stored: [{ id: 'session-elsewhere' }],
    // The loop may wrap the persistence error; the cause chain is searched.
    resumeError: new Error('resume failed', { cause: owned }),
  });
  const bus = makeBus(ctx, baseConfig({ allow: [{ from: '*', to: '*' }] }));

  await assert.rejects(
    () => bus.send(sender, { target: 'session-elsewhere', text: 'x' }),
    (error) => {
      assert.equal(error.code, 'target-busy');
      assert.match(error.message, /another DSH process/);
      return true;
    },
  );
});

test('a failed delivery does not spend the pair rate budget', async () => {
  const sender = fakeAgent('session-s');
  const { ctx } = fakeCtx({
    liveAgents: [sender],
    stored: [{ id: 'session-cold' }],
    resumeFails: true,
  });
  const bus = makeBus(
    ctx,
    baseConfig({ allow: [{ from: '*', to: '*' }], maxSendsPerWindow: 1 }),
  );

  for (let attempt = 0; attempt < 3; attempt += 1) {
    await assert.rejects(
      () => bus.send(sender, { target: 'session-cold', text: 'x' }),
      (error) => {
        assert.equal(error.code, 'resume-failed', `attempt ${attempt} must not be rate-limited`);
        return true;
      },
    );
  }
  assert.equal(bus.recentSends.size, 0);
});

test('a target whose driver throws reports delivery-failed and refunds the slot', async () => {
  const sender = fakeAgent('session-s');
  const target = fakeAgent('session-t');
  let broken = true;
  const followup = target.followup;
  target.followup = (message) => {
    if (broken) throw new Error('session detached');
    followup(message);
  };
  const { ctx } = fakeCtx({ liveAgents: [sender, target] });
  const bus = makeBus(
    ctx,
    baseConfig({ allow: [{ from: '*', to: '*' }], maxSendsPerWindow: 1 }),
  );

  await assert.rejects(
    () => bus.send(sender, { target: 'session-t', text: 'x' }),
    (error) => {
      assert.equal(error.code, 'delivery-failed');
      return true;
    },
  );
  broken = false;
  const result = await bus.send(sender, { target: 'session-t', text: 'y' });
  assert.equal(result.targetState, 'live');
  assert.equal(target.delivered.length, 1);
});

test('expired rate entries are evicted for pairs that stopped talking', async () => {
  const a = fakeAgent('session-a');
  const b = fakeAgent('session-b');
  const c = fakeAgent('session-c');
  const { ctx } = fakeCtx({ liveAgents: [a, b, c] });
  const bus = makeBus(ctx, baseConfig({ allow: [{ from: '*', to: '*' }], rateWindowMs: 5 }));

  await bus.send(a, { target: 'session-b', text: 'x' });
  assert.equal(bus.recentSends.size, 1);
  await new Promise((resolve) => setTimeout(resolve, 15));
  await bus.send(a, { target: 'session-c', text: 'y' });
  assert.deepEqual([...bus.recentSends.keys()], ['session-a\u0000session-c']);
});

test('sameWorkspace does not match a subagent child on either side', async () => {
  // A child inherits its parent's cwd, so without this a subagent reading
  // untrusted input could instruct every root session in the project.
  const root = fakeAgent('session-root', 'idle', '/tmp/project');
  const child = fakeAgent('session-child', 'idle', '/tmp/project', {
    origin: 'subagent',
    delegationDepth: 1,
    parentSession: 'session-root',
  });
  const { ctx } = fakeCtx({
    liveAgents: [root, child],
    stored: [{ id: 'session-stored-child', cwd: '/tmp/project', origin: 'subagent', delegationDepth: 1 }],
  });
  const bus = makeBus(ctx, baseConfig({ allow: [{ sameWorkspace: true }] }));

  for (const [from, to] of [
    [child, 'session-root'],
    [root, 'session-child'],
    [root, 'session-stored-child'],
  ]) {
    await assert.rejects(
      () => bus.send(from, { target: to, text: 'x' }),
      (error) => {
        assert.equal(error.code, 'denied', `${from.id} -> ${to}`);
        return true;
      },
    );
  }
  assert.equal(root.delivered.length, 0);
});

test('includeSubagents opts a workspace rule into subagent traffic; id rules are unaffected', async () => {
  const root = fakeAgent('session-root', 'idle', '/tmp/project');
  const child = fakeAgent('session-child', 'idle', '/tmp/project', { origin: 'subagent' });
  const { ctx } = fakeCtx({ liveAgents: [root, child] });

  const opted = makeBus(ctx, baseConfig({ allow: [{ sameWorkspace: true, includeSubagents: true }] }));
  await opted.send(child, { target: 'session-root', text: 'report' });
  assert.equal(root.delivered.length, 1);

  const byId = makeBus(ctx, baseConfig({ allow: [{ from: 'session-child', to: 'session-root' }] }));
  await byId.send(child, { target: 'session-root', text: 'report' });
  assert.equal(root.delivered.length, 2);
});

test('a forked peer with parentSession but no subagent origin still counts as a peer', async () => {
  const root = fakeAgent('session-root', 'idle', '/tmp/project');
  const fork = fakeAgent('session-fork', 'idle', '/tmp/project', { parentSession: 'session-root', isSeeded: true });
  const { ctx } = fakeCtx({ liveAgents: [root, fork] });
  const bus = makeBus(ctx, baseConfig({ allow: [{ sameWorkspace: true }] }));

  await bus.send(fork, { target: 'session-root', text: 'hi' });
  assert.equal(root.delivered.length, 1);
});

test('visibleRoster lists the caller plus permitted targets, and everything under rosterScope all', async () => {
  const me = fakeAgent('session-me', 'running', '/tmp/project');
  const peer = fakeAgent('session-peer', 'idle', '/tmp/project');
  const { ctx } = fakeCtx({
    liveAgents: [me, peer],
    stored: [{ id: 'session-far', cwd: '/tmp/elsewhere' }],
  });

  const scoped = makeBus(ctx, baseConfig({ allow: [{ sameWorkspace: true }] }));
  const rows = await scoped.visibleRoster(me);
  assert.deepEqual(
    rows.map((row) => [row.id, row.self, row.allowed]),
    [
      ['session-me', true, false],
      ['session-peer', false, true],
    ],
  );

  const open = makeBus(ctx, baseConfig({ allow: [{ sameWorkspace: true }], rosterScope: 'all' }));
  const all = await open.visibleRoster(me);
  assert.deepEqual(
    all.map((row) => [row.id, row.allowed]),
    [
      ['session-me', false],
      ['session-peer', true],
      ['session-far', false],
    ],
  );
});

test('cold resume prefers the request header config, including reasoning effort', async () => {
  const sender = fakeAgent('session-s');
  const { ctx, resumeOptions } = fakeCtx({
    liveAgents: [sender],
    stored: [{ id: 'session-cold' }],
    storedEvents: {
      'session-cold': [
        {
          type: 'request/header',
          data: { reason: 'initial', header: { config: { provider: 'old', model: 'old-model' } } },
        },
        { type: 'request/context', data: { provider: 'ctx-only', model: 'ctx-model' } },
        {
          type: 'request/header',
          data: {
            reason: 'change',
            header: { config: { provider: 'deepseek', model: 'deepseek-v4', reasoningEffort: 'high' } },
          },
        },
        // A plugin event that happens to carry provider/model is not a route.
        { type: 'subagent/spawned', data: { provider: 'child', model: 'child-model' } },
      ],
    },
  });
  const bus = makeBus(ctx, baseConfig({ allow: [{ from: '*', to: '*' }] }));

  await bus.send(sender, { target: 'session-cold', text: 'wake' });
  assert.deepEqual(resumeOptions[0].agentOptions, {
    provider: 'deepseek',
    model: 'deepseek-v4',
    reasoningEffort: 'high',
  });
});

test('cold resume ignores non-route events that carry provider and model fields', async () => {
  const sender = fakeAgent('session-s');
  const { ctx, resumeOptions } = fakeCtx({
    liveAgents: [sender],
    stored: [{ id: 'session-cold' }],
    storedEvents: {
      'session-cold': [
        { type: 'request/context', data: { provider: 'stub', model: 'stub-model' } },
        { type: 'subagent/spawned', data: { provider: 'child', model: 'child-model' } },
      ],
    },
  });
  const bus = makeBus(ctx, baseConfig({ allow: [{ from: '*', to: '*' }] }));

  await bus.send(sender, { target: 'session-cold', text: 'wake' });
  assert.deepEqual(resumeOptions[0].agentOptions, { provider: 'stub', model: 'stub-model' });
});

test('cold resume mounts the preset the session recorded', async () => {
  // DSH's own resume installs the model selection AND mounts the preset. Without
  // the mount the resumed agent keeps the default composition: wrong system prompt,
  // reduced toolset, and no error — the turn still completes.
  const sender = fakeAgent('session-s');
  const mounted = [];
  const { ctx, resumeOptions } = fakeCtx({
    liveAgents: [sender],
    stored: [{ id: 'session-cold', agentPreset: 'probe' }],
  });
  ctx.provide('agentPresets', {
    mount(agentCtx, id) {
      mounted.push({ agentCtx, id });
      return Promise.resolve({ id });
    },
  });
  const bus = makeBus(ctx, baseConfig({ allow: [{ from: '*', to: '*' }] }));

  await bus.send(sender, { target: 'session-cold', text: 'wake' });
  assert.deepEqual(mounted.map((entry) => entry.id), ['probe']);
  // The mount has to happen from the resume setup callback: that is the only point
  // where the agent is unpublished and `mount` accepts its scoped context.
  assert.equal(typeof resumeOptions[0].setup, 'function');
  assert.equal(mounted[0].agentCtx, 'agent-ctx-from-setup');
});

test('the preset projection wins over the header, matching DSH resume', async () => {
  const sender = fakeAgent('session-s');
  const mounted = [];
  const { ctx } = fakeCtx({
    liveAgents: [sender],
    stored: [{ id: 'session-cold', agentPreset: 'from-header' }],
  });
  ctx.provide('sessionProjections', { stateOf: () => 'from-projection' });
  ctx.provide('agentPresets', {
    mount(_agentCtx, id) {
      mounted.push(id);
      return Promise.resolve({ id });
    },
  });
  const bus = makeBus(ctx, baseConfig({ allow: [{ from: '*', to: '*' }] }));

  await bus.send(sender, { target: 'session-cold', text: 'wake' });
  assert.deepEqual(mounted, ['from-projection']);
});

test('cold resume skips the mount when no preset registry is mounted', async () => {
  const sender = fakeAgent('session-s');
  const { ctx, resumeOptions } = fakeCtx({
    liveAgents: [sender],
    stored: [{ id: 'session-cold', agentPreset: 'probe' }],
  });
  const bus = makeBus(ctx, baseConfig({ allow: [{ from: '*', to: '*' }] }));

  const result = await bus.send(sender, { target: 'session-cold', text: 'wake' });
  assert.equal(result.targetState, 'resumed');
  // A preset-free composition has nothing to restore, and the resume must still work.
  assert.equal(typeof resumeOptions[0].setup, 'function');
  await resumeOptions[0].setup('agent-ctx-from-setup', { session: { header: {} } });
});

test('a failing preset mount fails the resume instead of composing wrongly', async () => {
  const sender = fakeAgent('session-s');
  const { ctx } = fakeCtx({
    liveAgents: [sender],
    stored: [{ id: 'session-cold', agentPreset: 'deleted-preset' }],
  });
  ctx.provide('agentPresets', {
    mount() {
      throw new Error('unknown preset "deleted-preset"');
    },
  });
  const bus = makeBus(ctx, baseConfig({ allow: [{ from: '*', to: '*' }] }));

  await assert.rejects(
    () => bus.send(sender, { target: 'session-cold', text: 'wake' }),
    (error) => {
      assert.equal(error.code, 'resume-failed');
      assert.match(error.message, /deleted-preset/);
      return true;
    },
  );
});
