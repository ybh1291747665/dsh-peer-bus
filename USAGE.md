# Using dsh-peer-bus

A task-oriented guide. For what the plugin is and how it works internally, see [README.md](README.md).

## 1. Install and confirm it is live

```bash
dsh plugin --profile web add /absolute/path/to/dsh-peer-bus
```

The package declares `dsh.bundle.patch`, so this registers it in the profile's `dsh.profile.bundles` and the plugin mounts itself on the next boot. Confirm:

```bash
grep dsh-peer-bus ~/.dsh/profiles/web/package.json
```

Then **restart DSH**. Registering tools is not a config hot-reload.

Once up, ask any session to run `bus_roster`. If the tool exists, the plugin is mounted. It lists the calling session's own row (marked `you`) plus every session it is allowed to message — live ones first, then stored ones — with each id, whether it is loaded, its workspace, and whether it is a subagent. Under the default-deny policy that is just the caller's own row, which is how you learn a session's id for an id rule. Set `rosterScope: 'all'` to list every session the process can see instead.

## 2. Decide which sessions may talk

The plugin ships **default-deny**: `bus_roster` works, but `bus_send` refuses every pair until you allow it. That is deliberate — a bus message is delivered as a *user message*, and a model treats user messages as instructions, so a permissive bus is a prompt-injection path.

There are two ways to allow a pair. Add rules to `~/.dsh/profiles/web/cordis.patch.yml`, then restart — or, once both sessions exist, use `/bus` from inside a session and skip the restart entirely.

### Fastest: `/bus` from inside a session

```
/bus id                    show this session's id
/bus list                  who may message this session, and why
/bus allow <session>       let <session> message this session
/bus revoke <session>      take that back
```

`<session>` is a full id or an unambiguous id prefix, resolved the same way `bus_send` resolves a target.

**The grant is receiver consent.** `/bus allow <peer>` run in session A means *that peer may message A* — each side's user decides who may instruct it, so a two-way conversation takes one grant on each side. If you are setting up a pair, run `/bus allow <other-id>` in *both* sessions.

Runtime grants are additive to the config and persist across restarts (they are written to a `peer_bus_allowlist` storage domain). `/bus revoke` can only take back a grant made this way; when the config still permits the pair it says so instead of claiming success.

No model tool can change the allowlist. `/bus` is on the human command registry only, and a bus message whose body begins `/bus allow …` is delivered as text — it is never executed.

### Easiest: allow by workspace

```yaml
- id: peer-bus
  config:
    allow:
      - sameWorkspace: true
    maxMessageBytes: 16384      # a patch replaces the whole config; keys you
    maxSendsPerWindow: 10       # leave out fall back to their defaults
    rateWindowMs: 60000
```

Any two sessions working in the **same directory** may now message each other. This needs no session ids, so it works for sessions you have not created yet — open a second chat in the same project and the two can talk immediately.

It is also narrower than a wildcard: a session in an unrelated project does not match, and neither does a **subagent** — a child inherits its parent's directory, so letting it match would let a subagent reading untrusted input instruct your main sessions. Opt subagents in explicitly only if you need them on the bus:

```yaml
allow:
  - sameWorkspace: true
    includeSubagents: true
```

To narrow the rule to exactly one project, name it:

```yaml
allow:
  - sameWorkspace: true
    cwd: '/Users/you/project'
```

Both sessions need a *recorded* workspace. Two sessions whose working directory DSH did not record are treated as unlocated, not as "the same workspace", so the rule refuses them rather than authorizing everything.

### Precise: allow by session id

Use this when the two sessions are in different projects, or when you want to name exactly who may talk to whom. Get each id by asking that session to run `bus_roster` — its own row is marked `you`.

```yaml
allow:
  - from: 'session-abc'
    to: 'session-def'
  - from: 'session-def'      # rules are one-directional:
    to: 'session-abc'        # allow both ways for a conversation
```

A pattern matches exactly, as a trailing-`*` prefix, or as `'*'` for any:

```yaml
allow:
  # a pool of workers may all report to one coordinator
  - from: 'session-worker-*'
    to: 'session-coordinator'
  # and the coordinator may answer any of them
  - from: 'session-coordinator'
    to: 'session-worker-*'
```

Patterns are not globs — `*` is only meaningful at the end.

### Mixing them

Both shapes can appear in one list, and a pair is allowed if **any** rule covers it:

```yaml
allow:
  - sameWorkspace: true                      # anyone in this project
  - from: 'session-abc'                      # plus this one cross-project pair
    to: 'session-in-another-repo'
```

## 3. Have two sessions talk

In session A, ask it to message session B. The model calls `bus_send` with B's id from `bus_roster`:

```
Send session-def a message asking what it is working on.
```

What happens:

1. `bus_send` resolves the address, checks the allowlist and the rate ceiling.
2. If B is loaded, it is woken; if B is only stored, it is resumed from its log first.
3. B runs a turn with your text, attributed to A's session id.
4. A can wait for the answer with `bus_wait`.

You do not have to drive both sides by hand. If both sessions are told to reply with `bus_send`, they hold the conversation themselves — that is what the e2e test demonstrates.

### Reading the transcript

A bus message appears in the recipient as a user message beginning `Agent <sender-session-id> sent a message:`. Its source kind is `peer-bus-message`, so it is distinguishable from `dsh-subagent`'s parent/child traffic both in the log and in `bus_wait`.

Two variants exist for `bus_ask`. A question begins `Agent <id> asked you a question:` and ends with a note that the reply in this turn is returned to the asker automatically — without that note, a real model tends to answer *and* re-send the answer with `bus_send`, delivering it twice. A late answer to a pending ask begins `Agent <id> answered your earlier question:`.

## 4. Choose the delivery mode

| Mode | When to use it |
|---|---|
| `followup` (default) | Normal request/reply. The message becomes its own turn. |
| `steer` | The target is mid-task and the message should reach it at its next step boundary rather than waiting for a whole turn. |

`steer` on an idle target starts a turn, so it is safe to use without checking the target's state first.

## 5. Take a reply

`bus_wait` blocks until the next bus message addressed to the calling session arrives, optionally filtered to one sender:

```
Wait for a bus message from session-abc.
```

**It consumes the message.** The delivery is taken out of the pending inbox, so the same content will not also run as its own turn.

- It returns as soon as the delivery is recorded, and returns **immediately** if a matching message is already parked in the inbox. That second part matters: `bus_wait` runs inside a turn, so a message delivered earlier in that same turn is sitting in the inbox and has no transcript entry yet.
- `from` takes a full session id or an unambiguous prefix, like `bus_send`'s target.
- Pass `timeoutMs` to bound the wait. The default is the configured `waitTimeoutMs` (60 s), and any value is capped at `maxWaitMs` (10 min).
- Cancelling the tool call (interrupting the turn) rejects rather than hanging.
- It reports only this package's own traffic, so `dsh-subagent` parent/child messages are left in place.
- It never takes a `bus_ask` **question** addressed to this session. That question belongs to the turn that answers it; taking it here would leave the asker waiting until its timeout.
- It takes **one** message. If two arrive, the second still runs as its own turn.

### When *not* to use it

If you only want the reply and have nothing else to do, **do not call `bus_wait`** — the reply arrives on its own as your next turn. Calling it as well is what creates the duplicate delivery this tool exists to avoid.

Two sessions that both call `bus_wait` waiting on each other will sit until the timeout expires. Pick one side to be the waiter, or have the initiator wait and the responder just reply.

## 6. Ask a question and get the answer back

`bus_send` + `bus_wait` works, but it makes the caller do the work: it has to know to wait, and a reply that arrives on its own becomes a separate turn. `bus_ask` is the one-step version.

```
bus_ask { target: "<id>", text: "what is the deploy status?" }
  → status "answered", text: "<their answer>", turn: 3
```

The answer is read from **the turn that claimed the question**, so an unrelated turn that happens to run later is never mistaken for it. The ask id travels on the question itself, which is why the correlation cannot race the delivery.

If the target was **already running** when you asked, you get `{status: "pending", askId}` after `askBusyTimeoutMs` (default 30s) instead of a long wait. The answer still comes — as a bus message tagged with that ask id:

```
bus_wait { askId: "ask-abc-1" }
```

An idle target is given the full `waitTimeoutMs`, because it can start your question's turn right away.

Two sessions that ask each other would deadlock, so a second ask that would close the loop is refused up front:

```
bus_ask rejected (ask-cycle): asking "session-bob" would close a wait cycle
(session-bob -> session-alice -> session-bob); one side must answer with bus_send instead of bus_ask
```

This is not a hop cap — ordinary `bus_send` conversations are still unbounded. Only *blocking* waits are tracked, and a timed-out or cancelled ask releases its edge immediately.

If the target wants to answer with something other than its turn's text, it can call `bus_reply { text }` — it needs no ask id, because a session answers one question per turn.

### Check what happened to a message

`bus_send` returns a `messageId`. To see what became of it afterwards:

```
bus_status { messageId: "<id from bus_send>" }
  → status "claimed", turn: 4, latencyMs: 12
```

| Status | Meaning |
|---|---|
| `queued` | In the target's inbox; the target is busy and has not taken it yet. |
| `claimed` | A turn took it (the turn is reported). |
| `received` | The target took it with `bus_wait`. |
| `discarded` | Dropped before any turn ran it, e.g. the target's run was cancelled. Send it again if it still matters. |
| `unknown` | Not a message you sent, or it is no longer remembered — receipts keep the newest 1,000 and do not survive a restart. |

Only the sender can read a receipt. `claimed` means a turn took the message, not that the target did what it asked; use `bus_ask` when you need the answer.

## 7. Understand the limits before relying on it

- **Cross-process reach is opt-in.** By default two sessions in *different* DSH processes cannot reach each other, and a send to a session open elsewhere is refused with `target-busy`. Set `crossProcess: true` in both processes and they can, over a local socket — no network, no port, and nothing is granted that the allowlist did not already allow.
- **Waking a stored session loads it.** On a profile where the bus resumes sessions itself (no host lookup, e.g. `headless`), it releases such a session after it has been idle for `resumedIdleMs` (default 10 min), which frees its log lock for other DSH processes; the next message resumes it again. Set `resumedIdleMs: 0` to keep them loaded. On `web`, resumes go through the host's own path and the session is host-owned, exactly like one opened in the GUI.
- **The route is inferred.** Cold resume recovers provider, model, and reasoning effort from the session's last `request/header` event (or its last `request/context`). A session that never made a model request has no recorded route, and the resumed turn will be empty.
- **Receipts track delivery, not intent.** `bus_status` tells you whether a message was taken into a turn, taken by `bus_wait`, or discarded — not whether the target acted on it. Receipts are process-local.
- **Roster cost grows with stored history.** Every send and ask rebuilds the roster from persistence, so the work scales with the number of *stored* sessions rather than live ones — about 135 ms at 1,123 stored sessions on this repository's test home, paid on each send. Live-first lookup is the fix, and it is deliberately deferred rather than overlooked.
- **Rate ceiling.** Each sender→target pair is capped at `maxSendsPerWindow` per `rateWindowMs` (default 10 per minute); a send that fails to deliver does not count. This exists so two auto-replying agents cannot loop forever spending tokens on every hop. It bounds the rate, not the length, of a conversation. If you hit `rate-limited`, the pair is talking more than a human would.

## 8. Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `bus_*` tools do not appear | The plugin is not mounted, or DSH was not restarted. Check `grep dsh-peer-bus ~/.dsh/profiles/web/package.json` and restart. |
| `denied` | No allow rule covers this pair. Id rules are directional — add the reverse rule too. A `sameWorkspace` rule refuses sessions in different directories, sessions with no recorded workspace, and subagents unless the rule sets `includeSubagents: true`. |
| `unknown-target` | The address matches no session. Run `bus_roster`. |
| `ambiguous-target` | A short prefix matched several sessions. Use a longer id. |
| `rate-limited` | The pair exceeded `maxSendsPerWindow`. Wait out `rateWindowMs` or raise the ceiling. |
| `resume-unavailable` | No session persistence backend is mounted, so stored sessions cannot be woken. Live sessions still work. |
| `target-busy` | The target is open in another DSH process, which holds its log lock. Message it from that process, or close it there first. |
| `ask-cycle` | Asking this target would close a wait loop: the target is already blocked inside a `bus_ask` that leads back to this session. One side has to use `bus_send` + `bus_wait` instead. |
| `no-pending-ask` | `bus_reply` was called when no `bus_ask` from another session is in flight here. |
| `target-archived` | The target is in the workspace registry's archive set. Unarchive it in the GUI before messaging it. The refusal happens before any resume, so the archived session was not woken. |
| `resume-failed` | The stored log could not be loaded. The message names the underlying error. |
| `delivery-failed` | The target's driver rejected the message (for example it was unloaded mid-send). Nothing was delivered and the rate slot was refunded; retry. |
| `bus_ask` returns `pending` although the target was sitting in `bus_wait` | Expected: a `bus_wait` never takes a question meant for its own turn. The question runs as the target's next turn once its `bus_wait` returns, and the answer arrives as a bus message tagged with the ask id. |
| `bus_status` says `unknown` for a message you just sent | Receipts are per process and only readable by the sender. A restart, or more than 1,000 newer messages, forgets it. |
| The target runs a turn but does nothing | The resumed session had no recorded model route. See the limits above. |
| `message-too-large` | The body exceeded `maxMessageBytes` (default 16 KiB). |

## 9. Verify a deployment yourself

The package ships the checks it was developed against. All of them are offline: no network and no model calls.

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

`npm run e2e` also proves the `./invariant` companion activated, and runs the
invariant across the whole conversation as a false-positive test. It drives
`bus_wait` from a model tool call inside a real turn, which is the only way to
exercise DSH's rule that nothing may append to a session while one of its
events is still being published.

`npm run e2e` mounts the **real** workspace registry — which only the web bundle
ships — so the archive refusal is exercised against the genuine service rather
than a stub: a stored target is refused with `target-archived` and never resumed,
a live archived target is refused the same way, and unarchiving restores
reachability. The plain `boot-check` on the headless profile is the opposite
half: with no registry mounted, nothing is archived and behaviour is unchanged.
