# 核心概念

Ludens 是面向复杂端到端任务的多模态、跨设备 Agent Harness，适用于机器人操控、安防巡检、桌面与软件自动化以及实时游戏等场景。Ludens 不把模型限制在静态提示词和脆弱的逐轮点击包装里，而是将真实硬件与软件目标接入一个可持续演化的代码工作区，让视觉感知、闭环控制与离线验证协同迭代。

## 阅读路线

| 主题 | 核心内容 | 文档 |
| --- | --- | --- |
| **系统概览** | 为什么需要代码优先的 Harness，以及 **Baseware**、**工作区**、**Shiori** 与**控制台**四层如何分工协作 | [什么是 Ludens 与四层分工](overview.md) |
| **循环与控制** | Observe → Reason → Act & Eval → Consolidate 闭环、**自主运行**与**手动待命**、**收回控制权**、单调 `epoch` 租约、预算以及双向**事件池**与 `steer` | [自主循环、控制租约与异步协作](loop-and-control.md) |
| **感知与自验证** | 30 Hz 常驻感知状态机、**Capability – Eval – Env** 三元闭环、`ludens eval` 门禁、`adapt` 失败帧反馈以及技能与记忆沉淀 | [编码即感知与能力自验证体系](self-verification.md) |

## 核心术语速览

| 术语 | 在系统中的职责 |
| --- | --- |
| **Ludens** | 既是整套跨设备多模态 Agent Harness，也是它的同名吉祥物人格。 |
| **Baseware** | 跨设备集成层，统一屏蔽异构驱动、多节点传输协议（`stdio`、`bridge`、`ssh`、`http`、`sse`）与 `epoch` 控制权租约。 |
| **工作区（Workspace）** | 由智能体与人工操作者共同演化的持久化代码目录（含 `perception.py`、`@capability` 模块、`skills/`、`memory/` 与 `.ludens/timeline/`）。 |
| **Shiori** | Ludens 的 **Agent 线程核心**，专责控制周期调度、时间/请求预算管控、上下文注入与安全释放设备。 |
| **控制台（Console）** | 统一的 React 19 + Vite 静态 SPA 可观测与操控平面（支持零端口 UDS 桌面应用、托管 Web / 远端 `wss://` `/rpc` 与移动端多目标切换），涵盖运行、回放、性能、能力、配置、设备、工作区、文档、设置与开发者视图。 |

## 下一步

- **动手实践**：按[教程概览](../tutorials/index.md)或直接进入[快速开始](../tutorials/quickstart.md)安装组件、初始化工作区并接入设备。
- **架构与协议契约**：阅读[系统架构与边界](../reference/architecture.md)及[CLI 命令参考](../reference/cli.md)，查看精确的模块职责与命令行接口。
- **工程权衡复盘**：查阅[架构洞察](../insights/index.md)，了解上下文压缩、WebSocket 增量恢复、轮首注入与感知参数分层的深度分析。
