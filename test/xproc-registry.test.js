/**
 * Tests for the cross-process transport's two filesystem-facing pieces.
 *
 * These are the parts where being wrong is expensive and quiet: a socket path that
 * exceeds `sun_path` fails at bind, a registry entry with the wrong permissions
 * hands another user a token, and a staleness sweep that is too eager makes a
 * live peer undiscoverable. None of that is visible from the bus's own tests.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EndpointRegistry, ensurePrivateDir, isProcessAlive } from '../src/xproc/registry.js';
import { SUN_PATH_MAX, shortName, socketPathFor } from '../src/xproc/socket-path.js';

/** A fresh throwaway directory per test. */
const scratch = () => mkdtemp(join(tmpdir(), 'peer-bus-xproc-'));

/** A pid that is certainly not running, and certainly not this process. */
const DEAD_PID = 999999;

test('a socket path under a normal home stays in the DSH home', () => {
  const result = socketPathFor({ home: '/Users/someone/.dsh', endpointId: 'ep-1', platform: 'darwin' });
  assert.equal(result.location, 'home');
  assert.equal(result.fallback, false);
  assert.match(result.socket, /\/Users\/someone\/\.dsh\/peer-bus\/s\/[0-9a-f]{16}\.sock$/);
  assert.ok(Buffer.byteLength(result.socket) <= SUN_PATH_MAX);
});

test('a home too long for sun_path falls back to a per-uid temp directory', () => {
  const longHome = `/Users/someone/${'nested/'.repeat(20)}home`;
  const preferredLength = Buffer.byteLength(join(longHome, 'peer-bus', 's', `${shortName('ep-1')}.sock`));
  assert.ok(preferredLength > SUN_PATH_MAX, 'the fixture must actually exceed the limit');

  const result = socketPathFor({
    home: longHome,
    endpointId: 'ep-1',
    platform: 'darwin',
    uid: 501,
    tmp: '/var/folders/xx/T',
  });
  assert.equal(result.location, 'tmp');
  assert.equal(result.fallback, true);
  assert.equal(result.socket, `/var/folders/xx/T/dsh-pb-501/${shortName('ep-1')}.sock`);
  assert.ok(Buffer.byteLength(result.socket) <= SUN_PATH_MAX);
});

test('the limit is measured in bytes, not characters', () => {
  // 40 three-byte characters is 120 bytes but only 40 characters: a check on
  // string length would let this through and the kernel would refuse the bind.
  const home = `/tmp/${'中'.repeat(40)}`;
  const result = socketPathFor({ home, endpointId: 'ep-1', platform: 'darwin', uid: 501, tmp: '/tmp' });
  assert.equal(result.location, 'tmp');
});

test('windows uses a named pipe that does not leak the home path', () => {
  const result = socketPathFor({ home: '/Users/someone/.dsh', endpointId: 'ep-1', platform: 'win32' });
  assert.equal(result.location, 'pipe');
  assert.match(result.socket, /^\\\\\.\\pipe\\dsh-peer-bus-[0-9a-f]{12}-[0-9a-f]{16}$/);
  assert.ok(!result.socket.includes('someone'));
});

test('the same endpoint id always maps to the same socket name', () => {
  assert.equal(shortName('ep-1'), shortName('ep-1'));
  assert.notEqual(shortName('ep-1'), shortName('ep-2'));
});

test('isProcessAlive knows this process is alive and a dead pid is not', () => {
  assert.equal(isProcessAlive(process.pid), true);
  assert.equal(isProcessAlive(DEAD_PID), false);
  assert.equal(isProcessAlive(0), false);
  assert.equal(isProcessAlive(-1), false);
  assert.equal(isProcessAlive(undefined), false);
});

test('publishing creates an owner-only entry and token', async () => {
  const home = await scratch();
  try {
    const registry = new EndpointRegistry({
      home,
      endpointId: 'ep-1',
      socket: '/tmp/s.sock',
      profile: 'headless',
      version: '0.2.0',
    });
    await registry.publish('secret-token');

    const dirMode = (await stat(registry.dir)).mode & 0o777;
    const entryMode = (await stat(registry.entryFile)).mode & 0o777;
    const tokenMode = (await stat(registry.tokenFile)).mode & 0o777;
    assert.equal(dirMode, 0o700, 'the endpoint directory must be owner-only');
    assert.equal(entryMode, 0o600, 'the entry must be owner-only');
    assert.equal(tokenMode, 0o600, 'the token must be owner-only');

    const entry = JSON.parse(await readFile(registry.entryFile, 'utf8'));
    assert.equal(entry.endpointId, 'ep-1');
    assert.equal(entry.pid, process.pid);
    assert.equal(entry.socket, '/tmp/s.sock');
    assert.equal(entry.profile, 'headless');
    assert.equal(entry.v, 1);
    assert.equal(typeof entry.startedAt, 'string');
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('entries() excludes this endpoint and every malformed record', async () => {
  const home = await scratch();
  try {
    const self = new EndpointRegistry({ home, endpointId: 'self', socket: '/tmp/self.sock' });
    await self.publish('self-token');
    const good = { v: 1, endpointId: 'good', pid: process.pid, socket: '/tmp/good.sock', startedAt: '2026-01-01T00:00:00.000Z' };
    await writeFile(join(self.dir, 'good.json'), JSON.stringify(good));
    await writeFile(join(self.dir, 'broken.json'), '{ not json');
    await writeFile(join(self.dir, 'old-version.json'), JSON.stringify({ ...good, v: 99, endpointId: 'old-version' }));
    await writeFile(join(self.dir, 'no-socket.json'), JSON.stringify({ ...good, socket: '', endpointId: 'no-socket' }));
    await writeFile(join(self.dir, 'mismatched.json'), JSON.stringify({ ...good, endpointId: 'other' }));
    await writeFile(join(self.dir, 'no-pid.json'), JSON.stringify({ ...good, pid: 'abc', endpointId: 'no-pid' }));
    await writeFile(join(self.dir, 'stray.txt'), 'ignored');

    const entries = await self.entries();
    assert.deepEqual(entries.map((entry) => entry.endpointId), ['good']);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('a peer token is readable, and an unknown peer has none', async () => {
  const home = await scratch();
  try {
    const self = new EndpointRegistry({ home, endpointId: 'self', socket: '/tmp/self.sock' });
    await self.publish('self-token');
    const peer = new EndpointRegistry({ home, endpointId: 'peer', socket: '/tmp/peer.sock' });
    await peer.publish('peer-token\n');

    assert.equal(await self.tokenFor('peer'), 'peer-token');
    assert.equal(await self.tokenFor('nobody'), undefined);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('prune removes only peers whose process is gone', async () => {
  const home = await scratch();
  try {
    const self = new EndpointRegistry({ home, endpointId: 'self', socket: '/tmp/self.sock' });
    await self.publish('self-token');
    const live = new EndpointRegistry({ home, endpointId: 'live', socket: '/tmp/live.sock' });
    await live.publish('live-token');
    const dead = new EndpointRegistry({ home, endpointId: 'dead', socket: '/tmp/dead.sock' });
    await dead.publish('dead-token');
    await writeFile(
      dead.entryFile,
      JSON.stringify({ v: 1, endpointId: 'dead', pid: DEAD_PID, socket: '/tmp/dead.sock', startedAt: 'x' }),
    );

    assert.deepEqual(await self.prune(), ['dead']);
    assert.deepEqual((await self.entries()).map((entry) => entry.endpointId), ['live']);
    // The dead peer's token goes with its entry, so a later process cannot read a
    // stale secret.
    assert.equal(await self.tokenFor('dead'), undefined);
    // A live peer is left strictly alone.
    assert.equal(await self.tokenFor('live'), 'live-token');
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('a peer whose socket is unreachable is still pruned only by pid', async () => {
  // A peer can publish its entry before it has bound its socket. Treating a
  // refused connection as death would make a starting peer undiscoverable.
  const home = await scratch();
  try {
    const self = new EndpointRegistry({ home, endpointId: 'self', socket: '/tmp/self.sock' });
    await self.publish('self-token');
    const starting = new EndpointRegistry({ home, endpointId: 'starting', socket: '/tmp/never-bound.sock' });
    await starting.publish('starting-token');

    assert.deepEqual(await self.prune(), []);
    assert.deepEqual((await self.entries()).map((entry) => entry.endpointId), ['starting']);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('unpublish and forget leave nothing behind', async () => {
  const home = await scratch();
  try {
    const self = new EndpointRegistry({ home, endpointId: 'self', socket: '/tmp/self.sock' });
    await self.publish('self-token');
    const peer = new EndpointRegistry({ home, endpointId: 'peer', socket: '/tmp/peer.sock' });
    await peer.publish('peer-token');

    await self.forget('peer');
    assert.deepEqual(await self.entries(), []);
    await self.unpublish();
    assert.deepEqual(await readdir(self.dir), []);
    // Idempotent: a second withdrawal is not an error.
    await self.unpublish();
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('a shared-temp directory is verified, not trusted', async () => {
  // On Linux `$TMPDIR` is `/tmp`, which any user can write to: the directory can be
  // pre-created by someone else, or created as a symlink pointing anywhere. A plain
  // mkdir would happily use it and put a listening socket inside.
  const home = await scratch();
  const shared = await scratch();
  try {
    const real = join(shared, 'dsh-pb-501');
    await mkdir(real, { mode: 0o700 });
    await chmod(real, 0o700);
    await ensurePrivateDir(real, { strict: true });

    // A symlink in its place is refused rather than followed.
    const link = join(shared, 'linked');
    await symlink(real, link);
    await assert.rejects(
      () => ensurePrivateDir(link, { strict: true }),
      /not a real directory/,
    );

    // So is a directory anyone else can enter.
    const open = join(shared, 'world-readable');
    await mkdir(open, { mode: 0o777 });
    await chmod(open, 0o777);
    await assert.rejects(() => ensurePrivateDir(open, { strict: true }), /expected 700/);

    // The non-strict path still creates and tightens, for directories under our home.
    const owned = join(shared, 'ours');
    await ensurePrivateDir(owned);
    assert.equal((await stat(owned)).mode & 0o777, 0o700);
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(shared, { recursive: true, force: true });
  }
});
