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
| observe | seen | the worker used a tool to answer (e.g. read the file) | glob, read |
| observe | seen | the worker answered once, without re-sending the answer via bus_send | glob, read |
| check | PASS | the planner reported the real version | om `release.json` in the shared workspace (/var/folders/_j/_m05_nc16wbg_0yx1yj3nrt00000gn/T/peer-bus-real-Oew5GA/release.json), and it confirmed no files were m |
| check | PASS | the worker is unloaded |  |
| check | PASS | scenario 2 settled |  |
| check | PASS | the worker was resumed |  |
| check | PASS | the resumed worker ran real model turns on its recorded route | opencode-go/deepseek-v4.1-flash |
| check | PASS | the planner reported the codename from the resumed worker | ` field in `release.json` (workspace path: /var/folders/_j/_m05_nc16wbg_0yx1yj3nrt00000gn/T/peer-bus-real-Oew5GA/release.json), and it confirmed no files were m |
| observe | seen | the resumed worker answered once, without re-sending via bus_send | (no tool calls) |
| check | PASS | scenario 3 settled |  |
| observe | seen | planner sent a one-way notice with bus_send | bus_send, bus_status, bus_roster |
| observe | seen | planner checked delivery with bus_status | bus_send, bus_status, bus_roster |
| check | PASS | every planner→worker message has a settled receipt | claimed, claimed, claimed |
| check | PASS | the worker received the notice |  |

## Transcript

### Release Planner (`session-real-planner-72348-mup1um58`)

**user**: Another session in this project, titled "Release Worker" (session id session-real-worker-72348-mup1um58), owns the release files. Find out from that session which version string release.json declares, then tell me the version. Get the answer from that session rather than reading the file yourself.

**tool call** `bus_roster` {}

**tool result**: session-real-planner-72348-mup1um58 Release Planner live/running /var/folders/_j/_m05_nc16wbg_0yx1yj3nrt00000gn/T/peer-bus-real-Oew5GA [you] session-real-worker-72348-mup1um58 Release Worker live/idle /var/folders/_j/_m05_nc16wbg_0yx1yj3nrt00000gn/T/peer-bus-real-Oew5GA

**tool call** `bus_ask` {"target":"session-real-worker-72348-mup1um58","text":"Which version string does release.json declare in your workspace? Please answer with the version string only (and the file path you read it from). Do not modify any files."}

**tool result**: Answer from session-real-worker-72348-mup1um58: Version: `4.2.0-rc.7` File read: `release.json` (full path: /var/folders/_j/_m05_nc16wbg_0yx1yj3nrt00000gn/T/peer-bus-real-Oew5GA/release.json). No files were modified.

**assistant** (turn 1): The **Release Worker** session reports that `release.json` declares the version string:

**`4.2.0-rc.7`**

Per that session, the value comes from `release.json` in the shared workspace (/var/folders/_j/_m05_nc16wbg_0yx1yj3nrt00000gn/T/peer-bus-real-Oew5GA/release.json), and it confirmed no files were modified. I did not read the file myself.

**user**: Ask the "Release Worker" session again: what codename does release.json give this release? Report the codename it gives you.

**tool call** `bus_ask` {"target":"session-real-worker-72348-mup1um58","text":"What codename does release.json give this release? Please answer with the codename only, plus the field name you read it from. Do not modify any files."}

**tool result**: Answer from session-real-worker-72348-mup1um58: Codename: `blue-heron` (read from the `codename` field in `release.json` at /var/folders/_j/_m05_nc16wbg_0yx1yj3nrt00000gn/T/peer-bus-real-Oew5GA/release.json). No files were modified.

**assistant** (turn 2): The **Release Worker** session reports that `release.json` gives this release the codename:

**`blue-heron`**

Per that session, the value comes from the `codename` field in `release.json` (workspace path: /var/folders/_j/_m05_nc16wbg_0yx1yj3nrt00000gn/T/peer-bus-real-Oew5GA/release.json), and it confirmed no files were modified. I did not read the file myself.

**user**: Tell the "Release Worker" session that the release is now frozen and it must not change release.json. It does not need to reply. Then confirm for me that your notice was actually picked up by that session.

**tool call** `bus_send` {"text":"Notice: the release is now FROZEN. Do not change release.json — no edits, writes, renames, or deletions to that file from now on. No reply needed to this message.","target":"session-real-worker-72348-mup1um58"}

**tool result**: Delivered ffc9e290-73f2-41d4-ab7c-6155fc72a3c1 to session-real-worker-72348-mup1um58 (live)

**tool call** `bus_status` {"messageId":"ffc9e290-73f2-41d4-ab7c-6155fc72a3c1"}

**tool result**: Message ffc9e290-73f2-41d4-ab7c-6155fc72a3c1 to session-real-worker-72348-mup1um58: claimed in turn 3 after 1 ms

**tool call** `bus_roster` {}

**tool result**: session-real-planner-72348-mup1um58 Release Planner live/running /var/folders/_j/_m05_nc16wbg_0yx1yj3nrt00000gn/T/peer-bus-real-Oew5GA [you] session-real-worker-72348-mup1um58 Release Worker live/idle /var/folders/_j/_m05_nc16wbg_0yx1yj3nrt00000gn/T/peer-bus-real-Oew5GA

**assistant** (turn 3): Sent — and confirmed picked up.

- **Message sent:** `bus_send` to session-real-worker-72348-mup1um58 (Release Worker), id `ffc9e290-73f2-41d4-ab7c-6155fc72a3c1`, text stating the release is frozen and that `release.json` must not be changed (no edits, writes, renames, or deletions), with no reply requested.
- **Pickup evidence:** `bus_status` reports the message was **claimed in turn 3 after 1 ms** — i.e., the worker's session actually took it into a turn rather than leaving it queued. The worker is now back to `live/idle`, consistent with having processed that turn and stopped (it sent no reply, as instructed).

So the freeze notice was delivered and ingested by the Release Worker session; it is no longer sitting unread in its inbox.

### Release Worker (`session-real-worker-72348-mup1um58`)

**bus message**: Agent session-real-planner-72348-mup1um58 asked you a question: Which version string does release.json declare in your workspace? Please answer with the version string only (and the file path you read it from). Do not modify any files.

(Answer in this turn: your reply is returned to the asker automatically, so do not also send it with bus_send.)

**tool call** `glob` {"pattern":"**/release.json"}

**tool result**: release.json

**tool call** `read` {"file_path":"release.json"}

**tool result**: <path>/var/folders/_j/_m05_nc16wbg_0yx1yj3nrt00000gn/T/peer-bus-real-Oew5GA/release.json</path> <type>file</type> <content> 1: { 2: "version": "4.2.0-rc.7", 3: "codename": "blue-heron", 4: "frozen": false 5: } (End of file - total 5 lines) </content>

**assistant** (turn 1): Version: `4.2.0-rc.7`

File read: `release.json` (full path: /var/folders/_j/_m05_nc16wbg_0yx1yj3nrt00000gn/T/peer-bus-real-Oew5GA/release.json). No files were modified.

**bus message**: Agent session-real-planner-72348-mup1um58 asked you a question: What codename does release.json give this release? Please answer with the codename only, plus the field name you read it from. Do not modify any files.

(Answer in this turn: your reply is returned to the asker automatically, so do not also send it with bus_send.)

**assistant** (turn 2): Codename: `blue-heron` (read from the `codename` field in `release.json` at /var/folders/_j/_m05_nc16wbg_0yx1yj3nrt00000gn/T/peer-bus-real-Oew5GA/release.json). No files were modified.

**bus message**: Agent session-real-planner-72348-mup1um58 sent a message: Notice: the release is now FROZEN. Do not change release.json — no edits, writes, renames, or deletions to that file from now on. No reply needed to this message.

**assistant** (turn 3): Acknowledged: `release.json` is now frozen — I will make no edits, writes, renames, or deletions to it.
