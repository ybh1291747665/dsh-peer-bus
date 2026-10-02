# dsh-peer-bus

**English** · [简体中文](README.zh.md)

Cross-session message bus for [DeepSeek Harness](https://github.com/deepseek-ai). It lets two **independent, unrelated** sessions address each other by id and wake each other up — no parent/child relationship required.

```
session A ──bus_send──▶ session B   (B is woken, runs a turn)
session B ──bus_send──▶ session A   (A is woken, runs a turn)
```

New here? [USAGE.md](USAGE.md) is the task-oriented guide: install, allowlist, two sessions talking, troubleshooting.

## Why this exists

DSH already ships two ways for agents to talk, and both are narrower than "two sessions":

| Existing | Scope |
|---|---|
| `send_message` (`dsh-tool-subagent-control`) | a **direct parent or direct continuable child** only |
| `dsh-experimental-agent-team` | a **Lead plus its teammates**, one tree, one process |

Neither lets session `A` and session `B` — two unrelated roots — hold a conversation. This plugin adds exactly that: a flat, id-addressed bus over every session the process can see.

## How it works

The interesting part, and the reason this is a small plugin rather than a large one:

**The session log is a projection, not the driver.** `agent/inbox/spliced` events in a session log *record* pending inbox state so it can be rebuilt after a restart, but appending to a log does **not** wake anything. The live driver reads its in-memory inbox.

So delivery never touches the log directly. It goes through the live `Agent` API that `@deepseek-ai/dsh-agent` augments onto every registered agent:

| Target state | What the bus does |
|---|---|
| **live** (running or idle) | `agent.followup(message)` by default — queues its own turn, and **wakes the driver** when idle. With `mode: 'steer'`, `agent.steer(message)` instead — admitted at the nearest step boundary. |
| **stored, unloaded** | `ctx.agents.resume({ resumeSessionId })` then the same delivery — cold-resumes from persistence |
| **open in another DSH process** | rejected with `target-busy` — the log is locked by that process |
| **archived** | rejected with `target-archived` — refused before any resume, so an archived session is never woken. `bus_roster` does not list archived sessions either, and an archived caller is shown nothing. |
| **unknown** | rejected with `unknown-target` |

The mode is the caller's choice, not inferred from the target's state: `followup` is always the default.

Archive state comes from the workspace registry, which only the web bundle mounts. A profile without one behaves exactly as if nothing were archived — the check is skipped, not faked. A session archived while still live is refused the same way, because archiving does not have to unload it.

Because `followup`/`steer` record their own `agent/inbox/spliced` event, durability comes for free: the message survives a restart with no second mailbox to maintain.

### Its own message source kind

A delivered message carries the `peer-bus-message` source, declared by this package. `dsh-llm`'s `MessageSourceMap` is merge-extensible and documents that each producer declares its kind in its own module — there is deliberately no shared catch-all kind — and that consumers fall through unknown kinds.

Reusing `dsh-subagent`'s `agent-message` kind would have worked, but it would make bus traffic indistinguishable from parent/child traffic in the transcript and in `bus_wait`. Declaring a kind is the documented design; sharing one is the shortcut.

### Cold resume has to restore the model route

A resumed agent has no route of its own. `ctx.agents.resume()` without `agentOptions` leaves the loop with no provider/model, so a delivered message produces a turn that starts, runs no step, and calls no model — a silent no-op. The route is not in the session header, so the bus reads it out of the log and restates it on resume: the newest `request/header` event's call config (provider, model, and reasoning effort — the same source `dsh-subagent` uses when a child inherits its parent's route), falling back to the newest `request/context` route metadata. This is easy to miss because the delivery itself still looks successful.

**Which resume path runs depends on the composition.** When a session controller is mounted — the web bundle — the bus goes through the host's own Typert `agent` lookup, which is the path the GUI uses: model selection installed, preset mounted, sub-agent ownership checked, and the resulting lifecycle **host-owned** rather than handed to this plugin. `dsh-agent` registers that lookup on every profile, but its own resolver answers only for an agent that is already live, so the discriminator is the *answer*, not the presence: a bare provider returns nothing for a stored session and the manual path takes over. A log held by another writer comes back as `session/writer-held` and is reported as `target-busy` without retrying. `npm run boot-check` prints which path a profile gets.

A resume is shared only while it is in flight. Once it settles, liveness is re-read from `ctx.agents`, so a resumed session that is later unloaded is resumed again on the next send rather than "delivered" to an agent that no longer exists.

### Cold resume has to restore the agent preset too

A route is only half of a session's composition. DSH's own resume installs the model selection **and** mounts the agent preset:

```js
setup: async (agentCtx, agent) => {
  this.installSelection(agent);               // model selection
  await presets.mount(agentCtx, resolvedId);  // the preset
}
```

A preset is not decoration. In a preset-backed profile it supplies the persona (the system prompt), the agent-instructions loader, and some tools — in the shipped `standard` preset, `dsh-persona`, `dsh-agent-instructions`, and the `ask-user` / `present` tools come from the preset rather than the global layer. So a resumed agent that skips the mount runs on the **wrong system prompt and a reduced toolset**, and nothing reports it: the turn still completes.

The preset id is read from the registry's own `agentPreset` projection, matching what DSH's session controller reads, falling back to the durable `session.header.agentPreset`. The mount has to run from the `resume` setup callback, which is the only point where the agent is unpublished and `mount` accepts its scoped context.

This one is easy to miss in testing: only the **web** profile mounts `@deepseek-ai/dsh-agent-preset-registry`, so on a plain `headless` profile the omission is invisible. The e2e overlay mounts the registry and declares two presets so it can assert the *recorded* preset was mounted rather than the default.

### Resolve services before the first `await`

Cordis rebinds `this.ctx` to a per-call **shadow** while a service method runs, so that `this.ctx.<serviceName>` names the service itself. That shadow is only good for the synchronous part of the call: a `this.ctx.<service>` or `this.ctx.get(...)` lookup made after an `await` that crosses a macrotask fails — as `undefined`, or as `cannot get required service "x" in inactive context`.

The trap is that it is invisible until it isn't. It only bites callers that reach the service through `ctx.get('peerBus')` instead of holding the instance, and only when an await actually crosses a macrotask — so a fast path hides it and a slow one crashes. It broke this plugin exactly when the runtime allowlist started opening a storage domain on real file I/O: `roster()` read `this.ctx.agents` afterwards, and the boot check died with a bare `TypeError`.

The discipline here is to resolve what a method needs **before** its first `await`, into locals — `const agents = this.pluginCtx.agents; const persistence = this.pluginCtx.get('sessionPersistence');`. The bus keeps its construction-time context in `pluginCtx` precisely because `this.ctx` is the shadowed one. `npm run boot-check` is the regression check for this: it calls `roster()` through the service proxy as its first bus operation, with a real storage open in between.

## Package layout

| Path | Role |
|---|---|
| `src/index.js` | Cordis plugin: the bus service, the `bus_*` tools, and `/bus` registration |
| `src/peer-bus.js` | Roster, permission, rate, delivery, cold-resume ownership |
| `src/ask.js` | `bus_ask`: answer correlation, the wait-for graph, late delivery |
| `src/receipts.js` | `bus_status`: what became of each delivered message |
| `src/message.js` | The `peer-bus-message` source kind and the message builder |
| `src/errors.js` | `SessionBusError` and its stable codes |
| `src/allowlist.js` | The runtime allowlist behind `/bus allow`, durable through a storage domain |
| `src/commands.js` | The human-facing `/bus` command: `id`, `list`, `allow`, `revoke` |
| `src/invariant.js` | The `./invariant` companion — package-owned durable-shape checks |
| `cordis.patch.yml` | The bundle patch, mounted as one insert |

`src/invariant.js` follows the DSH convention that every package registers its runtime checks from a `./invariant` companion so ordinary entrypoints stay independent of diagnostics. It validates shape and placement only — permission, size, and rate are per-deployment `Config`, and a log written under a looser policy must still replay after a deployment tightens it.

The companion needs `invariants`, which the base, web, and headless bundles do **not** mount (only `dsh-sdk-minimal` does). It does **not** declare that service as its own dependency, and that is deliberate: a declared-but-absent service holds the entry at `pending` forever, and the loader reports every pending entry as a startup warning — so declaring it would print "1 entry did not activate" on every boot of every profile except one. Instead the companion activates unconditionally and waits for the service in a nested fiber, registering the moment `@deepseek-ai/dsh-invariants` is composed and staying inert otherwise.

## Install

```bash
# From a checkout:
git clone https://github.com/ybh1291747665/dsh-peer-bus.git
dsh plugin --profile web add "$PWD/dsh-peer-bus"

# Or straight from the registry:
dsh plugin --profile web add dsh-peer-bus
```

The package declares `dsh.bundle.patch`, so `dsh plugin add` registers it in the profile's `dsh.profile.bundles` and the plugin mounts itself on the next boot — no manual `cordis.patch.yml` entry needed.

While installing, `pnpm` reports missing peers such as `@deepseek-ai/dsh-agent`. **That is expected and can be ignored.** DSH turns off automatic peer installation and provides those packages from its own runtime, which is also why they are declared as peers rather than dependencies: the plugin has to run against the host's copy, not a second one of its own. The same applies to `@deepseek-ai/dsh-home-paths` (used only when `crossProcess` is on) and `zod` (used by the storage domain's validation), both of which are declared optional.

It ships **default-deny**, so installing it grants no session the ability to message another. See [USAGE.md](USAGE.md#2-decide-which-sessions-may-talk) for the allowlist syntax.

## Tools

| Tool | Purpose |
|---|---|
| `bus_roster` | List the sessions the caller can reach: its own row (marked `you`) plus every session the allowlist lets it message, with id, title, live/stored, status, workspace, and whether it is a subagent. `rosterScope: 'all'` lists everything instead. |
| `bus_send` | Send to a target by id or unambiguous id prefix. Optional `mode: 'steer'`. |
| `bus_ask` | Ask a question and get the answer **in this tool result**. See below. |
| `bus_reply` | Answer the `bus_ask` this session is currently running, explicitly, instead of letting the turn's own text be taken as the answer. |
| `bus_status` | Look up what became of a message you sent, by the `messageId` that `bus_send` returned: `queued`, `claimed` (with the turn), `received` (taken by the target's `bus_wait`), `discarded`, or `unknown`. See below. |
| `bus_wait` | **Take** the next bus message addressed to this session, optionally `from` one sender (full id or unambiguous prefix) or by the `askId` of a pending ask. Consumes it, so it will not also arrive as a turn. It never takes a `bus_ask` question addressed to this session — that belongs to the turn that answers it. Timeout defaults to `waitTimeoutMs`, capped at `maxWaitMs`. |

### Titles are an auxiliary address

`bus_roster` shows each live session's title, and a title that is unique among the sessions a caller can reach also works as a target for `bus_send` and `bus_ask`. Ids stay canonical: an id or id prefix is always tried first, and a title that matches several sessions is refused with its candidate ids rather than guessed at.

Titles are read from the session's own log through `ctx.get('sessionTitle')`, which needs a live session — so a **stored** row reports no title. Reading one would mean a log read per roster row, and the roster is rebuilt on every send; leaving it blank is the honest answer rather than an expensive one.

Names are `bus_*` on purpose: `send_message` is already claimed globally by `dsh-tool-subagent-control`, and a same-name registration would shadow it.

### `bus_ask`: the reply comes back as the tool result

Two-step delivery is poor ergonomics: the caller has to know to wait, the reply can also arrive as its own turn, and two sessions that both wait on each other deadlock until the rate ceiling stops them. `bus_ask` closes all three.

```
A: bus_ask { target: B, text: "what is the deploy status?" }
   → status "answered", text: "<B's answer>", turn: 3
```

**Correlation is exact, not heuristic.** The ask id travels *with the question* as `source.askId`, and the ask is registered before the question is delivered. That ordering is load-bearing: a `followup` to an idle session can be claimed by the driver before the sender's continuation runs, so anything registered afterwards would race the very claim it is trying to observe. The answer is then read from the turn that claimed the question — every `assistant/message` carrying that turn number — which is more accurate than "the last assistant text in the session", a value that can belong to a later, unrelated turn.

**A busy target becomes a pending ask rather than a long wait.** If the target was already running when asked, `bus_ask` waits only `askBusyTimeoutMs` (default 30 s) and then returns `{status: 'pending', askId}`. The answer still arrives, as a bus message tagged with that ask id, and `bus_wait { askId }` takes it. An idle target is given the full `waitTimeoutMs`, because it can start the question's turn immediately.

**Wait cycles are refused, not deadlocked.** Every in-flight ask is an edge in a "who is blocked on whom" graph. Adding an edge that closes a cycle is rejected up front with `ask-cycle`, naming the chain:

```
bus_ask rejected (ask-cycle): asking "session-bob" would close a wait cycle
(session-bob -> session-alice -> session-bob); one side must answer with bus_send instead of bus_ask
```

This is deliberately **not** a hop cap. Ordinary `bus_send` conversations stay unbounded and are bounded only by the rate ceiling; only blocking waits participate in the graph. A timed-out or cancelled ask releases its edge, so a stale edge cannot make a later ask report a deadlock that does not exist.

`bus_reply` is optional: without it, the target's turn text *is* the answer. Use it when the answer should be something other than what the turn says — and note it takes no ask id, because the registry resolves "the ask whose turn this is". A session answers one question per turn.

**The question tells the target how to answer.** It arrives as `Agent <id> asked you a question: …`, with a closing note that the reply in this turn is returned to the asker automatically. The first real-model run showed why: framed like an ordinary message, the question was answered in the turn *and* re-sent with `bus_send`, so the asker received it twice (see [Real model](#real-model)).

A question is never taken by the target's own `bus_wait`. If the target happens to be inside a `bus_wait` when the question arrives, the wait leaves it in the inbox: the answer is read from the turn that claims the question, so consuming it would strand the asker until its timeout.

### `bus_status`: what became of a message

`bus_send` only proves the message reached the target's inbox. `bus_status { messageId }` follows it from there:

| Status | Meaning |
|---|---|
| `queued` | In the target's inbox; no turn has taken it yet (the target is busy). |
| `claimed` | The target's loop took it into a turn; the receipt names the turn and the latency. |
| `received` | The target took it with `bus_wait`. |
| `discarded` | Removed before any turn ran it — for example, the target's run was cancelled. |
| `unknown` | Not a message you sent, or this process no longer remembers it. |

A receipt is recorded **before** the message is routed. On an idle target, `followup()` starts the driver synchronously and the driver claims its first batch before its first `await`, so the claim fires inside the `followup()` call; a receipt recorded afterwards would miss it and say `queued` forever. Only the sender can read a receipt — anyone else gets `unknown`, the same answer as for an id that does not exist, so receipts cannot be used to probe another session's traffic. Receipts are process-local and bounded (the newest 1,000), so they do not survive a restart. `claimed` means a turn *took* the message, not that the target acted on it as asked.

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `allow` | `[]` | Permission allowlist. **Default deny — an empty list permits nothing.** |
| `maxMessageBytes` | `16384` | Maximum UTF-8 bytes in one message body. |
| `maxSendsPerWindow` | `10` | Send ceiling per sender→target pair per window. A send that fails to deliver does not count. |
| `rateWindowMs` | `60000` | Length of that window in milliseconds. |
| `rosterScope` | `'allowed'` | What `bus_roster` shows: `'allowed'` = the caller plus sessions it may message; `'all'` = every session, flagged `allowed`/`not-allowed`. |
| `waitTimeoutMs` | `60000` | `bus_wait` timeout when the caller passes none, and `bus_ask`'s when the target is idle. |
| `maxWaitMs` | `600000` | Upper bound on any `bus_wait` or `bus_ask` timeout, so one call cannot hold a turn open indefinitely. |
| `askBusyTimeoutMs` | `30000` | How long `bus_ask` waits when the target was already running, before it returns `pending`. |
| `resumedIdleMs` | `600000` | Release a session the bus cold-resumed itself once it has been idle this long, freeing its log lock. `0` keeps such sessions loaded. Sessions resumed through the host's own lookup are host-owned and unaffected. |
| `crossProcess` | `false` | Reach sessions held live by another DSH process over a local socket. **Off by default on purpose** — see [Cross-process](#cross-process). |
| `crossProcessTimeoutMs` | `2000` | Timeout for one remote control-plane query (roster merge, `bus_status`, ask cancellation). Short on purpose: a wedged peer must degrade to "looks stored", not stall a turn. |
| `crossProcessDeliverTimeoutMs` | `60000` | Timeout for one forwarded delivery, which may have to cold-resume the target on the far side. |
| `crossProcessRosterCacheMs` | `3000` | How long this process may reuse the last answer to "which peer holds what". Every roster asks every peer, so a burst of sends would otherwise cost a query per send per peer. A stale answer is safe: the peer that no longer holds the session says so and the sender re-resolves. `0` asks every time. |

Keys you leave out of a profile patch fall back to these defaults.

### Cross-process

Off by default. Turning it on widens the trust boundary from "this process" to
**"every DSH process of this OS user over this `DSH_HOME`"**, which is why it has to be
a deliberate act rather than something that quietly starts working.

What that boundary is, exactly:

| Property | How it holds |
|---|---|
| Which processes can see each other | Only those sharing one `DSH_HOME`. Two homes on one machine are two separate worlds. |
| Who can connect | The endpoint directory is `0700` and every file in it `0600`, so another OS user cannot enumerate peers or read a token. When a long `DSH_HOME` forces the socket into the shared temp directory, that directory is **verified** rather than trusted — a real directory, not a symlink, owned by this user, mode `0700` — because on Linux `/tmp` can be pre-created by anyone. |
| Who can talk | A handshake token, read from the peer's own `0600` file. On Windows this is load-bearing rather than defence in depth: a named pipe has no filesystem permission model of its own. |
| What a peer may do | Nothing it could not do locally. The **receiving** process re-runs its own allowlist, archive check, and rate ceiling; a sender cannot talk its way past them. |
| Whether it leaves the machine | No. A Unix domain socket or a Windows named pipe, both local. There is no network listener and no port. |

**Who decides permission across processes.** The receiving process, always. A grant means "this session may message me", and it is made with `/bus allow` inside the process that holds the session being messaged — so the sender's process cannot see it and does not try to. For a target held elsewhere the sender forwards and lets that process apply its own allowlist, archive state, and rate ceiling; for a target held locally it checks as before, because there the receiver and the sender are the same allowlist. This is what makes a cross-process pair work with nothing but the receiver's consent — needing the rule written into both processes' config would mean a consent that was actually given had no effect.

Two consequences worth stating plainly. First, a peer that lies about itself is
inside the trust boundary already — the receiver prefers its **own** view of the
sender's session when it has one, and falls back to the sender's claim only when it
cannot see that session at all. Second, enabling the transport does not grant
anything: with an empty `allow` list, two processes that can see each other still
cannot message each other.

### Two allowlist rule shapes

```yaml
allow:
  # 1. id patterns — exact, trailing-* prefix, or '*' for any
  - from: 'session-abc'
    to: 'session-worker-*'

  # 2. same workspace — any two root sessions sharing a workspace
  - sameWorkspace: true

  # ...narrowed to one workspace
  - sameWorkspace: true
    cwd: '/Users/you/project'

  # ...and letting subagent children in too (off by default)
  - sameWorkspace: true
    includeSubagents: true
```

Id patterns are not globs: `*` is only meaningful at the end.

The workspace rule exists because a session id is a fresh UUID — you cannot write an id rule for a session that does not exist yet, which makes "let me test two sessions talking" need a config edit and a restart after the fact. It is also narrower than `'*'`: a session in an unrelated project does not match.

Both sides need a *recorded* workspace for a workspace rule to match. Two sessions whose `cwd` DSH did not record are not "in the same workspace", they are simply unlocated, and the rule refuses them rather than silently authorizing every such session.

A workspace rule also refuses a **subagent child** on either side unless it sets `includeSubagents: true`. `dsh-subagent` gives every child its parent's `cwd`, so without this exclusion a subagent reading an untrusted file or web page could instruct — and cold-resume — every root session in the project. A child is recognised by its header (`origin: 'subagent'` or a positive `delegationDepth`); a user-initiated fork is a peer and still matches. Id rules are explicit and unaffected.

### Why default-deny

A bus message is delivered as a **user message**, and a model treats user messages as instructions. A permissive bus is therefore a prompt-injection path: any session — including a subagent you spawned to read an untrusted file — could instruct your main session. Default-deny with an explicit allowlist keeps that a deliberate choice, and the workspace rule's subagent exclusion keeps the convenient rule from reopening that path.

### Changing the allowlist at runtime: `/bus`

The config file is the baseline, and it cannot be written ahead of time — so `/bus` edits the allowlist from inside a session, with no restart and no GUI:

```
/bus id                    show this session's id
/bus list                  who may message this session, and why
/bus allow <session>       let <session> message this session
/bus revoke <session>      take that back
```

`<session>` is a full id or an unambiguous id prefix, resolved the same way `bus_send` resolves a target — a typo fails loudly instead of persisting a grant that can never match.

**The grant is receiver consent.** `/bus allow <peer>` run in session A means *that peer may message A*. Each side's user decides who may instruct it, so a two-way conversation takes one grant on each side. The alternative — one grant opening both directions — would let A's user decide, on B's behalf, who may instruct B.

Runtime grants are **additive and revocable**, and they persist: they are written to a `peer_bus_allowlist` storage domain, so they survive a restart. `/bus revoke` can only take back a grant made this way — it cannot subtract from the config, and it says so rather than claiming a success it did not achieve:

```
$ /bus revoke session-abc
Runtime grant revoked, but the config allowlist still permits session-abc to message this session.
```

**No model tool can do this.** `/bus` is registered on the human command registry only; there is deliberately no `bus_allow` tool, so an agent cannot widen its own permissions. A bus message whose body starts with `/bus allow …` is delivered as text and is never interpreted — the e2e asserts that the command registry is not invoked at all during a delivery.

A profile that mounts no command registry, or that cannot resolve `zod` (which the storage domain layer validates with), still has a working bus: the command is skipped and runtime grants stay in memory for the life of the process, with a warning that says which of the two happened.

The per-pair rate ceiling is the second guard: two agents that both auto-reply quickly would otherwise loop forever, spending tokens on every hop. It bounds the rate, not the length, of a conversation.

## Verification

Every check below except the last is offline — no network, no model calls. This is what was run to produce the results stated here.

```bash
npm run link-dev-deps   # once: symlink @deepseek-ai/* out of a local DSH install
npm test                # 277 unit tests
```

The heavier checks boot a real DSH profile from a workspace-local `DSH_HOME`, so they never touch your own `~/.dsh`:

```bash
npm run test-home       # once: build .dsh-test/profiles/{headless,web}
npm run boot-check      # the plugin mounts and registers its six tools
npm run boot-check:web  # the same, on the web profile, without binding port 3080
npm run e2e             # two independent sessions hold a real conversation
npm run e2e:web         # the same, on the web profile, where cold resume goes through the host lookup
npm run restart-e2e     # that conversation survives a real process restart
```

`DSH_HOME` is forced to `.dsh-test` by `scripts/dsh-home.mjs`, which every check imports first — the ambient `DSH_HOME` is a real DSH session's own home, so it is overridden rather than inherited. Set `BUS_TEST_DSH_HOME` to point the checks at a different throwaway home.

`test-home` gives the two profiles deliberately different mounting paths. `headless` is mounted by the overlay, so `bus.patch.yml` stays usable on a profile that does not bundle this package at all; `web` is mounted by the package's own bundle layer, so the shipped `cordis.patch.yml` — what a real `dsh plugin add` composes — is the thing under test. A patch `insert` **appends**; it does not replace a row with the same id. Bundling the package *and* inserting it from an overlay would therefore mount two buses, under one service name, with two sets of tools.

| Check | What it establishes |
|---|---|
| `npm test` | 277 unit tests: addressing, both allowlist rule shapes and the subagent exclusion, roster scoping, rate (including refund and eviction), routing, the target states, stale-resume recovery, lock contention, the route recovery, archive protection (both when the registry is mounted and when it is absent), the runtime allowlist (`/bus` grant, revoke, listing, durable load, and the wait for it), the cold-resume precedence (host lookup first, manual fallback, `session/writer-held` mapped to `target-busy`), title resolution (unique title resolves, ambiguous title lists its candidates, an id prefix still wins), `bus_ask` (answer correlation by claiming turn, later turns ignored, pending and late delivery, wait-cycle refusal including a three-session chain, cancellation and disposal), delivery receipts (a claim fired synchronously inside `followup()` is still recorded, sender-only reads, `received` surviving the discard its own removal logs, the size bound), idle release of resumed agents (released only after a full quiet period, kept while running, with pending inbox work, or in an ask; a send racing a release resumes the session again; host-resumed sessions untouched), `bus_wait` leaving a `bus_ask` question for the turn that answers it, the tool executors — run against fakes that enforce DSH's no-nested-append rule during event publication — and the invariant validators — including that the companion does **not** declare `invariants` as its own dependency, so it never leaves a pending entry behind at startup. The cross-process suites add: the frame reader reassembling a multi-byte character split across chunks and a large message arriving byte by byte; the claim book's atomic create, dead-owner takeover, owner-only files, and the rule that a release only removes a claim its holder still owns; delivery de-duplication and the unknown-on-timeout outcome; the handshake deadline and the pre-handshake frame limit; the shared-temp directory check refusing a symlink and a world-readable directory; `liveRows` answering without reading persistence; three buses where a wait cycle spans all three and where the edges a question implies are released when it settles; two processes contending for one stored session; the ownership cache, its expiry, and its correction after a peer dies; a peer's runtime grant deciding a cross-process send; and a remote target's archive state being visible before the trip. |
| `npm run boot-check` | The plugin loads through the real profile loader and registers its service and six tools. Reports whether the `./invariant` companion registered or is inert on this profile, and whether the workspace registry is mounted — the two optional capabilities that decide which code paths are live. |
| `npm run e2e` | 93 assertions over a real boot with a scripted stub `LlmAdapter`: delivery, `peer-bus-message` attribution, idle wake, cold resume and re-resume after unload, the subagent exclusion and roster scoping; `bus_wait` **called by the model inside a real turn**, both for a delivery that arrives mid-wait and one that arrived earlier in the turn — the turn completes, the tool returns the body without the attribution prefix, and the message does not also run as its own turn; archive protection against the **real** workspace registry, for a stored and for a live archived target, including that unarchiving restores reachability; a real session renamed through `sessionTitle.rename` resolving and sending by title; `bus_ask` **called by the model inside real turns**: an answer returned in the caller's tool result, a mutual ask refused as `ask-cycle` inside the answering turn, and a busy target handing back `pending` whose answer then arrives as a bus message tagged with the ask id; `/bus` granting a pair the config refuses, writing that grant through to the **real** storage domain, and taking it back — plus proof that a delivered message body beginning `/bus` executes no command; `bus_status` against real turns — `claimed` with the real turn number, `queued` then `claimed` on a busy target, `discarded` after a real `cancel()`, `received` for a message the target's model took with `bus_wait`, and `unknown` for anyone but the sender; a session sitting in `bus_wait` while another asks it something, proving the wait does not swallow the question and the asker still gets the answer; on the manual resume path, an idle resumed session released by the sweep, with its log lock shown held before and free after, and resumed again by the next message; and that the `./invariant` companion registered and did not reject legitimate traffic. The allowlist is a single `sameWorkspace` rule, and the talking sessions share a workspace while the deny probe sits in a temp directory — so the same rule both grants the conversation and refuses the outsider. |
| `npm run e2e:web` | 89 assertions — the same scenarios on the **web** profile, which is the only place the host resume path exists: `sessionController` configures the Typert `agent` lookup, so every cold resume in this run goes through the official path rather than the manual one. The resume-related scenarios are path-aware, which is why the count differs from `e2e`: the manual path proves the plugin unloads its own handle, re-resumes rather than serving a stale cache, and releases an idle resumed session; the host path proves the opposite property — no handle is held at all, and the idle sweep leaves the host-owned session alone. |
| `npm run restart-e2e` | Runs the phases as **two separate processes** over one `DSH_HOME`; `verify` boots fresh and reads the persisted log files off disk. The seed also runs `/bus allow`, so `verify` proves the runtime grant was read back from storage in a process that never made it. A real process boundary is the point — resuming in place would not test durability. |

### Real model

```bash
npm run e2e:xproc          # two real DSH processes, stub model, free
npm run real-model-check   # spends real tokens on your configured model route
npm run real-model-xproc   # both: two real processes AND a real model, spends tokens
```

Two sessions on a real model route, on the `web` profile (host resume path) in the isolated test home, with no port bound. The run reads only two things from your real `~/.dsh`, at runtime: the `llm-pi-ai` and `agent-default-model` rows of your web profile (copied into a gitignored overlay under `.dsh-test/`), and the API key they name, loaded into the script's own environment and never printed or written. The prompts are plain task requests that never name a bus tool:

1. A planner must get the version string in `release.json` from a worker session that owns the file.
2. The worker is unloaded, and the planner asks it for the codename — so the answer has to come from a session the bus cold-resumes on its recorded route.
3. The planner sends the worker a one-way notice and has to confirm it was picked up.

Mechanism results (delivery, attribution, cold resume on the real route, receipts) are hard checks; what the model chose is recorded as an observation. Results on `opencode-go/deepseek-v4.1-flash`, DSH `0.2.0-rc.2`, two runs: every check passed, and without being told which tool to use the planner chose `bus_ask` for both questions, and `bus_send` + `bus_status` for "send a notice and confirm it was picked up". The full transcript is in [verification/real-model-2026-10-01.md](verification/real-model-2026-10-01.md).

**What it caught.** The first run exposed a defect no stub could: a `bus_ask` question was framed like an ordinary message, so the target answered in its turn *and* re-sent the answer with `bus_send` — the asker got it twice and ran an extra turn. Questions now say that the turn's reply is returned automatically; on both runs after the change the worker answered once. The run before the fix is kept as [verification/real-model-2026-10-01-before-question-framing.md](verification/real-model-2026-10-01-before-question-framing.md).

Two official DSH test toolkits — `@deepseek-ai/dsh-agent-loop-testkit` and `@deepseek-ai/dsh-llm-mock-server` — are `devDependencies` of shipped packages and are **not present in a published install**, so this package cannot use them. The stub adapter in `scripts/e2e-bus.mjs` stands in for the mock server; it implements only the one required `LlmAdapter.stream()` method and relies on the base class defaults for everything else.

## Known limitations

- **Cross-process reach is opt-in, and off by default.** With `crossProcess: false` every delivery path is process-local: a session open in another DSH process shows as stored, and a send to it is refused with `target-busy` because that process holds its log lock. Turn the transport on and those sessions become reachable — they appear in the roster marked remote, and `bus_send`, `bus_ask`, `bus_reply`, `bus_status`, and `bus_roster` all work across the boundary. What stays local: the transport is a Unix domain socket (a Windows named pipe) and never crosses a machine. Durability across a restart is a separate property and does hold either way — a stored session is resumed and woken by a later process.
- **A peer that has not enabled the transport is invisible, and that is not a bug.** Discovery is per `DSH_HOME` and per opt-in, so a process running an older build, or one with `crossProcess` off, simply is not there. A send to a session it holds is refused with `target-busy`, and the message says why.
- **Cold-resumed agents are released when idle — on the fallback path.** A session the bus resumed *itself* (no host lookup, e.g. on `headless`) is released once it has been idle, with an empty inbox and no in-flight ask, for `resumedIdleMs` (10 min); that frees its log lock so another process can open it, and the next message simply resumes it again. A session resumed through the host's own lookup (`web`) is host-owned, exactly like one opened in the GUI, and the bus never unloads it. If a session the bus resumed on the fallback path is *also* opened in a GUI, the bus may still release it after a quiet period; the GUI then resumes it again on its next request.
- **The roster is rebuilt from persistence on every send, and that cost grows with your history.** Every `bus_send`, `bus_ask`, and address resolution calls `sessionPersistence.list()`, so the work is proportional to the number of *stored* sessions, not to the number of live ones. Measured on this repository's test home: 1,123 stored sessions cost about 135–141 ms for `list()` and 124–135 ms for the whole `roster()` — paid again on each send. A live-first lookup (resolve against live agents first, fall back to the full list only when the address is not live) is the obvious fix and is deliberately **not** implemented yet; it is recorded as a deferred optimization rather than an oversight.
- **Cold resume is single-winner across processes, and the bus is what makes it so.** The layer below cannot: a session's log is guarded by a cross-process `flock(2)`, but that lock guards *write handles* and `agents.resume` does not take one, so two processes that both decide to resume the same stored session would both succeed. The bus arbitrates among the only processes that can be contending — before resuming, a process claims the session with an atomic `open(…, 'wx')` under `$DSH_HOME/peer-bus/claims/`. The winner resumes; the loser waits for the winner to actually hold the session and then **forwards the message to it**, so nothing is dropped. A claim whose owning pid is gone is taken over, a claim is given back if the resume fails, and it is released when the session is released or the process unloads. Present only when `crossProcess` is on. `npm run e2e:xproc` stages the race with two real processes and asserts the outcome.
- **A forwarded delivery that times out is reported as unknown, not as a failure.** If the peer does not answer in `crossProcessDeliverTimeoutMs`, `bus_send` returns `targetState: "unknown"` with the id to ask about, because the peer may well have delivered it and an error would invite the model to send it again. Retries are safe either way: the sender tags each delivery, and the receiving process takes a repeat of an id it has already seen as a duplicate — returning the original result instead of waking the target twice.
- **The route is inferred, not declared.** Cold resume reads the last `request/header` (or, failing that, `request/context`) event to recover provider, model, and reasoning effort. A session that never made a model request has no recorded route, and the resumed turn will be empty.
- **Receipts track delivery, not intent.** `bus_status` can say a message was claimed into a turn, taken by `bus_wait`, or discarded — not whether the target did what the message asked. Receipts are process-local and do not survive a restart. For the answer itself, use `bus_ask`, or `bus_wait` for the reply.
- **`bus_wait` consumes.** It takes the message out of the pending inbox so the same content cannot also run as its own turn. That is deliberate — a peek would deliver twice, waste a turn, and let two sessions that both wait on each other ping-pong until the rate ceiling stops them. If you would rather have the reply arrive as your next turn, do not call it.
- **Real-model verification is a separate, paid check.** Every check under [Verification](#verification) except `real-model-check` and `real-model-xproc` uses a scripted stub `LlmAdapter`, which proves delivery, wake, persistence, attribution, and policy deterministically and offline. `npm run real-model-check` runs two sessions on a real model route with prompts that never name a bus tool; its mechanism checks are hard failures, while which tool the model chose is recorded as an observation — that is model behaviour, measured on a handful of runs, not a guarantee.
- **The cross-process checks are two layers, and only one of them is free.** `npm run e2e:xproc` spawns a real second DSH process and proves discovery, forwarding, both-sides permission, receipts, and stale cleanup after the peer is killed — deterministically, with a stub model. `npm run real-model-xproc` adds the part a stub cannot: the message arriving over the socket wakes a **real model turn** in the process holding the session, and the real answer is pushed back. The record of a passing run is in [verification/real-model-xproc-2026-10-02.md](verification/real-model-xproc-2026-10-02.md).

## Requirements

DeepSeek Harness `>=0.1.7-rc.2 <0.3.0`, verified on `0.1.7-rc.2` and `0.2.0-rc.2`. Since 0.2.0, DSH checks every `@deepseek-ai/dsh*` peer range against the running version at boot and refuses to mount a plugin that does not match, so this range must cover the host you run. It stops before 0.3.0 because a 0.x minor release may change plugin APIs; re-run the checks under [Verification](#verification) before widening it. The plugin declares `@deepseek-ai/*` packages as `peerDependencies` so it resolves them from the host install rather than bundling its own copy; `dsh-invariants` and `dsh-session-query` are marked optional, because cold resume and the invariant companion are optional capabilities (DSH still checks their ranges).

## Publishing notes

Honest gaps, so nobody assumes more than is here:

- **The `test/` and `scripts/` directories ship in the tarball** so the commands in [Verification](#verification) work from an installed copy, not only from a checkout. That is deliberate and slightly unusual; drop them from `files` if you prefer a lean package.
- **No `README.i18n.yaml`.** The DSH monorepo records per-section hashes of the English and Chinese README blocks and checks them with `pnpm run verify-translation-pairing`. That tool lives in the monorepo and is not published, so the bilingual pair here ([README.md](README.md), [README.zh.md](README.zh.md)) is **not** hash-recorded. Do not hand-write that file: fabricated hashes would fail their verification.
- **No `lib/` build.** DSH packages compile TypeScript to `lib/`. This one is plain ESM JavaScript under `src/`, so there is no compile step and no `.d.ts`. The `exports` map follows the same shape (`./invariant`, `./package.json`) but points at `src/`.
- **No automated real-model check.** The manual round trip described under [Known limitations](#known-limitations) is not reproducible from this repository — it needs a live profile with a real provider. Closing that is tracked work, not a shipped guarantee.

## License

MIT — see [LICENSE](LICENSE).
