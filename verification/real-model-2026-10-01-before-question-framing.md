# Real-model verification — 2026-10-01

- Route: `opencode-go/deepseek-v4.1-flash`, reasoning effort `low`
- Profile: `web` (host resume path), isolated test home, no port bound
- DSH: `0.2.0-rc.2`
- Prompts are plain task requests; none names a bus tool.
- Result: all mechanism checks passed

| Kind | Result | Label | Detail |
|---|---|---|---|
| check | PASS | the bus is mounted on the web profile |  |
| check | PASS | scenario 1 settled |  |
| observe | seen | planner used a bus tool to reach the worker | bus_roster, bus_ask |
| observe | seen | planner chose bus_ask (answer in its own tool result) | bus_roster, bus_ask |
| check | PASS | the worker received the question as a bus message |  |
| check | PASS | the question is credited to the planner |  |
| observe | seen | the worker used a tool to answer (e.g. read the file) | glob, bash, read, bus_send |
| check | PASS | the planner reported the real version | firmed — the Release Worker's follow-up message also states the version: **`4.2.0-rc.7`**. That matches the answer it gave to my question, so the version declar |
| check | PASS | the worker is unloaded |  |
| check | PASS | scenario 2 settled |  |
| check | PASS | the worker was resumed |  |
| check | PASS | the resumed worker ran real model turns on its recorded route | opencode-go/deepseek-v4.1-flash, opencode-go/deepseek-v4.1-flash |
| check | PASS | the planner reported the codename from the resumed worker | se Worker's follow-up message also says **`blue-heron`**, matching its answer to my question. So `release.json` gives this release the codename **blue-heron** ( |
| check | PASS | scenario 3 settled |  |
| observe | seen | planner sent a one-way notice with bus_send | bus_send, bus_status, bus_roster |
| observe | seen | planner checked delivery with bus_status | bus_send, bus_status, bus_roster |
| check | PASS | every planner→worker message has a settled receipt | claimed, claimed, claimed |
| check | PASS | the worker received the notice |  |

## Transcript

### Release Planner (`session-real-planner-71385-mup1qxur`)

**user**: Another session in this project, titled "Release Worker" (session id session-real-worker-71385-mup1qxur), owns the release files. Find out from that session which version string release.json declares, then tell me the version. Get the answer from that session rather than reading the file yourself.

**tool call** `bus_roster` {}

**tool result**: session-real-planner-71385-mup1qxur Release Planner live/running /var/folders/_j/_m05_nc16wbg_0yx1yj3nrt00000gn/T/peer-bus-real-504vCW [you] session-real-worker-71385-mup1qxur Release Worker live/idle /var/folders/_j/_m05_nc16wbg_0yx1yj3nrt00000gn/T/peer-bus-real-504vCW

**tool call** `bus_ask` {"target":"session-real-worker-71385-mup1qxur","text":"Which version string does release.json declare? Please reply with just the version string (or the exact field/value if there are several)."}

**tool result**: Answer from session-real-worker-71385-mup1qxur: `release.json` declares `"version": "4.2.0-rc.7"` (single version field; also `codename: "blue-heron"`, `frozen: false`). I sent the version string back to the asking session.

**assistant** (turn 1): **Version: `4.2.0-rc.7`**

Per the **Release Worker** session (which owns the release files), `release.json` declares a single version field:

- `"version": "4.2.0-rc.7"`
- (also `codename: "blue-heron"`, `frozen: false`)

I got this answer from that session as requested, rather than reading the file myself.

**bus message**: Agent session-real-worker-71385-mup1qxur sent a message: 4.2.0-rc.7

**assistant** (turn 2): Confirmed — the Release Worker's follow-up message also states the version: **`4.2.0-rc.7`**.

That matches the answer it gave to my question, so the version declared by `release.json` is **4.2.0-rc.7**.

**user**: Ask the "Release Worker" session again: what codename does release.json give this release? Report the codename it gives you.

**tool call** `bus_ask` {"target":"session-real-worker-71385-mup1qxur","text":"What codename does release.json give this release? Please reply with just the codename."}

**tool result**: Answer from session-real-worker-71385-mup1qxur: Codename: `blue-heron` — sent back to the asking session.

**assistant** (turn 3): The Release Worker reports the codename as: **`blue-heron`**

(For context, its earlier answer noted `release.json` pairs this codename with version `4.2.0-rc.7` and `frozen: false`.)

**bus message**: Agent session-real-worker-71385-mup1qxur sent a message: blue-heron

**assistant** (turn 4): Confirmed — the Release Worker's follow-up message also says **`blue-heron`**, matching its answer to my question.

So `release.json` gives this release the codename **blue-heron** (version `4.2.0-rc.7`, `frozen: false`).

**user**: Tell the "Release Worker" session that the release is now frozen and it must not change release.json. It does not need to reply. Then confirm for me that your notice was actually picked up by that session.

**tool call** `bus_send` {"target":"session-real-worker-71385-mup1qxur","text":"Notice from Release Planner: the release is now FROZEN. Do not change release.json (no edits, no version/codename/frozen-field updates, no rewrites). It must remain exactly as it is. No reply needed."}

**tool result**: Delivered 96346ef0-7d1b-4f1b-9082-3523b544a13c to session-real-worker-71385-mup1qxur (live)

**tool call** `bus_status` {"messageId":"96346ef0-7d1b-4f1b-9082-3523b544a13c"}

**tool result**: Message 96346ef0-7d1b-4f1b-9082-3523b544a13c to session-real-worker-71385-mup1qxur: claimed in turn 3 after 1 ms

**tool call** `bus_roster` {}

**tool result**: session-real-planner-71385-mup1qxur Release Planner live/running /var/folders/_j/_m05_nc16wbg_0yx1yj3nrt00000gn/T/peer-bus-real-504vCW [you] session-real-worker-71385-mup1qxur Release Worker live/idle /var/folders/_j/_m05_nc16wbg_0yx1yj3nrt00000gn/T/peer-bus-real-504vCW

**assistant** (turn 5): Done. Notice sent and confirmed picked up.

- **Sent:** "the release is now FROZEN; do not change release.json … No reply needed." → delivered to `session-real-worker-71385-mup1qxur`.
- **Pickup confirmation:** DSH reports the message status as **`claimed in turn 3 after 1 ms`** — i.e., the Release Worker session actually took the message into a turn, not merely queued it. Its session is live and now idle again, consistent with it having processed the notice without replying (as instructed).

### Release Worker (`session-real-worker-71385-mup1qxur`)

**bus message**: Agent session-real-planner-71385-mup1qxur sent a message: Which version string does release.json declare? Please reply with just the version string (or the exact field/value if there are several).

**tool call** `glob` {"pattern":"**/release.json"}

**tool result**: release.json

**tool call** `bash` {"command":"pwd && ls -la","description":"Show working directory contents"}

**tool result**: /private/var/folders/_j/_m05_nc16wbg_0yx1yj3nrt00000gn/T/peer-bus-real-504vCW total 8 drwx------@ 3 yanbohao staff 96 Oct 1 12:41 . drwx------@ 430 yanbohao staff 13760 Oct 1 12:41 .. -rw-r--r--@ 1 yanbohao staff 77 Oct 1 12:41 release.json 

**tool call** `read` {"file_path":"/var/folders/_j/_m05_nc16wbg_0yx1yj3nrt00000gn/T/peer-bus-real-504vCW/release.json"}

**tool result**: <path>/var/folders/_j/_m05_nc16wbg_0yx1yj3nrt00000gn/T/peer-bus-real-504vCW/release.json</path> <type>file</type> <content> 1: { 2: "version": "4.2.0-rc.7", 3: "codename": "blue-heron", 4: "frozen": false 5: } (End of file - total 5 lines) </content>

**tool call** `bus_send` {"target":"session-real-planner-71385-mup1qxur","text":"4.2.0-rc.7"}

**tool result**: Delivered 60d130b6-80c4-4107-8fc7-f8818b88e4bd to session-real-planner-71385-mup1qxur (live)

**assistant** (turn 1): `release.json` declares `"version": "4.2.0-rc.7"` (single version field; also `codename: "blue-heron"`, `frozen: false`). I sent the version string back to the asking session.

**bus message**: Agent session-real-planner-71385-mup1qxur sent a message: What codename does release.json give this release? Please reply with just the codename.

**tool call** `bus_send` {"target":"session-real-planner-71385-mup1qxur","text":"blue-heron"}

**tool result**: Delivered e6eec0ed-f9ba-4df4-91ec-3a33962ed328 to session-real-planner-71385-mup1qxur (live)

**assistant** (turn 2): Codename: `blue-heron` — sent back to the asking session.

**bus message**: Agent session-real-planner-71385-mup1qxur sent a message: Notice from Release Planner: the release is now FROZEN. Do not change release.json (no edits, no version/codename/frozen-field updates, no rewrites). It must remain exactly as it is. No reply needed.

**assistant** (turn 3): Acknowledged — no changes will be made to [release.json](release.json); it stays exactly as-is (version `4.2.0-rc.7`, codename `blue-heron`, `frozen: false` in the file). No reply sent.
