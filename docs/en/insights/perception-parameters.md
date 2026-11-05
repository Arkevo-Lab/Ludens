# Why Perception Parameters Are Stratified Across Three Layers

When an agent writes `perception.py` inside a workspace, it looks natural at first glance to put every perception knob on the `Perception` class itself — what to capture, how to decode it, and how many times per second (`sample_hz`) to run. We originally exposed `sample_hz = 30.0 # Target rate; tune as needed` right at the top of `core/templates/perception.py`.

During a multi-hour *Animal Crossing: New Horizons* run, that single line quietly broke every sub-second skill the agent tried to build later. This note explains what happened in that run, why we lifted sampling cadence out of agent code into the infrastructure layer, and why perception configuration in Ludens is split across three distinct boundaries instead of living in one place.

## What happened when the agent owned `sample_hz`

At the very beginning of the *Animal Crossing* run, the agent opened `perception.py` to implement `Perception.sample()` over `controller/screen.capture`. Seeing `sample_hz = 30.0 # Target rate; tune as needed`, it immediately rewrote the file as:

```python
"""Low-rate game-screen observation for Animal Crossing."""

class Perception:
    sample_hz = 2.0
```

From the model's point of view on Turn 1, this looked like responsible engineering: *Animal Crossing* is a relaxed life-simulation game, each LLM turn (`observe` -> inference -> tool call) takes 5–10 seconds, and sampling at 30 Hz felt like a waste of CPU and disk.

Two hours later, the agent reached Tom Nook's critter-catching quest. Following the workspace guidelines, it stopped trying to react turn-by-turn and wrote a fast local Python `@capability` (`motion_watch.py:watch_motion`) that polled `Client().observe({"capability": "python/perception.py:Perception.sample"})` in a `time.sleep(0.12)` loop (~8.3 Hz) to detect moth movement and fishing bobber splashes.

It had completely forgotten that on Turn 1 it locked `Perception.sample_hz` to `2.0` Hz:

1. **Downstream starvation.** Even though `watch_motion` polled the timeline every `120 ms`, the resident sampler only produced a new frame every `500 ms` (`190 ms` capture + `310 ms` sleep). A fish bite splash in *Animal Crossing* lasts roughly `500–700 ms`, leaving only one or two sampled frames to distinguish it from a nibble; shorter visual cues can fall entirely between samples.
2. **Misplaced resource thrift.** The model throttled `sample_hz` to save storage and avoid queue buildup, unaware that `ObservationHistory` (`core/python/ludens_tools/_observation_history.py`) already encodes image streams into fragmented H.264 MP4 (`libx264`), evicts the hot window under a fixed time/byte budget, and runs `run_continuously` (`core/python/ludens_tools/_resident.py`) without overlapping or accumulating a backlog when a sample takes longer than one period.
3. **Cross-timescale blindness.** An LLM reasoning at `0.1–0.2 Hz` judges the environment by its own turn cadence, not by the `10–30 Hz` temporal resolution required by the local Python `@capability` closed-loop controllers that consume the same `.ludens/timeline/`.

## The three layers of perception configuration

Fixing this was not just a matter of changing a prompt comment; it clarified who actually owns each category of perception parameter. In Ludens, perception parameters fall into three layers based on **who has the context to change them safely**:

| Layer | Where it lives | Parameters | Owner & rationale |
| --- | --- | --- | --- |
| **1. Agent sensing code** | `perception.py:Perception` (`start`, `sample`, `close`) | Device capture calls, CV preprocessing, structured `{text, data, media, space, sources}` output | **The coding agent.** Only the agent working on the task knows which device channels to read and what semantic features to extract. Scheduling rate is excluded so the agent cannot starve downstream consumers. |
| **2. Workspace operator settings** | `.ludens/settings.json` & Dashboard Perception page | `hotSeconds`, `videoSegmentSeconds`, `videoIdleSeconds` | **The human operator (per workspace).** These tune the trade-off between in-memory hot inspection window and MP4 segment rotation cadence for a specific project, without altering sampling semantics or process safety ceilings. |
| **3. Host infrastructure** | Host environment variables (`LUDENS_PERCEPTION_*`, `LUDENS_VIDEO_*`) | `LUDENS_PERCEPTION_SAMPLE_HZ` (`30`), `LUDENS_PERCEPTION_PERSIST`, `HOT_BYTES` (`1 GiB`), `SEGMENT_SECONDS` (`3600`), `SEGMENT_BYTES` (`256 MiB`), `VIDEO_QUEUE_BYTES` (`32 MiB`), `VIDEO_QUEUE_FRAMES` (`64`), `VIDEO_STREAMS` (`16`), `VIDEO_QUERY_BYTES` (`32 MiB`) | **The platform / host harness.** Temporal resolution ceilings (`30 Hz`) and memory/disk safety bounds protect the host machine and guarantee timeline fidelity across all capabilities. |

## Why some parameters are editable in Dashboard while others stay in infrastructure

A natural follow-up question is: if `hotSeconds`, `videoSegmentSeconds`, and `videoIdleSeconds` are exposed in `.ludens/settings.json` and the Dashboard's Perception Settings panel (`core/src/core/query/perception-config.ts`), why not expose `sampleHz` or `hotBytes` there too — or conversely, why allow editing those three time windows at all?

1. **Why the three time-window settings are operator-editable (`hotSeconds`, `videoSegmentSeconds`, `videoIdleSeconds`)**:
   - They express **inspection and archiving ergonomics** that vary by workflow. When debugging a fast action game, an operator may want a shorter `videoSegmentSeconds` so finalized MP4 chunks rotate quickly, or a longer `hotSeconds` (`10–3600` seconds) so recent raw frames stay deliverable straight from memory without cold MP4 decode.
   - Changing them within their validated integer bounds (`PERCEPTION_LIMITS`) never breaks capability correctness or risks OOM, because the hard byte ceiling (`LUDENS_PERCEPTION_HOT_BYTES = 1 GiB`) still enforces fair eviction underneath regardless of how large `hotSeconds` is set.
2. **Why byte caps, queue limits, and `sample_hz` stay in host infrastructure**:
   - **Byte and queue budgets** (`HOT_BYTES`, `SEGMENT_BYTES`, `VIDEO_QUEUE_BYTES`, `VIDEO_QUERY_BYTES`) are **host resource guardrails**. They depend on the machine's RAM and disk provisioning rather than the game being played; keeping them in host environment variables prevents workspace configs or agents from exhausting host memory.
   - **The sampling rate** (`LUDENS_PERCEPTION_SAMPLE_HZ`, defaulting to `30.0` Hz) defines the **temporal resolution contract** of `.ludens/timeline/`. Because `run_continuously` automatically defers the next tick whenever a single capture takes longer than `1 / sample_hz` (for example, a `190 ms` emulator screenshot naturally runs back-to-back at `~5.2 Hz` without error or queue buildup), `30.0` Hz acts as a zero-sleep ceiling for slow devices and a 30 fps target for fast ones. Lowering it in workspace code only inserts artificial dead time between captures.

## What changed

- `core/python/ludens_tools/_perception.py` now reads `sample_hz` exclusively from `LUDENS_PERCEPTION_SAMPLE_HZ` (default `30.0` Hz via `core/python/ludens_tools/_sampling.py`), ignoring any `sample_hz` attribute on the workspace class.
- `core/templates/perception.py` and `core/templates/AGENTS.md` no longer expose `sample_hz` as a class attribute or invite the agent to "tune as needed"; `AGENTS.md` explicitly warns against adding artificial `sleep` throttling inside `Perception.sample()`.
- The effective `sampleHz` remains visible in `ludens status`, `ludens perception status`, and the Dashboard's read-only runtime status check (`PerceptionRuntimeSnapshot`) as observable infrastructure facts.
