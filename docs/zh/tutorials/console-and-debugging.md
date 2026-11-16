# 控制台使用与排障

Ludens 在零端口桌面应用（走 UDS `app-server.sock`）、托管 Web / 远端 `ludens app-server --listen ws://...`、Vite HMR 开发模式（`npm run dev`，默认 `http://127.0.0.1:3015`）以及移动端多目标切换（`<ConnectionTargetDialog>`）之间共享同一份 Vite SPA（`app/out`）与 `@ludens/protocol/app-rpc` JSON-RPC 2.0 **控制台（Console）**，并与结构化事件日志、30 Hz fMP4 归档及终端诊断命令共享同一套数据底座。本教程涵盖控制台全视图操作、回放取证、控制周期卡顿与能力验证失败排查、守护进程健康检查，以及提交问题前的针对性验证命令。

## 1. 控制台视图速查

### 工作区视图（Workspace）

| 侧栏菜单 | URL 参数 | 核心操作 |
| --- | --- | --- |
| **运行（Live）** | `?view=live` | 零门槛直接进入任意工作区（含 0-Run）并在点击 **启动自主运行** 时按需拉起 Core + Baseware，在侧边栏「**活跃 Core**」管理全部并发工作区（展示 `App` / `CLI` 来源、`🆘` 数量与单点停止 `■`），通过 **设备冲突弹窗**（`CONFLICT -32009 DEVICE_BUSY`）切换或抢占接管，点击 **收回控制权**，切换多节点实时画面（`[machineId]`），通过 **事件池** 发送异步留言、处理智能体发出的协助请求与通知（**回复** / **回复并继续** / **标记已处理**），用 **即时插话（Steer Now）** 紧急纠偏，点击 **整理 skills/ 与 memory/ 笔记**，并查看 **画面与遥测** 及实时事件流（`events/subscribe`） |
| **回放（Replay）** | `?view=replay` | 拖拽受限 30 秒 fMP4 视频窗（上限 60 秒）与 15 分钟事件窗，使用 **跳转时间** 精确定位毫秒时刻，在 **事件流** 按 **全部轨道** 筛选，并点击 **节点详情** 核对真实送入模型的截图、工具调用与 `observation_context` 回执 |
| **性能（Performance）** | `?view=perf` | 观测 **性能概览**（已完成轮次、P95 与中位轮次延迟、Prompt 缓存命中率、解码速率、占空比、采样速率、自主运行占比），并在 **请求与调用链回溯** 中排查单次请求耗时与压缩时间线 |
| **能力（Capabilities）** | `?view=caps` | 浏览 **Capability – Eval – Env** 三元拓扑，按状态（`verified`、`adapting`、`stale`、`failed`、`unverified`、`missing`）过滤，核对 **工作区来源**（`baseware.json` 与静态 Python `@capability`）、**Core 连接检查** 与 **社区驱动验证**，并一键运行全部或单项评测 |
| **配置（Config）** | `?view=perception` | 通过 6 个页签管理工作区配置：**模型与预算**、**目标设备**、**连接与多模态传输**、**感知录制参数**（`hotSeconds`、`videoSegmentSeconds`、`videoIdleSeconds`）、**后台服务与会话**（含一键 **启动工作区 / 热重载 Core / 停止**、`emulator`/`baseware`/`core`/`app-daemon`/`pet` 后台进程状态行、**工作区长期记忆（`MEMORY.md`）** 与 Shiori 会话摘要），以及 **上下文容量推演** |

### 全局与工具视图

| 侧栏菜单 | URL 参数 | 核心操作 |
| --- | --- | --- |
| **工作区（Workspaces）** | `?view=workspaces` | 浏览、创建、导入和切换工作区（支持快捷键 `Cmd/Ctrl+K` 快速切换、`Cmd/Ctrl+B` 收放侧栏、`Cmd/Ctrl+[` 与 `Cmd/Ctrl+]` 前进后退） |
| **设备（Devices）** | `?view=baseware` | **设备与节点 · Baseware**：管理 **受控设备**（`~/.ludens/machines.json` 与 `workspace-default`）和 **驱动包**（`~/.ludens/drivers.json`），探测 **节点检视与控制器**，并在 **守护进程与租约** 吊销异常占用的租约 |
| **文档（Docs）** | `?view=docs` | 在控制台内离线阅读中英双语同步文档 |
| **设置（Settings）** | `?view=settings` | 配置全局 **常规**、**新建默认参数**、**模型与传输** 以及可选 **桌宠** 显示与 `!auto` 多 Core 自动跟随策略（并通过 `<ConnectionTargetDialog>` 切换 `electron-local`、`same-origin` 与 `remote` 连接目标） |
| **开发者（Developer）** | `?view=dev` | **Loop 实验室**：在不同预设下推演多轮上下文增长曲线、帧 Token 占比与压缩阈值 |

## 2. 在回放（`?view=replay`）中核查时间线证据

当智能体错过关键瞬间或触发了不符合预期的动作时，先在 **回放（Replay）**（`?view=replay`）复核事实，再动手改代码：

1. **锚定异常时刻**：在 **事件流** 中切换或展开 **全部轨道**，拿到 `logs/<run-id>/events.jsonl` 或运行日志里的精确时间戳后使用 **跳转时间**。
2. **对齐录像与采样节点**：拖动 30 Hz fMP4 时间轴，核实 `Perception.sample()` 是在状态变化之前还是之后完成采帧。
3. **验证模型真实输入**：点击任意模型请求节点的 **节点详情**，直接查看当时真正送达模型的 `observation_context` 截图、文本与工具返回，不要仅靠外部副作用时间戳猜测模型“看到过什么”。

如果某种边界故障难以稳定复现，建议立刻配合 `ludens eval adapt` 将该时刻记录锁定为离线评测反例。

## 3. 排查控制周期停滞与能力验证失败

### 场景 A：控制周期卡顿或需要立即停止设备动作

1. **第一时间回收控制权**：在控制台 **运行（Live）** 点击 **收回控制权**，或执行 `ludens auto off`。若 Baseware 底层仍持锁，可执行 `baseware revoke`（或在 **设备** -> **守护进程与租约** 手动吊销）。
2. **检查 Core 与服务健康状态**：在工作区目录下依次查看各层状态：

```sh
ludens daemon status
ludens status
ludens services
ludens perception status
ludens perception state
baseware status
```

3. **排查阻塞或异常退出的 `perception.py`**：若 `perception.state` 显示 `error` 或长期停在 `loading`，检查 `logs/<run-id>/perception/<gen>/` 下的 stderr 输出（或在 **配置** 页查看状态），修复代码后执行 `ludens perception reload`（或点击 **配置 -> 后台服务与会话** 的 **热重载 Core**）。
4. **恢复断连节点**：打开 **设备**（`?view=baseware`）-> **守护进程与租约** 检查状态，或终端执行 `ludens machine list` 与 `baseware reconnect [--machine <id>]`。
5. **在不关闭外部目标窗口的前提下干净重启**：

```sh
ludens down --keep-emulator
ludens up
```

### 场景 B：能力发现报错或 `ludens eval` 失败

- **能力未出现在 `ludens controller list` 或能力页报错**：检查对应 `@capability` 是否满足同步 `def`、非空 Docstring、受支持的参数注解（`str`、`int`、`float`、`bool`、`list[T]`、`dict[str, T]`、`Optional[T]` / `T | None`）、JSON 字面量默认值，且没有使用 `*args`、`**kwargs` 或不受支持的第三方装饰器。
- **状态停留在 `stale` 或 `adapting`**：执行 `ludens eval list` 与 `ludens eval run <eval-id>` 查看精确异常栈与源码哈希差异。若是通过 `ludens eval adapt` 标记的 `adapting`，请先在 `@eval_env` 中复现该反例（确认旧能力评测失败），再改进能力实现直至 `ludens eval run <eval-id>` 重新通过为 `verified`。

## 4. 开启完整诊断日志、CLI 检视与前台隔离调试

若偶发故障在 `normal` 摘要模式下缺少嵌套调用细节，可将诊断模式切换为 `full`（写入 `logs/<run-id>/diagnostics.jsonl` 与 `logs/baseware/`）：

```sh
ludens run --device-only --diagnostics full
```

其中 `--device-only` 会建立设备连接并拉起 `perception.py` 采样，同时**不**触发任何 LLM 请求，非常适合单独验收摄像头流、控制租约与状态机初始化。

如需彻底脱离工作区单独调试某个 Baseware 驱动与传输通道：

```sh
baseware serve --driver cua --machine-id local-desktop --diagnostics full
```

在终端直接检视归档事件或大字段对象：

```sh
ludens logs events --run logs/<run-id> --diagnostics
ludens logs read --run logs/<run-id> --event <seq> --field <name> --full
```

完整事件结构与参数说明见 [日志参考](../reference/logging.md) 与 [CLI 参考](../reference/cli.md)。

## 5. 运行针对性验证检查

修改或排查底层模块后，按受影响子包运行对应的类型检查与测试套件，在确认故障边界后再汇总报告：

```sh
# 协议 Schema 与契约检查
(cd protocol && bun run typecheck && bun test)

# Baseware 驱动、传输与控制租约
(cd baseware && bun run typecheck && bun test)

# Core 运行时、Python SDK 与传输层
(cd core && bun run typecheck && bun run typescript:test && bun run python:test)

# 控制台静态构建、Web 与桌面端测试
(cd app && npm run build && npm run build:check && npm run typecheck && npm run desktop:typecheck && npm test && npm run desktop:test)
```

按需运行的可选专项验证：

- `(cd core && bun run python:typecheck)` 与 `(cd core && bun run omp:test:transport)`：Python 类型检查与模型传输专项测试
- `(cd app && npm run perf)`：大容量归档查询性能与内存基线检查
- `(cd app && npm run pet:smoke)`：可选托盘**桌宠**小组件冒烟检查

反馈问题时，请一并附上失败命令的完整输出、`logs/<run-id>/manifest.json` 以及相关的 **回放** 时间戳或 `record-id`。
