# Chat2Codex

[English](README.md) | [简体中文](README.zh-CN.md)

从飞书/Lark 聊天里运行你本机的 Codex。

Chat2Codex 会把一个飞书/Lark 机器人变成本机 Codex CLI 的消息平台。你可以在聊天里发送需求、文件和图片；接收 Codex 的执行进度和最终回复；通过卡片审批 Codex 动作；也可以继续本机已有的 Codex 会话，而不需要暴露公网 webhook 服务。

## 当前状态

- 当前已经实现的是飞书/Lark 长连接适配器。Slack、Discord 等其他聊天平台还在路线图中。
- 私聊默认开启，并且可以切换到任意本机目录。
- 群聊默认关闭，必须显式加入允许列表，并且可以用 `CODEX_GROUP_ALLOWED_ROOTS` 限制可访问目录。
- Codex app-server 协议仍是实验性能力。升级 Codex CLI 后，请按 [Codex App-Server 防护检查](#codex-app-server-防护检查) 运行 smoke test。

## 快速开始

### 前置条件

- Bun `>= 1.3.9`，用于安装和本地开发。
- Node.js `>= 20.12.0`。
- 一个自己创建的飞书/Lark 应用，并已启用机器人能力。
- 运行 Chat2Codex 的机器上已经安装并登录 Codex CLI。
- 飞书/Lark 应用需要消息接收、消息发送、消息资源读取权限，消息事件的长连接订阅，以及 `card.action.trigger` 卡片回调。

### 安装并运行

```bash
bun install
```

通过扫码自动创建并连接飞书/Lark 应用：

```bash
bun run setup:feishu
```

setup 命令会在终端渲染二维码，并保留授权 URL 作为备用入口。用飞书/Lark 扫码，确认创建应用后，它会把 `FEISHU_APP_ID`、`FEISHU_APP_SECRET` 和 `LARK_DOMAIN` 写入 `.env`。如果你已经有应用，也可以复制 [`.env.example`](.env.example) 为 `.env` 后手动编辑。

然后运行：

```bash
bun run dev
```

给机器人发送私聊消息：

```text
/status
Summarize this repository.
```

你也可以发送文件或图片。Chat2Codex 会把支持的附件下载到 `ATTACHMENT_DOWNLOAD_DIR`，并把本地路径附加到 Codex prompt 中。如果消息只有附件没有文字，它会使用默认 prompt，让 Codex 检查这个文件或图片。

运行过程中，Chat2Codex 会发送一张状态卡片，最多每 15 秒更新一次，并把最终 Codex 回复渲染成飞书/Lark 富文本消息。点击卡片里的停止按钮，或发送 `/stop`，可以中止当前运行。失败和已停止的卡片会带有重试按钮，可以重新运行同一个 prompt。如果卡片创建或更新失败，会回退为文本进度消息。

## 功能

- 飞书/Lark 长连接机器人，不需要公网 webhook 服务。
- 每个 chat 对应一个 Codex 会话。
- 支持 `/status`、`/projects`、`/project <index|path>`、`/threads`、`/resume`、`/new`、`/cd <path>`、`/stop` 和 `/whoami` 命令。
- 使用 JSON 保存本地状态。
- 使用 Codex app-server JSON-RPC 获取机器可读的进度、最终输出和审批回调。
- Codex 运行时会限频更新状态卡片，并提供停止/重试按钮；卡片不可用时自动回退为文本。
- 支持用飞书/Lark 审批卡片处理 Codex 命令执行和文件变更审批请求。按钮会根据 Codex 当前提供的审批选项生成，包括 Approve、Approve session、Deny、Cancel turn 等。
- 支持飞书/Lark 图片和文件消息，把附件下载为本地路径后随 prompt 传给 Codex。
- 在日志和 `/status` 中记录近期消息路由/丢弃诊断信息。
- Codex 失败或无法启动时，会返回适合团队机器人场景的错误摘要。
- 最终 Codex 回复会渲染为飞书/Lark 富文本消息。
- 支持用户级 launchd/systemd 服务，方便长期运行团队机器人。

## 项目文档

- [贡献指南](CONTRIBUTING.md)
- [安全策略](SECURITY.md)
- [更新日志](CHANGELOG.md)
- [Codex app-server 协议快照](docs/codex-app-server-protocol/)
- [英文 README](README.md)

## Codex App-Server 防护检查

Chat2Codex 使用实验性的 `codex app-server --stdio` 协议来控制线程、接收进度事件和处理审批回调。安装或升级 Codex CLI 后，先运行快速本地 smoke test：

```bash
bun run smoke:app-server
```

这个命令会在临时工作区验证 `initialize` 和 `thread/start`，但不会启动模型 turn。如果还想验证一次完整的模型 turn：

```bash
bun run smoke:app-server:turn
```

如果要验证真实的命令审批请求：

```bash
bun run smoke:app-server:approval
```

这个模式会使用临时工作区、`approvalPolicy=untrusted` 和 `sandbox=workspace-write`。它会要求 Codex 创建 `approval-smoke.txt`，验证 app-server 发出 `item/commandExecution/requestApproval`，返回 `accept`，等待 `turn/completed`，然后检查文件内容。

当前生成的协议快照在 [`docs/codex-app-server-protocol`](docs/codex-app-server-protocol/) 下。升级 Codex CLI 后可以刷新：

```bash
bun run protocol:generate
git diff -- docs/codex-app-server-protocol
```

修改 [`src/agent/codex-runner.ts`](src/agent/codex-runner.ts) 前，请先检查协议 schema diff；如果 app-server 的请求形状未知，审批逻辑应该默认关闭而不是放行。

当 `CODEX_APPROVAL_POLICY` 允许交互式审批时，Codex app-server 会在 turn 运行过程中发出审批请求。Chat2Codex 会向同一个 chat 发送一张独立审批卡片，并暂停 Codex，直到授权用户点击其中一个选项。命令执行审批卡片的按钮会镜像 Codex 的 `availableDecisions`；文件变更审批卡片会使用 Codex 的文件变更审批选项。

用当前 `bun run setup:feishu` 流程创建的应用会包含这个回调。如果你的飞书/Lark 应用是在状态卡片动作加入之前创建的，请在开发者后台手动订阅 `card.action.trigger` 回调，这样停止按钮才能通过长连接回到这个桥接服务。

如果你的应用是在附件能力加入之前创建的，也需要补充飞书/Lark `im.v1.messageResource.get` API 所需的消息资源读取权限；否则文本消息仍然可用，但附件下载会失败。

群聊消息只有在显式提到机器人时才会被处理。要启用一个群聊，先在目标群里发送 `@Chat2Codex /whoami`，复制返回的 `chat_id`，然后配置：

```env
ALLOW_GROUPS=true
ALLOWED_CHAT_IDS=oc_xxx
```

## 团队机器人部署

如果要在团队群里使用，请保持机器人在允许列表内，并把它作为用户级后台服务运行，而不是长期把 `bun run dev` 留在终端里。

1. 在目标群里发送 `@Chat2Codex /whoami`，复制返回的 `chat_id`。
2. 更新 `.env`：

   ```env
   ALLOW_GROUPS=true
   ALLOWED_CHAT_IDS=oc_xxx
   ALLOWED_USER_IDS=ou_xxx,ou_yyy
   CODEX_WORKDIR=/absolute/path/to/your/repo
   CODEX_GROUP_ALLOWED_ROOTS=/absolute/path/to/your/repo,/absolute/path/to/team/repos
   CODEX_BIN=/absolute/path/to/codex
   CODEX_APPROVAL_POLICY=on-request
   ATTACHMENT_DOWNLOAD_DIR=/absolute/path/to/chat2codex-attachments
   ```

   后台服务建议把 `CODEX_BIN` 配成绝对路径，因为 launchd 和 systemd 不会加载你的交互式 shell 启动文件。
   如果机器人需要无人值守运行，不希望等待飞书/Lark 审批点击，可以使用 `CODEX_APPROVAL_POLICY=never`。

3. 构建并预览服务文件：

   ```bash
   bun run build
   bun run service:print
   ```

4. 安装用户级服务：

   ```bash
   bun run setup:service
   ```

   在 macOS 上会安装名为 `com.chat2codex.bridge` 的 launchd agent；在 Linux 上会安装名为 `chat2codex.service` 的 systemd user service。

常用服务命令：

```bash
# macOS 状态和日志
launchctl print gui/$(id -u)/com.chat2codex.bridge
tail -f .data/logs/chat2codex.out.log .data/logs/chat2codex.err.log

# Linux 状态和日志
systemctl --user status chat2codex
journalctl --user -u chat2codex -f

# 卸载用户级服务
bun run service:uninstall
```

## 聊天命令

| 命令 | 作用 |
| --- | --- |
| `/status` | 显示当前 chat 会话、cwd、附件目录和近期事件诊断。 |
| `/projects` | 按 cwd 分组列出 Codex app-server 发现的项目。 |
| `/project <index\|path>` | 通过编号进入已列出的项目，或切换到指定目录，并清空当前选中的线程。 |
| `/threads` | 列出当前项目最近的 Codex 对话。`/sessions` 是别名。 |
| `/resume <index\|thread_id>` | 通过编号继续已列出的对话，或直接通过 Codex thread id 加载。 |
| `/new` | 在当前项目开始一个新的 Codex 对话。 |
| `/cd <path>` | 修改当前 chat 的 cwd，并开始一个新的 Codex thread。 |
| `/stop` | 停止当前 chat 正在运行的 Codex。运行状态卡片里也有停止按钮。 |
| `/whoami` | 显示当前 `chat_id`、chat 类型、发送者 id 和访问判断。 |

## 安全默认值

Chat2Codex 默认使用 `CODEX_SANDBOX=workspace-write`，所以 Codex 可以编辑当前选中的工作区。对于只问答、不改代码的机器人，可以改成 `read-only`。

默认 `CODEX_APPROVAL_POLICY=never`，适合无人值守运行。如果你希望 Codex 审批请求以飞书/Lark 卡片形式出现，可以设置为 `CODEX_APPROVAL_POLICY=on-request` 或 `untrusted`。在群聊中，审批按钮只能由 `ALLOWED_USER_IDS` 中列出的用户处理。

私聊默认开启。群聊消息必须提到机器人，并且群聊默认关闭，直到同时配置 `ALLOW_GROUPS=true` 和 `ALLOWED_CHAT_IDS`。你也可以把 `ALLOWED_USER_IDS` 设置为发送者 `open_id`、`user_id` 或 `union_id` 的逗号分隔列表。私聊可以切换到任意本机目录；群聊只能切换到 `CODEX_GROUP_ALLOWED_ROOTS`，如果没有配置这个变量，则只能使用 `CODEX_WORKDIR`。

不要在有不可信成员的群里，以宽泛文件系统权限运行这个机器人。一个能驱动本地 coding agent 的聊天机器人，本质上就是你机器的远程控制入口。

## 运行形态

这个项目本地开发以 Bun 为主，但生产运行会构建为标准 Node.js ESM：

```bash
bun run build
node dist/index.js
```

只有在你的环境中验证过飞书 SDK 长连接路径后，才建议使用 `bun run start:bun`。

Chat2Codex 是非官方项目，与 OpenAI 没有关联。

## 测试

```bash
bun run check
```

这个命令会运行 TypeScript 类型检查、Bun 测试套件和生产构建。可以使用 `bun audit` 检查 Bun 依赖锁文件。

## 参与贡献

本地开发和 pull request 流程见 [CONTRIBUTING.md](CONTRIBUTING.md)。在共享 chat 中运行 Chat2Codex 或报告安全问题前，请先阅读 [SECURITY.md](SECURITY.md)。

## 后续功能

1. 更丰富的 `/status` 输出，包括队列深度、当前运行时长、审批等待时长和近期失败信息。
2. 为长期运行的团队机器人提供可配置的运行超时和审批超时。
3. 在 app-server 支持验证完成后，加入更高级的线程控制能力，例如 history、compact、fork 和 rollback。
4. 在新增 Slack、Discord 或其他平台前，抽象聊天适配器边界。
