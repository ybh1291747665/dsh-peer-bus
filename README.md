# dsh-peer-bus

**English** · [简体中文](README.zh.md)

Let two DSH sessions talk to each other.

```
session A ──bus_send──▶ session B    (B wakes up and runs a turn)
```

## Install

```bash
dsh plugin --profile web add dsh-peer-bus
```

Restart DSH. If `pnpm` warns about missing peers, ignore it — DSH supplies those from its own runtime.

## Use

You need two sessions. In **each** one, run `/bus id` and copy the id it prints.

**Let them talk.** A grant means *"this session may message me"*, so make it in the session that will be **received from**:

```
# in session B — now A may message B
/bus allow <A's id>
```

Then just ask session A's model, in plain language:

> Ask `<B's id>` what the release version is.

It calls `bus_ask`, and B wakes up, answers, and the answer comes back in the same turn. For a one-way message, say "send `<B's id>` a message saying …". **You never type the tool names yourself** — the model picks them.

To allow the other direction too, run `/bus allow <B's id>` in session A.

## What the model gets

| | |
|---|---|
| `bus_send` | send a message; the target wakes up and runs a turn |
| `bus_ask` | ask a question and get the answer back in the same turn |
| `bus_reply` | answer a question explicitly |
| `bus_wait` | take an incoming message instead of letting it run a turn |
| `bus_roster` | list the sessions this one can reach |
| `bus_status` | what became of a message you sent |
| `/bus` | **you** grant and revoke permission — no model can |

## Permission

Nothing is allowed until you grant it. Two ways:

- **`/bus allow <id>`** — one session, one direction, no restart. Durable.
- **A workspace rule** — every session in one project, in the profile's `cordis.patch.yml`:

```yaml
- id: peer-bus
  config:
    allow:
      - sameWorkspace: true
```

Messages arrive as *user* messages, and a model treats those as instructions — so an open bus would be a prompt-injection path. Hence default-deny.

## Two processes

Off by default. To reach a session held by another DSH process, set this in **both**:

```yaml
- id: peer-bus
  config:
    crossProcess: true
```

The receiving process still decides permission, so a grant in one process governs that process's sessions only.

## More

- **[USAGE.md](USAGE.md)** — every tool in detail, all config keys, error codes, troubleshooting
- **[verification/](verification/)** — what was tested, and what the tests do not prove

MIT — see [LICENSE](LICENSE).
