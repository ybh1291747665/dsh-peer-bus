/**
 * Tests for the runtime allowlist behind `/bus allow`.
 *
 * The policy question these pin is that runtime grants are **additive**: they can
 * admit a pair the config does not cover, and `/bus revoke` can only take back a
 * grant made this way — never subtract from the config.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { RuntimeAllowlist, allowlistDomain, loadStateSchema } from '../src/allowlist.js';
import { baseConfig, fakeAgent, fakeCtx, fakeStorageDomain, makeBus } from './helpers.js';

/** Two live roots with no allow rule between them. */
const pair = () => ({ sender: fakeAgent('session-sender'), target: fakeAgent('session-target') });

test('a stored grant admits exactly one direction', async () => {
  const facility = fakeStorageDomain({ grants: [{ from: 'session-sender', to: 'session-target' }] });
  const { sender, target } = pair();
  const { ctx } = fakeCtx({ liveAgents: [sender, target], storageDomain: facility });
  const bus = makeBus(ctx, baseConfig());

  await bus.roster();
  assert.equal(bus.isAllowed(bus.rowOf(sender), bus.rowOf(target)), true);
  assert.equal(bus.isAllowed(bus.rowOf(target), bus.rowOf(sender)), false);
});

test('a grant is written through, so a restart over the same store keeps it', async () => {
  const facility = fakeStorageDomain();
  const first = makeBus(fakeCtx({ storageDomain: facility }).ctx, baseConfig());
  await first.allowlist.ready;
  assert.equal(await first.allowlist.grant('session-sender', 'session-target'), true);
  assert.deepEqual(facility.state.grants, [{ from: 'session-sender', to: 'session-target' }]);

  const { sender, target } = pair();
  const second = makeBus(
    fakeCtx({ liveAgents: [sender, target], storageDomain: facility }).ctx,
    baseConfig(),
  );
  // `isAllowed` is synchronous; every real caller reaches it through `roster()`,
  // which is what waits for the load.
  await second.roster();
  assert.equal(second.isAllowed(second.rowOf(sender), second.rowOf(target)), true);
});

test('a permission decision waits for the durable grants to load', async () => {
  // Without the `await allowlist.ready` in `roster`, the first send after a
  // restart would be decided against an empty set and refused.
  const facility = fakeStorageDomain(
    { grants: [{ from: 'session-sender', to: 'session-target' }] },
    { slowOpenMs: 25 },
  );
  const { sender, target } = pair();
  const { ctx } = fakeCtx({ liveAgents: [sender, target], storageDomain: facility });
  const bus = makeBus(ctx, baseConfig());

  const result = await bus.send(sender, { target: target.id, text: 'first send after a restart' }, {});
  assert.equal(result.target, target.id);
  assert.equal(target.delivered.length, 1);
});

test('granting the same pair twice reports the second as a no-op', async () => {
  const allowlist = new RuntimeAllowlist(fakeCtx({ storageDomain: fakeStorageDomain() }).ctx);
  assert.equal(await allowlist.grant('a', 'b'), true);
  assert.equal(await allowlist.grant('a', 'b'), false);
  assert.equal(allowlist.entries.length, 1);
});

test('duplicate records in storage collapse to one grant', async () => {
  const facility = fakeStorageDomain({
    grants: [
      { from: 'a', to: 'b' },
      { from: 'a', to: 'b' },
    ],
  });
  const allowlist = new RuntimeAllowlist(fakeCtx({ storageDomain: facility }).ctx);
  await allowlist.ready;
  assert.equal(allowlist.entries.length, 1);
});

test('revoke removes a runtime grant and persists the removal', async () => {
  const facility = fakeStorageDomain();
  const allowlist = new RuntimeAllowlist(fakeCtx({ storageDomain: facility }).ctx);
  await allowlist.grant('a', 'b');
  assert.equal(await allowlist.revoke('a', 'b'), true);
  assert.equal(await allowlist.revoke('a', 'b'), false);
  assert.equal(allowlist.has('a', 'b'), false);
  assert.deepEqual(facility.state.grants, []);
});

test('a revoke cannot subtract from the config allowlist', async () => {
  const { sender, target } = pair();
  const facility = fakeStorageDomain({ grants: [{ from: 'session-sender', to: 'session-target' }] });
  const { ctx } = fakeCtx({ liveAgents: [sender, target], storageDomain: facility });
  const bus = makeBus(ctx, baseConfig({ allow: [{ from: 'session-sender', to: 'session-target' }] }));

  await bus.allowlist.revoke('session-sender', 'session-target');
  assert.equal(bus.isAllowed(bus.rowOf(sender), bus.rowOf(target)), true);
});

test('without a storage domain the allowlist is memory-only and still works', async () => {
  const { sender, target } = pair();
  const { ctx } = fakeCtx({ liveAgents: [sender, target] });
  const bus = makeBus(ctx, baseConfig());

  await bus.allowlist.ready;
  await bus.allowlist.grant('session-sender', 'session-target');
  assert.equal(bus.isAllowed(bus.rowOf(sender), bus.rowOf(target)), true);
  await bus.dispose();
});

test('a domain that fails to open is reported instead of breaking the bus', async () => {
  const facility = fakeStorageDomain({ grants: [] }, { failOpen: true });
  const warnings = [];
  const { sender, target } = pair();
  const { ctx } = fakeCtx({ liveAgents: [sender, target], storageDomain: facility });
  ctx.logger.warn = (...args) => warnings.push(args.map(String).join(' '));
  const bus = makeBus(ctx, baseConfig());

  await bus.allowlist.ready;
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /memory-only/);
  await bus.allowlist.grant('session-sender', 'session-target');
  assert.equal(bus.isAllowed(bus.rowOf(sender), bus.rowOf(target)), true);
});

test('the durable schema accepts a real snapshot and rejects junk', async () => {
  const schema = await loadStateSchema();
  assert.notEqual(schema, undefined, 'zod must resolve for the durable path to exist');
  assert.deepEqual(schema.parse({ grants: [{ from: 'a', to: 'b' }] }), {
    grants: [{ from: 'a', to: 'b' }],
  });
  assert.deepEqual(schema.parse({}), { grants: [] });
  // The domain layer rejects a global schema that accepts null, because null is
  // the medium's "never written" sentinel.
  assert.equal(schema.safeParse(null).success, false);
  assert.equal(schema.safeParse({ grants: [{ from: 1, to: 'b' }] }).success, false);
});

test('the domain spec is built from the loaded schema', async () => {
  const schema = await loadStateSchema();
  const spec = allowlistDomain(schema);
  assert.equal(spec.name, 'peer_bus_allowlist');
  assert.equal(spec.version, 1);
  assert.deepEqual(spec.tables, {});
  assert.equal(spec.global.schema, schema);
});

test('the domain declaration uses a name the storage layer accepts', async () => {
  const facility = fakeStorageDomain();
  const allowlist = new RuntimeAllowlist(fakeCtx({ storageDomain: facility }).ctx);
  await allowlist.ready;
  assert.equal(facility.opens.length, 1);
  // The storage layer validates names with /^[a-z][a-z0-9_]*$/, which is why this
  // is underscored rather than hyphenated like the package itself.
  assert.match(facility.opens[0].name, /^[a-z][a-z0-9_]*$/);
  assert.deepEqual(facility.opens[0].tables, {});
  assert.equal(facility.opens[0].global.initial.grants.length, 0);
});
