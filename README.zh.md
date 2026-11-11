<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="app/public/brand/ludens-mark-dark.svg">
    <img src="app/public/brand/ludens-mark-light.svg" alt="Ludens logo" width="88" height="88">
  </picture>
</p>

# Ludens

[English](README.md) · **简体中文**

**让编码智能体通过自己写代码，在真实的桌面、游戏主机与模拟器环境中感知、操控并持续进化。**

Ludens 不把智能体困在静态提示词或写死的动作空间里，而是为它提供一个连接真实硬件的持久化代码工作区。无论是玩实时游戏还是操作陌生软件，智能体都会在运行过程中自主编写并热重载 30 Hz 感知状态机（`perception.py`）、沉淀可复用技能（`@capability`），并先在离线代理环境（`@eval_env`）中自验证通过后再投入实战。

---

## 为什么是 Ludens

- **任意屏幕，任意控制器** — 统一接入本机桌面（`CUA`）、采集卡 + HID 硬件桥（如通过 SSH 连接树莓派控制主机）、模拟器或 MCP 节点；单个工作区可并发挂载多台设备并随时切换。
- **代码即感知** — 常驻 Python 进程将实时画面持续录制为可检索的 30 Hz fMP4 时间轴，同时在内存中运行并热重载智能体自己编写的视觉检测器与闭环反射（`perception.py`）。
- **可自验证的技能演化** — 智能体把试错经验提炼为带类型的 `@capability` 函数，配合 `@eval_env` 代理环境与 `@eval_capability` 断言，通过 `ludens eval` 在毫秒内完成离线回归验证。
- **实时驾驶舱与逐帧回放** — 在浏览器控制台中查看多机直播流、通过双向**事件池**异步协作（`ludens event`）、轮内紧急插话纠偏（`steer`）、秒级收回设备租约（`epoch`），并对照模型完整轨迹拖拽 30 Hz 录像回放；也可选配 **Ludens Pet** 桌面伴侣。

## 30 秒看懂工作流

在工作区（`~/.ludens/workspaces/<name>`）中，智能体编写普通 Python 模块即可同时对接真实设备与离线评测环境：

```python
# skills/fishing.py
from ludens_tools import Client, capability, eval_capability, eval_env

@capability
def reel_on_bite() -> dict:
    """监听 30 Hz 感知时间轴，在咬钩帧出现的瞬间按 A 收竿。"""
    client = Client()
    for _ in range(30):
        records = client.observe()["records"]
        if records and records[-1]["data"]["event"] == "bite":
            client.call("controller/pad.play", {"button": "A"})
            return {"reeled": True}
    return {"reeled": False}

@eval_env
class PondEnv:
    """离线代理鱼塘：先产生试探水花，第 5 帧出现真实咬钩。"""
    def __init__(self) -> None:
        self.tick, self.reeled = 0, False

    def observe(self, query=None) -> list[dict]:
        self.tick += 1
        return [{"data": {"event": "bite" if self.tick == 5 else "nibble"}}]

    def call(self, id: str, args: dict) -> dict:
        self.reeled = (id == "controller/pad.play" and self.tick == 5)
        return {"ok": True}

@eval_capability(reel_on_bite, env=PondEnv)
def eval_reel_on_bite() -> dict:
    """无需触碰真实设备，离线验证闭环反应时机。"""
    with PondEnv() as env:
        reel_on_bite()
    return {"passed": env.reeled, "rewards": {"accuracy": 1.0 if env.reeled else 0.0}}
```

随时在终端或 Web 控制台（`?view=caps`）一键执行离线验证：

```sh
ludens eval run --all
```

## 快速开始

环境需准备 **Bun 1.4+**、**Node.js 22.13+**、**Python 3.12+**、**uv**，以及已完成登录的本地 **OMP** 模型凭据。

### 1. 安装与构建

```sh
git clone https://github.com/Arkevo-Lab/Ludens.git && cd Ludens
bun install --frozen-lockfile
uv sync --project core/python --frozen
(cd app && npm run build)
export PATH="$PWD/baseware/bin:$PWD/core/bin:$PATH"
```

### 2. 创建并启动工作区

以内置 `cua` 桌面驱动为例（接入外部模拟器驱动包 `--driver-package` 或远程 SSH / 桥接节点见[设备与驱动准备](docs/zh/tutorials/devices.md)）：

```sh
ludens init --name my-agent --driver cua
cd "$HOME/.ludens/workspaces/my-agent"
ludens up
```

### 3. 打开控制台并交接控制权

访问 [`http://127.0.0.1:3015`](http://127.0.0.1:3015) 管理受控节点、观看实时画面或回放历史记录，也可以直接在终端启动自主运行：

```sh
ludens auto on --message "探索当前环境并沉淀可复用的技能函数"
ludens event send "当前战斗结束后顺便检查一下背包界面"
ludens steer "立刻停手闪避"
ludens auto off
```

## 工程结构

| 子包 | 职责 |
| --- | --- |
| [`@ludens/protocol`](protocol/README.md) | 零依赖契约层：RPC Schema、事件信封与内容寻址归档格式。 |
| [`@ludens/baseware`](baseware/README.md) | 设备控制面：驱动加载器、多机受控节点池与 `epoch` 控制权租约仲裁。 |
| [`@ludens/core`](core/README.md) | 智能体基座：Shiori 运行时、常驻 Python `perception.py` 进程、跨平台后台编排与 `ludens eval`。 |
| [`@ludens/app`](app/README.md) | Next.js Web 控制台（`:3015`，含实时、回放、能力、配置与基座视图）及可选 Electron **桌宠**。 |

## 文档导航

完整文档以中英双语同步维护（[`docs/zh/`](docs/zh/) 与 [`docs/en/`](docs/en/)），也可在控制台 `?view=docs` 中直接阅读：

- **[教程](docs/zh/tutorials/index.md)** — [安装与启停](docs/zh/tutorials/quickstart.md) · [设备与节点池](docs/zh/tutorials/devices.md) · [工作区与能力编程](docs/zh/tutorials/workspace.md) · [常驻感知状态机](docs/zh/tutorials/perception-and-action.md) · [调试与验证](docs/zh/tutorials/debugging-and-verification.md)
- **[参考](docs/zh/reference/index.md)** — [系统架构](docs/zh/reference/architecture.md) · [Baseware 契约](docs/zh/reference/baseware.md) · [Driver Bridge 协议](docs/zh/reference/driver-bridge-protocol.md) · [日志体系](docs/zh/reference/logging.md) · [Dashboard UI](docs/zh/reference/dashboard-ui.md)
- **[工程洞察](docs/zh/insights/index.md)** — [后台投机压缩](docs/zh/insights/omp-compaction.md) · [WebSocket 增量恢复](docs/zh/insights/ws-recovery.md) · [单通道轮次注入](docs/zh/insights/omp-injection.md)

> **安全提示**：智能体会在宿主机直接执行 Shell 与 Python 代码，且运行归档包含屏幕录像。运行不受信任任务请使用虚拟机或容器隔离；任何时刻执行 `ludens auto off` 均可立即吊销设备输入权限。

## 开源许可

[MIT](LICENSE)
