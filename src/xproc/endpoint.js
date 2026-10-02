/**
 * The socket server and the client pool behind it.
 *
 * One server per DSH process, listening on a Unix domain socket (or a Windows
 * named pipe), plus one lazily-created connection per peer. Operations are
 * dispatched to handlers the bus supplies; this module knows nothing about
 * sessions, permissions, or messages.
 *
 * Two properties matter more than the plumbing:
 *
 * - **A wedged peer must not wedge us.** Every request has a timeout, every
 *   connection failure rejects its pending requests, and a peer that fails to
 *   connect is forgotten from the registry.
 * - **A peer that goes away mid-request is a normal event, not an exception.**
 *   Processes restart; `peer-gone` is a distinct code so the bus can fall back to
 *   the local path rather than reporting a failure to the user.
 *
 * @module dsh-peer-bus/xproc/endpoint
 */
import { randomUUID } from 'node:crypto';
import { chmod, rm } from 'node:fs/promises';
import { createServer, connect } from 'node:net';
import { dirname } from 'node:path';
import { PROTOCOL_VERSION, FrameReader, encodeFrame, failure, frameLimitFor, request, success } from './protocol.js';
import { EndpointRegistry, ensurePrivateDir } from './registry.js';

/** Stable code for "the peer is not reachable any more". */
const PEER_GONE = 'peer-gone';

/** Stable code for a peer that failed the handshake. */
const UNAUTHORIZED = 'unauthorized';

/** Owner-only on the socket itself: on Unix this is what connect() enforces. */
const SOCKET_MODE = 0o600;

/**
 * Connect failures that mean "nothing is listening there any more".
 *
 * Anything else — a timeout, a reset, a handshake that went wrong — may be a peer
 * that is merely busy or restarting, and its registration must survive.
 */
const DEFINITIVELY_GONE = new Set(['ECONNREFUSED', 'ENOENT']);

/**
 * How long a connection may stay silent before the handshake completes.
 *
 * Without this, a peer that connects and says nothing holds a socket and its buffers
 * for as long as it likes — and there is no reason for a real peer to be slow here:
 * the greeting is one small frame written as soon as the socket opens.
 */
const HANDSHAKE_TIMEOUT_MS = 5000;

/**
 * Frame limit before the handshake.
 *
 * The greeting is a handful of fields, so an ungreeted connection has no business
 * sending anything large. The full limit is restored the moment it authenticates.
 */
const HANDSHAKE_FRAME_LIMIT = 4096;

/**
 * One process's endpoint: its listener, its outbound connections, and the
 * registry entry that makes it discoverable.
 */
class Endpoint {
  /**
   * @param options - identity, socket path, handler table, and timeouts.
   */
  constructor({ home, endpointId, socket, socketLocation, profile, version, handlers, timeouts, logger, maxMessageBytes }) {
    this.endpointId = endpointId;
    this.socket = socket;
    /** `home`, `tmp`, or `pipe` — `tmp` means the parent is shared, so it is verified. */
    this.socketLocation = socketLocation;
    this.profile = profile;
    this.version = version;
    this.handlers = handlers;
    // Defensive: a missing timeout would become `setTimeout(fn, undefined)`, which
    // fires immediately and turns every request into a timeout that races its own
    // response. A caller that forgets one gets the documented default, not a
    // coin flip.
    this.timeouts = { control: timeouts?.control ?? 2000, deliver: timeouts?.deliver ?? 60000 };
    /** Injectable so the deadline can be tested without waiting five seconds. */
    this.handshakeTimeoutMs = timeouts?.handshake ?? HANDSHAKE_TIMEOUT_MS;
    this.logger = logger;
    this.frameLimit = frameLimitFor(maxMessageBytes);
    this.token = randomUUID();
    this.registry = new EndpointRegistry({ home, endpointId, socket, profile, version });
    this.server = undefined;
    /** Outbound connections, one per peer, keyed by endpoint id. */
    this.clients = new Map();
    /**
     * Inbound connections this endpoint has accepted.
     *
     * Tracked because `server.close()` only stops *new* connections: it waits for
     * the existing ones to end, so an endpoint that never destroys them never
     * finishes stopping.
     */
    this.inbound = new Set();
    this.stopped = false;
  }

  /**
   * Publish this endpoint and start listening.
   *
   * The registry entry is written **before** the bind so a peer that discovers us
   * while we are still starting sees a live pid and waits, rather than deciding we
   * are gone.
   *
   * @returns fulfillment once the socket accepts connections.
   */
  async start() {
    await this.registry.publish(this.token);
    // The socket's own directory is not the registry directory: binding into a
    // path whose parent does not exist fails outright, so create it first — and
    // owner-only, since on Unix the directory mode is part of what keeps other
    // users off the socket.
    await ensurePrivateDir(dirname(this.socket), { strict: this.socketLocation === 'tmp' });
    // A socket file left by a crashed process would make bind fail with
    // EADDRINUSE even though nothing is listening on it.
    await rm(this.socket, { force: true }).catch(() => {});
    this.server = createServer((connection) => this.accept(connection));
    this.server.on('error', (error) => {
      this.logger?.warn?.(`peer-bus cross-process listener error: ${error?.message ?? String(error)}`);
    });
    await new Promise((resolve, reject) => {
      const onError = (error) => reject(error);
      this.server.once('error', onError);
      this.server.listen(this.socket, () => {
        this.server.off('error', onError);
        resolve();
      });
    });
    // The containing directory is 0700 already; tightening the socket itself is
    // defence in depth, and on Unix connect() is what checks it.
    await chmod(this.socket, SOCKET_MODE).catch(() => {});
    return undefined;
  }

  /**
   * Handle one inbound connection: handshake, then dispatch.
   *
   * @param connection - accepted socket.
   */
  accept(connection) {
    this.inbound.add(connection);
    connection.on('close', () => {
      clearTimeout(deadline);
      this.inbound.delete(connection);
    });
    let greeted = false;
    // A connection that never greets is dropped rather than kept: an unauthenticated
    // peer must not be able to hold resources here indefinitely.
    const deadline = setTimeout(() => connection.destroy(), this.handshakeTimeoutMs);
    deadline.unref?.();
    const reader = new FrameReader({
      limit: HANDSHAKE_FRAME_LIMIT,
      onError: (error) => {
        this.logger?.debug?.(`peer-bus cross-process dropped a peer: ${error.message}`);
        connection.destroy();
      },
      onFrame: (frame) => {
        if (!greeted) {
          greeted = this.greet(connection, frame);
          // Authenticated: it may now speak at full size, and the deadline no longer
          // applies — a legitimate peer can be idle between requests for hours.
          if (greeted) {
            clearTimeout(deadline);
            reader.limit = this.frameLimit;
          }
          return;
        }
        void this.dispatch(connection, frame);
      },
    });
    connection.on('data', (chunk) => reader.push(chunk));
    connection.on('error', () => connection.destroy());
  }

  /**
   * Verify the first frame and answer it.
   *
   * @param connection - the socket being greeted.
   * @param frame - the peer's first frame.
   * @returns whether the connection may continue.
   */
  greet(connection, frame) {
    if (frame.op !== 'hello' || frame.token !== this.token) {
      connection.end(encodeFrame(failure(frame.id, UNAUTHORIZED, 'peer-bus handshake failed')));
      return false;
    }
    connection.write(
      encodeFrame(success(frame.id, { endpointId: this.endpointId, profile: this.profile, version: this.version })),
    );
    return true;
  }

  /**
   * Run one operation and answer it.
   *
   * A handler that throws is reported to the caller as a failure frame carrying
   * the handler's own `code` when it has one, so the bus's error vocabulary
   * survives the trip.
   *
   * @param connection - the calling socket.
   * @param frame - the request frame.
   */
  async dispatch(connection, frame) {
    const handler = this.handlers[frame.op];
    if (typeof handler !== 'function') {
      connection.write(encodeFrame(failure(frame.id, 'unknown-op', `unknown operation ${JSON.stringify(frame.op)}`)));
      return;
    }
    try {
      const result = await handler(frame.payload);
      if (!connection.destroyed) connection.write(encodeFrame(success(frame.id, result)));
    } catch (error) {
      const code = typeof error?.code === 'string' ? error.code : 'internal';
      const message = error?.message ?? String(error);
      if (!connection.destroyed) connection.write(encodeFrame(failure(frame.id, code, message)));
    }
  }

  /**
   * Every peer currently in the registry, excluding this endpoint.
   *
   * @returns registry entries.
   */
  async peers() {
    return await this.registry.entries();
  }

  /**
   * Drop registry entries whose process is gone.
   *
   * @returns the endpoint ids removed.
   */
  async prune() {
    return await this.registry.prune();
  }

  /**
   * Get or open the connection to one peer.
   *
   * @param entry - the peer's registry entry.
   * @returns the connection record.
   * @throws an error coded `peer-gone` when the peer cannot be reached.
   */
  async connectionFor(entry) {
    const existing = this.clients.get(entry.endpointId);
    if (existing !== undefined && existing.ready === true) return existing;
    if (existing !== undefined) await existing.opening.catch(() => {});
    const again = this.clients.get(entry.endpointId);
    if (again !== undefined && again.ready === true) return again;

    const record = { socket: undefined, ready: false, pending: new Map(), nextId: 1, opening: undefined };
    this.clients.set(entry.endpointId, record);
    record.opening = (async () => {
      const token = await this.registry.tokenFor(entry.endpointId);
      if (token === undefined) throw coded(PEER_GONE, `peer ${entry.endpointId} has no token`);
      const socket = connect(entry.socket);
      record.socket = socket;
      const reader = new FrameReader({
        limit: this.frameLimit,
        onError: () => this.dropClient(entry.endpointId),
        onFrame: (frame) => this.settle(entry.endpointId, frame),
      });
      socket.on('data', (chunk) => reader.push(chunk));
      socket.on('error', () => this.dropClient(entry.endpointId));
      socket.on('close', () => this.dropClient(entry.endpointId));
      await new Promise((resolve, reject) => {
        // Connecting to a peer that accepts and then says nothing must not hang this
        // caller's turn: the same deadline covers connect and greeting together.
        const timer = setTimeout(
          () => reject(coded('timeout', `connecting to ${entry.endpointId} timed out`)),
          this.handshakeTimeoutMs,
        );
        timer.unref?.();
        const settle = (fn) => (value) => {
          clearTimeout(timer);
          fn(value);
        };
        socket.once('connect', settle(resolve));
        socket.once('error', settle(reject));
      });
      const greeting = await this.exchange(entry.endpointId, 'hello', undefined, {
        token,
        timeoutMs: this.timeouts.control,
        bare: true,
      });
      record.greeted = greeting;
      record.ready = true;
    })();
    try {
      await record.opening;
      return record;
    } catch (error) {
      this.dropClient(entry.endpointId);
      if (error?.code === UNAUTHORIZED) {
        // The peer is alive but does not accept us: that is a real refusal and the
        // caller deserves to see it, not a silent fallback.
        throw error;
      }
      // Only a *definitive* "nothing is listening there" is grounds for deleting
      // a peer's own registration file. A timeout or a reset may be a peer that is
      // busy or mid-restart, and deleting its entry would make a live process
      // undiscoverable until it happened to re-publish.
      if (DEFINITIVELY_GONE.has(error?.code)) {
        await this.registry.forget(entry.endpointId).catch(() => {});
      }
      throw coded(PEER_GONE, `peer ${entry.endpointId} is not reachable: ${error?.message ?? String(error)}`);
    }
  }

  /**
   * Send one request and await its response.
   *
   * @param endpointId - peer to call.
   * @param op - operation name.
   * @param payload - operation arguments.
   * @param options - timeout and the bare-frame flag used by the handshake.
   * @returns the operation result.
   */
  exchange(endpointId, op, payload, { token, timeoutMs, bare = false } = {}) {
    const record = this.clients.get(endpointId);
    if (record?.socket === undefined) return Promise.reject(coded(PEER_GONE, 'no connection'));
    const id = String(record.nextId);
    record.nextId += 1;
    const frame = bare ? { ...request(id, op, payload), token } : request(id, op, payload);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        record.pending.delete(id);
        reject(coded('timeout', `${op} to ${endpointId} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref?.();
      record.pending.set(id, { resolve, reject, timer });
      record.socket.write(encodeFrame(frame), (error) => {
        // `socket.write` reports success as `null`, not `undefined`: checking only
        // for undefined turns every successful write into a TypeError.
        if (error == null) return;
        clearTimeout(timer);
        record.pending.delete(id);
        reject(coded(PEER_GONE, `could not write to ${endpointId}: ${error.message}`));
      });
    });
  }

  /**
   * Resolve or reject one pending request from a response frame.
   *
   * @param endpointId - peer the frame came from.
   * @param frame - the response frame.
   */
  settle(endpointId, frame) {
    const record = this.clients.get(endpointId);
    const pending = record?.pending.get(frame.id);
    if (pending === undefined) return;
    clearTimeout(pending.timer);
    record.pending.delete(frame.id);
    if (frame.ok === true) {
      pending.resolve(frame.result);
      return;
    }
    pending.reject(coded(frame.error?.code ?? 'internal', frame.error?.message ?? 'peer reported a failure'));
  }

  /**
   * Call one operation on one peer.
   *
   * @param entry - the peer's registry entry.
   * @param op - operation name.
   * @param payload - operation arguments.
   * @param options - per-call timeout override.
   * @returns the operation result.
   */
  async call(entry, op, payload, { timeoutMs } = {}) {
    const record = await this.connectionFor(entry);
    return await this.exchange(entry.endpointId, op, payload, {
      timeoutMs: timeoutMs ?? this.timeouts.control,
    });
  }

  /**
   * Tear down one connection and fail everything waiting on it.
   *
   * @param endpointId - peer whose connection is gone.
   */
  dropClient(endpointId) {
    const record = this.clients.get(endpointId);
    if (record === undefined) return;
    this.clients.delete(endpointId);
    record.socket?.destroy();
    for (const pending of record.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(coded(PEER_GONE, `peer ${endpointId} closed the connection`));
    }
    record.pending.clear();
  }

  /**
   * Stop listening, drop every connection, and withdraw from the registry.
   *
   * @returns fulfillment once the endpoint is gone.
   */
  async stop() {
    if (this.stopped) return;
    this.stopped = true;
    for (const endpointId of [...this.clients.keys()]) this.dropClient(endpointId);
    // Destroy inbound sockets too, or close() waits for peers that may never hang
    // up — a wedged peer would make shutdown hang forever.
    for (const connection of [...this.inbound]) connection.destroy();
    this.inbound.clear();
    await new Promise((resolve) => {
      if (this.server === undefined) {
        resolve();
        return;
      }
      this.server.close(() => resolve());
    });
    await rm(this.socket, { force: true }).catch(() => {});
    await this.registry.unpublish();
  }
}

/**
 * Build an Error carrying a stable code.
 *
 * @param code - machine discriminator.
 * @param message - human-readable account.
 * @returns the error.
 */
function coded(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export { Endpoint, PEER_GONE, UNAUTHORIZED, coded };
