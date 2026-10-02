/**
 * Model-facing bus tools and plugin registration.
 *
 * Tool names are `bus_*` deliberately: `send_message` is already claimed
 * globally by `@deepseek-ai/dsh-tool-subagent-control` for adjacent-agent
 * traffic, and a same-name registration would shadow it.
 *
 * @module dsh-peer-bus
 */
import z from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { registerBusCommands } from './commands.js';
import { FRAMING_BLOCK } from './message.js';
import { BUS_SOURCE_KIND, SessionBus, SessionBusError, isBusSource } from './peer-bus.js';

/** Cordis plugin name. */
const name = 'peer-bus';

/**
 * Services the bus requires. Cordis refuses a read of an undeclared service, and
 * a declared-but-absent service blocks the whole plugin from activating.
 *
 * `sessionPersistence` is deliberately NOT listed: the bus reads it lazily via
 * `ctx.get('sessionPersistence')` because cold resume is an optional capability.
 * A profile without a persistence backend still gets a working bus for live
 * sessions; only waking a stored session reports `resume-unavailable`.
 */
const inject = ['agents', 'tools'];

/**
 * An id rule: `from`/`to` patterns matched against session ids.
 *
 * A pattern matches exactly, as a trailing-`*` prefix, or as `'*'` for any.
 * Patterns are not globs — `*` is only meaningful at the end.
 */
const IdRule = z.object({
  from: z.string().required(),
  to: z.string().required(),
});

/**
 * A workspace rule: the pair may talk when both sessions share a workspace.
 *
 * This exists because a session id is a fresh UUID, so an id rule cannot be
 * written before the session exists. It is also narrower than `'*'`: a session
 * in an unrelated project does not match. Set `cwd` to narrow it to one
 * workspace.
 */
const WorkspaceRule = z.object({
  // `.required()` matters: without it the union would accept any object, since
  // every field here would be optional and this shape would match everything.
  sameWorkspace: z.const(true).required(),
  cwd: z.string(),
  /**
   * Also match subagent children. Off by default: a child inherits its parent's
   * `cwd`, so a workspace rule would otherwise let any subagent — including one
   * reading untrusted input — instruct every root session in the project.
   */
  includeSubagents: z.boolean().default(false),
});

/** Validated bus policy. */
const Config = z.object({
  /**
   * Permission allowlist. Default deny: an empty list permits no pair.
   *
   * Two rule shapes:
   *
   * ```yaml
   * allow:
   *   # name an exact pair, or a family with a trailing-* prefix
   *   - from: 'session-abc'
   *     to: 'session-worker-*'
   *   # let any two sessions that share a workspace talk (subagents excluded)
   *   - sameWorkspace: true
   *   # ...or only within one workspace
   *   - sameWorkspace: true
   *     cwd: '/path/to/project'
   *   # ...and let subagent children in on it too
   *   - sameWorkspace: true
   *     includeSubagents: true
   * ```
   */
  allow: z.array(z.union([IdRule, WorkspaceRule])).default([]),
  /** Maximum UTF-8 bytes accepted in one message body. */
  maxMessageBytes: z.natural().default(16384),
  /** Send ceiling per sender→target pair inside one window. */
  maxSendsPerWindow: z.natural().default(10),
  /** Length of the rate-limit window in milliseconds. */
  rateWindowMs: z.natural().default(60000),
  /**
   * What `bus_roster` shows a caller. `allowed` (default) lists the caller itself
   * plus the sessions it may message; `all` lists every session the process can
   * see, including other projects' ids and paths, each flagged `allowed`.
   */
  rosterScope: z.union(['allowed', 'all']).default('allowed'),
  /** `bus_wait` timeout when the caller does not pass `timeoutMs`. */
  waitTimeoutMs: z.natural().default(60000),
  /** Upper bound on any `bus_wait` timeout, so one call cannot hold a turn open indefinitely. */
  maxWaitMs: z.natural().default(600000),
  /**
   * How long `bus_ask` waits when the target was **already running** when asked.
   *
   * A busy target cannot begin the question's turn until it finishes what it is
   * doing, so waiting the full `waitTimeoutMs` mostly means waiting for unrelated
   * work. Past this bound the ask becomes `pending` and the answer arrives later
   * as a bus message, which keeps the caller's turn short.
   */
  askBusyTimeoutMs: z.natural().default(30000),
  /**
   * Release a session this plugin cold-resumed once it has been idle this long.
   *
   * Applies only to sessions the bus resumed itself (the fallback path, e.g. on a
   * headless profile); one resumed through the host's own agent lookup is
   * host-owned. Releasing unloads the agent and frees its log lock, so another
   * process can open it again; the next message simply resumes it. `0` keeps
   * resumed sessions loaded for the life of the plugin.
   */
  resumedIdleMs: z.natural().default(600000),
  /**
   * Reach sessions held live by **another DSH process**, over a local socket.
   *
   * Off by default, and that is a security position rather than a maturity one:
   * enabling it widens the trust boundary from "this process" to "every DSH
   * process of this OS user over this `DSH_HOME`", so it has to be a deliberate
   * act. While it is off the bus behaves exactly as it did before the transport
   * existed — the cross-process modules are not even loaded.
   */
  crossProcess: z.boolean().default(false),
  /**
   * Timeout for one remote control-plane query: a roster merge, a `bus_status`
   * lookup, an ask cancellation.
   *
   * Deliberately short. A peer that is wedged, mid-restart, or simply gone must
   * degrade to "that session looks stored" rather than stall a caller's turn.
   */
  crossProcessTimeoutMs: z.natural().default(2000),
  /**
   * Timeout for one forwarded delivery.
   *
   * Much longer than a control-plane query because the far side may have to
   * cold-resume the target before it can hand the message over, which is a log
   * read plus a composition — the same work a local cold resume does.
   */
  crossProcessDeliverTimeoutMs: z.natural().default(60000),
  /**
   * How long this process may reuse the last answer to "which peer holds what".
   *
   * Every roster rebuild asks every peer what it holds, so without this a burst of
   * sends costs a query per send per peer. A stale answer is safe rather than merely
   * cheap: the peer that no longer holds the session says so, and the sender
   * re-resolves and takes the local path. `0` asks every time.
   */
  crossProcessRosterCacheMs: z.natural().default(3000),
});

/** Largest delay `setTimeout` honours; anything above it fires immediately. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/** Shared text renderer: one line per row. */
const renderLines = (lines) => [{ type: 'text', text: lines.join('\n') }];

/**
 * Register the bus service, its six model-facing `bus_*` tools, and the human-facing
 * `/bus` command.
 *
 * @param ctx - plugin context carrying `agents` and `tools`.
 * @param config - validated bus policy.
 */
function apply(ctx, config) {
  const bus = new SessionBus(ctx, config);
  ctx.effect(() => () => bus.dispose());
  // The allowlist editor is human-only on purpose: no model tool is registered for
  // it, so an agent cannot widen its own permissions.
  registerBusCommands(ctx, bus);

  ctx.tools.register(
    defineTool({
      name: 'bus_roster',
      description:
        'List the sessions this session can reach over the bus: your own row (marked "you") plus every session the allowlist lets you message, with each id, its title when it has one, whether it is currently loaded, and its workspace. Use it before bus_send to find the exact session id you want to reach; a unique title also works as a target, but ids are canonical. Archived sessions are never listed.',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            sessions: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  id: { type: 'string', required: true },
                  live: { type: 'boolean', required: true },
                  status: { type: 'string' },
                  title: { type: 'string' },
                  cwd: { type: 'string' },
                  subagent: { type: 'boolean' },
                  self: { type: 'boolean' },
                  allowed: { type: 'boolean' },
                },
              },
            },
          },
        },
        render: (_args, value) =>
          renderLines(
            value.sessions.length === 0
              ? ['No sessions are reachable.']
              : value.sessions.map((row) => {
                  const flags = [
                    row.self ? 'you' : undefined,
                    row.subagent ? 'subagent' : undefined,
                    !row.self && row.allowed === false ? 'not-allowed' : undefined,
                  ].filter(Boolean);
                  return `${row.id}\t${row.title ?? '-'}\t${row.live ? `live/${row.status ?? '?'}` : 'stored'}\t${row.cwd ?? '-'}${flags.length === 0 ? '' : `\t[${flags.join(', ')}]`}`;
                }),
          ),
      },
      async execute(_args, exec) {
        if (exec.agent === undefined) {
          throw new Error('bus_roster requires a calling agent session');
        }
        const rows = await bus.visibleRoster(exec.agent, { signal: exec.signal });
        const sessions = rows.map((row) => ({
          id: row.id,
          live: row.live,
          ...(row.status === undefined ? {} : { status: row.status }),
          ...(typeof row.title === 'string' ? { title: row.title } : {}),
          ...(typeof row.cwd === 'string' ? { cwd: row.cwd } : {}),
          subagent: row.subagent === true,
          self: row.self === true,
          allowed: row.allowed === true,
        }));
        return { sessions };
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'bus_send',
      description:
        'Send a message to another session by id. The target session is woken and runs a turn with your message; a stored session that is not loaded is resumed first. Delivery is denied unless the peer-bus config allowlist permits this sender→target pair, and an archived target is refused without being woken.',
      parameters: {
        target: {
          type: 'string',
          required: true,
          description:
            'Target session id, an unambiguous id prefix, or a title unique among the sessions you can reach (bus_roster shows titles).',
        },
        text: {
          type: 'string',
          required: true,
          description: 'Message body delivered to the target session.',
        },
        mode: {
          type: 'string',
          enum: ['followup', 'steer'],
          description:
            'followup (default) queues the message as its own turn; steer admits it at the target\'s nearest step boundary.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            target: { type: 'string', required: true },
            messageId: { type: 'string', required: true },
            targetState: { type: 'string', required: true },
            note: { type: 'string' },
          },
        },
        render: (_args, value) =>
          renderLines([
            value.note === undefined
              ? `Delivered ${value.messageId} to ${value.target} (${value.targetState})`
              : `${value.messageId} to ${value.target}: ${value.targetState} — ${value.note}`,
          ]),
      },
      async execute(args, exec) {
        if (exec.agent === undefined) {
          throw new Error('bus_send requires a calling agent session');
        }
        try {
          return await bus.send(
            exec.agent,
            { target: args.target, text: args.text, mode: args.mode },
            { signal: exec.signal },
          );
        } catch (error) {
          if (error instanceof SessionBusError) {
            throw new Error(`bus_send rejected (${error.code}): ${error.message}`);
          }
          throw error;
        }
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'bus_ask',
      description:
        'Ask another session a question and get its answer back in this result, instead of sending and then waiting. The question wakes the target exactly like bus_send and is subject to the same allowlist. Returns status "answered" with the text of the turn that answered; status "pending" with an askId when the target was busy and did not answer in time, in which case the answer arrives later as a bus message and bus_wait with that askId takes it; or status "discarded" if the question was thrown away before it ran. Refused as ask-cycle if the target is already waiting on an answer from this session, because both sides would deadlock.',
      parameters: {
        target: {
          type: 'string',
          required: true,
          description:
            'Target session id, an unambiguous id prefix, or a title unique among the sessions you can reach (bus_roster shows titles).',
        },
        text: {
          type: 'string',
          required: true,
          description: 'The question delivered to the target session.',
        },
        timeoutMs: {
          type: 'integer',
          description:
            'Give up after this many milliseconds and report status "pending". Defaults to waitTimeoutMs, or to the shorter askBusyTimeoutMs when the target was already running; capped at maxWaitMs.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            status: { type: 'string', required: true },
            askId: { type: 'string', required: true },
            from: { type: 'string' },
            text: { type: 'string' },
            turn: { type: 'integer' },
          },
        },
        render: (_args, value) =>
          renderLines(
            value.status === 'answered'
              ? [`Answer from ${value.from}: ${value.text ?? ''}`]
              : value.status === 'pending'
                ? [
                    `No answer from ${value.from} yet. Ask ${value.askId} is still open; the answer will arrive as a bus message, and bus_wait with askId "${value.askId}" takes it.`,
                  ]
                : [`${value.from} discarded the question before answering it.`],
          ),
      },
      async execute(args, exec) {
        if (exec.agent === undefined) {
          throw new Error('bus_ask requires a calling agent session');
        }
        try {
          return await bus.asks.ask(
            exec.agent,
            { target: args.target, text: args.text, timeoutMs: args.timeoutMs },
            { signal: exec.signal },
          );
        } catch (error) {
          if (error instanceof SessionBusError) {
            throw new Error(`bus_ask rejected (${error.code}): ${error.message}`);
          }
          throw error;
        }
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'bus_reply',
      description:
        "Answer the bus_ask this session is currently running, with an explicit reply instead of letting the turn's own text be taken as the answer. Only valid while a question from another session is in flight; it fails with no-pending-ask otherwise.",
      parameters: {
        text: {
          type: 'string',
          required: true,
          description: 'The answer sent back to the session that asked.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            askId: { type: 'string', required: true },
            to: { type: 'string', required: true },
          },
        },
        render: (_args, value) => renderLines([`Answered ${value.to} (ask ${value.askId})`]),
      },
      async execute(args, exec) {
        if (exec.agent === undefined) {
          throw new Error('bus_reply requires a calling agent session');
        }
        try {
          return await bus.asks.reply(exec.agent, args.text);
        } catch (error) {
          if (error instanceof SessionBusError) {
            throw new Error(`bus_reply rejected (${error.code}): ${error.message}`);
          }
          throw error;
        }
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'bus_status',
      description:
        'Check what became of a message you sent with bus_send or bus_ask, by the messageId it returned. "queued": in the target\'s inbox, not taken yet. "claimed": the target took it into a turn (turn is reported). "received": the target took it with bus_wait. "discarded": removed before any turn ran it, e.g. the target was cancelled. "unknown": not a message you sent, or this process no longer remembers it (receipts do not survive a restart).',
      parameters: {
        messageId: {
          type: 'string',
          required: true,
          description: 'The messageId returned by bus_send.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            messageId: { type: 'string', required: true },
            status: { type: 'string', required: true },
            to: { type: 'string' },
            sentAt: { type: 'string' },
            settledAt: { type: 'string' },
            latencyMs: { type: 'integer' },
            turn: { type: 'integer' },
            reason: { type: 'string' },
          },
        },
        render: (_args, value) =>
          renderLines([
            value.status === 'unknown'
              ? `Message ${value.messageId}: unknown${value.reason === undefined ? '' : ` (${value.reason})`}`
              : `Message ${value.messageId} to ${value.to}: ${value.status}${value.turn === undefined ? '' : ` in turn ${value.turn}`}${value.latencyMs === undefined ? '' : ` after ${value.latencyMs} ms`}`,
          ]),
      },
      async execute(args, exec) {
        if (exec.agent === undefined) {
          throw new Error('bus_status requires a calling agent session');
        }
        return await bus.status(args.messageId, exec.agent.id);
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'bus_wait',
      description:
        'Take the next bus message addressed to this session, optionally from one sender or one pending question. This CONSUMES the message: it is removed from the pending inbox, so it will not also arrive as its own turn. Returns immediately when a matching message is already pending. Use it to receive a reply after bus_send; skip it if you would rather let the reply arrive as your next turn.',
      parameters: {
        from: {
          type: 'string',
          description:
            'Only accept messages from this sender: a full session id, or an unambiguous id prefix from bus_roster.',
        },
        askId: {
          type: 'string',
          description:
            'Only accept the late answer to this bus_ask, which reported status "pending" with this askId.',
        },
        timeoutMs: {
          type: 'integer',
          description:
            'Give up after this many milliseconds and report a timeout. Defaults to the configured waitTimeoutMs and is capped at maxWaitMs.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            received: { type: 'boolean', required: true },
            from: { type: 'string' },
            text: { type: 'string' },
            askId: { type: 'string' },
          },
        },
        render: (_args, value) =>
          renderLines(
            value.received
              ? [`Message from ${value.from}: ${value.text ?? ''}`]
              : ['No bus message arrived before the timeout.'],
          ),
      },
      async execute(args, exec) {
        if (exec.agent === undefined) {
          throw new Error('bus_wait requires a calling agent session');
        }
        if (exec.signal.aborted) throw new Error('bus_wait was cancelled before it started');
        const agent = exec.agent;
        const session = agent.session;

        // Resolve a sender prefix the same way bus_send resolves a target. An id
        // that matches nothing yet is kept verbatim as an exact filter: the sender
        // may be a session that has not been created or persisted yet.
        let from = args.from;
        if (from !== undefined) {
          try {
            from = await bus.resolve(from, { signal: exec.signal });
          } catch (error) {
            if (!(error instanceof SessionBusError)) throw error;
            if (error.code !== 'unknown-target') {
              throw new Error(`bus_wait rejected (${error.code}): ${error.message}`);
            }
          }
          if (exec.signal.aborted) throw new Error('bus_wait was cancelled before it started');
        }

        /**
         * Whether one message carries this package's bus attribution.
         *
         * Matching our own source kind rather than `dsh-subagent`'s
         * `agent-message` keeps `bus_wait` from returning parent/child traffic.
         * The optional `askId` narrows it further, to the late answer of one
         * specific `bus_ask` — which is how a caller that got `status: "pending"`
         * picks its own answer out of a busy inbox. A `bus_ask` question addressed
         * to this session is never taken: the answer is read from the turn that
         * claims it, so consuming it here would strand the asker.
         */
        const isMine = (message) =>
          isBusSource(message?.source) &&
          !bus.asks.isOpenQuestionFor(message, agent.id) &&
          (from === undefined || message.source.senderSessionId === from) &&
          (args.askId === undefined || message.source.askId === args.askId);

        /**
         * Read the text body out of one bus message.
         *
         * `createBusMessage` frames the body with a lead-in block (`Agent <id>
         * sent a message: `, or the question / late-answer variants) so the
         * *transcript* reads as relayed traffic. That framing is already supplied
         * by this tool's own renderer, so returning it again would double it up in
         * the tool result the model reads.
         */
        const bodyOf = (message) =>
          (message.content ?? [])
            .filter((block) => block.type === 'text' && !FRAMING_BLOCK.test(block.text))
            .map((block) => block.text)
            .join('');

        /**
         * A delivery is recorded the moment it reaches the inbox, as an
         * `agent/inbox/spliced` insert. The matching `user/message` transcript
         * append only follows once the receiving turn reaches it, and for a
         * `followup` that is AFTER the current turn ends.
         *
         * This matters because `bus_wait` itself runs inside a turn: matching only
         * the transcript append would time out on every message that arrives while
         * it waits, which is all of them. So the splice is the primary signal and
         * the append is kept for messages already consumed into the transcript.
         */
        const deliveryIn = (event) => {
          if (event.type === 'agent/inbox/spliced') {
            return (event.data?.inserted ?? []).find(isMine);
          }
          if (event.type === 'user/message') {
            return isMine(event.data) ? event.data : undefined;
          }
          return undefined;
        };

        /**
         * Take one delivery out of the inbox and report it.
         *
         * This tool **consumes**: the message is removed from the pending lists, so
         * it does not also run as its own turn. Without the removal the same content
         * would reach the model twice — once here and once as the queued turn that
         * `followup` scheduled — which wastes a turn and lets two sessions that both
         * wait on each other ping-pong until the rate ceiling stops them.
         *
         * `remove` returns whether the message was still pending. It can already be
         * gone when the loop claimed it at a step boundary, in which case it has
         * been appended to the transcript and there is nothing left to take.
         *
         * @param message - the delivered bus message.
         * @returns the tool's canonical value.
         */
        const take = (message) => {
          // Before the removal: removing a pending message is reported as a
          // discard, and the receipt must say the target took it.
          bus.receipts.markReceived(message.id);
          agent.inbox.remove(message.id);
          return {
            received: true,
            from: message.source.senderSessionId,
            text: bodyOf(message),
            ...(typeof message.source.askId === 'string' ? { askId: message.source.askId } : {}),
          };
        };

        // A message that reached the inbox before this call is already pending.
        // Checking here is what makes the tool's documented "returns immediately
        // when a matching message is already pending" true: the caller is inside a
        // turn, so such a message has not been appended to the transcript yet and
        // would otherwise never be reported.
        for (const pending of [...agent.inbox.nextStep, ...agent.inbox.nextTurn]) {
          if (isMine(pending)) return take(pending);
        }

        const requested = Number.isFinite(args.timeoutMs) ? Math.trunc(args.timeoutMs) : config.waitTimeoutMs;
        const timeoutMs = Math.min(Math.max(requested, 0), config.maxWaitMs, MAX_TIMER_MS);
        return await new Promise((resolve, reject) => {
          let settled = false;
          /**
           * Detach the listener, timer, and abort hook exactly once, then settle.
           * A settle step that throws rejects instead of leaving the promise
           * pending — once detached, nothing else could ever settle it.
           */
          const finish = (settle) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            off();
            exec.signal.removeEventListener('abort', onAbort);
            try {
              settle();
            } catch (error) {
              reject(error);
            }
          };
          const off = ctx.on('session/event', (eventSession, event) => {
            if (settled || eventSession.id !== session.id) return;
            const message = deliveryIn(event);
            if (message === undefined) return;
            // This listener runs while `Session.append` is still publishing the
            // event, and the session rejects any nested append until that returns.
            // `take` appends — the inbox removal is itself a logged splice — so it
            // must run after the current append unwinds. Calling it inline threw
            // inside a contained observer and left the tool call pending forever.
            finish(() =>
              queueMicrotask(() => {
                try {
                  resolve(take(message));
                } catch (error) {
                  reject(error);
                }
              }),
            );
          });
          const timer = setTimeout(() => finish(() => resolve({ received: false })), timeoutMs);
          /** Forward caller cancellation into a rejection rather than a hang. */
          const onAbort = () => finish(() => reject(new Error('bus_wait was cancelled')));
          exec.signal.addEventListener('abort', onAbort, { once: true });
        });
      },
    }),
  );
}

// NOTE: no `export default` here on purpose. The Cordis loader's `unwrapExports`
// prefers `exports.default ?? exports`, so a default export would hand the loader
// a bare function and silently drop `name`/`inject`/`Config` — the plugin would
// then fail with "cannot get property ... without inject".
export { Config, apply, inject, name };
