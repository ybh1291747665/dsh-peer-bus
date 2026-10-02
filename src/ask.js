/**
 * `bus_ask`: a question that comes back as the caller's tool result.
 *
 * The plan is two steps — send, then wait — and the ergonomics are poor: the
 * caller has to know to wait, the reply can also arrive as its own turn, and two
 * sessions that both wait on each other deadlock until the rate ceiling stops
 * them. This module closes all three.
 *
 * **Correlation is exact, not heuristic.** The ask id travels *with the question*
 * as `source.askId`, and the ask is registered before the question is delivered.
 * That ordering matters: a `followup` to an idle session can be claimed by the
 * driver before the sender's continuation runs, so anything registered afterwards
 * would race the claim it is trying to observe. Because the key is on the message
 * itself, the claim is matched whenever it happens.
 *
 * The answer is then read from the turn that claimed the question: every
 * `assistant/message` carrying that turn number is collected, and the turn's
 * `turn/end` settles the ask. That is more accurate than "the last assistant text
 * in the session", which can be a later, unrelated turn.
 *
 * @module dsh-peer-bus/ask
 */
import { SessionBusError } from './errors.js';
import { createBusMessage } from './message.js';

/** Statuses `bus_ask` can report. */
const ANSWERED = 'answered';
const PENDING = 'pending';
const DISCARDED = 'discarded';

/**
 * Cap on claims remembered for a message no ask has claimed yet.
 *
 * Only reachable if an ask is registered and then fails to map, which the
 * message-carried ask id makes practically impossible; the cap is here so a bug
 * there cannot grow a map without bound.
 */
const MAX_ORPHAN_CLAIMS = 64;

/** Join the text blocks of one assistant message. */
const textOf = (message) =>
  (message?.content ?? [])
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('');

/**
 * Mint a process-unique ask id.
 *
 * The instance token keeps ids unique across a resumed log, where a bare counter
 * would repeat after a restart.
 */
function mintAskId(seq, token) {
  return `ask-${token}-${seq}`;
}

/**
 * In-flight questions, the wait-for graph, and the answer correlation.
 *
 * Not a Cordis service, so `this.ctx` is never shadowed and stays readable after
 * an await.
 */
class AskRegistry {
  /**
   * @param ctx - the plugin's own context.
   * @param bus - the bus, used to deliver questions through the ordinary path.
   * @param config - validated bus policy.
   */
  constructor(ctx, bus, config) {
    this.ctx = ctx;
    this.bus = bus;
    this.config = config;
    /** Unsettled asks, by ask id, in creation order. */
    this.pending = new Map();
    /** `askerId\0targetId` edges for asks currently *blocking* a caller. */
    this.waiting = new Map();
    /** Claims seen for an ask id that is not registered yet. */
    this.orphanClaims = new Map();
    this.seq = 0;
    this.token = Math.random().toString(36).slice(2, 10);
    this.listeners = [];
  }

  /**
   * Whether asking `to` would close a wait cycle.
   *
   * The graph is "who is currently blocked waiting on whom". Adding `from → to`
   * deadlocks exactly when `to` can already reach `from`, because every edge on
   * that path is a caller sitting inside a tool call that cannot return until its
   * own question is answered. A cycle is refused up front; the alternative is both
   * sides burning their whole timeout and then reporting a timeout that names no
   * cause.
   *
   * This is deliberately not a hop cap: ordinary `bus_send` conversations are
   * unbounded, and only blocking waits participate here.
   *
   * @param from - asking session id.
   * @param to - target session id.
   * @returns true when the edge would close a cycle.
   */
  wouldCycle(from, to) {
    const stack = [to];
    const seen = new Set();
    while (stack.length > 0) {
      const current = stack.pop();
      if (current === from) return true;
      if (seen.has(current)) continue;
      seen.add(current);
      for (const next of this.waiting.get(current) ?? []) stack.push(next);
    }
    return false;
  }

  /**
   * Describe the cycle that blocks one ask, for the error message.
   *
   * @param from - asking session id.
   * @param to - target session id.
   * @returns a readable `a -> b -> a` chain.
   */
  cyclePath(from, to) {
    const path = [from, to];
    let current = to;
    for (let hops = 0; hops < 16; hops += 1) {
      const next = [...(this.waiting.get(current) ?? [])][0];
      if (next === undefined) break;
      path.push(next);
      if (next === from) break;
      current = next;
    }
    return path.join(' -> ');
  }

  /** Record one blocking edge. */
  addEdge(from, to) {
    const edges = this.waiting.get(from) ?? new Set();
    edges.add(to);
    this.waiting.set(from, edges);
  }

  /** Drop one blocking edge, and the map entry when it was the last. */
  removeEdge(from, to) {
    const edges = this.waiting.get(from);
    if (edges === undefined) return;
    edges.delete(to);
    if (edges.size === 0) this.waiting.delete(from);
  }

  /** Install the event listeners once, on the first ask. */
  ensureListening() {
    if (this.listeners.length > 0) return;
    this.listeners.push(
      this.ctx.on('agent/inbox/claimed', (event) => this.onClaimed(event)),
      this.ctx.on('agent/inbox/discarded', (event) => this.onDiscarded(event)),
      this.ctx.on('session/event', (session, event) => this.onSessionEvent(session, event)),
    );
  }

  /** Look up the ask one claimed message belongs to, via its own ask id. */
  askOfMessage(message) {
    const askId = message?.source?.askId;
    if (askId === undefined) return undefined;
    return this.pending.get(askId);
  }

  /**
   * Whether a message is an unanswered `bus_ask` question addressed to one session.
   *
   * Such a question must be left for the turn that claims it: that turn is where
   * the answer is read from. A late *answer* carries the same ask id but travels
   * the other way — to the asker — so it never matches here.
   *
   * @param message - a bus message.
   * @param sessionId - the session that would receive it.
   * @returns true when a live ask is waiting for this session to answer it.
   */
  isOpenQuestionFor(message, sessionId) {
    const ask = this.askOfMessage(message);
    return ask !== undefined && ask.settled !== true && ask.targetId === sessionId;
  }

  /**
   * Whether a session takes part in an unsettled ask, on either side.
   *
   * Used before releasing an idle resumed agent: unloading one end of an
   * in-flight question would discard it or strand its answer.
   *
   * @param sessionId - the session to test.
   * @returns true while the session asks, or is being asked, something.
   */
  involves(sessionId) {
    if (this.waiting.has(sessionId)) return true;
    for (const ask of this.pending.values()) {
      if (ask.askerId === sessionId || ask.targetId === sessionId) return true;
    }
    return false;
  }

  /**
   * Record which turn took the question.
   *
   * @param event - the fused `{message, turn, agent}` payload.
   */
  onClaimed(event) {
    const ask = this.askOfMessage(event?.message);
    if (ask === undefined) {
      const askId = event?.message?.source?.askId;
      if (askId !== undefined) this.rememberOrphanClaim(askId, event?.turn);
      return;
    }
    if (ask.turn !== undefined) return;
    ask.turn = event.turn;
    ask.targetAgentId = event.agent?.id;
  }

  /**
   * Remember a claim for an ask that is not registered yet.
   *
   * @param askId - the ask id carried by the claimed message.
   * @param turn - the turn that claimed it.
   */
  rememberOrphanClaim(askId, turn) {
    this.orphanClaims.set(askId, turn);
    while (this.orphanClaims.size > MAX_ORPHAN_CLAIMS) {
      const oldest = this.orphanClaims.keys().next().value;
      this.orphanClaims.delete(oldest);
    }
  }

  /**
   * Settle an ask whose question was thrown away before it ran.
   *
   * @param event - the fused `{message, agent}` payload.
   */
  onDiscarded(event) {
    const ask = this.askOfMessage(event?.message);
    if (ask === undefined) return;
    this.settle(ask, { kind: DISCARDED });
  }

  /**
   * Collect the answer as the target's turn runs, and settle it when the turn ends.
   *
   * @param session - the session the event belongs to.
   * @param event - the session event.
   */
  onSessionEvent(session, event) {
    if (this.pending.size === 0) return;
    if (event?.type === 'assistant/message') {
      const data = event.data;
      if (data === undefined) return;
      for (const ask of this.pending.values()) {
        if (ask.targetId !== session.id || ask.turn === undefined || ask.turn !== data.turn) continue;
        const text = textOf(data.message);
        if (text !== '') ask.answer.push(text);
      }
      return;
    }
    if (event?.type !== 'turn/end') return;
    const turn = event.data?.turn;
    for (const ask of [...this.pending.values()]) {
      if (ask.targetId !== session.id || ask.turn === undefined || ask.turn !== turn) continue;
      this.settle(ask, { kind: ANSWERED, turn });
    }
  }

  /**
   * End one ask and hand its outcome to whoever is waiting.
   *
   * Resolution is deferred to a microtask: these are called from listeners that
   * run while a session is still publishing an event, and the waiting caller's
   * continuation may deliver another message.
   *
   * @param ask - the ask to settle.
   * @param outcome - `{kind, turn?}`.
   */
  settle(ask, outcome) {
    if (ask.settled === true) return;
    ask.settled = true;
    if (ask.timer !== undefined) {
      clearTimeout(ask.timer);
      ask.timer = undefined;
    }
    // A timed-out ask has no waiter left; its answer is handed over as a message
    // instead. This is checked here rather than at the caller, because a turn can
    // end in the window between the wait timer firing and the caller resuming.
    if (ask.timedOut === true) {
      this.pending.delete(ask.askId);
      const text = outcome.kind === ANSWERED ? ask.answer.join('\n\n') : (outcome.text ?? '');
      queueMicrotask(() => this.deliverLate(ask, text));
      return;
    }
    ask.finish?.(() => ask.settlePromise?.(outcome));
  }

  /**
   * Ask one session a question and wait for its answer.
   *
   * @param asker - exact live calling agent.
   * @param request - `{target, text, timeoutMs}`.
   * @param options - optional cancellation.
   * @returns `{status, askId, from, text?, turn?}`.
   * @throws {SessionBusError} `ask-cycle` before delivery, plus every rejection
   *   `bus.send` itself can produce.
   */
  async ask(asker, request, options = {}) {
    const text = request.text;
    if (typeof text !== 'string' || text.trim() === '') {
        throw new SessionBusError('question text must be a non-empty string', 'invalid-text');
    }
    const rows = await this.bus.roster(options);
    const targetId = this.bus.resolveIn(rows, request.target);
    if (targetId === asker.id) {
      throw new SessionBusError('a session cannot ask itself', 'self-send');
    }
    if (this.wouldCycle(asker.id, targetId)) {
      throw new SessionBusError(
        `asking "${targetId}" would close a wait cycle (${this.cyclePath(asker.id, targetId)}); one side must answer with bus_send instead of bus_ask`,
        'ask-cycle',
      );
    }

    // A target that is already running cannot start this turn immediately, so the
    // wait is bounded more tightly: the plan's recommendation is to hand back a
    // pending ask quickly rather than hold the caller's turn open for a whole
    // turn's worth of work that has not begun.
    const target = this.ctx.agents.get(targetId);
    const busy = target !== undefined && target.status !== 'idle';
    const requested = Number.isFinite(request.timeoutMs) ? Math.trunc(request.timeoutMs) : undefined;
    const bound = Math.max(
      0,
      Math.min(requested ?? (busy ? this.config.askBusyTimeoutMs : this.config.waitTimeoutMs), this.config.maxWaitMs),
    );

    this.ensureListening();
    const askId = mintAskId((this.seq += 1), this.token);
    const ask = {
      askId,
      askerId: asker.id,
      targetId,
      turn: undefined,
      answer: [],
      settled: false,
      finish: undefined,
      timer: undefined,
    };
    // Registered BEFORE delivery, because the claim can beat the send's
    // continuation. The id travels on the message, so this ordering is enough.
    this.pending.set(askId, ask);
    this.addEdge(asker.id, targetId);

    let delivery;
    try {
      delivery = await this.bus.send(
        asker,
        // `upstream` is what lets the far side see a cycle that runs through both
        // processes: neither graph contains the other's edges.
        { target: targetId, text, mode: 'followup', askId, upstream: this.upstreamOf(asker.id) },
        options,
      );
    } catch (error) {
      this.pending.delete(askId);
      this.removeEdge(asker.id, targetId);
      throw error;
    }
    ask.messageId = delivery.messageId;
    // Only a forwarded question leaves a proxy on the far side that needs releasing.
    ask.remote = delivery.targetState === 'remote';
    // A claim that arrived while the send was in flight is replayed here.
    const earlyTurn = this.orphanClaims.get(askId);
    if (earlyTurn !== undefined) {
      this.orphanClaims.delete(askId);
      ask.turn = earlyTurn;
    }

    let outcome;
    try {
      outcome = await this.wait(ask, bound, options);
    } catch (error) {
      // Cancellation and a mid-wait unload both leave through here. The edge has
      // to go with them: a stale edge is a phantom "someone is blocked" that makes
      // a later ask report `ask-cycle` for a deadlock that does not exist.
      this.pending.delete(askId);
      this.removeEdge(asker.id, targetId);
      throw error;
    }
    this.removeEdge(asker.id, targetId);

    if (outcome.kind === ANSWERED) {
      this.pending.delete(askId);
      return {
        status: ANSWERED,
        askId,
        from: targetId,
        text: ask.answer.join('\n\n'),
        turn: outcome.turn,
      };
    }
    if (outcome.kind === 'replied') {
      this.pending.delete(askId);
      // Prefer the turn the answer came from. Locally it is the same value, but a
      // cross-process answer carries the turn from the process that ran it, and
      // this side never saw that claim.
      return { status: ANSWERED, askId, from: targetId, text: outcome.text, turn: outcome.turn ?? ask.turn };
    }
    if (outcome.kind === DISCARDED) {
      this.pending.delete(askId);
      return { status: DISCARDED, askId, from: targetId };
    }

    if (outcome.kind === 'disposed') {
      this.pending.delete(askId);
      throw new SessionBusError('the bus was unloaded while this question was in flight', 'disposed');
    }

    // Timed out. The ask stays registered so the answer, when it comes, is
    // delivered to the asker as an ordinary bus message tagged with this ask id.
    // It is dropped after the same ceiling, so a target that never answers cannot
    // pin an entry for the life of the process.
    ask.timer = setTimeout(() => {
      this.pending.delete(askId);
      // Past this point nothing here can receive the answer, so the peer's proxy is
      // released now rather than left until its own ceiling.
      if (ask.remote === true) void this.bus.cancelRemoteAsk({ askId, targetId });
    }, this.config.maxWaitMs);
    ask.timer.unref?.();
    return { status: PENDING, askId, from: targetId };
  }

  /**
   * Wait for one ask to settle, its target to discard it, or the bound to elapse.
   *
   * @param ask - the registered ask.
   * @param bound - milliseconds to wait.
   * @param options - optional cancellation.
   * @returns the outcome.
   */
  wait(ask, bound, options) {
    return new Promise((resolve, reject) => {
      let detached = false;
      /** Detach the timer and abort hook exactly once, then hand over the settle step. */
      ask.finish = (settle) => {
        if (detached) return;
        detached = true;
        if (ask.timer !== undefined) clearTimeout(ask.timer);
        options.signal?.removeEventListener('abort', onAbort);
        queueMicrotask(() => {
          try {
            settle();
          } catch (error) {
            reject(error);
          }
        });
      };
      ask.settlePromise = resolve;
      ask.timer = setTimeout(() => {
        // Flagged synchronously: a `turn/end` arriving before the resolve
        // continuation runs must take the late-delivery path rather than try to
        // settle a waiter that has already given up.
        ask.timedOut = true;
        ask.finish?.(() => resolve({ kind: 'timeout' }));
      }, bound);
      /** Forward caller cancellation into a rejection rather than a hang. */
      const onAbort = () => ask.finish?.(() => reject(new Error('bus_ask was cancelled')));
      options.signal?.addEventListener('abort', onAbort, { once: true });
      if (options.signal?.aborted) onAbort();
    });
  }

  /**
   * Answer the question this session is currently running, explicitly.
   *
   * No ask id is asked of the model on purpose: the id would have to be smuggled
   * into the question text to be visible, and a session answers one question per
   * turn in practice. The registry resolves "the ask whose turn this is".
   *
   * @param target - the live agent answering.
   * @param text - the answer.
   * @returns the ask id answered and the session it went to.
   * @throws {SessionBusError} `no-pending-ask` when nothing is waiting on it.
   */
  async reply(target, text) {
    if (typeof text !== 'string' || text.trim() === '') {
      throw new SessionBusError('reply text must be a non-empty string', 'invalid-text');
    }
    const ask = this.inFlightFor(target.id);
    if (ask === undefined) {
      throw new SessionBusError(
        'no bus_ask is waiting on this session, so there is nothing to reply to',
        'no-pending-ask',
      );
    }
    this.settle(ask, { kind: 'replied', text, turn: ask.turn });
    return { askId: ask.askId, to: ask.askerId };
  }

  /**
   * The newest unsettled ask this session has already started answering.
   *
   * @param targetId - the answering session id.
   * @returns the ask, or undefined when there is none.
   */
  inFlightFor(targetId) {
    let found;
    for (const ask of this.pending.values()) {
      if (ask.targetId !== targetId || ask.settled === true) continue;
      found = ask;
    }
    return found;
  }

  /**
   * Every session that transitively waits on this one.
   *
   * The wait graph is stored as "X waits on Y" edges, so this walks it backwards.
   * A peer needs the answer because its own graph cannot see this process's edges:
   * without it, a cycle that runs through two processes is invisible to both.
   *
   * @param sessionId - the session to look upstream from.
   * @returns the waiting session ids, excluding the session itself.
   */
  upstreamOf(sessionId) {
    const reverse = new Map();
    for (const [waiter, targets] of this.waiting) {
      for (const target of targets) {
        const sources = reverse.get(target) ?? new Set();
        sources.add(waiter);
        reverse.set(target, sources);
      }
    }
    const found = new Set();
    const stack = [...(reverse.get(sessionId) ?? [])];
    while (stack.length > 0) {
      const current = stack.pop();
      if (current === sessionId || found.has(current)) continue;
      found.add(current);
      for (const next of reverse.get(current) ?? []) stack.push(next);
    }
    return [...found];
  }

  /**
   * Whether a question arriving from a peer would close a wait cycle.
   *
   * Two ways it can, and both are needed:
   *
   * - **Locally**: this process's own graph already has the target waiting on the
   *   sender, so the sender waiting on the target closes the loop.
   * - **Through the peer's graph**: the sender reports who transitively waits on
   *   it, and if the target reaches any of those here, the loop closes through
   *   sessions in both processes — which neither side can see alone.
   *
   * @param senderId - the session asking, in the peer's process.
   * @param targetId - the session being asked, in this process.
   * @param upstream - sessions the sender says wait on it transitively.
   * @returns the session that closes the cycle, or undefined.
   */
  remoteCycle(senderId, targetId, upstream) {
    if (this.wouldCycle(senderId, targetId)) return senderId;
    for (const waiter of Array.isArray(upstream) ? upstream : []) {
      if (typeof waiter !== 'string') continue;
      if (this.wouldCycle(waiter, targetId)) return waiter;
    }
    return undefined;
  }

  /**
   * Track a question another process asked, on behalf of the peer that asked it.
   *
   * The entry is a real pending ask in every way that matters locally: a claim
   * attaches the turn to it, the target's assistant messages accumulate into it,
   * `bus_wait` skips the question, and `bus_reply` can settle it. What differs is
   * where the outcome goes — there is no waiter in this process, so it is pushed
   * back to the endpoint that asked.
   *
   * `finish` is deliberately a plain passthrough: there is no timer to clear and no
   * abort hook to detach here, so settling the ask is the whole job.
   *
   * It also records the wait edges the question implies. A cross-process question
   * leaves its edge in the **asker's** graph, so without this a cycle spanning three
   * processes is invisible to every one of them: the receiver knows only that it was
   * asked, not who is now blocked behind it.
   *
   * @param question - the ask id, who asked, what it targets, where to answer, and
   *   who the asker says is waiting on it.
   * @returns the registered proxy ask.
   */
  registerProxy({ askId, askerId, targetId, replyTo, upstream }) {
    this.ensureListening();
    // The asker waits on the target, and so does everyone the asker reported as
    // waiting on *it* — transitively, they are all blocked behind this target now.
    const claimedEdges = [
      [askerId, targetId],
      ...(Array.isArray(upstream) ? upstream : [])
        .filter((waiter) => typeof waiter === 'string')
        .map((waiter) => [waiter, targetId]),
    ];
    for (const [from, to] of claimedEdges) this.addEdge(from, to);
    const proxy = {
      askId,
      askerId,
      targetId,
      replyTo,
      turn: undefined,
      answer: [],
      settled: false,
      timer: undefined,
      finish: (settle) => settle(),
      settlePromise: (outcome) => void this.pushRemoteAnswer(proxy, outcome),
      claimedEdges,
    };
    // The asker is supposed to send an `ask.cancel` when it stops caring, but it may
    // have been killed instead. This ceiling is what bounds the entry in that case:
    // without it an unanswered question would live as long as the process.
    proxy.timer = setTimeout(() => {
      this.pending.delete(askId);
      for (const [from, to] of claimedEdges) this.removeEdge(from, to);
    }, this.config.maxWaitMs);
    proxy.timer.unref?.();
    this.pending.set(askId, proxy);
    return proxy;
  }

  /**
   * Release a proxy ask because the process that asked has stopped waiting.
   *
   * @param askId - the question to forget.
   * @returns whether anything was released.
   */
  cancelProxy(askId) {
    const proxy = this.pending.get(askId);
    if (proxy === undefined) return { cancelled: false };
    if (proxy.timer !== undefined) clearTimeout(proxy.timer);
    this.pending.delete(askId);
    for (const [from, to] of proxy.claimedEdges ?? []) this.removeEdge(from, to);
    return { cancelled: true };
  }

  /**
   * Send a proxied ask's outcome back to the process that asked.
   *
   * @param proxy - the proxy ask that just settled.
   * @param outcome - `{kind, text?, turn?}`.
   */
  async pushRemoteAnswer(proxy, outcome) {
    const text = outcome.kind === ANSWERED ? proxy.answer.join('\n\n') : (outcome.text ?? '');
    this.pending.delete(proxy.askId);
    // A stale edge is a phantom "someone is blocked" that makes a later ask report
    // `ask-cycle` for a deadlock that does not exist.
    for (const [from, to] of proxy.claimedEdges ?? []) this.removeEdge(from, to);
    await this.bus.pushRemoteAnswer({
      askId: proxy.askId,
      askerId: proxy.askerId,
      targetId: proxy.targetId,
      replyTo: proxy.replyTo,
      text,
      turn: outcome.turn,
    });
  }

  /**
   * Settle a local ask from a peer's pushed answer.
   *
   * If the caller already gave up, the existing timeout path takes over and the
   * answer arrives as an ordinary bus message — so a slow peer loses nothing.
   *
   * @param payload - `{askId, text, turn?}`.
   * @returns whether an ask was still waiting on it.
   */
  receiveRemoteAnswer(payload) {
    const ask = this.pending.get(payload?.askId);
    if (ask === undefined) return { accepted: false };
    this.settle(ask, { kind: 'replied', text: String(payload.text ?? ''), turn: payload.turn });
    return { accepted: true };
  }

  /**
   * Deliver a late answer to the session that asked.
   *
   * This bypasses the pair allowlist on purpose. The asker initiated the exchange
   * — that is the consent — and requiring the *reverse* direction to be allowed as
   * well would silently drop the answer to a question that was legitimately asked.
   *
   * @param ask - the ask that just produced an answer.
   * @param text - the answer text.
   */
  deliverLate(ask, text) {
    const asker = this.ctx.agents.get(ask.askerId);
    if (asker === undefined) return;
    asker.followup(createBusMessage(ask.targetId, text, { askId: ask.askId, role: 'answer' }));
  }

  /**
   * Release every listener and timer, and fail the waits still in flight.
   */
  dispose() {
    for (const off of this.listeners) off();
    this.listeners = [];
    for (const ask of this.pending.values()) {
      if (ask.timer !== undefined) clearTimeout(ask.timer);
      ask.settled = true;
      ask.settlePromise?.({ kind: 'disposed' });
      // A proxy belongs to a peer, not to us, so it is not cancelled here — the
      // peer's own ceiling handles it. A question *we* asked, though, left a proxy
      // behind that nothing else will release.
      if (ask.remote === true) void this.bus.cancelRemoteAsk({ askId: ask.askId, targetId: ask.targetId });
    }
    this.pending.clear();
    this.waiting.clear();
    this.orphanClaims.clear();
  }
}

export { ANSWERED, AskRegistry, DISCARDED, PENDING, mintAskId, textOf };
