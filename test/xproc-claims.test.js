/**
 * The claim protocol that makes cold resume single-winner.
 *
 * The layer below cannot do this: a session's log lock guards *write handles*, and
 * `agents.resume` does not take one, so two processes can both resume the same stored
 * session and both believe they own it. These tests cover the arbiter itself — the
 * atomic create, the dead-owner takeover, and the rule that a release only removes a
 * claim this process still owns.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaimBook } from '../src/xproc/claims.js';

/** A fresh throwaway home per test. */
const scratch = () => mkdtemp(join(tmpdir(), 'peer-bus-claims-'));

test('the first claimant wins and the second is told who holds it', async () => {
  const home = await scratch();
  try {
    const first = new ClaimBook({ home, endpointId: 'ep-first' });
    const second = new ClaimBook({ home, endpointId: 'ep-second' });

    assert.deepEqual(await first.acquire('session-x'), { acquired: true });
    const lost = await second.acquire('session-x');
    assert.equal(lost.acquired, false);
    assert.equal(lost.owner.endpointId, 'ep-first');
    assert.equal(lost.owner.pid, process.pid);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('a claim file is owner-only and lives under the transport directory', async () => {
  const home = await scratch();
  try {
    const book = new ClaimBook({ home, endpointId: 'ep-first' });
    await book.acquire('session-x');
    const file = book.fileFor('session-x');
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.equal((await stat(book.dir)).mode & 0o777, 0o700);
    const parsed = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(parsed.sessionId, 'session-x');
    assert.equal(parsed.endpointId, 'ep-first');
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('a claim whose owner is gone is taken over', async () => {
  // The owner was killed, so it never released. The dead pid is the whole signal.
  const home = await scratch();
  try {
    const book = new ClaimBook({ home, endpointId: 'ep-live' });
    await book.acquire('session-x');
    await writeFile(
      book.fileFor('session-x'),
      JSON.stringify({ pid: 999999, endpointId: 'ep-dead', sessionId: 'session-x' }),
    );
    assert.equal(await book.ownerOf('session-x'), undefined, 'a dead owner holds nothing');
    assert.deepEqual(await book.acquire('session-x'), { acquired: true });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('an unreadable claim file is not treated as a live claim', async () => {
  const home = await scratch();
  try {
    const first = new ClaimBook({ home, endpointId: 'ep-first' });
    // The claim directory is created by a first acquire, so it has to happen before
    // there is anywhere to put a corrupt file.
    await first.acquire('session-x');
    await writeFile(first.fileFor('session-x'), '{ half-written');
    const second = new ClaimBook({ home, endpointId: 'ep-second' });
    assert.deepEqual(await second.acquire('session-x'), { acquired: true });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('release only removes a claim this process still owns', async () => {
  // After a takeover the file belongs to the new owner. Deleting it would hand the
  // session to a third contender, which is the split the claim exists to prevent.
  const home = await scratch();
  try {
    const original = new ClaimBook({ home, endpointId: 'ep-original' });
    await original.acquire('session-x');
    // Someone else takes it over behind our back.
    await writeFile(
      original.fileFor('session-x'),
      JSON.stringify({ pid: process.pid, endpointId: 'ep-successor', sessionId: 'session-x' }),
    );
    await original.release('session-x');
    const stillThere = await original.ownerOf('session-x');
    assert.equal(stillThere?.endpointId, 'ep-successor', 'the successor keeps its claim');
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('release and releaseAll clear what this process holds', async () => {
  const home = await scratch();
  try {
    const book = new ClaimBook({ home, endpointId: 'ep' });
    await book.acquire('session-a');
    await book.acquire('session-b');
    await book.release('session-a');
    assert.equal(await book.ownerOf('session-a'), undefined);
    assert.notEqual(await book.ownerOf('session-b'), undefined);

    await book.releaseAll();
    assert.equal(await book.ownerOf('session-b'), undefined);
    // Idempotent: unloading twice is not an error.
    await book.releaseAll();
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('two claimants on different sessions do not block each other', async () => {
  const home = await scratch();
  try {
    const first = new ClaimBook({ home, endpointId: 'ep-first' });
    const second = new ClaimBook({ home, endpointId: 'ep-second' });
    assert.deepEqual(await first.acquire('session-a'), { acquired: true });
    assert.deepEqual(await second.acquire('session-b'), { acquired: true });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
