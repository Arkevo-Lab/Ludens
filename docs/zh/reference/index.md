# Reference · 组件与契约

本目录定义 Ludens 的系统架构、CLI 命令规范、进程职责边界、跨设备控制协议与运行日志归档格式。所有契约均以仓库源码实现为唯一基准。

## 架构分层与参考地图

| 层级 | 核心关注点 | 规范文档 | 权威源码位置 |
| --- | --- | --- | --- |
| **系统拓扑与控制循环** | 五组件边界、Shiori Agent 线程核心、OMP 会话装配、控制周期 `epoch`、事件池与跨进程存储归属 | [架构与边界](architecture.md) | `core/src/core/shiori/runtime.ts` · `core/src/core/agent-omp/session.ts` |
| **CLI 与环境变量** | `ludens`、`baseware` 与 `ludens-app` 全部子命令、参数选项、默认值与宿主/感知环境变量 | [CLI 命令参考](cli.md) | `core/src/cli/main.ts` · `baseware/src/cli.ts` · `app/desktop/main.ts` |
| **跨设备集成与能力目录** | CUA 原生工具结构、`ExecutionResult` 信封、`requiresControl` 仲裁、外部驱动包发现与多节点池化 | [Baseware 设计理念与能力契约](baseware.md) | `baseware/src/contracts.ts` · `baseware/src/catalog.ts` |
| **Bridge 底层通信** | TCP 单客户端行协议、`HELLO / OWN / APPLY / CAPTURE / TOUCH` 指令集与错误码 | [Driver Bridge 协议](driver-bridge-protocol.md) | `baseware/src/drivers/bridge.ts` · 外部驱动 Provider |
| **可观测性与控制台消费** | `normal / full` 记录模式、`.ludens/timeline/` 与 `.ludens/archive/` 存储、Trace 配对、控制台冷热索引与回放 | [日志与调用链](logging.md) | `core/src/core/storage/events.ts` · `protocol/src/log-archive.ts` · `core/src/core/query/` |

## 阅读建议

- **理解系统定位与四层架构**：先阅读 [系统概览与四层架构](../concepts/overview.md)、[自主循环与控制周期](../concepts/loop-and-control.md) 与 [编码即感知与能力自验证](../concepts/self-verification.md)。
- **接入新硬件、模拟器或软件驱动**：先读 [Baseware 设计理念与能力契约](baseware.md#driver-包与启动描述)，再对照 [Driver Bridge 协议](driver-bridge-protocol.md) 实现目标侧 TCP 桥与 TypeScript Provider。
- **理解 Agent 如何感知环境并下发动作**：阅读 [架构与边界](architecture.md#会话与-loop)、[工作区与能力编程](../tutorials/workspace.md) 与 [常驻感知与动作状态机](../tutorials/perception-and-action.md)。
- **使用控制台、排查运行与核验性能基线**：阅读 [控制台与调试验证](../tutorials/console-and-debugging.md)（含控制台各视图、`core/src/perf/` 与 `app/perf/` 性能预算及验收工作流），并配合 [日志与调用链](logging.md) 解读运行事实。
