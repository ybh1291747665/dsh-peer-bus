# dsh-peer-bus

[English](README.md) · **简体中文**

让两个 DSH 会话互相对话。

```
session A ──bus_send──▶ session B    （B 被唤醒，跑一个 turn）
```

## 安装

```bash
dsh plugin --profile web add dsh-peer-bus
```

重启 DSH。如果 `pnpm` 提示缺少 peer，忽略即可 —— 那些包由 DSH 运行时提供。

## 使用

你需要两个会话。在**每一个**里执行 `/bus id`，把打印出来的 id 复制下来。

**让它们能对话。** 一条授权表示*"这个会话可以给我发消息"*，所以要在**接收方**会话里做：

```
# 在会话 B 里 —— 从现在起 A 可以给 B 发消息
/bus allow <A 的 id>
```

然后直接用大白话跟会话 A 的模型说：

> 问一下 `<B 的 id>` 当前发布版本是多少。

它会调用 `bus_ask`，B 被唤醒、作答，答复在同一轮里返回。只想单向发消息就说"给 `<B 的 id>` 发条消息说……"。**工具名你永远不用自己敲** —— 模型会挑。

想让反方向也能发，就在会话 A 里执行 `/bus allow <B 的 id>`。

## 模型能用什么

| | |
|---|---|
| `bus_send` | 发一条消息，目标被唤醒并跑一个 turn |
| `bus_ask` | 提问，并在同一轮里拿回答复 |
| `bus_reply` | 显式作答 |
| `bus_wait` | 主动取走来信，而不是让它跑成一轮 |
| `bus_roster` | 列出本会话能触达的会话 |
| `bus_status` | 查询你发出的消息后来怎样了 |
| `/bus` | **你**用来授权与撤销 —— 任何模型都做不到 |

## 权限

不给授权就什么都不许。两种方式：

- **`/bus allow <id>`** —— 单个会话、单个方向、不用重启，且持久有效。
- **工作区规则** —— 一个项目里的所有会话，写在 profile 的 `cordis.patch.yml` 里：

```yaml
- id: peer-bus
  config:
    allow:
      - sameWorkspace: true
```

总线消息是以 *user* 消息投递的，而模型会把 user 消息当指令 —— 所以一个敞开的总线就是 prompt injection 通道。因此默认拒绝。

## 两个进程之间

默认关闭。要触达由另一个 DSH 进程持有的会话，在**两个进程里**都设置：

```yaml
- id: peer-bus
  config:
    crossProcess: true
```

裁决方依然是接收进程，所以在某个进程里做的授权只管那个进程的会话。

## 更多

- **[USAGE.md](USAGE.md)（英文）** —— 每个工具的细节、全部配置键、错误码、故障排查
- **[verification/](verification/)** —— 测试了什么，以及测试证明不了什么

MIT —— 见 [LICENSE](LICENSE)。
