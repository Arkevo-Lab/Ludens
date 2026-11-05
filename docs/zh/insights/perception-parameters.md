# 为什么感知层参数要分成三层管理

当 Agent 在工作区里编写 `perception.py` 时，把所有和感知相关的旋钮——采什么数据、怎么解码、每秒采多少次（`sample_hz`）——全都放在 `Perception` 类身上，乍看之下再自然不过。我们最初也是这么做的，直接在 `core/templates/perception.py` 顶部放了一行 `sample_hz = 30.0 # Target rate; tune as needed`。

但在一次长达数小时的《集合啦！动物森友会》实机运行中，正是这行“按需调优”悄无声息地废掉了 Agent 后续编写的所有亚秒级闭环技能。这篇笔记复盘那次运行里发生了什么、为什么我们把采样频率从 Agent 代码上浮到基础设施层，以及为什么 Ludens 的感知参数要拆成三道边界来管理。

## 把 `sample_hz` 交给 Agent 时发生了什么

在动森长跑的第 1 回合，Agent 打开 `perception.py`，准备基于 `controller/screen.capture` 实现 `Perception.sample()`。看到模板里的 `sample_hz = 30.0 # Target rate; tune as needed` 后，它顺手把代码改成了：

```python
"""Low-rate game-screen observation for Animal Crossing."""

class Perception:
    sample_hz = 2.0
```

站在模型第 1 回合的视角看，这简直是“极具工程素养”的省资源操作：动森是个慢节奏种田游戏，大模型每跑一轮（`observe` -> 推理 -> 工具调用）都要 5～10 秒，按 30 Hz 采样岂不是白白消耗 CPU 和磁盘？

两个小时后，游戏推进到 Tom Nook 的生物收集支线。Agent 按照工作区指南，不再尝试用回合制硬点抓虫，而是写了一个高频本地 Python `@capability`（`motion_watch.py:watch_motion`），在内部用 `time.sleep(0.12)`（约 `8.3 Hz`）循环调用 `Client().observe({"capability": "python/perception.py:Perception.sample"})`，试图检测飞蛾位移和钓鱼浮漂咬钩水花。

它早已彻底忘了自己在第 1 回合把 `Perception.sample_hz` 锁死在了 `2.0` Hz：

1. **下游能力被静默饿死。** 尽管 `watch_motion` 每 `120 ms` 就去查一次时空轴，但底层的常驻采样进程每 `500 ms` 才吐出一帧新图（`190 ms` 截屏耗时 + `310 ms` 人工休眠）。动森里鱼咬钩的水花窗口大约持续 `500～700 ms`，只能留下一两帧采样画面来区分真正咬钩与试探；更短的视觉线索则可能整段落在两次采样之间。
2. **错位的“省资源”直觉。** 模型调低帧率是怕撑爆存储或造成队列堆积，却不知道 `ObservationHistory`（`core/python/ludens_tools/_observation_history.py`）底层已经把图像流实时编码为分片 H.264 MP4（`libx264`）、按固定时间与字节预算自动淘汰热窗口，而且 `run_continuously`（`core/python/ludens_tools/_resident.py`）天然带有非重叠背压——当单次截屏慢于目标周期时，下一帧只会紧接着顺延执行，绝不会并发重叠或堆积队列。
3. **跨时间尺度的视野盲区。** 大模型自己在 `0.1～0.2 Hz` 的回合尺度上思考，很容易拿自己的看图频率去推断环境所需的采样率，却忽略了同一条 `.ludens/timeline/` 还要喂给下游 `10～30 Hz` 的 Python `@capability` 闭环控制器。

## 感知参数的三层边界

解决这个问题不能只靠改一句注释，它逼我们厘清了一个核心架构问题：**每一类感知参数到底应该由谁拍板？** 在 Ludens 中，感知相关配置按**谁拥有安全修改它的完整上下文**划分为三层：

| 层级 | 所在位置 | 包含参数 | 持有人与划分依据 |
| --- | --- | --- | --- |
| **1. Agent 感知逻辑层** | `perception.py:Perception`（`start`、`sample`、`close`） | 设备截屏/传感器调用、CV 预处理、结构化 `{text, data, media, space, sources}` 输出载荷 | **工作区编码 Agent。** 只有正在做任务的 Agent 知道该读哪个设备通道、提取什么语义特征。调度频率不在此层暴露，防止 Agent 因局部节俭偏见饿死下游能力。 |
| **2. 工作区操作员配置层** | `.ludens/settings.json` 与 Dashboard「感知」面板 | `hotSeconds`、`videoSegmentSeconds`、`videoIdleSeconds` | **人类操作员（按工作区粒度）。** 用于按具体项目调节内存热窗口保留时长与 MP4 分段滚动节奏的回放/调试体验，不改变采样率语义，也不触碰进程安全上限。 |
| **3. 宿主基础设施层** | 宿主环境变量（`LUDENS_PERCEPTION_*`、`LUDENS_VIDEO_*`） | `LUDENS_PERCEPTION_SAMPLE_HZ`（`30`）、`LUDENS_PERCEPTION_PERSIST`、`HOT_BYTES`（`1 GiB`）、`SEGMENT_SECONDS`（`3600`）、`SEGMENT_BYTES`（`256 MiB`）、`VIDEO_QUEUE_BYTES`（`32 MiB`）、`VIDEO_QUEUE_FRAMES`（`64`）、`VIDEO_STREAMS`（`16`）、`VIDEO_QUERY_BYTES`（`32 MiB`） | **平台 / 宿主底座。** 时间分辨率上限（`30 Hz`）与内存/磁盘安全护栏负责保护宿主机并保证所有下游能力的时空轴保真度。 |

## 为什么有些参数允许在 Dashboard 编辑，有些必须留在基础设施层

顺着这张表自然会问：既然 `hotSeconds`、`videoSegmentSeconds` 和 `videoIdleSeconds` 放进了 `.ludens/settings.json` 并允许在 Dashboard「感知」页面（`core/src/core/query/perception-config.ts`）可视化编辑，为什么不把 `sampleHz` 或 `hotBytes` 也放进去——或者反过来，为什么单单开放那三个时间窗口参数？

1. **为什么三个时间窗口参数开放给操作员编辑（`hotSeconds`、`videoSegmentSeconds`、`videoIdleSeconds`）**：
   - 它们调节的是**因任务而异的回放与核查体验**。调试快节奏动作游戏时，操作员可能希望调小 `videoSegmentSeconds` 让 MP4 分片更快封口落盘，或者调大 `hotSeconds`（`10～3600` 秒）让最近原始帧直接留在内存热窗口里免去冷视频解码。
   - 在合法的整数秒范围内（`PERCEPTION_LIMITS`）怎么调这三个值，都不会破坏下游能力的正确性，也不会把进程搞 OOM——因为底层的硬字节上限（`LUDENS_PERCEPTION_HOT_BYTES = 1 GiB`）始终在兜底，无论 `hotSeconds` 设多大，超预算时最大通道都会优先缩窗。
2. **为什么字节上限、队列深度与 `sample_hz` 必须留在宿主基础设施层**：
   - **字节与队列预算**（`HOT_BYTES`、`SEGMENT_BYTES`、`VIDEO_QUEUE_BYTES`、`VIDEO_QUERY_BYTES`）是**宿主机物理护栏**。它们取决于机器本身的内存和磁盘容量，而不是玩的是什么游戏；留在宿主环境变量里可以防止工作区配置或 Agent 失手耗尽宿主机内存。
   - **采样率**（`LUDENS_PERCEPTION_SAMPLE_HZ`，默认为 `30.0` Hz）定义的是 `.ludens/timeline/` 的**时间分辨率契约**。由于 `run_continuously` 在单次采样耗时超过 `1 / sample_hz` 时会自动顺延而不重叠（例如模拟器单次截屏耗时 `190 ms` 时，采样器天然以约 `5.2 Hz` 零休眠全速连采，不会报错也不会积压），`30.0` Hz 对慢速设备而言就是“零额外空转等待”的上限，对快速设备则是标准的 30 帧上限。在工作区代码里调低它，唯一的效果就是在两次截屏之间硬塞进毫无意义的休眠盲区。

## 怎么改的

- `core/python/ludens_tools/_perception.py` 现在只从宿主环境变量 `LUDENS_PERCEPTION_SAMPLE_HZ`（通过 `core/python/ludens_tools/_sampling.py`，默认 `30.0` Hz）读取频率，不再读取工作区 `Perception` 类上的 `sample_hz` 属性。
- `core/templates/perception.py` 与 `core/templates/AGENTS.md` 移除了 `sample_hz` 类属性及“按需调优（`tune as needed`）”提示，并在 `AGENTS.md` 中明确禁止在 `Perception.sample()` 内人为加入 `sleep` 降频。
- 实际生效的 `sampleHz` 继续通过 `ludens status`、`ludens perception status` 以及 Dashboard 的只读运行态核查（`PerceptionRuntimeSnapshot`）作为可观测的基础设施事实对外暴露。
