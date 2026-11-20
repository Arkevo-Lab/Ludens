# 架构与边界

Ludens 是面向复杂端到端任务（如机器人操控、安防巡检、桌面与软件自动化、实时游戏等）的多模态跨设备 Harness，采用 **4 层角色 × 6 个物理包**的正交并发架构——将**客户端交互（L1：Client & Desktop）**、**控制面服务端（L2：Server）**、**单工作区执行内核 / 沙盒（L3：Core）**与**跨设备集成层（L4：Baseware）**加上底层零依赖**共享契约层（Protocol）**彻底解耦：

- **L1 客户端（`@ludens/client` `client/` + All-in-One 桌面发行包 `@ludens/desktop` `desktop/`）**：`@ludens/client` 提供 Web 与手机端同构、可独立线上发版、支持异源直连（First-class Cross-Origin）的响应式 Vite 静态 SPA（`client/dist`），以及面向人的纯 RPC CLI `ludens`（**严格仅依赖 `@ludens/protocol`**，零 `@ludens/core` / `@ludens/server` / `@ludens/baseware` / `electron` 依赖；本地未起服务时自动从 `PATH` 按需唤醒 `ludens-server start`）；`@ludens/desktop`（`ludens-app`）将 `client/dist`（Electron 打包态位于 `Resources/client`）+ 本地 `server/dist` + `core/dist` + `baseware/dist` 组装为开箱即用的零 TCP 端口 Electron 桌面应用（并支持系统托盘、`ActiveCoreQuitGuard`、可选桌宠以及随时切连远程 `ludens-server`）。
- **L2 控制面服务端（`@ludens/server` `server/`，bin `ludens-server`）**：开源可本地（默认纯 UDS `app-server.sock`）、自托管或云端部署（`--listen ws://HOST:PORT --auth token`），统一提供 JSON-RPC 2.0（含 `capabilities/eval*`、`workspaces/import`、`logs/*`）、`EventHub` 实时推送、HMAC capability ticket 鉴权的 `/media`、查询/冷索引 Worker 以及多工作区 Core 运行环境调度（`WorkspaceSupervisor` / `Launcher`）。**零 `@ludens/client` / `@ludens/desktop` 依赖**。
- **L3 单工作区执行内核 / 沙盒（`@ludens/core` `core/`，bin `ludens-core`）**：遵循 **1 Workspace = 1 Core** 隔离原则，每个工作区对应一个独立 Core 进程，内部承载 **Shiori**（Agent 线程核心，基于 OMP `18.22.2`）、常驻感知与动作状态机（`perception.py`）、可编程外层循环（`loop.py`）、工作区代码与离线自验证（`ludens-core eval`）。**零 `@ludens/server` / `@ludens/client` / `@ludens/desktop` 依赖**。
- **L4 跨设备集成层（`@ludens/baseware` `baseware/`，bin `baseware`）+ 共享契约底座（`@ludens/protocol` `protocol/`）**：Baseware 独立管理硬件、模拟器与桌面驱动、统一 Controller 目录、`epoch` 控制租约仲裁与 MCP 接口；Protocol 提供零 Node/Bun/OMP 运行时依赖的 JSON-RPC 2.0 协议契约、跨端 DTO 类型与纯浏览器安全投影函数。

## 四层角色与六包拓扑

| 层级 / 物理包 | 可执行入口与进程形态 | 核心职责与依赖边界 |
| --- | --- | --- |
| **共享契约层**<br>`protocol/`（`@ludens/protocol`） | 库包（零外部依赖） | **跨端强类型契约底座**：定义 `@ludens/protocol/app-rpc` JSON-RPC 2.0 协议（含 `capabilities/evalHistory`、`capabilities/evalAdapt`、`workspaces/import`、`logs/events`、`logs/read` 等完整契约）、驱动/机器/事件池/时间线 Schema、供前端 SPA 直接消费的纯浏览器安全 DTO 与投影函数，以及供 CLI/Server/Desktop 共用的宿主路径契约（`@ludens/protocol/app-server-paths`）。零第三方/OMP 运行时依赖。 |
| **L1 客户端（Web / 手机端 + 纯 RPC CLI）**<br>`client/`（`@ludens/client`） | `ludens`（纯 RPC 操作者 CLI）<br>+ Vite 静态 SPA（`client/dist`） | **异源一等公民客户端与人类操作者入口**：**严格仅依赖 `@ludens/protocol`**（零 `@ludens/core`、`@ludens/server`、`@ludens/baseware`、`electron` 依赖）。包含：(1) React 19 + Vite 响应式 SPA，支持独立部署并通过 `<ConnectionTargetDialog>` 或 `?server=` 连接本地或异源远程 `ludens-server`；(2) 面向人的纯 RPC CLI `ludens`（`ludens config ...`、`ludens workspace <init\|list\|open\|forget\|import\|up\|down\|services\|eval>`、顶层高频遥控 `ludens <status\|auto\|steer\|consolidate\|stop\|model\|logs>`），全线支持本地 `app-server.sock`（未就绪时自动从 `PATH` 按需唤醒 `ludens-server start`）与 `--remote ws(s)://... [--token ...]`。 |
| **L1 All-in-One 桌面发行壳**<br>`desktop/`（`@ludens/desktop`） | `ludens-app`（Electron 桌面宿主） | **自包含本地桌面应用**：组装各子包自治产物 `client/dist`（打包态 `Resources/client`）+ `server/dist` + `core/dist` + `baseware/dist`。通过 `AppServerHost` / `ensureLocalAppDaemon` 按 `LUDENS_HOME` 拉起或复用单例 `ludens-server` 并走 Unix Domain Socket（`app-server.sock`，**0 个监听 TCP 端口**）；注册 `ludens-app://console/` 与 `ludens-media://local/media?...`（经 UDS `media/resolve` 支持 HTTP `206 Range`）；提供 `DesktopUdsRpcRelay`（`window.ludens.rpc`）、系统托盘、`ActiveCoreQuitGuard` 三选一退出守卫与可选桌宠（`PetSessionCoordinator`），并可随时切连远程 `ludens-server`。 |
| **L2 控制面服务端**<br>`server/`（`@ludens/server`） | `ludens-server`（`<serve\|start\|stop\|restart\|status>`） | **多工作区控制面与 JSON-RPC 2.0 服务端**：依赖 `@ludens/protocol`、`@ludens/core`、`@ludens/baseware`（**零 `@ludens/client` / `@ludens/desktop` 依赖**）。默认纯 UDS（`app-server.sock`），亦可通过 `--listen ws://HOST:PORT` 对外服务（非 `--dev` 的 `ws://` 强制 `--auth token`）。在同一进程内提供 UDS NDJSON 与 WebSocket `/rpc`、`EventHub` 实时推送（`events/subscribe` + 1024 条环形缓冲 `sinceSeq` 补齐）、HMAC capability ticket `/media`（`mt=`、`206 Range`）、`/health` 及静态 `client/dist`；内部承载 `WorkspaceSupervisor`（调用 `ludens-core run` 拉起沙盒）、`DashboardWorker` 查询与冷索引构建、事件池读写、物理设备冲突仲裁（`CONFLICT -32009 DEVICE_BUSY` + `preempt`）、运行时 Profile（`desktop` / `remote` / `web-dev`）与桌宠状态协调。 |
| **L3 单工作区执行内核 / 沙盒**<br>`core/`（`@ludens/core`） | `ludens-core`（`run` 与沙盒内 `<controller\|perception\|event\|machine\|eval>`） | **单工作区执行沙盒（`1 Workspace = 1 Core`）**：仅依赖 `@ludens/protocol`、`@ludens/baseware` 与 `@oh-my-pi/*`（**零 `@ludens/server` / `@ludens/client` / `@ludens/desktop` 依赖**）。每个工作区运行独立 Core 进程，内部承载 **Shiori**（Agent 线程核心，挂载 **OMP 18.22.2**）、常驻 `perception.py` 状态机、可选 `loop.py` 外层循环、能力发现与路由、工作区内生能力自验证（`ludens-core eval`）及运行日志归档。沙盒内 `PATH` 注入 `core/bin`，供 Shiori 直接调用 `ludens-core <controller\|perception\|event\|machine\|eval>`（统一使用 `ludens-core perception observe`）。 |
| **L4 跨设备集成层**<br>`baseware/`（`@ludens/baseware`） | `baseware`（`serve` / `driver` / `controller` / `machine` / `mcp`） | **独立跨设备集成层服务**：加载内置（`cua`）或外部 Driver，提供统一 Controller 能力目录、控制权租约（`epoch`）仲裁、输入取消与独立设备事实日志（`logs/baseware/`），对外暴露 CLI、TS/Python API 与 MCP 接口。 |

```mermaid
flowchart LR
    O["操作者 (Web / Mobile / CLI / Desktop)"] --> CUI["L1 @ludens/client: Vite SPA & ludens CLI"]
    O --> Desk["L1 @ludens/desktop: ludens-app (Electron + Tray + Pet)"]
    Desk --> CUI
    CUI -->|"UDS app-server.sock / WS /rpc"| Srv["L2 @ludens/server: ludens-server + WorkspaceSupervisor + Query Worker"]
    Srv -->|"ludens-core run"| C1["L3 @ludens/core: Core 1 / Shiori (OMP 18.22.2) - Workspace A"]
    Srv -->|"ludens-core run"| C2["L3 @ludens/core: Core 2 / Shiori (OMP 18.22.2) - Workspace B"]
    C1 --> P["常驻 perception.py & loop.py"]
    C1 --> S["OMP bash -> ludens-core controller/perception/event/machine/eval"]
    S --> C["统一 Controller 入口"]
    P --> C
    C --> B["L4 @ludens/baseware: baseware 服务 + epoch 租约仲裁"]
    B --> Dvr["Driver (stdio / bridge / ssh / http / sse)"]
    Dvr --> E["硬件 / 桌面 / 模拟器 / 远程节点"]
    C1 --> L["workspace/logs & .ludens"]
    B --> L
    L --> Srv
```

### 四个正交可执行 CLI 与桌面入口

六包架构将命令行工具按受众与运行边界严格正交划分为 4 个 CLI + 1 个桌面入口：

1. **`ludens`（`@ludens/client`，面向人的纯 RPC 操作者 CLI）**：
   - 全局配置：`ludens config [show | set <field> <value>]`
   - 工作区全生命周期与评测：`ludens workspace <init|list|open|forget|import|up|down|services|eval>`
   - 顶层高频遥控与日志检索：`ludens <status|auto|steer|consolidate|stop|model|logs>`
   - 全线 100% 走 JSON-RPC：传入 `--remote <ws(s)://...>` 时直连远端 `ludens-server`；未传 `--remote` 时连接本机 `$LUDENS_HOME/run/app-server.sock`，若本地服务未启动则自动从 `PATH` 按需执行 `ludens-server start` 唤醒后重连。
2. **`ludens-server`（`@ludens/server`，控制面服务端与守护进程管理 CLI）**：
   - `ludens-server serve [--listen <unix://...|ws://HOST:PORT>]... [--auth <none|token>] [--token <secret>|--token-env <VAR>] [--static-dir <dir>] [--trusted-origin <origin>] [--parent-watchdog] [--dev]`
   - `ludens-server <start|stop|restart|status> [--keep-cores|--stop-cores] [--listen ...]`
3. **`ludens-core`（`@ludens/core`，单工作区沙盒内核与沙盒内 Shiori 工具 CLI）**：
   - 启动单工作区沙盒：`ludens-core run [--workspace <path>] [--baseware-socket <path>] [--device-only] [--model <id>] ...`
   - 沙盒内工具命令（直连工作区 `core.sock` 或离线执行）：`ludens-core controller ...`、`ludens-core perception <status|state|reload|stop|transition|inject|observe>`（已移除旧顶层重复的 `observe` 别名，统一使用 `ludens-core perception observe`）、`ludens-core event <list|send|reply|ack>`、`ludens-core machine <list|use|connect|disconnect>`、`ludens-core eval <list|run|history|adapt|<capability-id>>`。
4. **`baseware`（`@ludens/baseware`，跨设备驱动与节点层 CLI）** 与 **`ludens-app`（`@ludens/desktop`，All-in-One Electron 桌面端）**。

### 四工况拓扑与接入方式

同一份 `@ludens/client` Vite 静态 SPA（`client/dist`）与 `@ludens/server` JSON-RPC 2.0 服务（`ludens-server`）统一覆盖四种运行工况：

1. **本地 Electron 桌面端（`ludens-app`，`desktop` Profile，零监听 TCP 端口）**：`AppServerHost` 按 `LUDENS_HOME` 执行 `ensureLocalAppDaemon`，复用或拉起单例 `<home>/run/app-server.sock`（路径接近 96 字节 `APP_SERVER_SUN_PATH_LIMIT` 时自动回退至 `/tmp/ludens-app-<uid>-<sha256_12>.sock`）。通过自定义协议 `ludens-app://console/` 加载 `client/dist`（Electron 打包态位于 `Resources/client`）静态资源、`ludens-media://local/media?...` 走 UDS `media/resolve` 返回本地媒体并支持 `206 Range`；渲染层 Preload IPC（`window.ludens.rpc`）与 `PetSessionCoordinator` 共用该 UDS 链路；退出流程由 `ActiveCoreQuitGuard` 保护。
2. **托管 Web / 自托管远端服务（`bun run start:selfhost` 或 `ludens-server serve` / `ludens-server start`，`remote` Profile）**：使用 `--listen ws://HOST:PORT --auth token [--token ... | --token-env ...] [--static-dir client/dist]` 对外提供 WebSocket JSON-RPC `/rpc`、HMAC capability ticket 鉴权的 `/media`（`mt=`、`DEFAULT_MEDIA_TICKET_TTL_MS = 4h`、`206 Range`）、`/health` 以及可选同源静态 SPA（同时支持 `--trusted-origin` 供独立部署的异源 `@ludens/client` 直连）。`remote` Profile 强制启用 Token 鉴权与 `managed-sandbox` 受管沙箱边界；浏览器打开 `#token=...` 后立即通过 `history.replaceState` 擦除 URL 中的凭据。
3. **纯 RPC 客户端 CLI（`ludens`）**：操作者在本地终端或 CI 环境中通过 `ludens` 执行工作区管理（`ludens workspace ...`）、实时干预（`ludens auto / steer / model / stop`）、能力评测（`ludens workspace eval ...`）与日志检视（`ludens logs ...`），在本地 `app-server.sock`（含自动按需唤醒 `ludens-server start`）与 `--remote ws(s)://... [--token ...]` 之间完全同构。
4. **独立发版 Web / 移动端与多目标切换（含 `web-dev` 隔离预览）**：`@ludens/client` 可独立托管于任意静态站点或 CDN，手机或桌面浏览器加载后可在 `<ConnectionTargetDialog>`（或 URL `?server=`）中随时切换 `electron-local`、`same-origin` 与异源 `remote`（`ws://` / `wss://` + Token）目标；根目录联调命令 `bun run dev` / `bun run dev:web` 默认运行于 `web-dev` Profile（`LUDENS_HOME` 自动隔离至 `~/.ludens-dev`，绝不干扰日常 `~/.ludens` 守护进程），也可运行 `bun run dev:client` 零后端直连远端服务。

所有界面均以事件驱动推送（`events/subscribe` + 基于 `1024` 环形缓冲的 `sinceSeq` 增量补齐）与双平面媒体解析（`MediaResolver`，且 `observation` 事件保证在媒体落盘验证后再推送）保持同步。

## 源码目录与六包分层

仓库组织为 6 包 Bun workspace（`["protocol", "baseware", "core", "server", "client", "desktop"]`）：

| 包 / 目录 | 分层与职责 |
| --- | --- |
| `protocol/`（`@ludens/protocol`） | **共享契约层（零运行时依赖）**：JSON-RPC 2.0 协议契约（`app-rpc.ts`）、连接/驱动/机器/事件池 Schema、运行事件类型、Timeline / Archive 格式、跨端查询 DTO 类型（`types.ts`、`replay-types.ts`、`activity-view.ts`、`run-identity.ts`、`initial-selection.ts`、`pet.ts`、`transport.ts` 等）及纯浏览器安全投影函数。 |
| `baseware/`（`@ludens/baseware`） | **L4 跨设备集成层**：CUA 与外部 Bridge/SSH/HTTP/SSE 驱动加载、统一 Controller 目录、`epoch` 控制租约仲裁、有界媒体流缓冲（`ObservationStreamSpool`）、独立设备日志与 `baseware` CLI / MCP。 |
| `core/`（`@ludens/core`） | **L3 单工作区执行内核 / 沙盒**：`core/src/core/shiori/`（Agent 线程核心控制内核）、`core/src/core/agent-omp/`（OMP `18.22.2` 会话组装、扩展与模型 Trace）、`core/src/core/subsystems/`（常驻 Python `perception.py` / `loop.py` Worker、`@capability` 发现、Baseware 会话）、`core/src/core/storage/`（`.ludens/` 与 `logs/<run-id>/` 存储）、`core/python/ludens_tools/`、`core/patches/`、`core/prompts/`、`core/templates/` 以及 `ludens-core` CLI。**零 `@ludens/server` / `@ludens/client` / `@ludens/desktop` 依赖**。 |
| `server/`（`@ludens/server`） | **L2 控制面服务端**：`server/src/server/`（`app-server.ts`、`rpc-router.ts`、`event-hub.ts`、HMAC `media-ticket.ts`、`http-routes.ts`）、`server/src/daemon/`（`app-daemon.ts`、`app-server-paths.ts`、`supervisor.ts`、`launcher.ts`、`process-manager.ts`、`device-arbitration.ts`）、`server/src/query/`（`DashboardWorker`、归档索引与冷构建 Builder、`available-models.ts`、`runtime-control.ts` 等）以及 `ludens-server` CLI。**零 `@ludens/client` / `@ludens/desktop` 依赖**。 |
| `client/`（`@ludens/client`） | **L1 响应式 Web/Mobile SPA 与纯 RPC CLI**：React 19 + Vite 控制台前端（`client/app/`、`client/shell/`、`client/features/`、`client/components/`、`client/lib/`、`client/messages/`，单包构建产出 `client/dist`）以及面向人的纯 RPC CLI `ludens`（`client/cli/`、`client/bin/ludens`）。**严格仅依赖 `@ludens/protocol`**，不承载任何跨包拉起 `server`/`desktop` 的编排逻辑。 |
| `desktop/`（`@ludens/desktop`） | **L1 Electron All-in-One 桌面壳**：Electron 主进程与零端口 UDS 桥接（`desktop/src/main.ts`、`custom-protocols.ts`、`rpc-bridge.ts`、`quit-guard.ts`、`pet-session.ts`、`companion.ts`）、单包外壳构建脚本（`desktop/scripts/build-electron.mjs` 仅产出 `desktop/dist/electron`，不越界编译其他子包）与 `ludens-app` 启动器，打包阶段组装各包 `dist/` 产物并协同本地 `@ludens/server`。 |

### 根目录总控编排与各包自治 `dist/` 构建架构

仓库采用「**根目录总控编排 + 各包自治 `dist/`**」的开发与生产脚本体系：

- **各包标准产物统一为 `dist/`**：每个可构建包独立负责自身单包原子构建，产出各自的自包含产物——`client/dist`（纯静态 SPA，Electron 打包态位于 `Resources/client`）、`server/dist`、`core/dist`、`baseware/dist`、`desktop/dist/electron`。各子包 `package.json` 仅保留纯单包原子脚本（`build` / `typecheck` / `test` 等），`desktop/scripts/build-electron.mjs` 仅编译 Electron 主进程与 preload，不再越界构建 `../server`、`../core`、`../baseware`。
- **根目录开发阶段 4 模式**（由根 `scripts/dev.mjs` 统一编排；除纯前端外默认均将 `LUDENS_HOME` 隔离至 `~/.ludens-dev`，传入 `--real-home` 或使用 `:real` 别名可挂载真实 `~/.ludens`）：
  - `bun run dev` / `bun run dev:web`（`bun run dev:web:real`）：拉起受管回环 `ludens-server --dev` + Vite HMR 开发服务器；
  - `bun run dev:desktop`（`bun run dev:desktop:real`）：构建桌面壳并启动纯 Vite HMR + Electron 原生 UDS 自管本地 `ludens-server`（绝不双起 TCP `ludens-server`）；
  - `bun run dev:client`：纯异源 Vite 前端（零本地后端，直连远程或云端 `ludens-server`）；
  - `bun run dev:server`（`bun run dev:server:real`）：独立前台启动开发态 `ludens-server`。
- **根目录生产阶段产线与全仓质检**：
  - `bun run build`（以及按产线拆分的 `bun run build:client`、`bun run build:server`、`bun run build:sandbox`、`bun run build:desktop`）；
  - `bun run pack:desktop` / `bun run dist:desktop`（依次产出各包 `dist/` 并组装 Electron 本地包或 `.dmg` / `.exe` 安装包）；
  - `bun run start:selfhost`（经根 `scripts/selfhost.mjs` 校验/按需构建 `client/dist`，以生产态启动 `ludens-server serve --static-dir client/dist`）；
  - `bun run typecheck` 与 `bun run test`（一键串行验证全部 6 个包的类型检查与测试套件）。

## 设备与统一能力

1. **统一 Controller 抽象**：Driver 对外暴露的所有能力统称为 **Controller**（包括执行输入的控制器与采集画面/状态的传感器）。每项能力遵循 CUA 原生工具结构：`name`、`description`、`inputSchema`、可选 `outputSchema` / `annotations` 以及 MCP `CallToolResult` 返回值。设计依据见 [Baseware 设计理念与能力契约](baseware.md)，类型定义见 [baseware/src/contracts.ts](../../../baseware/src/contracts.ts) 与 [baseware/src/catalog.ts](../../../baseware/src/catalog.ts)。
2. **双命名空间聚合与按需发现**：Ludens 将设备能力（`controller/<id>`）与工作区 Python 装饰器能力（`python/<path>:<fn>`）合并至 `ludens-core controller` 目录。为避免撑爆模型上下文，所有设备能力与 MCP 工具**均不默认注入 OMP 的模型工具列表**，而是由 Agent 通过 `baseware.json`、`ludens-core controller` 或 `ludens_tools.Client` 按需发现与调用。
3. **纯粹的硬件边界**：Driver 仅忠实映射硬件接口（如双屏独立截图 `screen.top.capture` / `screen.bottom.capture`、原生触屏坐标 `touch.down / move / up`），跨屏图像拼接、坐标转换与具体任务策略一律留在工作区代码中实现。

## 控制权与生命周期

### 1. 多 Core 并发与按需生命周期

Ludens 遵循 **1 Workspace = 1 Core** 隔离原则，由 **`@ludens/server`（`ludens-server`）** 统一监管多个工作区的 Core 进程（`Project.core` / `ProjectCoreSummary`）：

- **按需拉起（On-Demand Spawn）与 0-Run 零门槛**：选择任意工作区（即使尚未产生历史运行记录）即可直接进入运行页（Live），基于 `Project.defaults` 展示预设模型；在运行页发送目标消息或点击 **启动自主运行**（`▶`）时，`ludens-server` 会通过 JSON-RPC（`runtime/control` / `eventPool/mutate`）自动按需拉起对应工作区的 Core（`ludens-core run`）与 Baseware（`spawned: true`），无需预先在终端执行 `ludens workspace up`。
- **Warm Standby 热备驻留**：当主动**收回控制权**（`ludens auto off`）或活动计时器到期时，Core 退出自主运行循环并保持 **Warm Standby**（手动待命，`manual` 态）：Baseware 设备连接与 Shiori OMP 会话持续驻留就绪，仅停止高频采样与录制，支持随时发送新消息秒级续接或切换模型。
- **启动来源与 `ActiveCoreQuitGuard` 退出守卫**：每个活跃 Core 都会记录启动来源 `ServiceLaunchOrigin`（`"app"` 或 `"cli"`）及所属 `appInstanceId`，并在控制台侧边栏「活跃 Core」列表直观标注来源与单点停止按钮（`■`）。关闭桌面主窗口（`×`）仅隐藏至系统托盘与可选桌宠；显式退出桌面 App（`⌘Q` / `before-quit` / 托盘 **Quit**）时，由 `ActiveCoreQuitGuard` 查询 `daemon/status`：若当前无活跃 Core，应用直接退出并保留后台单例守护进程；若存在活跃 Core，则弹出三选一确认框（**后台继续运行 / 停止所有 Core 并退出 / 取消**）。
- **物理设备冲突仲裁（`CONFLICT -32009 DEVICE_BUSY` + `preempt`）**：绑定不同物理设备或不同端口的工作区 Core 完全并发运行、互不干扰。当多个工作区尝试占用同一物理设备或端口时：
  - 若当前持有设备的 Core 处于 **Warm Standby（手动待命，`manual`）**，系统自动让位释放其设备租约并由新工作区接管；
  - 若持有设备的 Core 正在执行活跃**自主运行**循环，`ludens-server` 返回 JSON-RPC 错误 `-32009`（`APP_RPC_ERROR_CODES.CONFLICT`，`data.code: "DEVICE_BUSY"` 与 `DeviceContentionConflict` 载荷），控制台弹出设备冲突提示框，供用户选择取消、切换到持有工作区或执行**抢占接管（`preempt`）**——干净停止原 Core、释放设备租约后立即启动当前工作区。

### 2. 控制租约（`epoch`）与权限校验

- 每次执行 `ludens auto on [--seconds <n>]` 会开启一个新的控制周期，生成唯一 **`epoch`**。持续时间（`seconds`）为可选参数：省略时（`null`）租约与运行时循环不设超时定时器，一直持续运行直到显式执行 `ludens auto off`；传入时由 Baseware 与 Shiori 共同按该周期计时上限执行。
- `ludens auto timer <seconds|off>` 就地更新 Baseware 的 `lease_duration` 与 Shiori 的活动停止计时器，并记录 `control_timer`，不会生成新的 `epoch`。
- Core 通过持久连接向 Baseware 持有该 `epoch`，并将 `BASEWARE_EPOCH` 注入工作区进程环境。
- 查询能力目录与 `--help` 无需控制权；具体能力是否要求控制权由其 `requiresControl` 属性声明（部分只读状态查询同样要求有效 `epoch`）。通过 `ludens-core controller` 调用工作区 `python/...` 能力同样要求处于活跃控制周期。
- 当发生人工收回控制权（`ludens auto off`）、计时器到期、Core 断线或设备断开时，Baseware 立即废止旧 `epoch`、中断在途动作并执行设备释放（清零按键与触点），清理完毕后回到手动待命（`manual`）状态。

### 3. 手柄异步时间表（`pad.play`）

模拟器手柄统一采用相对时间表指令 `pad.play`，参数 `inputs` 为 `{atMs, durationMs, state}` 数组：

```sh
ludens-core controller controller/pad.play --args '{"inputs":[{"atMs":0,"durationMs":500,"state":{"LEFT":1}},{"atMs":0,"durationMs":300,"state":{"B":1}}]}'
```

- **通道合成规则**：不同按键/摇杆通道的时间段允许自由重叠；同一通道的时间段禁止重叠。相邻时间段在边界直接切换合成状态，整张时间表结束时自动归位中立状态。
- **异步生命周期**：`pad.play` 默认提交后立即返回 `actionId`（动作归当前控制 `epoch` 所有，短连接 CLI 退出不会中断已提交动作）；传入 `"wait": true` 或调用 `pad.wait / status / cancel`（传 `{"actionId": "<id>"}`）可等待、查询或取消该动作。同一设备同时只执行一张时间表，并发提交新时间表会返回 `BUSY`。
- **硬件时钟语义**：时间参数单位为毫秒；轮询驱动桥按输入轮询时的单调墙钟推进（最小跨度 16ms），帧驱动桥按模拟帧率向上取整换算为帧数。

### 4. 常驻状态机与输入重置

统一常驻 `perception.py` 状态机在进入自主运行时采用 Core 当前控制 `epoch`，并在每次重载时采用新的 `inputGeneration`。当自动重载轮换 generation 或在 `auto` 周期内执行显式 `ludens-core perception reload` 时，系统通过 Baseware 立即取消并释放本工作区的全部当前输入（包含并发 CLI 输入），递进 `inputGeneration` 拒绝旧实例残余调用，同时保留当前 `epoch`、活动计时器与 OMP 会话。常驻进程从属于该控制周期：连续采样与 fMP4 视频录制只在控制租约活跃期间运行，`Runtime.stop()` 会等待感知租约撤销——停止采样器、刷出最后一条 `perception_stats` 并封口活跃视频分段——之后才记录周期 `control(manual)` 切换事件；在手动待命（`manual`）期间常驻进程保持热备，可继续服务时间线读取但不采样。详见 [core/src/core/shiori/runtime.ts](../../../core/src/core/shiori/runtime.ts)。

## 会话与 Loop

### 1. OMP 超集装配与外层续轮

Core 在单工作区内复用同一个 OMP 会话（持久化于 `.ludens/shiori/sessions/`），并在 `Settings.isolated()` 基础上采用**最小覆盖原则（Superset Shell）**：

- 保留 OMP 原生系统提示词（若工作区存在 `AGENTS.md`，通过原生 `contextFiles` 注入）。
- 显式启用 OMP 原生工具 `read`、`write`、`edit`、`bash`、`wait`，并注册自定义工具 `observe` 与 `event_pool`（同时将 `core/bin` 注入 `bash` 子进程 `PATH`，使 Shiori 在沙盒内直接调用 `ludens-core`）。
- 仅覆盖 Core 契约必需项：关闭 `retry.modelFallback` 并在 `createOmpSession` 中显式开启 `disableModelFallback`、`disableServerSideFallback` 与 `suppressAutoPrewalk`（防止上下文晋升、服务端回退或 `prewalk.auto` 在运行期隐式切走所选多模态模型）、关闭 `title.refreshOnReplan` 与 `cacheWarming`（确保每次模型请求严格归属控制周期）、将 `PROVIDER_IMAGE_BUDGETS` 设为 `Infinity`（在压缩前保留历史图像，避免中途丢图破坏 Prompt Cache 前缀）、经 `tier.openai` 应用实际生效的 OMP 服务档位（`priority` 对应 Fast、`ultrafast` 对应 Ultra、`none` 对应 Standard）并经 `defaultThinkingLevel` 与 `session.setThinkingLevel(..., false)` 权威同步推理强度，以及应用可选的 `compactionThreshold`。详见 [core/src/core/agent-omp/session.ts](../../../core/src/core/agent-omp/session.ts)。
- 仅枚举支持图像的 OMP 模型并严格限制在手动待命（manual）切换：`availableModels`（位于 `@ludens/server` 的查询引擎 `server/src/query/available-models.ts`）读取 OMP `ModelRegistry` 与 `discoverAuthStorage`（按工作区解析或回退至全局 `defaults`），仅返回具备图像输入能力（`input.includes("image")`）的模型并将已配置凭据的 Provider 排在前面，每个模型携带由 OMP `shouldSendServiceTier` 派生的专属 `supportedServiceTiers` 以及由 `model.thinking` 派生的 `supportedEfforts` 与 `defaultEffort`（不使用写死的模型名单，且有意排除 OMP `"auto"` 分类器档位以避免产生控制周期外的隐式请求）。目录与 Shiori 会话均通过 `createOmpModelRegistry`（[models.ts](../../../core/src/core/agent-omp/models.ts)）构建注册表，并额外加载 `openai-codex` 的 `/models` 发现缓存（仅在 OMP 缓存过期时重新拉取）：Codex 按模型在 `service_tiers` 中声明 `ultrafast`，缺少该缓存行时 Ultra 永不出现，已保存的 `ultrafast` 会静默按 Standard 运行。`ModelPickerDialog` 在选中模型卡片内就地展开推理强度（Effort）与响应速度（Speed）内联抽屉，仅提供所选模型实际支持的强度与 Standard/Fast/Ultra 速度档位，再由 `Runtime.setModel`（通过 `ludens model [<provider/id>] [--service-tier none|priority|ultrafast] [--effort none|minimal|low|medium|high|xhigh|max]` 与 `server/src/query/runtime-control.ts` 中的控制台 `set_model` 暴露）原子提交模型与可选的速度、强度；仅在 `mode === "manual"` 且无进行中轮次、记忆整理或在途调用时放行，显式禁止 `auto` 运行期间中途热切换模型；校验通过后以 `{ ...found, imageCountBudget: Infinity }` 及 `setThinkingLevel` 更新 OMP 会话并写入 `shiori` `session` 事件，使 `Runtime.status()` 报告实际生效档位与强度（不支持时降级为 Standard / 模型默认强度）并与实时运行／活动投影即时同步（控制台 `set_model` 在 Core 在线处于 `manual` 态或 Core 离线时均会将 `model`、`serviceTier` 与 `effort` 原子写回 `ludens.json`；Fast/Ultra 为付费加速档位，可能增加用量费用）。

在 `auto` 控制周期内，外层循环按以下步骤运转：

1. **发起轮次**：使用 [continue.md](../../../core/prompts/continue.md) 发起 OMP `prompt`（开启自主运行若带 `auto on --message` 则附加一次性提醒）。
2. **常驻状态机与模型推理并行运转**：模型推理期间环境持续运行——在周期控制租约之下，常驻 `Perception.sample()` 按 Core 配置的频率（`LUDENS_PERCEPTION_SAMPLE_HZ`，默认 `30` Hz）持续采样写入 `.ludens/timeline/`，其进程内能力在同一进程中持续读取时空轴并执行高频闭环控制；取舍见 [为什么感知层参数要分成三层管理](../insights/perception-parameters.md)。
3. **自动上下文交付**：Ludens 扩展挂载 OMP 的 `before_agent_start` 钩子（见 [extension.ts](../../../core/src/core/agent-omp/extension.ts)）。当自动注入开启（默认 `inject on`）时，在每轮 prompt 开始自动追加尚未交付的最新主通道感知记录以及采样器状态变迁（`state / codeSHA / error`）；工具结果不再被追加任何观察，`tool_result` 钩子只登记原生工具图片的交付事实，轮内需要画面由模型显式调用 `observe` 组合。曾在工具批次末追加最新帧的通道已于 2026-10-29 删除，取舍见 [注入收敛为轮首单通道](../insights/omp-injection.md)。
4. **续轮或收回控制权**：单次 `prompt` 结束且控制周期仍活跃时自动发起下一轮；一旦人工收回控制权或计时器到期，`addBeforeModelCall` 门禁立即阻断新模型请求，释放设备控制权。

### 2. 上下文压缩与传输恢复

- **后台预测压缩**：复用 OMP 原生两段式压缩，触发阈值默认跟随模型目录（可通过 `ludens.json` 或 `--compaction-threshold` 覆盖）。针对 30Hz 实时控制循环的补丁改造见 [OMP 后台压缩改造](../insights/omp-compaction.md)。
- **WebSocket 增量传输与恢复**：OpenAI Codex 默认使用 WebSocket `auto` 模式，断连分类、冷却退避与未完成工具调用的 SSE 恢复策略见 [WS 恢复测试依据](../insights/ws-recovery.md)。

## 工作区事件池

人类与 Shiori 通过双向、工作区作用域的**事件池（Event Pool）**异步交换消息与请求：事件在智能体周期之外也能留存，且从不与设备租约绑定。

- **存储与并发**：`.ludens/event-pool.json` 是带单调 `seq` 的版本化文档。每次读-改-写都会获取跨进程锁目录（`event-pool.json.lock`，获取上限 5 秒、15 秒后回收陈旧锁），并通过临时文件 + `rename` 原子发布，因此 CLI、Core、Query Worker 与客户端 UI 都不会读到半写文件。待处理事件永不裁剪；仅保留最近 200 条已处理事件。
- **契约**：方向为 `inbound`（`message`、`reply`）与 `outbound`（`help_request`、`notice`）；状态为 `pending` / `handled`；执行者为 `shiori` / `human`。每条事件携带 `id`、`seq`、`text`、可选 `title`、`replyTo`、`pauseRequested`、`runId` / `epoch`，以及 `createdAt` / `handledAt` / `handledBy`。人类回复一条待处理的出站事件时，会在同一次加锁写入中把该请求标记为已处理（`handledBy: "human"`）。
- **CLI**：`ludens-core event list [--direction inbound|outbound] [--status pending|handled] [--limit <n>]`、`ludens-core event send [--title <text>] [--message <text> | <text>]`、`ludens-core event reply <event-id> [...]`、`ludens-core event ack <event-id>...`。Core 在线时命令经 Core Socket 路由，否则直接写入 `.ludens/event-pool.json`，因此在 `manual` 待机或 Core 已停止时留下的消息会在下一个周期被拾取。变更类命令仅限人类：在智能体周期内（存在 `BASEWARE_EPOCH`）会被拒绝，并引导智能体改用 `event_pool` 工具。
- **Shiori 工具**：`event_pool({ action: "read" | "ack" | "emit" })`。`read` 返回待处理的入站消息/回复（全部或指定 `ids`；`includeHandled` 可读历史），默认将其标记已读，`ack: false` 则在忙碌时暂缓；`ack` 显式将入站事件标记为已处理；`emit` 发布出站 `help_request`（默认）或 `notice`。`pause` 默认为 `false`，保持自主循环异步进行；只有 `pause: true`——仅用于彻底受阻的智能体——会以 `awaiting human` 停止自主运行并撤销设备控制权、回到手动待命，直到人类恢复。
- **轮首摘要**：`before_agent_start` 仅在 `pendingInbound > 0` 时追加紧凑的入站摘要：每条包含 `id`、`seq`、`kind`、可选 `title` 与 72 字符单行预览。事件池空闲时不追加任何字节，从而保留 provider 前缀 KV 缓存；完整正文通过 `event_pool({ action: "read" })` 按需拉取。
- **界面**：控制台前端（`@ludens/client`）通过 `ludens-server` 的 `eventPool/read` 与 `eventPool/mutate` JSON-RPC 方法读写同一存储，并通过 `events/subscribe` 订阅 `eventPool` 实时推送，驱动出站托盘、会话流卡片、标题栏待处理徽章与回复输入框；多工作区的待处理出站数量（`pendingOutbound`）同步汇总至侧栏「活跃 Core」列表并驱动可选桌宠 `!auto` 的 `🆘` 优先跳转。CLI 与控制台是对同一加锁文件的对等写入方。
- **双时序投影与全览**：每个生命周期投影为两条流消息。消息 1（人工消息或 `outbound_event` 卡片）严格锚定在 `createdAt`（`T_send` / `T_emit`），绝不追加到流尾。消息 2（`pool_receipt`）由 `pool_event` 的 `action: "handled"` 投影而来，锚定在 `handledAt`（`T_read`）。人工可通过 `ack` 与 `actor: "human"` 撤回未读的待处理入站消息，显示为已撤回而非已读取。Live 工作台右侧检查器坞在 `Stage & Telemetry` 与 `Event Pool` 分段头之间切换；专用的事件池全览列出留存事件，线程头快捷入口可打开它，每条事件的定位到会话流操作会跳转到其流内位置。

紧急的轮内打断仍然使用 `ludens steer <message>`，它直接排队进入正在运行的智能体，而不进入事件池。

## 可核查的运行事实

- **多源事实解耦**：Baseware 独立持久化设备控制与执行事实（`logs/baseware/`），Core 记录模型调用、工具执行、能力调用与感知交付（`logs/<run-id>/`），Shiori 挂载局部 OpenTelemetry provider 记录 `agentLoop` 遥测。
- **控制台隔离读取**：**`@ludens/server`（`ludens-server`）** 将归档解析与索引维护放在独立的 Worker 线程（`server/src/query/`）中，冷历史目录由限流为全局单实例的临时 Builder 子进程构建并原子发布至 `.dashboard-index/`；`server/src/server/rpc-router.ts` 中的 JSON-RPC 处理器与 `PetSessionCoordinator`（`activity/get`、`events/subscribe`）仅通过有界 RPC 读取投影结果，完全移除 `/api/*` REST 路由且不运行任何 Next.js 服务端进程。详见 [日志与调用链](logging.md#消费与指标解释)。

## TypeScript 与 Python

Ludens 由 TypeScript 六包架构（`protocol/`、`baseware/`、`core/`、`server/`、`client/`、`desktop/`）与 Python 工具包（`core/python/ludens_tools/`）共同组成：

- **TypeScript 侧**：`@ludens/protocol` 定义零依赖契约与跨端投影；`@ludens/baseware` 负责跨设备驱动与租约仲裁；`@ludens/core` 负责 Shiori 运行时、OMP 会话扩展与单工作区沙盒（`ludens-core`）；`@ludens/server` 负责多工作区 JSON-RPC 控制面、`EventHub` 推送、HMAC `/media`、查询引擎与 `WorkspaceSupervisor`（`ludens-server`）；`@ludens/client` 提供纯 `@ludens/protocol` 依赖的响应式 Web/Mobile SPA 与纯 RPC 操作者 CLI（`ludens`）；`@ludens/desktop` 提供零端口 Electron 桌面宿主与桌宠（`ludens-app`）。
- **Python 侧**：负责 `@capability` 静态发现与动态执行、统一常驻 `Perception` 状态机、可编程 `Loop` 外层循环、PyAV 视频段编码与冷帧按需解码。常驻感知通过媒体流引用（`_StreamMediaRef`）直接从磁盘摄取 Baseware 缓冲的原始字节，省去跨进程内联 Base64 往返，自动将设备观测 `sources` 时空溯源绑定至时间线记录，并通过 `ifNoneMatchSequence` 对未发生帧变化的最新帧 `Client().observe()` 轮询执行零编码短路。视频编解码直接在常驻感知进程内完成，不额外引入独立的流媒体服务。

## 能力持久化边界

全局 `LUDENS_HOME`（默认 `~/.ludens`）保存应用配置、`registry/<id>.json` 工作区索引、驱动缓存与共享桌宠状态。注册项只包含 `{id, workspace, name, updatedAt}`；工作区的 `.ludens/workspace.json` 持有稳定身份，目录移动后通过 `ludens workspace open` 更新索引。会话和历史均保存在工作区，registry 可重建。详见 [两层目录结构](../tutorials/workspace.md)。

登记创建、移动、移除与桌宠目标选择共用按工作区划分的锁。同时需要两把锁时，先获取登记锁，再获取桌宠目标锁。移除先读取当前登记，仅清除与之匹配的原始桌宠目标，再删除登记文件；目标不可读或不可写时，在删除前阻止移除。重新登记不会恢复已清除的目标。其他目标、消费者心跳文件、工作区内容及运行中的 Core 均不受影响。普通桌宠状态轮询保持只读，只有已存目标发生目录移动时才加锁重新读取并更新。控制台操作结果直接报告已提交配置或实际移除的登记，不依赖后续目录或消费者状态读取。

默认情况下，可选**桌宠**采用 **`!auto`（`PET_AUTO_TARGET`）多 Core 自动追踪模式**（`targetConfigured === false` 且 `autoFollowing: true`）：只要存在活跃 Core，桌面端按优先级自动跟随——优先任意存在待处理 `🆘` 出站协助请求（`pendingOutbound > 0`）的在线 Core → 其次当前聚焦工作区的在线 Core → 其次后台处于**自主运行**态（或唯一活跃）的 Core；全部 Core 停机时优雅进入空闲待命（`autoWaiting`）。用户仍可手动固定单个工作区或显式选择**停止跟随**（`null`）。桌宠通过 UDS RPC 调用 `pet/setTarget` 与 `pet/recordConsumer` 分别返回已提交的 `{ target }` 和 `{ consumer }`，观测图像通过 `ludens-media://local/media?...` 加载。`pet/getState` 在心跳记录不可读时仍保留已保存目标（`connected: null` 并附 `consumerError`），不会声称桌面端未连接。登记目录离线、缺失或身份不符时，仍保留已保存目标并标注 `targetUnavailable: true`；桌面端暂时停止消费该来源，不清除选择。心跳的 `targetRevision` 表示正在尝试的目标，`revision` 表示已加载的来源。只有尝试目标匹配时才归属应用错误，正在跟随则必须有匹配的已加载 revision。`pet/getState` 读取会等待该 worker 已接收的目标写入结束，避免恢复读取先报告旧选择，排队中的写入随后才完成。`targetConfigured` 区分尚未设置目标文件（默认进入 `!auto` 自动追踪）与显式保存停止（`null`）；只有后者会阻止启动时的自动选择。

工作区内的状态存储各司其职，互不冗余复制：

| 存储位置 | 归属与内容 |
| --- | --- |
| `.ludens/timeline/` | **能力观测与媒体唯一原件**：由常驻感知进程单一写入者维护，存放 `@record` 记录元数据、分段 fMP4 视频（`video/`，默认 5 分钟一段、空闲 10 秒收尾）与 SHA-256 去重非视频媒体（`objects/`）。 |
| `.ludens/archive/` | **模型与工具结构化文本归档**：跨请求、跨 run 按内容哈希去重存储 `objects/<sha256>.json.gz` 与流式载荷，内含媒体一律通过引用指向 `.ludens/timeline/`。 |
| `logs/<run-id>/` | **单 Core 运行事件流**：存放 `manifest.json`、`events.jsonl` 与 `streams/`，通过 `eventSources` 与内容引用关联 Baseware、Archive 与 Timeline。 |
| `.ludens/shiori/` | **OMP 原生会话存储**：存放 `sessions/*.jsonl` 与当前续接指针，由 OMP SessionManager 管理。 |
| `.ludens/event-pool.json` | **双向人机事件池**：跨运行与离线待机持久化待处理与近期已处理的入站消息／回复及出站求助／通知。 |
| `.ludens/skill-versions/` | **技能与记忆快照**：运行中记录的内容版本留在工作区内，随目录一起移动。 |

## 统一时空轴与回放

感知采样、常驻动作、模型推理与设备执行共享工作区的绝对墙钟时间坐标，并通过 `recordId`、事件序号、`modelCallId`、`toolCallId`、`actionId` 及 `trace` 树精确关联。控制台回放器在同一时间游标下同步渲染 `.ludens/timeline/` 中的全量连续采样画面（包含未被模型采纳的中间帧）、动作时间跨度与模型调用详情；历史回放纯属只读投影，不会触发设备操作或改变桌宠的实时跟随目标。
