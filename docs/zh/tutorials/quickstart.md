# 快速开始

本教程带你完成环境安装与构建，掌握桌面端应用、本地浏览器控制台和无头 CLI 三种启动方式，学习开启**自主运行**、通过**事件池**与 **Steer Now** 协同干预，以及随时**收回控制权**的完整流程。

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

## 3. 三种启动方式

三种启动方式底层共享同一个 `@ludens/core` `app-server` 进程监管服务，以及统一的 `~/.ludens/` 全局注册表。

### 方式 A：桌面端应用（Desktop App）

先构建一次桌面端外壳，再启动原生应用窗口：

```sh
(cd app && npm run desktop:build)
ludens-app --show-window
```

`ludens-app` 常用启动参数：

- `--workspace <path>`：直接打开指定工作区目录
- `--server <url>`（别名 `--dashboard <url>`）：连接已启动的远程或本地 `app-server`
- `--profile <path>`：自定义 Electron 用户数据目录
- `--background`：以后台托盘模式启动，暂不弹出主窗口
- `--show-window`：启动时立即显示并聚焦控制台窗口

在桌面应用内，打开 **工作区（Workspaces）**（`?view=workspaces`）即可切换或新建工作区，再进入 **配置（Config）**（`?view=perception`）一键**启动工作区**，全程无需打开终端。关闭主窗口时应用会收起至系统托盘（托盘附带可选的**桌宠**小组件，可在**设置**中开关或通过环境变量 `LUDENS_DISABLE_COMPANION=1` 禁用）；完全退出应用（macOS `⌘Q` 或托盘 **Quit**）时会自动清理全部受管后台进程。如需打包原生 `.dmg` 或 `.exe` 安装包，运行 `npm --prefix app run desktop:dist`。

### 方式 B：本地浏览器控制台（`ludens app-server` / `npm run dev`）

启动统一的 `app-server`（别名 `ludens serve`），由它同时提供 `/api/*` 接口与静态前端控制台（`app/out`）：

```sh
ludens app-server
```

`ludens app-server` 默认监听 `127.0.0.1:3015`（支持 `--host`、`--port <0|1..65535>`、`--static-dir <path>`、`--trusted-origin <origin>` 与 `--parent-watchdog`）。在浏览器打开 [`http://127.0.0.1:3015`](http://127.0.0.1:3015)，前往 **工作区（Workspaces）**（`?view=workspaces`）选择或新建工作区，随后在 **配置（Config）**（`?view=perception`）点击**启动工作区**。若你在开发前端界面并需要热更新，保持 `ludens app-server` 运行并在另一终端启动 `(cd app && npm run dev)` 即可。

### 方式 C：无头 CLI 模式

也可以完全在终端中初始化并拉起工作区。以下示例使用 Ludens 内置的桌面自动化驱动（`cua`）：

```sh
ludens init --name my-agent --driver cua
cd "$HOME/.ludens/workspaces/my-agent"
ludens up
```

如果需要接入外部硬件桥接、仿真器、视频采集流或远程 SSH 设备，请传入 `--driver <id> --driver-package <spec>`，详见 [设备接入与 Baseware](devices.md)。

`ludens init` 与 `ludens up` 常用参数：

- `ludens init --name <name> [--workspace <path>] --driver <id> [--driver-package <spec>] [--game <path>] [--cua-command <path>] [--model <id>] [--seconds <n>] [--requests <n>] [--pet | --no-pet]`
- `ludens up [--dry-run] [--dashboard | --no-dashboard] [--pet | --no-pet]`（`--dry-run` 仅打印启动计划不实际拉起进程；`--no-dashboard` 跳过启动本地控制台端口；`--pet` / `--no-pet` 控制是否附带可选桌宠）

如果需要把磁盘上已有的目录纳入管理或迁移旧版工作区，可执行 `ludens workspace open <dir> [--new-id]` 或 `ludens workspace import <dir> [--legacy-state <dir>] [--previous-workspace <dir>]`。

## 4. 启动自主运行、事件池协作与收回控制权

Ludens 将人工监管与智能体自主执行划分为两个清晰的控制模式：

- **手动待命**（`manual`）：设备操作权由你持有，**Shiori**（Ludens 的 Agent 线程核心）处于待命状态，不会下发执行动作。
- **自主运行**（`auto`）：Shiori 获得当前**控制租约 (Epoch)** / **控制周期**，在设定的时间与请求预算内持续驱动 `perception.py` 与 Baseware 设备执行闭环任务。

### 在控制台（**运行**，`?view=live`）操作

1. 在桌面应用或浏览器控制台打开 **运行（Live）**（`?view=live`）。
2. 在底部输入框填写初始任务目标（例如巡检特定桌面流程或监测传感器状态流），点击 **启动自主运行**。
3. 运行过程中，可通过输入框的 **事件池（Event Pool）** 模式追加不打断当前推理的异步指令；若需立即纠偏，则切换为 **即时插话（Steer Now）** 直接中断并引导当前轮次。
4. 任意时刻点击 **收回控制权**，即可立刻中止自主运行并吊销智能体控制租约，切回 **手动待命**。
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
- `ludens services`：查看当前工作区受管后台服务的运行状态
- `ludens down [--keep-emulator] [--dashboard] [--pet]`：停止当前工作区（`--keep-emulator` 保留已启动的目标进程；`--dashboard` / `--pet` 一并关闭共享的控制台或可选桌宠进程）

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
| `dashboard` | `true` | `ludens up` 时是否自动拉起本地控制台端口 |
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
