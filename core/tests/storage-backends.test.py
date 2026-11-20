"""Multi-backend timeline storage tests: config resolution, SigV4 S3, directory, local quota/TTL, pins, and CLI/IPC."""

from __future__ import annotations

import base64
from datetime import datetime, timedelta, timezone
import hashlib
import hmac
from io import BytesIO
import json
import os
from pathlib import Path
import queue
import socket
import subprocess
import sys
import threading
import time
import unittest
from unittest.mock import patch
import urllib.parse

from ludens_tools._observation_history import ObservationHistory
from ludens_tools._storage import (
    DEFAULT_LOCAL_CACHE_BYTES,
    DEFAULT_LOCAL_MAX_BYTES,
    VIDEO_QUALITY_MAX_EDGE,
    VIDEO_QUALITY_RECOMMENDED_MAX_BYTES,
    TimelineStorageManager,
    build_s3_object_url,
    max_long_edge_for_video_quality,
    resolve_storage_config,
    sha256_file,
)
from ludens_tools._video import decode_frame, video_status

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _support import TemporaryDirectory, stop_process


SAMPLING = {"clock": "storage-test", "startedAtMs": 0, "finishedAtMs": 1}


def png(color: tuple[int, int, int] = (200, 40, 60), size: tuple[int, int] = (32, 24)) -> bytes:
    from PIL import Image

    output = BytesIO()
    Image.new("RGB", size, color).save(output, format="PNG")
    return output.getvalue()


def sample(*images: bytes) -> dict:
    return {"media": [{"mediaType": "image/png", "data": base64.b64encode(raw).decode("ascii")} for raw in images]}


def _uri_encode(value: str, *, encode_slash: bool = True) -> str:
    return urllib.parse.quote(value, safe="-_.~" if encode_slash else "/-_.~")


class _MockS3Store:
    def __init__(self, access_key: str, secret_key: str, region: str) -> None:
        self.access_key = access_key
        self.secret_key = secret_key
        self.region = region
        self.lock = threading.Lock()
        self.objects: dict[str, bytes] = {}
        self.requests: list[tuple[str, str, dict[str, str]]] = []


def _make_s3_handler(store: _MockS3Store):
    from http.server import BaseHTTPRequestHandler

    class MockS3Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, format: str, *args) -> None:  # noqa: A002
            return

        def _verify_sigv4(self, body: bytes) -> tuple[bool, str]:
            auth = self.headers.get("Authorization", "")
            amz_date = self.headers.get("x-amz-date", "")
            content_sha = self.headers.get("x-amz-content-sha256", "")
            if not auth.startswith("AWS4-HMAC-SHA256 "):
                return False, "Missing AWS4-HMAC-SHA256 Authorization header"
            if self.headers.get("Transfer-Encoding", "").lower() == "chunked":
                return False, "Unexpected chunked Transfer-Encoding"

            actual_sha = hashlib.sha256(body).hexdigest()
            if content_sha != actual_sha:
                return False, f"Payload SHA256 mismatch: header={content_sha} actual={actual_sha}"

            parts = {}
            for item in auth.removeprefix("AWS4-HMAC-SHA256 ").split(","):
                k, _, v = item.strip().partition("=")
                parts[k] = v
            cred = parts.get("Credential", "")
            signed_headers_str = parts.get("SignedHeaders", "")
            provided_sig = parts.get("Signature", "")

            date_stamp = amz_date[:8]
            expected_scope = f"{date_stamp}/{store.region}/s3/aws4_request"
            if cred != f"{store.access_key}/{expected_scope}":
                return False, f"Invalid Credential: {cred}"

            signed_names = signed_headers_str.split(";")
            canonical_headers = ""
            for name in signed_names:
                val = self.headers.get(name)
                if val is None:
                    return False, f"Missing signed header {name}"
                canonical_headers += f"{name.lower()}:{' '.join(val.strip().split())}\n"

            parsed = urllib.parse.urlsplit(self.path)
            raw_segments = (parsed.path or "/").split("/")
            canonical_uri = "/".join(_uri_encode(urllib.parse.unquote(seg), encode_slash=True) for seg in raw_segments) or "/"
            query_pairs = urllib.parse.parse_qsl(parsed.query, keep_blank_values=True)
            canonical_qs = "&".join(
                f"{k}={v}" for k, v in sorted((_uri_encode(k), _uri_encode(v)) for k, v in query_pairs)
            )
            canonical_request = "\n".join([
                self.command.upper(),
                canonical_uri,
                canonical_qs,
                canonical_headers,
                signed_headers_str,
                content_sha,
            ])
            string_to_sign = "\n".join([
                "AWS4-HMAC-SHA256",
                amz_date,
                expected_scope,
                hashlib.sha256(canonical_request.encode("utf-8")).hexdigest(),
            ])
            k_date = hmac.new(("AWS4" + store.secret_key).encode("utf-8"), date_stamp.encode("utf-8"), hashlib.sha256).digest()
            k_region = hmac.new(k_date, store.region.encode("utf-8"), hashlib.sha256).digest()
            k_service = hmac.new(k_region, b"s3", hashlib.sha256).digest()
            k_signing = hmac.new(k_service, b"aws4_request", hashlib.sha256).digest()
            expected_sig = hmac.new(k_signing, string_to_sign.encode("utf-8"), hashlib.sha256).hexdigest()
            if not hmac.compare_digest(expected_sig, provided_sig):
                return False, "SignatureDoesNotMatch"
            return True, ""

        def _send(self, status: int, payload: bytes = b"", content_type: str = "application/octet-stream") -> None:
            self.send_response(status)
            self.send_header("Content-Length", str(len(payload)))
            self.send_header("Content-Type", content_type)
            self.end_headers()
            if payload:
                self.wfile.write(payload)

        def do_PUT(self) -> None:  # noqa: N802
            length = int(self.headers.get("Content-Length", "0"))
            body = self.rfile.read(length) if length > 0 else b""
            ok, reason = self._verify_sigv4(body)
            with store.lock:
                store.requests.append(("PUT", self.path, {k.lower(): v for k, v in self.headers.items()}))
                if not ok:
                    self._send(403, reason.encode("utf-8"), "text/plain")
                    return
                key = urllib.parse.unquote(urllib.parse.urlsplit(self.path).path).lstrip("/")
                store.objects[key] = body
            self._send(200, b"")

        def do_GET(self) -> None:  # noqa: N802
            ok, reason = self._verify_sigv4(b"")
            with store.lock:
                store.requests.append(("GET", self.path, {k.lower(): v for k, v in self.headers.items()}))
                if not ok:
                    self._send(403, reason.encode("utf-8"), "text/plain")
                    return
                key = urllib.parse.unquote(urllib.parse.urlsplit(self.path).path).lstrip("/")
                payload = store.objects.get(key)
            if payload is None:
                self._send(404, b"NoSuchKey", "text/plain")
                return
            self._send(200, payload)

        def do_DELETE(self) -> None:  # noqa: N802
            ok, reason = self._verify_sigv4(b"")
            with store.lock:
                store.requests.append(("DELETE", self.path, {k.lower(): v for k, v in self.headers.items()}))
                if not ok:
                    self._send(403, reason.encode("utf-8"), "text/plain")
                    return
                key = urllib.parse.unquote(urllib.parse.urlsplit(self.path).path).lstrip("/")
                store.objects.pop(key, None)
            self._send(204, b"")

    return MockS3Handler


class StorageBackendTests(unittest.TestCase):
    def assert_picture(self, raw: bytes, color: tuple[int, int, int], size: tuple[int, int] = (32, 24)) -> None:
        from PIL import Image

        image = Image.open(BytesIO(raw)).convert("RGB")
        self.assertEqual(image.size, size)
        actual = image.getpixel((size[0] // 2, size[1] // 2))
        self.assertLess(max(abs(left - right) for left, right in zip(actual, color)), 10)

    def _write_workspace_id(self, workspace: Path, ws_id: str = "ws-test-01") -> None:
        ludens_dir = workspace / ".ludens"
        ludens_dir.mkdir(parents=True, exist_ok=True)
        (ludens_dir / "workspace.json").write_text(json.dumps({"version": 1, "id": ws_id}) + "\n", encoding="utf-8")

    def test_config_resolution_defaults_overrides_crf_and_ephemeral_modes(self) -> None:
        with TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            home = root / "home"
            ws = root / "ws"
            ws.mkdir(parents=True)
            self._write_workspace_id(ws, "ws-alpha")

            with patch.dict(os.environ, {"LUDENS_HOME": str(home)}, clear=False):
                os.environ.pop("LUDENS_PERCEPTION_PERSIST", None)
                os.environ.pop("LUDENS_VIDEO_CRF", None)

                # Built-in fallback when storage.json does not exist
                cfg = resolve_storage_config(ws)
                self.assertEqual(cfg["workspaceId"], "ws-alpha")
                self.assertEqual(cfg["kind"], "local")
                self.assertEqual(cfg["profileId"], "local-default")
                self.assertEqual(cfg["maxBytes"], DEFAULT_LOCAL_MAX_BYTES)
                self.assertEqual(cfg["localCacheBytes"], DEFAULT_LOCAL_CACHE_BYTES)
                self.assertEqual(cfg["videoQuality"], "balanced")
                self.assertEqual(cfg["crf"], 23)
                self.assertEqual(cfg["maxLongEdge"], 1080)
                self.assertTrue(cfg["protectReferenced"])

                # Global storage.json + workspace ludens.json overrides
                home.mkdir(parents=True, exist_ok=True)
                (home / "storage.json").write_text(json.dumps({
                    "version": 1,
                    "defaultProfileId": "nas-1",
                    "videoQuality": "compact",
                    "protectReferenced": False,
                    "profiles": [
                        {
                            "id": "nas-1",
                            "name": "External NAS",
                            "kind": "directory",
                            "localCacheBytes": 1048576,
                            "directory": {"path": str(root / "nas")},
                        },
                        {
                            "id": "ephemeral-prof",
                            "name": "RAM Only",
                            "kind": "ephemeral",
                        },
                    ],
                }), encoding="utf-8")

                inherited = resolve_storage_config(ws)
                self.assertEqual(inherited["kind"], "directory")
                self.assertEqual(inherited["profileId"], "nas-1")
                self.assertEqual(inherited["crf"], 28)
                self.assertEqual(inherited["maxLongEdge"], 720)
                self.assertFalse(inherited["protectReferenced"])
                self.assertEqual(inherited["localCacheBytes"], 1048576)

                # Workspace override: quality=high -> crf 18, mode=local with custom maxBytes
                (ws / "ludens.json").write_text(json.dumps({
                    "storage": {
                        "mode": "local",
                        "maxBytes": 50_000_000,
                        "videoQuality": "high",
                    },
                }), encoding="utf-8")
                ws_local = resolve_storage_config(ws)
                self.assertEqual(ws_local["kind"], "local")
                self.assertEqual(ws_local["maxBytes"], 50_000_000)
                self.assertEqual(ws_local["crf"], 18)
                self.assertIsNone(ws_local["maxLongEdge"])

                # LUDENS_VIDEO_CRF env overrides preset
                with patch.dict(os.environ, {"LUDENS_VIDEO_CRF": "25"}):
                    self.assertEqual(resolve_storage_config(ws)["crf"], 25)

                # LUDENS_PERCEPTION_PERSIST=0 forces ephemeral regardless of ludens.json / storage.json
                with patch.dict(os.environ, {"LUDENS_PERCEPTION_PERSIST": "0"}):
                    forced = resolve_storage_config(ws)
                    self.assertEqual(forced["kind"], "ephemeral")

                # Ephemeral via workspace ludens.json (without env var!) behaves identically to hot-window mode
                (ws / "ludens.json").write_text(json.dumps({"storage": {"mode": "ephemeral"}}), encoding="utf-8")
                history = ObservationHistory(ws)
                try:
                    self.assertFalse(history.persistent)
                    rec = history.append(sample(png((40, 180, 90))), "g1", SAMPLING)
                    self.assertTrue(rec["media"][0]["timeline"]["asset"].startswith("window-"))
                finally:
                    history.close()
                self.assertEqual(list(history.directory.glob("window-*")), [])
                self.assertEqual(list(history.directory.rglob("*.mp4")), [])

    def test_s3_url_styles_and_streaming_sha256(self) -> None:
        # Virtual-hosted style for standard cloud endpoints
        self.assertEqual(
            build_s3_object_url(
                {"endpoint": "https://s3.us-east-1.amazonaws.com", "bucket": "my-bucket"},
                "prod/ws-1/video/seg.mp4",
            ),
            "https://my-bucket.s3.us-east-1.amazonaws.com/prod/ws-1/video/seg.mp4",
        )
        # Virtual-hosted when endpoint already includes bucket prefix (case-insensitive OSS/COS style)
        self.assertEqual(
            build_s3_object_url(
                {"endpoint": "https://My-Bucket.oss-cn-hangzhou.aliyuncs.com", "bucket": "MY-BUCKET"},
                "ws-1/video/seg.mp4",
            ),
            "https://my-bucket.oss-cn-hangzhou.aliyuncs.com/ws-1/video/seg.mp4",
        )
        # Path-style automatically for dotted buckets and single-label Docker/LAN hostnames
        self.assertEqual(
            build_s3_object_url(
                {"endpoint": "https://s3.us-east-1.amazonaws.com", "bucket": "media.archive"},
                "ws-1/video/seg.mp4",
            ),
            "https://s3.us-east-1.amazonaws.com/media.archive/ws-1/video/seg.mp4",
        )
        self.assertEqual(
            build_s3_object_url(
                {"endpoint": "http://minio:9000", "bucket": "ludens"},
                "ws-1/video/seg.mp4",
            ),
            "http://minio:9000/ludens/ws-1/video/seg.mp4",
        )
        # Path-style automatically for localhost / IP or explicit forcePathStyle
        self.assertEqual(
            build_s3_object_url(
                {"endpoint": "http://127.0.0.1:9000", "bucket": "ludens"},
                "ws-1/video/seg.mp4",
            ),
            "http://127.0.0.1:9000/ludens/ws-1/video/seg.mp4",
        )
        self.assertEqual(
            build_s3_object_url(
                {"endpoint": "https://r2.example.com", "bucket": "ludens", "forcePathStyle": True},
                "a b/seg.mp4",
            ),
            "https://r2.example.com/ludens/a%20b/seg.mp4",
        )

        with TemporaryDirectory() as tmp:
            blob = Path(tmp) / "multi_chunk.bin"
            payload = (b"ludens-stream-" * 200_000)  # ~2.8 MiB (> 2 chunks of 1 MiB)
            blob.write_bytes(payload)
            self.assertEqual(sha256_file(blob), hashlib.sha256(payload).hexdigest())

    def test_local_ring_buffer_quota_ttl_pins_and_referenced_protection(self) -> None:
        with TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            home = root / "home"
            ws = root / "ws"
            home.mkdir()
            ws.mkdir()
            self._write_workspace_id(ws, "ws-local")

            with patch.dict(os.environ, {"LUDENS_HOME": str(home)}):
                history = ObservationHistory(ws)
                colors = [(210, 40, 50), (40, 190, 70), (50, 90, 210), (200, 180, 40)]
                records = []
                for idx, color in enumerate(colors):
                    # Different generation forces a separate video segment per frame
                    rec = history.append(
                        sample(png(color)),
                        f"gen-{idx}",
                        SAMPLING,
                        f"2026-11-17T10:0{idx}:00.000Z",
                    )
                    history.seal()
                    records.append(rec)
                history.close()

                assets = [rec["media"][0]["timeline"]["asset"] for rec in records]
                self.assertEqual(len(set(assets)), 4)
                seg_sizes = [(ws / ".ludens" / "timeline" / asset).stat().st_size for asset in assets]
                self.assertTrue(all(size > 0 for size in seg_sizes))

                # Pin segment 0 (oldest!) -> must NEVER be evicted
                pins_path = ws / ".ludens" / "timeline" / "pins.json"
                pins_path.write_text(json.dumps({"version": 1, "assets": [assets[0]]}), encoding="utf-8")

                # Reference segment 1 in .ludens/archive/media/*.json -> must be evicted AFTER unreferenced (2 & 3)!
                archive_media_dir = ws / ".ludens" / "archive" / "media"
                archive_media_dir.mkdir(parents=True, exist_ok=True)
                (archive_media_dir / ("a" * 64 + ".json")).write_text(
                    json.dumps({"asset": assets[1], "video": records[1]["media"][0]["timeline"]["video"]}),
                    encoding="utf-8",
                )

                # Configure quota to fit 2 segments (seg 0 pinned + seg 1 referenced), evicting unreferenced seg 2 & seg 3!
                target_quota = seg_sizes[0] + seg_sizes[1]
                (home / "storage.json").write_text(json.dumps({
                    "version": 1,
                    "defaultProfileId": "local-default",
                    "videoQuality": "balanced",
                    "protectReferenced": True,
                    "profiles": [
                        {
                            "id": "local-default",
                            "name": "Local",
                            "kind": "local",
                            "maxBytes": target_quota,
                        },
                    ],
                }), encoding="utf-8")

                mgr = TimelineStorageManager(ws, ws / ".ludens" / "timeline", start_worker=False)
                pruned = mgr.prune_now()
                self.assertEqual(pruned["evictedCount"], 2)
                self.assertGreater(pruned["freedBytes"], 0)

                # Seg 0 (pinned) and Seg 1 (referenced) survive; Seg 2 and Seg 3 (unreferenced) were evicted!
                self.assertTrue((ws / ".ludens" / "timeline" / assets[0]).is_file())
                self.assertTrue((ws / ".ludens" / "timeline" / assets[1]).is_file())
                self.assertFalse((ws / ".ludens" / "timeline" / assets[2]).exists())
                self.assertFalse((ws / ".ludens" / "timeline" / assets[3]).exists())

                evicted_meta = json.loads((ws / ".ludens" / "timeline" / (assets[2] + ".json")).read_text(encoding="utf-8"))
                self.assertEqual(evicted_meta["status"], "evicted")
                self.assertEqual(evicted_meta["evictedReason"], "quota")
                self.assertIn("evictedAt", evicted_meta)

                with self.assertRaisesRegex(ValueError, "Recorded video was evicted by storage retention policy"):
                    decode_frame(ws / ".ludens" / "timeline", assets[2], records[2]["media"][0]["timeline"]["video"])

                # Now shrink maxBytes to 1 byte: unreferenced are all gone, so referenced Seg 1 is evicted,
                # while pinned Seg 0 STILL survives!
                (ws / "ludens.json").write_text(json.dumps({
                    "storage": {"mode": "local", "maxBytes": 1},
                }), encoding="utf-8")
                pruned_again = mgr.prune_now()
                self.assertEqual(pruned_again["evictedCount"], 1)
                self.assertTrue((ws / ".ludens" / "timeline" / assets[0]).is_file())
                self.assertFalse((ws / ".ludens" / "timeline" / assets[1]).exists())

                # Verify TTL eviction (maxAgeHours) marks evictedReason == "ttl" while still respecting pins
                pins_path.write_text(json.dumps({"version": 1, "assets": []}), encoding="utf-8")
                old_started = (datetime.now(timezone.utc) - timedelta(hours=5)).isoformat().replace("+00:00", "Z")
                seg0_meta_path = ws / ".ludens" / "timeline" / (assets[0] + ".json")
                seg0_meta = json.loads(seg0_meta_path.read_text(encoding="utf-8"))
                seg0_meta["startedAt"] = old_started
                seg0_meta_path.write_text(json.dumps(seg0_meta), encoding="utf-8")
                (ws / "ludens.json").write_text(json.dumps({
                    "storage": {"mode": "local", "maxBytes": DEFAULT_LOCAL_MAX_BYTES, "maxAgeHours": 1},
                }), encoding="utf-8")
                ttl_res = mgr.prune_now()
                self.assertEqual(ttl_res["evictedCount"], 1)
                self.assertEqual(
                    json.loads(seg0_meta_path.read_text(encoding="utf-8"))["evictedReason"],
                    "ttl",
                )

    def test_directory_backend_spool_archive_cache_prune_and_transparent_decode(self) -> None:
        with TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            home = root / "home"
            ext_dir = root / "external-ssd"
            ws = root / "ws"
            home.mkdir()
            ext_dir.mkdir()
            ws.mkdir()
            self._write_workspace_id(ws, "ws-dir")

            (home / "storage.json").write_text(json.dumps({
                "version": 1,
                "defaultProfileId": "ext-ssd",
                "videoQuality": "balanced",
                "protectReferenced": True,
                "profiles": [
                    {
                        "id": "ext-ssd",
                        "name": "External SSD",
                        "kind": "directory",
                        "localCacheBytes": 0,
                        "directory": {"path": str(ext_dir)},
                    },
                ],
            }), encoding="utf-8")

            with patch.dict(os.environ, {"LUDENS_HOME": str(home)}):
                history = ObservationHistory(ws)
                vid_rec = history.append(sample(png((30, 140, 210))), "g1", SAMPLING, "2026-11-17T12:00:00Z")
                bin_rec = history.append(
                    {"media": [{"mediaType": "application/octet-stream", "data": base64.b64encode(b"sensor-blob").decode()}]},
                    "g1",
                    SAMPLING,
                    "2026-11-17T12:00:01Z",
                )
                history.close()

                vid_ref = vid_rec["media"][0]["timeline"]
                bin_asset = bin_rec["media"][0]["timeline"]["asset"]
                timeline_dir = ws / ".ludens" / "timeline"

                # Both video segment and binary object were archived to external-ssd/ws-dir/...
                ext_video = ext_dir / "ws-dir" / vid_ref["asset"]
                ext_bin = ext_dir / "ws-dir" / bin_asset
                self.assertTrue(ext_video.is_file())
                self.assertTrue(ext_bin.is_file())
                self.assertEqual(ext_bin.read_bytes(), b"sensor-blob")

                # Because localCacheBytes == 0, local copies were pruned after verified archival!
                self.assertFalse((timeline_dir / vid_ref["asset"]).exists())
                self.assertFalse((timeline_dir / bin_asset).exists())

                sidecar = json.loads((timeline_dir / (vid_ref["asset"] + ".json")).read_text(encoding="utf-8"))
                self.assertEqual(sidecar["status"], "ready")
                self.assertEqual(sidecar["archive"]["backend"], "directory")
                self.assertEqual(sidecar["archive"]["profileId"], "ext-ssd")
                self.assertEqual(sidecar["archive"]["key"], f"ws-dir/{vid_ref['asset']}")

                # Transparent frame decoding via Python API, _video CLI, and cold ObservationHistory.observe!
                decoded = decode_frame(timeline_dir, vid_ref["asset"], vid_ref["video"])
                self.assert_picture(decoded, (30, 140, 210))

                # Also allow status == "evicted" when valid archive metadata is retained
                sidecar_path = timeline_dir / (vid_ref["asset"] + ".json")
                sidecar_evicted_with_archive = {**sidecar, "status": "evicted"}
                sidecar_path.write_text(json.dumps(sidecar_evicted_with_archive), encoding="utf-8")
                self.assertEqual(video_status(timeline_dir, vid_ref["asset"])["status"], "evicted")
                self.assert_picture(decode_frame(timeline_dir, vid_ref["asset"], vid_ref["video"]), (30, 140, 210))
                sidecar_path.write_text(json.dumps(sidecar), encoding="utf-8")

                cli_proc = subprocess.run(
                    [
                        sys.executable, "-m", "ludens_tools._video",
                        "--root", str(timeline_dir),
                        "--asset", vid_ref["asset"],
                        "--pts", str(vid_ref["video"]["pts"]),
                    ],
                    env={**os.environ, "LUDENS_HOME": str(home)},
                    capture_output=True,
                    check=True,
                )
                self.assert_picture(cli_proc.stdout, (30, 140, 210))

                cold = ObservationHistory(ws)
                try:
                    obs_vid = cold.observe({"id": vid_rec["id"]})["records"][0]
                    self.assert_picture(base64.b64decode(obs_vid["media"][0]["data"]), (30, 140, 210))
                    obs_bin = cold.observe({"id": bin_rec["id"]})["records"][0]
                    self.assertEqual(Path(obs_bin["media"][0]["path"]).read_bytes(), b"sensor-blob")
                finally:
                    cold.close()

                # Simulate unmounting external directory -> clear unavailable error
                unmounted = root / "external-ssd-unmounted"
                ext_dir.rename(unmounted)
                try:
                    with self.assertRaisesRegex(ValueError, "External storage directory is unavailable"):
                        decode_frame(timeline_dir, vid_ref["asset"], vid_ref["video"])
                finally:
                    unmounted.rename(ext_dir)

    def test_s3_backend_sigv4_put_cache_hydration_delete_and_offline_close_bound(self) -> None:
        from http.server import ThreadingHTTPServer

        store = _MockS3Store("AKIAIOSFODNN7EXAMPLE", "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", "us-east-1")
        server = ThreadingHTTPServer(("127.0.0.1", 0), _make_s3_handler(store))
        server_thread = threading.Thread(target=server.serve_forever, daemon=True)
        server_thread.start()
        endpoint = f"http://127.0.0.1:{server.server_address[1]}"

        try:
            with TemporaryDirectory() as tmp:
                root = Path(tmp).resolve()
                home = root / "home"
                ws = root / "ws"
                home.mkdir()
                ws.mkdir()
                self._write_workspace_id(ws, "ws-s3")

                (home / "storage.json").write_text(json.dumps({
                    "version": 1,
                    "defaultProfileId": "r2-main",
                    "videoQuality": "balanced",
                    "protectReferenced": True,
                    "profiles": [
                        {
                            "id": "r2-main",
                            "name": "Mock S3",
                            "kind": "s3",
                            "localCacheBytes": 1024 * 1024,
                            "s3": {
                                "endpoint": endpoint,
                                "region": "us-east-1",
                                "bucket": "ludens-archive",
                                "prefix": "env-prod",
                                "accessKeyId": store.access_key,
                                "secretAccessKey": store.secret_key,
                                "forcePathStyle": True,
                            },
                        },
                    ],
                }), encoding="utf-8")

                with patch.dict(os.environ, {"LUDENS_HOME": str(home)}):
                    history = ObservationHistory(ws)
                    rec1 = history.append(sample(png((220, 90, 30))), "g1", SAMPLING, "2026-11-17T13:00:00Z")
                    history.seal()
                    rec2 = history.append(sample(png((60, 180, 120))), "g2", SAMPLING, "2026-11-17T13:01:00Z")
                    history.close()

                    ref1 = rec1["media"][0]["timeline"]
                    ref2 = rec2["media"][0]["timeline"]
                    timeline_dir = ws / ".ludens" / "timeline"

                    expected_key1 = f"ludens-archive/env-prod/ws-s3/{ref1['asset']}"
                    expected_key2 = f"ludens-archive/env-prod/ws-s3/{ref2['asset']}"
                    self.assertIn(expected_key1, store.objects)
                    self.assertIn(expected_key2, store.objects)

                    meta1 = json.loads((timeline_dir / (ref1["asset"] + ".json")).read_text(encoding="utf-8"))
                    self.assertEqual(meta1["archive"]["backend"], "s3")
                    self.assertEqual(meta1["archive"]["key"], f"env-prod/ws-s3/{ref1['asset']}")

                    # Clear local cache via offline CLI (python -m ludens_tools._storage)
                    clear_proc = subprocess.run(
                        [sys.executable, "-m", "ludens_tools._storage", "--workspace", str(ws), "--action", "clear_cache"],
                        env={**os.environ, "LUDENS_HOME": str(home)},
                        capture_output=True,
                        text=True,
                        check=True,
                    )
                    clear_out = json.loads(clear_proc.stdout)
                    self.assertTrue(clear_out["ok"])
                    self.assertGreater(clear_out["freedBytes"], 0)
                    self.assertFalse((timeline_dir / ref1["asset"]).exists())
                    self.assertFalse((timeline_dir / "cache" / ref1["asset"]).exists())

                    # Pull-through read hydration from S3 -> populates .ludens/timeline/cache/<asset>
                    get_count_before = sum(1 for method, _, _ in store.requests if method == "GET")
                    hydrated_png = decode_frame(timeline_dir, ref1["asset"], ref1["video"])
                    self.assert_picture(hydrated_png, (220, 90, 30))
                    self.assertTrue((timeline_dir / "cache" / ref1["asset"]).is_file())
                    get_count_after_first = sum(1 for method, _, _ in store.requests if method == "GET")
                    self.assertEqual(get_count_after_first, get_count_before + 1)

                    # Second decode hits warm local cache without another S3 GET!
                    hydrated_png_cached = decode_frame(timeline_dir, ref1["asset"], ref1["video"])
                    self.assert_picture(hydrated_png_cached, (220, 90, 30))
                    get_count_after_second = sum(1 for method, _, _ in store.requests if method == "GET")
                    self.assertEqual(get_count_after_second, get_count_after_first)

                    # Cap localCacheBytes to 1 segment: hydrating ref2 evicts older ref1 from cache/
                    meta2 = json.loads((timeline_dir / (ref2["asset"] + ".json")).read_text(encoding="utf-8"))
                    (ws / "ludens.json").write_text(json.dumps({
                        "storage": {"mode": "inherit", "localCacheBytes": meta2["archive"]["bytes"]},
                    }), encoding="utf-8")
                    os.utime(timeline_dir / "cache" / ref1["asset"], (time.time() - 60, time.time() - 60))
                    self.assert_picture(decode_frame(timeline_dir, ref2["asset"], ref2["video"]), (60, 180, 120))
                    self.assertTrue((timeline_dir / "cache" / ref2["asset"]).is_file())
                    self.assertFalse((timeline_dir / "cache" / ref1["asset"]).exists())

                    # Enforce S3 backend maxBytes quota -> triggers SigV4 DELETE on oldest segment!
                    seg2_bytes = meta1["archive"]["bytes"]
                    (ws / "ludens.json").write_text(json.dumps({
                        "storage": {"mode": "inherit", "maxBytes": seg2_bytes},
                    }), encoding="utf-8")
                    prune_proc = subprocess.run(
                        [sys.executable, "-m", "ludens_tools._storage", "--workspace", str(ws), "--action", "prune"],
                        env={**os.environ, "LUDENS_HOME": str(home)},
                        capture_output=True,
                        text=True,
                        check=True,
                    )
                    prune_out = json.loads(prune_proc.stdout)
                    self.assertTrue(prune_out["ok"])
                    self.assertEqual(prune_out["evictedCount"], 1)
                    self.assertNotIn(expected_key1, store.objects)
                    self.assertIn(expected_key2, store.objects)
                    with self.assertRaisesRegex(ValueError, "Recorded video was evicted by storage retention policy"):
                        decode_frame(timeline_dir, ref1["asset"], ref1["video"])

                # Verify close() does not hang indefinitely when S3 endpoint is unresponsive
                blackhole_sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
                blackhole_sock.bind(("127.0.0.1", 0))
                blackhole_sock.listen(1)
                bh_port = blackhole_sock.getsockname()[1]

                accepted_stall = threading.Event()
                release_stall = threading.Event()

                def stall_peer() -> None:
                    try:
                        conn, _ = blackhole_sock.accept()
                        accepted_stall.set()
                        # Stall past the 10s _archive_one network_timeout while holding _op_lock
                        release_stall.wait(timeout=12.0)
                        try:
                            conn.sendall(b"HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\n\r\n")
                        except OSError:
                            pass
                        conn.close()
                    except OSError:
                        pass

                stall_thread = threading.Thread(target=stall_peer, daemon=True)
                stall_thread.start()
                try:
                    ws_offline = root / "ws-offline"
                    ws_offline.mkdir()
                    (home / "storage.json").write_text(json.dumps({
                        "version": 1,
                        "defaultProfileId": "stalled-s3",
                        "videoQuality": "balanced",
                        "protectReferenced": True,
                        "profiles": [
                            {
                                "id": "stalled-s3",
                                "name": "Stalled S3",
                                "kind": "s3",
                                "s3": {
                                    "endpoint": f"http://127.0.0.1:{bh_port}",
                                    "region": "us-east-1",
                                    "bucket": "b",
                                    "accessKeyId": "k",
                                    "secretAccessKey": "s",
                                },
                            },
                        ],
                    }), encoding="utf-8")
                    with patch.dict(os.environ, {"LUDENS_HOME": str(home)}):
                        hist_stalled = ObservationHistory(ws_offline)
                        hist_stalled.append(sample(png()), "g1", SAMPLING)
                        hist_stalled.seal()
                        # Wait until background archiver is actively stalled inside _op_lock
                        self.assertTrue(accepted_stall.wait(timeout=2.0))
                        t0 = time.monotonic()
                        hist_stalled.close()
                        self.assertLess(time.monotonic() - t0, 2.8)
                finally:
                    release_stall.set()
                    blackhole_sock.close()
                    stall_thread.join(timeout=1.0)
        finally:
            server.shutdown()
            server.server_close()

    def test_cli_writer_lock_contention_and_live_perception_storage_maintain_ipc(self) -> None:
        with TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            home = root / "home"
            ext_dir = root / "ext"
            ws = root / "ws"
            home.mkdir()
            ext_dir.mkdir()
            ws.mkdir()
            self._write_workspace_id(ws, "ws-ipc")

            (home / "storage.json").write_text(json.dumps({
                "version": 1,
                "defaultProfileId": "ext",
                "videoQuality": "balanced",
                "protectReferenced": True,
                "profiles": [
                    {
                        "id": "ext",
                        "name": "Ext",
                        "kind": "directory",
                        "localCacheBytes": 10 * 1024 * 1024,
                        "directory": {"path": str(ext_dir)},
                    },
                ],
            }), encoding="utf-8")

            source = (
                "from ludens_tools import capability, record\n"
                "class Perception:\n"
                "    def start(self, context):\n"
                "        self.sample()\n"
                "    @record\n"
                "    @capability\n"
                "    def sample(self):\n"
                "        return " + repr(sample(png((120, 70, 200)))) + "\n"
                "    def close(self):\n"
                "        pass\n"
            )
            env = {**os.environ, "LUDENS_HOME": str(home)}
            with (ws / "stderr.log").open("w") as stderr:
                proc = subprocess.Popen(
                    [sys.executable, "-u", "-m", "ludens_tools._perception"],
                    cwd=ws,
                    env=env,
                    stdin=subprocess.PIPE,
                    stdout=subprocess.PIPE,
                    stderr=stderr,
                    text=True,
                )
                assert proc.stdin is not None and proc.stdout is not None
                incoming: queue.Queue[dict] = queue.Queue()
                reader = threading.Thread(
                    target=lambda: [incoming.put(json.loads(line)) for line in proc.stdout],  # type: ignore[union-attr]
                    daemon=True,
                )
                reader.start()
                try:
                    proc.stdin.write(json.dumps({
                        "id": "start-1",
                        "action": "start",
                        "workspace": str(ws),
                        "runDir": str(ws / "run"),
                        "generation": "g1",
                        "source": source,
                    }) + "\n")
                    proc.stdin.flush()

                    started = None
                    sampled = None
                    while started is None or sampled is None:
                        msg = incoming.get(timeout=5)
                        if msg.get("id") == "start-1":
                            started = msg
                        elif msg.get("event") == "sample":
                            sampled = msg
                    self.assertTrue(started["ok"])

                    # Offline CLI detects busy writer.lock and exits non-zero without corrupting state
                    busy_cli = subprocess.run(
                        [sys.executable, "-m", "ludens_tools._storage", "--workspace", str(ws), "--action", "prune"],
                        env=env,
                        capture_output=True,
                        text=True,
                    )
                    self.assertNotEqual(busy_cli.returncode, 0)
                    self.assertIn("writer.lock", busy_cli.stderr)

                    # Seal segment via lease transition, then run live storage_maintain IPC!
                    proc.stdin.write(json.dumps({"id": "lease-1", "action": "lease", "epoch": "ep-1"}) + "\n")
                    proc.stdin.write(json.dumps({"id": "lease-2", "action": "lease", "epoch": None}) + "\n")
                    proc.stdin.flush()
                    got_lease2 = False
                    while not got_lease2:
                        msg = incoming.get(timeout=5)
                        if msg.get("id") == "lease-2":
                            got_lease2 = True

                    for idx, mode in enumerate(("sync", "clear_cache", "prune")):
                        req_id = f"maint-{idx}"
                        proc.stdin.write(json.dumps({
                            "id": req_id,
                            "action": "storage_maintain",
                            "mode": mode,
                        }) + "\n")
                        proc.stdin.flush()
                        reply = None
                        while reply is None:
                            msg = incoming.get(timeout=5)
                            if msg.get("id") == req_id:
                                reply = msg
                        self.assertTrue(reply["ok"])
                        self.assertIn("freedBytes", reply["result"])
                        self.assertIn("archivedCount", reply["result"])
                        self.assertIn("evictedCount", reply["result"])
                        self.assertEqual(reply["errors"], [])
                finally:
                    stop_process(proc)
                    proc.stdin.close()
                    proc.stdout.close()
                    reader.join(timeout=1)

    def test_video_quality_presets_scale_long_edge_without_altering_live_frames(self) -> None:
        import av
        from PIL import Image

        self.assertEqual(VIDEO_QUALITY_MAX_EDGE, {"high": None, "balanced": 1080, "compact": 720})
        self.assertEqual(
            VIDEO_QUALITY_RECOMMENDED_MAX_BYTES,
            {"compact": 5 * 1024**3, "balanced": 20 * 1024**3, "high": 50 * 1024**3},
        )
        self.assertEqual(max_long_edge_for_video_quality("compact"), 720)
        self.assertEqual(max_long_edge_for_video_quality("balanced"), 1080)
        self.assertIsNone(max_long_edge_for_video_quality("high"))

        cases = [
            ("compact", (1920, 1080), (720, 404), (210, 60, 40)),
            ("compact", (1080, 1920), (404, 720), (60, 180, 90)),
            ("balanced", (2560, 1440), (1080, 608), (40, 110, 220)),
            ("high", (1920, 1080), (1920, 1080), (180, 150, 50)),
        ]
        for idx, (preset, input_size, expected_size, color) in enumerate(cases):
            with self.subTest(preset=preset, input_size=input_size):
                with TemporaryDirectory() as tmp:
                    root = Path(tmp).resolve()
                    home = root / "home"
                    ws = root / f"ws-{idx}"
                    home.mkdir()
                    ws.mkdir()
                    self._write_workspace_id(ws, f"ws-preset-{idx}")
                    (ws / "ludens.json").write_text(
                        json.dumps({"storage": {"mode": "local", "videoQuality": preset}}),
                        encoding="utf-8",
                    )

                    with patch.dict(os.environ, {"LUDENS_HOME": str(home)}, clear=False):
                        os.environ.pop("LUDENS_PERCEPTION_PERSIST", None)
                        os.environ.pop("LUDENS_VIDEO_CRF", None)

                        mgr = TimelineStorageManager(ws, ws / ".ludens" / "timeline", start_worker=False)
                        self.assertEqual(mgr.effective_policy()["maxLongEdge"], VIDEO_QUALITY_MAX_EDGE[preset])

                        history = ObservationHistory(ws)
                        try:
                            rec = history.append(
                                sample(png(color, input_size)),
                                f"gen-{idx}",
                                SAMPLING,
                                "2026-11-20T10:00:00.000Z",
                            )
                            # Live delivered perception frame must remain untouched at native input resolution.
                            live_raw = base64.b64decode(rec["media"][0]["data"])
                            with Image.open(BytesIO(live_raw)) as live_img:
                                self.assertEqual(live_img.size, input_size)
                        finally:
                            history.close()

                        ref = rec["media"][0]["timeline"]
                        timeline_dir = ws / ".ludens" / "timeline"
                        mp4_path = timeline_dir / ref["asset"]
                        with av.open(str(mp4_path), mode="r") as container:
                            stream = container.streams.video[0]
                            self.assertEqual((stream.width, stream.height), expected_size)
                            self.assertEqual(stream.width % 2, 0)
                            self.assertEqual(stream.height % 2, 0)

                        decoded = decode_frame(timeline_dir, ref["asset"], ref["video"])
                        self.assert_picture(decoded, color, expected_size)


if __name__ == "__main__":
    unittest.main()
