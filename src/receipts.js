/**
 * Delivery receipts for `bus_status`.
 *
 * `bus_send` only proves a message reached the target's inbox. A receipt follows
 * it after that: whether the target's loop took it into a turn (`claimed`, with
 * the turn number), whether `bus_wait` took it (`received`), or whether it was
 * thrown away before it ran (`discarded` — the target was cancelled, or its inbox
 * was cleared).
 *
 * **A receipt is recorded before the message is routed.** On an idle target,
 * `followup()` starts the driver synchronously, and the driver claims its first
 * batch before its first `await` — so the claim event fires *inside* the
 * `followup()` call. A receipt recorded after routing would miss its own claim
 * and report `queued` forever.
 *
 * Receipts are process-local and bounded. After a restart, or once a receipt has
 * aged out, the answer is `unknown` — which is also the answer for a message the
 * caller did not send, so a receipt cannot be used to probe another session's
 * traffic.
 *
 * @module dsh-peer-bus/receipts
 */

/** Delivered to the target's inbox; no turn has taken it yet. */
const QUEUED = 'queued';
/** Taken into a turn by the target's loop. */
const CLAIMED = 'claimed';
/** Taken by the target's own `bus_wait`. */
const RECEIVED = 'received';
/** Removed from the inbox before any turn ran it. */
const DISCARDED = 'discarded';
/** Not known to this process: never sent by the caller, expired, or from before a restart. */
const UNKNOWN = 'unknown';

/** Default number of receipts kept before the oldest is forgotten. */
const DEFAULT_CAPACITY = 1000;

/**
 * Bounded receipt book over the messages this bus delivered.
 *
 * Not a Cordis service, so `this.ctx` is never shadowed by a per-call proxy.
 */
class ReceiptBook {
  /**
   * @param ctx - the plugin's own context, used for the inbox event listeners.
   * @param capacity - receipts kept before the oldest is forgotten.
   */
  constructor(ctx, capacity = DEFAULT_CAPACITY) {
    this.ctx = ctx;
    this.capacity = capacity;
    /** Receipts by message id, oldest first. */
    this.receipts = new Map();
    this.listeners = [];
  }

  /**
   * Install the inbox listeners once, on the first receipt.
   *
   * Listening lazily keeps a bus that never sends from observing every inbox event
   * in the process.
   */
  ensureListening() {
    if (this.listeners.length > 0) return;
    this.listeners.push(
      this.ctx.on('agent/inbox/claimed', (event) => this.onClaimed(event)),
      this.ctx.on('agent/inbox/discarded', (event) => this.onDiscarded(event)),
    );
  }

  /**
   * Start tracking one message, before it is routed.
   *
   * @param message - the identified bus message about to be delivered.
   * @param from - sending session id; the only session allowed to read the receipt.
   * @param to - target session id.
   * @returns a function that forgets the receipt, for a delivery that then fails.
   */
  record(message, from, to) {
    this.ensureListening();
    this.receipts.set(message.id, {
      messageId: message.id,
      from,
      to,
      status: QUEUED,
      sentAt: Date.now(),
    });
    while (this.receipts.size > this.capacity) {
      this.receipts.delete(this.receipts.keys().next().value);
    }
    return () => {
      this.receipts.delete(message.id);
    };
  }

  /**
   * Advance a still-queued receipt to a terminal status.
   *
   * Every later status is terminal, and only `queued` may move: `bus_wait` marks a
   * message `received` *before* removing it from the inbox, and that removal is
   * itself reported as a discard, which must not overwrite the receipt.
   *
   * @param messageId - the message id.
   * @param status - the new status.
   * @param fields - extra fields recorded with the transition.
   */
  advance(messageId, status, fields = {}) {
    const receipt = this.receipts.get(messageId);
    if (receipt === undefined || receipt.status !== QUEUED) return;
    Object.assign(receipt, fields, { status, settledAt: Date.now() });
  }

  /**
   * Record that the target's loop took a message into a turn.
   *
   * @param event - the fused `{message, turn, agent}` payload.
   */
  onClaimed(event) {
    const id = event?.message?.id;
    if (id === undefined) return;
    this.advance(id, CLAIMED, Number.isInteger(event.turn) ? { turn: event.turn } : {});
  }

  /**
   * Record that a message was removed from the inbox without running.
   *
   * @param event - the fused `{message, agent}` payload.
   */
  onDiscarded(event) {
    const id = event?.message?.id;
    if (id === undefined) return;
    this.advance(id, DISCARDED);
  }

  /**
   * Record that the target's own `bus_wait` took a message.
   *
   * Must be called before the inbox removal, which reports a discard.
   *
   * @param messageId - the message id.
   */
  markReceived(messageId) {
    this.advance(messageId, RECEIVED);
  }

  /**
   * Read one receipt on behalf of a session.
   *
   * Only the sender may read a receipt. Anyone else gets `unknown`, exactly as for
   * a message that does not exist, so a receipt cannot reveal another session's
   * traffic or even that a message id is real.
   *
   * @param messageId - the id `bus_send` returned.
   * @param callerId - the session asking.
   * @returns the receipt view.
   */
  statusFor(messageId, callerId) {
    const receipt = this.receipts.get(messageId);
    if (receipt === undefined || receipt.from !== callerId) {
      return { messageId, status: UNKNOWN };
    }
    return {
      messageId,
      status: receipt.status,
      to: receipt.to,
      sentAt: new Date(receipt.sentAt).toISOString(),
      ...(receipt.settledAt === undefined
        ? {}
        : {
            settledAt: new Date(receipt.settledAt).toISOString(),
            latencyMs: receipt.settledAt - receipt.sentAt,
          }),
      ...(receipt.turn === undefined ? {} : { turn: receipt.turn }),
    };
  }

  /** Release the listeners and forget every receipt. */
  dispose() {
    for (const off of this.listeners) off();
    this.listeners = [];
    this.receipts.clear();
  }
}

export { CLAIMED, DISCARDED, QUEUED, RECEIVED, ReceiptBook, UNKNOWN };
