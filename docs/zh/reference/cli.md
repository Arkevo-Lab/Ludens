# CLI 命令参考（`ludens` / `ludens-server` / `ludens-core` / `baseware` / `ludens-app`）

本文档汇总 Ludens 六包架构下 **4 个正交 CLI 可执行入口 + 桌面端入口**暴露的全部用户级与沙盒内子命令、参数开关、默认值与环境变量：

- **`ludens`**（`@ludens/client`，[`client/bin/ludens`](../../../client/bin/ludens)）：**面向人的纯 RPC 操作者客户端 CLI**（严格仅依赖 `@ludens/protocol`，零 `@ludens/core` / `@ludens/server` 代码依赖）——负责全局配置（`ludens config`）、工作区全生命周期与远程评测（`ludens workspace <init|list|open|forget|import|up|down|services|eval>`）以及顶层高频遥控与日志检索（`ludens <status|auto|steer|consolidate|stop|model|logs>`）。全线支持本地 Unix Domain Socket（未启动时自动从 `PATH` 按需唤醒 `ludens-server start`）与 `--remote ws(s)://... [--token ...]`。
- **`ludens-server`**（`@ludens/server`，[`server/bin/ludens-server`](../../../server/bin/ludens-server)）：**控制面服务端与守护进程管理 CLI** —— 统一提供 `ludens-server <serve|start|stop|restart|status>`，承载多工作区 JSON-RPC 2.0（`/rpc` 与 `app-server.sock`）、`EventHub` 实时推送、HMAC `/media`、查询引擎与 `WorkspaceSupervisor`。
- **`ludens-core`**（`@ludens/core`，[`core/bin/ludens-core`](../../../core/bin/ludens-core)）：**单工作区执行内核与沙盒内工具 CLI** —— 提供单工作区内核启动入口 `ludens-core run` 以及沙盒内 Shiori / 开发者直连工具 `ludens-core <controller|perception|event|machine|eval>`（已移除旧顶层重复的 `observe` 别名，统一收敛为 `ludens-core perception observe`）。
- **`baseware`**（`@ludens/baseware`，[`baseware/bin/baseware`](../../../baseware/bin/baseware)）：**独立运行的跨设备集成层 CLI** —— 守护进程服务、驱动包发现与管理、多机路由、原生控制器直调以及 MCP 暴露入口。
- **`ludens-app`**（`@ludens/desktop`，[`desktop/bin/ludens-app`](../../../desktop/bin/ludens-app)，Windows [`desktop/bin/ludens-app.cmd`](../../../desktop/bin/ludens-app.cmd)）：**All-in-One 零端口 Electron 桌面壳**（`ludens-app://console/` + `ludens-media://local/media?...`），自包含组装各包自治产物 `client/dist`（打包态 `Resources/client`）+ `server/dist` + `core/dist` + `baseware/dist`，并支持一键切连远程 `ludens-server`。

> **全局前缀、远程连接与按需唤醒策略**：`ludens` 的所有子命令均支持 `--workspace <path>`（覆盖 `LUDENS_WORKSPACE` 与当前工作目录），以及 `--remote <ws(s)://...>` 与 `--token <secret>`（覆盖 `LUDENS_REMOTE_URL` 与 `LUDENS_REMOTE_TOKEN`）。
> - 传入 `--remote` 时：`ludens` 直接经 WebSocket JSON-RPC 连接远端 `ludens-server`；
> - 未传 `--remote` 时：`ludens` 连接本机 `$LUDENS_HOME/run/app-server.sock`（若路径接近 96 字节上限则自动回退至 `/tmp/ludens-app-<uid>-<sha256_12>.sock`）；若本地 socket 未就绪，会自动从 `PATH`（或同仓库 `../server/bin/ludens-server`）执行 `ludens-server start` 按需唤醒本地服务并重连；若本机未安装 `ludens-server`，则输出明确提示引导安装/启动 `ludens-server` 或传入 `--remote <url>`。

---

## 1. `ludens` —— 纯 RPC 操作者客户端 CLI（`@ludens/client`）

实现位于 [`client/cli/`](../../../client/cli/) 与 [`protocol/src/app-rpc.ts`](../../../protocol/src/app-rpc.ts)。全局状态保存在服务端 `$LUDENS_HOME`（默认 `~/.ludens`）。

### `ludens config`

通过 RPC 查看或更新供新建与启动工作区继承的全局默认配置（支持 `--remote` 与 `--token`）。

```bash
ludens config [show] [--remote <url>] [--token <secret>]
ludens config set workspaceRoot <directory> [--remote <url>] [--token <secret>]
ludens config set defaults.<field> <value> [--remote <url>] [--token <secret>]
```

支持的 `defaults.<field>` 配置项：

| 配置键 | 取值说明 |
| --- | --- |
| `defaults.model` | 默认 `<provider/model>` 模型标识 |
| `defaults.serviceTier` | `priority`、`ultrafast` 或 `none`（清除配置） |
| `defaults.effort` | `minimal`、`low`、`medium`、`high`、`xhigh`、`max` 或 `none`（清除配置） |
| `defaults.seconds` | 单次自主运行周期默认时长（秒，正整数） |
| `defaults.requests` | 单周期默认请求配额（正整数） |
| `defaults.compactionThreshold` | Shiori 压缩阈值（Token 数，正整数） |
| `defaults.pet` | `true` \| `false` —— 新建工作区默认是否开启可选桌宠 |
| `defaults.connection.openaiWebsockets` | OpenAI WebSocket 传输开关（`auto` \| `on` \| `off`） |
| `defaults.connection.cacheRetention` | Prompt 缓存保留策略（`auto` \| `short` \| `long` \| `none`） |
| `defaults.connection.appendOnlyContext` | 仅追加上下文策略（`auto` \| `on` \| `off`） |
| `defaults.connection.imageUrls.enabled` | 是否启用多模态图像 URL 传递 |
| `defaults.connection.imageUrls.backends` | 允许图像 URL 传递的后端列表 |

### `ludens workspace <init|list|open|forget|import>`

管理工作区创建、全局注册表登记与旧状态迁移（全线走 JSON-RPC，统一支持 `--workspace`、`--remote`、`--token`）：

```bash
# 初始化工作区并生成 ludens.json（走 workspaces/mutate action: "create" RPC）
ludens workspace init --driver <id> \
  [--name <name>] \
  [--workspace <path>] \
  [--machine <id>] \
  [--driver-package <spec>] \
  [--game <path>] \
  [--port <n>] \
  [--cua-command <path>] \
  [--model <id>] \
  [--effort <level>] \
  [--service-tier <tier>] \
  [--seconds <n>] \
  [--requests <n>] \
  [--register-driver] \
  [--pet | --no-pet] \
  [--remote <url>] [--token <secret>]

# 列出、打开登记、移除登记与导入迁移工作区（import 走新增的 workspaces/import RPC）
ludens workspace list [--remote <url>] [--token <secret>]
ludens workspace open <directory> [--new-id] [--remote <url>] [--token <secret>]
ludens workspace forget <id> [--remote <url>] [--token <secret>]
ludens workspace import <directory> [--legacy-state <directory>] [--previous-workspace <directory>] \
  [--remote <url>] [--token <secret>]
```

当 `ludens.json` 缺省相关字段时，启动器使用的默认值：`model` = `openai-codex/gpt-6.2-sol`、`seconds` = `1800`、`requests` = `1000`、`dashboard` = `true`、`pet` = `false`、`logging.diagnostics` = `"normal"`。

### `ludens workspace <up|services|down>`

按 **1 Workspace = 1 Core** 隔离统一拉起、检查与关闭受管工作区进程（Baseware、承载 **Shiori** 的工作区 **Core** `ludens-core run` 及可选目标应用/模拟器启动命令），支持本地 `app-server.sock` 与 `--remote`：

```bash
ludens workspace up [--workspace <path>] [--preempt] \
  [--services <emulator,baseware,core>] [--remote <url>] [--token <secret>]
ludens workspace services [--workspace <path>] [--remote <url>] [--token <secret>]
ludens workspace down [--workspace <path>] [--services <emulator,baseware,core>] \
  [--keep-emulator] [--remote <url>] [--token <secret>]
```

- `--preempt` 自动抢占同一物理设备上冲突的工作区 Core。
- `--services` 将 `up` / `down` 作用域限定到指定组件（`emulator`、`baseware`、`core`）。
- `--keep-emulator` 在停止 Ludens 各守护进程的同时保留外部目标应用/模拟器进程。

### `ludens workspace eval`

通过 `capabilities/get`、`capabilities/eval`、`capabilities/evalHistory` 与 `capabilities/evalAdapt` RPC 远程或本地列出、运行、查询评测历史并标记能力失败反例（详见 [能力自验证](../concepts/self-verification.md)）：

```bash
ludens workspace eval list [--workspace <path>] [--remote <url>] [--token <secret>]
ludens workspace eval run [<capability-id>] [--all] [--workspace <path>] [--remote <url>] [--token <secret>]
ludens workspace eval <python/capability-id> [--workspace <path>] [--remote <url>] [--token <secret>]
ludens workspace eval history [<capability-id>] [--limit <n>] [--workspace <path>] [--remote <url>] [--token <secret>]
ludens workspace eval adapt <capability-id> --reason <text> [--record <record-id> ...] \
  [--workspace <path>] [--remote <url>] [--token <secret>]
```

### 顶层高频遥控与日志检索：`ludens <status|auto|steer|consolidate|stop|model|logs>`

操作者最常用的实时控制与日志命令保留为 `ludens` 顶层一级指令，100% 经 JSON-RPC 路由至 `ludens-server`：

```bash
ludens status [--workspace <path>] [--remote <url>] [--token <secret>]
ludens auto on [--message <text>] [--seconds <n>] [--preempt] [--workspace <path>] [--remote <url>] [--token <secret>]
ludens auto timer <seconds|off> [--workspace <path>] [--remote <url>] [--token <secret>]
ludens auto off [--workspace <path>] [--remote <url>] [--token <secret>]
ludens steer [--message <text> | <text>] [--workspace <path>] [--remote <url>] [--token <secret>]
ludens consolidate [--seconds <n>] [--workspace <path>] [--remote <url>] [--token <secret>]
ludens stop [--workspace <path>] [--remote <url>] [--token <secret>]
ludens model [<provider/id>] [--service-tier none|priority|ultrafast] \
  [--effort none|minimal|low|medium|high|xhigh|max] [--workspace <path>] [--remote <url>] [--token <secret>]

# 纯 RPC 日志归档检索（经 logs/events 与 logs/read RPC 查询历史运行事件与完整卸载载荷，无需直读本地磁盘）
ludens logs events --run <run-directory-or-id> [--diagnostics] [--cursor <n>] [--limit <n>] [--workspace <path>] [--remote <url>] [--token <secret>]
ludens logs read --run <run-directory-or-id> \
  (--ref '<JSON reference>' | --file <reference.json> | --event <seq> --field <name>) \
  [--full] [--workspace <path>] [--remote <url>] [--token <secret>]
```

- `ludens auto on` 开启**自主运行（Auto Run）**控制周期（`--seconds` 设置定时周期时长；`--preempt` 抢占同一物理设备上的冲突 Core）。
- `ludens auto timer` 动态调整当前周期剩余计时（`off` 表示取消时间上限）。
- `ludens auto off` 执行**收回控制权（Reclaim Control）**，将 Shiori 切回**手动待命（Manual Standby / `manual`）**并在 Baseware 侧撤销设备控制租约。
- `ludens steer` 向 Shiori 发送高优引导指令（打断 `loop.py` 等待或排队注入活跃轮次）。
- `ludens consolidate` 触发记忆整理任务（`--seconds` 默认 `600` 秒）。
- `ludens stop` 经 `run/stop` RPC 立即停止当前工作区正在进行的活跃控制运行并收回设备控制权（如需关闭工作区 Core / Baseware 后台进程，请使用 `ludens workspace down`）。
- `ludens model` 在手动待命期间切换模型、Service Tier 或推理深度（Effort）。
- `ludens logs` 经由 `logs/events` 与 `logs/read` RPC 读取归档事件时间线及卸载到磁盘的大字段载荷（详见 [日志与调用链](logging.md)）。

---

## 2. `ludens-server` —— 控制面服务端 CLI（`@ludens/server`）

实现位于 [`server/src/`](../../../server/src/)。统一管理按 `LUDENS_HOME` 隔离的多工作区控制面服务端。

### `ludens-server serve`

在前台启动控制面服务端，提供 UDS NDJSON 与 WebSocket `/rpc` JSON-RPC 2.0（`@ludens/protocol/app-rpc`）、`EventHub` 实时事件推送、HMAC capability ticket `/media`（`mt=`、`206 Range`）、`/health` 以及可选静态 Vite SPA（`client/dist`，`/api/*` 返回 `404`）。

```bash
ludens-server serve [--listen <unix://PATH | ws://HOST:PORT>]... \
  [--auth <none|token>] [--token <secret> | --token-env <var>] \
  [--static-dir <path>] [--trusted-origin <origin>] [--parent-watchdog] [--dev] [-h | --help]
```

- 不传 `--listen` 时默认仅监听 UDS（`<home>/run/app-server.sock`，路径接近 96 字节上限时回退至 `/tmp/ludens-app-<uid>-<sha256_12>.sock`，**0 个监听 TCP 端口**）且 `--auth none`（运行于 `desktop` Profile）。
- 非 `--dev` 的 `ws://HOST:PORT` 绑定运行于 `remote` Profile（启用 `managed-sandbox` 受管沙箱边界），强制要求 `--auth token`（配合 `--token` 或 `--token-env`），否则拒绝启动。
- `--dev` 仅允许绑定本机回环地址（`127.0.0.1`、`localhost`、`::1`），运行于 `web-dev` Profile。
- `--trusted-origin <origin>` 支持重复传入，允许独立部署的异源 `@ludens/client` 前端跨域连接；`--parent-watchdog` 将服务生命周期绑定到父进程标准输入，启动完成后向 stdout 输出单行 JSON 就绪握手信息。

### `ludens-server <start|stop|restart|status>`

以守护进程方式查看、启动、停止或重启当前 `LUDENS_HOME` 下的单例 `ludens-server`：

```bash
ludens-server status
ludens-server start [--listen <unix://PATH|ws://HOST:PORT>]... [--auth <none|token>] \
  [--token <secret> | --token-env <var>] [--static-dir <path>] [--trusted-origin <origin>] [--dev]
ludens-server stop [--keep-cores | --stop-cores]
ludens-server restart [--listen <unix://PATH|ws://HOST:PORT>]... [--auth <none|token>] \
  [--token <secret> | --token-env <var>] [--static-dir <path>] [--trusted-origin <origin>] [--dev]
```

- `ludens-server stop` 默认先停止受管工作区 Core 再关闭服务端（对应 `--stop-cores`）；传入 `--keep-cores` 可仅停止 `ludens-server` 并保留活跃 Core。

---

## 3. `ludens-core` —— 单工作区执行内核与沙盒内工具 CLI（`@ludens/core`）

实现位于 [`core/src/`](../../../core/src/)。`@ludens/core` 会将 `core/bin` 自动注入 Shiori `bash` 工具的 `PATH`，使沙盒内 Agent 与本地开发者可直接调用 `ludens-core` 子命令（通过工作区 `core.sock` 或离线执行）。

### `ludens-core run`

启动单工作区 **Core** 执行沙盒（内部承载 **Shiori** Agent 线程核心与常驻 `perception.py` / `loop.py`，由 `ludens-server` 的 `WorkspaceSupervisor` 拉起，或在前台独立调试启动）：

```bash
ludens-core [--workspace <path>] run \
  [--baseware-socket <path>] \
  [--workspace <path>] \
  [--device-only] \
  [--model <provider/model>] \
  [--resume <session.jsonl> | --new-session] \
  [--seconds <n>] \
  [--requests <n>] \
  [--compaction-threshold <tokens>] \
  [--diagnostics normal|full] \
  [--launched-by app|cli]
```

直调默认值：`--seconds 300`、`--requests 50`、`--diagnostics normal`，`--launched-by`（回退读取 `LUDENS_LAUNCHED_BY` 环境变量）默认为 `cli`（`app` 由 `ludens-server` 按需拉起时传入）；`--model` 优先读取 `ludens.json`，缺省时为 `openai-codex/gpt-6.2-sol`。

### `ludens-core controller` 与 `ludens-core machine`

列出并直接调用原生驱动控制器（`controller/<name>`）或 Python 封装的工作区控制器（`python/<path.py>:<function>`），以及管理 Baseware 机器节点：

```bash
ludens-core controller list
ludens-core controller <id> --help
ludens-core controller controller/<native name> [--machine <machineId>] [--args '<JSON object>' | --file <arguments.json>]
ludens-core controller python/<path.py>:<function> [--args '<JSON object>' | --file <arguments.json>]

ludens-core machine list
ludens-core machine use <id>
ludens-core machine connect <id> [<id2> ...]
ludens-core machine disconnect <id>
```

### `ludens-core perception`（含 `perception observe`）

管理多模态感知管道并查询磁盘或内存环中记录的观测窗口（注：已移除旧顶层重复的 `observe` 别名，统一使用 `ludens-core perception observe`）：

```bash
ludens-core perception status
ludens-core perception state
ludens-core perception reload
ludens-core perception stop
ludens-core perception transition <target> [--args '<JSON object>' | --file <arguments.json>]
ludens-core perception inject [on|off]
ludens-core perception observe [--capability <id|*>] \
  [--id <record-id> | --at <ISO> | --start <ISO> --end <ISO>] \
  [--limit <n>] [--after <sequence>] [--images]
```

`perception observe` 默认 `--limit 8`（最大 `64`）；传入 `--images` 可在结果中附带帧图像数据。

### `ludens-core event`（Event Pool 事件池）

在沙盒或本机工作区目录下查看并操作异步工作区事件池（Core 在线时经 `core.sock` 路由，离线时加锁直写 `.ludens/event-pool.json`；在智能体周期内存在 `BASEWARE_EPOCH` 时拒绝人工变更子命令并引导 Shiori 使用 `event_pool` 工具）：

```bash
ludens-core event list [--direction <inbound|outbound>] [--status <pending|handled>] [--limit <n>]
ludens-core event send [--title <text>] [--message <text> | <text>]
ludens-core event reply <event-id> [--message <text> | <text>]
ludens-core event ack <event-id> [<event-id2> ...]
```

### `ludens-core eval`

在沙盒内或工作区本地离线运行、查看历史并修订能力自验证数据集与脚本（执行时自动剥离 `LUDENS_SOCKET`、`BASEWARE_SOCKET`、`LUDENS_EPOCH` 与 `BASEWARE_EPOCH`）：

```bash
ludens-core eval list
ludens-core eval run [<capability-id>] [--all]
ludens-core eval <python/capability-id>          # 当能力 ID 以 python/ 开头时可省略 run
ludens-core eval history [<capability-id>] [--limit <n>]
ludens-core eval adapt <capability-id> --reason <text> [--record <record-id> ...]
```

---

## 4. `baseware` CLI（`@ludens/baseware`）和 `ludens-app` 桌面端（`@ludens/desktop`）

### `baseware` CLI

实现位于 [`baseware/src/cli.ts`](../../../baseware/src/cli.ts) 与 [`baseware/src/main.ts`](../../../baseware/src/main.ts)。独立模式默认守护进程 Socket 为 `/tmp/ludens-baseware-${uid}-${id}.sock`。

```bash
# 以指定驱动、传输协议与 Socket 地址直接启动 Baseware 服务
baseware serve --driver <id> \
  [--driver-package <npm|github:org/repo#rev|https://github.com/org/repo#rev|file:path>] \
  [--port <n>] [--host <host>] \
  [--transport stdio|bridge|ssh|http|sse] \
  [--ssh-host <host>] [--ssh-user <user>] [--ssh-port <n>] [--ssh-identity <path>] [--ssh-command <cmd>] \
  [--url <url>] [--cua-command <path>] \
  [--socket <path>] [--data-dir <path>] [--machine-id <id>] \
  [--diagnostics normal|full]

# Baseware 客户端、驱动、节点与 MCP 命令
baseware status
baseware list
baseware export [--output <path>]          # 默认输出路径：baseware.json

baseware driver list
baseware driver discover --package <spec>

baseware controller list
baseware controller <id> --help
baseware controller <name> [--machine <id>] [--args '<JSON object>' | --file <arguments.json>]
baseware help <id>

baseware reconnect [--machine <id>]
baseware machine list
baseware machine use <id>
baseware machine connect <id> [<id2> ...]
baseware machine disconnect <id>

baseware revoke                            # 撤销当前自主运行租约（Epoch）
baseware mcp                               # 通过标准输入输出以 MCP 协议暴露控制器
```

### `ludens-app` 桌面端 CLI

实现位于 [`desktop/src/main.ts`](../../../desktop/src/main.ts)。启动零监听 TCP 端口的 Electron 桌面壳，通过 `AppServerHost`（`ensureLocalAppDaemon`）走 UDS `app-server.sock`、使用 `ludens-app://console/` 加载 `@ludens/client` 打包产物（`client/dist`，打包态 `Resources/client`）、使用 `ludens-media://local/media?...` 加载本地媒体，并通过 `ActiveCoreQuitGuard` 与可选桌宠（`PetSessionCoordinator`）运行。

```bash
ludens-app [--workspace <path>] [--server <url> | --dashboard <url>] \
  [--profile <path>] [--background] [--show-window] [--help]
```

| 参数 | 用途 |
| --- | --- |
| `--workspace <path>` | 打开并聚焦指定工作区目录 |
| `--server <url>` / `--dashboard <url>` | 覆盖 `ludens-app://console/`，连接外部 Vite 开发或远端渲染地址（亦可设 `LUDENS_APP_DEV_URL` / `LUDENS_DEV_URL`） |
| `--profile <path>` | 覆盖 Electron 用户数据目录路径 |
| `--background` | 以后台/托盘常驻模式启动，不自动弹出主窗口 |
| `--show-window` | 启动时立即显示并聚焦控制台窗口 |
| `--help` | 打印桌面启动器用法说明 |

---

## 环境变量参考

以下环境变量已在 [`protocol/`](../../../protocol/src/)、[`baseware/`](../../../baseware/src/)、[`core/`](../../../core/src/)、[`server/`](../../../server/src/)、[`client/`](../../../client/) 与 [`desktop/`](../../../desktop/src/) 源码中核验：

| 变量名 | 默认值 | 用途 |
| --- | --- | --- |
| `LUDENS_HOME` | `~/.ludens` | 全局配置、驱动缓存与全局状态根目录（根目录 `bun run dev` / `dev:web` / `dev:desktop` / `dev:server` 默认隔离为 `~/.ludens-dev`，传入 `--real-home` 或使用 `:real` 别名挂载真实 `~/.ludens`） |
| `LUDENS_WORKSPACE` | 当前工作目录 | 未传入 `--workspace` 时的默认工作区路径 |
| `LUDENS_SOCKET` | `/tmp/ludens-core-${uid}-${workspaceHash}.sock` | 覆盖 Core 守护进程 Unix Socket 路径 |
| `BASEWARE_SOCKET` | `/tmp/ludens-baseware-${uid}-${id}.sock` | 覆盖 Baseware Unix Socket 路径 |
| `BASEWARE_EPOCH` | — | `ludens-core run` 与 Baseware 客户端透传的控制租约 Epoch |
| `BASEWARE_TRACE` | — | 透传给 Baseware 调用的链路追踪标识 |
| `LUDENS_MACHINE_ID` | — | Baseware 路由默认选中的机器节点 ID |
| `LUDENS_PYTHON` | — | 工作区能力脚本与自验证使用的 Python 解释器路径 |
| `LUDENS_RUN_ID` | — | 覆盖当前运行的日志归档 Run ID |
| `LUDENS_LOG_DIAGNOSTICS` | `"normal"` | 日志诊断级别（`normal` 或 `full`） |
| `LUDENS_BASEWARE_STREAM_PREFETCH` | — | Baseware 感知流预取开关/参数 |
| `LUDENS_BRIDGE_PORT` | — | Driver Bridge 协议端口覆盖 |
| `LUDENS_PERCEPTION_SAMPLE_HZ` | `30` | 默认感知采样率（Hz） |
| `LUDENS_PERCEPTION_PERSIST` | `1` | 是否开启感知环形缓冲区磁盘持久化 |
| `LUDENS_PERCEPTION_HOT_SECONDS` | `600` | 内存热感知窗口时长（`10..3600` 秒） |
| `LUDENS_PERCEPTION_HOT_BYTES` | `1 GiB` | 内存热感知缓冲区容量上限 |
| `LUDENS_PERCEPTION_SEGMENT_SECONDS` | `3600` | 磁盘感知分段切分时长 |
| `LUDENS_PERCEPTION_SEGMENT_BYTES` | `256 MiB` | 磁盘感知单段体积上限 |
| `LUDENS_VIDEO_SEGMENT_SECONDS` | `300` | 视频感知分段时长（`10..3600` 秒） |
| `LUDENS_VIDEO_IDLE_SECONDS` | `10` | 视频流空闲刷盘超时（`1..600` 秒） |
| `LUDENS_VIDEO_QUEUE_BYTES` | `32 MiB` | 视频入队字节上限（触发背压） |
| `LUDENS_VIDEO_QUEUE_FRAMES` | `64` | 视频队列帧数上限 |
| `LUDENS_VIDEO_STREAMS` | `16` | 最大并发视频感知流数量 |
| `LUDENS_VIDEO_QUERY_BYTES` | `32 MiB` | 单次视频窗口查询的最大字节预算 |
| `LUDENS_APP_INDEX_CACHE_BYTES` | `256 MiB` | 控制台索引内存 LRU 容量预算 |
| `LUDENS_APP_BUILD_BYTES` | `2 GiB` | 构建 `.dashboard-index/` 时单次扫描字节上限 |
| `LUDENS_APP_INDEX_MAX_RUNS` | `3` | 同时常驻内存的 Run 索引数量上限 |
| `LUDENS_APP_INDEX_IDLE_MS` | `300000` | 控制台 Run 索引空闲驱逐超时（毫秒） |
| `LUDENS_APP_INDEX_ROOT` | 工作区 `.dashboard-index` | 覆盖控制台可重建索引存放根目录 |
| `LUDENS_REMOTE_URL` | — | `ludens` 纯 RPC CLI 默认接入的 `--remote ws(s)://...` 地址 |
| `LUDENS_REMOTE_TOKEN` | — | 与 `LUDENS_REMOTE_URL` / `--remote` 配套的默认鉴权 Token |
| `LUDENS_APP_TOKEN` | — | 启停鉴权版 `ludens-server`（`--token-env LUDENS_APP_TOKEN`）时传递/读取的 Token 环境变量 |
| `LUDENS_STATIC_DIR` | — | `ludens-server` 托管的 Vite 静态 SPA 控制台构建产物目录（`client/dist`） |
| `LUDENS_APP_SERVER_URL` | — | 根目录 `scripts/dev.mjs` / `client/vite.config.ts` 代理转发的上游 `ludens-server` 地址（`/rpc`、`/media`、`/health`） |
| `LUDENS_APP_DEV_URL` | — | `ludens-app` 加载外部开发渲染地址（别名 `LUDENS_DEV_URL`） |
| `LUDENS_BUN` | — | 覆盖 Bun 可执行文件路径 |
| `LUDENS_SERVER_BIN` / `LUDENS_APP_SERVER_BIN` | — | `ludens` CLI 或 `ludens-app` 桌面端按需拉起 `ludens-server` 时的二进制路径覆盖 |
| `LUDENS_DISABLE_COMPANION` | — | 禁止 Electron 桌面端自动拉起可选桌宠窗口 |

## 相关文档

- [工作区教程](../tutorials/workspace.md) 与 [设备接入教程](../tutorials/devices.md)：结合 `ludens workspace init`、`ludens workspace up`、`ludens-core` 与 `baseware` 的完整端到端实战。
- [控制台与调试教程](../tutorials/console-and-debugging.md)：在控制台（Console）中查看实时运行、回放与能力状态。
- [系统架构规范](architecture.md)：四层六包职责、守护进程 Socket、启动时序与存储边界。
- [Baseware 设备层规范](baseware.md)：驱动加载、控制租约 Epoch 与控制器契约。
- [日志与调用链规范](logging.md)：运行归档目录结构与 `ludens logs` 检索字段。
