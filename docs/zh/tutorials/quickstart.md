# 快速开始

本教程带你完成环境安装与构建，掌握零端口桌面应用、托管 Web / 远端 SPA、统一 CLI（本地 UDS 与 `--remote`）以及移动端多目标切换四种运行与接入方式，学习开启**自主运行**、通过**事件池**与 **Steer Now** 协同干预，以及随时**收回控制权**的完整流程。

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
(cd app && npm run build)
export PATH="$PWD/baseware/bin:$PWD/core/bin:$PWD/app/bin:$PATH"
```

执行完 `export PATH` 后即可在当前终端直接调用 `baseware`、`ludens` 与 `ludens-app`。如需长期生效，可将带有仓库绝对路径的 `export PATH=...` 写入 `~/.zshrc` 或 `~/.bashrc`。

## 3. 四种运行与接入方式

四种工况底层共享同一份 **Vite 静态 SPA（`app/out`）**、统一的 `@ludens/protocol/app-rpc` **JSON-RPC 2.0** 协议与 **App Daemon**（`ludens app-server`，可通过 `ludens daemon` 管理，按 **1 Workspace = 1 Core** 并发监管各个工作区 **Core**），并共用同一个 `~/.ludens/` 全局注册表。

### 方式 A：桌面端应用（零监听 TCP 端口）

先构建一次桌面端外壳，再启动原生应用窗口：

```sh
(cd app && npm run desktop:build)
ludens-app --show-window
```

`ludens-app` 常用启动参数：

- `--workspace <path>`：直接打开指定工作区目录
- `--server <url>`（别名 `--dashboard <url>`）：覆盖 `ludens-app://console/`，连接外部 Vite 开发服务或托管地址
- `--profile <path>`：自定义 Electron 用户数据目录
- `--background`：以后台托盘模式启动，暂不弹出主窗口
- `--show-window`：启动时立即显示并聚焦控制台窗口

桌面应用通过纯 Node `ensureLocalAppDaemon` 按 `LUDENS_HOME` 经 Unix Domain Socket（`app-server.sock`）拉起或复用单例 `ludens app-server`（**0 个监听 TCP 端口**），通过 `ludens-app://console/` 加载打包静态资源、通过 `ludens-media://local/media?...` 经 UDS `media/resolve` 返回本地媒体（含 `206` `Range`）、并通过 `window.ludens.rpc` 桥接渲染进程与托盘桌宠。打开 **工作区（Workspaces）**（`?view=workspaces`）切换或新建工作区后，即可零门槛直接进入 **运行（Live）**（`?view=live`，即使 0 条历史运行记录也能直接进入）：输入任务目标并发送或点击 **启动自主运行**，App Daemon 会自动按需拉起该工作区的 **Core + Baseware**（标记为 `launchedBy: "app"`），无需先开终端执行 `ludens up`（仍可在 **配置（Config）** `?view=perception` 点击 **启动工作区 / 热重载 Core / 停止**）。侧边栏「**活跃 Core**」列表实时汇总全部运行中的 Core，展示 `App` / `CLI` 启动来源徽章与单点停止按钮（`■`）。关闭主窗口（`×`）时收起至系统托盘并保持活跃 Core 继续工作（可选**桌宠**默认开启 `!auto` 多 Core 自动追踪，按待处理 `🆘` `pendingOutbound > 0` → 当前聚焦工作区 Core → 后台**自主运行** Core 的优先级跟随；可在 **设置** 中开关或通过 `LUDENS_DISABLE_COMPANION=1` 禁用）；完全退出（`⌘Q` / `before-quit` / 托盘 **Quit**）时会触发 `ActiveCoreQuitGuard`：若当前无活跃 Core，应用直接退出并保留后台守护进程；若存在活跃 Core，则弹出三选一确认（**后台继续运行 / 停止所有 Core 并退出 / 取消**）。如需打包原生 `.dmg` 或 `.exe` 安装包，运行 `npm --prefix app run desktop:dist`。

### 方式 B：托管 Web / 远端控制台（`ludens daemon start` / `ludens app-server` / `npm run dev`）

启动托管 Web / 远端 **App Daemon**（`ludens app-server`，别名 `ludens serve`），单进程对外提供静态 Vite SPA（`app/out`）、WebSocket JSON-RPC `/rpc`、HMAC capability ticket 鉴权的 `/media` 与 `/health`（无 `/api/*` REST 路由）：

```sh
# 本机回环浏览器访问
ludens app-server --listen ws://127.0.0.1:3015 --auth none --static-dir app/out

# 托管或远端微服务（非回环地址强制要求 --auth token）
LUDENS_APP_TOKEN="your-secret-token" \
  ludens daemon start --listen ws://0.0.0.0:3015 --auth token --token-env LUDENS_APP_TOKEN --static-dir app/out
```

不传入 `--listen` 时，`ludens app-server` 默认以 **纯 UDS 模式启动（`app-server.sock`，0 个监听 TCP 端口）**。浏览器打开带凭据的链接（`http(s)://host:port/#token=...`）后，SPA 会第一时间捕获凭据并通过 `history.replaceState` 擦除 URL hash 中的 token。进入 **工作区（Workspaces）** 与 **运行（Live）** 即可直接按需启动任务。若你在开发前端界面并需要 Vite 热更新，可执行 `(cd app && npm run dev)`（默认在 `127.0.0.1:3015` 启动 Vite 开发服务器，并代理 `/rpc`、`/media` 与 `/health` 至自动拉起的 `ludens app-server`）。

### 方式 C：统一 CLI 模式（`ludens` —— 本地 UDS 与 `--remote`）

可通过 `ludens daemon status|start|stop|restart` 直接管理后台单例守护进程（`stop` 默认同时停止 Core，除非传入 `--keep-cores`），也可在终端通过本地 `app-server.sock` 初始化并拉起工作区：

```sh
ludens init --name my-agent --driver cua
cd "$HOME/.ludens/workspaces/my-agent"
ludens up
```

所有操作者命令（`config`、`workspace list|open|forget`、`init`、`up`、`services`、`down`、`status`、`auto`、`steer`、`consolidate`、`stop`、`model`）均支持传入 `--remote ws(s)://... [--token ...]`（或环境变量 `LUDENS_REMOTE_URL` / `LUDENS_REMOTE_TOKEN`）统一操控远端 `app-server`。如果需要接入外部硬件桥接、仿真器、视频采集流或远程 SSH 设备，请传入 `--driver <id> --driver-package <spec>`，详见 [设备接入与 Baseware](devices.md)。

`ludens init` 与 `ludens up` 常用参数：

- `ludens init --name <name> [--workspace <path>] --driver <id> [--driver-package <spec>] [--game <path>] [--cua-command <path>] [--model <id>] [--seconds <n>] [--requests <n>] [--pet | --no-pet]`
- `ludens up [--dry-run] [--preempt] [--services <emulator,baseware,core>] [--dashboard | --no-dashboard] [--pet | --no-pet]`（`--dry-run` 仅打印启动计划不实际拉起进程；`--preempt` 抢占同一设备上的冲突 Core；`--no-dashboard` 跳过确保本地 App-Server 守护进程）

如果需要在磁盘上纳管已有目录或迁移旧版工作区，可执行 `ludens workspace open <dir> [--new-id]` 或 `ludens workspace import <dir> [--legacy-state <dir>] [--previous-workspace <dir>]`。

### 方式 D：移动端与多目标切换

在手机、平板或任意电脑浏览器打开同一份响应式 Vite SPA，即可通过控制台 `<ConnectionTargetDialog>` 在 `electron-local`（桌面端 IPC UDS）、`same-origin`（托管同源 WS `/rpc`）与 `remote`（`ws://` / `wss://` + Token）目标之间无缝切换。

## 4. 启动自主运行、事件池协作与收回控制权

Ludens 将人工监管与智能体自主执行划分为两个清晰的控制模式：

- **手动待命**（`manual`）：设备操作权由你持有，**Shiori**（Ludens 的 Agent 线程核心）处于 **Warm Standby** 待命状态，不会下发执行动作。
- **自主运行**（`auto`）：Shiori 获得当前**控制租约 (Epoch)** / **控制周期**，在设定的时间与请求预算内持续驱动 `perception.py` 与 Baseware 设备执行闭环任务。

### 在控制台（**运行**，`?view=live`）操作

1. 在桌面应用或浏览器控制台打开 **运行（Live）**（`?view=live`）——0-Run 工作区无需先运行 `ludens up` 即可零门槛进入。
2. 在底部输入框填写初始任务目标（例如巡检特定桌面流程或监测传感器状态流），点击 **启动自主运行**。若该工作区 Core 尚未启动，App Daemon 会自动按需拉起 **Core + Baseware**；若另一工作区正在同一物理设备上执行**自主运行**，控制台会弹出冲突提示（`CONFLICT -32009 DEVICE_BUSY`），供你选择取消、切换到持有工作区或**抢占接管**（处于手动待命热备中的 Core 会自动让位）。
3. 运行过程中，可通过输入框的 **事件池（Event Pool）** 模式追加不打断当前推理的异步指令；若需立即纠偏，则切换为 **即时插话（Steer Now）** 直接中断并引导当前轮次。
4. 任意时刻点击 **收回控制权**，即可立刻中止自主运行并吊销智能体控制租约，同时将 Core 保留在 **Warm Standby**（**手动待命**，`manual`）以便随时续跑或切换模型。
5. 一轮探索结束后，点击 **整理 skills/ 与 memory/ 笔记**，将有效经验沉淀到工作区的 `skills/` 与 `memory/`。

### 使用 CLI 操作

**运行**页的全部动作都有一一对应的 CLI 命令（在工作区目录下执行，或通过 `--workspace <path>` 指定目录）：

```sh
ludens status
ludens auto on --message "探索目标环境并编写经验证的 Python 能力函数" --seconds 600
ludens event send "当前序列结束后顺便核对状态面板"
ludens steer "立刻暂停执行动作并汇报当前遥测"
ludens auto off
ludens consolidate
```

其他常用生命周期命令：

- `ludens auto timer <seconds|off>`：在线调整或清除当前自主运行的剩余倒计时
- `ludens event list | reply | ack`：查看、回复或确认双向事件池中的消息
- `ludens model [<provider/id>] [--service-tier none|priority|ultrafast] [--effort none|minimal|low|medium|high|xhigh|max]`：查看或动态切换当前工作区的模型与推理档位
- `ludens services [--remote <url>]`：查看当前工作区受管后台服务的运行状态
- `ludens stop [--remote <url>]`：干净停止当前工作区 Core 守护进程
- `ludens down [--services <emulator,baseware,core>] [--keep-emulator] [--dashboard] [--pet] [--remote <url>]`：停止当前工作区（`--keep-emulator` 保留已启动的目标进程；`--dashboard` / `--pet` 一并关闭共享的 App-Server 或可选桌宠进程）
- `ludens daemon status | start | stop [--keep-cores|--stop-cores] | restart`：直接管理单例 `ludens app-server` 守护进程

## 5. 工作区配置（`ludens.json`）与全局默认参数

`ludens init` 会在工作区根目录生成 `ludens.json`，所有配置项也可在控制台 **配置（Config）**（`?view=perception`）中直接编辑：

| 配置字段 | 默认值 | 说明 |
| --- | --- | --- |
| `driver` / `driverPackage` | `cua` / 未设置 | 驱动标识符，以及可选的外部驱动包或清单路径 |
| `game` / `port` / `cuaCommand` | 未设置 | 可选目标程序路径、控制器端口或自定义 CUA 启动命令 |
| `model` | `openai-codex/gpt-6.1-sol` | Shiori 使用的主推理模型（`provider/model`） |
| `serviceTier` / `effort` | 未设置 | 可选服务档位（`none`、`priority`、`ultrafast`）与推理力度（`none`..`max`） |
| `seconds` / `requests` | `1800` / `1000` | 单次自主运行的默认时长预算（秒）与请求上限 |
| `compactionThreshold` | 未设置 | 触发后台上下文压缩的 Token 阈值 |
| `connection` | 继承全局 | 多模态传输参数（`openaiWebsockets`、`cacheRetention`、`appendOnlyContext`、`imageUrls`） |
| `machines` | 未设置 | 多节点白名单与当前活跃节点（`{ active?, allowed }`） |
| `dashboard` | `true` | `ludens up` 时是否自动确保本地 `ludens app-server`（`app-server.sock`）就绪 |
| `pet` | `false` | 当前工作区是否启用可选桌宠开关 |
| `logging` | `{ "diagnostics": "normal" }` | 运行归档日志详略等级（`"normal"` 或 `"full"`） |

使用 `ludens config` 管理全局默认值（默认存储在 `~/.ludens/`，可通过 `LUDENS_HOME` 环境变量重定向）：

```sh
ludens config show
ludens config set workspaceRoot "$HOME/ludens-workspaces"
ludens config set defaults.model "openai-codex/gpt-6.1-sol"
ludens config set defaults.seconds 1800
ludens config set defaults.requests 1000
ludens config set defaults.pet false
ludens config set defaults.connection.imageUrls.enabled true
```

## 6. 日志检视与后续学习

每次运行都会在 `logs/<run-id>/` 下持久化结构化事件流，并将连续观测与 30 Hz fMP4 视频写入 `.ludens/timeline/`。你可以在控制台 **回放（Replay）**（`?view=replay`）中同步时间线复盘，或在终端用 `ludens logs events --run <run-dir>` 与 `ludens logs read --run <run-dir> ...` 检索原始记录。

继续阅读后续教程：

- [设备接入与 Baseware](devices.md) — 接入外部硬件驱动、远程 SSH/桥接节点并配置多机工具路由
- [工作区、能力与自验证](workspace.md) — 编写 `MEMORY.md`、`skills/`、`@capability` 并运行 `ludens eval`
- [感知、执行与性能调优](perception-and-action.md) — 编写热重载 `perception.py` 状态机并调优多模态传输延迟
- [控制台使用与排障](console-and-debugging.md) — 全面使用控制台各视图并诊断控制周期卡顿或能力自检失败
