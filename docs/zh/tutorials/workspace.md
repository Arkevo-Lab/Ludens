# 工作区与能力编程

Workspace 是交由 Agent 与开发者共同演进的普通 Coding 工作区：可以在其中编写感知与控制代码、沉淀技能与记忆、收集数据集并训练模型，而无需改动仓库内的 Harness 或 Driver 源码。

下文中的 CLI 命令均在**目标工作区目录**下执行（假定仓库 `core/bin` 与 `baseware/bin` 已加入 `PATH`）。环境安装与服务启停见 [安装与工作区启停](quickstart.md)，常驻 `perception.py` 与 `action.py` 的具体实现见 [常驻感知与动作循环](perception-and-action.md)。

## 文件与会话

### 1. 工作区目录结构

全局目录与工作区分为两层。`LUDENS_HOME` 默认为 `~/.ludens`，不随源码 checkout 移动；它只保存应用配置、可重建的索引、共享缓存与桌宠状态：

```text
~/.ludens/                  # 可由 LUDENS_HOME 覆盖
├── config.json             # {version: 1, workspaceRoot: absolute, defaults: {...}}
├── registry/<id>.json      # {id, workspace, name, updatedAt}，只指向工作区
├── cache/drivers/          # 外部驱动安装缓存
├── logs/baseware/          # 未指定 --data-dir 的独立 Baseware 日志
├── pet/
│   ├── target.json         # 桌宠跟随的稳定 workspace ID
│   ├── consumer.json       # 桌宠消费者心跳
│   ├── profile/            # Electron 偏好与本地缓存
│   └── background/         # 共享桌宠后台日志
└── workspaces/             # 初始 workspaceRoot，可改到任意绝对路径
```

每个工作区独立保存运行所需的状态，移动或备份时应保留整个目录：

```text
workspace/
├── ludens.json                 # 本机服务启动配置（driver、端口、模型、预算）
├── AGENTS.md                # 可选的工作区专属约定（随 OMP 原生 contextFiles 加载）
├── baseware.json            # 连接设备后自动导出的设备能力与参数 schema 快照
├── perception.py            # 工作区常驻感知入口（Perception 类）
├── action.py                # 工作区常驻动作入口（Action 类）
├── skills/<name>/SKILL.md   # 可复用技能文档与配套脚本
├── memory/current.md        # 当前目标、状态与下一步计划
├── .ludens/
│   ├── workspace.json       # {version: 1, id: "ws-UUID"}，持久身份
│   ├── settings.json        # 可选的工作区感知热窗口与视频分段参数覆盖
│   ├── skill-versions/      # 技能与记忆的历史内容快照
│   ├── timeline/            # 跨 run 共享的 @record 能力记录、MP4 视频段与去重媒体原件
│   ├── archive/             # 模型与工具日志的内容寻址 JSON 归档（媒体引用 timeline）
│   └── shiori/
│       ├── sessions/        # OMP 会话 JSONL 及其同名资源目录
│       └── current-session.json # 默认续接会话指针
└── logs/
    ├── <run-id>/            # 单次 Host 运行的事件与流记录
    └── background/          # launchd 后台服务日志与状态
```

### 2. 模板与会话生命周期

- **初始化模板**：`ludens init --name <name> --driver <id>` 在全局默认父目录下创建工作区，也可传 `--workspace <path>` 指定目录。创建缺失的 [AGENTS.md](../../../core/templates/AGENTS.md)、[perception.py](../../../core/templates/perception.py) 与 [action.py](../../../core/templates/action.py) 模板；全局 `defaults` 复制到新建的 `ludens.json`，之后修改全局配置不影响它。`AGENTS.md` 可自由修改或删除，后续启动不会强行补回；修改后需重启 Host 生效。
- **工作区身份**：`.ludens/workspace.json` 的 ID 是唯一身份，不由目录名称或路径计算。移动后执行 `ludens workspace open <new-path>` 更新全局索引；独立副本用 `open <copy-path> --new-id` 分配新身份并清除当前会话选择。原始会话、技能版本、录制和日志仍在工作区内。registry 丢失后可重新 `open`，`forget <id>` 只注销索引。旧目录需显式 [导入](quickstart.md#已有工作区登记与迁移)。
- **会话续接**：重启 Host 默认读取 `.ludens/shiori/current-session.json` 续接上一轮 OMP 会话；`ludens run --new-session` 开启新会话并保留工作区全部代码与文件，`--resume <session.jsonl>` 可指定恢复同一工作区下的历史会话。
- **技能与记忆**：`skills/<name>/SKILL.md` 采用含 `name` 与 `description` 的 YAML frontmatter。Agent 通过 OMP 原生 `read` / `write` / `edit` 工具按需读写技能与记忆，Ludens 不会在每轮模型请求中重复推送全量文件索引。

## 发现与调用能力

### 1. 统一能力目录（`ludens controller`）

设备原生 Controller（来自 Baseware）与工作区声明的 Python 能力（来自 `@capability`）共用同一个目录入口：

```sh
# 列出当前所有设备能力与工作区 Python 能力
ludens controller list

# 查看单项能力的输入/输出 JSON Schema 与控制权要求
ludens controller controller/pad.play --help
ludens controller python/perception.py:Perception.sample --help

# 通过 --args 或 --file 传入完整 JSON 参数对象执行调用
ludens controller controller/screen.top.capture --args '{}'
ludens controller python/scripts/nav.py:move_to --file ./move-args.json
```

- `controller/<name>`：由当前连接的 Baseware Driver 提供，Host 启动时会将最新目录快照写入工作区 `baseware.json`（也可随时执行 `baseware export` 刷新）。
- `python/<相对路径.py>:<函数或Class.method>`：由工作区 Python 代码中的 `@capability` 装饰器提供，通过 AST 静态扫描发现，无需启动进程即可查询签名与说明。

### 2. Python 能力声明与四种调用方式

在工作区 Python 代码中使用 `ludens_tools` 声明和调用能力：

```python
from ludens_tools import Client, capability

@capability
def capture_top(exposure: int = 1) -> dict:
    """Capture the top screen with documented typed parameters."""
    return Client().call("controller/screen.top.capture", {})
```

`@capability` 既可用于顶层同步函数，也可用于类方法（如 `Perception.sample`、`Action.step`）。静态发现会扫描工作区代码（跳过 `logs/`、`.ludens/`、`.git/` 与虚拟环境），要求被标记函数具备 **docstring** 与**显式参数类型注解**（支持标量、`list`、`dict[str, ...]` 与 `Optional`），并将顶层同步函数及 `Perception.sample` / `Action.step` 纳入 `ludens controller list` 目录。实现细节见 [_capabilities.py](../../../core/python/ludens_tools/_capabilities.py)。

`@observe` 用于选择工作区的主观测能力。它必须与同一函数上的 `@capability` 配对（也可同时搭配 `@record`），且整个工作区最多只能声明一个 `@observe` 能力。发现过程会将重复声明报告为诊断，而不会选择有歧义的主通道。

不同调用入口的执行位置与数据边界对比：

| 调用方式 | 执行进程 | 参数与返回值 | 适用场景 |
| --- | --- | --- | --- |
| 普通 Python `import` 调用 | 当前 Python 进程 | 原生 Python 对象（可传 PyTorch 模型、NumPy 数组等） | 工作区内部高性能组合、共享进程内模型与缓存 |
| `Client().call("python/...", {...})` | 当前 Python 进程 | 按能力 schema 校验参数，在当前进程内导入并调用 | 按目录 ID 动态派发本地 Python 能力，不经 Host 重开子进程 |
| `ludens controller python/... --args '{...}'` | Host 启动一次性 Python 子进程 | 跨进程 JSON 序列化；调用结束后子进程退出，不保留内存状态 | Agent 在原生 `bash` 工具中通过命令行触发单次 Python 能力 |
| `Client().call("controller/...", {...})` 或 `ludens controller controller/...` | 经 Ludens 转发至 Baseware | JSON 参数对象，返回包含原生 `result` 与媒体字节的 `ExecutionResult` | 执行设备输入或采集传感器/屏幕数据 |

### 3. 使用 @eval_capability 与 ludens eval 评估能力

对延迟敏感或重复性交互，使用**快速闭环（`@capability`）+ 离线评估（`@eval_capability`）**模式。逐轮 LLM 观测存在数秒延迟：既无法响应钓鱼咬钩、限时连击或移动目标等亚秒级游戏窗口，也会在重复对话循环上浪费轮次。将这些交互封装为本地 Python `@capability` 函数，在进程内高频轮询并执行动作，再离线评估其检测与控制逻辑。

当单项工作区能力适合离线评估时，可在同一 Python 模块中按需为其配对一个同步、无必填参数的评估函数。评估会移除继承的 Host/设备 socket 与控制 epoch，因此无法驱动实机。应根据能力类型选择评估方式：

1. **重放已标注的 `.ludens/timeline/` 记录或 30 Hz 轨迹切片**，用于感知、解析或序列检测函数。`Client().observe()` 直接按页读取持久化时空轴；`Client().replay(...)`（配合 `with record_window() as win:`）则按时间窗口（`window=win` 或 `start=...`、`end=...`）或围绕锚点记录（`around=record_id, before_seconds=2.0, after_seconds=2.0`）自动分页拉取数秒长的 30 Hz 连续帧序列。
   回放默认包含所有能力流，可用 `capability=...` 筛选；默认最多返回 `max_records=256` 条记录，较长轨迹需增大此上限。
2. **挂载本地代理环境并联合演进 Actor + Critic**，用于钓鱼收线、捕虫或网格/菜单导航等闭环动作/反应能力。用 `@eval_env` 装饰带 docstring 的顶层类（或同步工厂函数）来声明可复用环境，并用 `with MyEnv(...) as env:` 挂载实例（临时桩环境仍可用 `with eval_env(env):`）。环境（**Critic** / 世界模型）通过 `env.observe(query)` 拦截 `Client().observe(query)`，通过 `env.call(id, args)` 拦截 `Client().call("controller/...", args)`，在虚拟时间中推进潜在真值状态，并跨随机试验直接依据该状态为能力（**Actor** / 策略）评分。

在非平凡的游戏交互中，无论 Actor（`@capability`）还是 Critic（`eval_env`）都很难在接触真实环境前一次造到完美。应借助 30 Hz `.ludens/timeline/` 回放将二者作为**联合演进（Actor-Critic Co-Evolution）**的一对组件迭代：

1. **先搭最小 `v0` Actor + Critic 并实机探测**：构建最小闭环能力与 `eval_env`，在实机尝试中用 `with record_window() as win:`（或 `@record @capability` 探针）包裹动作，由 30 Hz `Perception.sample` 录下完整轨迹。
2. **切片 30 Hz 回放并优先升级 Critic（`eval_env`）**：用 `Client().replay(win)` 或 `Client().replay(around=record_id, before_seconds=3.0, after_seconds=2.0)` 提取连续帧，观察真实的多帧动态（例如假咬与真咬水花各自持续多少个 33ms 帧、背景水波如何波动），在 `env.observe()` 内直接重放真实切片或校准动态参数（内部调用 `Client().observe()` 或 `Client().replay()` 不会递归），直到升级后的 Critic 能复现真实环境中的干扰并让朴素 `v0` Actor 暴露失败（`passed=False`）。
3. **基于升级后的 Critic 离线迭代 Actor**：修改 `@capability` 并离线运行 `ludens eval run <id>` 直至重新通过（`verified`），再回实机验证。

```python
import random
from ludens_tools import Client, capability, eval_capability, eval_env, record_window

@capability
def reel_on_bite() -> dict:
    """Poll for a real bite and reel inside its reaction window."""
    client = Client()
    reeled = False
    with record_window() as window:
        for _ in range(20):
            observation = client.observe()
            if observation["event"] == "bite":
                client.call("controller/pad.play", {"button": "a"})
                reeled = True
                break
    return {"reeled": reeled, "window": window.to_dict()}

@eval_env
class BiteEnv:
    """Surrogate fishing pond with randomized nibbles preceding the bite."""
    def __init__(self, seed: int):
        self.tick = 0
        self.bite_at = random.Random(seed).randrange(3, 10)
        self.reeled = False

    def observe(self, query=None):
        self.tick += 1  # Advance virtual time; randomized nibbles precede the bite.
        # Client().replay(...) or Client().observe() may supply real 30 Hz timeline slices here.
        return {"event": "bite" if self.tick == self.bite_at else "nibble"}

    def call(self, id, args):
        if id == "controller/pad.play" and self.tick == self.bite_at:
            self.reeled = True
        return {"ok": True}

@eval_capability(reel_on_bite, env=BiteEnv)
def eval_reel_on_bite() -> dict:
    """Grade closed-loop reeling from surrogate ground truth."""
    failed_seeds = []
    for seed in range(20):
        with BiteEnv(seed) as env:  # @eval_env classes mount directly as context managers.
            reel_on_bite()
        if not env.reeled:
            failed_seeds.append(seed)
    pass_rate = (20 - len(failed_seeds)) / 20
    return {"passed": not failed_seeds, "rewards": {"pass_rate": pass_rate}, "details": {"failed_seeds": failed_seeds}}
```

评估函数必须包含 docstring，并返回非空的扁平 `dict[str, int | float]` 有限数值奖励，或信封 `{"rewards": {...}, "details"?: {...}, "passed"?: bool}`。当 `passed` 为 `False` 时，运行会记录 `failed`，同时保留 `rewards` 与 `details` 以便迭代。由此构成**能力 – 评估 – 环境（Capability – Eval – Env）三元关系**：`@eval_capability(fn, env=...)` 的可选 `env` 参数接受同文件的 `@eval_env` 符号，或指向其他模块中声明环境的 `"python/path.py:EnvName"` ID 字符串；`ludens eval list` 会报告静态发现的环境目录 `envs`（id、description、origin、`codeSHA`）。发现过程只进行静态扫描；只有显式请求时才执行评估：

```sh
# 列出绑定、当前状态、奖励与发现诊断
ludens eval list

# 运行一个已绑定评估，或运行所有已绑定评估
ludens eval run python/perception.py:parse_hp_bar
ludens eval run --all

# 当能力在旧题集上通过但实机翻车时，标记为 adapting 并记录反例帧
ludens eval adapt python/perception.py:parse_hp_bar --reason "False positive on dark transition" --record <record-id>

# 按时间倒序读取不可变历史运行
ludens eval history python/perception.py:parse_hp_bar
ludens eval history
```

当实机执行暴露未建模的动态或视觉边界情况时，`ludens eval adapt <id> --reason "<why>" --record <record-id>` 会将能力标记为 `adapting` 并关联反例。改进代理环境或重放题集，使评估复现该实机失败，再迭代能力，直到 `ludens eval run <id>` 重新通过。由此闭合 Sim-to-Real 循环：实机失败 → 记录反例 → 离线复现 → 验证修复。

记录保存在 `.ludens/evals/latest.json` 与 `.ludens/evals/runs/<run-id>.json`。能力目录包含六种状态：

| 状态 | 含义 |
| --- | --- |
| `missing` | 能力没有绑定 `@eval_capability`。 |
| `unverified` | 已绑定评估，但尚无最新运行记录。 |
| `stale` | 最新运行后，能力、评估或绑定环境的源码 `codeSHA` 发生变化，或绑定的评估 ID / 环境 ID 已改变。 |
| `adapting` | 已显式标记为需要修订评估；只要评估模块的整文件 `evalCodeSHA` 与绑定环境模块的 `envCodeSHA` 均未变，重跑仍为 failed/adapting。 |
| `failed` | 最新匹配运行失败，或未产出合法的非空奖励。 |
| `verified` | 当前能力与评估代码对应的最新匹配运行已通过，并产出合法奖励。 |

三个 `codeSHA`（`capabilityCodeSHA`、`evalCodeSHA` 与绑定环境的 `envCodeSHA`）都对整个源码文件计算哈希，而非函数 AST 节点，因此包含模块级 `CASES` 常量。评估模块或其绑定 `@eval_env` 模块的任何修改（包括注释或同文件内仅修改能力函数）都会解除适应门控，并使旧结果变为 `stale`；只有随后运行通过才会变为 `verified`。这是源码变化保护，不是已加入反例的证明：再次信任能力前，应将失败记录加入题集或验证器。外部 fixture 或导入的辅助模块不在此哈希范围内；修订这些用例时也应更新评估模块。

`ludens consolidate` 会向仅允许文件工具的提示注入最新静态评估目录：对于绑定了 `@eval_capability` 的能力，仅当状态为 `verified` 时才允许保留或提升到 `skills/`（`unverified`、`stale`、`adapting` 或 `failed` 条目会被剪除）；而未绑定评估的能力（`missing`，例如实机动作编排宏）只要在实机运行中验证有效仍可保留。整理期间不会执行评估或编辑能力/评估源码；所需修改或评估命令会记录到 memory，留待后续执行轮次处理。

## 能力留档与 workspace 时空轴

### 1. `@record` 装饰器与记录信封

仅标记 `@capability` 的函数默认只返回普通 Python 结果，不会向磁盘写入永久档案。当某项感知或动作结果需要沉淀到工作区时空轴时，叠加 `@record` 装饰器（`@record` 与 `@capability` 顺序不限，但 `@record` 必须与 `@capability` 配合使用）：

```python
from ludens_tools import capability, record

@record
@capability
def detect_scene() -> dict:
    """Extract structured scene state and retain the frame on the timeline."""
    return {
        "text": "Title screen ready",
        "data": {"menu": "start", "cursor": 0},
        "media": [{"mediaType": "image/png", "path": "latest.png"}],
        "space": {"frame": "top_screen", "width": 400, "height": 240},
    }
```

`@record` 函数的返回值必须是只包含以下已知字段的字典信封（字段均可按需省略，传入未知字段会直接报错）：

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `text` | `str` | 面向模型与控制台的简要文字描述。 |
| `data` | 任意可序列化 JSON | 结构化状态数据（展开记录详情或代码读取时使用）。 |
| `media` | `list[dict]` | 媒体列表，每项为 `{"mediaType": "...", "path": "..."}`（支持相对工作区路径）或 `{"mediaType": "...", "data": "<base64>"}`（可直接传入设备截图返回的 `data`）。 |
| `sampledAt` | `str`（ISO 时间戳） | 已知的源采样时刻（不填则仅保留记录完成时刻 `recordedAt`）。 |
| `sources` | `list` | 衍生自其他观测或内层记录的来源引用列表。 |
| `space` | `dict` | 设备或算法定义的坐标系描述。 |
| `effect` | `dict` 或 `list[dict]` | 可选的进程内动作请求，每项包含能力/控制器 `id` 与可选的 `arguments`（或 `args`）对象。 |
| `transition` | `str` 或 `dict` | 连续状态机的可选下一状态：目标能力名称，或 `{"to": "...", "arguments": {...}}`（也接受 `args`）。 |

在 `ludens eval run` 中，`@record` 仍会校验此信封，但只在内存中附加合成的 `timeline: {recordId, sequence}`，不会持久化记录或归档媒体。在 `eval_env(env)` 内，追加的信封还会收集到 `env.recorded`（若环境不允许新增属性，请预先将其初始化为列表）。这些记录不会加入 `Client().observe()` 的历史。可选的 `env.list()` 与 `env.help(id)` 回调提供模拟目录信息。驱动调用保留常规参数契约：省略参数时使用 `{}`，非字典参数会被拒绝。

### 2. 单写入者与媒体归档机制

无论在常驻进程、普通 `import` 还是 CLI 中调用 `@record` 函数，计算均在调用方自己的 Python 进程内完成，随后通过 Ludens socket 将结果交给当前常驻感知 worker 的**唯一时空轴写入者**落盘，并在返回信封中附带 `timeline: {recordId, sequence}` 及媒体 `asset` 引用（若感知 writer 未运行或写入失败，调用会明确抛错，不会静默吞掉或自动重试动作）：

- **图像流转 fMP4 视频段**：图像写入 `.ludens/timeline/video/` 下的 fragmented MP4 视频段（默认 5 分钟一段，空闲 10 秒收尾），通过 `timeline.video` 的 `{pts, timeBase, width, height}` 精确定位；热窗口内保留内存原图供实时交付，冷历史查询时按需从视频段解码。
- **非视频媒体内容寻址**：音频、二进制等其他媒体按 SHA-256 哈希去重保存在 `.ludens/timeline/objects/<sha256>.bin`。

关于如何通过常驻 `perception.py` 持续采样、`ludens observe` 查询时空轴、配置 `.ludens/settings.json` 以及编写 `action.py` 常驻动作，请继续阅读 [常驻感知与动作循环](perception-and-action.md)。

## 后台程序与人工交还

- **OMP 原生后台任务**：耗时训练、数据分析或辅助脚本可直接使用 OMP 原生 `bash` 工具的异步任务（`async`）或命名服务（`name`），通过 `read proc://` 查看状态、`write proc://<id>/kill` 终止或 `wait` 等待完成。
- **控制租约隔离**：每次 `ludens auto on` 时，Ludens 插件会向原生 shell 环境注入最新的 `BASEWARE_EPOCH`。后台程序仅持有其启动时刻的 `epoch`；一旦发生人工交还或周期结束，旧 `epoch` 立即失效，即便后台进程仍在做本地计算，也无法再向设备发送任何输入指令，且不能自行申请新 `epoch`。
