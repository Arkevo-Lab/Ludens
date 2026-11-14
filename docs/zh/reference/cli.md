# CLI 命令参考（`ludens` / `baseware` / `ludens-app`）

本文档汇总 Ludens 仓库三个可执行入口暴露的全部用户级子命令、参数开关、默认值与环境变量：

- `ludens`（[`core/bin/ludens`](../../../core/bin/ludens)）：工作区与全局配置管理、Shiori Agent 线程核心守护进程、运行时控制、感知与自验证（Eval）工具、日志归档读取以及控制台后端服务（`app-server`）。
- `baseware`（[`baseware/bin/baseware`](../../../baseware/bin/baseware)）：独立运行的 **Baseware** 跨设备集成层守护进程、驱动包发现与管理、多机路由、原生控制器直调以及 MCP 暴露入口。
- `ludens-app`（[`app/bin/ludens-app`](../../../app/bin/ludens-app)，Windows [`app/bin/ludens-app.cmd`](../../../app/bin/ludens-app.cmd)）：承载控制台（Console）与可选桌宠（Desktop Pet）的 Electron 桌面端入口。

> **全局工作区前缀**：任意 `ludens` 子命令均可在子命令名之前附加 `--workspace <path>`（例如 `ludens --workspace /path/to/ws status`），用于覆盖 `LUDENS_WORKSPACE` 与当前工作目录。

---

## 全局配置与工作区注册表

实现位于 [`core/src/cli/global.ts`](../../../core/src/cli/global.ts) 与 [`protocol/src/ludens.ts`](../../../protocol/src/ludens.ts)。全局状态保存在 `$LUDENS_HOME`（默认 `~/.ludens`）。

### `ludens config`

查看或更新供新建与启动工作区继承的全局默认配置。

```bash
ludens config [show]
ludens config set workspaceRoot <directory>
ludens config set defaults.<field> <value>
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
| `defaults.dashboard` | `true` \| `false` —— `ludens up` 时是否拉起控制台服务 |
| `defaults.pet` | `true` \| `false` —— `ludens up` 时是否拉起可选桌宠 |
| `defaults.connection.openaiWebsockets` | OpenAI WebSocket 传输开关 |
| `defaults.connection.cacheRetention` | Prompt 缓存保留策略 |
| `defaults.connection.appendOnlyContext` | 仅追加上下文策略 |
| `defaults.connection.imageUrls.enabled` | 是否启用多模态图像 URL 传递 |
| `defaults.connection.imageUrls.backends` | 允许图像 URL 传递的后端列表 |

### `ludens workspace`

管理全局注册表中的工作区条目。

```bash
ludens workspace list
ludens workspace open <directory> [--new-id]
ludens workspace forget <id>
ludens workspace import <directory> [--legacy-state <directory>] [--previous-workspace <directory>]
```

---

## 工作区生命周期与控制台服务

实现位于 [`core/src/cli/workspace.ts`](../../../core/src/cli/workspace.ts)、[`core/src/cli/main.ts`](../../../core/src/cli/main.ts)、[`core/src/cli/app-server-cli.ts`](../../../core/src/cli/app-server-cli.ts) 与 [`core/src/daemon/launcher.ts`](../../../core/src/daemon/launcher.ts)。

### `ludens init`

初始化工作区目录并生成 `ludens.json`。

```bash
ludens init --driver <id> \
  [--name <name>] \
  [--workspace <path>] \
  [--driver-package <spec>] \
  [--game <path>] \
  [--cua-command <path>] \
  [--model <id>] \
  [--seconds <n>] \
  [--requests <n>] \
  [--pet | --no-pet]
```

当 `ludens.json` 缺省相关字段时，启动器使用的默认值：`model` = `openai-codex/gpt-6.1-sol`、`seconds` = `1800`、`requests` = `1000`、`dashboard` = `true`、`pet` = `false`、`logging.diagnostics` = `"normal"`。

### `ludens up` / `ludens services` / `ludens down`

按 **1 Workspace = 1 Core** 隔离统一拉起、检查与关闭受管工作区进程（Baseware、承载 **Shiori** 的工作区 **Core**，标记为 `launchedBy: "cli"` 以免受桌面端退出影响、可选目标应用/模拟器启动命令、**App Daemon** 与可选桌宠）。

```bash
ludens up [--dry-run] [--dashboard | --no-dashboard] [--pet | --no-pet]
ludens services
ludens down [--keep-emulator] [--dashboard] [--pet]
```

- `--dashboard` / `--no-dashboard` 控制是否同时启动多工作区控制台 **App Daemon**（`ludens app-server`）与控制台页面。
- `--pet` / `--no-pet` 控制在 `up` / `down` 时是否联动可选桌宠窗口。
- `--keep-emulator` 在停止 Ludens 各守护进程的同时保留外部目标应用/模拟器进程。

### `ludens app-server` / `ludens serve`

启动统一的多工作区 **App Daemon**（提供控制台 HTTP + WebSocket 接口、多 Core 编排、物理设备冲突仲裁以及文档与回放 API）。

```bash
ludens app-server [--host 127.0.0.1] [--port <0|1..65535>] [-p <port>] \
  [--static-dir <path>] [--trusted-origin <origin>] [--parent-watchdog] [-h | --help]
ludens serve ...   # app-server 的别名
```

默认值：`--host 127.0.0.1`、`--port 3015`（传入 `0` 可自动分配空闲端口）。`--trusted-origin <origin>` 支持重复传入；`--parent-watchdog` 将服务生命周期绑定到父进程标准输入。

### `ludens run`

直接在前台启动工作区 **Core**（内部承载 **Shiori** Agent 线程核心，不经过 `ludens up` 托管编排）。

```bash
ludens [--workspace <path>] run \
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

[`core/src/cli/main.ts`](../../../core/src/cli/main.ts) 中的直调默认值：`--seconds 300`、`--requests 50`、`--diagnostics normal`，`--launched-by`（回退读取 `LUDENS_LAUNCHED_BY` 环境变量）默认为 `cli`（`app` 由 **App Daemon** 传入，用于限定桌面端 Quit 仅回收 App 拉起的 Core）；`--model` 优先读取 `ludens.json`，缺省时为 `openai-codex/gpt-6.1-sol`。

---

## 实时控制、事件池、感知、控制器与多机路由

以下命令通过工作区 Unix Domain Socket 与运行中的核心守护进程通信（详见 [`core/src/cli/control-cli.ts`](../../../core/src/cli/control-cli.ts)、[`core/src/cli/event-cli.ts`](../../../core/src/cli/event-cli.ts) 与 [`core/src/daemon/transport.ts`](../../../core/src/daemon/transport.ts)）。

### 状态、自主运行与干预（Steer）

```bash
ludens status
ludens auto on [--message <text>] [--seconds <n>]
ludens auto timer <seconds|off|unbounded|none>
ludens auto off
ludens steer [--message <text> | <text>]
ludens consolidate [--seconds <n>]
ludens model [<provider/id>] [--service-tier none|priority|ultrafast] \
  [--effort none|minimal|low|medium|high|xhigh|max]
```

- `ludens auto on` 开启**自主运行（Auto Run）**控制周期（`--seconds` 设置定时周期时长）。
- `ludens auto timer` 动态调整当前周期剩余计时（`off`、`unbounded` 或 `none` 表示取消时间上限）。
- `ludens auto off` 执行**收回控制权（Reclaim Control）**，将 Shiori 切回**手动待命（Manual Standby / `manual`）**并在 Baseware 侧撤销设备控制租约。
- `ludens steer` 向 Shiori 发送高优引导指令（打断或排队注入）。
- `ludens consolidate` 触发记忆整理任务（`--seconds` 默认 `600` 秒）。
- `ludens model` 在手动待命期间切换模型、Service Tier 或推理深度（Effort）。

### `ludens event`（Event Pool 事件池）

查看并处理异步工作区事件池中的入站通知与 Shiori 出站请求。

```bash
ludens event list [--direction <inbound|outbound>] [--status <pending|handled>] [--limit <n>]
ludens event send [--title <text>] [--message <text> | <text>]
ludens event reply <event-id> [--message <text> | <text>]
ludens event ack <event-id> [<event-id2> ...]
```

### `ludens perception` 与 `ludens observe`

管理多模态感知管道并查询磁盘或内存环中记录的观测窗口。

```bash
ludens perception status
ludens perception state
ludens perception reload
ludens perception stop
ludens perception transition <target> [--args '<JSON object>' | --file <arguments.json>]
ludens perception inject [on|off]
ludens perception observe [--capability <id|*>] [--id <record-id> | --at <ISO> | --start <ISO> --end <ISO>] \
  [--limit <n>] [--after <sequence>] [--images]
ludens observe [--capability <id|*>] [--id <record-id> | --at <ISO> | --start <ISO> --end <ISO>] \
  [--limit <n>] [--after <sequence>] [--images]
```

`observe` 默认 `--limit 8`（最大 `64`）；传入 `--images` 可在结果中附带帧图像数据。

### `ludens controller` 与 `ludens machine`

列出并直接调用原生驱动控制器（`controller/<name>`）或 Python 封装的工作区控制器（`python/<path.py>:<function>`），以及管理 Baseware 机器节点。

```bash
ludens controller list
ludens controller <id> --help
ludens controller controller/<native name> [--machine <machineId>] [--args '<JSON object>' | --file <arguments.json>]
ludens controller python/<path.py>:<function> [--args '<JSON object>' | --file <arguments.json>]

ludens machine list
ludens machine use <id>
ludens machine connect <id> [<id2> ...]
ludens machine disconnect <id>
```

---

## 自验证（Eval）与日志归档

实现位于 [`core/src/cli/eval-cli.ts`](../../../core/src/cli/eval-cli.ts) 与 [`core/src/cli/log-archive.ts`](../../../core/src/cli/log-archive.ts)。

### `ludens eval`

运行、查看历史并修订能力自验证数据集与脚本（详见[能力自验证](../concepts/self-verification.md)）。

```bash
ludens eval list
ludens eval run [<capability-id>] [--all] [--limit <n>]
ludens eval <python/capability-id>          # 当能力 ID 以 python/ 开头时可省略 run
ludens eval history [<capability-id>] [--limit <n>]
ludens eval adapt <capability-id> --reason <text> [--record <record-id> ...]
```

### `ludens logs`

读取历史运行归档事件时间线及卸载到磁盘的完整载荷（详见[日志与调用链](logging.md)）。

```bash
ludens logs events --run <run-directory> [--diagnostics]
ludens logs read --run <run-directory> \
  (--ref '<JSON reference>' | --file <reference.json> | --event <seq> --field <name>) \
  [--full]
```

---

## `baseware` CLI

实现位于 [`baseware/src/cli.ts`](../../../baseware/src/cli.ts) 与 [`baseware/src/main.ts`](../../../baseware/src/main.ts)。独立模式默认守护进程 Socket 为 `/tmp/ludens-baseware-${uid}-${id}.sock`。

### `baseware serve`

以指定驱动、传输协议与 Socket 地址直接启动 Baseware 服务。

```bash
baseware serve --driver <id> \
  [--driver-package <npm|github:org/repo#rev|https://github.com/org/repo#rev|file:path>] \
  [--port <n>] [--host <host>] \
  [--transport stdio|bridge|ssh|http|sse] \
  [--ssh-host <host>] [--ssh-user <user>] [--ssh-port <n>] [--ssh-identity <path>] [--ssh-command <cmd>] \
  [--url <url>] [--cua-command <path>] \
  [--socket <path>] [--data-dir <path>] [--machine-id <id>] \
  [--diagnostics normal|full]
```

### Baseware 客户端、驱动、节点与 MCP 命令

```bash
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

---

## `ludens-app` 桌面端 CLI

实现位于 [`app/desktop/main.ts`](../../../app/desktop/main.ts)。启动承载控制台（Console）与可选桌宠的 Electron 桌面壳。

```bash
ludens-app [--workspace <path>] [--server <url> | --dashboard <url>] \
  [--profile <path>] [--background] [--show-window] [--help]
```

| 参数 | 用途 |
| --- | --- |
| `--workspace <path>` | 打开并聚焦指定工作区目录 |
| `--server <url>` / `--dashboard <url>` | 连接已在运行的 `ludens app-server` HTTP 地址（`--dashboard` 为命令行别名） |
| `--profile <path>` | 覆盖 Electron 用户数据目录路径 |
| `--background` | 以后台/托盘常驻模式启动，不自动弹出主窗口 |
| `--show-window` | 启动时立即显示并聚焦控制台窗口 |
| `--help` | 打印桌面启动器用法说明 |

---

## 环境变量参考

以下环境变量已在 [`core/`](../../../core/src/)、[`baseware/`](../../../baseware/src/) 与 [`app/`](../../../app/) 源码中核验：

| 变量名 | 默认值 | 用途 |
| --- | --- | --- |
| `LUDENS_HOME` | `~/.ludens` | 全局配置、驱动缓存与全局状态根目录 |
| `LUDENS_WORKSPACE` | 当前工作目录 | 未传入 `--workspace` 时的默认工作区路径 |
| `LUDENS_SOCKET` | `/tmp/ludens-core-${uid}-${workspaceHash}.sock` | 覆盖 Core 守护进程 Unix Socket 路径 |
| `BASEWARE_SOCKET` | `/tmp/ludens-baseware-${uid}-${id}.sock` | 覆盖 Baseware Unix Socket 路径 |
| `BASEWARE_EPOCH` | — | `run` 与 Baseware 客户端透传的控制租约 Epoch |
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
| `LUDENS_STATIC_DIR` | — | `app-server` 托管的 Next.js 静态控制台构建产物目录 |
| `LUDENS_BUN` | — | 覆盖 Bun 可执行文件路径 |
| `LUDENS_APP_SERVER_BIN` | — | `ludens-app` 拉起 `app-server` 时的二进制路径覆盖 |
| `LUDENS_DISABLE_COMPANION` | — | 禁止 Electron 桌面端自动拉起可选桌宠窗口 |

## 相关文档

- [工作区教程](../tutorials/workspace.md) 与 [设备接入教程](../tutorials/devices.md)：结合 `ludens init`、`ludens up` 与 `baseware` 的完整端到端实战。
- [控制台与调试教程](../tutorials/console-and-debugging.md)：在控制台（Console）中查看实时运行、回放与能力状态。
- [系统架构规范](architecture.md)：守护进程 Socket、启动时序与存储边界。
- [Baseware 设备层规范](baseware.md)：驱动加载、控制租约 Epoch 与控制器契约。
- [日志与调用链规范](logging.md)：运行归档目录结构与 `ludens logs` 检索字段。
