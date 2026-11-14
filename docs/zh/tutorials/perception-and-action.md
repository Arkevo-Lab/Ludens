# 感知、执行与性能调优

与其让耗时的多模态模型每一帧都参与“看图再点击”，Ludens 在每个工作区中运行一个常驻 Python 进程（`perception.py`）。在**自主运行**期间，它持续采集目标画面、录制 30 Hz fMP4 视频到 `.ludens/timeline/`，并在内存中运行可随时热重载的闭环状态机。

关于为什么采样率、保留窗口与内存上限被严格拆分为三层，参见 [为什么感知参数要跨三层分治](../insights/perception-parameters.md)。

## 1. 编写常驻 `perception.py`

工作区根目录的 `perception.py` 支持两种入口形式：定义一个包含 `start(self, context)`、带有 `@observe @record @capability` 的 `sample(self)` 与 `close(self)` 方法的 `Perception` 类；或者只声明一个顶层同步函数并标注 `@observe @record @capability`。

请**不要**在 `Perception` 类上定义 `sample_hz` 属性，也**不要**在 `sample()` 内部人为添加 `time.sleep(...)` 降频。采样率统一由宿主基础设施环境变量 `LUDENS_PERCEPTION_SAMPLE_HZ`（默认 `30.0` Hz）控制；单帧采集耗时较长时，调度器会自动延后下一拍，绝不会重叠并发。

`sample()`（以及状态机内部其余状态函数）返回的字典允许包含 `text`、`data`、`media`、`sampledAt`、`sources`、`space`、`timeline`、`effect` 与 `transition` 字段。

### 闭环状态机示例

`perception.py` 中的所有状态函数均运行在同一进程内，通过 `self` 零拷贝共享上下文。返回结果中可通过 `effect` 立即触发能力调用（传单个对象 `{"id": "...", "arguments": {...}}` 或数组），并通过 `transition` 切换下一状态（传目标名称或 `{"to": "<target>", "arguments": {...}}`）：

```python
from ludens_tools import Client, capability, observe, record

class Perception:
    def start(self, context: dict) -> None:
        self.client = Client()
        self.alert_streak = 0

    @observe
    @record
    @capability
    def sample(self) -> dict:
        """采集主控制器画面，统计连续异常状态并在本地触发执行动作。"""
        capture = self.client.call("controller/screenshot", {})
        observations = capture.get("observations", [])
        # 将 _detect_alert 替换为工作区实际的视觉检测逻辑
        alert_active = self._detect_alert(capture)
        self.alert_streak = self.alert_streak + 1 if alert_active else 0

        response: dict = {
            "text": f"state=watch streak={self.alert_streak}",
            "data": {"state": "watch", "alert": alert_active, "streak": self.alert_streak},
            "media": observations,
        }
        if self.alert_streak >= 3:
            response["effect"] = {"id": "controller/relay.trigger", "arguments": {"channel": 1}}
            response["transition"] = {
                "to": "python/perception.py:Perception.cooldown",
                "arguments": {"remaining": 15},
            }
        return response

    @capability
    def cooldown(self, remaining: int = 15) -> dict:
        """保持高频观测的同时进行冷却计数，防止短时间内重复触发。"""
        self.alert_streak = 0
        if remaining <= 1:
            return {"text": "state=watch", "transition": "python/perception.py:Perception.sample"}
        return {
            "text": f"state=cooldown remaining={remaining - 1}",
            "transition": {
                "to": "python/perception.py:Perception.cooldown",
                "arguments": {"remaining": remaining - 1},
            },
        }

    def close(self) -> None:
        pass

    def _detect_alert(self, capture: dict) -> bool:
        return False
```

可通过 CLI（`ludens perception`）或 Python（`Client().state()` / `Client().transition(...)`）实时查看与切换状态机：

```sh
ludens perception status
ludens perception state
ludens perception transition python/perception.py:Perception.cooldown --args '{"remaining":10}'
ludens perception inject on
```

保持 `ludens perception inject on` 开启时，Shiori 会在每轮开始时自动接收一次最新的主通道观测，同时保持工具返回体精简以保护 Prompt 缓存命中率；若希望完全改为按需检索，可关闭为 `ludens perception inject off`。

## 2. 热重载与 `inputGeneration` 租约隔离

修改保存 `perception.py` 或其导入的任意工作区 `.py` 模块时，系统会自动热重载常驻进程；如果更新的是非 Python 资源文件（如权重或模板图片），可手动触发重载：

```sh
ludens perception reload
```

在**自主运行**期间发生重载时，宿主会在当前控制周期 `epoch` 下递增 `inputGeneration`，立即把旧版本持有的设备输入归零并取消未完成动作，再无缝切换到新版状态机——整个过程不会丢失当前 `epoch`、时间/请求预算或 Shiori 会话线程。

## 3. 查询 `.ludens/timeline/`（`Client.observe()` 与 `ludens observe`）

在**自主运行**期间，每次 `@record` 采样都会将元数据与 30 Hz H.264 分片 fMP4 视频写入 `.ludens/timeline/`；即使切回**手动待命**，常驻进程也会保持待命状态以响应只读查询。

`Client().observe(query)` 支持以下查询组合（`limit` 范围 `1..64`）：

| 查询模式 | 参数示例 | 行为说明 |
| --- | --- | --- |
| 最新帧轮询 | `{"limit": 8, "ifNoneMatchSequence": seq}` | 获取最新若干条观测；若最新序号仍等于 `seq` 则直接返回 `{"unchanged": True}` |
| 时间点定位 | `{"at": "2026-04-01T10:00:00Z"}` | 获取不晚于该带时区 ISO 时间戳的最新记录（不可与 `start`/`end`/`after` 同用） |
| 时间区间分页 | `{"start": "...", "end": "...", "limit": 32}` | 按时间区间分页读取历史记录（可附带 `after` 序号游标） |
| 精确 ID 或全通道 | `{"id": "<record-id>"}` 或 `{"capability": "*"}` | 按记录 ID 精确读取（不可与时间/序号过滤并用），或查询所有 `@record` 能力产生的时间轴记录 |

对应的终端命令：

```sh
ludens observe --limit 5 --images
ludens observe --capability '*' --start 2026-04-01T10:00:00Z --end 2026-04-01T10:05:00Z
ludens observe --id <record-id>
```

在 Python 中建议检查 `res["ok"]`，常见返回错误码（`res["error"]["code"]`）包括：

- `UNAVAILABLE`：常驻感知进程未运行、已报错停止或在查询途中被新世代替换
- `NOT_READY`：进程仍在 `loading` 阶段，或当前世代尚未产出第一条主通道记录
- `EXPIRED`：非持久化内存窗口模式（`LUDENS_PERCEPTION_PERSIST=0`）下请求的历史区间已被淘汰
- `NOT_FOUND`：找不到匹配指定 `id` 或 `at` 时间点的记录
- `QUERY_FAILED`：查询参数非法或媒体解码失败

如需按窗口回放整段连续帧（例如配合 `with record_window() as win:` 或某条失败样本的 `record_id`），调用 `Client().replay(win)` 或 `Client().replay(around=record_id, before_seconds=2.0, after_seconds=2.0)`。

## 4. 存储保留参数与采样环境变量

工作区级别的保留策略存放在 `.ludens/settings.json`，可在控制台 **配置（Config）**（`?view=perception`）的 **感知录制参数（Perception Recording）** 页签安全调整：

| 配置键（`.ludens/settings.json`） | 环境变量回退 | 合法范围 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `hotSeconds` | `LUDENS_PERCEPTION_HOT_SECONDS` | `10..3600` | `600` | 热内存窗口中保留近期原始记录的秒数 |
| `videoSegmentSeconds` | `LUDENS_VIDEO_SEGMENT_SECONDS` | `10..3600` | `300` | `.ludens/timeline/video/*.mp4` 视频分片的轮转时长（秒） |
| `videoIdleSeconds` | `LUDENS_VIDEO_IDLE_SECONDS` | `1..600` | `10` | 视频轨空闲多少秒后自动封口落盘 |

宿主机全局资源上限与采样频率变量（在启动 `ludens up` 或 `ludens run` 前由宿主机环境指定）：

- `LUDENS_PERCEPTION_SAMPLE_HZ`：目标采样率上限（默认 `30.0` Hz）
- `LUDENS_PERCEPTION_PERSIST`：是否持久化 `.ludens/timeline/`（默认 `1`/`true`；设为 `0`/`false` 仅保留热内存窗口）
- `LUDENS_PERCEPTION_HOT_BYTES`（`1 GiB`）、`LUDENS_PERCEPTION_SEGMENT_SECONDS`（`3600`）、`LUDENS_PERCEPTION_SEGMENT_BYTES`（`256 MiB`）：热窗口与分片大小限制
- `LUDENS_VIDEO_QUEUE_BYTES`（`32 MiB`）、`LUDENS_VIDEO_QUEUE_FRAMES`（`64`）、`LUDENS_VIDEO_STREAMS`（`16`）、`LUDENS_VIDEO_QUERY_BYTES`（`32 MiB`）：fMP4 编码队列与回放解码内存保护上限

## 5. 多模态传输、图片 URL 外置与性能调优

高频传递内联 Base64 图像会显著放大请求体积并增加连接开销。可通过控制台 **配置** -> **连接与多模态传输**（`?view=perception`）、全局 **设置** -> **模型与传输**（`?view=settings`）或 `ludens config set` 调整连接策略：

```sh
ludens config set defaults.connection.openaiWebsockets auto
ludens config set defaults.connection.cacheRetention long
ludens config set defaults.connection.appendOnlyContext auto
ludens config set defaults.connection.imageUrls.enabled true
ludens config set defaults.connection.imageUrls.backends '["provider-files","cloudflared","tailscale","uguu","tmpfiles","litterbox","0x0","catbox"]'
```

各字段合法取值如下：

- `openaiWebsockets`：`auto`、`on` 或 `off`
- `cacheRetention`：`auto`、`short`、`long` 或 `none`
- `appendOnlyContext`：`auto`、`on` 或 `off`
- `imageUrls.enabled`：`true` 或 `false`
- `imageUrls.backends`：从 `"provider-files"`、`"cloudflared"`、`"tailscale"`、`"uguu"`、`"tmpfiles"`、`"litterbox"`、`"0x0"`、`"catbox"`、`"pinggy"`、`"localhost-run"` 中按优先级排列的回退链

运行一段时间后，可结合控制台两个专职视图持续调优：

- **性能（Performance，`?view=perf`）**：观测已完成轮次数、P95 与中位轮次延迟、Prompt 缓存命中率、解码速率、占空比、采样速率、自主运行占比以及单请求调用链。
- **上下文容量推演（Loop Simulator）**（在 **配置 -> 上下文容量推演** 页签或 **开发者** `?view=dev` 打开）：在启动长周期任务前，基于不同预设模拟系统提示词、对话轮次、感知文本/图像与 `compactionThreshold` 对上下文峰值 Token 的影响。

最后一步，前往 [控制台使用与排障](console-and-debugging.md)，掌握控制台全局操作、能力验证排查与守护进程健康检查方法。
