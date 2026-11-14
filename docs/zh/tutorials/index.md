# 动手教程

Ludens 是面向复杂端到端任务的多模态、跨设备 Harness，适用于具身与机器人控制、安防监控、桌面与软件工作流以及实时交互与游戏等场景。本组五篇教程将带你完成从环境安装、首次运行到跨机器设备接入、能力自检闭环、常驻感知状态机编写，以及控制台运维与排障的完整实践。

如果你希望在动手之前先理解核心设计——包括 **Shiori**（Ludens 的 Agent 线程核心）、**Baseware**（跨设备集成层）以及感知-执行主循环，建议先阅读 [概念总览](../concepts/overview.md)。

## 推荐学习路径

| 步骤 | 教程 | 完成目标 |
| --- | --- | --- |
| 1 | [快速开始](quickstart.md) | 安装依赖，通过零端口桌面应用、托管 Web / 远端 SPA、统一 CLI（`ludens daemon` / `--remote`）或移动端多目标切换启动与接入 Ludens，启动 **自主运行**、通过事件池协作并随时 **收回控制权** |
| 2 | [设备接入与 Baseware](devices.md) | 配置内置 CUA 桌面自动化与外部驱动包（覆盖 `stdio`、`bridge`、`ssh`、`http`、`sse`），并在多节点间路由控制器工具 |
| 3 | [工作区、能力与自验证](workspace.md) | 组织 `ludens.json`、`MEMORY.md`、`skills/` 与 `perception.py`；编写 `@capability`、`@eval_env` 与 `@eval_capability`；运行 `ludens eval` 并在 **能力（Capabilities）** 视图中核验 |
| 4 | [感知、执行与性能调优](perception-and-action.md) | 编写并热重载常驻 `perception.py` 状态机，使用 `Client.observe()` 查询 30 Hz fMP4 归档，配置多模态传输与图片 URL 外置，并调优端到端延迟 |
| 5 | [控制台使用与排障](console-and-debugging.md) | 掌握 **控制台（Console）** 各视图操作，在 **回放（Replay）** 中检视时间线证据，定位控制周期停滞与能力验证失败，排查守护进程与套接字状态，并运行针对性验证检查 |

## 延伸阅读

- **概念文档**：[概念总览](../concepts/overview.md)、[循环与控制](../concepts/loop-and-control.md)、[自验证闭环](../concepts/self-verification.md)
- **参考手册**：[CLI 参考](../reference/cli.md)、[系统架构](../reference/architecture.md)、[Baseware 跨设备集成层](../reference/baseware.md)、[驱动桥接协议](../reference/driver-bridge-protocol.md)、[日志系统](../reference/logging.md)
- **技术洞察**：[技术洞察索引](../insights/index.md)
