# dsh-peer-bus

[English](README.md) · **简体中文**

面向 [DeepSeek Harness](https://github.com/deepseek-ai) 的跨 session 消息总线。它让两个**互相独立、没有父子关系**的 session 可以按 id 互相寻址并唤醒对方。

```
session A ──bus_send──▶ session B   （B 被唤醒，跑一个 turn）
session B ──bus_send──▶ session A   （A 被唤醒，跑一个 turn）
```

第一次使用请看 [USAGE.md](USAGE.md)（英文），那是面向操作的指南：安装、白名单、让两个 session 对话、故障排查。

## 为什么需要它

DSH 已经提供两种 agent 通信方式，但两者都比「任意两个 session」更窄：

| 已有能力 | 作用范围 |
|---|---|
| `send_message`（`dsh-tool-subagent-control`） | 仅限**直接父级或直接 continuable 子级** |
| `dsh-experimental-agent-team` | **一个 Lead 加它的 teammates**，单棵树、单进程 |

两者都无法让 session `A` 和 session `B` —— 两个互不相关的根 —— 对话。本插件补上的正是这一点：一张覆盖进程内所有 session 的、扁平的、按 id 寻址的总线。

## 工作原理

这是最值得说明的部分，也是它能是个小插件而不是大工程的原因：

**session 日志是投影，不是驱动器。** 日志里的 `agent/inbox/spliced` 事件*记录*待处理 inbox 状态，以便重启后重建，但**往日志追加并不会唤醒任何东西**。活的驱动读的是内存 inbox。

所以投递从不直接碰日志，而是走 `@deepseek-ai/dsh-agent` 通过声明合并**挂在每个已注册 agent 上**的活 `Agent` API：

| 目标状态 | 总线动作 |
|---|---|
| **活着**（运行中或空闲） | 默认 `agent.followup(message)` —— 排队成独立的 turn，空闲时**唤醒驱动**。传 `mode: 'steer'` 则改用 `agent.steer(message)` —— 在最近的 step 边界插入。 |
| **已持久化、未加载** | `ctx.agents.resume({ resumeSessionId })` 后按同样方式投递 —— 从持久化冷恢复 |
| **在另一个 DSH 进程中打开** | 以 `target-busy` 拒绝 —— 该进程持有它的日志锁 |
| **已归档** | 以 `target-archived` 拒绝 —— 在任何恢复动作之前就拒绝，因此归档会话永远不会被唤醒。`bus_roster` 也不会列出归档会话；如果调用方自己已归档，则什么都看不到。 |
| **不存在** | 以 `unknown-target` 拒绝 |

投递模式由调用方选择，而不是根据目标状态推断：默认总是 `followup`。

归档状态来自 workspace registry，而只有 web bundle 挂载它。没有该服务的 profile 行为与"什么都没归档"完全一致 —— 是跳过检查，而不是伪造一个结果。归档时仍在运行的会话同样被拒绝，因为归档并不要求把它卸载。

由于 `followup`/`steer` 自身会记录 `agent/inbox/spliced` 事件，持久化是白送的：消息能在重启后存活，不需要另建邮箱。

### 自己的 message source kind

投递的消息携带本包声明的 `peer-bus-message` source。`dsh-llm` 的 `MessageSourceMap` 是可合并扩展的，并且明确说明**每个生产者在自己的模块里声明自己的 kind** —— 刻意没有共享的兜底 kind —— 且消费者会穿透未知 kind。

复用 `dsh-subagent` 的 `agent-message` kind 也能跑，但那样 bus 流量在 transcript 和 `bus_wait` 里就与父子流量无法区分了。声明自己的 kind 是文档规定的设计，共用则是抄近路。

### 冷恢复必须恢复模型路由

被 resume 的 agent 自身没有路由。`ctx.agents.resume()` 不带 `agentOptions` 时，loop 没有 provider/model，于是投递的消息会跑出一个「启动了 turn、没跑任何 step、没调用模型」的空 turn —— 一次静默的空操作。路由不在 session header 里，因此总线从日志中读取并在 resume 时重述：优先取最新一条 `request/header` 事件里的调用配置（provider、model 和 reasoning effort —— 与 `dsh-subagent` 让子 agent 继承父路由时的来源相同），没有时再退回最新一条 `request/context` 路由元数据。这个坑容易漏，因为投递本身看起来是成功的。

**走哪条恢复路径取决于组合。** 当挂载了 session controller（web bundle）时，总线走宿主自己的 Typert `agent` lookup —— 也就是 GUI 打开会话所走的那条路径：安装模型选择、挂载预设、检查 sub-agent 归属，并且恢复出来的生命周期**由宿主持有**，而不是交给本插件一个需要自己释放的 handle。`dsh-agent` 在每个 profile 上都会注册这个 lookup，但它自己的 resolver 只对**已经在线的** agent 有答案，所以判别依据是**返回值**而不是存在性：裸 provider 对已存储会话返回空，手工路径随即接手。日志被其他写入者持有时会以 `session/writer-held` 返回，并直接报成 `target-busy`，不再重试。`npm run boot-check` 会打印某个 profile 实际走的是哪条路径。

resume 只在进行中时被共享。一旦结束，存活性总是重新从 `ctx.agents` 读取，所以一个被恢复后又被卸载的 session，会在下一次发送时被重新 resume，而不是「投递」给一个已经不存在的 agent。

### 在第一个 `await` 之前解析服务

Cordis 会在服务方法执行期间把 `this.ctx` 重绑到一个**当次调用的影子上下文**上，使 `this.ctx.<serviceName>` 指向服务自身。这个影子只在调用的同步部分有效：任何跨越 macrotask 的 `await` 之后再做的 `this.ctx.<service>` 或 `this.ctx.get(...)` 查询都会失败 —— 要么返回 `undefined`，要么抛 `cannot get required service "x" in inactive context`。

阴险之处在于它不发作时完全看不出来：只有通过 `ctx.get('peerBus')` 而不是直接持有实例的调用方才会中招，而且只有 await 真的跨了 macrotask 才触发 —— 快路径把它藏住，慢路径直接崩。本插件正是在运行时白名单开始用真实文件 I/O 打开 storage domain 时踩到的：`roster()` 在那之后读 `this.ctx.agents`，boot-check 直接以一个光秃秃的 `TypeError` 挂掉。

这里的纪律是：在第一个 `await` **之前**把方法需要的东西解析成局部变量 —— `const agents = this.pluginCtx.agents; const persistence = this.pluginCtx.get('sessionPersistence');`。总线把构造时的上下文保存在 `pluginCtx` 里，正是因为 `this.ctx` 是被影子替换的那个。`npm run boot-check` 就是这条纪律的回归检查：它通过服务代理调用 `roster()`，且中间隔着一次真实的 storage 打开。

## 包结构

| 路径 | 职责 |
|---|---|
| `src/index.js` | Cordis 插件：bus 服务与 `bus_*` 工具 |
| `src/peer-bus.js` | 地址簿、权限、限速、投递、冷恢复所有权 |
| `src/ask.js` | `bus_ask`：答复关联、等待图、迟到答复投递 |
| `src/receipts.js` | `bus_status`：每条已投递消息后来怎样了 |
| `src/message.js` | `peer-bus-message` source kind 与消息构造 |
| `src/errors.js` | `SessionBusError` 及其稳定错误码 |
| `src/allowlist.js` | `/bus allow` 背后的运行时白名单，经 storage domain 持久化 |
| `src/commands.js` | 面向人的 `/bus` 命令：`id`、`list`、`allow`、`revoke` |
| `src/invariant.js` | `./invariant` 伴随模块 —— 包自有的持久化形状检查 |
| `cordis.patch.yml` | bundle patch，以一次 insert 挂载 |

`src/invariant.js` 需要 `invariants`，而 base、web、headless bundle 都**不**挂载它（只有 `dsh-sdk-minimal` 挂）。它**刻意不把这个服务声明为自己的依赖**：声明了但服务缺失会让该 entry 永远停在 `pending`，而加载器会把每个 pending entry 报成启动警告 —— 除了那一个 profile，每次启动都会打印「1 entry did not activate」。改为无条件激活、在嵌套 fiber 里等服务：一旦组合里有 `@deepseek-ai/dsh-invariants` 就立刻注册，没有就静默失效。

`src/invariant.js` 遵循 DSH 的约定：每个包都从 `./invariant` 伴随模块注册自己的运行时检查，好让普通入口不依赖诊断设施。它只校验**形状与位置** —— 权限、大小、限速属于每次部署的 `Config`，而在更宽松策略下写出的日志，必须在部署收紧策略后仍能回放。

## 安装

```bash
# 从检出安装：
git clone https://github.com/ybh1291747665/dsh-peer-bus.git
dsh plugin --profile web add "$PWD/dsh-peer-bus"

# 或直接从 registry：
dsh plugin --profile web add dsh-peer-bus
```

本包声明了 `dsh.bundle.patch`，因此 `dsh plugin add` 会把它登记进 profile 的 `dsh.profile.bundles`，下次启动时插件自动挂载 —— 不需要手工往 `cordis.patch.yml` 加条目。

它出厂即**默认拒绝**，所以仅安装并不会让任何 session 获得给他人发消息的能力。白名单语法见 [USAGE.md](USAGE.md)。

安装时 `pnpm` 会提示缺少 `@deepseek-ai/dsh-agent` 之类的 peer。**这是预期行为，可以忽略。** DSH 关闭了 peer 的自动安装，改为由自己的运行时提供这些包——这也正是它们被声明为 peer 而不是 dependency 的原因：插件必须跑在宿主的副本上，而不是自己再装一份。`@deepseek-ai/dsh-home-paths`（仅在 `crossProcess` 开启时使用）与 `zod`（供存储域校验使用）同理，两者都声明为可选。

## 工具

| 工具 | 用途 |
|---|---|
| `bus_roster` | 列出调用方能触达的 session：它自己（标记为 `you`）加上白名单允许它发消息的所有 session，含 id、标题、活/存、状态、工作区以及是否为 subagent。`rosterScope: 'all'` 则列出全部。 |
| `bus_send` | 按 id、无歧义前缀或唯一标题发送。可选 `mode: 'steer'`。 |
| `bus_ask` | 提问，并**在本次工具结果里**拿到答复。见下文。 |
| `bus_reply` | 显式回答本会话当前正在处理的那个 `bus_ask`，而不是让本轮文本充当答复。 |
| `bus_status` | 用 `bus_send` 返回的 `messageId` 查询你发出的消息后来怎样了：`queued`、`claimed`（附 turn）、`received`（被目标的 `bus_wait` 取走）、`discarded` 或 `unknown`。见下文。 |
| `bus_wait` | **取走**下一条发给本 session 的总线消息，可用 `from` 限定单个发送方（完整 id 或无歧义前缀），或用 pending ask 的 `askId` 过滤。会消费掉它，因此不会再作为 turn 到达一次。它**不会**取走发给本会话的 `bus_ask` 问题 —— 那属于负责回答它的 turn。超时默认为 `waitTimeoutMs`，上限为 `maxWaitMs`。 |

命名用 `bus_*` 是刻意的：`send_message` 已被 `dsh-tool-subagent-control` 全局占用，同名注册会把它遮蔽掉。


### `bus_ask`：答复直接作为工具结果返回

两步投递的体验很差：调用方得自己知道要去等、答复还可能作为独立 turn 到达、而两个互相等待的会话会一直卡到限速把它们拦住。`bus_ask` 把这三件事一起解决。

```
A: bus_ask { target: B, text: "部署状态怎么样？" }
   → status "answered", text: "<B 的答复>", turn: 3
```

**关联是精确的，不是启发式。** ask id 随问题本身一起走（`source.askId`），而且 ask 在问题投递**之前**就注册好了。这个顺序是关键：发给空闲会话的 `followup` 可能在发送方的续体运行之前就被驱动取走，任何在投递之后才注册的东西都会和它想观察的那次 claim 赛跑。答复随后从**取走该问题的那个 turn** 里读取 —— 收集该 turn 编号下的所有 `assistant/message` —— 这比"会话里最后一段 assistant 文本"准确得多，后者可能属于更晚的、无关的 turn。

**目标忙时转为 pending，而不是长时间等待。** 如果提问时目标已在运行，`bus_ask` 只等 `askBusyTimeoutMs`（默认 30 秒），然后返回 `{status: 'pending', askId}`。答复依然会到，形式是一条带该 ask id 的总线消息，用 `bus_wait { askId }` 取走。空闲目标则给足 `waitTimeoutMs`，因为它可以立刻开始处理这个问题。

**等待环会被拒绝，而不是死锁。** 每个进行中的 ask 都是"谁被谁阻塞"图上的一条边。会成环的边在投递前就被拒绝，并给出链条：

```
bus_ask rejected (ask-cycle): asking "session-bob" would close a wait cycle
(session-bob -> session-alice -> session-bob); one side must answer with bus_send instead of bus_ask
```

这**不是**跳数上限。普通的 `bus_send` 对话依然不受限，只由限速约束；只有**阻塞式**等待进入这张图。超时或被取消的 ask 会立刻释放它的边，因此陈旧边不会让后续的 ask 报出并不存在的死锁。

`bus_reply` 是可选的：不调用它时，目标那一轮的文本**就是**答复。当你希望答复不是本轮文本时才用它 —— 它不需要 ask id，因为注册表解析的就是"当前这一轮在处理哪个 ask"。一个会话每轮只回答一个问题。

**问题会告诉目标如何作答。** 它以 `Agent <id> asked you a question: …` 开头，并以一句说明结尾：本轮的回复会自动返回给提问方。第一次真实模型运行说明了原因：如果问题的措辞和普通消息一样，目标会在本轮作答，**同时**再用 `bus_send` 发一遍，提问方就收到了两次。

问题永远不会被目标自己的 `bus_wait` 取走。如果问题到达时目标恰好在 `bus_wait` 里，等待会把它留在 inbox：答复是从取走该问题的 turn 里读取的，若被 `bus_wait` 消费，提问方就只能一直等到超时。

### `bus_status`：消息后来怎样了

`bus_send` 只能证明消息进了目标的 inbox。`bus_status { messageId }` 接着跟踪它：

| 状态 | 含义 |
|---|---|
| `queued` | 在目标 inbox 中，还没有 turn 取走它（目标正忙）。 |
| `claimed` | 目标的循环把它取进了一个 turn；回执给出 turn 编号与延迟。 |
| `received` | 目标用 `bus_wait` 取走了它。 |
| `discarded` | 在任何 turn 运行它之前就被移除了 —— 例如目标的运行被取消。 |
| `unknown` | 不是你发的消息，或本进程已不再记得它。 |

回执在消息**路由之前**就记录好。对空闲目标，`followup()` 会同步启动驱动，而驱动在第一个 `await` 之前就 claim 了第一批消息，所以 claim 事件发生在 `followup()` 调用内部；若在路由之后才记录，回执就会错过它、永远停在 `queued`。只有发送方能读取回执 —— 其他人得到的是 `unknown`，与不存在的 id 完全一样，因此回执无法被用来窥探别的会话的流量。回执只存在于本进程且有上限（最新 1000 条），重启后不保留。`claimed` 表示某个 turn **取走**了消息，不代表目标照做了。

### 标题是辅助地址

`bus_roster` 会显示每个在线会话的标题，而调用方可触达范围内**唯一**的标题也可以直接作为 `bus_send` / `bus_ask` 的目标。id 始终是规范地址：先按 id 与 id 前缀解析，标题匹配到多个会话时会连同候选 id 一起拒绝，而不是猜一个。

标题通过 `ctx.get('sessionTitle')` 从会话自己的日志里读取，因此需要会话在线 —— 所以**已存储**的行不带标题。为每行读一次日志只为了拿标题并不划算，而 roster 每次发送都会重建；留空是诚实的答案，而不是一个昂贵的答案。

## 配置

| 键 | 默认值 | 含义 |
|---|---|---|
| `allow` | `[]` | 权限白名单。**默认拒绝 —— 空列表不放行任何一对。** |
| `maxMessageBytes` | `16384` | 单条消息体的 UTF-8 字节上限。 |
| `maxSendsPerWindow` | `10` | 每个发送方→目标对在每个窗口内的发送上限。未能投递的发送不计数。 |
| `rateWindowMs` | `60000` | 该窗口的毫秒长度。 |
| `rosterScope` | `'allowed'` | `bus_roster` 显示什么：`'allowed'` = 调用方自己加上它可发送的 session；`'all'` = 全部 session，并标注 `allowed`/`not-allowed`。 |
| `waitTimeoutMs` | `60000` | 调用方未传超时时 `bus_wait` 的超时；目标空闲时也是 `bus_ask` 的超时。 |
| `maxWaitMs` | `600000` | 任何 `bus_wait` 或 `bus_ask` 超时的上限，避免一次调用无限期占住一个 turn。 |
| `askBusyTimeoutMs` | `30000` | 提问时目标已在运行的情况下，`bus_ask` 等多久后转为 `pending`。 |
| `resumedIdleMs` | `600000` | 总线**自己**冷恢复的会话空闲这么久后释放，同时释放其日志锁；`0` 表示一直保持加载。经宿主自身 lookup 恢复的会话归宿主所有，不受影响。 |
| `crossProcess` | `false` | 通过本地 socket 触达由另一个 DSH 进程持有的会话。**默认关闭是刻意的**——信任边界见下。 |
| `crossProcessTimeoutMs` | `2000` | 单次远端控制面查询（roster 合并、`bus_status`、ask 取消）的超时。刻意很短：卡住的 peer 必须退化成"看起来是已存储"，而不是拖住一个 turn。 |
| `crossProcessDeliverTimeoutMs` | `60000` | 单次转发投递的超时，因为对端可能需要先冷恢复目标。 |
| `crossProcessRosterCacheMs` | `3000` | 本进程可复用"哪个 peer 持有什么"这一答案的时长。每次 roster 都要问每个 peer，否则一阵连续发送就是每发一条问一遍。过期答案是安全的：不再持有该会话的 peer 会明说，发送方随即重新解析。`0` 表示每次都问。 |

profile patch 中省略的键会回退到上述默认值。

### 跨进程

默认关闭。打开它会把信任边界从"本进程"扩大到**"同一 OS 用户、同一 `DSH_HOME` 下的每一个 DSH 进程"**，所以它必须是一个刻意的动作，而不是悄悄开始生效的东西。

这条边界究竟是什么：

| 性质 | 如何成立 |
|---|---|
| 哪些进程互相可见 | 只有共享同一个 `DSH_HOME` 的进程。同一台机器上的两个 home 是两个互不相通的世界。 |
| 谁能连接 | 端点目录是 `0700`，其中每个文件是 `0600`，因此其他 OS 用户无法枚举 peer，也读不到 token。当 `DSH_HOME` 过长、socket 被迫落到共享临时目录时，该目录会被**校验**而不是被信任——必须是真实目录（不是符号链接）、属于当前用户、权限 `0700`——因为在 Linux 上 `/tmp` 任何人都能抢先创建。 |
| 谁能对话 | 握手 token，从 peer 自己的 `0600` 文件读取。在 Windows 上这不是纵深防御而是主要防线：命名管道自身没有文件系统权限模型。 |
| peer 能做什么 | 不比本地多。**接收方**会重新跑自己的白名单、归档检查与限速；发送方无法用说辞绕过它们。 |
| 是否会离开本机 | 不会。Unix domain socket 或 Windows 命名管道，都是本地的。没有网络监听，也没有端口。 |

**跨进程时谁裁决权限：永远是接收方进程。** 一个授权意味着"这个会话可以给我发消息"，而它是用 `/bus allow` 在**持有被发消息那个会话的进程里**做出的——发送方进程看不到它，也不去尝试。对于由别处持有的目标，发送方转发过去，由那个进程施加自己的白名单、归档状态与限速；对于本地持有的目标，它照旧自行检查，因为在那里接收方与发送方是同一份白名单。这才使得跨进程的一对会话**仅凭接收方的同意**就能工作——若要求规则必须写进两个进程的配置，那么一个真实给出的同意就等于没有生效。

两个值得直说的推论。第一，一个谎报自身身份的 peer 本来就在信任边界之内——接收方在能看到发送方 session 时优先采用**自己的**视图，只有在完全看不到时才会退回发送方的说法。第二，打开传输本身不授予任何权限：`allow` 为空时，两个互相可见的进程依然无法互发消息。


### 两种白名单规则

```yaml
allow:
  # 1. id 模式 —— 精确匹配、尾部 * 前缀、或 '*' 匹配任意
  - from: 'session-abc'
    to: 'session-worker-*'

  # 2. 同工作区 —— 任意两个共享工作区的根 session
  - sameWorkspace: true

  # ……也可收窄到某一个工作区
  - sameWorkspace: true
    cwd: '/Users/you/project'

  # ……并把 subagent 子 agent 也纳入（默认关闭）
  - sameWorkspace: true
    includeSubagents: true
```

id 模式不是 glob：`*` 只在末尾有意义。

工作区规则的存在理由：session id 是随机 UUID，你无法为一个尚不存在的 session 预先写 id 规则 —— 那会让「我想试两个 session 对话」变成「先建好、再改配置、再重启一次」。它也比 `'*'` 更窄：不相关项目里的 session 不会匹配。

工作区规则要求双方都有**已记录**的工作区。两个 DSH 未记录工作目录的 session 不算「同一工作区」，而是无从定位，规则会拒绝它们，而不是悄悄放行所有这类 session。

工作区规则还会拒绝任意一方是 **subagent 子 agent** 的配对，除非规则设置了 `includeSubagents: true`。`dsh-subagent` 会让每个子 agent 继承父级的 `cwd`，若不排除，一个正在读不可信文件或网页的 subagent 就能给同项目里的每个根 session 下指令、甚至把它们冷恢复。子 agent 通过 header 识别（`origin: 'subagent'` 或正的 `delegationDepth`）；用户主动 fork 出的 session 是平级的，仍会匹配。id 规则是显式的，不受影响。

### 为什么默认拒绝

总线消息是以 **user message** 投递的，而模型会把 user message 当指令。因此一个宽松的总线就是 prompt injection 通道：任何 session —— 包括你为了读一个不可信文件而 spawn 的 subagent —— 都能给你的主 session 下指令。默认拒绝加显式白名单，让这件事成为一个刻意的选择；工作区规则对 subagent 的排除，则保证这条方便的规则不会把这个通道重新打开。

每个配对的限速是第二道闸门：两个都会快速自动回复的 agent 否则会永远循环，每一跳都在烧 token。它限制的是对话的速率，而不是长度。

### 运行时修改白名单：`/bus`

配置文件是基线，但它没法提前写 —— 所以 `/bus` 让你在会话里直接改白名单，不用重启，也不需要图形界面：

```
/bus id                    显示本会话的 id
/bus list                  谁能给本会话发消息，以及依据是什么
/bus allow <session>       允许 <session> 给本会话发消息
/bus revoke <session>      撤销上面这条
```

`<session>` 是完整 id 或无歧义的 id 前缀，解析方式与 `bus_send` 解析目标完全一致 —— 打错字会立刻报错，而不是持久化一条永远匹配不上的授权。

**授权语义是"接收方同意"。** 在会话 A 里执行 `/bus allow <peer>` 表示*该 peer 可以给 A 发消息*。每一侧的用户各自决定谁能给自己下指令，因此双向对话需要两侧各授权一次。若改成"一次授权双向通信"，就等于让 A 的用户替 B 决定谁能指挥 B。

运行时授权是**只做叠加、可以撤销**的，而且会持久化：写入 `peer_bus_allowlist` storage domain，重启后依然有效。`/bus revoke` 只能收回用这种方式给出的授权，无法削减配置文件里的规则；遇到这种情况它会如实说明，而不是谎报成功：

```
$ /bus revoke session-abc
Runtime grant revoked, but the config allowlist still permits session-abc to message this session.
```

**没有任何模型工具能做这件事。** `/bus` 只注册在人类命令注册表上；刻意不提供 `bus_allow` 工具，因此 agent 无法给自己扩权。正文以 `/bus allow …` 开头的总线消息会被当作纯文本投递，永远不会被解释执行 —— e2e 直接断言投递期间命令注册表一次都没被调用。

如果某个 profile 没挂载命令注册表，或者解析不到 `zod`（storage domain 层用它做校验），总线依然可用：命令被跳过，运行时授权只留在内存里，并给出一条说明是这两种情况中哪一种的警告。

## 验证

除最后一项外，以下检查全部离线 —— 无网络、无模型调用。这里陈述的结果就是由它们跑出来的。

```bash
npm run link-dev-deps   # 一次性：从本地 DSH 安装软链 @deepseek-ai/*
npm test                # 277 个单元测试
```

更重的检查会从工作区内的 `DSH_HOME` 启动真实 DSH profile，因此绝不碰你自己的 `~/.dsh`：

```bash
npm run test-home       # 一次性：生成 .dsh-test/profiles/{headless,web}
npm run boot-check      # 插件挂载并注册六个工具
npm run boot-check:web  # 同上，但在 web profile 上，且不占用 3080 端口
npm run e2e             # 两个独立 session 真实对话
npm run e2e:web         # 同上，但在 web profile 上 —— 那里的冷恢复走宿主 lookup
npm run restart-e2e     # 该对话在真实进程重启后仍然存在
```

`DSH_HOME` 由 `scripts/dsh-home.mjs` 强制指向 `.dsh-test`，每个检查脚本都最先 import 它 —— 环境里已有的 `DSH_HOME` 是真实 DSH 会话自己的 home，因此这里是被覆盖而不是被继承。用 `BUS_TEST_DSH_HOME` 可以指向另一个一次性 home。

`test-home` 有意让两个 profile 走不同的挂载路径：`headless` 由 overlay 挂载，因此 `bus.patch.yml` 在完全不 bundle 本包的 profile 上依然可用；`web` 由本包自己的 bundle 层挂载，因此被测的是真正发布的 `cordis.patch.yml` —— 也就是 `dsh plugin add` 实际组合的东西。patch 的 `insert` 是**追加**，不会按 id 替换已有行；所以既 bundle 本包、又用 overlay insert 一次，会挂载出两个总线：同一个服务名下两个实例、两套工具。

| 检查 | 它证明了什么 |
|---|---|
| `npm test` | 277 个单元测试：寻址、两种白名单规则及 subagent 排除、roster 范围、限速（含退还与过期清理）、路由、各目标状态、过期 resume 的恢复、日志锁冲突、路由恢复、归档防护（registry 挂载与缺失两种情况都覆盖）、运行时白名单（`/bus` 授权、撤销、列表、持久化读取，以及为它做的等待）、冷恢复的路径优先级（宿主 lookup 优先、手工回退、`session/writer-held` 映射为 `target-busy`）、标题解析（唯一标题可解析、歧义标题列出候选、id 前缀优先）、`bus_ask`（按 claim 到的 turn 关联答复、忽略更晚的 turn、pending 与迟到投递、等待环拒绝含三会话链、取消与 dispose）、投递回执（在 `followup()` 内同步发生的 claim 依然被记录、仅发送方可读、`received` 不会被其自身移除产生的 discard 覆盖、容量上限）、已恢复 agent 的空闲释放（只在完整静默期后释放；运行中、inbox 有待处理、处于 ask 中时保留；与释放赛跑的发送会重新恢复会话；宿主恢复的会话不受影响）、`bus_wait` 把 `bus_ask` 问题留给负责回答它的 turn、工具执行器（所用的 fake 会像 DSH 一样禁止在事件发布期间嵌套 append），以及 invariant 校验器（含伴随模块**不**把 `invariants` 声明为自身依赖、因而不会在启动时留下 pending entry）。 跨进程测试另加：帧读取器重组被切开的多字节字符与逐字节到达的大消息；认领本的原子创建、失效属主接管、仅属主可读的文件，以及"释放只移除仍属于自己的认领"；投递去重与超时的 unknown 结果；握手截止时间与握手前帧上限；共享临时目录检查拒绝符号链接与世界可读目录；`liveRows` 不读持久化即可作答；三个总线中跨全部三者的等待环、以及提问隐含的边在结算时被释放；两个进程争抢同一个已存储会话；归属缓存及其过期、以及在 peer 死亡后的纠正；接收方的运行时授权决定一次跨进程发送；以及远端目标的归档状态在发出之前即可见。 |
| `npm run boot-check` | 插件经真实 profile 加载器载入，并注册其服务与六个工具。同时报告 `./invariant` 伴随模块是已注册还是在本 profile 上静默失效，以及 workspace registry 是否挂载 —— 这两个可选能力决定了哪些代码路径是活的。 |
| `npm run e2e` | 在真实启动上以脚本化 stub `LlmAdapter` 跑 93 条断言：投递、`peer-bus-message` 归因、空闲唤醒、冷恢复及卸载后的重新恢复、subagent 排除与 roster 范围、默认拒绝；由模型**在真实 turn 内调用** `bus_wait`，分别覆盖等待中途到达和本 turn 早先到达的投递 —— turn 能正常结束、工具返回剥离了归因前缀的正文，且该消息不会再作为独立 turn 运行；对**真实** workspace registry 的归档防护，覆盖已存储目标与仍在线的归档目标，并验证取消归档后恢复可达；真实会话经 `sessionTitle.rename` 改名后按标题解析并投递；`bus_ask` **由模型在真实 turn 内调用**：答复回到调用方的工具结果里、互相提问在应答那一轮里以 `ask-cycle` 被拒、目标忙时返回 `pending` 且其答复随后以带 ask id 的总线消息到达；`/bus` 授权一对配置本来拒绝的会话、把该授权写进**真实** storage domain、再撤销它 —— 外加一条直接证据：正文以 `/bus` 开头的消息不会执行任何命令；针对真实 turn 的 `bus_status` —— 带真实 turn 编号的 `claimed`、忙碌目标上先 `queued` 后 `claimed`、真实 `cancel()` 之后的 `discarded`、被目标模型用 `bus_wait` 取走的 `received`，以及非发送方得到 `unknown`；一个会话正在 `bus_wait` 时另一个会话向它提问，证明等待不会吞掉问题、提问方仍拿到答复；在手工恢复路径上，空闲的已恢复会话被 sweep 释放，释放前日志锁被持有、释放后可被重新打开，且下一条消息会再次恢复它；以及 `./invariant` 伴随模块已注册且未误拒合法流量。 |
| `npm run e2e:web` | 89 条断言 —— 在 **web** profile 上跑同样的场景，只有那里存在宿主恢复路径：`sessionController` 配置了 Typert `agent` lookup，因此这一轮里每次冷恢复走的都是官方路径而不是手工路径。与恢复相关的场景是路径感知的，所以条数与 `e2e` 不同：手工路径证明插件会释放自己持有的 handle、重新 resume 而不是拿陈旧缓存顶替、并释放空闲的已恢复会话；宿主路径证明的则是相反的性质 —— 根本不持有 handle，空闲 sweep 也不会动宿主所有的会话。 |
| `npm run restart-e2e` | 以**两个独立进程**在同一 `DSH_HOME` 上跑两个阶段；`verify` 全新启动并从磁盘上的持久化日志文件读回。seed 阶段还会执行一次 `/bus allow`，因此 `verify` 证明了运行时授权是被一个从未做过该授权的进程从存储里读回来的。真实进程边界是关键 —— 原地 resume 不能验证持久性。 |

### 真实模型

```bash
npm run real-model-check   # 会在你配置的模型路由上消耗真实 token
```

在 `web` profile（宿主恢复路径）、隔离的测试 home 中运行两个真实模型会话，不占用端口。它只在运行时从你真实的 `~/.dsh` **读取**两样东西：web profile 里的 `llm-pi-ai` 与 `agent-default-model` 两行（复制到 `.dsh-test/` 下一个被 gitignore 的 overlay），以及这两行指向的 API key —— 只载入脚本自身的进程环境，从不打印或写出。提示词都是普通的任务请求，从不点名任何总线工具：

1. planner 必须从拥有 `release.json` 的 worker 会话那里问到版本号。
2. worker 被卸载后，planner 再问它代号 —— 答案只能来自总线按其记录路由冷恢复的会话。
3. planner 给 worker 发一条单向通知，并且要确认对方已收到。

机制结果（投递、归因、真实路由上的冷恢复、回执）是硬性检查；模型选了什么只记作观察。在 `opencode-go/deepseek-v4.1-flash`、DSH `0.2.0-rc.2` 上跑了两次：所有检查通过；在没有被告知用哪个工具的情况下，planner 两次提问都选了 `bus_ask`，"发通知并确认送达"则选了 `bus_send` + `bus_status`。完整对话记录见 [verification/real-model-2026-10-01.md](verification/real-model-2026-10-01.md)。

**它抓到了什么。** 第一次运行暴露了 stub 永远发现不了的缺陷：`bus_ask` 的问题措辞和普通消息一样，目标在本轮作答后**又**用 `bus_send` 把答案发了一遍 —— 提问方收到两次，还多跑了一轮。现在问题会说明本轮回复会自动返回；修改后的两次运行里 worker 都只答了一次。修复前的那次运行保留在 [verification/real-model-2026-10-01-before-question-framing.md](verification/real-model-2026-10-01-before-question-framing.md)。

两个官方 DSH 测试工具包 —— `@deepseek-ai/dsh-agent-loop-testkit` 与 `@deepseek-ai/dsh-llm-mock-server` —— 是已发布包的 `devDependencies`，**在正式安装中并不存在**，因此本包无法使用它们。`scripts/e2e-bus.mjs` 里的 stub adapter 代替了 mock server：它只实现唯一必需的 `LlmAdapter.stream()` 方法，其余全部依赖基类默认实现。

## 已知限制

- **跨进程触达是选择性开启的，默认关闭。** `crossProcess: false` 时所有投递路径都是进程内的：另一个 DSH 进程持有的 session 在 roster 里显示为已存储，向它发送会因该进程持有日志锁而被拒为 `target-busy`。打开传输后这些 session 就可触达——它们会以 remote 标记出现在 roster 里，`bus_send`、`bus_ask`、`bus_reply`、`bus_status`、`bus_roster` 都跨边界可用。仍然保持本地的部分：传输是 Unix domain socket（Windows 命名管道），**不跨机器**。跨重启的持久性与这是两件事，两者都成立——已存储的 session 会被之后的进程 resume 并唤醒。
- **没开启传输的 peer 是不可见的，这不是 bug。** 发现按 `DSH_HOME` 且按选择性开启划分，所以旧版本进程、或关了 `crossProcess` 的进程，就是不在这张网里。向它持有的 session 发送会被拒为 `target-busy`，并且消息会说明原因。
- **冷恢复的 agent 空闲后会被释放 —— 仅限回退路径。** 总线**自己**恢复的会话（没有宿主 lookup，例如 `headless`）在空闲、inbox 为空且没有进行中的 ask 满 `resumedIdleMs`（10 分钟）后被释放，同时释放日志锁，其他进程就能再打开它；下一条消息会再次把它恢复。经宿主自身 lookup 恢复的会话（`web`）归宿主所有，和在 GUI 里打开的一样，总线从不卸载它。如果一个由总线在回退路径上恢复的会话**同时**在 GUI 中打开，总线仍可能在一段静默期后释放它；GUI 会在下一次请求时重新恢复它。
- **每次发送都会从持久化重建 roster，成本随历史增长。** 每个 `bus_send`、`bus_ask` 和地址解析都会调用 `sessionPersistence.list()`，因此开销正比于**已存储**会话数，而不是在线会话数。在本仓库测试 home 上实测：1,123 个已存储会话时 `list()` 约 135–141 ms，整个 `roster()` 约 124–135 ms —— 而且每次发送都要再付一次。显而易见的修法是 live-first lookup（先只在在线 agent 里解析地址，地址不在线时才退回全量列表），目前**有意未做**，这是有意推迟的优化，不是遗漏。
- **冷恢复在跨进程之间是单一赢家，而这正是总线提供的。** 下层做不到：会话日志有真实的跨进程 `flock(2)`，但那把锁守的是**写句柄**，`agents.resume` 并不去取它，所以两个进程同时决定恢复同一个已存储会话时**都会成功**。总线在唯一可能竞争的群体之间做仲裁——恢复之前，进程用一次原子的 `open(…, 'wx')` 在 `$DSH_HOME/peer-bus/claims/` 下认领该会话。赢家负责恢复；输家等赢家真正持有会话之后，**把消息转发给它**，所以不会有消息被丢掉。认领文件里的 pid 已不存在时可被接管；恢复失败会把认领交还；会话被释放或进程卸载时删除认领。仅在 `crossProcess` 开启时存在。`npm run e2e:xproc` 用两个真实进程布置这场竞争并断言结果。一次通过运行的记录见 [verification/real-model-xproc-2026-10-02.md](verification/real-model-xproc-2026-10-02.md)。
- **转发投递超时会报"状态未知"，而不是失败。** 如果对端在 `crossProcessDeliverTimeoutMs` 内没有应答，`bus_send` 返回 `targetState: "unknown"` 并给出可查询的 id——因为对端很可能**已经投递成功**，而报错会诱导模型重发。无论如何重发都是安全的：发送方给每次投递打上标记，接收进程遇到已经见过的 id 会判定为重复，返回原来的结果而不是第二次唤醒目标。
- **路由是推断的，不是声明的。** 冷恢复读取最后一条 `request/header`（没有则读 `request/context`）事件来还原 provider、model 与 reasoning effort。从未发起过模型请求的 session 没有记录路由，恢复后的 turn 会是空的。
- **回执跟踪的是投递，不是意图。** `bus_status` 能说明消息被取进了某个 turn、被 `bus_wait` 取走或被丢弃，但不能说明目标是否照消息去做了。回执只存在于本进程，重启后不保留。要拿答复，请用 `bus_ask`，或用 `bus_wait` 等回复。
- **`bus_wait` 会消费消息。** 它把消息从待处理 inbox 中取走，因此同一份内容不会再跑成一个 turn。这是刻意的：窥视会导致重复投递、浪费一个 turn，并让两个互相等待的 session 一直 ping-pong 到触发限速为止。如果你更希望回复作为你的下一个 turn 到达，就不要调用它。
- **真实模型验证是单独的、要花钱的检查。** 除 `real-model-check` 外，验证一节的所有检查都用脚本化 stub `LlmAdapter`，在离线且确定性的前提下证明投递、唤醒、持久化、归因与策略。npm run e2e:xproc          # 两个真实 DSH 进程，stub 模型，免费
npm run real-model-check   # 真机路由，消耗额度
npm run real-model-xproc   # 两个真实进程 + 真模型，消耗额度

## 依赖要求

DeepSeek Harness `>=0.1.7-rc.2 <0.3.0`，已在 `0.1.7-rc.2` 与 `0.2.0-rc.2` 上验证。自 0.2.0 起，DSH 在启动时会用运行版本逐一核对插件的每个 `@deepseek-ai/dsh*` peer 范围，不匹配就拒绝挂载，因此这个范围必须覆盖你实际运行的宿主版本。上限停在 0.3.0 之前，因为 0.x 的 minor 版本可能改动插件 API；放宽前请先重跑[验证](#验证)中的检查。本包把 `@deepseek-ai/*` 声明为 `peerDependencies`，以便从宿主安装解析而非自带副本；其中 `dsh-invariants` 与 `dsh-session-query` 标为 optional，因为冷恢复与 invariant 伴随模块都是可选能力（DSH 仍会核对它们的范围）。

## 许可

MIT —— 见 [LICENSE](LICENSE)。
