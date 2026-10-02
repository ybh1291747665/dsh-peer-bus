/**
 * Cross-session message bus for DeepSeek Harness.
 *
 * Delivery rides the live `Agent` API that `@deepseek-ai/dsh-agent` augments onto
 * every registered agent: `followup()` queues an ordinary turn and wakes the
 * driver, `steer()` admits at the nearest step boundary and starts a turn when
 * the driver is idle. A session that is persisted but not loaded is cold-resumed
 * through `ctx.agents.resume()`, which loads the log and starts its loop.
 *
 * The session log is the durable store: `followup`/`steer` record an
 * `agent/inbox/spliced` event plus the visible `user/message`, so a delivered
 * message survives a restart without a second mailbox of our own.
 *
 * @module dsh-peer-bus/peer-bus
 */
import { Service } from '@deepseek-ai/cordis';
import { AskRegistry } from './ask.js';
import { SessionBusError } from './errors.js';
import { RuntimeAllowlist } from './allowlist.js';
import { BUS_SOURCE_KIND, createBusMessage, isBusSource } from './message.js';
import { ReceiptBook } from './receipts.js';

/**
 * Whether a session header describes a delegated subagent child.
 *
 * `dsh-subagent` stamps `origin: 'subagent'` and a positive `delegationDepth` on
 * every child, and the child inherits its parent's `cwd`. `parentSession` alone
 * is not used: a user-initiated fork carries it too and is a peer, not a child.
 *
 * @param header - session header, possibly undefined.
 * @returns true for a subagent child.
 */
const isSubagentHeader = (header) =>
  header?.origin === 'subagent' || (header?.delegationDepth ?? 0) > 0;

/**
 * The stable code of a DSH remote error, when the failure carries one.
 *
 * The session controller reports a log held by another writer as
 * \`session/writer-held\`; reading it by name keeps this package independent of
 * \`@deepseek-ai/dsh-api-gateway\`, which owns the class.
 *
 * @param error - any thrown value.
 * @returns the remote code, or undefined when this is not a remote error.
 */
const remoteErrorCode = (error) =>
  error?.isDSHRemoteError === true && typeof error.code === 'string' ? error.code : undefined;

/**
 * The shared "nothing is archived" answer.
 *
 * Returned instead of a fresh `Set` on every read, so the common case — a
 * profile with no workspace registry at all — allocates nothing. Never mutated.
 */
const NO_ARCHIVED = new Set();

/**
 * How many forwarded-delivery receipts one process remembers.
 *
 * Mirrors the receipt book's own capacity. Without a bound this map would grow for
 * the life of the process, one entry per cross-process message ever sent.
 */
const REMOTE_RECEIPT_CAPACITY = 1000;

/**
 * How many delivery ids one process remembers for de-duplication.
 *
 * A forwarded delivery can be retried by a sender that never saw the answer — the
 * request timed out, but the peer may well have delivered it. The receiver is the only
 * side that can tell, so it remembers what it has already taken.
 */
const DELIVERY_MEMORY = 1000;

/** How long a process waits for the claim winner to actually take the session. */
const CLAIM_WAIT_MS = 5000;

/** How often it asks. One boolean per peer, so this is cheap. */
const CLAIM_POLL_MS = 150;

/** Promise-based delay. */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Re-raise a transport failure as this process's own error type.
 *
 * A code that crossed the wire arrives as a plain `Error` with a `code` field, but
 * every caller of this bus — the model tools above all — branches on
 * `SessionBusError`. Without this, a peer's `denied` would reach the tool layer as
 * an unrecognised error and be reported as an internal failure instead of as the
 * refusal it is.
 *
 * @param error - whatever the transport threw.
 * @returns a `SessionBusError` carrying the same code.
 */
const asBusError = (error) =>
  error instanceof SessionBusError
    ? error
    : new SessionBusError(error?.message ?? String(error), typeof error?.code === 'string' ? error.code : 'internal');

/**
 * Whether a failure (or anything in its `cause` chain) is the persistence
 * layer's lock-contention error: the session is owned by another writer, which
 * in practice means it is open in another DSH process.
 *
 * Matched by name because `@deepseek-ai/dsh-session-persistence` is not a
 * dependency of this package.
 *
 * @param error - failure from `ctx.agents.resume()`.
 * @returns true when the target's log is locked by another owner.
 */
function isOwnedElsewhere(error) {
  let current = error;
  for (let depth = 0; depth < 8 && current != null; depth += 1) {
    if (current.name === 'SessionAlreadyOwnedError') return true;
    current = current.cause;
  }
  return false;
}

/**
 * Address book and delivery path over every session the process can see.
 *
 * Live agents come from `ctx.agents`; persisted-but-unloaded sessions come from
 * `ctx.sessionPersistence`. Delivery never appends to a log directly — it always
 * goes through the live agent so the driver is actually woken.
 */
class SessionBus extends Service {
  /**
   * @param ctx - owning context; must carry `agents`, `sessionPersistence`, and `logger`.
   * @param config - validated bus policy (permissions, limits, resume timeout).
   */
  constructor(ctx, config) {
    super(ctx, 'peerBus');
    /**
     * The plugin's own context, kept under a name Cordis does not shadow.
     *
     * While a service method runs, Cordis rebinds `this.ctx` to a scoped shadow so
     * that `this.ctx.<serviceName>` names the service itself. That shadow is only
     * valid for the synchronous part of the call: any lookup made after an `await`
     * that crosses a macrotask comes back `undefined`. Because every optional
     * capability here (persistence, archive state, presets, the allowlist domain)
     * is read through `this.ctx.get(...)` mid-method, that failure would be
     * silent — the capability would simply appear to be absent. Callers that reach
     * the bus through `ctx.get('peerBus')` are exactly the ones affected.
     */
    this.pluginCtx = ctx;
    this.config = config;
    /**
     * In-flight cold resumes only, so concurrent sends share one load of a target
     * log. A settled load is dropped: liveness is always re-read from
     * `ctx.agents`, never from a cached result that may name an unloaded agent.
     */
    this.resuming = new Map();
    /** Agent handles this plugin owns, so a resumed target's lifecycle is released on unload. */
    this.owned = new Map();
    /** Last time each owned agent showed activity, for the idle release. */
    this.lastActivity = new Map();
    /** Owned agents being released right now, so a send can wait the release out. */
    this.releasing = new Map();
    /** The periodic idle sweep and its activity listener; present only while something is owned. */
    this.idleSweep = undefined;
    this.activityOff = undefined;
    /** Per sender→target delivery timestamps, for the loop guard. */
    this.recentSends = new Map();
    /**
     * Grants made with `/bus allow`, additive to the config allowlist and durable
     * when this composition has a storage domain.
     */
    this.allowlist = new RuntimeAllowlist(this.pluginCtx);
    /** In-flight `bus_ask` questions, the wait-for graph, and answer correlation. */
    this.asks = new AskRegistry(this.pluginCtx, this, config);
    /**
     * The cross-process endpoint, started on first use when `crossProcess` is on.
     *
     * Nothing here is created — or even imported — while the flag is off, which is
     * what keeps the default a true no-op rather than a dormant socket.
     */
    this.xprocStart = undefined;
    /** Sticky: a transport that failed to start is not retried on every call. */
    this.xprocFailed = false;
    /** session id → the peer entry that reported it live, from the last roster. */
    /** Advisory: the owners the last roster pass saw. Diagnostics only. */
    this.lastKnownRemoteOwners = new Map();
    /** message id returned to a caller for a forwarded delivery → its peer entry. */
    this.remoteReceipts = new Map();
    /** delivery id → the durable message id it produced, for de-duplication. */
    this.deliveredRemote = new Map();
    /**
     * The last peer answer to "who holds what", reused for
     * `crossProcessRosterCacheMs`.
     *
     * Only the *remote* half is cached. The local half is rebuilt every time, because
     * this process's own live set changes without any peer being involved.
     */
    this.remoteCache = undefined;
    // Start publishing immediately when the transport is on. Waiting for the
    // first bus call would leave a process that never uses the bus undiscoverable
    // — and the point of the transport is to reach a session *another* process
    // holds, which is exactly the process that may never have called us.
    if (config.crossProcess === true) void this.xproc();
    /** What became of each delivered message, for `bus_status`. */
    this.receipts = new ReceiptBook(this.pluginCtx);
  }

  /**
   * The host's own \`agent\` lookup, when a session controller configured one.
   *
   * \`dsh-agent\` registers the lookup *provider* on every profile, but its own
   * resolver answers only for an agent that is already live — which is exactly the
   * case a cold resume is not. \`dsh-api-session-controller\` (web bundle only)
   * configures the resolver that performs a real resume. So the discriminator is
   * the answer, not the presence: a bare provider returns \`undefined\` for a stored
   * session and the manual path below takes over.
   *
   * @returns the lookup, or undefined when this composition has no Typert registry.
   */
  hostAgentLookup() {
    const typert = this.pluginCtx.get('typert');
    const lookup = typert?.lookups?.get?.('agent');
    return typeof lookup?.resolve === 'function' ? lookup : undefined;
  }

  /**
   * The title one live session currently shows.
   *
   * Titles come from the session's own log (the newest \`session/title\` event),
   * so this needs a live or replayed session. A stored session has none here on
   * purpose: reading one would mean a log read per roster row, and the roster is
   * rebuilt on every send. \`undefined\` means "not known", never "empty title".
   *
   * @param session - a live session, or undefined.
   * @returns the title, or undefined when there is none to read.
   */
  titleOf(session) {
    if (session === undefined) return undefined;
    const titles = this.pluginCtx.get('sessionTitle');
    if (titles === undefined) return undefined;
    try {
      const snapshot = titles.get(session);
      return typeof snapshot?.title === 'string' && snapshot.title !== '' ? snapshot.title : undefined;
    } catch {
      // A session that cannot be folded (already disposed) simply has no title.
      return undefined;
    }
  }

  /**
   * The session ids the workspace registry currently reports as archived.
   *
   * `workspaceRegistry` is an optional capability — only the `dsh-web-app` bundle
   * mounts it — so a headless profile has none and the bus behaves exactly as it
   * did before archive support existed. The getter throws until the registry has
   * loaded its durable state, which also means "nothing is archived yet".
   *
   * @returns archived session ids, or an empty set when they cannot be read.
   */
  archivedIds() {
    const registry = this.pluginCtx.get('workspaceRegistry');
    if (registry === undefined) return NO_ARCHIVED;
    try {
      const ids = registry.archivedSessionIds;
      if (Array.isArray(ids)) return new Set(ids);
      if (ids instanceof Set) return ids;
    } catch {
      // `archivedSessionIds` throws before the registry has started.
    }
    return NO_ARCHIVED;
  }

  /**
   * List every session the bus can address: live agents first, then persisted
   * sessions that are not currently loaded.
   *
   * This is the unfiltered address book used for resolution, so it still carries
   * archived sessions — flagged `archived` — which is what lets `send` answer
   * `target-archived` instead of the misleading `unknown-target`. What a calling
   * session may *see* is {@link visibleRoster}, which drops them.
   *
   * @param options - optional cancellation.
   * @returns addressable rows with id, liveness, header metadata, the live title when there is one, whether the session is a subagent child, and whether it is archived.
   */
  /**
   * Build the roster and the ownership that came with it.
   *
   * Split from `roster` so a caller that needs to *route* by ownership gets it from
   * the same call that discovered it, rather than from state a later call may have
   * replaced.
   *
   * @param options - optional cancellation.
   * @returns `{rows, owners}`.
   */
  async rosterWithOwners(options = {}) {
    // Every permission decision is made from a roster, so this is the one place
    // that has to wait for the durable runtime grants to be adopted. Without it,
    // the first send after a restart could be refused by an allowlist that had not
    // finished loading.
    // Resolve every service BEFORE the first await. Cordis rebinds `this.ctx` to a
    // per-call shadow while a service method runs, and a lookup made after an await
    // that crosses a macrotask fails as an "inactive context" — which is what a
    // caller reaching the bus through `ctx.get('peerBus')` would hit. Reading up
    // front is the discipline that keeps that path working.
    const agents = this.pluginCtx.agents;
    const persistence = this.pluginCtx.get('sessionPersistence');
    const logger = this.pluginCtx.logger;
    const archived = this.archivedIds();
    await this.allowlist.ready;
    const rows = new Map();
    /** session id → the peer entry that reported it live. Local to this call. */
    const owners = new Map();
    for (const agent of agents.list()) {
      rows.set(agent.id, {
        id: agent.id,
        live: true,
        status: agent.status,
        cwd: agent.session.header?.cwd,
        title: this.titleOf(agent.session),
        subagent: isSubagentHeader(agent.session.header),
        archived: archived.has(agent.id),
      });
    }
    if (persistence !== undefined) {
      const snapshots = await persistence.list({ signal: options.signal });
      for (const snapshot of snapshots) {
        if (rows.has(snapshot.header.id)) continue;
        rows.set(snapshot.header.id, {
          id: snapshot.header.id,
          live: false,
          cwd: snapshot.header.cwd,
          subagent: isSubagentHeader(snapshot.header),
          archived: archived.has(snapshot.header.id),
        });
      }
    }
    // Peers' live sessions last, and only where we have nothing live ourselves: a
    // log has exactly one owner, so a session live in two processes is a
    // contradiction, and the local view is the one we can verify.
    let reported;
    let reportedOwners;
    if (options.remote === false || this.config.crossProcess !== true) {
      reported = [];
      reportedOwners = new Map();
    } else {
      const cacheMs = this.config.crossProcessRosterCacheMs ?? 0;
      const cached = this.remoteCache;
      if (cacheMs > 0 && cached !== undefined && Date.now() - cached.at < cacheMs) {
        ({ rows: reported, owners: reportedOwners } = cached);
      } else {
        const endpoint = await this.xproc();
        if (endpoint === undefined) {
          reported = [];
          reportedOwners = new Map();
        } else {
          const { remoteLiveRows } = await import('./xproc/index.js');
          ({ rows: reported, owners: reportedOwners } = await remoteLiveRows(endpoint, logger));
          this.remoteCache = { rows: reported, owners: reportedOwners, at: Date.now() };
        }
      }
    }
    for (const remote of reported) {
      if (rows.get(remote.id)?.live === true) continue;
      owners.set(remote.id, reportedOwners.get(remote.id));
      rows.set(remote.id, {
        id: remote.id,
        live: true,
        host: 'remote',
        status: remote.status,
        cwd: remote.cwd,
        title: remote.title,
        subagent: remote.subagent === true,
        // Recomputed every pass, not cached: the peer's own archive state is
        // authoritative for what it holds, and ours can change between passes.
        archived: remote.archived === true || archived.has(remote.id),
      });
    }
    // Advisory only, for the diagnostic in `busyMessage`. Nothing on a decision path
    // reads it: an earlier version kept the owner map here and had `forwardRemote`
    // look it up afterwards, which meant a message could be routed by state another
    // call had already replaced.
    this.lastKnownRemoteOwners = owners;
    return { rows: [...rows.values()], owners };
  }

  /**
   * The roster as an array, for callers that do not need the owners.
   *
   * @param options - optional cancellation.
   * @returns the rows.
   */
  async roster(options = {}) {
    return (await this.rosterWithOwners(options)).rows;
  }

  /**
   * Every live session in this process, without reading persistence.
   *
   * A peer only needs to know what is held *here*, so answering it must not cost a
   * full scan of every stored session — that would make one `bus_send` do as many full
   * scans as there are peers, for rows that are then filtered away.
   *
   * @returns live rows, including this process's own archive state.
   */
  liveRows() {
    const agents = this.pluginCtx.agents;
    const archived = this.archivedIds();
    const rows = [];
    for (const agent of agents.list()) {
      rows.push({
        id: agent.id,
        live: true,
        status: agent.status,
        cwd: agent.session.header?.cwd,
        title: this.titleOf(agent.session),
        subagent: isSubagentHeader(agent.session.header),
        archived: archived.has(agent.id),
      });
    }
    return rows;
  }

  /**
   * The roster as one calling session may see it.
   *
   * With the default `rosterScope: 'allowed'` this is the caller's own row plus
   * every session it is permitted to message, so a session cannot enumerate the
   * ids and workspace paths of unrelated projects. `rosterScope: 'all'` lists
   * everything, each row annotated with whether the caller may message it.
   *
   * Archived sessions are never listed, and an archived caller is shown nothing:
   * `bus_roster` must not advertise a conversation that `bus_send` would refuse.
   *
   * @param caller - the live calling agent.
   * @param options - optional cancellation.
   * @returns visible rows, each flagged `self` and `allowed`.
   */
  async visibleRoster(caller, options = {}) {
    const archived = this.archivedIds();
    const rows = (await this.roster(options)).filter((row) => row.archived !== true);
    const callerRow = rows.find((row) => row.id === caller.id) ?? this.rowOf(caller, archived);
    if (callerRow.archived === true) return [];
    const visible = [];
    if (!rows.some((row) => row.id === caller.id)) {
      visible.push({ ...callerRow, self: true, allowed: false });
    }
    for (const row of rows) {
      const self = row.id === caller.id;
      const allowed = !self && this.isAllowed(callerRow, row);
      if (this.config.rosterScope !== 'all' && !self && !allowed) continue;
      visible.push({ ...row, self, allowed });
    }
    return visible;
  }

  /**
   * Build a roster row for a live agent the roster did not list.
   *
   * @param agent - live agent.
   * @param archived - archive set to test against, resolved by the caller.
   * @returns the row the permission check reads.
   */
  rowOf(agent, archived = this.archivedIds()) {
    const header = agent.session?.header;
    return {
      id: agent.id,
      live: true,
      status: agent.status,
      cwd: header?.cwd,
      title: this.titleOf(agent.session),
      subagent: isSubagentHeader(header),
      archived: archived.has(agent.id),
    };
  }

  /**
   * Resolve a caller-supplied address against already-fetched roster rows.
   *
   * A full session id always wins; otherwise an exact id-prefix match is
   * accepted so a human can type a short handle. Ambiguous prefixes are
   * rejected rather than guessed.
   *
   * @param rows - roster rows to resolve against.
   * @param address - full session id or unambiguous prefix.
   * @returns the resolved session id.
   * @throws {SessionBusError} `unknown-target` when nothing matches, `ambiguous-target` when several do.
   */
  resolveIn(rows, address) {
    if (rows.some((row) => row.id === address)) return address;
    const matches = rows.filter((row) => row.id.startsWith(address));
    if (matches.length === 1) return matches[0].id;
    if (matches.length > 1) {
      throw new SessionBusError(
        `address "${address}" matches ${matches.length} sessions; use a longer id`,
        'ambiguous-target',
      );
    }
    // Not an id or an id prefix, so try a title. Ids stay canonical and a title is
    // only ever an auxiliary address: a title that matches several sessions is
    // refused with its candidates rather than guessed at.
    const wanted = address.trim().toLowerCase();
    const titled = rows.filter(
      (row) => typeof row.title === 'string' && row.title.toLowerCase() === wanted,
    );
    if (titled.length === 1) return titled[0].id;
    if (titled.length > 1) {
      throw new SessionBusError(
        `title "${address}" matches ${titled.length} sessions: ${titled.map((row) => row.id).join(', ')}; use an id`,
        'ambiguous-target',
      );
    }
    throw new SessionBusError(`no session matches address "${address}"`, 'unknown-target');
  }

  /**
   * Resolve a caller-supplied address to a session id.
   *
   * @param address - full session id or unambiguous prefix.
   * @param options - optional cancellation.
   * @returns the resolved session id.
   * @throws {SessionBusError} see {@link resolveIn}.
   */
  async resolve(address, options = {}) {
    return this.resolveIn(await this.roster(options), address);
  }

  /**
   * Normalize a workspace path for comparison.
   *
   * Only trailing separators are stripped: DSH already validates a session's
   * `cwd` as absolute, and resolving symlinks here would mean filesystem I/O on
   * every permission check.
   *
   * @param cwd - raw workspace path, possibly undefined.
   * @returns the comparable form, or undefined when there is no usable path.
   */
  static normalizeCwd(cwd) {
    if (typeof cwd !== 'string') return undefined;
    const trimmed = cwd.replace(/[/\\]+$/, '');
    return trimmed === '' ? undefined : trimmed;
  }

  /**
   * Decide the permission allowlist for one sender→target pair.
   *
   * Default is deny: an empty allowlist permits nothing. Two rule shapes exist:
   *
   *   `{ from, to }`            id patterns. A pattern matches exactly, or as a
   *                             trailing-`*` prefix so one rule can cover a
   *                             session family. `'*'` matches anything. These
   *                             are not globs.
   *   `{ sameWorkspace: true }` the pair may talk when both sessions share a
   *                             workspace. Optionally narrowed with `cwd`.
   *
   * The workspace shape exists because a session id is a fresh UUID, so an
   * id rule cannot be written before the session exists. It is also narrower
   * than `'*'`: a session in an unrelated project does not match.
   *
   * A workspace rule never matches when either side is a subagent child unless
   * the rule sets `includeSubagents: true`. A child inherits its parent's `cwd`,
   * so without this exclusion a subagent reading untrusted input could instruct
   * — and cold-resume — every root session in the same project. Id rules are
   * explicit and are not affected.
   *
   * @param sender - roster row of the caller, carrying `id`, `cwd`, and `subagent`.
   * @param target - roster row of the resolved destination.
   * @returns whether any allowlist rule covers the pair.
   */
  isAllowedByConfig(sender, target) {
    const allowed = this.config.allow ?? [];
    const matchesId = (pattern, id) =>
      pattern === '*' ||
      pattern === id ||
      (pattern.endsWith('*') && id.startsWith(pattern.slice(0, -1)));
    const senderCwd = SessionBus.normalizeCwd(sender.cwd);
    const targetCwd = SessionBus.normalizeCwd(target.cwd);
    const matchesWorkspace = (rule) => {
      if (rule.includeSubagents !== true && (sender.subagent === true || target.subagent === true)) {
        return false;
      }
      // Both sides need a real workspace: two sessions with no recorded cwd are
      // not "in the same workspace", they are simply unlocated.
      if (senderCwd === undefined || targetCwd === undefined) return false;
      if (senderCwd !== targetCwd) return false;
      if (rule.cwd === undefined) return true;
      return SessionBus.normalizeCwd(rule.cwd) === senderCwd;
    };
    return allowed.some((rule) =>
      rule.sameWorkspace === true
        ? matchesWorkspace(rule)
        : matchesId(rule.from, sender.id) && matchesId(rule.to, target.id),
    );
  }

  /**
   * Decide the effective permission for one sender→target pair.
   *
   * The config allowlist is the baseline and `/bus allow` only ever adds to it, so
   * this is the union of the two sources. There is deliberately no deny rule: a
   * runtime grant cannot subtract from the config, which is why `/bus revoke`
   * reports when the config still permits the pair instead of claiming success.
   *
   * @param sender - roster row of the caller.
   * @param target - roster row of the resolved destination.
   * @returns whether the pair may talk.
   * @see isAllowedByConfig
   */
  isAllowed(sender, target) {
    return (
      this.isAllowedByConfig(sender, target) ||
      this.allowlist.has(sender.id, target.id)
    );
  }

  /**
   * Enforce the permission allowlist for one sender→target pair.
   *
   * @param sender - roster row of the caller.
   * @param target - roster row of the resolved destination.
   * @throws {SessionBusError} `denied` when no allowlist rule covers the pair.
   * @see isAllowed
   */
  assertAllowed(sender, target) {
    if (!this.isAllowed(sender, target)) {
      throw new SessionBusError(
        `session "${sender.id}" is not permitted to message "${target.id}"; add an allow rule to the peer-bus config`,
        'denied',
      );
    }
  }

  /**
   * Enforce the per-pair send-rate ceiling that keeps two agents from looping,
   * and reserve one slot for this send.
   *
   * Expired timestamps are swept across every pair on each call, so a pair that
   * stopped talking does not keep an entry for the life of the process.
   *
   * @param senderSessionId - session id of the caller.
   * @param targetSessionId - resolved destination session id.
   * @returns a release function that refunds the reserved slot when the delivery then fails.
   * @throws {SessionBusError} `rate-limited` when the pair exceeded `maxSendsPerWindow`.
   */
  assertWithinRate(senderSessionId, targetSessionId) {
    const windowMs = this.config.rateWindowMs;
    const key = `${senderSessionId}\u0000${targetSessionId}`;
    const now = Date.now();
    for (const [pair, stamps] of this.recentSends) {
      const live = stamps.filter((at) => now - at < windowMs);
      if (live.length === 0) this.recentSends.delete(pair);
      else if (live.length !== stamps.length) this.recentSends.set(pair, live);
    }
    const kept = this.recentSends.get(key) ?? [];
    if (kept.length >= this.config.maxSendsPerWindow) {
      throw new SessionBusError(
        `session "${senderSessionId}" exceeded ${this.config.maxSendsPerWindow} messages to "${targetSessionId}" within ${windowMs}ms`,
        'rate-limited',
      );
    }
    kept.push(now);
    this.recentSends.set(key, kept);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const stamps = this.recentSends.get(key);
      const at = stamps?.lastIndexOf(now) ?? -1;
      if (at === -1) return;
      stamps.splice(at, 1);
      if (stamps.length === 0) this.recentSends.delete(key);
    };
  }

  /**
   * This process's cross-process endpoint, started on first use.
   *
   * A start failure is reported once and then latched: the local delivery paths
   * still work, so a broken transport must degrade the bus rather than break it —
   * and it must not log on every single call.
   *
   * @returns the endpoint, or undefined when the transport is off or unusable.
   */
  async xproc() {
    if (this.config.crossProcess !== true) return undefined;
    if (this.xprocFailed) return undefined;
    const logger = this.pluginCtx.logger;
    this.xprocStart ??= (async () => {
      const { startEndpoint } = await import('./xproc/index.js');
      const { createRequire } = await import('node:module');
      const { version } = createRequire(import.meta.url)('../package.json');
      return await startEndpoint({
        bus: this,
        config: this.config,
        logger,
        profile: this.pluginCtx.get('profileContext')?.name ?? 'unknown',
        version,
      });
    })();
    try {
      return await this.xprocStart;
    } catch (error) {
      this.xprocFailed = true;
      this.xprocStart = undefined;
      logger?.warn?.(
        `peer-bus cross-process transport did not start, so the bus stays process-local: ${error?.message ?? String(error)}`,
      );
      return undefined;
    }
  }

  /**
   * Deliver a peer's message here, on this process's own terms.
   *
   * The receiving half of a forwarded delivery, and the reason a peer cannot talk
   * its way past our allowlist: permission, archive state, and the rate ceiling
   * are all re-checked against **this** process's config before anything reaches
   * an inbox.
   *
   * The sender's row comes from our own view of persistence when we have it, and
   * only falls back to the peer's claim about itself when the sender's session is
   * not visible here at all. The local view is preferred because it is the one we
   * can actually check.
   *
   * @param payload - the forwarded delivery.
   * @returns the durable message id and how the target was reached.
   * @throws {SessionBusError} `not-here` when this process does not hold the target.
   */
  async deliverRemote(payload) {
    const senderSessionId = payload?.senderSessionId;
    const targetId = payload?.targetId;
    const text = payload?.text;
    if (typeof senderSessionId !== 'string' || typeof targetId !== 'string' || typeof text !== 'string') {
      throw new SessionBusError('a forwarded delivery needs a sender, a target, and text', 'invalid-text');
    }
    // `remote: false`: this is already the receiving side of a peer's request, and
    // a roster that fanned out again would let two peers query each other forever.
    const rows = await this.roster({ remote: false });
    const targetRow = rows.find((row) => row.id === targetId);
    if (targetRow === undefined || targetRow.live !== true) {
      // Released for idleness, moved, or never here. The sender re-resolves once.
      throw new SessionBusError(`session "${targetId}" is not live in this process`, 'not-here');
    }
    const senderRow =
      rows.find((row) => row.id === senderSessionId) ??
      (payload.senderRow === undefined ? { id: senderSessionId } : { ...payload.senderRow, id: senderSessionId });
    this.assertAllowed(senderRow, targetRow);
    if (targetRow.archived === true) {
      throw new SessionBusError(
        `session "${targetId}" is archived; unarchive it before sending it a message`,
        'target-archived',
      );
    }
    // Checked before the rate slot and before delivery: a cycle must cost nothing
    // and must not put a question into an inbox.
    if (payload.askId !== undefined) {
      const closes = this.asks.remoteCycle(senderSessionId, targetId, payload.upstream);
      if (closes !== undefined) {
        throw new SessionBusError(
          `asking "${targetId}" would close a wait cycle through "${closes}", which already waits on the asking session; one side must answer with bus_send instead of bus_ask`,
          'ask-cycle',
        );
      }
    }
    // A retry of a delivery we already took must not deliver twice. The sender cannot
    // know whether its request arrived, so it may resend; only we can tell.
    if (typeof payload.deliveryId === 'string') {
      const already = this.deliveredRemote.get(payload.deliveryId);
      if (already !== undefined) return { messageId: already, targetState: 'duplicate', duplicate: true };
    }

    const release = this.assertWithinRate(senderSessionId, targetId);
    try {
      const message = createBusMessage(senderSessionId, text, {
        askId: payload.askId,
        role: payload.askId === undefined ? 'message' : 'question',
      });
      // Registered before delivery: the claim can beat this continuation, and the
      // proxy is what lets the claim attach a turn to a question asked elsewhere.
      if (payload.askId !== undefined && typeof payload.replyTo === 'string') {
        this.asks.registerProxy({
          askId: payload.askId,
          askerId: senderSessionId,
          targetId,
          replyTo: payload.replyTo,
          upstream: payload.upstream,
        });
      }
      const result = await this.deliverLocal(targetId, message, payload.mode ?? 'followup', {});
      if (typeof payload.deliveryId === 'string') {
        this.deliveredRemote.set(payload.deliveryId, result.messageId);
        if (this.deliveredRemote.size > DELIVERY_MEMORY) {
          this.deliveredRemote.delete(this.deliveredRemote.keys().next().value);
        }
      }
      return { messageId: result.messageId, targetState: result.targetState };
    } catch (error) {
      release();
      throw error;
    }
  }

  /**
   * Whether this process holds a session live.
   *
   * @param sessionId - the session to check.
   * @returns true when an agent for it is registered here.
   */
  /**
   * Give back the cross-process claim on one session.
   *
   * Best-effort and never awaited by its callers: these sit on release paths that must
   * not fail or delay because a claim file could not be removed. A claim that survives
   * anyway is still reclaimable by this process (see `ClaimBook.acquire`) and by any
   * other once this pid is gone.
   *
   * @param sessionId - the session whose claim to release.
   */
  async releaseClaim(sessionId) {
    if (this.config.crossProcess !== true) return;
    const endpoint = await this.xprocStart?.catch(() => undefined);
    await endpoint?.claims?.release(sessionId).catch(() => {});
  }

  /**
   * Drop the cached peer answer.
   *
   * Called whenever a peer says it does not hold something the cache claimed it did:
   * the whole point of the cache is that being wrong is correctable, and correcting it
   * immediately is better than being wrong for the rest of the window.
   */
  invalidateRemoteCache() {
    this.remoteCache = undefined;
    // The advisory map describes the same thing, so leaving it behind would let a
    // diagnostic insist a peer holds a session we have just been told it does not.
    this.lastKnownRemoteOwners = new Map();
  }

  holdsLive(sessionId) {
    if (typeof sessionId !== 'string') return false;
    return this.pluginCtx.agents.get(sessionId) !== undefined;
  }

  /**
   * Deliver to a session this process does not hold, claiming it first.
   *
   * Resuming is not exclusive in the layer below — `agents.resume` does not take the
   * log's write lock — so two processes that both decide to resume a stored session
   * both succeed and both believe they own it. The claim is what makes the decision
   * single-winner among the only processes that can be contending for it.
   *
   * The loser's job is to hand the message to the winner, not to fail: it waits for
   * the winner to actually hold the session, then forwards. Looking immediately would
   * see nothing — a resume is a log read plus a composition — and the loser would
   * resume it too, which is the problem this exists to prevent.
   *
   * @param admitted - the result of {@link authorize}.
   * @param options - optional cancellation.
   * @returns the delivery result.
   */
  async deliverWithClaim(admitted, options = {}) {
    const { targetId, message, mode } = admitted;
    const endpoint = await this.xproc();
    // Nothing to arbitrate: the transport is off, or this process already has it.
    if (endpoint === undefined || this.holdsLive(targetId)) {
      return await this.deliverLocal(targetId, message, mode, options);
    }

    const claim = await endpoint.claims.acquire(targetId);
    if (!claim.acquired) {
      const owner = claim.owner;
      if (owner !== undefined && (await this.waitForClaimOwner(endpoint, owner, targetId))) {
        // The winner holds it now, so it is visible to a fresh roster and the message
        // belongs to that process.
        const { owners } = await this.rosterWithOwners(options);
        const owner = owners.get(targetId);
        if (owner !== undefined) return await this.forwardRemote({ ...admitted, targetOwner: owner }, options);
      }
      // The claim is held by a live process that never took the session. Refuse
      // rather than resume it anyway: a second owner is worse than a retry, and the
      // claim expires with its holder.
      throw new SessionBusError(
        `session "${targetId}" is being resumed by another peer-bus process (endpoint ${owner?.endpointId ?? 'unknown'}), which has not finished; try again shortly`,
        'target-busy',
      );
    }

    try {
      return await this.deliverLocal(targetId, message, mode, options);
    } catch (error) {
      // A claim held by a process that never took the session would block it for
      // good, so a failed resume gives it straight back.
      await endpoint.claims.release(targetId).catch(() => {});
      throw error;
    }
  }

  /**
   * Wait for the claim winner to report that it holds the session.
   *
   * @param endpoint - this process's endpoint.
   * @param owner - the claim's owner.
   * @param targetId - the contended session.
   * @returns whether the owner took it within the budget.
   */
  async waitForClaimOwner(endpoint, owner, targetId) {
    const deadline = Date.now() + CLAIM_WAIT_MS;
    while (Date.now() < deadline) {
      await sleep(CLAIM_POLL_MS);
      const entry = (await endpoint.peers().catch(() => [])).find(
        (peer) => peer.endpointId === owner.endpointId,
      );
      // The winner is gone, so its claim is reclaimable on the next attempt.
      if (entry === undefined) return false;
      try {
        const answer = await endpoint.call(entry, 'holds', { sessionId: targetId }, {
          timeoutMs: this.config.crossProcessTimeoutMs,
        });
        if (answer?.holds === true) return true;
      } catch {
        // A peer that is busy or restarting is not a peer that failed; keep asking.
      }
    }
    return false;
  }

  /**
   * Forward one admitted message to the peer that holds the target.
   *
   * @param admitted - the result of {@link authorize}.
   * @param options - optional cancellation.
   * @param retried - internal: a `not-here` answer is re-resolved only once.
   * @returns the target session id, the durable message id, and `remote`.
   */
  async forwardRemote(
    { targetId, message, mode, text, senderRow, upstream, targetOwner },
    options = {},
    retried = false,
  ) {
    const endpoint = await this.xproc();
    const entry = targetOwner;
    if (endpoint === undefined || entry === undefined) {
      // The owner disappeared between the roster merge and now. The local path
      // will either resume the session or explain why it cannot.
      return await this.deliverLocal(targetId, message, mode, options);
    }
    try {
      // Recorded before the request, not after: if it times out, this mapping is the
      // only way the caller can still ask what happened.
      this.remoteReceipts.set(message.id, entry);
      if (this.remoteReceipts.size > REMOTE_RECEIPT_CAPACITY) {
        this.remoteReceipts.delete(this.remoteReceipts.keys().next().value);
      }
      const result = await endpoint.call(
        entry,
        'deliver',
        {
          // The key the peer de-duplicates on, and the key a retry can be asked about.
          deliveryId: message.id,
          senderSessionId: message.source.senderSessionId,
          senderRow: { id: senderRow.id, cwd: senderRow.cwd, subagent: senderRow.subagent === true },
          targetId,
          text,
          mode,
          ...(message.source.askId === undefined ? {} : { askId: message.source.askId }),
          // Where the answer goes. Only meaningful with an ask id, and the peer
          // ignores it otherwise.
          ...(message.source.askId === undefined ? {} : { replyTo: endpoint.endpointId }),
          // Who transitively waits on the sender, so the peer can see a cycle that
          // spans both processes.
          ...(upstream === undefined ? {} : { upstream }),
        },
        { timeoutMs: this.config.crossProcessDeliverTimeoutMs },
      );
      // Both ids resolve to the peer. The caller is handed the peer's durable id, but
      // a timeout leaves it holding only the delivery id, and either one has to be
      // enough to ask what happened.
      this.remoteReceipts.set(result.messageId, entry);
      if (this.remoteReceipts.size > REMOTE_RECEIPT_CAPACITY) {
        this.remoteReceipts.delete(this.remoteReceipts.keys().next().value);
      }
      return { target: targetId, messageId: result.messageId, targetState: 'remote' };
    } catch (error) {
      // A dead peer is the same situation as a peer that moved on: whatever the cache
      // said, this process has to take the local path. Treated together because the
      // cache makes it reachable — a peer can die inside the cached window.
      if (error?.code === 'peer-gone' && !retried) {
        this.invalidateRemoteCache();
        return await this.forwardRemote(
          { targetId, message, mode, text, senderRow, upstream, targetOwner: undefined },
          options,
          true,
        );
      }
      // A timeout is not a failure. The peer may well have delivered it — the answer
      // simply did not come back — so reporting an error would invite a duplicate send
      // for a message that already arrived. The caller is told the outcome is unknown
      // and given the id to ask about.
      if (error?.code === 'timeout') {
        return {
          target: targetId,
          messageId: message.id,
          targetState: 'unknown',
          note: `the peer did not answer within ${this.config.crossProcessDeliverTimeoutMs}ms; the message may or may not have been delivered — check bus_status(${message.id})`,
        };
      }
      if (error?.code !== 'not-here' || retried) {
        if (error?.code === 'not-here') {
          this.invalidateRemoteCache();
          // Still not there after a fresh look: treat it as a session this process
          // must resume itself.
          return await this.deliverLocal(targetId, message, mode, options);
        }
        // A refusal decided by the peer must reach our callers in our own error
        // vocabulary, not as a bare coded Error.
        throw asBusError(error);
      }
      // Re-resolve once: the session may have been released for idleness, or
      // picked up by a different process.
      const { owners } = await this.rosterWithOwners(options);
      const again = owners.get(targetId);
      if (again === undefined) return await this.deliverLocal(targetId, message, mode, options);
      return await this.forwardRemote(
        { targetId, message, mode, text, senderRow, upstream, targetOwner: again },
        options,
        true,
      );
    }
  }

  /**
   * Sender-side admission for one message.
   *
   * Resolves the target, checks permission and archive state, reserves a rate
   * slot, and builds the message — everything that must happen on the *sending*
   * side and nothing that touches the target's inbox.
   *
   * Split out from {@link send} because a cross-process delivery needs exactly
   * this half locally and exactly {@link deliverLocal} remotely, and because the
   * receiving process has to run its **own** permission, archive, and rate checks
   * rather than trusting a peer's word that they passed.
   *
   * @param sender - exact live calling agent, used as the authorization subject.
   * @param request - raw address, text, optional delivery mode, optional ask id.
   * @param options - optional cancellation.
   * @returns the resolved target, the built message, and the rate slot's release.
   * @throws {SessionBusError} on every rejection; see the individual guards.
   */
  async authorize(sender, request, options = {}) {
    const agents = this.pluginCtx.agents;
    if (agents.get(sender.id) !== sender) {
      throw new SessionBusError('message delivery requires the exact live sender agent', 'unauthorized');
    }
    const text = request.text;
    if (typeof text !== 'string' || text.trim() === '') {
      throw new SessionBusError('message text must be a non-empty string', 'invalid-text');
    }
    const bytes = Buffer.byteLength(text, 'utf8');
    if (bytes > this.config.maxMessageBytes) {
      throw new SessionBusError(
        `message is ${bytes} bytes; the limit is ${this.config.maxMessageBytes}`,
        'message-too-large',
      );
    }
    // One roster pass serves both resolution and the permission check, which
    // needs each side's workspace for the `sameWorkspace` rule.
    const { rows, owners } = await this.rosterWithOwners(options);
    const targetId = this.resolveIn(rows, request.target);
    if (targetId === sender.id) {
      throw new SessionBusError('a session cannot send a bus message to itself', 'self-send');
    }
    const senderRow = rows.find((row) => row.id === sender.id) ?? this.rowOf(sender);
    const targetRow = rows.find((row) => row.id === targetId) ?? { id: targetId };
    // Permission for a target held by *another process* is that process's to decide.
    //
    // The grant semantics are receiver consent, and a receiver grants with `/bus allow`
    // inside its own process — so the grant lives where the decision has to be made, and
    // this process cannot see it. Refusing here would mean a consent the receiver's user
    // really did give never took effect, and would make cross-process messaging work
    // only for pairs that both sides happened to write into config. The receiving
    // process re-runs this same check, and its answer is the one that counts.
    if (targetRow.host === 'remote') {
      this.pluginCtx.logger?.debug?.(
        `peer-bus deferring permission for ${targetId} to the process that holds it`,
      );
    } else {
      this.assertAllowed(senderRow, targetRow);
    }
    // Archiving is the durable "do not wake this session" gate, so it is refused
    // here: after the permission check, so an unauthorized caller learns nothing
    // about a session it may not message, but before the rate slot is reserved
    // and before any cold resume, so an archived target is never loaded or run.
    // A session archived while still live is refused the same way — archiving
    // does not have to unload it for the refusal to hold.
    if (targetRow.archived === true) {
      throw new SessionBusError(
        `session "${targetId}" is archived; unarchive it before sending it a message`,
        'target-archived',
      );
    }
    const release = this.assertWithinRate(sender.id, targetId);
    return {
      targetId,
      text,
      upstream: request.upstream,
      // Passed down the delivery path rather than looked up again later.
      targetOwner: owners.get(targetId),
      senderRow,
      targetRow,
      // `askId` rides on the message so a `bus_ask` can correlate the answer with
      // the question even if the claim beats the sender's continuation. Only the
      // ask registry passes one, so its presence is what makes this a question.
      message: createBusMessage(sender.id, text, {
        askId: request.askId,
        role: request.askId === undefined ? 'message' : 'question',
      }),
      mode: request.mode ?? 'followup',
      release,
    };
  }

  /**
   * Hand an already-built message to one local session, resuming it if needed.
   *
   * The receiving half of a delivery: everything after admission, with no
   * knowledge of who the sender is beyond what the message itself carries. A
   * cross-process `deliver` handler runs this after applying its own admission
   * checks, which is why it takes a message rather than a sender and never
   * touches the sender's rate budget.
   *
   * @param targetId - resolved local session id.
   * @param message - the message to hand over.
   * @param mode - `followup` queues its own turn; `steer` admits at the nearest step.
   * @param options - optional cancellation for a cold resume.
   * @returns the target session id, durable message id, and observed target state.
   */
  async deliverLocal(targetId, message, mode, options = {}) {
    const agents = this.pluginCtx.agents;
    let forgetReceipt;
    try {
      // A target being released for idleness is still registered until its
      // dispose finishes. Routing into it now would hand the message to an agent
      // that is going away, so wait the release out and resume it fresh.
      const releasing = this.releasing.get(targetId);
      if (releasing !== undefined) await releasing;
      let target = agents.get(targetId);
      let targetState = 'live';
      if (target === undefined) {
        await this.coldResume(targetId, options);
        // Re-read liveness instead of trusting the load's result: the resumed
        // agent can be unloaded again before this continuation runs.
        target = agents.get(targetId);
        targetState = 'resumed';
        if (target === undefined) {
          throw new SessionBusError(
            `session "${targetId}" was unloaded before the message could be delivered`,
            'delivery-failed',
          );
        }
      }
      // The receipt must exist before routing: an idle target claims the message
      // synchronously inside `followup()`, and a receipt recorded afterwards would
      // miss its own claim. The sender is read off the message, not passed in, so
      // this half works identically for a forwarded delivery.
      forgetReceipt = this.receipts.record(message, message.source.senderSessionId, targetId);
      try {
        this.route(target, message, mode);
      } catch (error) {
        throw new SessionBusError(
          `could not deliver to session "${targetId}": ${error?.message ?? String(error)}`,
          'delivery-failed',
        );
      }
      this.touch(targetId);
      return { target: targetId, messageId: message.id, targetState };
    } catch (error) {
      // A message that never reached the target must not leave a receipt for a
      // message that does not exist.
      forgetReceipt?.();
      throw error;
    }
  }

  /**
   * Deliver one message from a live sender to any addressable session.
   *
   * Resolves the target, checks permission, refusal, and rate, then routes by
   * target state: a loaded agent is woken in place, and a persisted-but-unloaded
   * session is cold-resumed first. The returned id is the durable message
   * identity recorded in the target's session log.
   *
   * @param sender - exact live calling agent, used as the authorization subject.
   * @param request - raw address, text, and optional delivery mode.
   * @param options - optional cancellation.
   * @returns the target session id, durable message id, and observed target state.
   * @throws {SessionBusError} on every rejection; see the individual guards, and
   *   `target-archived` when the target is in the registry's archive set.
   */
  async send(sender, request, options = {}) {
    const admitted = await this.authorize(sender, request, options);
    const { targetId, message, mode, release } = admitted;
    try {
      // A session another process holds live looks *stored* from here, so it has
      // to be routed by the roster's own answer rather than by local liveness.
      if (admitted.targetOwner !== undefined) {
        return await this.forwardRemote(admitted, options);
      }
      return await this.deliverWithClaim(admitted, options);
    } catch (error) {
      // A message that never reached the target must not spend the pair's budget.
      release();
      throw error;
    }
  }

  /**
   * Recover the model route a session was last using.
   *
   * A resumed agent has no route of its own: without `agentOptions` the loop has
   * no provider/model, and a delivered message produces a turn that never calls a
   * model. The route is not in the session header, so it is read from the log:
   * the newest `request/header` event carries the call configuration
   * (provider, model, reasoning effort) — the same source `dsh-subagent` uses
   * when a child inherits its parent's route. A log with no header falls back to
   * the newest `request/context` route metadata. Other event types are ignored
   * even when their data happens to carry `provider`/`model` fields.
   *
   * @param sessionId - persisted session to inspect.
   * @returns the last recorded route, or undefined when the log has none.
   */
  async lastKnownRoute(sessionId) {
    const query = this.pluginCtx.get('sessionQuery');
    if (query === undefined) return undefined;
    let events;
    try {
      const snapshot = await query.readSession(sessionId);
      events = snapshot?.events ?? snapshot ?? [];
    } catch {
      // An unreadable log is not fatal here: resume will report the real failure.
      return undefined;
    }
    const isRoute = (value) =>
      typeof value?.provider === 'string' &&
      value.provider.length > 0 &&
      typeof value?.model === 'string' &&
      value.model.length > 0;
    let fallback;
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index];
      if (event?.type === 'request/header') {
        const config = event.data?.header?.config;
        if (isRoute(config)) {
          return {
            provider: config.provider,
            model: config.model,
            ...(typeof config.reasoningEffort === 'string'
              ? { reasoningEffort: config.reasoningEffort }
              : {}),
          };
        }
      } else if (fallback === undefined && event?.type === 'request/context' && isRoute(event.data)) {
        fallback = { provider: event.data.provider, model: event.data.model };
      }
    }
    return fallback;
  }

  /**
   * Load a persisted session and start its loop, retaining the handle so this
   * plugin owns the agent's lifecycle for as long as it stays mounted.
   *
   * @param targetId - persisted session id to load.
   * @param options - optional cancellation for the load.
   * @returns the resumed live agent.
   * @throws {SessionBusError} `resume-unavailable` without persistence, `target-busy`
   *   when another owner holds the log, `resume-failed` on any other load failure.
   */
  async coldResume(targetId, options = {}) {
    const inFlight = this.resuming.get(targetId);
    if (inFlight !== undefined) return inFlight;

    if (this.pluginCtx.get('sessionPersistence') === undefined) {
      throw new SessionBusError(
        'cold resume needs a session persistence backend, which is not mounted',
        'resume-unavailable',
      );
    }

    // Build the whole load as one promise and register it BEFORE any await, so a
    // concurrent send to the same cold target shares this resume instead of
    // racing a second load of the same log.
    const load = this.loadPersisted(targetId, options);
    this.resuming.set(targetId, load);
    try {
      return await load;
    } finally {
      // Only in-flight loads are shared. Keeping a settled one would hand a later
      // send an agent that may since have been unloaded, and a rejection must be
      // retried rather than replayed.
      if (this.resuming.get(targetId) === load) this.resuming.delete(targetId);
    }
  }

  /**
   * Release a handle this plugin still holds for a target that is no longer live.
   *
   * `loadPersisted` only runs when `ctx.agents` has no live agent for the id, so
   * any handle still held for it is stale. Disposing it first also closes the
   * persistence handle it may still own, which would otherwise make the new
   * resume fail on its own lock.
   *
   * @param targetId - session id about to be resumed.
   */
  async releaseOwned(targetId) {
    const stale = this.owned.get(targetId);
    if (stale === undefined) return;
    // Giving up the handle gives up the claim with it: whatever takes the session next
    // has to be able to take the claim too.
    void this.releaseClaim(targetId);
    const logger = this.pluginCtx.logger;
    this.owned.delete(targetId);
    this.lastActivity.delete(targetId);
    this.stopIdleSweepIfEmpty();
    try {
      await stale.dispose();
    } catch (error) {
      logger?.warn?.(
        `peer-bus could not release stale handle for ${targetId}: ${error?.message ?? String(error)}`,
      );
    }
  }

  /**
   * Take ownership of a handle this plugin resumed, and start watching it for
   * idleness.
   *
   * @param targetId - the resumed session id.
   * @param handle - the resume handle; disposing it unloads the agent.
   */
  trackOwned(targetId, handle) {
    this.owned.set(targetId, handle);
    this.lastActivity.set(targetId, Date.now());
    this.ensureIdleSweep();
  }

  /**
   * Record activity on an owned agent, so the idle clock restarts.
   *
   * @param sessionId - any session id; ignored unless this plugin owns it.
   */
  touch(sessionId) {
    if (this.lastActivity.has(sessionId)) this.lastActivity.set(sessionId, Date.now());
  }

  /**
   * Start the idle sweep and its activity listener, once, while something is owned.
   *
   * Every event an owned session logs restarts its idle clock, so a session that
   * ran a short turn between two sweeps is not mistaken for one that never woke.
   * The timer is unref'd: it must never keep a process alive on its own.
   * `resumedIdleMs: 0` disables all of it, which keeps resumed agents resident.
   */
  ensureIdleSweep() {
    const idleMs = this.config.resumedIdleMs;
    if (!(idleMs > 0)) return;
    if (this.activityOff === undefined) {
      this.activityOff = this.pluginCtx.on('session/event', (session) => this.touch(session?.id));
    }
    if (this.idleSweep === undefined) {
      const every = Math.min(Math.max(Math.floor(idleMs / 4), 50), 60000);
      this.idleSweep = setInterval(() => {
        void this.sweepIdle();
      }, every);
      this.idleSweep.unref?.();
    }
  }

  /** Stop the sweep and its listener once nothing is owned. */
  stopIdleSweepIfEmpty() {
    if (this.owned.size > 0) return;
    if (this.idleSweep !== undefined) {
      clearInterval(this.idleSweep);
      this.idleSweep = undefined;
    }
    if (this.activityOff !== undefined) {
      this.activityOff();
      this.activityOff = undefined;
    }
  }

  /**
   * Release every owned agent that has been idle for `resumedIdleMs`.
   *
   * Only agents this plugin resumed itself are considered: one resumed through
   * the host's agent lookup is host-owned and never appears here. An agent is
   * kept while it is running, while anything is pending in its inbox, while it
   * asks or is asked something, or while it is being resumed — and any of those
   * restarts its idle clock, so it is released only after a full quiet period.
   *
   * @param now - the current time, injectable for tests.
   * @returns fulfillment once every due release has finished.
   */
  async sweepIdle(now = Date.now()) {
    const idleMs = this.config.resumedIdleMs;
    if (!(idleMs > 0)) return;
    const agents = this.pluginCtx.agents;
    const due = [];
    for (const [id, handle] of this.owned) {
      if (this.releasing.has(id) || this.resuming.has(id)) continue;
      const agent = agents.get(id);
      // Unloaded behind our back (or replaced): the handle is stale, release it.
      if (agent === undefined || agent !== handle.agent) {
        due.push(id);
        continue;
      }
      const busy =
        agent.status !== 'idle' || agent.inbox?.hasPending === true || this.asks.involves(id);
      if (busy) {
        this.lastActivity.set(id, now);
        continue;
      }
      if (now - (this.lastActivity.get(id) ?? now) >= idleMs) due.push(id);
    }
    await Promise.all(due.map((id) => this.releaseIdle(id)));
  }

  /**
   * Unload one owned agent, releasing its log lock so another process can open it.
   *
   * The ownership entry is dropped synchronously, and the in-progress release is
   * published in `releasing` before the dispose can yield, so a send that races it
   * waits and then resumes the session again instead of routing into an agent
   * that is going away.
   *
   * @param id - the owned session id.
   * @returns fulfillment once the agent is disposed.
   */
  releaseIdle(id) {
    const handle = this.owned.get(id);
    const logger = this.pluginCtx.logger;
    if (handle !== undefined) {
      this.owned.delete(id);
      this.lastActivity.delete(id);
    }
    const done = (async () => {
      try {
        if (handle !== undefined) {
          await handle.dispose();
          logger?.info?.(`peer-bus released idle resumed session ${id}`);
        }
      } catch (error) {
        logger?.warn?.(
          `peer-bus could not release idle session ${id}: ${error?.message ?? String(error)}`,
        );
      } finally {
        // Released as part of this promise rather than alongside it. Another process
        // that sees this pid in the claim file does not retry — it refuses — so a claim
        // still on disk when this resolves is a session nobody can take.
        //
        // Unconditional, and reached even when the handle was already gone: a claim left
        // behind by an earlier release path blocks the session for every process,
        // *including this one*, whose own acquire would see a live pid and refuse.
        await this.releaseClaim(id);
        this.releasing.delete(id);
        this.stopIdleSweepIfEmpty();
      }
    })();
    // Published before the promise can yield, so a send racing this release waits for it
    // and then resumes the session again, instead of routing into an agent going away.
    this.releasing.set(id, done);
    return done;
  }

  /**
   * Restore one persisted session's route and resume it, retaining the handle.
   *
   * @param targetId - persisted session id to load.
   * @param options - optional cancellation for the load.
   * Precedence: the host's Typert `agent` lookup when it can actually resume,
   * then the manual path — restore the recorded route and mount the recorded
   * preset. The host path leaves the lifecycle host-owned; the manual path keeps
   * the handle so this plugin can release it.
   *
   * @returns the resumed live agent.
   * @throws {SessionBusError} `target-busy` or `resume-failed` when the load rejects.
   */
  async loadPersisted(targetId, options) {
    const agents = this.pluginCtx.agents;
    const logger = this.pluginCtx.logger;
    await this.releaseOwned(targetId);

    // Prefer the host's own resume path when one is composed. It composes the
    // agent exactly as opening the session in the GUI does — model selection
    // installed, preset mounted, sub-agent ownership checked — and, crucially, it
    // keeps the resulting lifecycle host-owned instead of handing this plugin a
    // handle it has to release.
    const lookup = this.hostAgentLookup();
    if (lookup !== undefined) {
      try {
        const agent = await lookup.resolve(targetId);
        if (agent !== undefined) {
          logger?.info?.(`peer-bus resumed ${targetId} through the host agent lookup`);
          return agent;
        }
      } catch (error) {
        if (remoteErrorCode(error) === 'session/writer-held') {
          throw new SessionBusError(await this.busyMessage(targetId), 'target-busy');
        }
        // Anything else falls through to the manual resume. The reason is logged
        // rather than swallowed: a silent fallback would hide a real difference
        // between the two compositions.
        logger?.debug?.(
          `peer-bus host agent lookup could not resume ${targetId} (${remoteErrorCode(error) ?? error?.message}); using the manual path`,
        );
      }
    }

    // Restore the route the session was last using, or the wake-up turn is empty.
    const route = await this.lastKnownRoute(targetId);
    try {
      const handle = await agents.resume({
        resumeSessionId: targetId,
        signal: options.signal,
        ...(route === undefined ? {} : { agentOptions: route }),
        setup: (agentCtx, agent) => this.mountRecordedPreset(agentCtx, agent),
      });
      this.trackOwned(targetId, handle);
      logger?.info?.(
        `peer-bus resumed ${targetId}${route === undefined ? '' : ` on ${route.provider}/${route.model}`}`,
      );
      return handle.agent;
    } catch (error) {
      if (isOwnedElsewhere(error)) {
        throw new SessionBusError(await this.busyMessage(targetId), 'target-busy');
      }
      throw new SessionBusError(
        `could not resume session "${targetId}": ${error?.message ?? String(error)}`,
        'resume-failed',
      );
    }
  }

  /**
   * Send a proxied question's answer back to the process that asked it.
   *
   * The asking process is the only one that can settle the caller's wait, so the
   * answer travels as a frame rather than as a message. If that process is gone,
   * the answer is delivered into the asker's session log here instead: the
   * question was asked in good faith, and dropping the answer because the asker
   * restarted would be the worst of both outcomes.
   *
   * @param answer - the ask id, both session ids, the reply endpoint, and the text.
   */
  async pushRemoteAnswer({ askId, askerId, targetId, replyTo, text, turn }) {
    const endpoint = await this.xproc();
    if (endpoint !== undefined && typeof replyTo === 'string') {
      const entry = (await endpoint.peers().catch(() => [])).find((peer) => peer.endpointId === replyTo);
      if (entry !== undefined) {
        try {
          await endpoint.call(entry, 'ask.answer', { askId, text, turn }, { timeoutMs: this.config.crossProcessTimeoutMs });
          return;
        } catch (error) {
          this.pluginCtx.logger?.debug?.(
            `peer-bus could not push an answer to ${replyTo}: ${error?.message ?? String(error)}`,
          );
        }
      }
    }
    // Nobody is waiting for it any more: leave it where the asker will find it.
    await this.deliverLocal(askerId, createBusMessage(targetId, text, { askId, role: 'answer' }), 'followup', {});
  }

  /**
   * The receipt for one message, wherever it was delivered.
   *
   * A forwarded message's receipt lives in the process that actually put it in an
   * inbox, so the query has to travel. The peer re-checks that the caller is the
   * recorded sender, which is what stops one session reading another's receipts
   * through a peer that happens to be reachable.
   *
   * @param messageId - the id `bus_send` returned.
   * @param callerId - the session asking.
   * @returns the receipt view, or `unknown` with a reason.
   */
  async status(messageId, callerId) {
    const entry = this.remoteReceipts.get(messageId);
    if (entry === undefined) return this.receipts.statusFor(messageId, callerId);
    const endpoint = await this.xproc();
    if (endpoint === undefined) {
      return {
        messageId,
        status: 'unknown',
        reason: 'this process can no longer reach the process that delivered it',
      };
    }
    try {
      return await endpoint.call(
        entry,
        'status',
        // The caller may hold a delivery id rather than the peer's message id.
        { messageId, deliveryId: messageId, callerId },
        { timeoutMs: this.config.crossProcessTimeoutMs },
      );
    } catch (error) {
      if (error?.code === 'peer-gone') {
        // Definitive: forget the mapping so a later query does not keep dialing a
        // process that has gone. A timeout is not definitive and keeps its entry.
        this.remoteReceipts.delete(messageId);
        return {
          messageId,
          status: 'unknown',
          reason: 'the process that delivered it is no longer running',
        };
      }
      throw asBusError(error);
    }
  }

  /**
   * Tell the process holding a target that this question no longer needs an answer.
   *
   * Best-effort by design: the peer's proxy has its own ceiling, so a cancel that
   * cannot be delivered costs a little memory on the far side rather than
   * correctness here.
   *
   * @param request - the ask id and the session it targeted.
   */
  async cancelRemoteAsk({ askId, targetId }) {
    const endpoint = await this.xproc();
    // Advisory: this runs long after the roster pass that discovered the owner (a
    // timeout, or unload), so the map may be empty or stale. A cancel that cannot be
    // delivered costs the peer nothing — its proxy has its own ceiling.
    const entry = this.lastKnownRemoteOwners.get(targetId);
    if (endpoint === undefined || entry === undefined) return;
    try {
      await endpoint.call(entry, 'ask.cancel', { askId }, { timeoutMs: this.config.crossProcessTimeoutMs });
    } catch (error) {
      this.pluginCtx.logger?.debug?.(
        `peer-bus could not cancel ask ${askId} on ${entry.endpointId}: ${error?.message ?? String(error)}`,
      );
    }
  }

  /**
   * Settle a local ask from a peer's pushed answer.
   *
   * @param payload - `{askId, text, turn?}`.
   * @returns whether an ask was still waiting on it.
   */
  receiveRemoteAnswer(payload) {
    return this.asks.receiveRemoteAnswer(payload);
  }

  /**
   * Resolve a receipt that the sender may only know by delivery id.
   *
   * A timed-out forward leaves the sender holding its own id and nothing else, so that
   * is the key it can ask with.
   *
   * @param payload - `{messageId, deliveryId, callerId}`.
   * @returns the receipt view.
   */
  resolveReceipt({ messageId, deliveryId, callerId }) {
    const known = typeof deliveryId === 'string' ? this.deliveredRemote.get(deliveryId) : undefined;
    return this.receipts.statusFor(known ?? messageId, callerId);
  }

  /**
   * Release a proxy ask at the asking process's request.
   *
   * @param payload - `{askId}`.
   * @returns whether a proxy was released.
   */
  cancelRemoteAskOnArrival(payload) {
    return this.asks.cancelProxy(payload?.askId);
  }

  /**
   * Explain a session whose log another process holds.
   *
   * With the transport off this is the whole story: the lock is the end of the
   * road. With it on, reaching this point means every peer we can see was asked
   * and none of them claimed the session — so the useful thing to say is *why*
   * forwarding could not help, rather than repeating that it cannot.
   *
   * @param targetId - the locked session.
   * @returns the message for a `target-busy` refusal.
   */
  async busyMessage(targetId) {
    const base = `session "${targetId}" is open in another DSH process (its log is locked there); it can only be messaged from that process`;
    if (this.config.crossProcess !== true) return base;
    // A peer does claim it: forwarding is the answer, and this refusal came from
    // somewhere else entirely, so do not blame the transport.
    if (this.lastKnownRemoteOwners.get(targetId) !== undefined) return base;
    const endpoint = await this.xproc();
    const why =
      endpoint === undefined
        ? 'this process could not start the cross-process transport'
        : 'the process holding it is not running peer-bus, or has crossProcess disabled';
    return `${base} — and no reachable peer-bus endpoint claims it, so it cannot be forwarded either (${why})`;
  }

  /**
   * Read the agent preset a stored session was composed with.
   *
   * The preset registry's own `agentPreset` projection is authoritative, matching
   * what DSH's session controller reads on resume. The durable session header is
   * the fallback for a composition whose registry is absent, since
   * `CreateAgentOptions.meta.agentPreset` writes the resolved id there too.
   *
   * @param session - the reconstructed, not-yet-published session.
   * @returns the recorded preset id, or undefined for a preset-free composition.
   */
  recordedPreset(session) {
    const projections = this.pluginCtx.get('sessionProjections');
    if (projections !== undefined) {
      try {
        const projected = projections.stateOf(session, 'agentPreset');
        if (typeof projected === 'string') return projected;
      } catch {
        // The projection is not registered in this composition; fall through.
      }
    }
    const header = session.header?.agentPreset;
    return typeof header === 'string' ? header : undefined;
  }

  /**
   * Mount the agent preset a resumed session was composed with.
   *
   * A preset is not decoration: in a preset-backed profile it supplies the
   * persona, the agent-instructions loader, and some tools. DSH's own resume path
   * installs the model selection **and** mounts the preset, so a resumed agent
   * without its preset runs on the wrong system prompt and a reduced toolset —
   * silently, because the turn still completes.
   *
   * This must run from the `setup` callback, which is the only point where the
   * agent is unpublished and `mount` accepts its scoped context.
   *
   * @param agentCtx - the unpublished agent's scoped context.
   * @param agent - the unpublished agent being resumed.
   */
  async mountRecordedPreset(agentCtx, agent) {
    const presets = this.pluginCtx.get('agentPresets');
    if (presets === undefined) return; // Preset-free composition: nothing to restore.
    const presetId = this.recordedPreset(agent.session);
    // An undefined id resolves to the registry default, which is what DSH itself
    // does for a session that recorded no preset.
    await presets.mount(agentCtx, presetId);
  }

  /**
   * Hand one message to a live agent's driver.
   *
   * @param agent - exact live target agent.
   * @param message - identified message to deliver.
   * @param mode - `followup` queues its own turn; `steer` admits at the nearest step.
   */
  route(agent, message, mode) {
    if (mode === 'steer') agent.steer(message);
    else agent.followup(message);
  }

  /**
   * Release every cold-resumed agent this plugin owns, and the allowlist domain.
   *
   * @returns fulfillment once all owned handles and the domain are disposed.
   */
  async dispose() {
    const handles = [...this.owned.values()];
    const releases = [...this.releasing.values()];
    this.owned.clear();
    this.lastActivity.clear();
    this.stopIdleSweepIfEmpty();
    this.resuming.clear();
    this.recentSends.clear();
    this.asks.dispose();
    // Unlink the socket and withdraw the registry entry: a peer must not keep
    // dialing a process that is going away.
    const endpoint = await this.xprocStart?.catch(() => undefined);
    // Claims first: a claim left behind by a clean shutdown would have a live pid in it
    // for as long as that pid is reused, and the next contender would wait on a process
    // that has nothing to do with the session.
    await endpoint?.claims?.releaseAll?.().catch(() => {});
    await endpoint?.stop?.().catch(() => {});
    this.receipts.dispose();
    await Promise.allSettled([
      ...handles.map((handle) => handle.dispose()),
      ...releases,
      this.allowlist.close(),
    ]);
  }
}

// No default export: this module is also reachable as a plugin subpath, and the
// Cordis loader prefers `exports.default`, which would drop the named metadata.
export {
  BUS_SOURCE_KIND,
  SessionBus,
  SessionBusError,
  createBusMessage,
  isBusSource,
  isOwnedElsewhere,
  isSubagentHeader,
};
