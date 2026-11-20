# 快速开始

本教程带你完成环境安装与构建，掌握 Ludens 的三大运行平面——**零端口桌面端应用（`desktop`）**、**托管云端 / 远端节点与移动端受管沙箱（`remote`）**、**默认隔离的前端与 AI Harness 开发预览（`web-dev`）**——以及面向人的纯 RPC 客户端 CLI `ludens`（本地 UDS 自动按需唤醒 `ludens-server` 与 `--remote` 远程直连），学习开启**自主运行**、通过**事件池**与 **Steer Now** 协同干预，以及随时**收回控制权**的完整流程。

## 1. 环境前置条件

开始安装前，请确认系统已备齐以下运行环境与凭据：

- **Bun** `1.4+`
- **Node.js** `22.13+`（或 `24+`）
- **Python** `3.12+` 与 **uv**
- **已配置好的模型 / OMP 认证凭据**（用于驱动底层 LLM 推理）

## 2. 克隆仓库、安装依赖与构建

在仓库根目录执行安装构建，并将各子包的命令行工具加入 `PATH`：

```sh
git clone https://github.com/Arkevo-Lab/Ludens.git && cd Ludens
bun install --frozen-lockfile
uv sync --project core/python --frozen
bun run build
export PATH="$PWD/baseware/bin:$PWD/core/bin:$PWD/server/bin:$PWD/client/bin:$PWD/desktop/bin:$PATH"
```

> 根目录 `bun run build` 会依次构建全部自治产线产物（`client/dist`、`server/dist`、`core/dist`、`baseware/dist`、`desktop/dist/electron`）；也可按需单跑分产线：`bun run build:client`、`bun run build:server`、`bun run build:sandbox`、`bun run build:desktop`。

执行完 `export PATH` 后即可在当前终端直接调用 `ludens`（`@ludens/client` 纯 RPC 操作者 CLI）、`ludens-server`（`@ludens/server` 控制面服务端）、`ludens-core`（`@ludens/core` 单工作区执行内核与沙盒工具）、`baseware`（`@ludens/baseware` 跨设备集成层）与 `ludens-app`（`@ludens/desktop` 桌面应用）。如需长期生效，可将带有仓库绝对路径的 `export PATH=...` 写入 `~/.zshrc` 或 `~/.bashrc`。

## 3. 三种运行平面与纯 RPC CLI 接入

所有接入平面底层共享同一份 **Vite 静态 SPA（`client/dist`）**、统一的 `@ludens/protocol/app-rpc` **JSON-RPC 2.0** 协议与控制面服务端 **`@ludens/server`（`ludens-server`）**（按 **1 Workspace = 1 Core** 并发监管各个工作区的 `@ludens/core` `ludens-core run` 进程），并通过会话握手显式协商运行平面（`runtimeProfile`）与宿主机能力边界（`capabilities`）。

### 1. 桌面端应用（`ludens-app` —— 日常本地主力入口，`desktop`）

若此前尚未执行根 `bun run build`，先构建桌面端相关产线，再启动原生应用窗口：

```sh
bun run build:desktop
ludens-app --show-window
```

`ludens-app` 常用启动参数：

- `--workspace <path>`：直接打开指定工作区目录
- `--server <url>`：覆盖 `ludens-app://console/`，加载显式指定的本机 Vite 开发服务器地址
- `--profile <path>`：自定义 Electron 用户数据目录（默认 `~/.ludens/desktop/profile`）
- `--background`：以后台托盘模式启动，暂不弹出主窗口
- `--show-window`：启动时立即显示并聚焦控制台窗口

桌面应用是日常本地使用的主力入口：通过 `ensureLocalAppDaemon` 按 `LUDENS_HOME`（默认 `~/.ludens`）经 Unix Domain Socket（`app-server.sock`）拉起或复用单例 `ludens-server`（**0 个监听 TCP 端口**），具备完整本机宿主能力（自由选择本机目录、`file:` 驱动包、自定义 `cuaCommand` 与本地存储路径）。应用通过 `ludens-app://console/` 加载 `client/dist`（Electron 打包态位于 `Resources/client`）静态资源、通过 `ludens-media://local/media?...` 经 UDS `media/resolve` 返回本地媒体（含 `206` `Range`）、并通过 `window.ludens.rpc` 与 `window.ludens.dialog.pickPath` 桥接渲染进程、原生目录/ROM 选择器与托盘桌宠。在本地 UDS 连接健康时，侧边栏自动隐藏连接状态胶囊以保持清爽原生观感，同时随时可通过 `⌘K / Ctrl+K` 快速跳转面板切换连接目标 / 远端服务器。

通过侧边栏工作区切换器底部 **新建工作区**、`⌘K / Ctrl+K` 快速跳转面板或 **工作区（Workspaces）**（`?view=workspaces&create=1`）即可打开一站式创建向导：支持一键绑定 `~/.ludens/machines.json` 中的**已有设备节点**、从**已安装驱动**指定 ROM 与端口，或验证并收录**新驱动包**，同时内联选择推理模型并点击 **创建并进入运行台** 一步完成初始化、服务拉起与进入 **运行（Live）**（`?view=live`，即使 0 条历史运行记录也能直接进入）：输入任务目标并发送或点击 **启动自主运行**，`ludens-server` 会自动按需拉起该工作区的 **Core + Baseware**（标记为 `launchedBy: "app"`），无需先开终端执行 `ludens workspace up`（仍可在 **配置（Config）** `?view=perception` 点击 **启动工作区 / 热重载 Core / 停止**）。侧边栏「**活跃 Core**」列表实时汇总全部运行中的 Core，展示 `App` / `CLI` 启动来源徽章与单点停止按钮（`■`）。关闭主窗口（`×`）时收起至系统托盘并保持活跃 Core 继续工作（可选**桌宠**默认开启 `!auto` 多 Core 自动追踪，按待处理 `🆘` `pendingOutbound > 0` → 当前聚焦工作区 Core → 后台**自主运行** Core 的优先级跟随；可在 **设置** 中开关或通过 `LUDENS_DISABLE_COMPANION=1` 禁用）；完全退出（`⌘Q` / `before-quit` / 托盘 **Quit**）时会触发 `ActiveCoreQuitGuard`：若当前无活跃 Core，应用直接退出并按归属自动回收由本桌面端拉起的本地纯 UDS 守护进程（外部手动启动的守护进程不受影响）；若存在活跃 Core，则弹出三选一确认（**后台继续运行 / 停止所有 Core 并退出 / 取消**）。如需本地验证打包目录，运行 `bun run pack:desktop`；如需打包原生 `.dmg` 或 `.exe` 安装包，运行 `bun run dist:desktop`。

### 2. 托管云端 / 远端节点与移动端（`ludens-server` —— 受管沙箱，`remote`）

面向云端 SaaS、远端算力节点及手机/平板浏览器访问，可通过根目录一键入口 `bun run start:selfhost` 或直接启动 `ludens-server serve`（后台守护进程 `ludens-server start`），单进程对外提供静态 Vite SPA（`client/dist`）、WebSocket JSON-RPC `/rpc`、HMAC capability ticket 鉴权的 `/media` 与 `/health`（亦可通过 `--trusted-origin` 支持独立发版的异源 `@ludens/client` 直连）：

```sh
# 根目录自托管快捷入口（自动校验/按需构建 client/dist 并透传参数给 ludens-server serve）
LUDENS_APP_TOKEN="your-secret-token" \
  bun run start:selfhost -- --listen ws://0.0.0.0:3015 --auth token --token-env LUDENS_APP_TOKEN

# 或直接运行 ludens-server（非 --dev 的 ws:// 监听强制要求 --auth token）
LUDENS_APP_TOKEN="your-secret-token" \
  ludens-server serve --listen ws://0.0.0.0:3015 --auth token --token-env LUDENS_APP_TOKEN --static-dir client/dist

# 或作为后台守护进程启动
LUDENS_APP_TOKEN="your-secret-token" \
  ludens-server start --listen ws://0.0.0.0:3015 --auth token --token-env LUDENS_APP_TOKEN --static-dir client/dist
```

在 `remote` 平面下，服务端强制启用 **Token 鉴权**与 **`managed-sandbox` 受管沙箱能力边界**（禁止越界挂载任意宿主机路径、`file:` 本地驱动包、自定义宿主可执行命令与本机自定义存储目录；服务端 `RpcRouter` 对越权变更返回 `403 CAPABILITY_RESTRICTED`，前端表单同步收敛为受管工作区视图）。不传入 `--listen` 时，`ludens-server serve` 默认以**纯 UDS 模式启动（`app-server.sock`，0 个监听 TCP 端口）**。在手机、平板或桌面浏览器打开带凭据的链接（`http(s)://host:port/#token=...`）后，响应式 SPA 会第一时间捕获凭据并通过 `history.replaceState` 擦除 URL hash 中的 token，也可随时通过 `<ConnectionTargetDialog>` 在 `electron-local`、`same-origin` 与 `remote`（`ws://` / `wss://` + Token）目标之间无缝切换。

### 3. 前端与 AI Harness 开发预览（根目录 `bun run dev*` —— 默认隔离，`web-dev`）

在浏览器或桌面壳中调试前端界面、服务端或运行自动化 AI Harness 巡检验收时，使用根目录统一编排的 4 种开发模式（`scripts/dev.mjs`，除纯前端外默认均隔离至 `~/.ludens-dev`，传入 `-- --real-home` 或使用 `:real` 别名可挂载真实 `~/.ludens`）：

```sh
# 1. Web 全栈联调（受管回环 ludens-server --dev + Vite HMR，默认隔离 ~/.ludens-dev）
bun run dev            # 等价于 bun run dev:web
bun run dev:web:real   # 显式挂载真实 ~/.ludens 注册表

# 2. Electron 桌面端联调（纯 Vite HMR + Electron 原生 UDS 自管本地 server，不双起 TCP server）
bun run dev:desktop
bun run dev:desktop:real

# 3. 纯异源前端开发（零本地后端，直连远程或云端 ludens-server）
bun run dev:client

# 4. 独立前台启动开发态 ludens-server
bun run dev:server
bun run dev:server:real
```

`bun run dev` / `bun run dev:web` 会自动拉起本机回环 `ludens-server serve --dev --listen ws://127.0.0.1:0 --parent-watchdog` 与 Vite 开发服务器（默认 `127.0.0.1:3015`），并将 `LUDENS_HOME` 默认隔离至 `~/.ludens-dev`（也可传入 `-- --home /custom/dir` 指定独立目录），避免起停开发预览时误杀日常桌面端 `~/.ludens` 守护进程。`bun run dev:desktop` 仅起纯 Vite HMR 渲染器并由 Electron 原生 UDS 自行管理本地 `ludens-server`，绝不双起冗余 TCP server。`--dev` 仅允许绑定本机回环地址（`127.0.0.1`、`localhost`、`::1`），授予完整本地调试能力，在侧边栏展示语义化的 **`DEV PREVIEW`** 标识，并在 `<ConnectionTargetDialog>` 中提供**开发预览视角模拟**开关（一键切换「完整桌面视图」与「云端 SaaS / 手机端受管视图」）。如需直接预览生产静态产物 `client/dist`，可执行 `bun run start:selfhost`。

### 纯 RPC 客户端 CLI 操控（`ludens` —— 本地 UDS 按需唤醒与 `--remote`）

可通过 `ludens-server status|start|stop|restart` 直接管理后台单例服务端（`stop` 默认同时停止 Core，除非传入 `--keep-cores`），也可在终端直接调用纯 RPC 客户端 `ludens` 初始化并拉起工作区（若本地 `ludens-server` 未启动，`ludens` 会自动从 `PATH` 按需唤醒 `ludens-server start`）：

```sh
ludens workspace init --name my-agent --driver cua
cd "$HOME/.ludens/workspaces/my-agent"
ludens workspace up
```

所有 `ludens` 命令（`ludens config ...`、`ludens workspace <init|list|open|forget|import|up|down|services|eval>`、`ludens <status|auto|steer|consolidate|stop|model|logs>`）均为 100% 纯 RPC 客户端，支持传入 `--remote ws(s)://... [--token ...]`（或环境变量 `LUDENS_REMOTE_URL` / `LUDENS_REMOTE_TOKEN`）统一操控远端 `ludens-server`。如果需要接入外部硬件桥接、仿真器、视频采集流或远程 SSH 设备，请传入 `--driver <id> --driver-package <spec>`，详见 [设备接入与 Baseware](devices.md)。

`ludens workspace init` 与 `ludens workspace up` 常用参数：

- `ludens workspace init --name <name> [--workspace <path>] [--machine <id>] [--driver <id>] [--driver-package <spec>] [--game <path>] [--port <n>] [--cua-command <path>] [--model <id>] [--effort <level>] [--service-tier <tier>] [--register-driver] [--pet | --no-pet]`
- `ludens workspace up [--preempt] [--services <emulator,baseware,core>]`（`--preempt` 抢占同一设备上的冲突 Core；`--services` 指定启动的子服务）

如果需要在磁盘上纳管已有目录或迁移旧版工作区，可执行 `ludens workspace open <dir> [--new-id]` 或 `ludens workspace import <dir> [--legacy-state <dir>] [--previous-workspace <dir>]`。

## 4. 启动自主运行、事件池协作与收回控制权

Ludens 将人工监管与智能体自主执行划分为两个清晰的控制模式：

- **手动待命**（`manual`）：设备操作权由你持有，**Shiori**（Ludens 的 Agent 线程核心）处于 **Warm Standby** 待命状态，不会下发执行动作。
- **自主运行**（`auto`）：Shiori 获得当前**控制租约 (Epoch)** / **控制周期**，持续驱动 `perception.py` 与 Baseware 设备执行闭环任务；默认不设上限直至人工暂停，或按显式 `--seconds` / `ludens auto timer` 倒计时运行。

### 在控制台（**运行**，`?view=live`）操作

1. 在桌面应用或浏览器控制台打开 **运行（Live）**（`?view=live`）——0-Run 工作区无需先运行 `ludens workspace up` 即可零门槛进入。
2. 在底部输入框填写初始任务目标（例如巡检特定桌面流程或监测传感器状态流），点击 **启动自主运行**。若该工作区 Core 尚未启动，`ludens-server` 会自动按需拉起 **Core + Baseware**；若另一工作区正在同一物理设备上执行**自主运行**，控制台会弹出冲突提示（`CONFLICT -32009 DEVICE_BUSY`），供你选择取消、切换到持有工作区或**抢占接管**（处于手动待命热备中的 Core 会自动让位）。
3. 运行过程中，可通过输入框的 **事件池（Event Pool）** 模式追加不打断当前推理的异步指令；若需立即纠偏，则切换为 **即时插话（Steer Now）** 直接中断并引导当前轮次。
4. 任意时刻点击 **收回控制权**，即可立刻中止自主运行并吊销智能体控制租约，同时将 Core 保留在 **Warm Standby**（**手动待命**，`manual`）以便随时续跑或切换模型。
5. 一轮探索结束后，点击 **整理 skills/ 与 memory/ 笔记**，将有效经验沉淀到工作区的 `skills/` 与 `memory/`。

### 使用 CLI 操作

**运行**页的全部动作都有一一对应的 CLI 命令（在工作区目录下执行，或通过 `--workspace <path>` 指定目录）：

```sh
ludens status
ludens auto on --message "探索目标环境并编写经验证的 Python 能力函数" --seconds 600
ludens-core event send "当前序列结束后顺便核对状态面板"
ludens steer "立刻暂停执行动作并汇报当前遥测"
ludens auto off
ludens consolidate
```

其他常用生命周期命令：

- `ludens auto timer <seconds|off>`：在线调整或清除当前自主运行的剩余倒计时
- `ludens-core event list | reply | ack`：在工作区或沙盒内查看、回复或确认双向事件池中的消息
- `ludens model [<provider/id>] [--service-tier none|priority|ultrafast] [--effort none|minimal|low|medium|high|xhigh|max]`：查看或动态切换当前工作区的模型与推理档位
- `ludens workspace services [--remote <url>]`：查看当前工作区受管后台服务的运行状态
- `ludens stop [--remote <url>]`：停止当前工作区正在运行的活跃控制周期并收回设备控制权
- `ludens workspace down [--services <emulator,baseware,core>] [--keep-emulator] [--remote <url>]`：关闭当前工作区受管后台进程（`--keep-emulator` 保留已启动的目标进程）
- `ludens-server status | start | stop [--keep-cores|--stop-cores] | restart`：直接管理单例 `ludens-server` 控制面守护进程

## 5. 工作区配置（`ludens.json`）与全局默认参数

`ludens workspace init` 会在工作区根目录生成 `ludens.json`，所有配置项也可在控制台 **配置（Config）**（`?view=perception`）中直接编辑：

| 配置字段 | 默认值 | 说明 |
| --- | --- | --- |
| `driver` / `driverPackage` | `cua` / 未设置 | 驱动标识符，以及可选的外部驱动包或清单路径 |
| `game` / `port` / `cuaCommand` | 未设置 | 可选目标程序路径、控制器端口或自定义 CUA 启动命令 |
| `model` | `openai-codex/gpt-6.2-sol` | Shiori 使用的主推理模型（`provider/model`） |
| `serviceTier` / `effort` | 未设置 | 可选服务档位（`none`、`priority`、`ultrafast`）与推理力度（`none`..`max`） |
| `compactionThreshold` | 未设置 | 触发后台上下文压缩的 Token 阈值 |
| `connection` | 继承全局 | 多模态传输参数（`openaiWebsockets`、`cacheRetention`、`appendOnlyContext`、`imageUrls`） |
| `machines` | 未设置 | 多节点白名单与当前活跃节点（`{ active?, allowed }`） |
| `pet` | `false` | 当前工作区是否启用可选桌宠开关 |
| `logging` | `{ "diagnostics": "normal" }` | 运行归档日志详略等级（`"normal"` 或 `"full"`） |

使用 `ludens config` 管理全局默认值（默认存储在 `~/.ludens/`，可通过 `LUDENS_HOME` 环境变量重定向）：

```sh
ludens config show
ludens config set workspaceRoot "$HOME/ludens-workspaces"
ludens config set defaults.model "openai-codex/gpt-6.2-sol"
ludens config set defaults.pet false
ludens config set defaults.connection.imageUrls.enabled true
```

## 6. 日志检视与后续学习

每次运行都会在 `logs/<run-id>/` 下持久化结构化事件流，并将连续观测与 30 Hz fMP4 视频写入 `.ludens/timeline/`。你可以在控制台 **回放（Replay）**（`?view=replay`）中同步时间线复盘，或在终端用纯 RPC 命令 `ludens logs events --run <run-dir>` 与 `ludens logs read --run <run-dir> ...` 检索原始记录。

继续阅读后续教程：

- [设备接入与 Baseware](devices.md) — 接入外部硬件驱动、远程 SSH/桥接节点并配置多机工具路由
- [工作区、能力与自验证](workspace.md) — 编写 `MEMORY.md`、`skills/`、`@capability` 并运行 `ludens workspace eval` / `ludens-core eval`
- [感知、执行与性能调优](perception-and-action.md) — 编写热重载 `perception.py` 状态机并调优多模态传输延迟
- [控制台使用与排障](console-and-debugging.md) — 全面使用控制台各视图并诊断控制周期卡顿或能力自检失败
