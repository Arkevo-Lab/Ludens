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
- **原生桌面应用、实时驾驶舱与逐帧回放** — 既可直接启动自包含的 **Ludens 桌面端**（含系统托盘与 **Ludens Pet** 桌宠伴侣），也可在 `ludens app-server` 承载的浏览器控制台中一键启停与重载工作区、查看多机直播流、通过双向**事件池**异步协作（`ludens event`）、轮内紧急插话纠偏（`steer`）、秒级收回设备租约（`epoch`），并对照模型完整轨迹拖拽 30 Hz 录像回放。

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
export PATH="$PWD/baseware/bin:$PWD/core/bin:$PWD/app/bin:$PATH"
```

### 2. 启动桌面应用或本地 App-Server

Ludens 基于统一的 `@ludens/core` `app-server`（生产态零 Next.js 服务端进程、纯 TypeScript 跨平台进程监管）提供三种一等运行方式：

- **Ludens 桌面端（一等宿主）**：执行一次 `(cd app && npm run desktop:build)` 后直接运行 `ludens-app --show-window`（或通过 `npm --prefix app run desktop:dist` 打包原生 macOS `.dmg` / Windows NSIS `.exe` 安装包）。桌面端会自动在后台拉起并监管 `ludens app-server`，无需打开终端即可在界面内新建并一键**启动 / 重载 / 停止**工作区；点击窗口关闭按钮（`×`）仅隐藏至系统托盘与 **Ludens Pet** 桌宠，显式退出应用（`⌘Q` / 托盘 **Quit**）时则干净回收全部受管游戏 AI 子进程。
- **本地浏览器控制台（`ludens app-server` / `npm run dev`）**：运行 `ludens app-server`（别名 `ludens serve`）由单个 `@ludens/core` 进程在 [`http://127.0.0.1:3015`](http://127.0.0.1:3015) 同时承载 `/api/*` 与静态前端产物（`app/out`）；前端热更新开发执行 `(cd app && npm run dev)`（自动拉起后台 `ludens app-server` 并代理 `/api/*`）。
- **无头 CLI 模式**：直接在终端初始化与编排工作区（接入外部模拟器驱动包 `--driver-package` 或远程 SSH / 桥接节点见[设备与驱动准备](docs/zh/tutorials/devices.md)）：

```sh
ludens init --name my-agent --driver cua
cd "$HOME/.ludens/workspaces/my-agent"
ludens up
```

### 3. 交接控制权与异步协作

在桌面应用或 [`http://127.0.0.1:3015`](http://127.0.0.1:3015) 的**运行（`?view=live`）**页一键启动工作区并开启自主循环，或直接通过终端指令控制：

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
| [`@ludens/core`](core/README.md) | 智能体基座与统一 `app-server`：Shiori 运行时、常驻 Python `perception.py` 进程、`/api/*` 与静态 UI 服务（`ludens app-server`）、纯 TS `WorkspaceSupervisor` 以及 `ludens eval`。 |
| [`@ludens/app`](app/README.md) | 静态 Web 控制台构建产物（`app/out`，含实时、回放、能力、配置与基座视图）以及一等 Electron **Ludens 桌面端**与 **Ludens Pet** 桌宠伴侣。 |

## 文档导航

完整文档以中英双语同步维护（[`docs/zh/`](docs/zh/) 与 [`docs/en/`](docs/en/)），也可在控制台 `?view=docs` 中直接阅读：

- **[教程](docs/zh/tutorials/index.md)** — [安装与启停](docs/zh/tutorials/quickstart.md) · [设备与节点池](docs/zh/tutorials/devices.md) · [工作区与能力编程](docs/zh/tutorials/workspace.md) · [常驻感知状态机](docs/zh/tutorials/perception-and-action.md) · [调试与验证](docs/zh/tutorials/debugging-and-verification.md)
- **[参考](docs/zh/reference/index.md)** — [系统架构](docs/zh/reference/architecture.md) · [Baseware 契约](docs/zh/reference/baseware.md) · [Driver Bridge 协议](docs/zh/reference/driver-bridge-protocol.md) · [日志体系](docs/zh/reference/logging.md) · [Dashboard UI](docs/zh/reference/dashboard-ui.md)
- **[工程洞察](docs/zh/insights/index.md)** — [后台投机压缩](docs/zh/insights/omp-compaction.md) · [WebSocket 增量恢复](docs/zh/insights/ws-recovery.md) · [单通道轮次注入](docs/zh/insights/omp-injection.md)

> **安全提示**：智能体会在宿主机直接执行 Shell 与 Python 代码，且运行归档包含屏幕录像。运行不受信任任务请使用虚拟机或容器隔离；任何时刻执行 `ludens auto off` 均可立即吊销设备输入权限。

## 开源许可

[MIT](LICENSE)
