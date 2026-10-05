# dsh-peer-bus

[English](README.md) · **简体中文**

让两个互相独立的 DSH 会话互相对话。一个会话按 id 找到另一个、把它唤醒，还能把答复取回来 —— 不需要任何父子关系。

```
session A ──bus_send──▶ session B   （B 被唤醒，跑一个 turn）
session B ──bus_send──▶ session A   （A 被唤醒，跑一个 turn）
```

**两条命令安装，一条命令开始对话。** 直接跳到[安装](#安装)。

---

## 你会得到什么

给模型的六个工具，加给你的一条命令：

| | |
|---|---|
| `bus_roster` | 列出本会话能触达的会话 |
| `bus_send` | 发一条消息，目标被唤醒并跑一个 turn |
| `bus_ask` | 提问，并**在同一轮里拿回答复** |
| `bus_reply` | 显式作答，而不是靠结束本轮来充当答复 |
| `bus_status` | 查询你发出的消息后来怎样了 |
| `bus_wait` | 主动取走来信，而不是让它跑成独立的一轮 |
| `/bus` | 仅限人工的命令，用来授权与撤销 |

那六个是**模型工具，你永远不会手敲它们**。你用大白话告诉某个会话的模型你想要什么，它自己挑工具。见[第一次对话](#第一次对话)。

---

## 安装

### 1. 先确认 DSH 能跑

```bash
dsh --version
```

这条失败就先修 DSH。本插件是 DSH 的扩展，单独放着不做任何事。

### 2. 把插件装进一个 profile

*profile* 是一套 DSH 配置（`web`、`headless`、`tui`……）。用你实际启动的那个。

**从 npm 装：**

```bash
dsh plugin --profile web add dsh-peer-bus
```

**从本地检出装** —— 想读或改源码时用这条：

```bash
git clone https://github.com/ybh1291747665/dsh-peer-bus.git
dsh plugin --profile web add "$PWD/dsh-peer-bus"
```

两种方式都由 `dsh plugin add` 把包登记进该 profile 的 `dsh.profile.bundles`。**你不需要手工改任何 YAML。**

> **`pnpm` 会提示缺少 peer**（`@deepseek-ai/dsh-agent` 之类）。这是预期行为，可以忽略。DSH 关闭了 peer 的自动安装，改由自己的运行时提供这些包 —— 这也正是它们被声明为 peer 而不是 dependency 的原因：插件必须跑在宿主的副本上，而不是自己再装一份。

### 3. 重启 DSH 并确认已挂载

重启该 profile 的 DSH 进程，然后在任意会话里输入：

```
/bus id
```

应当返回该会话自己的 id：

```
This session: session-1a2b3c4d-…
```

如果看到的是 `unknown /bus subcommand`，或者毫无反应，说明插件没挂上 —— 见[故障排查](#故障排查)。

### 4. 注意：此时什么都还没被允许

本插件出厂即**默认拒绝**：仅安装不会让任何会话获得给他人发消息的能力。谁可以对话由你说了算，一条命令的事，就是下一步。

---

## 第一次对话

从头到尾五步。你需要两个 DSH 会话 —— 两个 GUI 窗口，或两个 `dsh` 进程。同一进程内或不同进程都可以。

### 第 1 步 —— 拿到两个会话的 id

在**会话 A** 里输入：

```
/bus id
```

复制它打印的 id。在**会话 B** 里做同样的事。现在你有了两个，例如：

```
session A:  session-1a2b3c4d-…
session B:  session-9z8y7x6w-…
```

### 第 2 步 —— 在需要的一侧各自授权

**授权的含义是"这个会话可以给我发消息"。** 在**接收方**会话里执行：

```
# 在会话 A 里 —— 从现在起 B 可以给 A 发消息
/bus allow session-9z8y7x6w-…

# 在会话 B 里 —— 从现在起 A 可以给 B 发消息
/bus allow session-1a2b3c4d-…
```

所以双向对话需要**两侧各授权一次**。这是接收方的同意，刻意不能由一个会话替另一个会话做主。

确认授权已生效：

```
/bus list
```

### 第 3 步 —— 发一条消息

现在直接用大白话跟会话 A 的模型说：

> 给 session-9z8y7x6w 发条消息："构建过了，去把 release 打上 tag。"

模型会调用 `bus_send`，而会话 B **被唤醒并针对这条消息跑一个 turn** —— 即使它原本空闲，即使它从未在本进程里被打开过。

返回结果：

```
Delivered msg-… to session-9z8y7x6w (live)
```

`live` 表示 B 本来就在运行；`resumed` 表示插件先从磁盘把它恢复了。两者都意味着它现在已经醒着。

### 第 4 步 —— 提问，并在同一轮拿回答复

`bus_send` 是发完即走。想要**同一轮里拿到答复**时改用提问：

> 问一下 session-9z8y7x6w 当前发布版本是多少，把它说的告诉我。

模型会调用 `bus_ask`，工具结果里直接带着对方的答复：

```
session-9z8y7x6w answered in turn 7:
"4.2.0-rc.7, codename blue-heron."
```

背后的机制：问题带着一个 id 被投递过去，目标跑一个 turn，然后**那一轮的文本**被读回并交给提问中的这一轮。没有轮询，没有第二次往返。

**如果目标正忙**，`bus_ask` 不会无限期占住你这一轮。它等 `askBusyTimeoutMs`（默认 30 秒），然后返回：

```
status: pending, askId: ask-…
```

什么都没丢 —— 答复稍后会作为一条普通的总线消息到达。见[答复迟到时](#答复迟到时)。

### 第 5 步 —— 在另一侧作答

在接收端，到来的问题就是一条普通消息。目标的模型可以**直接结束本轮**，那一轮的文本就是答复。想提前且显式地作答：

> 回复那条总线提问，就说"是的，42 个测试全过"。

这会调用 `bus_reply`。

### 整条流程，一张图

```
你 ──"给 X 发条消息"──▶ A 的模型 ──bus_send──▶ B
                                                │
                                       B 跑一个 turn
                                                │
你 ◀──工具结果────────────────────────────────────┘

你 ──"问 X 一件事"────▶ A 的模型 ──bus_ask──▶ B
                                                │
                                       B 跑一个 turn
                                                │
你 ◀──答复，就在同一轮里──────────────────────────┘
```

---

## 权限：谁能给谁发消息

两种规则写法，都写在 profile 配置里。无论哪种，**裁决方都是接收侧**。

### 按工作区 —— 省事的那种

同一个工作区里的会话可以对话：

```yaml
# 写在 profile 的 cordis.patch.yml 里
- id: peer-bus
  config:
    allow:
      - sameWorkspace: true
```

这是"我自己的会话，同一个项目"最合适的默认。它**不会**匹配无关项目，也**不会**匹配 subagent，除非你加上 `includeSubagents: true`。

收窄到某一个项目：

```yaml
      - sameWorkspace: true
        cwd: /Users/you/project
```

### 按会话 id —— 精确的那种

```yaml
    allow:
      - from: 'session-1a2b3c4d-…'   # 发送方
        to: 'session-9z8y7x6w-…'     # 接收方
```

`'*'` 匹配任意；尾部 `*` 是前缀匹配（`'session-worker-*'`）。它不是 glob —— `*` 只在末尾有意义。

会话 id 是随机 UUID，所以这种写法只能等两个会话都存在之后才写得出。`/bus` 就是为此存在。

### 运行时 —— `/bus`，不用重启

在会话里执行。仅限人工，**刻意不对任何模型开放**：

| 命令 | 作用 |
|---|---|
| `/bus id` | 打印本会话自己的 id |
| `/bus list` | 列出本会话涉及的所有授权 |
| `/bus allow <session>` | 允许该会话给**本**会话发消息 |
| `/bus revoke <session>` | 收回上面那条 |

授权是持久的 —— 重启后依然有效。`/bus revoke` 只能收回 `/bus allow` 给出的授权；写在 profile 配置里的规则得到那里去删，遇到这种情况命令会如实告诉你。

### 为什么默认拒绝

总线消息是以 **user message** 投递的，而模型会把 user message 当指令。所以一个开局就敞开的总线就是 prompt injection 通道：任何会话 —— 包括你为了读一个不可信文件而 spawn 的 subagent —— 都能给你的主会话下指令。因此权限必须显式给出，而且这个决定属于被打扰的那一方。

---

## 工具

你很少需要点名它们，模型会挑。但读结果、排查问题时，这些细节有用。

| 工具 | 参数 | 作用 |
|---|---|---|
| `bus_roster` | 无 | 列出可触达的会话 —— id、标题、活/存、状态、工作区。"可触达"的范围由 `rosterScope` 配置决定。 |
| `bus_send` | `target`、`text`、`mode` | 投递消息。`mode: 'followup'`（默认）排队成新的一轮；`mode: 'steer'` 在目标当前轮的最近 step 边界插入。 |
| `bus_ask` | `target`、`text`、`timeoutMs` | 提问并等待。返回答复，或带 `askId` 的 `pending`。 |
| `bus_reply` | `text` | 回答本会话当前正在处理的那个问题。不需要 id —— 一轮只回答一个问题。 |
| `bus_status` | `messageId` | `queued` → `claimed` → `received` / `discarded`，附 turn 编号与延迟。 |
| `bus_wait` | `from`、`askId`、`timeoutMs` | 等待一条消息，而不是让它跑成一轮。 |

### 寻址

可以用完整 id、无歧义的 id 前缀，或标题。标题匹配到多个会话时，工具会拒绝并列出候选，而不是猜一个。只有**在线**会话才有标题 —— 已存储的行不带标题，因为每行读一次日志只为拿标题并不划算。

### 答复迟到时

如果 `bus_ask` 返回了 `pending`，什么都没坏 —— 只是答复没在等待窗口内到达。该 ask 依然注册着，答复会作为一条带同一个 `askId` 的普通总线消息到达。你也可以用 `bus_wait` 显式地阻塞等它。

### `bus_ask` 为什么会拒绝某些提问

每个进行中的 ask 都是"谁被谁阻塞"图上的一条边。会成环的提问在投递前就被拒绝，并给出链条，而不是死锁：

```
bus_ask rejected (ask-cycle): asking "session-bob" would close a wait cycle
(session-bob -> session-alice -> session-bob); one side must answer with bus_send instead of bus_ask
```

普通的 `bus_send` 对话不在这张图里，依然不受限 —— 只由限速约束。

---

## 配置

写在 profile 的 `cordis.patch.yml` 里 `peer-bus` 那一行下面。**patch 会整体替换 `config` 块**，所以你想保留的每个键都要重新写出来：

```yaml
- id: peer-bus
  config:
    allow:
      - sameWorkspace: true
    maxMessageBytes: 16384
```

| 键 | 默认值 | 含义 |
|---|---|---|
| `allow` | `[]` | 权限白名单。**空列表不放行任何一对。** |
| `maxMessageBytes` | `16384` | 单条消息的 UTF-8 字节上限。 |
| `maxSendsPerWindow` | `10` | 每个发送方→目标对在每个窗口内的发送上限。未能投递的不计数。 |
| `rateWindowMs` | `60000` | 该窗口的毫秒长度。 |
| `rosterScope` | `'allowed'` | `bus_roster` 显示什么：`'allowed'` = 调用方加上它能发消息的会话；`'all'` = 全部，并标注是否允许。 |
| `waitTimeoutMs` | `60000` | `bus_wait` 的默认等待；目标空闲时也是 `bus_ask` 的等待。 |
| `maxWaitMs` | `600000` | 任何等待的上限，避免一次调用无限期占住一个 turn。 |
| `askBusyTimeoutMs` | `30000` | 目标已在运行时，`bus_ask` 等多久后转为 `pending`。 |
| `resumedIdleMs` | `600000` | 总线**自己**恢复的会话空闲这么久后释放，同时释放其日志锁；`0` 表示一直保持加载。经宿主自身 lookup 恢复的会话归宿主所有，不受影响。 |

---

## 跨进程

**默认关闭。** 关闭时，在*另一个* DSH 进程中打开的会话显示为已存储、无法触达。打开之后这些会话也能触达了。

```yaml
- id: peer-bus
  config:
    crossProcess: true
```

要在**每一个**需要参与的进程里都设置。此后：

- `bus_roster` 会把 peer 持有的会话标为 remote，`bus_send`、`bus_ask`、`bus_reply`、`bus_status` 都跨边界可用。
- **裁决方依然是接收进程。** 它会重新跑自己的白名单、归档检查与限速，所以在某个进程里做出的授权只管那个进程的会话。跨进程的一对会话**不需要**往发送方配置里写任何东西。
- 够不到对端时不会静默失败：`bus_send` 会说明结果是**未知**，并给出可用 `bus_status` 查询的 id。重发是安全的 —— 接收方认得已经取过的投递 id，会返回原来的结果而不是二次唤醒。

| 键 | 默认值 | 含义 |
|---|---|---|
| `crossProcess` | `false` | 通过本地 socket 触达由另一个 DSH 进程持有的会话。 |
| `crossProcessTimeoutMs` | `2000` | 单次远端控制面查询的超时。 |
| `crossProcessDeliverTimeoutMs` | `60000` | 单次转发投递的超时，因为对端可能需要先冷恢复目标。 |
| `crossProcessRosterCacheMs` | `3000` | 本进程可复用"哪个 peer 持有什么"这一答案的时长。过期答案是安全的：会自我纠正。 |

**信任边界是"同一 OS 用户、同一 `DSH_HOME`"。** peer 之间通过只有该用户能读的文件互相发现（目录 `0700`、文件 `0600`）。socket 是本地的 —— 没有网络监听，也没有端口。打开传输本身不授予任何权限：`allow` 为空时，两个互相可见的进程依然无法互发消息。

---

## 故障排查

**`/bus` 不被识别。**
插件没装在你在跑的 profile 里。检查安装命令里的 `--profile` 与你实际启动的 profile 是否一致，然后重启 DSH。

**`denied` —— "not permitted to message"。**
没有任何规则覆盖这一对。在**接收方会话**里执行 `/bus allow <对方 id>`，或往 profile 里加一条 `sameWorkspace` 规则。记住双向对话需要两侧各授权一次。

**`unknown-target` —— "no session matches"。**
id 写错了，或者目标还没有任何会话日志。在对方会话里跑 `/bus id` 重新复制。

**`target-busy`。**
另一个 DSH 进程持有该会话的日志锁，且无法触达。要么在两个进程里都打开 `crossProcess`，要么从打开着该会话的那个进程发送。

**`target-archived`。**
该会话已归档。归档就是那条持久的"别再唤醒我"标记，先取消归档。

**`rate-limited`。**
这一对在 `rateWindowMs` 内发的条数超过了 `maxSendsPerWindow`。限速是为了防止两个自动回复的 agent 无限循环烧 token。确实聊得这么快就把上限调高。

**`message-too-large`。**
超过 `maxMessageBytes`（默认 16 KB）。发一个指向文件的路径，而不是文件本身。

**答复一直没回来，`bus_ask` 返回了 `pending`。**
什么都没坏。用 `bus_status` 看发生了什么，答复稍后会作为普通消息到达。

---

## 已知限制

- **跨进程触达是选择性开启的。** `crossProcess: false` 时所有投递路径都是进程内的。传输是 Unix domain socket（Windows 命名管道），**不跨机器**。
- **没开启传输的 peer 是不可见的。** 发现按 `DSH_HOME` 且按选择性开启划分，所以旧版本进程、或关了 `crossProcess` 的进程就是不在这张网里。向它持有的会话发送会被拒为 `target-busy`，并且消息会说明原因。
- **冷恢复的 agent 空闲后会被释放 —— 仅限回退路径。** 总线自己恢复的会话在静默满 `resumedIdleMs`（10 分钟）后被释放，日志锁随之释放；下一条消息会再把它恢复。经宿主自身 lookup 恢复的会话（`web`）归宿主所有，总线从不卸载它。
- **路由是推断的，不是声明的。** 冷恢复从会话最后一条请求事件还原 provider、model 与 reasoning effort。从未发起过模型请求的会话没有记录路由，恢复后的 turn 会是空的。
- **每次发送都会从持久化重建 roster，成本随历史增长。** 开销正比于**已存储**会话数而非在线会话数 —— 1,123 个已存储会话时约 135 ms，每次发送都要再付一次。显而易见的修法是 live-first lookup，目前**有意推迟**，不是遗漏。
- **回执跟踪的是投递，不是意图。** `bus_status` 能说明消息被取进了某个 turn，不能说明目标是否照做了。回执只存在于本进程，重启后不保留。
- **`bus_wait` 会消费消息。** 它把消息从 inbox 中取走，因此同一份内容不会再跑成一轮。这是刻意的：窥视会导致重复投递、浪费一轮，并让两个互相等待的会话 ping-pong 到触发限速为止。
- **真机验证是单独的、要花钱的检查。** 除 `real-model-check` 与 `real-model-xproc` 外，所有检查都用脚本化 stub 模型，离线且确定性。

---

## 实现细节

给贡献者和好奇的人。不读这一节，上面的一切照常工作。

<details>
<summary><b>投递从不直接往会话日志追加</b></summary>

会话日志是投影，不是驱动器：往它追加**不会唤醒任何东西**，因为活的驱动读的是内存 inbox。所以投递一律走活的 `Agent` API —— `followup()` 排队成新的一轮，`steer()` 在 step 边界插入。已存储的会话先被冷恢复。由于 `followup`/`steer` 自身会记录 `agent/inbox/spliced` 事件，持久化是白送的：消息能在重启后存活，不需要另建邮箱。

投递的消息携带自己的 `peer-bus-message` source kind，而不复用 `dsh-subagent` 的，这样总线流量在 transcript 和 `bus_wait` 里始终与父子流量可区分。
</details>

<details>
<summary><b>冷恢复必须同时恢复模型路由与 agent 预设</b></summary>

被恢复的 agent 自身没有路由，不带 `agentOptions` 时 loop 没有 provider/model，于是那个 turn 跑不出任何 step、不调用模型 —— 一次静默的空操作，而投递本身看起来还是成功的。总线从最新的 `request/header` 事件读取路由（没有则退回 `request/context`）。

路由只是会话组合的一半。预设提供 persona（系统提示词）、指令加载器和部分工具，所以跳过挂载的恢复会用**错误的系统提示词和缩减的工具集**运行，而且没有任何东西会报告这件事。预设 id 取自 registry 自己的 `agentPreset` 投影，退回 `session.header.agentPreset`。

走哪条恢复路径取决于组合：挂载了 session controller（web bundle）时，总线走宿主的 Typert `agent` lookup —— GUI 打开会话走的那条路，恢复出来的生命周期归宿主所有。`dsh-agent` 在每个 profile 上都注册这个 lookup，但它的 resolver 只对已经在线的 agent 有答案，所以判别依据是**返回值**而不是存在性。`npm run boot-check` 会打印某个 profile 实际走的是哪条路径。
</details>

<details>
<summary><b>跨进程恢复是单一赢家，而这正是总线提供的</b></summary>

持久化层的跨进程锁守的是**写句柄**，而 `agents.resume` 并不去取它 —— 所以两个进程同时决定恢复同一个已存储会话时都会成功、都以为自己拥有它。总线在唯一可能竞争的群体之间做仲裁：恢复之前，进程用一次原子的 `open(…, 'wx')` 在 `$DSH_HOME/peer-bus/claims/` 下认领该会话。赢家负责恢复；输家等赢家真正持有会话之后，**把消息转发给它**，所以不会有消息被丢掉。认领文件里的 pid 已不存在时可被接管；恢复失败会把认领交还；会话被释放时删除认领。
</details>

<details>
<summary><b>帧按字节缓冲，而不是按字符串</b></summary>

对每个到达的数据块单独做解码，会把任何跨块边界的多字节字符变成乱码。一次 30 KB 的写入会分几块到达，所以一条较长的中文消息会被写坏 —— 一问一答走的是同一条路，同样会坏。所以在一整行到手之前不做任何解码；行边界永远不会落在字符中间，因为 UTF-8 的续字节和前导字节都不是 `0x0A`。
</details>

<details>
<summary><b>服务解析发生在第一个 <code>await</code> 之前</b></summary>

Cordis 会在服务方法执行期间把 `this.ctx` 重绑到一个当次调用的影子上下文上，而这个影子只在调用的同步部分有效：跨越 macrotask 的 `await` 之后再做的查询会失败，要么返回 `undefined`，要么抛 `cannot get required service "x" in inactive context`。因此总线在方法开头就把需要的东西解析成局部变量，并把构造时的上下文保存在 `pluginCtx` 里。
</details>

---

## 验证

```bash
npm run link-dev-deps   # 一次性：从本地 DSH 安装软链 @deepseek-ai/*
npm run test-home       # 一次性：生成 .dsh-test 下的临时 profile

npm test                # 277 个单元测试
npm run boot-check      # 插件挂载并注册六个工具
npm run boot-check:web  # 同上，web profile，不占用端口
npm run e2e             # 两个会话真实对话，stub 模型
npm run e2e:web         # 同上，web profile（宿主恢复路径）
npm run restart-e2e     # 该对话在真实进程重启后仍然存在
npm run e2e:xproc       # 两个真实 DSH 进程，认领竞争，空闲释放

# 下面两条会调用真实模型，消耗额度：
npm run real-model-check
npm run real-model-xproc
```

除最后两条外，所有检查都是离线的 —— 无网络、无模型调用。`DSH_HOME` 由 `scripts/dsh-home.mjs` 强制指向 `.dsh-test`，每个脚本都最先 import 它，因此**这些检查绝不碰你自己的 `~/.dsh`**。用 `BUS_TEST_DSH_HOME` 可以指向别处。

真机运行的记录 —— 包括它们证明了什么、以及不能证明什么 —— 都在 [`verification/`](verification/) 里。

---

## 依赖要求

DeepSeek Harness `>=0.1.7-rc.2 <0.3.0-0`，已在 `0.1.7-rc.2` 与 `0.2.0-rc.2` 上验证。

自 0.2.0 起，DSH 在启动时会用运行版本逐一核对插件的每个 `@deepseek-ai/dsh*` peer 范围，**不匹配就拒绝挂载**，因此这个范围必须覆盖你实际运行的宿主版本。上限停在 0.3.0 之前，因为 0.x 的 minor 版本可能改动插件 API；放宽前请先重跑上面的检查。

本包把 `@deepseek-ai/*` 声明为 `peerDependencies`，以便从宿主安装解析而非自带第二份副本。其中 `dsh-invariants`、`dsh-session-query`、`dsh-home-paths` 与 `zod` 标为 optional，因为用到它们的都是可选能力。

---

## 发布说明

- **没有 `lib/` 构建。** DSH 的包把 TypeScript 编译到 `lib/`；本包是 `src/` 下的纯 ESM JavaScript，没有编译步骤也没有 `.d.ts`。`exports` 映射形状相同（`./invariant`、`./package.json`），但指向 `src/`。
- **npm 包只包含 `src/`、bundle patch、两个 README、`USAGE.md` 与 `LICENSE`。** 测试、脚本与验证记录留在仓库里；要跑那些检查请从检出运行。
- **没有 `README.i18n.yaml`。** DSH 单仓会用它对翻译配对做逐段哈希校验，但那个工具没有发布，所以这里的双语文档 —— [README.md](README.md)、[README.zh.md](README.zh.md) —— 没有哈希记录。不要手写那个文件：伪造的哈希通不过它们的校验。

---

## 许可

MIT —— 见 [LICENSE](LICENSE)。
