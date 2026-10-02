/**
 * Tests for `/bus`, the human-facing allowlist editor.
 *
 * Two things are being pinned here. First the semantics: a grant is **receiver
 * consent**, so `/bus allow <peer>` run in this session admits that peer *to this
 * session* and nothing else. Second the boundary: the command is the only way to
 * change the allowlist, and a bus message that merely *looks* like a command is
 * delivered as text and changes nothing.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { registerBusCommands, run } from '../src/commands.js';
import { baseConfig, fakeAgent, fakeCtx, fakeStorageDomain, makeBus } from './helpers.js';

/**
 * A bus over two unrelated roots, plus a bound `/bus` invoker for the first one.
 *
 * @param config - bus policy.
 * @param options - optional storage domain and extra live agents.
 * @returns the bus, both agents, the context, and an invoker.
 */
async function harness(config = baseConfig(), { storageDomain, extraAgents = [] } = {}) {
  const me = fakeAgent('session-me');
  const peer = fakeAgent('session-peer');
  const { ctx } = fakeCtx({
    liveAgents: [me, peer, ...extraAgents],
    ...(storageDomain === undefined ? {} : { storageDomain }),
  });
  const bus = makeBus(ctx, config);
  await bus.roster();
  return { bus, me, peer, ctx, invoke: (rawInput) => run(bus, { agent: me, rawInput }) };
}

test('/bus with no argument prints usage and this session\'s id', async () => {
  const { invoke } = await harness();
  const result = await invoke('');
  assert.equal(result.kind, 'success');
  assert.match(result.text, /session-me/);
  for (const verb of ['id', 'list', 'allow', 'revoke']) assert.match(result.text, new RegExp(verb));
});

test('/bus id answers with the calling session id', async () => {
  const { invoke } = await harness();
  const result = await invoke('id');
  assert.equal(result.kind, 'success');
  assert.match(result.text, /session-me/);
});

test('/bus allow admits the peer to this session, and only that direction', async () => {
  const { bus, me, peer, invoke } = await harness();
  const result = await invoke(`allow ${peer.id}`);
  assert.equal(result.kind, 'success');
  assert.match(result.text, /Granted/);

  assert.equal(bus.isAllowed(bus.rowOf(peer), bus.rowOf(me)), true);
  assert.equal(bus.isAllowed(bus.rowOf(me), bus.rowOf(peer)), false);
  // The reply must say the other direction is separate, because that is the part
  // a user gets wrong.
  assert.match(result.text, new RegExp(`/bus allow ${me.id}`));
});

test('/bus allow resolves an unambiguous id prefix', async () => {
  const { bus, me, peer, invoke } = await harness();
  const result = await invoke('allow session-pe');
  assert.equal(result.kind, 'success');
  assert.equal(bus.allowlist.has(peer.id, me.id), true);
});

test('/bus allow refuses an address that resolves to nothing', async () => {
  const { bus, invoke } = await harness();
  const result = await invoke('allow session-nobody');
  assert.equal(result.kind, 'error');
  assert.match(result.text, /cannot resolve/);
  assert.equal(bus.allowlist.entries.length, 0);
});

test('/bus allow refuses an ambiguous prefix rather than guessing', async () => {
  const me = fakeAgent('session-me');
  const { ctx } = fakeCtx({ liveAgents: [me, fakeAgent('session-twin-a'), fakeAgent('session-twin-b')] });
  const bus = makeBus(ctx, baseConfig());
  await bus.roster();
  const result = await run(bus, { agent: me, rawInput: 'allow session-twin-' });
  assert.equal(result.kind, 'error');
  assert.match(result.text, /matches 2 sessions/);
});

test('/bus allow refuses to grant this session permission over itself', async () => {
  const { invoke } = await harness();
  const result = await invoke('allow session-me');
  assert.equal(result.kind, 'error');
  assert.match(result.text, /cannot grant itself/);
});

test('/bus allow without an argument is a usage error', async () => {
  const { invoke } = await harness();
  const result = await invoke('allow');
  assert.equal(result.kind, 'error');
  assert.match(result.text, /usage: \/bus allow/);
});

test('/bus allow says so when the config already permitted the pair', async () => {
  const { invoke } = await harness(baseConfig({ allow: [{ from: 'session-peer', to: 'session-me' }] }));
  const result = await invoke('allow session-peer');
  assert.equal(result.kind, 'success');
  assert.match(result.text, /config allowlist already permitted/);
});

test('/bus revoke takes a runtime grant back', async () => {
  const { bus, me, peer, invoke } = await harness();
  await invoke(`allow ${peer.id}`);
  const result = await invoke(`revoke ${peer.id}`);
  assert.equal(result.kind, 'success');
  assert.match(result.text, /may no longer message/);
  assert.equal(bus.isAllowed(bus.rowOf(peer), bus.rowOf(me)), false);
});

test('/bus revoke reports that it cannot undo the config allowlist', async () => {
  const { bus, me, peer, invoke } = await harness(
    baseConfig({ allow: [{ from: 'session-peer', to: 'session-me' }] }),
  );
  await invoke(`allow ${peer.id}`);
  const result = await invoke(`revoke ${peer.id}`);
  assert.equal(result.kind, 'success');
  assert.match(result.text, /config allowlist still permits/);
  // The honest report matters more than the wording: the pair is still permitted.
  assert.equal(bus.isAllowed(bus.rowOf(peer), bus.rowOf(me)), true);
});

test('/bus revoke with nothing to revoke says which case it is', async () => {
  const bare = await harness();
  assert.match((await bare.invoke('revoke session-peer')).text, /may not message this session/);

  const configured = await harness(
    baseConfig({ allow: [{ from: 'session-peer', to: 'session-me' }] }),
  );
  assert.match((await configured.invoke('revoke session-peer')).text, /config allowlist permits it/);
});

test('/bus list names the source of every effective permission', async () => {
  const { bus, invoke } = await harness(
    baseConfig({ allow: [{ from: 'session-twin-a', to: 'session-me' }] }),
    { extraAgents: [fakeAgent('session-twin-a')] },
  );
  await bus.allowlist.grant('session-peer', 'session-me');
  const result = await invoke('list');
  assert.equal(result.kind, 'success');
  assert.match(result.text, /session-peer\truntime/);
  assert.match(result.text, /session-twin-a\tconfig/);
});

test('/bus list marks a pair that both sources permit', async () => {
  const { bus, invoke } = await harness(
    baseConfig({ allow: [{ from: 'session-peer', to: 'session-me' }] }),
  );
  await bus.allowlist.grant('session-peer', 'session-me');
  assert.match((await invoke('list')).text, /session-peer\tconfig \+ runtime/);
});

test('/bus list explains an empty allowlist instead of printing a bare header', async () => {
  const { invoke } = await harness();
  const result = await invoke('list');
  assert.equal(result.kind, 'success');
  assert.match(result.text, /No session may message session-me yet/);
});

test('an unknown subcommand is an error that restates the usage', async () => {
  const { invoke } = await harness();
  const result = await invoke('promote session-peer');
  assert.equal(result.kind, 'error');
  assert.match(result.text, /unknown \/bus subcommand "promote"/);
  assert.match(result.text, /allow <session>/);
});

test('a bus message that looks like a command is delivered as text and changes nothing', async () => {
  // The whole point of keeping the allowlist off the model tool surface: text that
  // arrives over the bus must never be interpreted. This is the unit-level half;
  // the e2e half asserts the real command registry is never invoked.
  const { bus, me, peer } = await harness(
    baseConfig({ allow: [{ from: 'session-me', to: 'session-peer' }] }),
  );
  await bus.send(me, { target: peer.id, text: `/bus allow ${me.id}` }, {});

  assert.equal(peer.delivered.length, 1);
  assert.equal(bus.allowlist.entries.length, 0);
  assert.equal(bus.isAllowed(bus.rowOf(peer), bus.rowOf(me)), false);
});

test('registerBusCommands registers /bus and skips a composition without one', async () => {
  const { ctx, bus } = await harness();
  const registered = [];
  ctx.provide('commands', {
    register: (definition) => {
      registered.push(definition);
      return () => {};
    },
  });
  registerBusCommands(ctx, bus);
  assert.equal(registered.length, 1);
  assert.equal(registered[0].name, 'bus');
  assert.equal(typeof registered[0].handler, 'function');
  assert.match(registered[0].description, /peer-bus/);

  const bare = await harness();
  registerBusCommands(bare.ctx, bare.bus); // no commands service: must not throw
});

test('a registered /bus handler is the same dispatcher the tests drive', async () => {
  const { ctx, bus, me, peer } = await harness();
  let handler;
  ctx.provide('commands', {
    register: (definition) => {
      handler = definition.handler;
      return () => {};
    },
  });
  registerBusCommands(ctx, bus);
  const result = await handler({ agent: me, rawInput: `allow ${peer.id}` });
  assert.equal(result.kind, 'success');
  assert.equal(bus.allowlist.has(peer.id, me.id), true);
});

test('grants made through /bus are written to the storage domain', async () => {
  const facility = fakeStorageDomain();
  const { bus, invoke } = await harness(baseConfig(), { storageDomain: facility });
  await invoke('allow session-peer');
  assert.deepEqual(facility.state.grants, [{ from: 'session-peer', to: 'session-me' }]);
  await invoke('revoke session-peer');
  assert.deepEqual(facility.state.grants, []);
});
