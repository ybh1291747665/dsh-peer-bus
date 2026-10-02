/**
 * Shared fakes for the bus unit tests.
 *
 * A real Cordis {@link Context} carrying fake `agents`, `sessionPersistence`,
 * `sessionQuery`, and (optionally) `workspaceRegistry` services, so addressing,
 * permission, rate, routing, and archive decisions are pinned without booting a
 * real harness or spending model calls.
 */
import { Context } from '@deepseek-ai/cordis';
import { SessionBus } from '../src/peer-bus.js';

/**
 * Default policy used by most tests.
 *
 * Every key the real `Config` schema defaults must be present: `SessionBus` is
 * constructed directly here, so a missing timeout would be `undefined` rather
 * than the schema's default — and `setTimeout(fn, NaN)` fires immediately, which
 * reads as "the ask timed out" instead of "the fixture is incomplete".
 */
const baseConfig = (overrides = {}) => ({
  allow: [],
  maxMessageBytes: 16384,
  maxSendsPerWindow: 10,
  rateWindowMs: 60000,
  waitTimeoutMs: 60000,
  maxWaitMs: 600000,
  askBusyTimeoutMs: 30000,
  resumedIdleMs: 600000,
  // These mirror the schema's defaults on purpose. An omitted key here does not
  // read as "unset" downstream: `undefined` reaches `setTimeout`, which fires
  // immediately, so a transport timeout would race every response and fail about
  // one run in four.
  crossProcess: false,
  crossProcessTimeoutMs: 2000,
  crossProcessDeliverTimeoutMs: 60000,
  crossProcessRosterCacheMs: 3000,
  ...overrides,
});

/**
 * Build a fake agent whose delivery calls are recorded.
 *
 * @param id - session id this agent answers to.
 * @param status - lifecycle status the bus observes.
 * @param cwd - workspace the session reports; pass `null` for a session with no
 *   recorded workspace. (Passing `undefined` would just trigger this default,
 *   which is the trap this parameter exists to avoid.)
 * @param header - extra session header fields, e.g. subagent lineage.
 * @returns the fake agent plus its recorded deliveries.
 */
function fakeAgent(id, status = 'idle', cwd = '/tmp/ws', header = {}) {
  const workspace = cwd === null ? undefined : cwd;
  const delivered = [];
  return {
    id,
    status,
    session: {
      // A real Session carries its own id as well as the header; the ask registry
      // matches session events by it, so a fixture without one silently matches
      // nothing.
      id,
      header: workspace === undefined ? { id, ...header } : { id, cwd: workspace, ...header },
    },
    followup(message) {
      delivered.push({ mode: 'followup', message });
    },
    steer(message) {
      delivered.push({ mode: 'steer', message });
    },
    delivered,
  };
}

/**
 * Build a real Cordis context carrying fake bus dependencies.
 *
 * @param options - live agents, persisted headers, and failure switches.
 * @returns the context plus captured resume and disposal state.
 */
function fakeCtx({
  liveAgents = [],
  stored = [],
  resumeFails = false,
  resumeError,
  noPersistence = false,
  storedEvents = {},
  noQuery = false,
  readSessionImpl,
  archived,
  registryThrows = false,
  storageDomain,
  hostLookup,
  titles,
} = {}) {
  const ctx = new Context();
  const agents = new Map(liveAgents.map((agent) => [agent.id, agent]));
  const resumedIds = [];
  const resumeOptions = [];
  const state = { disposed: 0 };

  ctx.provide('agents', {
    list: () => [...agents.values()],
    get: (id) => agents.get(id),
    resume(options) {
      const { resumeSessionId } = options;
      resumedIds.push(resumeSessionId);
      resumeOptions.push(options);
      // Deliberately synchronous: the bus attaches its ownership continuation to
      // this promise, and a resolved promise runs that continuation before
      // send() returns, which keeps the disposal assertion deterministic.
      if (resumeError !== undefined) return Promise.reject(resumeError);
      if (resumeFails) return Promise.reject(new Error('log unreadable'));
      // A real resume rebuilds the session from its stored header, so the agent
      // must carry that header — `agentPreset` in particular, which the bus reads
      // to restore the preset.
      const storedHeader = stored.find((entry) => entry.id === resumeSessionId);
      const agent = fakeAgent(
        resumeSessionId,
        'idle',
        storedHeader?.cwd ?? '/tmp/ws',
        storedHeader ?? {},
      );
      // The real factory awaits `setup` on the unpublished agent before it
      // publishes, so a throwing mount has to fail the resume here too.
      try {
        const pendingSetup = options.setup?.('agent-ctx-from-setup', agent);
        if (pendingSetup instanceof Promise) return pendingSetup.then(() => publish());
      } catch (error) {
        return Promise.reject(error);
      }
      return publish();

      /** Publish the resumed agent and its single-shot disposer after setup. */
      function publish() {
        agents.set(resumeSessionId, agent);
        let disposed = false;
        return Promise.resolve({
          agent,
          // Single-shot like the real Cordis effect disposer.
          dispose: async () => {
            if (disposed) return;
            disposed = true;
            state.disposed += 1;
            if (agents.get(resumeSessionId) === agent) agents.delete(resumeSessionId);
          },
        });
      }
    },
  });

  if (!noPersistence) {
    ctx.provide('sessionPersistence', {
      list: async () => stored.map((header) => ({ header })),
    });
  }

  if (!noQuery) {
    ctx.provide('sessionQuery', {
      readSession:
        readSessionImpl ??
        (async (sessionId) => ({ events: storedEvents[sessionId] ?? [] })),
    });
  }

  // `workspaceRegistry` is optional: only the web bundle mounts one, so leaving
  // `archived` undefined is the headless case, not an incomplete fixture.
  // A storage domain is optional too: without one the runtime allowlist is
  // memory-only, which is the headless case rather than an incomplete fixture.
  if (storageDomain !== undefined) ctx.provide('storageDomain', storageDomain);

  // Titles come from the session's own log, so the fixture takes a lookup table.
  if (titles !== undefined) {
    ctx.provide('sessionTitle', {
      get: (session) => {
        const title = titles.get(session?.id);
        return title === undefined ? undefined : { title };
      },
    });
  }

  // The Typert registry is optional too. `dsh-agent` registers the `agent` lookup
  // provider on every profile, but only a session controller configures the
  // resolver that can actually resume — so the fixture takes the lookup itself.
  if (hostLookup !== undefined) {
    ctx.provide('typert', { lookups: { get: (key) => (key === 'agent' ? hostLookup : undefined) } });
  }

  if (archived !== undefined) {
    ctx.provide('workspaceRegistry', {
      /** A real registry exposes a plain array, and throws before it has started. */
      get archivedSessionIds() {
        if (registryThrows) throw new Error('workspace registry is not started yet');
        return archived;
      },
    });
  }

  return {
    ctx,
    state,
    resumedIds,
    resumeOptions,
    /** Drop a live agent from the registry without going through the bus's handle. */
    unload: (id) => agents.delete(id),
    /** Publish an agent the way a real resume does, for paths that resume out of band. */
    install: (agent) => agents.set(agent.id, agent),
  };
}

/**
 * Construct a bus in its own isolated service scope.
 *
 * Cordis allows one provider per service name per scope, so a test that needs
 * two differently-configured buses (denied versus allowed) must isolate them.
 *
 * @param ctx - context carrying the fake dependencies.
 * @param config - validated bus policy.
 * @returns a bus instance registered in a fresh scope.
 */
function makeBus(ctx, config) {
  return new SessionBus(ctx.isolate('peerBus'), config);
}

export { baseConfig, fakeAgent, fakeCtx, fakeStorageDomain, makeBus };

/**
 * A storage-domain facility backed by one in-memory global.
 *
 * Every `open` shares the same state object, so a second bus over the same
 * facility reads what the first one wrote — which is how a restart is simulated
 * without a backend. `slowOpenMs` and `failOpen` model the two ways opening can
 * go wrong or simply take time.
 *
 * @param initial - the global value the domain starts from.
 * @param options - `slowOpenMs` delays `open`; `failOpen` makes it reject.
 * @returns the facility plus the state it persists into.
 */
function fakeStorageDomain(initial = { grants: [] }, { slowOpenMs = 0, failOpen = false } = {}) {
  const state = { ...initial };
  const opens = [];
  return {
    state,
    opens,
    async open(spec) {
      opens.push(spec);
      if (slowOpenMs > 0) await new Promise((resolve) => setTimeout(resolve, slowOpenMs));
      if (failOpen) throw new Error('no kv backend is routed for this domain');
      return {
        global: {
          get: () => state,
          set: async (value) => {
            Object.assign(state, value);
          },
        },
        close: async () => {},
      };
    },
  };
}
