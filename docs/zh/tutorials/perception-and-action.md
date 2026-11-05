# 常驻感知与动作状态机

在实时交互环境中，常驻 `perception.py:Perception` 进程运行连续状态机，负责高频采样与进程内闭环控制，并将观测写入 `.ludens/timeline/`。各能力无需 IPC 即可共享内存、发出动作并在状态间转换，因此绑定 epoch 的控制程序运行在同一进程内。能力装饰器与时空轴信封约定见 [工作区与能力编程](workspace.md)。

下文中的 CLI 命令均在**目标工作区目录**下执行，假定仓库 `core/bin` 与 `baseware/bin` 已加入 `PATH`。跨目录操作时，在子命令前传入 `ludens --workspace /absolute/path/to/workspace`。

## 常驻感知与历史读取

### 1. `perception.py:Perception` 生命周期

`perception.py` 中的 `Perception` 类在独立的常驻 Python 进程中运行（模板见 [core/templates/perception.py](../../../core/templates/perception.py)）：

- `start(self, context)`：进程启动或 `reload` 时执行一次，可在此加载深度学习权重、初始化状态或后台采样线程。`context` 包含 `workspace`、`runDir` 与 `generation`。
- `sample(self)`：需标注 `@observe`、`@record` 与 `@capability`；其中 `@observe` 将其选为工作区的主观测能力。调度器按宿主配置的频率 `LUDENS_PERCEPTION_SAMPLE_HZ`（默认 `30.0` Hz，同时作为录像编码的名义帧率；忽略工作区类上的 `sample_hz` 属性——详见 [为什么感知层参数要分成三层管理](../insights/perception-parameters.md)）连续调用当前状态。若单次采样耗时超过周期，下一次采样会顺延而不会并发重叠或堆积补跑。
- `close(self)`：在 `reload`、`stop` 或 Host 退出时调用，用于释放自建资源。

常驻进程在同一个 Python 进程中运行连续状态机。任何活动能力都可以返回可选的 `effect`（`{"id": "controller/...", "arguments": {...}}` 或此类对象的列表）请求闭环执行，以及可选的 `transition`（`"method_name"` 或 `{"to": "method_name", "arguments": {...}}`）选择下一次 tick 调用的能力。转换目标在同一实例、模块或工作区内解析，无需跨进程，因此实例属性与模块全局变量可在 tick 之间共享内存上下文。

**源码修改自动重载**：修改 `perception.py` 或其导入的工作区 `.py` 模块会自动重载常驻进程（非 Python 资源不会触发重载）；显式历史查询在重载后仍然可用，新 generation 会保留历史 generation。如需在不改源码的情况下显式重启，可执行 `ludens perception reload`。

没有 `Perception` 类时，`perception.py` 也可定义任意名称的顶层 `@observe @record @capability` 函数。实时与离线时空轴默认读取唯一的 `@observe` 通道，包括其他工作区模块中的已记录能力；`@observe` 不会自动调度其他模块。没有标记时，默认通道仍为 `python/perception.py:Perception.sample`。重复标记会为每个冲突声明生成诊断，并阻止常驻进程开始运行。

宿主进入 `auto` 时将控制 epoch 授予常驻进程，感知重载时保留该租约，交还控制时撤销租约但不停止观测。手动模式下没有租约时会跳过 controller effect；本地 `python/` effect 仍在进程内执行。常驻进程的 `state`、`transition` 和 `lease` RPC 分别查看当前能力、选择其下一组参数、更新 epoch/input generation。跨模块目标使用 `python/path.py:function`；后续不带路径的函数名会在当前活动模块中解析。只有 `@record` 状态会发布观测，活动状态变化不会改变默认观测通道。

```python
from ludens_tools import capability, observe, record

class Perception:
    def start(self, context):
        self.tracking = False

    @observe
    @record
    @capability
    def sample(self):
        """Observe the environment and enter tracking when a target appears."""
        return {
            "text": "target acquired",
            "effect": {"id": "controller/pad.play", "arguments": {"inputs": [{"atMs": 0, "durationMs": 120, "key": "a"}]}},
            "transition": {"to": "track", "arguments": {"target": "marker"}},
        }

    @capability
    def track(self, target: str):
        """Track the target using state shared with sample in this process."""
        self.tracking = True
        return {"text": f"tracking {target}"}

    def close(self):
        pass
```

新工作区的 `Perception.sample()` 默认抛出 `NotImplementedError`，系统不会用默认截图替代未实现的感知；修改 Python 源码后，常驻进程会自动重载并保留持久历史。修改权重等非 Python 资源后，需要执行 `ludens perception reload`。已停止的常驻进程在源码修改后仍保持停止，直到显式重载。

### 2. 感知管理与历史查询命令（`ludens observe`）

```sh
# Lifecycle, state-machine control, and auto-inject policy management
ludens perception status
ludens perception state
ludens perception transition track --args '{"target":"marker"}'
ludens perception reload
ludens perception stop
ludens perception inject          # Show current auto-inject policy (on / off)
ludens perception inject off      # Stop auto-appending observations to model context, keep sampling and recording
ludens perception inject on       # Resume auto-appending

# Read timeline history (archived records only, never triggers resampling)
ludens observe
ludens observe --id <record-id> --images
ludens observe --at 2026-10-27T01:00:00Z
ludens observe --capability python/sensors.py:temperature
ludens observe --capability '*' --start 2026-10-27T01:00:00Z --limit 8
```

- **采样与自动注入解耦**：`ludens perception inject off` 仅停止在每轮 prompt 开始时向模型自动追加新观测和采样器状态；后台 `sample()`、视频录制与显式 `observe` 查询均照常运行，轮内观察始终由模型显式 `observe` 完成，工具结果不会被追加任何观察。`ludens perception stop` 则会彻底停止采样进程与时空轴 writer，直至下次 `reload`。
- **查询维度与分页**：默认读取由 `@observe` 选定的主通道（模板中的 `Perception.sample`）的最新记录；`--capability` 可筛选其他 `@record` 能力或传 `'*'` 查询全轴；`--at` 查询 `recordedAt` 不晚于指定时刻的最后一条记录；`--start` / `--end` 按 `recordedAt` 闭区间升序分页（默认 `8` 条，上限 `64` 条，通过返回的 `nextAfter` 传给 `--after` 翻页）。
- **终端图像交付**：在 Agent 的 `bash` 工具中加 `--images` 可通过 OMP 终端图像通道直接将图片送入模型（单页上限 32 张 / 40 MiB）。

### 3. 查询返回结构与错误码

CLI `ludens observe`、Python `Client().observe(query)` 与 OMP 原生 `observe` 工具返回相同的结构化信封 `{queryId, ok, query, records, hasMore, nextAfter?, availability?, error?}`。当 `ok: false` 时，`error.code` 明确区分原因：

| 错误码 | 触发场景 |
| --- | --- |
| `NOT_READY` | 查询最新记录，但所选能力尚未产出可用样本；主通道仍在加载时也返回此码。 |
| `NOT_FOUND` | 指定的 `--id` 不存在，或 `--at` 时刻之前没有任何匹配记录。 |
| `EXPIRED` | 时间或范围查询涉及已淘汰的非持久窗口，且无可读记录返回（若范围查询仅部分过期但仍有可读记录，则返回 `ok: true` 并标记 `availability.expired = true`）。未知 `--id` 始终返回 `NOT_FOUND`，不会推断它曾存在。 |
| `UNAVAILABLE` | 感知进程（时空轴 writer）已停止或在查询中被替换，或最新主通道的采样器不可用（如加载、采样失败）。writer 仍运行时，显式历史查询不受采样器故障影响。 |
| `QUERY_FAILED` | 参数非法、磁盘读取异常或冷视频帧解码失败。 |

### 4. 时空轴存储与编码预算环境变量

宿主进程支持以下环境变量配置时空轴窗口与视频编码参数（当前生效值可通过 `ludens perception status` 的 `history` 字段查看）：

采样率仅在对应环境变量未设置时使用默认值。空字符串、纯空白、非数值、零、负数、NaN 与无穷大会使工作进程启动失败，并返回指明变量名的校验错误；有效数字两侧的空白可以接受。

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `LUDENS_PERCEPTION_SAMPLE_HZ` | `30` | `Perception.sample()` 的连续采样目标频率与录像名义帧率（有限正数）。 |
| `LUDENS_PERCEPTION_PERSIST` | `1` | 设为 `0`（或 `false`）时仅保留内存/临时热窗口，进程停止或 `reload` 即清空。 |
| `LUDENS_PERCEPTION_HOT_SECONDS` | `600` | 每通道热窗口保留秒数（10 分钟），窗口内原图可直接内存交付；可被工作区设置覆盖。 |
| `LUDENS_PERCEPTION_HOT_BYTES` | `1073741824` | 热窗口全局字节预算（1 GiB），压力下优先收缩占用最大的通道。 |
| `LUDENS_PERCEPTION_SEGMENT_SECONDS` | `3600` | 时空轴元数据 JSONL 与索引文件的切段时长（1 小时）。 |
| `LUDENS_PERCEPTION_SEGMENT_BYTES` | `268435456` | 单段元数据与非视频媒体字节上限（256 MiB）。 |
| `LUDENS_VIDEO_SEGMENT_SECONDS` | `300` | MP4 视频分段时长（5 分钟）；可被工作区设置覆盖。 |
| `LUDENS_VIDEO_IDLE_SECONDS` | `10` | 停采后空闲收尾秒数；可被工作区设置覆盖，更改采样率或停止进程时也会收尾。 |
| `LUDENS_VIDEO_QUEUE_BYTES` | `33554432` | 后台视频编码队列内存上限（32 MiB，含压缩输入与 RGB 缓冲）。 |
| `LUDENS_VIDEO_QUEUE_FRAMES` | `64` | 后台视频编码队列最大待编码帧数。 |
| `LUDENS_VIDEO_STREAMS` | `16` | 同时活跃的图像编码流数量上限（超出时最久未用流先收尾）。 |
| `LUDENS_VIDEO_QUERY_BYTES` | `33554432` | 单次历史冷查询解码输出字节上限（32 MiB）。 |

工作区 `.ludens/settings.json` 可覆盖 `hotSeconds`、`videoSegmentSeconds`、`videoIdleSeconds`，优先级为设置文件 > 宿主环境变量 > 内置默认。Dashboard「感知」页独立编辑这些已保存覆盖值，不直接修改运行中的进程。可输入精确整数秒、选择预设或使用辅助滑条；选择继承会移除该字段的覆盖值。继承值不会被显示为已知的运行默认值。文件中已有的有效正数自定义值，包括小数或超出编辑器范围的值，仍会显示，并在编辑对应字段前保持不变。字节预算仍由环境变量控制。

草稿按工作区身份和登记路径分别保存在当前浏览器标签页，可显式放弃。浏览器会话存储可用时，刷新页面也会恢复草稿；否则只在当前页面生命周期内保留。读取已保存设置会保留未完成的输入。保存仅写入修改过的字段，不重载感知。响应无法确认时保留草稿，并提供读取操作核对已保存值，不自动重复写入。请求携带预期工作区路径，旧草稿不会悄悄写入重新定位后的登记目录。

保存后，可复制页面提供的工作区专属命令 `env -u LUDENS_SOCKET ludens --workspace '/absolute/workspace/path' perception reload`，在合适时机运行。清除继承的 `LUDENS_SOCKET` 可确保命令指向该工作区的宿主地址。再用“检查运行值”独立读取宿主状态。只有感知进程 ready，且 generation、PID 与完整加载参数均有证据时，才显示为当前运行值；停止或不完整的观测不能证明已应用。页面将显式保存的覆盖值与观测值比较，继承字段只显示观测到的值，不猜测其环境变量或默认值来源。带时间的检查是一次观测，不是持续监控，也不能证明后续保存已应用。没有运行宿主的已登记工作区仍可配置。

视频使用 fragmented MP4（`+frag_keyframe+empty_moov`），约每两秒采样量形成一个关键帧间隔。未收尾段中已完整落盘的片段可供读取，最新尚未落盘的帧明确返回不可读，不用邻帧替代。每段 `.mp4.json` 用 `readableBytes`、`lastReadablePts`（微秒 PTS）、`durationSeconds` 与 `frames` 发布完整片段的可读进度，收尾后更新为最终值。Dashboard 回放按固定字节范围读取，播放超出当前范围后加载新增片段；暂无可读帧时等待进度更新，错误状态不当作成功片段。热窗口按时间过期，字节超限时从占用最大的通道收缩；非持久模式的查询会报告被淘汰的历史缺口，`ludens perception status` 的 `history.budgetEvictions` 随当前进程实时更新。

## 租约归属与输入 generation

统一常驻状态机在接管时采用宿主当前控制 `epoch`。`PerceptionRuntime` 在启动替换代码前授予 `inputGeneration`，并在等待旧 Python 进程退出前清空它。重载和 `stop()` 会释放当前设备输入（包含并发 CLI 输入），拒绝旧 generation 的调用，同时保留控制 `epoch`、OMP 会话与剩余预算。如果输入清理失败，Host 会交还控制。人工交还（`auto off`）、预算耗尽或设备断连时撤销租约，感知可继续运行但不再执行设备 effect。执行 `stop()` 后须显式运行 `ludens perception reload` 重启；已交还控制时须运行 `ludens auto on` 再次授予设备控制权。
