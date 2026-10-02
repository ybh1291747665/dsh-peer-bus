/**
 * Plugin-contract tests: the module must satisfy the Cordis plugin shape that
 * `dsh plugin add` mounts, and `apply()` must register its service and tools.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import * as moduleNamespace from '../src/index.js';
import { Config, apply, inject, name } from '../src/index.js';

/**
 * Build a context with the services `inject` names, capturing tool registrations.
 *
 * @returns the context plus the registered tool names.
 */
function harness() {
  const ctx = new Context();
  const registered = [];
  ctx.provide('agents', { list: () => [], get: () => undefined });
  ctx.provide('sessionPersistence', { list: async () => [] });
  ctx.provide('tools', {
    register(definition) {
      registered.push(definition);
      return () => {};
    },
    get: () => undefined,
  });
  return { ctx, registered };
}

test('the module exports the Cordis plugin contract with no default export', () => {
  assert.equal(name, 'peer-bus');
  assert.equal(typeof apply, 'function');
  assert.equal(typeof Config, 'function');
  // The loader's `unwrapExports` prefers `exports.default`, so a default export
  // would replace the module namespace and drop name/inject/Config.
  assert.equal(moduleNamespace.default, undefined, 'a default export would break plugin loading');
});

test('inject declares only required services, leaving persistence optional', () => {
  assert.deepEqual(inject, ['agents', 'tools']);
  // A declared-but-absent service blocks the whole plugin, and cold resume is an
  // optional capability, so persistence must be read lazily instead.
  assert.ok(!inject.includes('sessionPersistence'));
});

test('Config defaults to default-deny with bounded message and rate limits', () => {
  const resolved = new Config({});
  assert.deepEqual(resolved.allow, []);
  assert.equal(resolved.maxMessageBytes, 16384);
  assert.equal(resolved.maxSendsPerWindow, 10);
  assert.equal(resolved.rateWindowMs, 60000);
});

test('apply registers the bus service and exactly five bus_* tools', () => {
  const { ctx, registered } = harness();
  apply(ctx, new Config({}));

  assert.notEqual(ctx.get('peerBus'), undefined);
  assert.deepEqual(
    registered.map((definition) => definition.name),
    ['bus_roster', 'bus_send', 'bus_ask', 'bus_reply', 'bus_status', 'bus_wait'],
  );
});

test('registered tools avoid the globally claimed send_message name', () => {
  const { ctx, registered } = harness();
  apply(ctx, new Config({}));

  const names = registered.map((definition) => definition.name);
  assert.ok(!names.includes('send_message'), 'send_message is owned by dsh-tool-subagent-control');
  assert.ok(!names.includes('list_agents'), 'list_agents is owned by dsh-tool-subagent-control');
});

test('every registered tool declares an output schema and a renderer', () => {
  const { ctx, registered } = harness();
  apply(ctx, new Config({}));

  for (const definition of registered) {
    assert.equal(typeof definition.description, 'string');
    assert.ok(definition.description.length > 20, `${definition.name} needs a real description`);
    assert.equal(typeof definition.execute, 'function');
    assert.equal(typeof definition.output?.schema, 'object');
    assert.equal(typeof definition.output?.render, 'function');
  }
});

test('apply rejects an invalid policy instead of registering a half-open bus', () => {
  const { ctx } = harness();
  assert.throws(() => apply(ctx, new Config({ allow: [{ from: 'only-from' }] })));
});
