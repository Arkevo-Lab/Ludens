# 六包四层正交架构重构计划（Six-Package Architecture Refactoring）

## 1. 背景与目标

当前仓库处于开发态（无向下兼容包袱），原有的四包结构（`protocol`、`baseware`、`core`、`app`）在职责与依赖边界上存在以下耦合：
- `core/` 同时包含了单工作区执行沙盒（Shiori OMP、`perception.py`、`loop.py`、`eval`）、跨工作区控制面服务端（App-Server JSON-RPC、`EventHub`、`/media`、Query/冷索引、`Supervisor`/Daemon 守护）以及面向人的遥控 CLI（`ludens`）。
- `app/` 同时混杂了纯前端 Web/Mobile SPA 视图与 Electron 桌面壳（主进程、托盘、进程嵌合与 Pet 窗口），且前端直接引用了 `@ludens/core/core/query/*`。

本次重构一步到位拆分为 **4 层角色 × 6 个物理 Workspace 包**，并彻底厘清 **4 个可执行 CLI 入口 + 桌面发行包** 的正交职责边界：

1. **共享契约层 — `@ludens/protocol` (`protocol/`)**
   - 零 Node/Bun/OMP 运行时依赖的共享契约、强类型 `app-rpc`、跨端 DTO 类型与纯浏览器安全投影函数。
   - 补齐 `capabilities/evalHistory`、`capabilities/evalAdapt`、`workspaces/import`、`logs/inspect` 等 RPC 方法契约，支撑 `ludens` CLI 100% 纯 RPC 化。
2. **L4 跨设备集成层 — `@ludens/baseware` (`baseware/`, bin: `baseware`)**
   - 独立硬件/模拟器/桌面驱动、Controller 契约、`epoch` 租约仲裁与 MCP Server。
3. **L3 单工作区执行内核 / 沙盒 — `@ludens/core` (`core/`, bin: `ludens-core`)**
   - `1 Workspace = 1 Core`，承载 Shiori（OMP `18.22.2`）+ `perception.py` + `loop.py` + 工作区代码与 `eval` 自验证。
   - **零 `@ludens/server`、`@ludens/client`、`@ludens/desktop` 依赖**。
   - CLI `ludens-core` 仅保留沙盒运行入口 `ludens-core run` 与沙盒内工具命令 `ludens-core <controller|perception|event|machine|eval>`（移除顶层重复的 `observe` 别名，统一使用 `perception observe`）。
4. **L2 控制面服务端 — `@ludens/server` (`server/`, bin: `ludens-server`)**
   - 开源可本地、自托管或云端部署，统一提供 JSON-RPC 2.0（含 `capabilities/eval*`、`workspaces/import`、`logs/*`）、`EventHub`、HMAC `/media`、Query/冷索引及 Core 运行环境调度（`Supervisor` / `Launcher`）。
   - **零 `@ludens/client`、`@ludens/desktop` 依赖**。
   - CLI `ludens-server` 提供 `<serve|start|stop|restart|status>`。
5. **L1 客户端（Web / 手机端 SPA + 纯 RPC CLI）— `@ludens/client` (`client/`, bin: `ludens`)**
   - 响应式 Web/Mobile Vite SPA + 面向人的纯 RPC CLI `ludens`。
   - **严格只依赖 `@ludens/protocol`（零 `@ludens/core`、`@ludens/server`、`@ludens/baseware`、`electron` 依赖）**，支持独立线上发版与异源连接（First-class Cross-Origin，`?server=` / `--remote` / `--token`）。
   - CLI `ludens` 提供：`ludens config ...`、`ludens workspace <init|list|open|forget|import|up|down|services|eval>`、顶层高频遥控 `ludens <status|auto|steer|consolidate|stop|model|logs>`（本地未起服务时自动从 `PATH` 按需唤醒 `ludens-server start`）。
6. **L1 All-in-One 桌面发行壳 — `@ludens/desktop` (`desktop/`, bin: `ludens-app`)**
   - Electron 桌面发行包，自包含组装 `client/out` + 本地 `@ludens/server`（UDS 零端口）+ `@ludens/core` + `@ludens/baseware` + 系统托盘 + `ActiveCoreQuitGuard` + Companion Pet，并支持一键切连远程 `ludens-server`。

## 2. 并发分工与文件所有权边界

- **`@arch-ui`（Gemini 4 Carbon）**：
  - 阶段一：交付 `protocol/**` 强类型 DTO 与新 RPC 契约并解锁下游。
  - 阶段二：合入 `@pkg-core-server` 与 `@pkg-client-desktop`，更新根 `package.json` workspaces 为 `["protocol", "baseware", "core", "server", "client", "desktop"]`，打磨连接目标切换 UI 与移动端响应式体验，完成真实浏览器验收。
- **`@pkg-core-server`（Gemini 4 Neon）**：
  - 拆分并交付 `core/**`（`ludens-core`）与 `server/**`（`ludens-server`），实现新增 RPC handler 与 PATH 注入。
- **`@pkg-client-desktop`（Gemini 4 Neon）**：
  - 移除旧 `app/**`，拆分并交付 `client/**`（纯 `@ludens/protocol` 依赖的 SPA + 纯 RPC `ludens` CLI）与 `desktop/**`（Electron 桌面壳）。
- **`@docs-lite`（Gemini 4 Hydrogen）**：
  - 更新 `MODELS.md`（四元素分池画像）与根 `README.md`、`README.zh.md`。
- **`@verifier-lead`（Gemini 4 Argon）**：
  - 维护 `PLANS.md`、`plans/index.md`、`plans/six-package-architecture.md`。
  - 全面重写/同步 `docs/zh/**` 与 `docs/en/**` 全部 21 对双语长文档（重点重构 `reference/architecture.md`、`reference/cli.md` 及所有涉及包路径与 CLI 命令的教程/概念/洞察文档）。
  - 汇总合入全部分支，执行硬性依赖边界校验、全仓 6 包测试矩阵验证、调度 `openai-codex/gpt-6.2-astra` 只读挑刺终审，清理已完工 plan 并创建 PR。

## 3. 验收标准

1. **物理包与依赖隔离**：
   - `app/` 旧目录彻底删除；
   - `client/` 零 `@ludens/core`、`@ludens/server`、`@ludens/baseware`、`electron` 依赖；
   - `core/` 零 `@ludens/server`、`@ludens/client`、`@ludens/desktop` 依赖；
   - `server/` 零 `@ludens/client`、`@ludens/desktop` 依赖。
2. **全仓 6 包测试矩阵 100% 通过**：
   - `protocol`、`baseware`、`core`（TS + Python `mypy` & 86 单测 + `omp:test:transport` + `ws-recovery` + `omp-speculation` + `omp-model-stickiness`）、`server`、`client`、`desktop` 全部构建与测试全绿。
3. **文档与双语对称**：
   - `README.md` / `README.zh.md`、各包 `README.md`、`docs/{zh,en}/**` 21 对文档 1:1 对称，无旧包名/旧 CLI 残留，无失效相对链接。
4. **Astra 终审与真机验收**：
   - `openai-codex/gpt-6.2-astra` 只读挑刺审计零真实缺陷（PASS），浏览器验收通过。
