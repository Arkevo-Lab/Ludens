#!/usr/bin/env python3
"""Offline dual-stream recording soak. Writes only to a fresh output directory."""

import argparse
import base64
from datetime import datetime, timezone
from io import BytesIO
import json
import os
from pathlib import Path
import statistics
import sys
import subprocess
import tempfile
import time

from PIL import Image, ImageChops, ImageDraw, ImageStat
from ludens_tools._observation_history import ObservationHistory
from ludens_tools import current_trial


def picture(index, channel):
    image = Image.new("RGB", (320, 240), (30, 50 + channel * 30, 80))
    draw = ImageDraw.Draw(image)
    # Moving edges plus small text exercise interframe compression and legibility.
    x = (index * 3 + channel * 13) % 280
    draw.rectangle((x, 80, x + 35, 120), fill=(220, 90, 30))
    draw.text((5, 5), f"Frame {index:05d} / screen {channel}", fill=(235, 240, 250))
    output = BytesIO()
    image.save(output, format="PNG", compress_level=1)
    return image, output.getvalue()


def rss_bytes():
    return int(subprocess.check_output(["ps", "-o", "rss=", "-p", str(os.getpid())], text=True).strip()) * 1024


# Perf budgets: the suite exits non-zero when any of them is violated.
VIDEO_STORAGE_BUDGETS = {
    "realtime_factor": 0.98,  # pacing and GC tolerance; sustained realtime means >= 0.98
    "cold_frame_ms": 1000.0,
    "max_decode_error": 24.0,
    "peak_rss_mib": 1024.0,
}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path)
    parser.add_argument("--records", type=int, default=2400)
    parser.add_argument("--rate", type=float, default=30)
    arguments = parser.parse_args()
    trial = current_trial() if os.environ.get("LUDENS_BENCH_TRIAL_ID") else None
    if arguments.output is None:
        if trial is None:
            arguments.output = Path(tempfile.mkdtemp(prefix="ludens-perf-video-")) / "recording-workspace"
        else:
            arguments.output = trial.artifacts / "recording-workspace"
    if arguments.records < 2 or arguments.rate <= 0:
        parser.error("--records must be at least 2 and --rate must be positive")
    if trial:
        trial.conditions(records=arguments.records, sample_hz=arguments.rate, streams=2)
        trial.limitations("Synthetic images; RSS is sampled. Cold decode measures recorded frames, not a live device.")
    arguments.output.mkdir(parents=True, exist_ok=False)
    os.environ["LUDENS_PERCEPTION_HOT_BYTES"] = "1048576"
    os.environ["LUDENS_PERCEPTION_HOT_SECONDS"] = "1"
    history = ObservationHistory(arguments.output, sample_hz=arguments.rate)
    saved, points, png_bytes = [], [], 0
    started = time.monotonic()
    sampling = {"clock": "soak", "startedAtMs": 0, "finishedAtMs": 1}
    try:
        for index in range(arguments.records):
            media = []
            for channel in range(2):
                _, raw = picture(index, channel)
                png_bytes += len(raw)
                media.append({"mediaType": "image/png", "data": base64.b64encode(raw).decode()})
            at = datetime.fromtimestamp(1_793_102_400 + index / arguments.rate, timezone.utc).isoformat()
            record = history.append({"media": media}, "soak", sampling, at)
            if index % 600 == 0 or index == arguments.records - 1:
                saved.append((index, record["id"]))
            if index % 100 == 0 or index == arguments.records - 1:
                points.append({"record": index, "rssBytes": rss_bytes(), "hotBytes": history.hot_bytes,
                               **history._video.metrics()})
            # Coarse sleep plus a short spin: time.sleep alone overshoots by ~1 ms per wake.
            deadline = started + (index + 1) / arguments.rate
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    break
                if remaining > 0.002:
                    time.sleep(remaining - 0.001)
    finally:
        loop_done = time.monotonic()
        history.close()
    encode_seconds = loop_done - started
    encoded = sum(path.stat().st_size for path in arguments.output.rglob("*.mp4"))
    frames, maximum_error = 0, 0
    cold_started = time.monotonic()
    cold = ObservationHistory(arguments.output)
    try:
        for index, record_id in saved:
            actual = cold.observe({"id": record_id})["records"][0]
            for channel, media in enumerate(actual["media"]):
                image = Image.open(BytesIO(base64.b64decode(media["data"]))).convert("RGB")
                original, _ = picture(index, channel)
                maximum_error = max(maximum_error, statistics.mean(ImageStat.Stat(ImageChops.difference(image, original)).mean))
                frames += 1
    finally:
        cold.close()
    cold_ms = (time.monotonic() - cold_started) * 1000
    middle = points[len(points) // 3: 2 * len(points) // 3]
    tail = points[2 * len(points) // 3:]
    report = {"records": arguments.records, "frames": arguments.records * 2,
              "elapsedSeconds": encode_seconds, "rate": arguments.rate,
              "metrics": history._video.metrics(), "pngBytesIfArchived": png_bytes, "videoBytes": encoded,
              "ratio": png_bytes / encoded, "coldDecodedFrames": frames, "maximumMeanPixelError": maximum_error,
              "coldFrameMs": cold_ms / max(frames, 1), "realtimeFactor": (arguments.records / arguments.rate) / encode_seconds,
              "rssPeakBytes": max(point["rssBytes"] for point in points),
              "rssMiddleMeanBytes": statistics.mean(point["rssBytes"] for point in middle),
              "rssTailMeanBytes": statistics.mean(point["rssBytes"] for point in tail),
              "hotPeakBytes": max(point["hotBytes"] for point in points), "samples": points,
              "imageFiles": len(list(arguments.output.rglob("*.png"))) + len(list(arguments.output.rglob("*.bin")))}
    report["budgetChecks"] = {
        "realtime-factor": report["realtimeFactor"] >= VIDEO_STORAGE_BUDGETS["realtime_factor"],
        "cold-frame-ms": report["coldFrameMs"] <= VIDEO_STORAGE_BUDGETS["cold_frame_ms"],
        "max-decode-error": report["maximumMeanPixelError"] <= VIDEO_STORAGE_BUDGETS["max_decode_error"],
        "peak-rss-mib": report["rssPeakBytes"] <= VIDEO_STORAGE_BUDGETS["peak_rss_mib"] * 1024 * 1024,
    }
    if trial:
        trial.artifact("measurements.json", report)
    else:
        (arguments.output / "measurements.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({key: value for key, value in report.items() if key != "samples"}, indent=2))
    failures = [name for name, passed in report["budgetChecks"].items() if not passed]
    if failures:
        print(f"video-storage budget violations: {', '.join(failures)}", file=sys.stderr)
        raise SystemExit(1)


if __name__ == "__main__":
    main()
