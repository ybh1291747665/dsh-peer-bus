/**
 * Tests for the wire format and for two real endpoints talking over a real socket.
 *
 * These are the properties the bus will rely on and cannot check itself: that a
 * peer from a different build is refused rather than misread, that a wedged peer
 * times out instead of hanging a caller's turn, that a peer which goes away is
 * reported as `peer-gone` rather than as a failure the user must interpret, and
 * that stopping an endpoint leaves no socket and no registry entry behind.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Endpoint, PEER_GONE, UNAUTHORIZED } from '../src/xproc/endpoint.js';
import { FrameReader, PROTOCOL_VERSION, encodeFrame, failure, frameLimitFor, request, success } from '../src/xproc/protocol.js';
import { socketPathFor } from '../src/xproc/socket-path.js';

/** Collect frames and errors from a reader. */
function readerFor(limit = 4096) {
  const frames = [];
  const errors = [];
  const reader = new FrameReader({ limit, onFrame: (frame) => frames.push(frame), onError: (error) => errors.push(error) });
  return { reader, frames, errors };
}

test('a frame survives a round trip', () => {
  const { reader, frames } = readerFor();
  reader.push(encodeFrame(request('1', 'roster.live', { since: 0 })));
  assert.deepEqual(frames, [{ v: PROTOCOL_VERSION, id: '1', op: 'roster.live', payload: { since: 0 } }]);
});

test('frames split across chunks, and several in one chunk, are both handled', () => {
  const { reader, frames } = readerFor();
  const payload = Buffer.concat([encodeFrame(success('1', { a: 1 })), encodeFrame(failure('2', 'denied', 'no'))]);
  reader.push(payload.slice(0, 7));
  reader.push(payload.slice(7, 30));
  reader.push(payload.slice(30));
  assert.deepEqual(frames.map((frame) => frame.id), ['1', '2']);
  assert.equal(frames[0].ok, true);
  assert.equal(frames[1].error.code, 'denied');
});

test('a peer from another protocol version is refused, not misread', () => {
  const { reader, frames, errors } = readerFor();
  reader.push(`${JSON.stringify({ v: 99, id: '1', op: 'deliver' })}\n`);
  assert.deepEqual(frames, []);
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /unsupported protocol version 99/);
});

test('malformed input fails once and stops reading', () => {
  const { reader, frames, errors } = readerFor();
  reader.push('{ not json\n');
  reader.push(encodeFrame(success('1', {})));
  assert.deepEqual(frames, [], 'nothing after a broken frame is interpreted');
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /not valid JSON/);
});

test('an oversize frame is an error rather than a truncation', () => {
  const { reader, errors } = readerFor(64);
  reader.push(`${JSON.stringify({ v: PROTOCOL_VERSION, id: '1', op: 'x', payload: 'y'.repeat(500) })}\n`);
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /exceeds the 64-byte limit/);
});

test('a non-object frame is rejected', () => {
  const { reader, frames, errors } = readerFor();
  reader.push('[1,2,3]\n');
  assert.deepEqual(frames, []);
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /not a JSON object/);
});

test('the frame limit leaves room for envelope overhead above the message limit', () => {
  assert.ok(frameLimitFor(16384) > 16384, 'a maximum-size message must still fit its envelope');
  assert.equal(frameLimitFor(0), frameLimitFor(16384) - 16384);
});

/** Build one endpoint over a scratch home. */
async function endpointAt(home, id, handlers, extra = {}) {
  const { socket } = socketPathFor({ home, endpointId: id });
  const endpoint = new Endpoint({
    home,
    endpointId: id,
    socket,
    profile: 'headless',
    version: '0.2.0',
    handlers,
    timeouts: { control: 2000 },
    maxMessageBytes: 16384,
    ...extra,
  });
  await endpoint.start();
  return endpoint;
}

/** The registry entry for one endpoint, as a peer would see it. */
const entryOf = async (endpoint, peerId) =>
  (await endpoint.peers()).find((entry) => entry.endpointId === peerId);

test('one endpoint calls another over a real socket', async () => {
  const home = await mkdtemp(join(tmpdir(), 'peer-bus-ep-'));
  const alpha = await endpointAt(home, 'alpha', {});
  const beta = await endpointAt(home, 'beta', {
    'roster.live': async (payload) => ({ echo: payload, from: 'beta' }),
  });
  try {
    const entry = await entryOf(alpha, 'beta');
    assert.notEqual(entry, undefined, 'alpha must discover beta through the registry');
    const result = await alpha.call(entry, 'roster.live', { since: 7 });
    assert.deepEqual(result, { echo: { since: 7 }, from: 'beta' });
  } finally {
    await alpha.stop();
    await beta.stop();
    await rm(home, { recursive: true, force: true });
  }
});

test('a handler error keeps its stable code across the wire', async () => {
  const home = await mkdtemp(join(tmpdir(), 'peer-bus-ep-'));
  const alpha = await endpointAt(home, 'alpha', {});
  const beta = await endpointAt(home, 'beta', {
    deliver: async () => {
      const error = new Error('that session is archived');
      error.code = 'target-archived';
      throw error;
    },
  });
  try {
    const error = await alpha
      .call(await entryOf(alpha, 'beta'), 'deliver', {})
      .catch((thrown) => thrown);
    assert.equal(error?.code, 'target-archived');
    assert.match(error.message, /archived/);
  } finally {
    await alpha.stop();
    await beta.stop();
    await rm(home, { recursive: true, force: true });
  }
});

test('an unknown operation is refused with its own code', async () => {
  const home = await mkdtemp(join(tmpdir(), 'peer-bus-ep-'));
  const alpha = await endpointAt(home, 'alpha', {});
  const beta = await endpointAt(home, 'beta', {});
  try {
    const error = await alpha.call(await entryOf(alpha, 'beta'), 'nope', {}).catch((thrown) => thrown);
    assert.equal(error?.code, 'unknown-op');
  } finally {
    await alpha.stop();
    await beta.stop();
    await rm(home, { recursive: true, force: true });
  }
});

test('a tampered token is refused as unauthorized, not as a lost peer', async () => {
  const home = await mkdtemp(join(tmpdir(), 'peer-bus-ep-'));
  const alpha = await endpointAt(home, 'alpha', {});
  const beta = await endpointAt(home, 'beta', { 'roster.live': async () => ({ ok: true }) });
  try {
    // Simulate a peer whose token file does not match what it will accept.
    const { writeFile } = await import('node:fs/promises');
    await writeFile(beta.registry.tokenFile, 'not-the-real-token', { mode: 0o600 });

    const error = await alpha.call(await entryOf(alpha, 'beta'), 'roster.live', {}).catch((thrown) => thrown);
    assert.equal(error?.code, UNAUTHORIZED, 'a refusal must not be reported as an unreachable peer');
  } finally {
    await alpha.stop();
    await beta.stop();
    await rm(home, { recursive: true, force: true });
  }
});

test('a peer that stops is reported as peer-gone and then forgotten', async () => {
  const home = await mkdtemp(join(tmpdir(), 'peer-bus-ep-'));
  const alpha = await endpointAt(home, 'alpha', {});
  const beta = await endpointAt(home, 'beta', { 'roster.live': async () => ({ ok: true }) });
  try {
    const entry = await entryOf(alpha, 'beta');
    assert.equal((await alpha.call(entry, 'roster.live', {})).ok, true);

    await beta.stop();
    const error = await alpha.call(entry, 'roster.live', {}).catch((thrown) => thrown);
    assert.equal(error?.code, PEER_GONE);
    // The dead peer's record is dropped, so the next resolution does not dial it.
    assert.equal(await entryOf(alpha, 'beta'), undefined);
  } finally {
    await alpha.stop();
    await rm(home, { recursive: true, force: true });
  }
});

test('a wedged handler times out instead of hanging the caller', async () => {
  const home = await mkdtemp(join(tmpdir(), 'peer-bus-ep-'));
  const alpha = await endpointAt(home, 'alpha', {});
  const beta = await endpointAt(home, 'beta', { deliver: () => new Promise(() => {}) });
  try {
    const started = Date.now();
    const error = await alpha
      .call(await entryOf(alpha, 'beta'), 'deliver', {}, { timeoutMs: 120 })
      .catch((thrown) => thrown);
    assert.equal(error?.code, 'timeout');
    assert.ok(Date.now() - started < 2000, 'the timeout must be the configured one');
  } finally {
    await alpha.stop();
    await beta.stop();
    await rm(home, { recursive: true, force: true });
  }
});

test('stopping removes the socket file and the registry entry', async () => {
  const home = await mkdtemp(join(tmpdir(), 'peer-bus-ep-'));
  const alpha = await endpointAt(home, 'alpha', {});
  const beta = await endpointAt(home, 'beta', {});
  try {
    assert.equal((await stat(beta.socket)).isSocket(), true);
    await beta.stop();
    await assert.rejects(() => stat(beta.socket), 'the socket file must be gone');
    assert.equal(await entryOf(alpha, 'beta'), undefined);
    // Idempotent.
    await beta.stop();
  } finally {
    await alpha.stop();
    await rm(home, { recursive: true, force: true });
  }
});

test('a peer that dies without stopping is pruned by pid', async () => {
  const home = await mkdtemp(join(tmpdir(), 'peer-bus-ep-'));
  const alpha = await endpointAt(home, 'alpha', {});
  try {
    // A registry entry left by a process that no longer exists.
    const { writeFile } = await import('node:fs/promises');
    const ghost = { v: 1, endpointId: 'ghost', pid: 999999, socket: '/tmp/ghost.sock', startedAt: 'x' };
    await writeFile(join(alpha.registry.dir, 'ghost.json'), JSON.stringify(ghost));

    assert.deepEqual(await alpha.prune(), ['ghost']);
    assert.equal(await entryOf(alpha, 'ghost'), undefined);
  } finally {
    await alpha.stop();
    await rm(home, { recursive: true, force: true });
  }
});

test('a multi-byte character split across chunks survives intact', () => {
  // The bug this pins: decoding each chunk on its own turns any character that
  // straddles a boundary into replacement characters. A 30 KB write on macOS
  // arrives as several chunks, so a large Chinese message would be corrupted — and
  // so would a question and its answer, which travel the same way.
  const { reader, frames, errors } = readerFor();
  const frame = encodeFrame(request('1', 'deliver', { text: '你好世界' }));
  const cut = frame.indexOf(Buffer.from('好', 'utf8')) + 1; // one byte into 好
  reader.push(frame.subarray(0, cut));
  reader.push(frame.subarray(cut));

  assert.deepEqual(errors, []);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].payload.text, '你好世界');
});

test('a four-byte character split three ways survives intact', () => {
  const { reader, frames } = readerFor();
  const frame = encodeFrame(request('1', 'deliver', { text: 'a🎯b' }));
  const start = frame.indexOf(Buffer.from('🎯', 'utf8'));
  reader.push(frame.subarray(0, start + 1));
  reader.push(frame.subarray(start + 1, start + 3));
  reader.push(frame.subarray(start + 3));

  assert.equal(frames.length, 1);
  assert.equal(frames[0].payload.text, 'a🎯b');
});

test('a large Chinese message arriving byte by byte is reassembled exactly', () => {
  // The worst case for the old reader, and the shape a real large write takes once
  // the kernel has chopped it up.
  const { reader, frames, errors } = readerFor(1 << 20);
  const text = '你好世界'.repeat(2000);
  const frame = encodeFrame(request('1', 'deliver', { text }));
  for (const byte of frame) reader.push(Buffer.from([byte]));

  assert.deepEqual(errors, []);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].payload.text, text);
  assert.equal(frames[0].payload.text.length, text.length);
});

test('a chunk holding many frames of any total size is not mistaken for an oversize frame', () => {
  // The limit bounds one *incomplete* frame. A batch of complete frames can exceed it
  // in total without being wrong, and each is dropped as it is read.
  const { reader, frames } = readerFor(64);
  const many = Array.from({ length: 40 }, (_unused, index) => success(String(index), { index }));
  reader.push(Buffer.concat(many.map((frame) => encodeFrame(frame))));
  assert.equal(frames.length, 40);
});

test('an incomplete frame that grows past the limit still fails', () => {
  const { reader, frames, errors } = readerFor(64);
  reader.push(Buffer.from(`{"v":1,"id":"1","op":"x","payload":"${'y'.repeat(200)}`, 'utf8'));
  assert.deepEqual(frames, []);
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /exceeds the 64-byte limit/);
});

test('a connection that never greets is dropped at the deadline', async () => {
  // Without a deadline an unauthenticated peer holds a socket and its buffers for as
  // long as it likes, and there is no legitimate reason to be slow here.
  const { connect } = await import('node:net');
  const home = await mkdtemp(join(tmpdir(), 'peer-bus-ep-'));
  const { socket } = socketPathFor({ home, endpointId: 'quiet' });
  const endpoint = new Endpoint({
    home,
    endpointId: 'quiet',
    socket,
    profile: 'headless',
    version: '0.2.0',
    handlers: {},
    timeouts: { control: 2000, handshake: 150 },
    maxMessageBytes: 16384,
  });
  await endpoint.start();
  try {
    const client = connect(socket);
    await new Promise((resolve) => client.once('connect', resolve));
    const closed = await new Promise((resolve) => {
      client.once('close', () => resolve(true));
      setTimeout(() => resolve(false), 3000);
    });
    assert.equal(closed, true, 'the silent connection must have been destroyed');
  } finally {
    await endpoint.stop();
    await rm(home, { recursive: true, force: true });
  }
});

test('an oversized frame before the handshake is refused', async () => {
  // The greeting is a handful of fields, so an ungreeted connection has no business
  // sending anything large.
  const { connect } = await import('node:net');
  const home = await mkdtemp(join(tmpdir(), 'peer-bus-ep-'));
  const { socket } = socketPathFor({ home, endpointId: 'strict' });
  const endpoint = new Endpoint({
    home,
    endpointId: 'strict',
    socket,
    profile: 'headless',
    version: '0.2.0',
    handlers: {},
    timeouts: { control: 2000, handshake: 2000 },
    maxMessageBytes: 1 << 20,
  });
  await endpoint.start();
  try {
    const client = connect(socket);
    await new Promise((resolve) => client.once('connect', resolve));
    client.write(`${JSON.stringify({ v: PROTOCOL_VERSION, id: '1', op: 'hello', token: 'x', pad: 'y'.repeat(8000) })}\n`);
    const closed = await new Promise((resolve) => {
      client.once('close', () => resolve(true));
      setTimeout(() => resolve(false), 3000);
    });
    assert.equal(closed, true, 'the oversize pre-handshake frame must drop the connection');
  } finally {
    await endpoint.stop();
    await rm(home, { recursive: true, force: true });
  }
});
