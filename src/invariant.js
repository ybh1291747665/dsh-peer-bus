/**
 * Package-owned durable bus-message invariants.
 *
 * DSH asks every package to register its runtime checks from a `./invariant`
 * companion so ordinary entrypoints stay independent of diagnostics. This module
 * validates the one durable thing this package owns: a `user/message` or inbox
 * splice carrying the `peer-bus-message` source.
 *
 * It deliberately validates **shape and placement only**. Permission policy,
 * message-size limits, and the send-rate ceiling are per-deployment `Config`, and
 * a log written under a looser policy must still replay after a deployment
 * tightens it — tying this invariant to the current config would reject history
 * that was valid when it was written. That is the same split
 * `@deepseek-ai/dsh-tool-todo/invariant` makes for parallel todos.
 *
 * @module dsh-peer-bus/invariant
 */
import { BUS_SOURCE_KIND, isBusSource } from './peer-bus.js';

/** Full npm package name that owns these checks. */
const PACKAGE_NAME = 'dsh-peer-bus';

/** Cordis companion plugin name. */
const name = 'peer-bus-invariant';

/** Inbox lists a delivered message may legally be spliced into. */
const INBOX_TARGETS = new Set(['next-turn', 'next-step']);

/**
 * Validate one bus message's durable shape.
 *
 * @param message - candidate message or splice-inserted value.
 * @param fail - package-attributed invariant reporter.
 */
function validateBusMessage(message, fail) {
  const source = message?.source;
  if (source.form !== 'relay') {
    fail(`a ${BUS_SOURCE_KIND} source must use the relay context form, got ${JSON.stringify(source.form)}`);
  }
  const sender = source.senderSessionId;
  if (typeof sender !== 'string' || sender.length === 0) {
    fail(`a ${BUS_SOURCE_KIND} source must name a non-empty senderSessionId`);
  }
  if (message.role !== 'user') {
    fail(`a ${BUS_SOURCE_KIND} message must be user-role, got ${JSON.stringify(message.role)}`);
  }
  if (!Array.isArray(message.content) || message.content.length === 0) {
    fail(`a ${BUS_SOURCE_KIND} message must carry non-empty content`);
  }
  const text = message.content
    .filter((block) => block?.type === 'text')
    .map((block) => block.text)
    .join('');
  if (text.trim().length === 0) {
    fail(`a ${BUS_SOURCE_KIND} message must carry readable text`);
  }
}

/**
 * Validate one package-owned event against the session that recorded it.
 *
 * @param sessionId - session whose log received the event.
 * @param event - the appended or dispatched event.
 * @param fail - package-attributed invariant reporter.
 */
function validateEvent(sessionId, event, fail) {
  if (event.type === 'user/message') {
    if (!isBusSource(event.data?.source)) return;
    validateBusMessage(event.data, fail);
    if (event.data.source.senderSessionId === sessionId) {
      fail(`session ${JSON.stringify(sessionId)} recorded a ${BUS_SOURCE_KIND} message sent to itself`);
    }
    return;
  }
  if (event.type === 'agent/inbox/spliced') {
    const inserted = event.data?.inserted;
    if (!Array.isArray(inserted)) return;
    for (const message of inserted) {
      if (!isBusSource(message?.source)) continue;
      if (!INBOX_TARGETS.has(event.data.target)) {
        fail(`a ${BUS_SOURCE_KIND} message was spliced into unknown inbox target ${JSON.stringify(event.data.target)}`);
      }
      validateBusMessage(message, fail);
      if (message.source.senderSessionId === sessionId) {
        fail(`session ${JSON.stringify(sessionId)} spliced a ${BUS_SOURCE_KIND} message sent to itself`);
      }
    }
  }
}

/**
 * Install validation for loaded and newly appended bus messages.
 *
 * `internal/dispatch` runs before a `session/event` commit, so a malformed bus
 * message is rejected at the boundary instead of being persisted and only
 * noticed on the next replay.
 */
const install = Object.assign(
  (ctx, fail) => {
    for (const session of ctx.sessions.list()) {
      for (const event of session.snapshotEvents()) validateEvent(session.id, event, fail);
    }
    ctx.on(
      'session/created',
      (session) => {
        for (const event of session.snapshotEvents()) validateEvent(session.id, event, fail);
      },
      { global: true },
    );
    ctx.on(
      'internal/dispatch',
      (_mode, eventName, args) => {
        if (eventName !== 'session/event') return;
        const [session, event] = args;
        validateEvent(session.id, event, fail);
      },
      { global: true },
    );
  },
  { inject: ['sessions'] },
);

/**
 * Register the bus invariant companion.
 *
 * The `invariants` service is deliberately **not** declared as this plugin's own
 * dependency, even though registration needs it. A declared-but-absent service
 * holds the entry at `pending` forever, and the loader reports every such entry as
 * a startup warning — so on every shipped profile except `dsh-sdk-minimal`, which
 * is the only one that mounts `dsh-invariants`, installing this package would
 * print "1 entry did not activate" on every boot. Upstream packages avoid that by
 * not mounting their companions outside a diagnostics profile at all; this keeps
 * the companion mountable everywhere and simply waits for the service in a nested
 * fiber, which the entry does not depend on.
 *
 * The nested fiber is intentionally not returned: returning it would make the
 * entry await the service again and reintroduce the very pending state this
 * avoids. It lives under this plugin's context, so it is disposed with it.
 *
 * @param ctx - plugin context.
 */
const apply = (ctx) => {
  ctx.inject(['invariants'], (invariantCtx) =>
    Promise.resolve(invariantCtx.invariants.register(PACKAGE_NAME, install)),
  );
};

export { BUS_SOURCE_KIND, PACKAGE_NAME, apply, name, validateBusMessage, validateEvent };
