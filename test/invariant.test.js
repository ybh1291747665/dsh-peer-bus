/**
 * Tests for the package-owned `./invariant` companion.
 *
 * These assert the durable-shape contract only. Permission, size, and rate policy
 * belong to `Config` and are covered in peer-bus.test.js.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import { PACKAGE_NAME, apply, name, validateEvent } from '../src/invariant.js';

/** A well-formed bus message as the bus builds it. */
const busMessage = (senderSessionId, text = 'hello') => ({
  role: 'user',
  id: 'msg-1',
  source: { kind: 'peer-bus-message', form: 'relay', senderSessionId },
  content: [{ type: 'text', text }],
});

/** A `user/message` event wrapping one bus message. */
const userMessageEvent = (senderSessionId, text) => ({
  type: 'user/message',
  data: busMessage(senderSessionId, text),
});

/** An inbox splice event wrapping one bus message. */
const spliceEvent = (senderSessionId, target = 'next-turn') => ({
  type: 'agent/inbox/spliced',
  data: { target, start: 0, inserted: [busMessage(senderSessionId)] },
});

/**
 * Collect every failure a validator reports instead of throwing on the first.
 *
 * @param run - body receiving the fail reporter.
 * @returns the reported messages, in order.
 */
function failures(run) {
  const seen = [];
  const fail = (message) => {
    seen.push(message);
  };
  run(fail);
  return seen;
}

test('the companion declares the official invariant-plugin contract', () => {
  assert.equal(name, 'peer-bus-invariant');
  assert.equal(typeof apply, 'function');
  assert.equal(PACKAGE_NAME, 'dsh-peer-bus');
});

test('the companion does not declare invariants as its own dependency', async () => {
  // Declaring it would hold this entry at \`pending\` on every profile that does
  // not mount \`dsh-invariants\` — which is all of them except dsh-sdk-minimal — and
  // the loader prints a startup warning for each pending entry. The service is
  // awaited in a nested fiber instead, so the entry activates and the companion
  // registers the moment the service appears.
  const module = await import('../src/invariant.js');
  assert.equal(module.inject, undefined);

  const injected = [];
  const ctx = {
    inject: (deps, callback) => {
      injected.push({ deps, callback });
      return Promise.resolve();
    },
  };
  apply(ctx);
  assert.deepEqual(injected.map((entry) => entry.deps), [['invariants']]);
  assert.equal(typeof injected[0].callback, 'function');
});

test('the companion registers once the invariants service appears', async () => {
  const registered = [];
  const ctx = {
    inject: (deps, callback) =>
      Promise.resolve(callback({ invariants: { register: (pkg, installer) => registered.push({ pkg, installer }) } })),
  };
  apply(ctx);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(registered.length, 1);
  assert.equal(registered[0].pkg, 'dsh-peer-bus');
  assert.deepEqual(registered[0].installer.inject, ['sessions']);
});

test('a well-formed bus message reports no failure', async () => {
  assert.deepEqual(failures((fail) => validateEvent('session-a', userMessageEvent('session-b'), fail)), []);
});

test('a splice into a legal inbox target reports no failure', async () => {
  for (const target of ['next-turn', 'next-step']) {
    assert.deepEqual(
      failures((fail) => validateEvent('session-a', spliceEvent('session-b', target), fail)),
      [],
      target,
    );
  }
});

test('non-bus sources are ignored entirely', async () => {
  const foreign = [
    { type: 'user/message', data: { role: 'user', content: [], source: { kind: 'user' } } },
    {
      type: 'user/message',
      data: {
        role: 'user',
        content: [],
        source: { kind: 'agent-message', form: 'relay', senderSessionId: 'session-x' },
      },
    },
    { type: 'agent/inbox/spliced', data: { target: 'nonsense', inserted: [{ source: { kind: 'user' } }] } },
    { type: 'turn/start', data: {} },
  ];
  for (const event of foreign) {
    assert.deepEqual(failures((fail) => validateEvent('session-a', event, fail)), [], event.type);
  }
});

test('a bus message with no sender is rejected', async () => {
  const broken = userMessageEvent('session-b');
  broken.data.source.senderSessionId = '';
  const seen = failures((fail) => validateEvent('session-a', broken, fail));
  assert.equal(seen.length, 1);
  assert.match(seen[0], /non-empty senderSessionId/);
});

test('a bus message with the wrong context form is rejected', async () => {
  const broken = userMessageEvent('session-b');
  broken.data.source.form = 'notice';
  const seen = failures((fail) => validateEvent('session-a', broken, fail));
  assert.equal(seen.length, 1);
  assert.match(seen[0], /relay context form/);
});

test('a non-user-role or empty-content bus message is rejected', async () => {

  const wrongRole = userMessageEvent('session-b');
  wrongRole.data.role = 'assistant';
  assert.match(
    failures((fail) => validateEvent('session-a', wrongRole, fail))[0],
    /must be user-role/,
  );

  const empty = userMessageEvent('session-b');
  empty.data.content = [];
  assert.match(
    failures((fail) => validateEvent('session-a', empty, fail))[0],
    /non-empty content/,
  );

  const blank = userMessageEvent('session-b', '   ');
  assert.match(
    failures((fail) => validateEvent('session-a', blank, fail))[0],
    /readable text/,
  );
});

test('a session that recorded a message to itself is rejected', async () => {
  // The bus rejects self-send at the tool boundary; the invariant catches a
  // regression that reaches the durable log anyway.
  const seen = failures((fail) => validateEvent('session-a', userMessageEvent('session-a'), fail));
  assert.equal(seen.length, 1);
  assert.match(seen[0], /sent to itself/);

  const spliced = failures((fail) => validateEvent('session-a', spliceEvent('session-a'), fail));
  assert.equal(spliced.length, 1);
  assert.match(spliced[0], /spliced a peer-bus-message message sent to itself/);
});

test('a splice into an unknown inbox target is rejected', async () => {
  const seen = failures((fail) => validateEvent('session-a', spliceEvent('session-b', 'somewhere'), fail));
  assert.equal(seen.length, 1);
  assert.match(seen[0], /unknown inbox target/);
});

test('apply registers the package with the invariant service, without awaiting it', async () => {
  const ctx = new Context();
  const registered = [];
  ctx.provide('invariants', {
    register(packageName, installer) {
      registered.push({ packageName, installer });
      return () => {};
    },
  });

  // Returning the nested fiber would make the entry await the service, which is
  // exactly the pending state that prints a startup warning.
  assert.equal(apply(ctx), undefined);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(registered.length, 1);
  assert.equal(registered[0].packageName, 'dsh-peer-bus');
  assert.deepEqual(registered[0].installer.inject, ['sessions']);
});

test('apply stays inert, and silent, without an invariant service', async () => {
  const ctx = new Context();
  assert.equal(apply(ctx), undefined);
  await new Promise((resolve) => setImmediate(resolve));
  // Nothing to assert beyond "it did not throw and did not block the entry": a
  // missing service is the normal case on every shipped profile but one.
});

test('the installer seeds existing logs and rejects a malformed dispatched event', async () => {
  const listeners = new Map();
  /** Fake context capturing the listeners the installer registers. */
  const installerCtx = {
    sessions: {
      list: () => [{ id: 'session-seed', snapshotEvents: () => [userMessageEvent('session-seed')] }],
    },
    on(eventName, handler) {
      const rows = listeners.get(eventName) ?? [];
      rows.push(handler);
      listeners.set(eventName, rows);
      return () => {};
    },
  };

  // Capture the installer the companion hands to the invariant service.
  let installer;
  const ctx = new Context();
  ctx.provide('invariants', {
    register(_packageName, candidate) {
      installer = candidate;
      return () => {};
    },
  });
  await apply(ctx);
  assert.equal(typeof installer, 'function');

  // A fail reporter that throws, mimicking InvariantError from the real service.
  const fail = (message) => {
    throw new Error(message);
  };

  // Seeding walks existing logs, so a pre-existing self-send is caught at install.
  assert.throws(() => installer(installerCtx, fail), /sent to itself/);

  // With a clean log, install succeeds and the dispatch listener rejects a bad event.
  installerCtx.sessions.list = () => [
    { id: 'session-seed', snapshotEvents: () => [userMessageEvent('session-other')] },
  ];
  installer(installerCtx, fail);
  assert.equal(listeners.get('session/created').length, 1);
  assert.equal(listeners.get('internal/dispatch').length, 1);

  const dispatch = (session, event) => {
    for (const handler of listeners.get('internal/dispatch')) {
      handler('emit', 'session/event', [session, event]);
    }
  };
  assert.throws(() => dispatch({ id: 'session-a' }, userMessageEvent('session-a')), /sent to itself/);
  // A foreign event passes straight through.
  dispatch({ id: 'session-a' }, { type: 'turn/start', data: {} });
  // A non-session/event dispatch is ignored.
  for (const handler of listeners.get('internal/dispatch')) {
    handler('emit', 'tools/result', [{}, {}]);
  }
});
