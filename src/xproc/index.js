/**
 * Wiring the transport into the bus.
 *
 * This module is loaded **only** when `crossProcess` is on, by a dynamic import
 * from the bus. That is what makes the default a true no-op: with the flag off,
 * none of this code is parsed, no socket is bound, no registry entry is written,
 * and the bus behaves exactly as it did before the transport existed.
 *
 * The two handlers here are the receiving side of a peer's request, and both are
 * deliberately thin: they translate a frame into the bus's own vocabulary and let
 * the bus make every decision. Nothing here decides who may talk to whom.
 *
 * @module dsh-peer-bus/xproc
 */
import { randomUUID } from 'node:crypto';
import { ClaimBook } from './claims.js';
import { Endpoint } from './endpoint.js';
import { socketPathFor } from './socket-path.js';

/** How many peers a single roster merge will query at once. */
const ROSTER_CONCURRENCY = 8;

/**
 * Start this process's endpoint and publish it in the registry.
 *
 * `@deepseek-ai/dsh-home-paths` is imported here rather than at the top of the
 * module so that a profile which cannot resolve it fails only when the feature is
 * actually switched on — and fails loudly, because two processes that disagree
 * about the DSH home would silently never find each other.
 *
 * @param options - the bus, its config, and identity facts for the registry.
 * @returns the started endpoint.
 */
async function startEndpoint({ bus, config, logger, profile, version }) {
  const { resolveDshHome } = await import('@deepseek-ai/dsh-home-paths');
  const home = resolveDshHome();
  const endpointId = `${process.pid}-${randomUUID().slice(0, 8)}`;
  const { socket, location, fallback } = socketPathFor({ home, endpointId });
  if (fallback) {
    logger?.info?.(
      `peer-bus cross-process socket is outside DSH_HOME (${location}): the home path is longer than the platform's socket-address limit`,
    );
  }

  const endpoint = new Endpoint({
    home,
    endpointId,
    socket,
    socketLocation: location,
    profile,
    version,
    maxMessageBytes: config.maxMessageBytes,
    timeouts: {
      control: config.crossProcessTimeoutMs,
      deliver: config.crossProcessDeliverTimeoutMs,
    },
    logger,
    handlers: {
      /**
       * This process's live sessions, as a peer needs to see them.
       *
       * `remote: false` is load-bearing: a peer's roster query must not itself fan
       * out to peers, or two processes asking each other would recurse.
       */
      'roster.live': async () => ({
        rows: bus.liveRows().map((row) => ({
          id: row.id,
          status: row.status,
          cwd: row.cwd,
          title: row.title,
          subagent: row.subagent === true,
          archived: row.archived === true,
        })),
      }),

      /**
       * Deliver one message on behalf of a peer.
       *
       * The receiving process runs its **own** permission, archive, and rate
       * checks. Trusting the sender's word that they passed would make the
       * sender's allowlist the only one that matters, which is exactly the
       * property the two-sided check exists to prevent.
       */
      deliver: async (payload) => await bus.deliverRemote(payload),

      /**
       * Whether this process currently holds a session live.
       *
       * The loser of a claim race asks this instead of polling a full roster: the
       * question is one boolean, and asking it must not cost a persistence read.
       */
      holds: async (payload) => ({ holds: bus.holdsLive(payload?.sessionId) }),

      /** A peer pushing back the answer to a question this process asked. */
      'ask.answer': async (payload) => await bus.receiveRemoteAnswer(payload),

      /** A peer saying it has stopped waiting, so our proxy for its question can go. */
      'ask.cancel': async (payload) => bus.cancelRemoteAskOnArrival(payload),

      /**
       * A peer reading back a receipt for a message we delivered for it.
       *
       * The receipt book itself refuses a caller that is not the recorded sender,
       * so this needs no extra check here.
       */
      status: async (payload) => bus.resolveReceipt(payload ?? {}),
    },
  });

  // The arbiter for "who resumes this session". Kept beside the endpoint because it
  // shares its lifetime and its identity.
  endpoint.claims = new ClaimBook({ home, endpointId, logger });

  await endpoint.start();
  await endpoint.prune().catch(() => []);
  logger?.info?.(`peer-bus cross-process endpoint ${endpointId} listening on ${socket}`);
  return endpoint;
}

/**
 * Query every peer for its live rows, degrading to nothing on failure.
 *
 * A peer that is wedged, restarting, or gone must cost a short timeout and
 * nothing else: the caller's roster then simply shows that session as stored,
 * which is what it looked like before the transport existed.
 *
 * @param endpoint - this process's endpoint.
 * @param logger - for the debug trail.
 * @returns `{ rows, owners }` — merged rows and the endpoint that reported each.
 */
async function remoteLiveRows(endpoint, logger) {
  const peers = await endpoint.peers().catch(() => []);
  const rows = [];
  const owners = new Map();
  for (let index = 0; index < peers.length; index += ROSTER_CONCURRENCY) {
    const batch = peers.slice(index, index + ROSTER_CONCURRENCY);
    const answers = await Promise.all(
      batch.map(async (entry) => {
        try {
          const result = await endpoint.call(entry, 'roster.live', {});
          return { entry, rows: Array.isArray(result?.rows) ? result.rows : [] };
        } catch (error) {
          logger?.debug?.(
            `peer-bus cross-process roster query to ${entry.endpointId} failed: ${error?.message ?? String(error)}`,
          );
          return { entry, rows: [] };
        }
      }),
    );
    for (const answer of answers) {
      for (const row of answer.rows) {
        if (typeof row?.id !== 'string' || row.id === '') continue;
        rows.push(row);
        owners.set(row.id, answer.entry);
      }
    }
  }
  return { rows, owners };
}

export { remoteLiveRows, startEndpoint };
