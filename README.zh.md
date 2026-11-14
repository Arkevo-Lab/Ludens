<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="app/public/brand/ludens-mark-dark.svg">
    <img src="app/public/brand/ludens-mark-light.svg" alt="Ludens logo" width="88" height="88">
  </picture>
</p>

# Ludens

[English](README.md) · **简体中文**

**面向复杂多模态端到端任务的多模态、跨设备 Agent Harness —— 适用于机器人操控、安防巡检、桌面自动化与实时游戏等场景。**

Ludens 不把智能体限制在静态提示词或固定动作Schema里，而是把可编程的代码工作区直接接到真实硬件与软件目标上：
- **Ludens** 既是整套跨设备多模态 Harness，也是它的同名吉祥物人格。
- **Shiori** 严格担任 Ludens 的 **Agent 线程核心**，在持久化代码工作区内完成跨轮次推理与代码演化。
- **Baseware** 是 Ludens 的**跨设备集成层**，统一屏蔽异构设备驱动、传输协议与硬件控制租约。

---

## 为什么选择 Ludens

- **任意屏幕，任意设备（`Baseware`）** — 统一接入本机桌面（`cua`）、采集卡与 HID 硬件桥（如通过 SSH 或 TCP 桥接控制的机器设备与嵌入式主机）、仿真器或 MCP 端点；单个工作区支持并发挂载多个受控节点并按需路由。
- **代码即感知（`perception.py`）** — 常驻 Python 进程将实时画面录制为可检索的 30 Hz fMP4 时间轴，同时在内存中运行并热重载智能体自己编写的视觉检测器与闭环状态机。
- **可自验证的能力演化（`@capability` 与 `ludens eval`）** — 将反复试错的动作流程沉淀为带类型的 Python 能力函数，搭配离线代理环境（`@eval_env`）与评测断言（`@eval_capability`），在秒级内离线完成回归验证后再下发真机执行。
- **统一控制台、自主循环与逐帧回放** — 通过原生 **Ludens 桌面应用** 或浏览器**控制台**（`ludens app-server`）一键启停工作区、开启**自主运行**、经由双向**事件池**异步协作（`ludens event`）、在推理中途紧急插话纠偏（`steer`）、随时一键**收回控制权**（`ludens auto off`），并对照模型完整轨迹拖拽 30 Hz 录像回放。*（可选附带系统托盘**桌宠**小组件。）*

## 30 秒看懂工作流

在工作区（`~/.ludens/workspaces/<name>`）中，智能体编写普通 Python 模块，即可同时对接真实 Baseware 设备与离线代理环境：

```python
# skills/visual_guard.py
from ludens_tools import Client, capability, eval_capability, eval_env

@capability
def act_on_alert() -> dict:
    """监听 30 Hz 感知时间轴，在检测到异常帧的瞬间触发执行动作。"""
    client = Client()
    for _ in range(30):
        records = client.observe()["records"]
        if records and records[-1]["data"].get("event") == "anomaly":
            client.call("controller/relay.trigger", {"channel": 1})
            return {"triggered": True}
    return {"triggered": False}

@eval_env
class WatchdogEnv:
    """离线代理监控流：前 4 帧正常，第 5 帧出现异常告警。"""
    def __init__(self) -> None:
        self.tick, self.triggered = 0, False

    def observe(self, query=None) -> list[dict]:
        self.tick += 1
        return [{"data": {"event": "anomaly" if self.tick == 5 else "nominal"}}]

    def call(self, id: str, args: dict) -> dict:
        self.triggered = (id == "controller/relay.trigger" and self.tick == 5)
        return {"ok": True}

@eval_capability(act_on_alert, env=WatchdogEnv)
def eval_act_on_alert() -> dict:
    """无需触碰真实硬件，离线验证闭环响应时机。"""
    with WatchdogEnv() as env:
        act_on_alert()
    return {"passed": env.triggered, "rewards": {"accuracy": 1.0 if env.triggered else 0.0}}
```

随时在终端或控制台 **能力** 页（`?view=caps`）一键运行离线验证：

```sh
ludens eval run --all
```

## 快速开始

环境需准备 **Bun 1.4+**、**Node.js 22.13+**、**Python 3.12+**、**uv**，以及已配置好的模型认证凭据。

### 1. 安装与构建

```sh
git clone https://github.com/Arkevo-Lab/Ludens.git && cd Ludens
bun install --frozen-lockfile
uv sync --project core/python --frozen
(cd app && npm run build)
export PATH="$PWD/baseware/bin:$PWD/core/bin:$PWD/app/bin:$PATH"
```

### 2. 三种启动方式

Ludens 基于统一的 `@ludens/core` `app-server`（生产态零 Next.js 服务端进程、纯 TypeScript 跨平台进程监管）提供三种运行方式：

- **桌面端应用**：执行一次 `(cd app && npm run desktop:build)` 后运行 `ludens-app --show-window`（或执行 `npm --prefix app run desktop:dist` 打包原生 macOS `.dmg` / Windows `.exe` 安装包）。应用自动监管后台 `ludens app-server`，无需终端即可一键**启动 / 重载 / 停止**工作区；关闭窗口（`×`）时最小化至系统托盘（可选显示桌宠），完全退出（`⌘Q` / 托盘 **Quit**）时干净清理全部受管进程。
- **本地浏览器控制台（`ludens app-server` / `npm run dev`）**：运行 `ludens app-server`（别名 `ludens serve`）在 [`http://127.0.0.1:3015`](http://127.0.0.1:3015) 同时承载 `/api/*` 与静态前端控制台（`app/out`）；前端热更新开发运行 `(cd app && npm run dev)`。
- **无头 CLI 模式**：直接在终端初始化并管理工作区（接入外部驱动包 `--driver-package` 或远程 SSH / 桥接节点详见[设备与驱动准备](docs/zh/tutorials/devices.md)）：

```sh
ludens init --name my-agent --driver cua
cd "$HOME/.ludens/workspaces/my-agent"
ludens up
```

### 3. 开启自主运行、收回控制权与异步协作

在桌面应用或 [`http://127.0.0.1:3015`](http://127.0.0.1:3015) 的**运行（`?view=live`）**页点击**启动自主运行**，或通过终端命令行操控：

```sh
ludens auto on --message "探索目标环境并沉淀经验证的 Python 能力函数"
ludens event send "当前序列执行完毕后顺便检查状态面板"
ludens steer "立刻暂停触发动作"
ludens auto off
```

## 工程结构

| 子包 | 职责 |
| --- | --- |
| [`@ludens/protocol`](protocol/README.md) | 零依赖契约层：RPC Schema、事件信封与内容寻址归档格式。 |
| [`@ludens/baseware`](baseware/README.md) | 跨设备集成层：驱动加载器、多机受控节点池（`stdio`/`bridge`/`ssh`/`http`/`sse`）与 `epoch` 控制租约仲裁。 |
| [`@ludens/core`](core/README.md) | Harness 运行时与统一 `app-server`：**Shiori**（Agent 线程核心）、常驻 Python `perception.py` 进程、`/api/*` 与控制台后端、纯 TS 进程监管与 `ludens eval`。 |
| [`@ludens/app`](app/README.md) | 静态 Web **控制台**（`app/out`，涵盖运行、回放、性能、能力、配置、设备、工作区、文档、设置与开发者视图）、Electron 桌面端与可选桌宠小组件。 |

## 文档导航

完整文档以中英双语同步维护（[`docs/zh/`](docs/zh/) 与 [`docs/en/`](docs/en/)），也可在控制台 `?view=docs` 中实时阅读：

- **[核心概念](docs/zh/concepts/index.md)** — [系统概览与四层架构](docs/zh/concepts/overview.md) · [自主循环与控制周期](docs/zh/concepts/loop-and-control.md) · [编码即感知与能力自验证](docs/zh/concepts/self-verification.md)
- **[教程](docs/zh/tutorials/index.md)** — [快速开始](docs/zh/tutorials/quickstart.md) · [设备与驱动准备](docs/zh/tutorials/devices.md) · [工作区与能力编程](docs/zh/tutorials/workspace.md) · [常驻感知状态机](docs/zh/tutorials/perception-and-action.md) · [控制台与调试验证](docs/zh/tutorials/console-and-debugging.md)
- **[参考](docs/zh/reference/index.md)** — [系统架构](docs/zh/reference/architecture.md) · [CLI 命令参考](docs/zh/reference/cli.md) · [Baseware 契约](docs/zh/reference/baseware.md) · [Driver Bridge 协议](docs/zh/reference/driver-bridge-protocol.md) · [日志体系](docs/zh/reference/logging.md)
- **[洞察](docs/zh/insights/index.md)** — [后台投机压缩](docs/zh/insights/omp-compaction.md) · [WebSocket 增量恢复](docs/zh/insights/ws-recovery.md) · [单通道轮次注入](docs/zh/insights/omp-injection.md) · [感知参数推演](docs/zh/insights/perception-parameters.md)

> **安全提示**：智能体会在宿主机直接执行 Shell 与 Python 代码，且运行归档包含视觉录制。处理不受信任的目标时请配合虚拟机或容器隔离；任何时刻执行 `ludens auto off`（或在控制台点击**收回控制权**）均可立即吊销设备动作权限。

## 开源许可

[MIT](LICENSE)
