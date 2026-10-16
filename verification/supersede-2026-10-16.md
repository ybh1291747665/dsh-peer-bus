# Supersede real-machine check — 2026-10-16

**Command:** `npm run e2e:supersede` (also `npm run e2e:supersede:web`)
**Result:** 28 checks passed, 0 failed — six consecutive runs on the headless profile and
one on the web profile (exit code 0 every time).

This closes the gap recorded in `HANDOVER.md` §5.1: `supersede` was covered by nine unit
tests against a **fake** inbox, so all they could assert was the mutation the bus *asks
for*. Nothing had ever shown what the real host does with that request.

## What this proves that the unit tests cannot

The real `Inbox.replace` lives in `@deepseek-ai/dsh-agent-loop`. Against a real `Agent`
with the real durable inbox and the real driver, the check shows the whole chain the unit
tests can only imitate:

- the `bus_send { supersede: true }` **tool argument** reaches the inbox (the tool's
  hand-off of `supersede` had no test coverage at all before this);
- the real `replace` reports `true` and the message really leaves the real queue;
- the cancellation is **durable**: the session log records
  `agent/inbox/spliced { outcome: 'canceled', removedCount: 1 }`;
- the superseded message **never runs** — it appears in no `agent/inbox/claimed` event,
  in no `user/message` transcript event, and in no assembled model request;
- the receipt book hears the host's own `agent/inbox/discarded` event and reports
  `discarded`, which the unit test explicitly could not do ("the fixture cannot dispatch
  the inbox's own event");
- the result the model reads says `Replaced the previous message with …`, not `Delivered …`.

## The finding: the window only exists while the target is busy

`HANDOVER.md` §4 and `USAGE.md` both described an idle target as claiming a message "in
about 1 ms", which reads like a small but real window to withdraw in. It is not a window.

`ReactLoopAgent.followup()` calls `inbox.splice` and then `wakeDriver()`, and
`wakeDriver` → `kick()` → `turn()` → `preStep()` reaches `inbox.claim()` **before the
first `await`**. So on an idle target the claim happens synchronously *inside* the
`bus.send` call that delivered the message. The "1 ms" is the receipt bookkeeping around
that claim (`sentAt` → `settledAt`), not time in which anything could be withdrawn.

Scenario B sends twice back to back — no model round trip between them, 0 ms apart — and
`replaced` is `false` every time, in every round, on both profiles:

| Round | Gap between the two sends | Receipt latency | Claim before `bus.send` returned | `replaced` |
|---|---|---|---|---|
| 1 | 0 ms | 0–1 ms | yes | `false` |
| 2 | 0 ms | 1 ms | yes | `false` |
| 3 | 0 ms | 0–1 ms | yes | `false` |

The practical consequence, now written into `USAGE.md`: **`supersede` works only against
a target that is mid-turn.** That is also why the earlier manual attempts failed — the
model round trip between two tool calls was never the (only) obstacle; on an idle target
there is no window at any speed.

Scenario A therefore holds a turn open deliberately, and proves the window is genuinely
open rather than won by a microsecond race:

| Check | Observed |
|---|---|
| The target is running a turn, so it cannot claim | `status=running` |
| The first message stays pending while the target is busy | `pendingFromYou=1` |
| It is **still** pending 150 ms later | `pending=[the same message]` |
| The real inbox then holds exactly the correction | `pending=[correction]` |
| The superseded message is gone from the real inbox | — |
| The log records a `canceled` splice inserting the correction | `removedCount=1` |
| The superseded message is reported `discarded` | `status=discarded` |
| It waited in the queue until the turn ended, then was claimed | `claimedAt >= releasedAt` |
| The target never saw the superseded instruction | — |
| The target ran the correction exactly once | 1 model call |
| It never entered the transcript; the correction did | — |
| It was never claimed by any turn | 0 claims |
| The correction was claimed by a real turn | `turn=2` |

The superseded message ran in **no turn at all**, and the correction ran in turn 2 — the
turn opened after the held one ended. Measured window in the recorded run: the stale
message sat pending 219 ms and the correction 8 ms before a turn claimed it.

## Why the two scenarios cross-validate

Scenario B's `replaced: false` could in principle mean `pendingBusMessages` failed to find
the message rather than that the message was already claimed. Scenario A rules that out
using the same pair, sender, and code path: there the same lookup finds the message and
the replacement succeeds. B also carries its own positive evidence — the receipt is
`claimed`, and the `agent/inbox/claimed` event's timestamp is at or before the moment
`bus.send` returned — so the claim demonstrably happened inside the send call.

## What this does not prove

- It is a **single process, single pair**. The cross-process supersede path is covered
  only by a unit test against two in-process endpoints over a real socket
  (`test/xproc-bus.test.js`); no two-OS-process supersede check exists.
- It does **not** reproduce the 3.7 s busy window from the real-model session. It creates
  a controlled window (a held turn) of a few hundred milliseconds instead, which is what
  makes it deterministic. The 3.7 s figure remains a single real-model observation.
- It does **not** cover `supersede` refusing to touch a pending **question**; that is
  unit-tested only (`test/supersede.test.js`).
- `maxPendingPerPair` is still unit-tested only. It is not exercised here, because the
  e2e overlay deliberately runs with the ceiling off.

## Reproducing

```bash
npm run e2e:supersede       # headless profile
npm run e2e:supersede:web   # web profile, no port bound
```

Both are offline: the adapter is scripted, so no model calls and no tokens.
