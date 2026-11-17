# 注入收敛为轮首单通道

如果 Agent 只是在终端里一问一答，环境什么时候变化它自己心里有数。但我们的 Agent 运行在一个**以 30Hz 持续采样、按周期持有控制租约**的实时交互环境里：模型每完成一批工具调用，屏幕上可能已经变了样。“模型决策前手里得有最新画面”于是成了硬需求——这篇笔记讲的，就是我们为了满足这个需求搭出来的第二条注入通道，以及为什么最终把它整个删掉。

## 先看原设计是怎么想的

Ludens 扩展曾在 OMP 的循环上挂了两个自动注入通道：

1. **轮首通道**：`before_agent_start` 钩子，每次 prompt 开始时把最新主通道感知记录和采样器状态变迁（`state / codeSHA / error`）作为一条持久化 custom message 交给模型；
2. **批次末通道**：`tool_result` 钩子，等一个工具批次里**最后完成的那个工具**返回时，把最新帧追加到它的结果末尾。

批次末通道的存在有一个看似合理的理由：翻遍 OMP 的钩子，`tool_result` 是唯一一个**在结果持久化和下一次模型请求之前被 await** 的钩子——`turn_end` 只是通知，改不了内容。想保证“模型每次决策前都拿着最新画面”，这里就是唯一能精确卡点的位置（`core/src/core/agent-omp/extension.ts`）。

听起来合理，但实际跑起来暴露出四个明显毛病。

## 毛病在哪

**一、语义污染。** 批次末通道是把截图直接拼进工具结果的 content 里。模型调用 `edit` 改一行代码，收到的却是“修改成功 + 一段感知 JSON + 一张截图”——工具输出和环境观察混在一块，破坏了工具返回值的语义边界。

**二、归因随完成顺序漂移。** 帧拼给批内**最后完成**的工具。同一批 `read` + `bash`，谁后返回谁就带上这帧；两次运行时序稍有不同，同一帧就落在不同的工具结果里。日志归因、会话回放都会被这种随机性干扰。

**三、频率失控。** 自动查询走 latest 模式，时空轴只返回**最新一条**记录（`core/python/ludens_tools/_observation_history.py` 的 `_select`）；而去重只比较“最新主样本 id 变没变”。采样器处于运行态（默认 30Hz）时，两次边界之间必然产生新帧——条件几乎恒真，**每个工具批次都命中**。注入量的大头全在这：一次 300 秒控制周期的模拟里，31 帧注入中有 27 帧来自批次末通道。

**四、只进不出。** 附带图片后的工具结果被持久化进会话历史，而 Ludens 把 provider 图片数量预算设成了 `Infinity`（见 [OMP 后台压缩改造](omp-compaction.md) 里的缓存考量）。帧进了历史就只有等 compaction 才能清掉——而 compaction 本身就是系统里开销最高的操作之一。

## 算一笔账

把这套机制放进 Loop 注入实验台（控制台「开发者」面板，`?view=dev&panel=loop`）之后，数字一目了然。同一组参数（300s 预算、30 请求上限、每轮 8 个工具批次、单图约 1.1k token）：

| 策略 | 注入帧数 | 累计交付帧 token | 峰值 wire | 保留感知占峰值 |
| --- | --- | --- | --- | --- |
| 含批次末通道（旧行为） | 31 | 43.4k | 70.2k | **60%** |
| 仅轮首通道（现行） | 4 | 5.6k | 33.8k | 17% |

这些数值来自本地模拟，并非 agent 实际运行的测量。累计交付帧 token 统计图片和帧文本载荷，不含状态通知。保留感知包含状态通知，可能因压实而缩小。图表在受影响请求之前标出压实。

六成上下文花在模型从没主动要求过的截图上，而这些帧的去留取决于一段与任务完全无关的采样节拍。

## 怎么改的

2026-10-29 起批次末通道整体删除：

- 自动交付只在 `before_agent_start`（prompt 开始）发生，状态变迁 + 新记录的语义不变；
- **轮内需要画面，模型自己调 `observe`**——它本来就是一个一等工具，常规最新读取返回去噪后的精简记录，按 id / 时刻 / 范围 / 能力查询时则附带完整的分页与可用范围元数据（`query`、`hasMore`、`nextAfter`、`availability`）；
- 显式 `observe` 与原生工具图片各自开交付收据（`origin` 为 `explicit` / `tool_result`），trace 归因不丢；`tool_result` 钩子只登记原生工具图片的交付事实，不再改写任何工具结果。

同一个钩子也按同样的预算纪律携带事件池摘要：`before_agent_start` 仅在 `pendingInbound > 0` 时追加紧凑的 `{ eventPool: { pendingInbound, items } }` 摘要，列出每条待处理入站事件的 id、kind、可选 title 与 72 字符单行预览。事件池空闲时不贡献任何字节，前缀 KV 缓存因此在轮次之间保持有效；完整正文通过 `event_pool({ action: "read" })` 按需拉取，并默认标记已读。

“决策前有新画面”的诉求没有消失，只是换了个持有人：以前是宿主在每次边界被动追加，现在是模型按需拉取。轮边界的采样器状态通知仍在——采样器停了模型不会被误导成“没新帧”，显式 `observe` 的错误码（`UNAVAILABLE` 等）就是明确信号。

## 进一步收敛：精简包络、可编程 `Loop.inject` 与 1:1 输入检视

删掉批次末通道管住了注入**频率**，但早期轮首观测消息（`customType: "ludens-observation"`，对应 `observation_context` 回执）的单次 JSON 里仍带着不少内部运行遥测噪声（`queryId`、`generation`、64 字符 `codeSHA`、单调时钟 `sampling`、`sampledAt`、Baseware 原始 `sources` 以及 `media[*].id`）。随后我们把轮首观测载荷契约也做了端到端收敛：

1. **精简感知包络（`perceptionInput`）**：常规最新读取只交付 `{ ok: true, records: [{ id, sequence, recordedAt, capability?, text?, data?, space?, effect?, transition? }] }`（默认主通道 `python/perception.py:Perception.sample` 省去重复的 `capability` 字段），按需附加 `perceptionState`、`eventPool`（`pendingInbound > 0` 时）或 `loopFault`（`loop.py` 异常回退时）。分页与可用性字段仅在显式历史/范围查询或失败读取（`!ok`）时出现。
2. **工作区 `loop.py` 的 `Loop.inject(ctx)` 定制**：当不同轮次需要差异化的上下文策略时，工作区可在 `loop.py` 中覆写 `inject(self, ctx: TurnContext)`——既可基于 `inj = ctx.default_inject()` 修改可变 `TurnInjection`（如在纯代码修改轮设置 `inj.attach_images = False` 省去视觉帧挂载，或向 `inj.extra` 追加领域摘要，对应 `structured` 模式），也可返回自定义 `dict`（`custom_json`）、`str`（`custom_text`），或返回 `None`（`none` 模式，本轮完全跳过轮首观测消息与图片挂载）。一旦 `loop.py` 抛错，`LoopRuntime` 会发出 `loop_fault`、自动回退到内置精简注入，并把 `loopFault` 带进下一轮载荷以便自愈修复。
3. **1:1 实时输入检视（`deliveredPayload`）**：`extension.ts` 在 `observation_context` 事件回执上直接记录经 `Loop.inject` 处理后的最终 `deliveredPayload`、`injectionMode` 与 `attachImages`，控制台**运行**页（`?view=live`，「查看传入模型的 Input 详情」）直接按 `deliveredPayload` 1:1 渲染，不再二次拼装或重复展示旧式 `snapshot`，确保面板所见与实际送达模型的观测文本载荷完全一致。

## 权衡与留档

代价是模型可能“忘记看”：专心写代码时它不会主动 `observe`，轮与轮之间屏幕变了它未必立刻知道。我们接受这一点，理由有三：轮首通道保证每个新轮次都从最新状态出发；状态变迁在轮边界必然送达；真正依赖实时画面的策略本来就该显式观察，而不是靠工具结果里顺带附上的画面。

旧行为在实验台里保留为一张标着“已移除 · 仅供对照”的对照预设，和现行策略并排跑同一组参数。以后如果需要评估自动注入策略，可以先对比这组 60% 与 17% 的开销差异。
