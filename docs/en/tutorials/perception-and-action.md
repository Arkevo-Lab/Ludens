# Perception, Action & Performance Tuning

Instead of burning slow multimodal LLM round trips on high-frequency visual checks, Ludens runs a persistent Python worker in each workspace (`perception.py`). During **Auto Run**, it continuously captures frames, records 30 Hz fMP4 video into `.ludens/timeline/`, and executes local state machines with automatic hot-reload.

For background on why sampling cadence, operator windows, and host resource limits live at different layers, see [Why Perception Parameters Are Stratified Across Three Layers](../insights/perception-parameters.md).

## 1. Writing Resident `perception.py`

A workspace `perception.py` must expose either a `Perception` class with `start(self, context)`, `@observe @record @capability` method `sample(self)`, and `close(self)`, or a single top-level synchronous `@observe @record @capability` function.

Do **not** set a `sample_hz` attribute on `Perception` and do **not** put `time.sleep(...)` throttling inside `sample()`. Sampling frequency is governed by the host infrastructure (`LUDENS_PERCEPTION_SAMPLE_HZ`, default `30.0` Hz), and the scheduler automatically waits for slow captures without overlapping ticks.

The `sample()` method (and any state target inside the resident worker) returns a dictionary whose allowed top-level keys are `text`, `data`, `media`, `sampledAt`, `sources`, `space`, `timeline`, `effect`, and `transition`.

### Closed-Loop State Machine Example

All states inside `perception.py` execute in the same Python process, sharing `self` attributes zero-copy. You can emit immediate capability calls via `effect` (`{"id": "...", "arguments": {...}}` or a list of effect objects) and switch active state via `transition` (`"<target>"` or `{"to": "<target>", "arguments": {...}}`):

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
        """Capture a frame from the primary controller, track status transitions, and trigger alerts locally."""
        capture = self.client.call("controller/screenshot", {})
        observations = capture.get("observations", [])
        # Replace inspect_alert_badge with your workspace's CV/detector logic
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
        """Hold off repeat triggers while continuing observation sampling."""
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

Inspect or switch the live state machine from CLI (`ludens perception`) or Python (`Client().state()` / `Client().transition(...)`):

```sh
ludens perception status
ludens perception state
ludens perception transition python/perception.py:Perception.cooldown --args '{"remaining":10}'
ludens perception inject on
```

Keep `ludens perception inject on` enabled when Shiori should receive freshly sampled primary observations once per turn start while keeping tool replies lean and cache-friendly; toggle `ludens perception inject off` if you only want explicit `ludens observe` queries.

## 2. Hot-Reload & `inputGeneration` Lease Isolation

Saving `perception.py` or any `.py` module imported by it automatically reloads the resident Python worker. If you modify non-Python assets (such as template images or detector weights on disk), trigger a manual reload:

```sh
ludens perception reload
```

During **Auto Run**, reloading increments `inputGeneration` under the active Control Cycle `epoch`, immediately zeroes held inputs and cancels in-flight actions from the old generation, and swaps in the new code without interrupting budgets or your Shiori thread.

## 3. Querying `.ludens/timeline/` (`Client.observe()` & `ludens observe`)

During **Auto Run**, every `@record` sample writes structured metadata and compressed 30 Hz H.264 fragmented MP4 segments under `.ludens/timeline/`. Even in **Manual Standby**, the resident worker stays warm to answer read-only history queries.

Supported query parameters for `Client().observe(query)` (`limit` `1..64`):

| Query Pattern | Parameters | Behavior |
| --- | --- | --- |
| Latest frames (poll-friendly) | `{"limit": 8, "ifNoneMatchSequence": seq}` | Returns up to `limit` newest frames, or `{"unchanged": True}` if sequence matches `seq` |
| Point lookup | `{"at": "2026-04-01T10:00:00Z"}` | Returns the record at or immediately before the ISO timestamp (cannot combine with `start`/`end`/`after`) |
| Time range | `{"start": "...", "end": "...", "limit": 32}` | Pages through records between two ISO timestamps (`after` optionally resumes from a sequence) |
| Exact ID / channel | `{"id": "<record-id>"}` or `{"capability": "*"}` | Fetches a specific record ID (cannot combine with time/sequence filters) or expands across all recorded capabilities |

CLI equivalent:

```sh
ludens observe --limit 5 --images
ludens observe --capability '*' --start 2026-04-01T10:00:00Z --end 2026-04-01T10:05:00Z
ludens observe --id <record-id>
```

Check `res["ok"]` in Python when reading observations defensively. Typical `error.code` values from the host subsystem are:

- `UNAVAILABLE`: Perception worker is stopped, in an error state, or replaced mid-query
- `NOT_READY`: Worker is still `loading` or no sample has completed in the active generation yet
- `EXPIRED`: Requested non-latest interval already evicted from the non-persistent memory buffer (`LUDENS_PERCEPTION_PERSIST=0`)
- `NOT_FOUND`: No record matches the requested `id` or `at` timestamp
- `QUERY_FAILED`: Invalid query parameter combination or media decode error

To inspect a contiguous slice of frames (for example after `with record_window() as win:` or from a timeline `record_id`), use `Client().replay(win)` or `Client().replay(around=record_id, before_seconds=2.0, after_seconds=2.0)`.

## 4. Storage Retention & Sampling Environment Variables

Operator retention windows live in `.ludens/settings.json` and can be adjusted safely from Console **Config** (`?view=perception`) under **Perception Recording**:

| Setting Key (`.ludens/settings.json`) | Env Fallback | Valid Range | Default | Purpose |
| --- | --- | --- | --- | --- |
| `hotSeconds` | `LUDENS_PERCEPTION_HOT_SECONDS` | `10..3600` | `600` | Seconds of raw recent records kept in the hot memory window |
| `videoSegmentSeconds` | `LUDENS_VIDEO_SEGMENT_SECONDS` | `10..3600` | `300` | Rotation duration (seconds) for `.ludens/timeline/video/*.mp4` segments |
| `videoIdleSeconds` | `LUDENS_VIDEO_IDLE_SECONDS` | `1..600` | `10` | Idle timeout before flushing/sealing an inactive video track |

Host infrastructure resource ceilings and rate controls (set in the host environment when starting `ludens up` or `ludens run`):

- `LUDENS_PERCEPTION_SAMPLE_HZ`: Target sampling ceiling (`30.0` by default)
- `LUDENS_PERCEPTION_PERSIST`: Persistent `.ludens/timeline/` storage (`1`/`true` by default; `0`/`false` for RAM-only hot window)
- `LUDENS_PERCEPTION_HOT_BYTES` (`1 GiB`), `LUDENS_PERCEPTION_SEGMENT_SECONDS` (`3600`), `LUDENS_PERCEPTION_SEGMENT_BYTES` (`256 MiB`): Timeline segment budgets
- `LUDENS_VIDEO_QUEUE_BYTES` (`32 MiB`), `LUDENS_VIDEO_QUEUE_FRAMES` (`64`), `LUDENS_VIDEO_STREAMS` (`16`), `LUDENS_VIDEO_QUERY_BYTES` (`32 MiB`): fMP4 encoder and replay decode guardrails

## 5. Multimodal Transport, Image URLs & Performance Tuning

Large inline base64 images increase request payload size and affect transport reliability. Tune Shiori's multimodal connection in Console **Config** -> **Connection & Transport** (`?view=perception`), globally in **Settings** -> **Model & Transport** (`?view=settings`), or via `ludens config set`:

```sh
ludens config set defaults.connection.openaiWebsockets auto
ludens config set defaults.connection.cacheRetention long
ludens config set defaults.connection.appendOnlyContext auto
ludens config set defaults.connection.imageUrls.enabled true
ludens config set defaults.connection.imageUrls.backends '["provider-files","cloudflared","tailscale","uguu","tmpfiles","litterbox","0x0","catbox"]'
```

Supported values per field:

- `openaiWebsockets`: `"auto"`, `"on"`, or `"off"`
- `cacheRetention`: `"auto"`, `"short"`, `"long"`, or `"none"`
- `appendOnlyContext`: `"auto"`, `"on"`, or `"off"`
- `imageUrls.enabled`: `true` or `false`
- `imageUrls.backends`: ordered fallback list selected from `"provider-files"`, `"cloudflared"`, `"tailscale"`, `"uguu"`, `"tmpfiles"`, `"litterbox"`, `"0x0"`, `"catbox"`, `"pinggy"`, `"localhost-run"`

After running cycles, review latency and context behavior in Console:

- **Performance (`?view=perf`)**: Track completed turns, P95 and median turn latency, prompt cache hit rate, decode speed, duty cycle, sampler rate, autonomy ratio, and per-request trace history.
- **Loop Simulator** (**Config -> Loop Simulator** tab or **Developer** `?view=dev`): Model how system prompts, conversation turns, perception text/images, and `compactionThreshold` affect peak context tokens across presets before running long overnight tasks.

Next, learn how to operate every Console view and diagnose stalled control cycles or failed checks in [Console Operations & Debugging](console-and-debugging.md).
