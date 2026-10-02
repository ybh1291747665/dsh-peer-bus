# Real-model cross-process check — 2026-10-02

**Command:** `npm run real-model-xproc`
**Result:** 11 checks passed, 0 failed, 1 observation — twice, consecutively (exit code 0 both times).

## What this proves that the stub e2e cannot

`scripts/e2e-xproc.mjs` proves the transport with a scripted `LlmAdapter`: two real OS
processes, real socket, real registry, but a stub model. It cannot show that a message
arriving from another process wakes a **real model turn** in the process holding the
session, because a stub never runs one.

This check does. The host process holds a session on the real route; this process asks
it a question with `bus_ask`; the answer is produced by the real model **in the host
process**, captured there, and pushed back over the socket.

## Setup

| | |
|---|---|
| Route | `opencode-go` / `deepseek-v4.1-flash`, `reasoningEffort: low` |
| Credentials | read from `~/.dsh/.credentials.yaml` into this process only |
| Overlay | `$DSH_HOME/real-model-xproc.patch.yml` — the real profile's `llm-pi-ai` and `agent-default-model` rows plus a `peer-bus` row with `crossProcess: true` |
| Profiles | both processes boot `web` + `web-noserver.patch.yml` |
| Workspace | one shared temp directory, resolved through `realpath` (see below) |
| Prompt | `Reply with exactly one short sentence: what is 17 multiplied by 3?` — it never names a bus tool |

## Results

| Check | Observed |
|---|---|
| The other process's real session appears in the roster | — |
| It is marked remote rather than stored | `host=remote` |
| `bus_ask` across processes did not fail | — |
| The question was answered rather than left pending | `status=answered` |
| The answer came back with content | `"17 multiplied by 3 equals 51."` (run 1), `"17 multiplied by 3 is 51."` (run 2) |
| The answer is the real model's arithmetic | `51` present |
| The answer carries the turn it came from | `turn=1` |
| A plain send is forwarded too | `targetState=remote` |
| The receipt is read back from the process that holds it | `status=claimed` |
| The killed process is no longer reported as live | `host=undefined` |
| Its session is still known from persistence | — |
| *Observation:* this process saw none of the host turn's events | `events=0` |

The observation is the load-bearing one. `events=0` means this process recorded no
session events for the host session at all — so the answer could not have been read
locally. It exists here only because the host process captured it and pushed it back.

The two runs produced different wording (`equals` vs `is`), which is itself evidence
that a real model answered rather than a fixture.

## Two real bugs this check found

Neither would have surfaced in the stub e2e, and both are the kind that only appear
once two processes genuinely run:

1. **macOS `/var` is a symlink to `/private/var`.** The orchestrator put both sessions
   in a `mkdtemp` directory, passing the string `/var/folders/...`; the host process's
   `process.cwd()` reports the physical path `/private/var/folders/...`. The
   `sameWorkspace` rule compares normalized cwd strings, so the pair was refused with
   `denied` even though both sessions were genuinely co-located. Fixed by resolving the
   workspace through `realpath` and passing it to the child explicitly, rather than
   letting it re-derive the path.

2. **A failing check left the host process running.** The script killed the host only
   on the happy path, so the first crash (an uncaught `denied`) abandoned a DSH process
   holding a session, a socket, and a registry entry — which the next run would see as a
   peer nothing owns. Fixed with `exit` / `uncaughtException` / `unhandledRejection`
   handlers that kill it on every path. Verified by injecting a failure after the host
   started: exit code 1, no orphan process.

## What this does not prove

- It is a **single pair of processes on one machine**. Nothing here exercises three or
  more processes, or two processes racing for the same session.
- It does **not** measure model behaviour. Which tool the model chose is not asserted,
  because the prompts never name one; the mechanism checks are the assertions.
- It costs real tokens and is therefore not part of `npm test` or the default e2e set.

---

## Follow-up: three processes, and contention (2026-10-02, later)

`npm run e2e:xproc` was extended to spawn **three** peer processes and to stage a
contention race. The free suite now covers:

| Check | Result |
|---|---|
| Three peers each appear in the roster, marked remote | PASS |
| A send is forwarded to a peer (not cold-resumed) | PASS |
| The receipt is read back from the peer that holds it | PASS |
| An unrelated session cannot read that receipt | PASS |
| After one peer is killed: it stops being remote, its log survives, **and the other two are still remote** | PASS |
| After the next peer is killed: its session is stored and held by nobody | PASS |
| *Observation:* only one process came away holding the contended session | **NOTE — SPLIT-BRAIN: 2 processes both report they resumed it** |
| Neither contender was told the resume simply failed | PASS |
| Every contender got a recognised outcome | PASS |

### The bug this found, and why it is not fixed

Two real processes, told to deliver to the same stored session at the same instant,
**both** cold-resumed it and **both** came away with a live agent in `running` state.

The persistence layer does have a real cross-process lock — a non-blocking `flock(2)`
on `session.lock`, whose contention maps to `SessionAlreadyOwnedError` — and this
plugin maps that to `target-busy` correctly wherever it surfaces. But the lock guards
**write handles**, and `agents.resume` does not take one, so a resume cannot fail on
ownership and the bus has no signal to act on.

Measured impact: the contended session's log contained only its header record, with no
sign of two writers. The risk is therefore two agents racing over one session, not
corrupted history — but the window is real and reachable whenever a stored session
held by nobody is messaged by two processes at once.

It is recorded as an observation rather than asserted, because a hard assertion that
resume is exclusive would be asserting something the layer below does not provide.
Closing it needs a claim protocol between peers (exclusive claim, then re-check the
roster, with a deterministic tie-break, held for the lifetime of ownership); this
package does not implement one, and shipping one unverified would be worse than
documenting the gap.

### Bugs found while building this, all fixed

1. **Three-process wait cycles were undetectable.** A wait edge lives in the *asker's*
   graph, so the receiver knew only that it had been asked, never who was blocked
   behind it — `upstreamOf` on the third process was empty and the cycle passed. Fixed
   by recording the wait edges a question implies on the receiving side (the asker, and
   everyone the asker reported), and releasing them when the ask settles, is cancelled,
   or hits its ceiling. Covered by a three-bus test and by a test that a released edge
   does not block a later, legal question.
2. **The contention phase script sent from a bare session id** rather than a live agent,
   so the contender was refused as `unauthorized` before touching any lock and the race
   silently did not happen. The `every contender got a recognised outcome` check caught
   it.
3. **The contender's argv was assembled in the wrong order**, so it addressed the race
   timestamp as a session id (`unknown-target`). Caught by the same check.
