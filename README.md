# dsh-peer-bus

**English** · [简体中文](README.zh.md)

Let two independent DSH sessions talk to each other. One addresses the other by id, wakes it up, and can get an answer back — no parent/child relationship required.

```
session A ──bus_send──▶ session B   (B wakes up and runs a turn)
session B ──bus_send──▶ session A   (A wakes up and runs a turn)
```

**Two commands to install, one command to start talking.** Jump to [Install](#install).

---

## What you get

Six tools for the model, one command for you:

| | |
|---|---|
| `bus_roster` | List the sessions this one can reach |
| `bus_send` | Send a message; the target wakes up and runs a turn |
| `bus_ask` | Ask a question and **get the answer back in the same turn** |
| `bus_reply` | Answer a question explicitly, instead of by just finishing the turn |
| `bus_status` | What became of a message you sent |
| `bus_wait` | Take an incoming message instead of letting it run as its own turn |
| `/bus` | A human-only command to grant and revoke permission |

The six tools are **model tools — you never type them**. You tell a session's model what you want in plain language and it picks the right one. See [Your first conversation](#your-first-conversation).

---

## Install

### 1. Check DSH works first

```bash
dsh --version
```

If that fails, fix DSH first. This is a DSH extension and does nothing on its own.

### 2. Install the plugin into a profile

A *profile* is a set of DSH configuration (`web`, `headless`, `tui`, …). Use whichever one you actually start.

**From npm:**

```bash
dsh plugin --profile web add dsh-peer-bus
```

**From a local checkout** — useful if you want to read or modify the source:

```bash
git clone https://github.com/ybh1291747665/dsh-peer-bus.git
dsh plugin --profile web add "$PWD/dsh-peer-bus"
```

Either way, `dsh plugin add` registers the package in that profile's `dsh.profile.bundles`. You do **not** need to edit any YAML by hand.

> **`pnpm` will warn about missing peers** (`@deepseek-ai/dsh-agent` and friends). This is expected and safe to ignore. DSH turns off automatic peer installation and supplies those packages from its own runtime — which is exactly why they are declared as peers rather than dependencies. The plugin must run against the host's copy, not a second one of its own.

### 3. Restart DSH and confirm it is live

Restart the DSH process for that profile, then in any session type:

```
/bus id
```

You should get back that session's own id:

```
This session: session-1a2b3c4d-…
```

If you instead see `unknown /bus subcommand`, or nothing happens, the plugin is not mounted — see [Troubleshooting](#troubleshooting).

### 4. Note that nothing is allowed yet

The plugin ships **default-deny**: installing it grants no session the ability to message another. You say who may talk, with one command, and that is the very next step.

---

## Your first conversation

Five steps, start to finish. You need two DSH sessions — two windows of the GUI, or two `dsh` processes. Same process or different processes both work.

### Step 1 — Get both session ids

In **session A**, type:

```
/bus id
```

Copy the id. Do the same in **session B**. You now have two, for example:

```
session A:  session-1a2b3c4d-…
session B:  session-9z8y7x6w-…
```

### Step 2 — Grant permission, on each side that needs it

**A grant means "this other session may message me."** Run it in the session that will *receive*:

```
# in session A — from now on, B may message A
/bus allow session-9z8y7x6w-…

# in session B — from now on, A may message B
/bus allow session-1a2b3c4d-…
```

A two-way conversation therefore takes **one grant on each side**. This is the receiver's consent, so it is deliberately not something one session can do on another's behalf.

Confirm it took:

```
/bus list
```

### Step 3 — Send a message

Now just talk to session A's model in plain language:

> Send session-9z8y7x6w a message: "the build is green, go ahead and tag the release."

The model calls `bus_send`, and session B **wakes up and runs a turn on that message** — even if it was idle, even if it had never been opened in this process.

What comes back:

```
Delivered msg-… to session-9z8y7x6w (live)
```

`live` means B was already running; `resumed` means the plugin loaded it from disk first. Either way it is awake now.

### Step 4 — Ask a question and get the answer back

`bus_send` is fire-and-forget. When you want an answer **in the same turn**, ask instead:

> Ask session-9z8y7x6w what the current release version is, and tell me what it says.

The model calls `bus_ask`, and the tool result carries the other session's answer:

```
session-9z8y7x6w answered in turn 7:
"4.2.0-rc.7, codename blue-heron."
```

Behind the scenes: the question is delivered with an id, the target runs a turn, and the text of *that turn* is read back and handed to the asking turn. No polling, no second round trip.

**If the target is busy**, `bus_ask` does not hold your turn open forever. It waits `askBusyTimeoutMs` (30 s by default) and then returns:

```
status: pending, askId: ask-…
```

Nothing is lost — the answer arrives later as a normal bus message. See [When the answer comes late](#when-the-answer-comes-late).

### Step 5 — Answer from the other side

On the receiving end, an incoming question simply shows up as a message. The target's model can **just finish its turn** and that turn's text becomes the answer. To answer early and explicitly:

> Reply to the bus question with "yes, all 42 tests pass".

That calls `bus_reply`.

### The whole flow, in one picture

```
you ──"send X a message"──▶ A's model ──bus_send──▶ B
                                                     │
                                            B runs a turn
                                                     │
you ◀──tool result───────────────────────────────────┘

you ──"ask X something"───▶ A's model ──bus_ask──▶ B
                                                     │
                                            B runs a turn
                                                     │
you ◀──the answer, in the same turn──────────────────┘
```

---

## Permission: who may message whom

Two rule shapes, written in the profile's config. Either way, **the receiving side decides.**

### By workspace — the easy one

Sessions in the same workspace may talk:

```yaml
# in the profile's cordis.patch.yml
- id: peer-bus
  config:
    allow:
      - sameWorkspace: true
```

This is the right default for "my own sessions, same project". It does **not** match unrelated projects, and it does **not** match subagents unless you add `includeSubagents: true`.

Narrow it to one project:

```yaml
      - sameWorkspace: true
        cwd: /Users/you/project
```

### By session id — the precise one

```yaml
    allow:
      - from: 'session-1a2b3c4d-…'   # the sender
        to: 'session-9z8y7x6w-…'     # the receiver
```

`'*'` matches anything, and a trailing `*` is a prefix match (`'session-worker-*'`). It is not a glob — `*` only means something at the end.

A session id is a fresh UUID, so this shape can only be written once both sessions exist. That is why `/bus` exists.

### At runtime — `/bus`, no restart

Run inside a session. This is human-only and deliberately **not** exposed to any model:

| Command | Effect |
|---|---|
| `/bus id` | Print this session's own id |
| `/bus list` | Show every grant this session is part of |
| `/bus allow <session>` | Let that session message **this** one |
| `/bus revoke <session>` | Take that permission back |

Grants are durable — they survive a restart. `/bus revoke` can only remove what `/bus allow` added; a rule written in the profile config has to be removed there, and the command tells you when that is the case.

### Why default-deny

A bus message is delivered as a **user message**, and a model treats user messages as instructions. A bus that starts open is therefore a prompt-injection path: any session — including a subagent you spawned to read an untrusted file — could instruct your main session. So permission is explicit, and it belongs to the side that gets interrupted.

---

## The tools

You rarely name these; the model picks them. The details matter when you are reading a result or debugging one.

| Tool | Arguments | What it does |
|---|---|---|
| `bus_roster` | none | Lists reachable sessions — id, title, live or stored, status, workspace. What "reachable" means is set by the `rosterScope` config key. |
| `bus_send` | `target`, `text`, `mode` | Delivers a message. `mode: 'followup'` (default) queues a new turn; `mode: 'steer'` interrupts the target's current turn at its next step. |
| `bus_ask` | `target`, `text`, `timeoutMs` | Asks and waits. Returns the answer, or `pending` with an `askId`. |
| `bus_reply` | `text` | Answers the question this session is currently running. Needs no id — one question per turn. |
| `bus_status` | `messageId` | `queued` → `claimed` → `received` / `discarded`, plus the turn number and latency. |
| `bus_wait` | `from`, `askId`, `timeoutMs` | Waits for a message rather than letting it run a turn. |

### Addressing

By full id, by an unambiguous id prefix, or by title. If a title matches more than one session the tool refuses and lists the candidates instead of guessing. Titles are only known for **live** sessions — a stored row shows none, because reading a title means a log read per row.

### When the answer comes late

If `bus_ask` returned `pending`, nothing is broken — the answer simply did not arrive inside the wait. The ask stays registered and the answer is delivered as an ordinary bus message tagged with the same `askId`. You can also block on it explicitly with `bus_wait`.

### Why `bus_ask` refuses some questions

Every in-flight ask is an edge in a "who is blocked on whom" graph. An ask that would close a loop is rejected up front, naming the chain, instead of deadlocking:

```
bus_ask rejected (ask-cycle): asking "session-bob" would close a wait cycle
(session-bob -> session-alice -> session-bob); one side must answer with bus_send instead of bus_ask
```

Ordinary `bus_send` conversations are not part of that graph and stay unbounded — they are limited only by the rate ceiling.

---

## Configuration

Set these under the `peer-bus` row in the profile's `cordis.patch.yml`. **A patch replaces the whole `config` block**, so restate every key you still want:

```yaml
- id: peer-bus
  config:
    allow:
      - sameWorkspace: true
    maxMessageBytes: 16384
```

| Key | Default | Meaning |
|---|---|---|
| `allow` | `[]` | Permission allowlist. **Empty permits nothing.** |
| `maxMessageBytes` | `16384` | Maximum UTF-8 bytes in one message. |
| `maxSendsPerWindow` | `10` | Send ceiling per sender→target pair per window. A failed delivery does not count. |
| `rateWindowMs` | `60000` | Length of that window. |
| `rosterScope` | `'allowed'` | What `bus_roster` shows: `'allowed'` = the caller plus what it may message; `'all'` = everything, flagged allowed or not. |
| `waitTimeoutMs` | `60000` | Default wait for `bus_wait`, and for `bus_ask` when the target is idle. |
| `maxWaitMs` | `600000` | Upper bound on any wait, so one call cannot hold a turn open forever. |
| `askBusyTimeoutMs` | `30000` | How long `bus_ask` waits on an already-running target before returning `pending`. |
| `resumedIdleMs` | `600000` | Release a session the bus resumed *itself* after this much idle time, freeing its log lock. `0` keeps it loaded. Sessions resumed through the host's own lookup are host-owned and unaffected. |

---

## Cross-process

**Off by default.** With it off, a session open in *another* DSH process shows as stored and cannot be reached. Turn it on and those sessions become reachable too.

```yaml
- id: peer-bus
  config:
    crossProcess: true
```

Set it in **every** process that should take part. Then:

- `bus_roster` shows peer-held sessions marked remote, and `bus_send`, `bus_ask`, `bus_reply`, and `bus_status` all work across the boundary.
- **The receiving process still decides.** It re-runs its own allowlist, archive check, and rate ceiling, so a grant made in one process governs that process's sessions only. A cross-process pair needs nothing written into the sender's config.
- If the peer cannot be reached in time, nothing fails silently: `bus_send` says the outcome is **unknown** and gives you the id to check with `bus_status`. Resending is safe — the receiver recognises a repeat of a delivery id it has already taken.

| Key | Default | Meaning |
|---|---|---|
| `crossProcess` | `false` | Reach sessions held by another DSH process over a local socket. |
| `crossProcessTimeoutMs` | `2000` | Timeout for one remote control-plane query. |
| `crossProcessDeliverTimeoutMs` | `60000` | Timeout for one forwarded delivery, which may need a cold resume on the far side. |
| `crossProcessRosterCacheMs` | `3000` | How long "which peer holds what" may be reused. A stale answer is self-correcting. |

**The trust boundary is "the same OS user, over the same `DSH_HOME`."** Peers are discovered through files only that user can read (`0700` directory, `0600` files). The socket is local — no network listener, no port. Enabling the transport grants nothing by itself: an empty `allow` list still permits nothing.

---

## Troubleshooting

**`/bus` is not recognised.**
The plugin is not mounted in the profile you are running. Check that the `--profile` in your install command is the profile you actually start, then restart DSH.

**`denied` — "not permitted to message".**
No rule covers the pair. Run `/bus allow <the other id>` **in the receiving session**, or add a `sameWorkspace` rule to the profile. Remember a two-way conversation needs one grant on each side.

**`unknown-target` — "no session matches".**
The id is wrong, or the target has no session log yet. Run `/bus id` in the other session and copy it again.

**`target-busy`.**
Another DSH process holds that session's log and is not reachable. Either enable `crossProcess` in both processes, or send from the process that has the session open.

**`target-archived`.**
That session is archived. Archiving is the durable "do not wake me" flag, so unarchive it first.

**`rate-limited`.**
The pair sent more than `maxSendsPerWindow` within `rateWindowMs`. This ceiling exists so two auto-replying agents cannot loop forever spending tokens. Raise it if you really are talking that fast.

**`message-too-large`.**
Over `maxMessageBytes` (16 KB by default). Send a pointer to a file rather than the file.

**The answer never came back, and `bus_ask` said `pending`.**
Nothing is broken. `bus_status` shows what happened, and the answer arrives later as a normal message.

---

## Known limitations

- **Cross-process reach is opt-in.** With `crossProcess: false`, every delivery path is process-local. The transport is a Unix domain socket (a Windows named pipe) and never crosses a machine.
- **A peer that has not enabled the transport is invisible.** Discovery is per `DSH_HOME` and per opt-in, so a process running an older build, or one with `crossProcess` off, simply is not there. A send to a session it holds is refused with `target-busy`, and the message says why.
- **Cold-resumed agents are released when idle — on the fallback path.** A session the bus resumed itself is released after `resumedIdleMs` (10 min) of quiet, which frees its log lock; the next message resumes it again. A session resumed through the host's own lookup (`web`) is host-owned and never unloaded by the bus.
- **The route is inferred, not declared.** Cold resume recovers the provider, model, and reasoning effort from the session's last request event. A session that never made a model request has no recorded route, and the resumed turn will be empty.
- **The roster is rebuilt from persistence on every send**, so the cost grows with the number of *stored* sessions rather than live ones — about 135 ms at 1,123 stored sessions, paid again on each send. A live-first lookup is the obvious fix and is deliberately deferred rather than overlooked.
- **Receipts track delivery, not intent.** `bus_status` can say a message was claimed into a turn — not whether the target did what it asked. Receipts are process-local and do not survive a restart.
- **`bus_wait` consumes.** It takes the message out of the inbox so the same content cannot also run as its own turn. That is deliberate: a peek would deliver twice, waste a turn, and let two sessions that both wait on each other ping-pong until the rate ceiling stops them.
- **Real-model verification is a separate, paid check.** Every check except `real-model-check` and `real-model-xproc` uses a scripted stub model and runs offline.

---

## How it works

For contributors and the curious. Everything above works without reading this.

<details>
<summary><b>Delivery never appends to a session log directly</b></summary>

The session log is a projection, not the driver: appending to it does **not** wake anything, because the live driver reads its in-memory inbox. So delivery always goes through the live `Agent` API — `followup()` for a new turn, `steer()` to interrupt at a step boundary. A stored session is cold-resumed first. Because `followup`/`steer` record their own `agent/inbox/spliced` event, durability comes for free: the message survives a restart with no second mailbox to maintain.

A delivered message carries its own `peer-bus-message` source kind rather than reusing `dsh-subagent`'s, so bus traffic stays distinguishable from parent/child traffic in the transcript and in `bus_wait`.
</details>

<details>
<summary><b>Cold resume has to restore the model route and the agent preset</b></summary>

A resumed agent has no route of its own, so without `agentOptions` the loop has no provider or model and the turn runs no step and calls no model — a silent no-op that still looks like a successful delivery. The bus reads the route from the newest `request/header` event (falling back to `request/context`).

A route is only half of a session's composition. A preset supplies the persona (system prompt), the instructions loader, and some tools, so a resume that skips the mount runs on the **wrong system prompt and a reduced toolset**, and nothing reports it. The preset id comes from the registry's own `agentPreset` projection, falling back to `session.header.agentPreset`.

Which resume path runs depends on the composition: with a session controller mounted (the web bundle) the bus goes through the host's Typert `agent` lookup — the path the GUI uses, leaving the lifecycle host-owned. `dsh-agent` registers that lookup everywhere, but its resolver only answers for an already-live agent, so the discriminator is the *answer*, not the presence. `npm run boot-check` prints which path a profile gets.
</details>

<details>
<summary><b>Cross-process resume is single-winner, and the bus makes it so</b></summary>

The persistence layer's cross-process lock guards *write handles*, and `agents.resume` does not take one — so two processes told to resume the same stored session would both succeed and both believe they own it. The bus arbitrates among the only processes that can be contending: before resuming, a process claims the session with an atomic `open(…, 'wx')` under `$DSH_HOME/peer-bus/claims/`. The winner resumes; the loser waits for the winner to actually hold the session and then **forwards the message to it**, so nothing is dropped. A claim whose pid is gone is taken over, a claim is returned if the resume fails, and it is released when the session is released.
</details>

<details>
<summary><b>Frames are buffered as bytes, not strings</b></summary>

Decoding each arriving chunk on its own splits any multi-byte character that straddles a chunk boundary into replacement characters. A 30 KB write arrives as several chunks, so a large Chinese message would be corrupted — and so would a question and its answer, which travel the same way. Nothing is decoded until a whole line is in hand; a line boundary can never fall inside a character, because no UTF-8 continuation or lead byte is `0x0A`.
</details>

<details>
<summary><b>Service lookups are resolved before the first <code>await</code></b></summary>

Cordis rebinds `this.ctx` to a per-call shadow while a service method runs, and that shadow is only good for the synchronous part of the call: a lookup made after an `await` that crosses a macrotask fails, as `undefined` or as `cannot get required service "x" in inactive context`. The bus therefore resolves what a method needs into locals up front and keeps its construction-time context in `pluginCtx`.
</details>

---

## Verification

```bash
npm run link-dev-deps   # once: symlink @deepseek-ai/* from a local DSH install
npm run test-home       # once: build the throwaway profiles under .dsh-test

npm test                # 277 unit tests
npm run boot-check      # the plugin mounts and registers its six tools
npm run boot-check:web  # the same on the web profile, binding no port
npm run e2e             # two sessions hold a real conversation, stub model
npm run e2e:web         # the same on the web profile (host resume path)
npm run restart-e2e     # that conversation survives a real process restart
npm run e2e:xproc       # two real DSH processes, claim contention, idle release

# These two call a real model and cost money:
npm run real-model-check
npm run real-model-xproc
```

Every check except the last two is offline — no network, no model calls. `DSH_HOME` is forced to `.dsh-test` by `scripts/dsh-home.mjs`, which each script imports first, so **the checks never touch your own `~/.dsh`**. Set `BUS_TEST_DSH_HOME` to point them elsewhere.

The records of passing real-model runs — including what they prove and what they do not — are in [`verification/`](verification/).

---

## Requirements

DeepSeek Harness `>=0.1.7-rc.2 <0.3.0-0`, verified on `0.1.7-rc.2` and `0.2.0-rc.2`.

Since 0.2.0, DSH checks every `@deepseek-ai/dsh*` peer range against the running version at boot and **refuses to mount a plugin that does not match**, so this range has to cover the host you run. It stops before 0.3.0 because a 0.x minor release may change plugin APIs; re-run the checks above before widening it.

The plugin declares `@deepseek-ai/*` packages as `peerDependencies` so it resolves them from the host install rather than bundling a second copy. `dsh-invariants`, `dsh-session-query`, `dsh-home-paths`, and `zod` are marked optional, because the capabilities that use them are optional.

---

## Publishing notes

- **No `lib/` build.** DSH packages compile TypeScript to `lib/`; this one is plain ESM JavaScript under `src/`, so there is no compile step and no `.d.ts`. The `exports` map follows the same shape (`./invariant`, `./package.json`) but points at `src/`.
- **The npm tarball ships `src/`, the bundle patch, both READMEs, `USAGE.md`, and `LICENSE`.** Tests, scripts, and the verification records stay in the repository; run the checks from a checkout.
- **No `README.i18n.yaml`.** The DSH monorepo records per-section hashes for translation pairing, but that tool is not published, so the bilingual pair here — [README.md](README.md), [README.zh.md](README.zh.md) — is not hash-recorded. Do not hand-write that file: fabricated hashes would fail their verification.

---

## License

MIT — see [LICENSE](LICENSE).
