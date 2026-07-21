# Chat2Codex

[English](README.md) | [简体中文](README.zh-CN.md)

从飞书/Lark 聊天里运行你本机的 Codex。

Chat2Codex 会把一个飞书/Lark 机器人变成本机 Codex CLI 的消息平台。你可以在聊天里发送需求、文件和图片；接收 Codex 的执行进度和最终回复；通过卡片审批 Codex 动作；也可以继续本机已有的 Codex 会话，而不需要暴露公网 webhook 服务。

## 当前状态

- 当前已经实现的是飞书/Lark 长连接适配器。Slack、Discord 等其他聊天平台还在路线图中。
- 私聊路由默认开启，但除 `/whoami` 外，发送者或私聊 chat 必须显式加入允许列表；授权后的私聊可以切换到任意本机目录。
- 群聊默认关闭，启用后必须同时允许 chat 和发送者，并且可以用 `CODEX_GROUP_ALLOWED_ROOTS` 限制可访问目录。
- Codex app-server 协议仍是实验性能力。安装或升级 Codex CLI 后，请先运行 `chat2codex doctor`，再按 [Codex App-Server 防护检查](#codex-app-server-防护检查) 完成验证。

## 快速开始

### 前置条件

- Node.js `>= 20.12.0`。
- npm，用于安装包。
- 运行 Chat2Codex 的机器上已经安装并登录 Codex CLI。
- 一个可以创建应用的飞书/Lark 账号，或一个已经启用机器人的飞书/Lark 应用。
- 飞书/Lark 应用需要消息接收、消息发送、消息资源读取权限，消息事件的长连接订阅，以及 `card.action.trigger` 卡片回调。

### 安装并运行

```bash
npm install -g chat2codex
```

通过扫码自动创建并连接飞书/Lark 应用：

```bash
chat2codex setup --workdir /absolute/path/to/your/repo
```

setup 命令会在终端渲染二维码，并保留授权 URL 作为备用入口。用飞书/Lark 扫码，确认创建应用后，它会把 `FEISHU_APP_ID`、`FEISHU_APP_SECRET`、`LARK_DOMAIN` 和扫码用户的 `open_id`（写入 `ALLOWED_USER_IDS`）保存到 `~/.chat2codex/.env`。如果你已经有应用，也可以运行 `chat2codex init --workdir /absolute/path/to/your/repo` 后手动编辑这份 env 文件；首次启动后可以发送 `/whoami` 获取需要加入允许列表的 id。

检查本地配置，然后启动桥接服务：

```bash
chat2codex doctor
chat2codex start
```

给机器人发送私聊消息：

```text
/status
Summarize this repository.
```

你也可以发送文件或图片。Chat2Codex 会把支持的附件下载到 `ATTACHMENT_DOWNLOAD_DIR`，并把本地路径附加到 Codex prompt 中。如果消息只有附件没有文字，它会使用默认 prompt，让 Codex 检查这个文件或图片。

运行过程中，Chat2Codex 会发送一张状态卡片，最多每 15 秒更新一次，并把最终 Codex 回复渲染成飞书/Lark 富文本消息。点击卡片里的停止按钮，或发送 `/stop`，可以中止当前运行。失败和已停止的卡片会带有重试按钮，可以重新运行同一个 prompt。完成卡片会展示紧凑的本轮结果，并提供摘要、文件、Diff、日志详情按钮；也可以发送 `/summary`、`/files`、`/diff`、`/logs` 查看同一轮详情。如果卡片创建或更新失败，会回退为文本进度消息。

### CLI 命令

| 命令 | 作用 |
| --- | --- |
| `/help` | 显示适合手机查看的 Chat2Codex 常用命令指南。 |
| `chat2codex` / `chat2codex start` | 启动飞书/Lark 桥接服务。 |
| `chat2codex setup --workdir <path>` | 创建/连接飞书/Lark 应用，并写入 `.env`。 |
| `chat2codex init --workdir <path>` | 已有应用时，创建一份初始 `.env`。 |
| `chat2codex doctor` | 检查 `.env`、Node.js、Codex CLI 与协议快照版本、工作目录和移动/群机器人安全提示。 |
| `chat2codex smoke [--mode turn\|approval]` | 本地验证 Codex app-server 协议。 |
| `chat2codex service print\|install\|uninstall` | 管理用户级 launchd/systemd 服务。 |

默认情况下，Chat2Codex 会把配置和运行状态放在 `~/.chat2codex`。如果需要多个机器人实例，可以设置 `CHAT2CODEX_HOME=/path/to/home`，或者通过 `--env /path/to/.env` 指定另一份配置文件。

## 功能

- 飞书/Lark 长连接机器人，不需要公网 webhook 服务。
- 每个 chat/thread scope 复用一个 Codex app-server 进程。只要发送者、cwd、thread、策略和 session epoch 不变，连续 turn 会保留同一进程以及 session 级授权。
- 支持 `/help`、`/status`、`/host`、`/projects`、`/project <index|path>`、`/threads`、`/history`、`/search`、`/resume`、`/fork`、`/archive`、`/archived`、`/unarchive`、`/retry`、`/usage`、`/service status|logs|restart`、`/compact`、`/plan <任务>`、`/new`、`/cd <path>`、`/stop`、`/steer`、`/answer`、`/mcp-answer`、`/summary`、`/files`、`/diff`、`/logs` 和 `/whoami` 命令。
- 使用 JSON 保存本地状态。
- 使用 Codex app-server JSON-RPC 获取机器可读的进度、最终输出和审批回调。
- Codex 运行时会限频更新状态卡片，并提供停止/重试、本轮详情按钮；卡片不可用时自动回退为文本。
- 支持用飞书/Lark 审批卡片处理 Codex 命令执行和文件变更审批请求。按钮会根据 Codex 当前提供的审批选项生成，包括 Approve、Approve session、Deny、Cancel turn 等。
- `/plan <任务>` 会只把当前一轮切换到 Codex Plan 模式，并支持结构化 `requestUserInput` 提问卡；自由输入可使用显式的 `/answer <回复码> <内容>`。选项会按原始请求在服务端重新校验；secret 问题会安全拒绝，不通过聊天记录收集凭据。下一条普通消息会显式恢复 Default 模式。
- 支持标准 MCP form 和 URL elicitation，并渲染为绑定原发送者的卡片。类型化表单字段也可以使用 `/mcp-answer <回复码> <JSON 引号包裹的字段 ID> <内容>`；字段值会按原始 schema 校验，敏感字段则安全拒绝。
- 支持 `item/permissions/requestApproval` 额外权限请求，并用卡片完整展示权限 profile。Chat2Codex 只提供拒绝、当前 turn 授权和当前 session 授权；任何授权都会返回 Codex 原始请求的 profile。
- 支持飞书/Lark 图片和文件消息，把附件下载为本地路径后随 prompt 传给 Codex。
- 在日志和 `/status` 中记录近期消息路由/丢弃诊断信息。
- `/status` 会显示队列深度、当前运行时长、审批等待时长和近期失败信息。
- `/host` 会发送 Host 健康卡，展示桥接主机、Codex binary、默认 cwd、队列、运行中任务、审批等待和移动/群机器人安全提示。
- 支持用 `/steer <补充指令>` 在当前 Codex 运行中追加指导，不会排在普通聊天任务队列后面。
- 支持在聊天里搜索、查看、分叉和压缩 Codex app-server 会话，方便从手机继续历史工作。
- 为无人值守团队机器人提供可选的运行超时和审批超时。
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

Chat2Codex 使用实验性的 `codex app-server --stdio` 协议来控制线程、接收进度事件和处理审批回调。安装或升级 Codex CLI 后，先运行：

```bash
chat2codex doctor
```

`doctor` 会把实际检测到的 `codex --version` 完整输出与内置协议快照记录的 Codex 版本做精确比对。如果版本不一致，或快照 manifest 缺失/无法读取，`doctor` 会给出兼容性警告，但不会仅因此判定检查失败。此时应把协议兼容性视为尚未验证，并继续运行快速本地 smoke test：

```bash
chat2codex smoke
```

这个命令会在临时工作区验证 `initialize` 和 `thread/start`，但不会启动模型 turn。如果还想验证一次完整的模型 turn：

```bash
chat2codex smoke --mode turn
```

指定历史 turn 的分叉采用更严格的兼容保护：只有正在运行的 app-server
版本与内置协议快照精确一致时，`/fork --turn` 才会发送 `thread/fork`。
旧版服务端可能忽略 `lastTurnId` 并静默退化为整线程分叉；普通 `/fork`
仍保留原有兼容行为。

如果要验证真实的命令审批请求：

```bash
chat2codex smoke --mode approval
```

这个模式会使用临时工作区、`approvalPolicy=untrusted` 和 `sandbox=workspace-write`。它会要求 Codex 创建 `approval-smoke.txt`，验证 app-server 发出 `item/commandExecution/requestApproval`，返回 `accept`，等待 `turn/completed`，然后检查文件内容。

当前生成的协议快照在 [`docs/codex-app-server-protocol`](docs/codex-app-server-protocol/) 下。升级 Codex CLI 后可以刷新：

```bash
bun run protocol:generate
git diff -- docs/codex-app-server-protocol
```

修改 [`src/agent/codex-runner.ts`](src/agent/codex-runner.ts) 前，请先检查协议 schema diff。Chat2Codex 只处理明确支持的 app-server 服务端请求：未知 method 会返回 JSON-RPC method-not-found 错误；格式不合法的审批请求会返回 invalid-params 错误，不会展示或自行补出批准选项。`/plan <任务>` 通过 app-server `collaborationMode` 启动单轮 Plan 模式；`item/tool/requestUserInput` 已支持卡片和显式 `/answer` 回复，请求字段和回调回答都会重新校验，已撤销请求会拒绝迟到回复，`isSecret` 问题因聊天无法保证遮罩输入而安全拒绝。标准 `mcpServer/elicitation/request` form 和 URL 请求已支持卡片交互，类型化表单值也可以使用 `/mcp-answer` 回复。桥接层不会持久化或回显 `requestUserInput` 与 MCP 的回答值，敏感表单字段会安全拒绝。OpenAI 专用的 MCP form 扩展不会参与能力协商。

`item/permissions/requestApproval` 也已支持绑定原发送者的审批卡，并完整展示请求的权限 profile。桥接层只允许 `deny`、`grantTurn` 和 `grantSession` 三种决定。授权时由 runner 克隆其持有的原始 profile；卡片 payload 不能替换权限，也不能开启 `strictAutoReview`。格式错误、信息不完整、已撤销或无法完整展示的请求都会安全拒绝。

当 `CODEX_APPROVAL_POLICY` 允许交互式审批时，Codex app-server 会在 turn 运行过程中发出审批请求。Chat2Codex 会向同一个 chat 发送一张独立审批卡片，并暂停 Codex，直到授权用户点击其中一个选项。命令执行审批卡片的按钮会镜像 Codex 的 `availableDecisions`。当前文件变更审批请求不包含目标文件或补丁详情，因此在这些信息能够被关联并完整展示前，Chat2Codex 只提供拒绝/取消。命令决策缺失或为 `null` 时，桥接层同样只展示拒绝/取消；决策列表格式不合法时则直接返回 invalid-params。审批卡会展示额外的文件系统/网络权限以及每条完整的 exec/network policy 规则；如果安全相关详情无法完整展示，卡片会移除所有允许类操作，只保留拒绝/取消，消息路由在处理卡片回调时也会执行相同的决策过滤。

用当前 `chat2codex setup` 流程创建的应用会包含这个回调。如果你的飞书/Lark 应用是在状态卡片动作加入之前创建的，请在开发者后台手动订阅 `card.action.trigger` 回调，这样停止按钮才能通过长连接回到这个桥接服务。

如果你的应用是在附件能力加入之前创建的，也需要补充飞书/Lark `im.v1.messageResource.get` API 所需的消息资源读取权限；否则文本消息仍然可用，但附件下载会失败。

群聊消息只有在显式提到机器人时才会被处理。要启用一个群聊，先在目标群里发送 `@Chat2Codex /whoami`，复制返回的 `chat_id`，然后配置：

```env
ALLOW_GROUPS=true
ALLOWED_CHAT_IDS=oc_xxx
```

群聊中的 `/whoami` 只会显示 `chat_id`、chat 类型和访问判断，不会把发送者 id 写入群消息记录。管理员需要获取发送者可用 id 时，应让该用户私聊机器人发送 `/whoami`。

## 团队机器人部署

如果要在团队群里使用，请保持机器人在允许列表内，并把它作为用户级后台服务运行，而不是长期把 `chat2codex start` 留在终端里。

1. 在目标群里发送 `@Chat2Codex /whoami`，复制返回的 `chat_id`。
2. 更新 `~/.chat2codex/.env`：

   ```env
   ALLOW_GROUPS=true
   ALLOWED_CHAT_IDS=oc_xxx
   ALLOWED_USER_IDS=ou_xxx,ou_yyy
   CODEX_WORKDIR=/absolute/path/to/your/repo
   CODEX_GROUP_ALLOWED_ROOTS=/absolute/path/to/your/repo,/absolute/path/to/team/repos
   CODEX_BIN=/absolute/path/to/codex
   CODEX_APPROVAL_POLICY=on-request
   CODEX_RUN_TIMEOUT_MS=1800000
   CODEX_APPROVAL_TIMEOUT_MS=300000
   ATTACHMENT_DOWNLOAD_DIR=/absolute/path/to/chat2codex-attachments
   ```

   后台服务建议把 `CODEX_BIN` 配成绝对路径，因为 launchd 和 systemd 不会加载你的交互式 shell 启动文件。
   如果机器人需要无人值守运行，不希望等待飞书/Lark 审批点击，可以使用 `CODEX_APPROVAL_POLICY=never`。
   `CODEX_RUN_TIMEOUT_MS=0` 和 `CODEX_APPROVAL_TIMEOUT_MS=0` 表示关闭自动超时；团队机器人建议设置为正整数毫秒值，避免任务或审批无限等待。

3. 预览服务文件：

   ```bash
   chat2codex service print
   ```

4. 安装用户级服务：

   ```bash
   chat2codex service install
   ```

   在 macOS 上会安装名为 `com.chat2codex.bridge` 的 launchd agent；在 Linux 上会安装名为 `chat2codex.service` 的 systemd user service。
   从旧版本升级后请重新运行 `chat2codex service install`，写入 `/service restart` 所需的 supervisor 标记。

常用服务命令：

```bash
# macOS 状态和日志
launchctl print gui/$(id -u)/com.chat2codex.bridge
tail -f ~/.chat2codex/.data/logs/chat2codex.out.log ~/.chat2codex/.data/logs/chat2codex.err.log

# Linux 状态和日志
systemctl --user status chat2codex
journalctl --user -u chat2codex -f

# 卸载用户级服务
chat2codex service uninstall
```

无论通过 npm 安装还是从源码安装用户服务，launchd 日志默认都写入 `~/.chat2codex/.data/logs`。前台执行 `bun run dev` 时，日志只输出到终端。文件日志会限制单条大小，并按 `LOG_FILE_MAX_BYTES` 和 `LOG_FILE_MAX_FILES` 轮转。如果源码开发时确实希望后台服务写入项目内目录，可以显式覆盖：

```bash
bun src/index.ts service install --env .env --project-dir . \
  --stdout .data/logs/chat2codex.out.log \
  --stderr .data/logs/chat2codex.err.log
```

## 聊天命令

| 命令 | 作用 |
| --- | --- |
| `/status` | 显示当前 chat 会话、cwd、队列深度、当前运行时长、审批等待时长、近期失败、附件目录和近期事件诊断。 |
| `/host` | 发送 Host 健康卡，展示 Codex CLI 可用性、服务路径、队列/审批数量和移动/群机器人安全提示。`/health` 是别名。 |
| `/projects` | 按 cwd 分组列出 Codex app-server 发现的项目。 |
| `/project <index\|path>` | 通过编号进入已列出的项目，或切换到指定目录，并清空当前选中的线程。 |
| `/threads` | 列出当前项目最近的 Codex 对话。`/sessions` 是别名。 |
| `/history [index\|turn_id]` | 查看当前会话最近历史轮次；带编号或 turn id 时查看该轮详情。 |
| `/search <关键词>` | 搜索 Codex 历史对话，并把结果保存为可 `/resume <编号>` 或 `/fork <编号>` 操作的列表。 |
| `/resume <index\|thread_id>` | 通过编号继续已列出的对话，或直接通过 Codex thread id 加载。 |
| `/fork [index\|thread_id]` | 分叉当前、已列出或指定的 Codex 会话，并把当前 chat 切到新 thread。 |
| `/fork --turn <历史编号\|turn_id>` | 从选中的非进行中 turn 分叉当前会话。可以使用 `/history` 中的编号，也可以直接传 turn id；原 thread 保持不变，且不会恢复本地文件。 |
| `/retry` | 为同一 chat 的原任务发送者重试当前 bridge 进程记住的最近任务；bridge 重启后精确 prompt 上下文会清空。 |
| `/usage` | 在 Codex 提供用量通知时，查看最近一轮和当前 thread 的累计 token 用量及 context 占用。 |
| `/archive` | 归档当前选中的 Codex thread 并从 chat 清除选择，不修改本地文件。 |
| `/archived` | 列出当前项目的已归档 thread。 |
| `/unarchive <已归档编号\|thread_id>` | 恢复已归档 thread；之后用 `/threads` 和 `/resume` 继续。 |
| `/service status` | 查看 bridge PID、运行时长、队列、重启能力和日志来源。 |
| `/service logs` | 查看有界的最近服务日志；必须是私聊且发送者明确列在 `ALLOWED_USER_IDS`。 |
| `/service restart` | 优雅重启由 launchd/systemd 托管的 bridge；沿用日志命令的管理员边界，并在有运行中或排队任务时拒绝。 |
| `/compact` | 请求压缩当前 Codex 会话。 |
| `/plan <任务>` | 只把当前任务切换到 Codex Plan 模式；需要 Codex 调用 `request_user_input` 时使用，下一条普通消息会恢复 Default 模式。 |
| `/new` | 在当前项目开始一个新的 Codex 对话。 |
| `/cd <path>` | 修改当前 chat 的 cwd，并开始一个新的 Codex thread。 |
| `/stop` | 停止当前 chat 正在运行的 Codex。运行状态卡片里也有停止按钮。 |
| `/steer <补充指令>` | 立即把补充指令发送给当前 Codex 运行，绕过当前 chat 的普通任务队列。 |
| `/answer <回复码> <内容>` | 回答当前非 secret 的 Codex `requestUserInput` 问题。回复码会显示在提问卡上；回答会立即绕过 chat 队列，且不会被桥接层持久化或回显。 |
| `/mcp-answer <回复码> <JSON 引号包裹的字段 ID> <内容>` | 使用卡片上展示的精确命令回答当前非敏感 MCP 字段。`/skip` 会跳过可选字段；如果实际字符串就是 `/skip`，请把值写成 `"/skip"`。类型化字段值会按原始 schema 校验；回答会立即绕过 chat 队列，且不会被桥接层持久化或回显。 |
| `/summary` | 查看当前 chat 最近一轮运行摘要。 |
| `/files` | 查看最近一轮变更文件。 |
| `/diff` | 查看最近一轮捕获到的 diff。 |
| `/logs` | 查看最近一轮命令摘要和输出预览。 |
| `/whoami` | 显示当前 `chat_id`、chat 类型和访问判断；仅在私聊中显示发送者 id。 |

## 安全默认值

Chat2Codex 默认使用 `CODEX_SANDBOX=workspace-write`，所以 Codex 可以编辑当前选中的工作区。对于只问答、不改代码的机器人，可以改成 `read-only`。

默认 `CODEX_APPROVAL_POLICY=never`，适合无人值守运行。如果你希望 Codex 审批请求以飞书/Lark 卡片形式出现，可以设置为 `CODEX_APPROVAL_POLICY=on-request` 或 `untrusted`。在群聊中，审批按钮只能由 `ALLOWED_USER_IDS` 中列出的用户处理。

`CODEX_RUN_TIMEOUT_MS=0` 和 `CODEX_APPROVAL_TIMEOUT_MS=0` 表示关闭自动超时。对于长期运行的后台机器人，可以设置正整数毫秒值；当 Codex turn 或审批请求卡住时，Chat2Codex 会取消它，并在 `/status` 的近期失败中留下恢复提示。

关键生产资源路径默认都有上限，可以通过 [`.env.example`](.env.example) 中的正整数配置调整：`CODEX_MAX_CONCURRENT_RUNS`、`CODEX_MAX_APP_SERVER_SESSIONS`；全局的 `BRIDGE_MAX_PENDING_MESSAGES` 与单 chat 的 `BRIDGE_MAX_PENDING_MESSAGES_PER_CHAT` 会约束活动 job、尚未投递的 durable 回复、待处理控制消息和轮内审批/输入等待；另有附件数量/单文件/单消息/存储总量配额与 `ATTACHMENT_RETENTION_HOURS`、聊天回复/stderr/运行日志/diff 输出上限、日志单条/文件轮转上限，以及终态 job/已送达 outbox 的留存条数。留存清理永远不会删除活动 job 或尚未送达的 outbox。附件会流式写入私有临时文件，经配额校验后原子落盘，并在不跟随软链接的前提下惰性清理过期内容。

可复用 app-server session 只保存在内存中。空闲 session 默认在 `CODEX_APP_SERVER_IDLE_TTL_MS` 指定的 15 分钟后关闭；达到 `CODEX_MAX_APP_SERVER_SESSIONS` 上限时，只会淘汰最近最少使用的空闲 session。发送者身份、cwd、thread、策略或 `/new` epoch 变化，以及执行 `/fork`、`/compact` 时，旧 owner 会先关闭，避免同一 thread 被多个进程同时持有。缺少稳定发送者 ID 的消息会退回单 turn 进程，不能继承 session 级授权。收到 `SIGINT`/`SIGTERM` 时，服务会依次关闭飞书连接和所有 Codex 子进程；尚未开始的 durable queued job 保留给重启恢复，running job 标记为 interrupted，绝不会自动重放。

`chat2codex doctor` 和 `/host` 都会提示移动/群机器人常见风险，包括相对路径 `CODEX_BIN`、群聊开启但没有 `ALLOWED_USER_IDS`、关闭运行/审批超时，以及高风险 sandbox 配置。

如果某个 chat 当前选择的 cwd 后来被删除，Chat2Codex 会把启动时的 `ENOENT` 判断为工作目录缺失，而不是误报 Codex binary 缺失。只要默认 `CODEX_WORKDIR` 仍存在且允许访问，它会清空当前 thread、切回默认 cwd，并提示用户重新发送任务；如果默认 cwd 也不可用，请先发送 `/cd <现有目录>`。

私聊路由默认开启，但除 `/whoami` 外，必须由 `ALLOWED_USER_IDS` 中的发送者发出，或来自 `ALLOWED_CHAT_IDS` 中的私聊 chat。群聊消息必须提到机器人，并且只有同时配置 `ALLOW_GROUPS=true`、允许的 chat 和 `ALLOWED_USER_IDS` 中的发送者才会执行。`ALLOWED_USER_IDS` 接受逗号分隔的 `open_id`、`user_id` 或 `union_id`。授权后的私聊可以切换到任意本机目录；群聊只能切换到 `CODEX_GROUP_ALLOWED_ROOTS` 的真实路径，软链接不能绕过限制。

飞书事件会先写入本地 pending inbox，再向长连接返回；Codex prompt 还会在执行前创建 durable job。尚未开始的 queued job 可在重启后继续；已进入 `running` 的 job 会被标记为 interrupted，由于无法安全判断已产生的副作用，不会自动重新执行。最终回复从 durable outbox 发送，并使用稳定的幂等键，因此聊天发送失败不会重跑 Codex。重启后，`/status` 等只读控制消息可以安全重放；`/new`、`/stop`、`/steer` 等会变更状态或绑定具体运行的命令不会被重放到另一个任务。先前归类为非 Codex 的消息，也不会仅因为重启期间访问或路由配置变化而升级成 Codex 任务。同一个工作区的 Codex 任务会跨 chat 串行执行，不同工作区可以在 `CODEX_MAX_CONCURRENT_RUNS` 范围内并行；达到全局或单 chat 队列上限时，会在启动 Codex 前拒绝接收新任务。等待工作区锁或全局运行许可的任务也会显示在 `/status` 中，并可用 `/stop` 取消。同一份 `BRIDGE_STATE_PATH` 只允许一个桥接进程使用。对敏感任务仍应保留审批和 Git 检查；手动重试 interrupted job 前，先检查 thread 和工作区状态。

正常退出会自动删除实例锁。若进程被 `SIGKILL` 或运行时发生致命崩溃，可能遗留 `<BRIDGE_STATE_PATH>.lock`；确认没有 Chat2Codex 进程运行后，再手动删除这个锁目录并重启。为避免与另一次启动竞争，程序不会自动回收陈旧实例锁。

不要在有不可信成员的群里，以宽泛文件系统权限运行这个机器人。一个能驱动本地 coding agent 的聊天机器人，本质上就是你机器的远程控制入口。

## 运行形态

通过 npm 安装的包会运行已经构建好的 Node.js ESM 入口。如果是从源码仓库本地开发，可以使用 Bun：

```bash
bun install
bun run dev
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

1. 在新增 Slack、Discord 或其他平台前，抽象聊天适配器边界。
