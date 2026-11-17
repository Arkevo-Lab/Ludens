# 工作区、能力与自验证

Ludens 将每个工作区组织为一个可编程的代码工程，并将受控设备、30 Hz 持久化感知时间轴以及离线的 **Capability – Eval – Env** 自检闭环绑定在一起。你和 **Shiori**（Ludens 的 Agent 线程核心）不再把行为逻辑散落在一次性脚本里，而是沉淀为带类型的 Python 能力函数，并在下发真实目标之前先在离线代理环境中完成验证。

本套自验证闭环的设计理念详见 [编码即感知与能力自验证](../concepts/self-verification.md)。

## 1. 工作区目录结构

每个工作区遵循 **1 Workspace = 1 Core** 隔离原则，独立持有自己的 Core 运行时与状态；绑定不同设备或端口的工作区可在 App Daemon 下并发运行，执行**收回控制权**后 Core 保留在 **Warm Standby**（**手动待命**，`manual`）待命。通过 `ludens init` 初始化后的工作区包含以下核心目录与文件：

| 路径 | 职责 |
| --- | --- |
| `ludens.json` | 工作区配置（驱动、模型、控制周期预算、受控节点池、多模态传输开关、`dashboard` / `pet` 开关、日志模式） |
| `AGENTS.md` | Shiori 在该工作区内遵守的工程约束与自验证工作流说明 |
| `MEMORY.md` | 工作区根目录长期记忆，沉淀环境规律与已验证策略（可直接编辑或在控制台 **配置** 页编辑） |
| `memory/` | 阶段性运行记忆笔记（例如在 `ludens consolidate` 边界更新的 `memory/current.md`） |
| `skills/` | 可复用技能文档（`skills/<name>/SKILL.md`）与能力/评测 Python 模块（例如 `skills/visual_guard.py`） |
| `perception.py` | 常驻 `Perception` 状态机（实现 `start`、`sample`、`close`），在**自主运行**期间以最高 30 Hz 持续采样 |
| `loop.py`（可选） | 可编程外层循环与轮首上下文注入器（`Loop.step` / `Loop.inject`），支持轮间热重载、零 Token `@capability` 调度与故障自动回退 |
| `baseware.json` | 由 Baseware 导出的实时控制器目录快照（对应 `ludens controller list` / `baseware export`） |
| `logs/<run-id>/` | 结构化运行事件流（`events.jsonl`）、`manifest.json` 与 `diagnostics.jsonl`（设备事实日志位于 `logs/baseware/`） |
| `.ludens/timeline/` | 单写入者的工作区时空轴，保存 `@record` 观测、去重多媒体对象与 `video/` 下的 30 Hz fMP4 视频 |
| `.ludens/evals/` | 离线能力评测历史与 `latest.json` 验证状态快照 |
| `.ludens/settings.json` | 工作区级感知存储覆盖参数（`hotSeconds`、`videoSegmentSeconds`、`videoIdleSeconds`） |

## 2. 统一能力目录

Ludens 将底层设备工具与工作区 Python 能力统一收敛到同一个控制器调用面（`ludens controller`）：

- **Baseware 设备工具**：以 `controller/<tool>` 命名（多机池显式路由时写作 `controller/<machineId>/<tool>`），详见 [设备接入与 Baseware](devices.md)。
- **工作区 Python 能力**：通过静态 AST 扫描工作区内全部 `.py` 文件自动发现（跳过 `logs/`、`.ludens/`、`.git/`、`node_modules/`、`.venv/`、`venv/` 与 `__pycache__/`），以 `python/<relpath>:<name>` 寻址（例如 `python/skills/visual_guard.py:act_on_alert`）。

### 编写合规的 `@capability`

向 CLI 与 Shiori 暴露的顶层 `@capability` 必须满足四条静态规则：

1. **同步函数**：必须使用 `def`，不能使用 `async def`。
2. **非空 Docstring**：用文档字符串清晰说明用途与前置条件，`ludens controller list` 与 `--help` 会直接展示它。
3. **受支持的参数类型标注**：所有参数都必须使用 `str`、`int`、`float`、`bool`、`list[T]`、`dict[str, T]` 或 `Optional[T]` / `T | None`，可选参数的默认值必须是 JSON 字面量；不支持仅限位置参数（`/`）、`*args` 或 `**kwargs`。
4. **仅叠加 Ludens 装饰器**：同一函数上除 `@capability` 外，仅支持组合使用 `@record` 与 `@observe`。

随时在终端检查并单步试运行已发现的能力：

```sh
ludens controller list
ludens controller python/skills/visual_guard.py:act_on_alert --help
ludens controller python/skills/visual_guard.py:act_on_alert --args '{"channel":1}'
```

在**手动待命**或离线测试模式下，能力调用不持有设备控制租约（`BASEWARE_EPOCH`）；进入**自主运行**后，所有需要控制权的设备调用都会自动携带当前控制周期的 `epoch`。

## 3. Capability – Eval – Env 三元闭环

为避免每次修改控制逻辑都直接惊动真实硬件或耗费线上轮次，建议用一组紧耦合的三元声明组织关键能力：

- **`@capability`**：实际执行观测（`Client().observe()`）与控制器调用（`Client().call(...)`）的策略逻辑。
- **`@eval_env`**：修饰顶层类或工厂函数（需含 docstring），通过 `observe(query=None)` 与 `call(id, args)` 在虚拟时间或真实时间线切片中模拟设备响应。
- **`@eval_capability(target, env=EnvClass)`**：修饰无必填参数的顶层同步函数（需含 docstring），挂载 `@eval_env` 执行能力并返回量化指标（如 `{"passed": bool, "rewards": {...}}`）。

将下面的域无关示例保存为 `skills/visual_guard.py`：

```python
from ludens_tools import Client, capability, eval_capability, eval_env

@capability
def act_on_alert(channel: int = 1, threshold: int = 2) -> dict:
    """监听 30 Hz 感知时间轴，确认连续两帧异常后再触发告警输出。"""
    client = Client()
    streak = 0
    for _ in range(12):
        records = client.observe({"limit": 1})["records"]
        state = records[-1]["data"].get("event") if records else None
        streak = streak + 1 if state == "anomaly" else 0
        if streak >= threshold:
            client.call("controller/relay.trigger", {"channel": channel})
            return {"triggered": True, "streak": streak}
    return {"triggered": False, "streak": streak}

@eval_env
class WatchdogEnv:
    """离线代理监控流：拦截单帧闪烁噪声，仅在连续异常时放行。"""

    def __init__(self) -> None:
        self.stream = ["nominal", "anomaly", "nominal", "anomaly", "anomaly", "nominal"]
        self.cursor = 0
        self.calls: list[tuple[int, str, dict]] = []

    def observe(self, query: dict | None = None) -> list[dict]:
        item = self.stream[min(self.cursor, len(self.stream) - 1)]
        self.cursor += 1
        return [{"data": {"event": item}}]

    def call(self, id: str, args: dict) -> dict:
        self.calls.append((self.cursor, id, args))
        return {"ok": True}

@eval_capability(act_on_alert, env=WatchdogEnv)
def eval_act_on_alert() -> dict:
    """验证两帧消抖逻辑能过滤单帧干扰并在第 5 帧精确触发动作。"""
    with WatchdogEnv() as env:
        outcome = act_on_alert(channel=2, threshold=2)
    passed = outcome["triggered"] and env.calls == [(5, "controller/relay.trigger", {"channel": 2})]
    return {"passed": passed, "rewards": {"accuracy": 1.0 if passed else 0.0}}
```

## 4. 运行 `ludens eval` 与失败反例闭环

在工作区终端或控制台中运行离线评测：

```sh
ludens eval list
ludens eval run --all
ludens eval run python/skills/visual_guard.py:eval_act_on_alert
ludens eval history python/skills/visual_guard.py:eval_act_on_alert --limit 10
```

执行 `ludens eval run` 时，Ludens 会自动剥离 `LUDENS_SOCKET`、`BASEWARE_SOCKET`、`LUDENS_EPOCH` 与 `BASEWARE_EPOCH`，从根源上保证离线评测绝不误触物理设备或干扰活跃控制租约。

### 六种验证状态

系统会联合追踪能力本身、对应评测函数与绑定 `@eval_env` 的源码哈希（`codeSHA`）：

| 状态 | 含义 |
| --- | --- |
| `verified` | 最近一次评测在当前三方源码完全一致的前提下通过 |
| `stale` | 能力、评测或绑定的 `@eval_env` 源码在通过后发生改动 |
| `adapting` | 已通过 `ludens eval adapt` 标记了真实失败样本，需修订并通过验证后才能恢复 |
| `failed` | 最近一次评测抛出异常、返回空奖励或 `passed: false` |
| `unverified` | 已绑定 `@eval_capability`，但尚未执行过评测 |
| `missing` | 尚未绑定任何 `@eval_capability` |

### 将真机失败转化为离线回归测试（`adapt` 与 `record_window`）

为保证时间轴锁安全，只有常驻单写入者（`perception.py` / Core 进程）会向 `.ludens/timeline/` 追加 `@record` 记录。在线运行探测或复合能力时，可通过 `record_window()` 包裹调用窗口（或在 Core 的 `@record @capability` 中录制），随后回溯该区间的真实帧数据：

```python
from ludens_tools import Client, record_window

client = Client()
with record_window() as win:
    res = client.call("python/skills/visual_guard.py:act_on_alert", {"channel": 1})

# 调出刚才时间窗内真实录制的 30 Hz 帧与结构化注释
frames = client.replay(win)
```

一旦某个原本为 `verified` 的能力在真机任务中失效，立刻将该条时间轴记录标记为失败反例：

```sh
ludens eval adapt python/skills/visual_guard.py:act_on_alert \
  --reason "相机自动曝光切换瞬间发生误触发" \
  --record <record-id>
```

接着在 Python 中用 `client.replay(around=record_id, before_seconds=2.0, after_seconds=2.0)`（或在控制台 **回放** 页拖拽定位时间点）核对真实帧序与干扰特征，先强化 `WatchdogEnv` 让旧实现明确返回 `passed: false`，再修改 `act_on_alert` 直至 `ludens eval run --all` 重新变为 `verified`。

## 5. 可编程外层循环（`loop.py`）与精简感知输入

默认情况下（工作区不存在 `loop.py`），Ludens 运行内置外层循环：每轮读取最新精简感知包络与视觉帧，然后进入一次模型推理。常规最新读取采用去噪后的紧凑结构：

`{ ok: true, records: [{ id, sequence, recordedAt, capability?, text?, data?, space?, effect?, transition? }] }`

其中默认主通道省去重复的 `capability` 字符串，并剥离 `queryId`、`generation`、`codeSHA`、`sampling`、`sources`、`media[*].id` 等内部运行噪声；当显式调用 `observe` 传入历史或过滤条件（`id`、`at`、`start`、`end`、`after`、`limit` 或 `capability`）时，才附带 `{ query, hasMore, nextAfter?, availability? }` 分页与可用范围元数据。

当常规轮间轮询、确定性 `@capability` 触发或周期性整理不需要每次消耗大模型 Token 时，你可以在工作区根目录创建或由 Shiori 编写 `loop.py`：

```python
from ludens_tools import (
    Client,
    Consolidate,
    Loop,
    Prompt,
    Stop,
    TurnContext,
    TurnInjection,
    Wait,
)


class Loop(Loop):
    """常规巡检在 Python 层确定性流转，仅在初始规划或触发告警后唤醒模型。"""

    def inject(self, ctx: TurnContext) -> TurnInjection:
        inj = ctx.default_inject()
        records = inj.records
        latest = records[-1].get("data", {}) if records else {}
        if latest.get("event") == "nominal":
            inj.attach_images = False
        inj.extra.append({"turn": ctx.turn, "llm_turns": ctx.llm_turns})
        return inj

    def step(self, ctx: TurnContext) -> Prompt | Consolidate | Wait | Stop:
        records = ctx.perception.get("records") or []
        latest = records[-1].get("data", {}) if records else {}
        if latest.get("goal_met"):
            return Stop(reason="goal_met")
        if latest.get("event") == "anomaly":
            outcome = Client().call(
                "python/skills/visual_guard.py:act_on_alert",
                {"channel": 1, "threshold": 2},
            )
            if outcome.get("triggered"):
                return Prompt(prompt="告警继电器已触发，请复核近期时间轴并记录处置结论。")
        if ctx.turn > 0 and ctx.turn % 20 == 0:
            return Consolidate()
        if ctx.turn == 0:
            return Prompt()
        return Wait(seconds=1.0, reason="nominal_patrol")
```

使用 `loop.py` 时的关键运行时保障：

- **双层定制接口**：`inject(ctx)` 可修改 `ctx.default_inject()` 返回的 `TurnInjection`（如关闭图片挂载 `inj.attach_images = False` 或向 `inj.extra` 追加摘要），也可直接返回自定义 `dict`、`str` 或 `None`（跳过本轮观测注入与图片挂载）；`step(ctx)` 在活跃 `epoch` 租约作用域内执行，可直接通过 `Client().call(...)` 调用 `@capability` 并返回 `Prompt`、`Consolidate`、`Wait` 或 `Stop`。
- **热重载与 `loop_fault` 自愈回退**：编辑 `loop.py` 或其导入的工作区 `.py` 模块会在轮间自动热重载。若出现语法或运行时错误，宿主会发出 `loop_fault`、自动回退到内置默认循环，并在下一轮模型输入中附带 `loopFault` 供即时修复，绝不中断当前控制周期。
- **人工 `Steer` 即时抢占**：发送 `ludens steer`（或点击控制台**即时插话**）会立即唤醒正在执行的 `Wait(seconds)`，并跳过 `Loop.step()` 直接进入携带人工指令的 `Prompt` 轮次（`ctx.steered = True`）。

## 6. 在控制台管理能力、记忆与沉淀

- **运行（Live，`?view=live`）**：在模型卡片中展开 **查看传入模型的 Input 详情** 即可 1:1 检视 `Loop.inject` 交付的真实 `deliveredPayload`；轮间 `loop_step` / `loop_fault` 事件与不经模型的 `@capability` 调用会折叠在 **Loop 调度步骤** 分组内（异常时自动展开）。
- **能力（Capabilities，`?view=caps`）**：直观检视 **Capability – Eval – Env** 拓扑关系，按状态（`verified`、`adapting`、`stale`、`failed`、`unverified`、`missing`）筛选，查看 **工作区来源**（`baseware.json` 与静态 Python `@capability`）、**Core 连接检查** 与 **社区驱动验证** 结果，并可一键点击运行全部或单项评测。
- **配置（Config，`?view=perception`）**：在 **后台服务与会话（Services & Session）** 页签直接编辑 **工作区长期记忆（`MEMORY.md`）**、查看 Shiori 会话摘要，或一键执行 **启动工作区 / 热重载 Core / 停止**。
- **记忆与技能沉淀（`ludens consolidate` 或运行页按钮）**：开启一次禁用所有设备访问的纯文件整理轮次，自动把 `verified` 能力晋升或保留到 `skills/` 技能卡片中，清除 `unverified`/`stale`/`adapting`/`failed` 条目，并刷新 `memory/current.md`。

继续阅读 [感知、执行与性能调优](perception-and-action.md)，学习编写可热重载的常驻 `perception.py` 状态机并配置 30 Hz 多模态传输链路。
