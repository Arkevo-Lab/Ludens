"""Pluggable multi-backend timeline storage, SigV4 client, and LRU/quota retention."""

from __future__ import annotations

import argparse
from dataclasses import dataclass
from datetime import datetime, timezone
import errno
import hashlib
import hmac
import json
import math
import os
from pathlib import Path
import queue
import re
import sys
import threading
import time
from typing import Any
import urllib.parse
import uuid

if sys.platform == "win32":
    import msvcrt
else:
    import fcntl

DEFAULT_LOCAL_MAX_BYTES = 20 * 1024 * 1024 * 1024  # 20 GiB
DEFAULT_LOCAL_CACHE_BYTES = 4 * 1024 * 1024 * 1024  # 4 GiB
BUILTIN_LOCAL_PROFILE_ID = "local-default"
VIDEO_QUALITY_CRF: dict[str, int] = {"high": 18, "balanced": 23, "compact": 28}
EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
STREAM_CHUNK_BYTES = 1024 * 1024  # 1 MiB

_ASSET_PART_RE = re.compile(r"^[A-Za-z0-9._-]+$")


def _replace_file(temporary: Path, destination: Path) -> None:
    for delay in (0.01, 0.02, 0.04, 0.08, None):
        try:
            temporary.replace(destination)
            return
        except PermissionError as error:
            if os.name != "nt" or getattr(error, "winerror", None) not in (5, 32) or delay is None:
                raise
            time.sleep(delay)


def _read_text_retry(path: Path) -> str:
    for delay in (0.01, 0.02, 0.04, 0.08, None):
        try:
            return path.read_text(encoding="utf-8")
        except PermissionError:
            if os.name != "nt" or delay is None:
                raise
            time.sleep(delay)
    raise AssertionError("unreachable")


def _atomic_json(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    try:
        temporary.write_text(json.dumps(value, allow_nan=False) + "\n", encoding="utf-8")
        _replace_file(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def _iso(at: float | None = None) -> str:
    ts = time.time() if at is None else at
    return datetime.fromtimestamp(ts, timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _parse_iso(value: Any, fallback: float) -> float:
    if not isinstance(value, str) or not value:
        return fallback
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            return fallback
        return parsed.timestamp()
    except (ValueError, OverflowError):
        return fallback


def _validate_asset_rel(asset: str) -> list[str]:
    parts = asset.split("/")
    if not parts or any(not _ASSET_PART_RE.fullmatch(part) or part in {".", ".."} for part in parts):
        raise ValueError("Invalid timeline media asset")
    return parts


def _timeline_path(root: Path, asset: str) -> Path:
    parts = _validate_asset_rel(asset)
    base = root.absolute()
    if base.exists() and base.resolve() != base:
        raise ValueError("Timeline media must not follow symlinks")
    path = base.joinpath(*parts)
    if path.exists() and path.resolve() != path:
        raise ValueError("Timeline media must not follow symlinks")
    if path.is_symlink():
        raise ValueError("Timeline media must not follow symlinks")
    return path


def _validate_archive_key(key: Any) -> list[str]:
    if not isinstance(key, str) or not key.strip():
        raise ValueError("Invalid timeline archive key")
    parts = [part for part in key.split("/") if part]
    if not parts or any(part in {".", ".."} for part in parts):
        raise ValueError("Invalid timeline archive key")
    return parts


def ludens_home(home: Path | str | None = None) -> Path:
    if home is not None:
        return Path(home).resolve()
    env_home = os.environ.get("LUDENS_HOME")
    if env_home:
        candidate = Path(env_home)
        if not candidate.is_absolute():
            raise ValueError("LUDENS_HOME must be an absolute directory")
        return candidate.resolve()
    return (Path.home() / ".ludens").resolve()


def _opt_nonneg_int(value: Any) -> int | None:
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, (int, float)) and math.isfinite(value) and value >= 0 and int(value) == value:
        return int(value)
    return None


def _opt_pos_number(value: Any) -> float | None:
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, (int, float)) and math.isfinite(value) and value > 0:
        return float(value)
    return None


def _default_local_profile() -> dict[str, Any]:
    return {
        "id": BUILTIN_LOCAL_PROFILE_ID,
        "name": "Local Ring Buffer",
        "kind": "local",
        "maxBytes": DEFAULT_LOCAL_MAX_BYTES,
        "maxAgeHours": None,
    }


def crf_for_video_quality(quality: str) -> int:
    return VIDEO_QUALITY_CRF.get(quality, VIDEO_QUALITY_CRF["balanced"])


def _resolve_crf(video_quality: str) -> int:
    env_raw = os.environ.get("LUDENS_VIDEO_CRF", "").strip()
    if env_raw:
        try:
            env_crf = int(env_raw)
        except ValueError:
            raise ValueError("LUDENS_VIDEO_CRF must be an integer between 0 and 51") from None
        if not 0 <= env_crf <= 51:
            raise ValueError("LUDENS_VIDEO_CRF must be an integer between 0 and 51")
        return env_crf
    return crf_for_video_quality(video_quality)


def _read_workspace_id(workspace: Path) -> str:
    identity_path = workspace / ".ludens" / "workspace.json"
    try:
        raw = json.loads(_read_text_retry(identity_path))
        if isinstance(raw, dict) and isinstance(raw.get("id"), str) and raw["id"].strip():
            return raw["id"].strip()
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        pass
    return workspace.name or "workspace"


def _read_global_storage_raw(home_dir: Path) -> dict[str, Any]:
    storage_path = home_dir / "storage.json"
    try:
        loaded = json.loads(_read_text_retry(storage_path))
        if isinstance(loaded, dict):
            return loaded
    except FileNotFoundError:
        pass
    except (json.JSONDecodeError, OSError):
        pass
    return {}


def _read_workspace_override_raw(workspace: Path) -> dict[str, Any]:
    ludens_path = workspace / "ludens.json"
    try:
        loaded = json.loads(_read_text_retry(ludens_path))
        if isinstance(loaded, dict) and isinstance(loaded.get("storage"), dict):
            return loaded["storage"]
    except FileNotFoundError:
        pass
    except (json.JSONDecodeError, OSError):
        pass
    return {}


def resolve_storage_config(workspace: Path | str, home: Path | str | None = None) -> dict[str, Any]:
    """Resolve effective storage configuration for a workspace."""
    persist_raw = os.environ.get("LUDENS_PERCEPTION_PERSIST")
    force_ephemeral = False
    if persist_raw is not None:
        persist_norm = persist_raw.strip().lower()
        if persist_norm not in {"1", "0", "true", "false"}:
            raise ValueError("LUDENS_PERCEPTION_PERSIST must be 1, 0, true, or false")
        force_ephemeral = persist_norm in {"0", "false"}

    ws_path = Path(workspace).resolve()
    home_dir = ludens_home(home)
    workspace_id = _read_workspace_id(ws_path)
    global_raw = _read_global_storage_raw(home_dir)
    override_raw = _read_workspace_override_raw(ws_path)

    profiles_by_id: dict[str, dict[str, Any]] = {
        BUILTIN_LOCAL_PROFILE_ID: _default_local_profile(),
    }
    raw_profiles = global_raw.get("profiles")
    if isinstance(raw_profiles, list):
        for item in raw_profiles:
            if isinstance(item, dict) and isinstance(item.get("id"), str) and item["id"].strip():
                pid = item["id"].strip()
                kind = item.get("kind")
                if kind in {"ephemeral", "local", "directory", "s3"}:
                    merged = dict(item)
                    merged["id"] = pid
                    if pid == BUILTIN_LOCAL_PROFILE_ID and "maxBytes" not in merged:
                        merged["maxBytes"] = DEFAULT_LOCAL_MAX_BYTES
                    profiles_by_id[pid] = merged

    default_profile_id = global_raw.get("defaultProfileId")
    if not isinstance(default_profile_id, str) or default_profile_id not in profiles_by_id:
        default_profile_id = BUILTIN_LOCAL_PROFILE_ID

    global_quality = global_raw.get("videoQuality")
    if global_quality not in VIDEO_QUALITY_CRF:
        global_quality = "balanced"

    protect_referenced = global_raw.get("protectReferenced")
    if not isinstance(protect_referenced, bool):
        protect_referenced = True

    override_mode = override_raw.get("mode", "inherit")
    if override_mode not in {"inherit", "ephemeral", "local", "profile"}:
        override_mode = "inherit"

    override_quality = override_raw.get("videoQuality")
    video_quality = override_quality if override_quality in VIDEO_QUALITY_CRF else str(global_quality)
    crf = _resolve_crf(video_quality)

    profile: dict[str, Any] | None = None
    if force_ephemeral or override_mode == "ephemeral":
        kind = "ephemeral"
        profile_id: str | None = None
        profile_name = "Ephemeral"
        max_bytes: int | None = None
        max_age_hours: float | None = None
        local_cache_bytes = DEFAULT_LOCAL_CACHE_BYTES
        directory_cfg: dict[str, Any] | None = None
        s3_cfg: dict[str, Any] | None = None
    elif override_mode == "local":
        kind = "local"
        profile_id = None
        profile_name = "Workspace Local"
        base_local = profiles_by_id[BUILTIN_LOCAL_PROFILE_ID]
        max_bytes = _opt_nonneg_int(base_local.get("maxBytes", DEFAULT_LOCAL_MAX_BYTES))
        if max_bytes is None and "maxBytes" not in base_local:
            max_bytes = DEFAULT_LOCAL_MAX_BYTES
        max_age_hours = _opt_pos_number(base_local.get("maxAgeHours"))
        if _opt_nonneg_int(override_raw.get("maxBytes")) is not None:
            max_bytes = _opt_nonneg_int(override_raw.get("maxBytes"))
        if _opt_pos_number(override_raw.get("maxAgeHours")) is not None:
            max_age_hours = _opt_pos_number(override_raw.get("maxAgeHours"))
        local_cache_bytes = DEFAULT_LOCAL_CACHE_BYTES
        directory_cfg = None
        s3_cfg = None
    else:
        target_id = override_raw.get("profileId") if override_mode == "profile" else default_profile_id
        if not isinstance(target_id, str) or target_id not in profiles_by_id:
            target_id = default_profile_id
        profile = profiles_by_id[target_id]
        kind = str(profile.get("kind", "local"))
        profile_id = str(profile["id"])
        profile_name = str(profile.get("name") or profile_id)
        max_bytes = _opt_nonneg_int(profile.get("maxBytes"))
        if kind == "local" and max_bytes is None and "maxBytes" not in profile:
            max_bytes = DEFAULT_LOCAL_MAX_BYTES
        max_age_hours = _opt_pos_number(profile.get("maxAgeHours"))
        cache_candidate = _opt_nonneg_int(profile.get("localCacheBytes"))
        local_cache_bytes = DEFAULT_LOCAL_CACHE_BYTES if cache_candidate is None else cache_candidate
        if _opt_nonneg_int(override_raw.get("maxBytes")) is not None:
            max_bytes = _opt_nonneg_int(override_raw.get("maxBytes"))
        if _opt_pos_number(override_raw.get("maxAgeHours")) is not None:
            max_age_hours = _opt_pos_number(override_raw.get("maxAgeHours"))
        if _opt_nonneg_int(override_raw.get("localCacheBytes")) is not None:
            override_cache = _opt_nonneg_int(override_raw.get("localCacheBytes"))
            assert override_cache is not None
            local_cache_bytes = override_cache
        raw_dir = profile.get("directory")
        directory_cfg = dict(raw_dir) if isinstance(raw_dir, dict) else None
        raw_s3 = profile.get("s3")
        s3_cfg = dict(raw_s3) if isinstance(raw_s3, dict) else None

    result: dict[str, Any] = {
        "workspaceId": workspace_id,
        "workspacePath": str(ws_path),
        "overrideMode": "ephemeral" if force_ephemeral else override_mode,
        "profileId": profile_id,
        "profileName": profile_name,
        "kind": kind,
        "videoQuality": video_quality,
        "crf": crf,
        "protectReferenced": protect_referenced,
        "maxBytes": max_bytes,
        "maxAgeHours": max_age_hours,
        "localCacheBytes": local_cache_bytes,
        "profilesById": profiles_by_id,
    }
    if directory_cfg is not None:
        result["directory"] = directory_cfg
    if s3_cfg is not None:
        result["s3"] = s3_cfg
    return result


# ---------------------------------------------------------------------------
# Zero-Dependency AWS Signature V4 S3 Client
# ---------------------------------------------------------------------------


def _uri_encode(value: str, *, encode_slash: bool = True) -> str:
    return urllib.parse.quote(value, safe="-_.~" if encode_slash else "/-_.~")


def _is_ip_host(hostname: str) -> bool:
    import ipaddress

    try:
        ipaddress.ip_address(hostname.strip("[]"))
        return True
    except ValueError:
        return False


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(STREAM_CHUNK_BYTES):
            digest.update(chunk)
    return digest.hexdigest()


def build_s3_object_url(config: dict[str, Any], key: str) -> str:
    endpoint = str(config.get("endpoint") or "").strip()
    bucket = str(config.get("bucket") or "").strip()
    if not endpoint or not bucket:
        raise ValueError("S3 config requires non-empty endpoint and bucket")
    parsed = urllib.parse.urlsplit(endpoint)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise ValueError(f"Invalid S3 endpoint URL: {endpoint!r}")

    clean_key = key.lstrip("/")
    encoded_key = _uri_encode(clean_key, encode_slash=False)
    base_path = parsed.path.rstrip("/")
    hostname = parsed.hostname
    host_lower = hostname.lower()
    force_path = (
        bool(config.get("forcePathStyle"))
        or "." in bucket
        or "." not in host_lower
        or host_lower == "localhost"
        or host_lower.endswith(".localhost")
        or _is_ip_host(host_lower)
    )

    port_suffix = f":{parsed.port}" if parsed.port and not (
        (parsed.scheme == "http" and parsed.port == 80) or (parsed.scheme == "https" and parsed.port == 443)
    ) else ""
    host_bracketed = f"[{hostname}]" if ":" in hostname and not hostname.startswith("[") else hostname

    if force_path:
        netloc = f"{host_bracketed}{port_suffix}"
        encoded_bucket = _uri_encode(bucket, encode_slash=True)
        full_path = f"{base_path}/{encoded_bucket}/{encoded_key}" if encoded_key else f"{base_path}/{encoded_bucket}"
    else:
        vhost = host_bracketed if host_lower.startswith(f"{bucket.lower()}.") else f"{bucket}.{host_bracketed}"
        netloc = f"{vhost}{port_suffix}"
        full_path = f"{base_path}/{encoded_key}" if encoded_key else (base_path or "/")

    if not full_path.startswith("/"):
        full_path = "/" + full_path
    return urllib.parse.urlunsplit((parsed.scheme, netloc, full_path, "", ""))


def _canonical_host(parsed: urllib.parse.SplitResult) -> str:
    hostname = parsed.hostname or ""
    host_bracketed = f"[{hostname}]" if ":" in hostname and not hostname.startswith("[") else hostname
    if parsed.port and not ((parsed.scheme == "http" and parsed.port == 80) or (parsed.scheme == "https" and parsed.port == 443)):
        return f"{host_bracketed}:{parsed.port}"
    return host_bracketed


def sign_s3_headers(
    *,
    method: str,
    url: str,
    region: str,
    access_key_id: str,
    secret_access_key: str,
    payload_hash: str,
    extra_headers: dict[str, str] | None = None,
    now: datetime | None = None,
) -> dict[str, str]:
    parsed = urllib.parse.urlsplit(url)
    dt = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    amz_date = dt.strftime("%Y%m%dT%H%M%SZ")
    date_stamp = dt.strftime("%Y%m%d")
    eff_region = region.strip() or "auto"
    host = _canonical_host(parsed)

    headers_to_sign: dict[str, str] = {
        "host": host,
        "x-amz-content-sha256": payload_hash,
        "x-amz-date": amz_date,
    }
    output_headers: dict[str, str] = {
        "Host": host,
        "x-amz-content-sha256": payload_hash,
        "x-amz-date": amz_date,
    }
    if extra_headers:
        for header_name, header_val in extra_headers.items():
            clean_val = " ".join(str(header_val).strip().split())
            lower_name = header_name.lower()
            output_headers[header_name] = clean_val
            if lower_name in {"content-type", "range"} or lower_name.startswith("x-amz-"):
                headers_to_sign[lower_name] = clean_val

    sorted_keys = sorted(headers_to_sign.keys())
    canonical_headers = "".join(f"{k}:{headers_to_sign[k]}\n" for k in sorted_keys)
    signed_headers = ";".join(sorted_keys)

    # parsed.path is already RFC3986 encoded when produced by build_s3_object_url,
    # normalize any unencoded path cleanly.
    raw_segments = (parsed.path or "/").split("/")
    canonical_uri = "/".join(_uri_encode(urllib.parse.unquote(seg), encode_slash=True) for seg in raw_segments) or "/"
    if not canonical_uri.startswith("/"):
        canonical_uri = "/" + canonical_uri

    query_pairs = urllib.parse.parse_qsl(parsed.query, keep_blank_values=True)
    encoded_query = sorted((_uri_encode(k), _uri_encode(v)) for k, v in query_pairs)
    canonical_querystring = "&".join(f"{k}={v}" for k, v in encoded_query)

    canonical_request = "\n".join([
        method.upper(),
        canonical_uri,
        canonical_querystring,
        canonical_headers,
        signed_headers,
        payload_hash,
    ])
    credential_scope = f"{date_stamp}/{eff_region}/s3/aws4_request"
    string_to_sign = "\n".join([
        "AWS4-HMAC-SHA256",
        amz_date,
        credential_scope,
        hashlib.sha256(canonical_request.encode("utf-8")).hexdigest(),
    ])

    k_date = hmac.new(("AWS4" + secret_access_key).encode("utf-8"), date_stamp.encode("utf-8"), hashlib.sha256).digest()
    k_region = hmac.new(k_date, eff_region.encode("utf-8"), hashlib.sha256).digest()
    k_service = hmac.new(k_region, b"s3", hashlib.sha256).digest()
    k_signing = hmac.new(k_service, b"aws4_request", hashlib.sha256).digest()
    signature = hmac.new(k_signing, string_to_sign.encode("utf-8"), hashlib.sha256).hexdigest()

    output_headers["Authorization"] = (
        f"AWS4-HMAC-SHA256 Credential={access_key_id}/{credential_scope}, "
        f"SignedHeaders={signed_headers}, Signature={signature}"
    )
    return output_headers


def _open_http_connection(parsed: urllib.parse.SplitResult, timeout: float) -> Any:
    import http.client
    import ssl

    hostname = parsed.hostname
    if not hostname:
        raise ValueError("Missing hostname in S3 URL")
    if parsed.scheme == "https":
        return http.client.HTTPSConnection(hostname, parsed.port or 443, timeout=timeout, context=ssl.create_default_context())
    return http.client.HTTPConnection(hostname, parsed.port or 80, timeout=timeout)


def _s3_credentials(config: dict[str, Any]) -> tuple[str, str, str]:
    region = str(config.get("region") or "auto")
    access_key_id = str(config.get("accessKeyId") or "").strip()
    secret_access_key = str(config.get("secretAccessKey") or "").strip()
    if not access_key_id or not secret_access_key:
        raise ValueError("S3 config requires accessKeyId and secretAccessKey")
    return region, access_key_id, secret_access_key


def s3_put_file(
    config: dict[str, Any],
    key: str,
    source_path: Path,
    *,
    content_type: str = "application/octet-stream",
    timeout: float = 30.0,
) -> None:
    """Stream a file to S3 using SigV4 without buffering the entire file in memory."""
    region, access_key_id, secret_access_key = _s3_credentials(config)
    file_size = source_path.stat().st_size
    payload_hash = sha256_file(source_path)
    url = build_s3_object_url(config, key)
    parsed = urllib.parse.urlsplit(url)
    headers = sign_s3_headers(
        method="PUT",
        url=url,
        region=region,
        access_key_id=access_key_id,
        secret_access_key=secret_access_key,
        payload_hash=payload_hash,
        extra_headers={
            "Content-Type": content_type,
            "Content-Length": str(file_size),
        },
    )
    target = parsed.path + (f"?{parsed.query}" if parsed.query else "")
    conn = _open_http_connection(parsed, timeout)
    try:
        conn.putrequest("PUT", target, skip_host=True, skip_accept_encoding=True)
        for header_name, header_val in headers.items():
            conn.putheader(header_name, header_val)
        conn.endheaders()
        with source_path.open("rb") as handle:
            while chunk := handle.read(STREAM_CHUNK_BYTES):
                conn.send(chunk)
        response = conn.getresponse()
        body = response.read(4096)
        if response.status not in {200, 201, 204}:
            detail = body.decode("utf-8", errors="replace").strip()
            raise RuntimeError(f"S3 PUT failed with HTTP {response.status}: {detail or response.reason}")
    finally:
        conn.close()


def s3_get_to_file(
    config: dict[str, Any],
    key: str,
    destination_path: Path,
    *,
    timeout: float = 30.0,
) -> int:
    """Stream an S3 object to destination_path via atomic .tmp rename."""
    region, access_key_id, secret_access_key = _s3_credentials(config)
    url = build_s3_object_url(config, key)
    parsed = urllib.parse.urlsplit(url)
    headers = sign_s3_headers(
        method="GET",
        url=url,
        region=region,
        access_key_id=access_key_id,
        secret_access_key=secret_access_key,
        payload_hash=EMPTY_SHA256,
    )
    destination_path.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination_path.with_name(f".{destination_path.name}.{uuid.uuid4().hex}.tmp")
    target = parsed.path + (f"?{parsed.query}" if parsed.query else "")
    conn = _open_http_connection(parsed, timeout)
    written = 0
    try:
        conn.putrequest("GET", target, skip_host=True, skip_accept_encoding=True)
        for header_name, header_val in headers.items():
            conn.putheader(header_name, header_val)
        conn.endheaders()
        response = conn.getresponse()
        if response.status != 200:
            body = response.read(4096).decode("utf-8", errors="replace").strip()
            raise RuntimeError(f"S3 GET failed with HTTP {response.status}: {body or response.reason}")
        with temporary.open("wb") as out:
            while chunk := response.read(STREAM_CHUNK_BYTES):
                out.write(chunk)
                written += len(chunk)
        _replace_file(temporary, destination_path)
        return written
    finally:
        conn.close()
        temporary.unlink(missing_ok=True)


def s3_delete_object(config: dict[str, Any], key: str, *, timeout: float = 15.0) -> None:
    """Delete an object from S3 (404 treated as already deleted)."""
    region, access_key_id, secret_access_key = _s3_credentials(config)
    url = build_s3_object_url(config, key)
    parsed = urllib.parse.urlsplit(url)
    headers = sign_s3_headers(
        method="DELETE",
        url=url,
        region=region,
        access_key_id=access_key_id,
        secret_access_key=secret_access_key,
        payload_hash=EMPTY_SHA256,
    )
    target = parsed.path + (f"?{parsed.query}" if parsed.query else "")
    conn = _open_http_connection(parsed, timeout)
    try:
        conn.putrequest("DELETE", target, skip_host=True, skip_accept_encoding=True)
        for header_name, header_val in headers.items():
            conn.putheader(header_name, header_val)
        conn.endheaders()
        response = conn.getresponse()
        body = response.read(4096)
        if response.status not in {200, 202, 204, 404}:
            detail = body.decode("utf-8", errors="replace").strip()
            raise RuntimeError(f"S3 DELETE failed with HTTP {response.status}: {detail or response.reason}")
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Timeline Storage Manager (Archival, Retention, Pin/Ref Protection, Hydration)
# ---------------------------------------------------------------------------


@dataclass
class _SegmentCandidate:
    asset: str
    sidecar_path: Path
    local_path: Path
    cache_path: Path
    meta: dict[str, Any]
    bytes: int
    started_ts: float
    pinned: bool
    referenced: bool


@dataclass
class _CacheEntry:
    asset: str
    path: Path
    bytes: int
    sort_ts: float
    pinned: bool


class TimelineStorageManager:
    """Manages local hot spool archival, LRU cache pruning, quota/TTL eviction, and cold read hydration."""

    def __init__(
        self,
        workspace: Path | str,
        timeline_dir: Path | str,
        *,
        home: Path | str | None = None,
        start_worker: bool = True,
    ) -> None:
        self.workspace = Path(workspace).resolve()
        self.timeline_dir = Path(timeline_dir).resolve()
        self.home = Path(home).resolve() if home is not None else None
        self._state_lock = threading.Lock()
        self._op_lock = threading.RLock()
        self._queue: queue.Queue[tuple[str, str | None]] = queue.Queue()
        self._closed = False
        self._prune_queued = False
        self._worker: threading.Thread | None = None
        self._allow_worker = start_worker

    def _enqueue(self, action: str, payload: str | None) -> None:
        with self._state_lock:
            if self._closed or not self._allow_worker:
                return
            self._queue.put((action, payload))
            if self._worker is None or not self._worker.is_alive():
                self._worker = threading.Thread(target=self._run_worker, name="ludens-timeline-storage", daemon=True)
                self._worker.start()

    def effective_policy(self) -> dict[str, Any]:
        cfg = resolve_storage_config(self.workspace, self.home)
        return {
            "kind": cfg["kind"],
            "profileId": cfg["profileId"],
            "videoQuality": cfg["videoQuality"],
            "crf": cfg["crf"],
            "maxBytes": cfg["maxBytes"],
            "maxAgeHours": cfg["maxAgeHours"],
            "localCacheBytes": cfg["localCacheBytes"],
            "protectReferenced": cfg["protectReferenced"],
        }

    def notify_sealed(self, asset: str) -> None:
        self._enqueue("archive", asset)

    def prune_async(self) -> None:
        with self._state_lock:
            if self._closed or not self._allow_worker or self._prune_queued:
                return
            self._prune_queued = True
            self._queue.put(("prune", None))
            if self._worker is None or not self._worker.is_alive():
                self._worker = threading.Thread(target=self._run_worker, name="ludens-timeline-storage", daemon=True)
                self._worker.start()

    def close(self, timeout: float = 2.0) -> None:
        with self._state_lock:
            if self._closed:
                return
            self._closed = True
            worker = self._worker
            if worker is not None and worker.is_alive():
                self._queue.put(("prune", None))
                self._queue.put(("stop", None))
        if worker is not None and worker.is_alive():
            worker.join(timeout=max(0.05, timeout))
        else:
            # Ensure local retention runs cleanly even if no async task was queued.
            try:
                cfg = resolve_storage_config(self.workspace, self.home)
                if cfg["kind"] == "local":
                    self.prune_now()
            except Exception:
                pass

    def _run_worker(self) -> None:
        while True:
            try:
                action, payload = self._queue.get(timeout=0.25)
            except queue.Empty:
                with self._state_lock:
                    if self._queue.empty():
                        self._worker = None
                        return
                continue
            if action == "stop":
                with self._state_lock:
                    self._worker = None
                return
            try:
                if action == "archive" and payload is not None:
                    cfg = resolve_storage_config(self.workspace, self.home)
                    if cfg["kind"] in {"directory", "s3"}:
                        with self._op_lock:
                            self._archive_one(payload, cfg, network_timeout=10.0)
                    with self._op_lock:
                        self._prune_locked(cfg, network_timeout=5.0)
                elif action == "prune":
                    with self._state_lock:
                        self._prune_queued = False
                    cfg = resolve_storage_config(self.workspace, self.home)
                    with self._op_lock:
                        self._prune_locked(cfg, network_timeout=5.0)
            except Exception as error:
                print(f"Timeline storage worker error ({action}): {type(error).__name__}: {error}", file=sys.stderr)

    # ------------------------------------------------------------------
    # Protection metadata: pins.json & .ludens/archive/media/*.json
    # ------------------------------------------------------------------

    def _read_pins(self) -> set[str]:
        pins_path = self.timeline_dir / "pins.json"
        try:
            raw = json.loads(_read_text_retry(pins_path))
            if isinstance(raw, dict) and isinstance(raw.get("assets"), list):
                return {item for item in raw["assets"] if isinstance(item, str) and item}
        except (FileNotFoundError, json.JSONDecodeError, OSError):
            pass
        return set()

    def _read_referenced_assets(self) -> set[str]:
        media_dir = self.workspace / ".ludens" / "archive" / "media"
        referenced: set[str] = set()
        if not media_dir.is_dir():
            return referenced
        try:
            for entry in media_dir.glob("*.json"):
                try:
                    data = json.loads(_read_text_retry(entry))
                    asset = data.get("asset") if isinstance(data, dict) else None
                    if isinstance(asset, str) and asset:
                        referenced.add(asset)
                except (json.JSONDecodeError, OSError):
                    continue
        except OSError:
            pass
        return referenced

    # ------------------------------------------------------------------
    # Archival (directory & s3)
    # ------------------------------------------------------------------

    def _build_archive_key(self, asset: str, cfg: dict[str, Any]) -> str:
        workspace_id = str(cfg["workspaceId"])
        kind = cfg["kind"]
        if kind == "s3":
            s3_cfg = cfg.get("s3") or {}
            prefix = str(s3_cfg.get("prefix") or "").strip().strip("/")
            return f"{prefix}/{workspace_id}/{asset}" if prefix else f"{workspace_id}/{asset}"
        return f"{workspace_id}/{asset}"

    def _has_valid_archive(self, meta: dict[str, Any]) -> bool:
        archive = meta.get("archive")
        return (
            isinstance(archive, dict)
            and archive.get("backend") in {"directory", "s3"}
            and isinstance(archive.get("key"), str)
            and bool(archive["key"].strip())
        )

    def _archive_one(self, asset: str, cfg: dict[str, Any], *, network_timeout: float = 30.0) -> bool:
        kind = cfg["kind"]
        if kind not in {"directory", "s3"}:
            return False
        local_path = _timeline_path(self.timeline_dir, asset)
        sidecar_path = _timeline_path(self.timeline_dir, asset + ".json")

        is_video = asset.startswith("video/") and asset.endswith(".mp4")
        is_object = asset.startswith("objects/") and asset.endswith(".bin")
        if not is_video and not is_object:
            return False

        meta: dict[str, Any] = {}
        if sidecar_path.is_file():
            try:
                loaded = json.loads(_read_text_retry(sidecar_path))
                if isinstance(loaded, dict):
                    meta = loaded
            except (json.JSONDecodeError, OSError):
                meta = {}

        if is_video:
            if meta.get("status") != "ready":
                return False

        profile_id = str(cfg.get("profileId") or "")
        if self._has_valid_archive(meta):
            existing = meta["archive"]
            if existing.get("backend") == kind and existing.get("profileId") == profile_id:
                if kind == "directory":
                    dir_path = (cfg.get("directory") or {}).get("path")
                    if isinstance(dir_path, str) and dir_path:
                        ext_target = Path(dir_path).joinpath(*_validate_archive_key(existing["key"]))
                        if ext_target.is_file():
                            return False
                else:
                    return False

        if not local_path.is_file():
            return False

        file_size = local_path.stat().st_size
        archive_key = self._build_archive_key(asset, cfg)

        if kind == "directory":
            dir_cfg = cfg.get("directory")
            if not isinstance(dir_cfg, dict) or not isinstance(dir_cfg.get("path"), str) or not dir_cfg["path"].strip():
                raise ValueError("Directory storage backend requires an absolute directory.path")
            base_dir = Path(dir_cfg["path"])
            if not base_dir.is_absolute():
                raise ValueError(f"Directory storage path must be absolute: {base_dir}")
            target = base_dir.joinpath(*_validate_archive_key(archive_key))
            target.parent.mkdir(parents=True, exist_ok=True)
            temporary = target.with_name(f".{target.name}.{uuid.uuid4().hex}.tmp")
            try:
                with local_path.open("rb") as src, temporary.open("wb") as dst:
                    while chunk := src.read(STREAM_CHUNK_BYTES):
                        dst.write(chunk)
                _replace_file(temporary, target)
            finally:
                temporary.unlink(missing_ok=True)
        elif kind == "s3":
            s3_cfg = cfg.get("s3")
            if not isinstance(s3_cfg, dict):
                raise ValueError("S3 storage backend requires s3 configuration")
            content_type = "video/mp4" if is_video else "application/octet-stream"
            s3_put_file(s3_cfg, archive_key, local_path, content_type=content_type, timeout=network_timeout)

        archive_record = {
            "backend": kind,
            "profileId": profile_id,
            "key": archive_key,
            "bytes": file_size,
            "archivedAt": _iso(),
        }
        if is_video:
            # Refresh sidecar before updating so concurrent reader/metadata fields stay intact.
            latest_meta = json.loads(_read_text_retry(sidecar_path))
            if latest_meta.get("status") != "ready":
                return False
            latest_meta["archive"] = archive_record
            _atomic_json(sidecar_path, latest_meta)
        else:
            obj_meta = {
                **meta,
                "status": "ready",
                "bytes": file_size,
                "startedAt": meta.get("startedAt") or _iso(local_path.stat().st_mtime),
                "archive": archive_record,
            }
            _atomic_json(sidecar_path, obj_meta)
        return True

    def sync_now(self) -> dict[str, Any]:
        """Synchronously archive all unarchived ready segments and static objects."""
        cfg = resolve_storage_config(self.workspace, self.home)
        archived_count = 0
        errors: list[str] = []
        if cfg["kind"] not in {"directory", "s3"}:
            return {"archivedCount": 0, "freedBytes": 0, "evictedCount": 0, "errors": errors}

        with self._op_lock:
            video_dir = self.timeline_dir / "video"
            if video_dir.is_dir():
                for sidecar in sorted(video_dir.glob("*.mp4.json")):
                    asset = f"video/{sidecar.name.removesuffix('.json')}"
                    try:
                        if self._archive_one(asset, cfg):
                            archived_count += 1
                    except Exception as error:
                        errors.append(f"{asset}: {error}")

            objects_dir = self.timeline_dir / "objects"
            if objects_dir.is_dir():
                for obj_file in sorted(objects_dir.glob("*.bin")):
                    asset = f"objects/{obj_file.name}"
                    try:
                        if self._archive_one(asset, cfg):
                            archived_count += 1
                    except Exception as error:
                        errors.append(f"{asset}: {error}")

        return {
            "archivedCount": archived_count,
            "freedBytes": 0,
            "evictedCount": 0,
            "errors": errors,
        }

    # ------------------------------------------------------------------
    # Pruning & Quota / TTL Eviction
    # ------------------------------------------------------------------

    def prune_now(self) -> dict[str, Any]:
        cfg = resolve_storage_config(self.workspace, self.home)
        with self._op_lock:
            return self._prune_locked(cfg, network_timeout=15.0)

    def _prune_locked(self, cfg: dict[str, Any], *, network_timeout: float = 15.0) -> dict[str, Any]:
        kind = cfg["kind"]
        if kind == "ephemeral":
            return {"freedBytes": 0, "archivedCount": 0, "evictedCount": 0, "errors": []}

        pins = self._read_pins()
        protect_referenced = bool(cfg.get("protectReferenced", True))
        referenced = self._read_referenced_assets() if protect_referenced else set()
        now = time.time()
        iso_now = _iso(now)
        freed_bytes = 0
        evicted_count = 0
        errors: list[str] = []

        if kind in {"directory", "s3"}:
            freed_bytes += self._prune_local_cache_locked(int(cfg["localCacheBytes"]), pins)
            max_bytes = cfg.get("maxBytes")
            max_age_hours = cfg.get("maxAgeHours")
            if max_bytes is not None or max_age_hours is not None:
                b_freed, b_evicted, b_errors = self._evict_backend_segments_locked(
                    cfg=cfg,
                    pins=pins,
                    referenced=referenced,
                    protect_referenced=protect_referenced,
                    now=now,
                    iso_now=iso_now,
                    network_timeout=network_timeout,
                )
                freed_bytes += b_freed
                evicted_count += b_evicted
                errors.extend(b_errors)
        elif kind == "local":
            l_freed, l_evicted = self._evict_local_segments_locked(
                max_bytes=cfg.get("maxBytes"),
                max_age_hours=cfg.get("maxAgeHours"),
                pins=pins,
                referenced=referenced,
                protect_referenced=protect_referenced,
                now=now,
                iso_now=iso_now,
            )
            freed_bytes += l_freed
            evicted_count += l_evicted

        return {
            "freedBytes": freed_bytes,
            "archivedCount": 0,
            "evictedCount": evicted_count,
            "errors": errors,
        }

    def _prune_local_cache_locked(self, cache_limit_bytes: int, pins: set[str], *, exclude: Path | None = None) -> int:
        """Prune cache/ and already-archived local spool blobs down to cache_limit_bytes."""
        total_local_bytes = 0
        eligible: list[_CacheEntry] = []

        # 1. Hydrated pull-through cache files under <timeline_dir>/cache/
        cache_root = self.timeline_dir / "cache"
        if cache_root.is_dir():
            for path in cache_root.rglob("*"):
                if not path.is_file() or path.name.endswith(".tmp"):
                    continue
                try:
                    stat = path.stat()
                except OSError:
                    continue
                rel_asset = path.relative_to(cache_root).as_posix()
                total_local_bytes += stat.st_size
                if exclude is not None and path == exclude:
                    continue
                eligible.append(_CacheEntry(
                    asset=rel_asset,
                    path=path,
                    bytes=stat.st_size,
                    sort_ts=stat.st_mtime,
                    pinned=rel_asset in pins,
                ))

        # 2. Local video/*.mp4 and objects/*.bin ONLY when verified archive metadata exists!
        video_dir = self.timeline_dir / "video"
        if video_dir.is_dir():
            for mp4 in video_dir.glob("*.mp4"):
                if not mp4.is_file():
                    continue
                try:
                    stat = mp4.stat()
                except OSError:
                    continue
                total_local_bytes += stat.st_size
                if exclude is not None and mp4 == exclude:
                    continue
                sidecar = mp4.with_suffix(".mp4.json")
                if not sidecar.is_file():
                    continue
                try:
                    meta = json.loads(_read_text_retry(sidecar))
                except (json.JSONDecodeError, OSError):
                    continue
                if meta.get("status") == "ready" and self._has_valid_archive(meta):
                    asset = f"video/{mp4.name}"
                    started_ts = _parse_iso(meta.get("startedAt"), stat.st_mtime)
                    eligible.append(_CacheEntry(
                        asset=asset,
                        path=mp4,
                        bytes=stat.st_size,
                        sort_ts=started_ts,
                        pinned=asset in pins,
                    ))

        objects_dir = self.timeline_dir / "objects"
        if objects_dir.is_dir():
            for obj_file in objects_dir.glob("*.bin"):
                if not obj_file.is_file():
                    continue
                try:
                    stat = obj_file.stat()
                except OSError:
                    continue
                total_local_bytes += stat.st_size
                if exclude is not None and obj_file == exclude:
                    continue
                sidecar = obj_file.with_name(obj_file.name + ".json")
                if not sidecar.is_file():
                    continue
                try:
                    meta = json.loads(_read_text_retry(sidecar))
                except (json.JSONDecodeError, OSError):
                    continue
                if meta.get("status") == "ready" and self._has_valid_archive(meta):
                    asset = f"objects/{obj_file.name}"
                    eligible.append(_CacheEntry(
                        asset=asset,
                        path=obj_file,
                        bytes=stat.st_size,
                        sort_ts=stat.st_mtime,
                        pinned=asset in pins,
                    ))

        if total_local_bytes <= cache_limit_bytes:
            return 0

        eligible.sort(key=lambda item: (1 if item.pinned else 0, item.sort_ts, str(item.path)))
        freed = 0
        for item in eligible:
            if total_local_bytes <= cache_limit_bytes:
                break
            try:
                item.path.unlink(missing_ok=True)
                freed += item.bytes
                total_local_bytes -= item.bytes
            except OSError:
                continue
        return freed

    def _collect_ready_video_segments(self, pins: set[str], referenced: set[str], *, require_local_file: bool) -> list[_SegmentCandidate]:
        video_dir = self.timeline_dir / "video"
        candidates: list[_SegmentCandidate] = []
        if not video_dir.is_dir():
            return candidates
        for sidecar in video_dir.glob("*.mp4.json"):
            try:
                meta = json.loads(_read_text_retry(sidecar))
            except (json.JSONDecodeError, OSError):
                continue
            if not isinstance(meta, dict) or meta.get("status") != "ready":
                continue
            mp4_name = sidecar.name.removesuffix(".json")
            asset = f"video/{mp4_name}"
            local_path = video_dir / mp4_name
            cache_path = self.timeline_dir / "cache" / "video" / mp4_name
            if require_local_file and not local_path.is_file():
                continue
            try:
                fallback_mtime = local_path.stat().st_mtime if local_path.is_file() else sidecar.stat().st_mtime
                if local_path.is_file():
                    seg_bytes = local_path.stat().st_size
                elif isinstance(meta.get("archive"), dict) and isinstance(meta["archive"].get("bytes"), int):
                    seg_bytes = int(meta["archive"]["bytes"])
                else:
                    seg_bytes = int(meta.get("readableBytes") or 0)
            except OSError:
                continue
            started_ts = _parse_iso(meta.get("startedAt"), fallback_mtime)
            candidates.append(_SegmentCandidate(
                asset=asset,
                sidecar_path=sidecar,
                local_path=local_path,
                cache_path=cache_path,
                meta=meta,
                bytes=seg_bytes,
                started_ts=started_ts,
                pinned=asset in pins,
                referenced=asset in referenced,
            ))
        return candidates

    def _evict_local_segments_locked(
        self,
        *,
        max_bytes: int | None,
        max_age_hours: float | None,
        pins: set[str],
        referenced: set[str],
        protect_referenced: bool,
        now: float,
        iso_now: str,
    ) -> tuple[int, int]:
        segments = self._collect_ready_video_segments(pins, referenced, require_local_file=True)
        if not segments:
            return 0, 0
        current_bytes = sum(seg.bytes for seg in segments)
        freed_bytes = 0
        evicted_count = 0
        evicted_assets: set[str] = set()

        def evict_one(seg: _SegmentCandidate, reason: str) -> None:
            nonlocal current_bytes, freed_bytes, evicted_count
            seg.local_path.unlink(missing_ok=True)
            seg.cache_path.unlink(missing_ok=True)
            updated = {k: v for k, v in seg.meta.items() if k != "archive"}
            updated.update(status="evicted", evictedAt=iso_now, evictedReason=reason)
            _atomic_json(seg.sidecar_path, updated)
            current_bytes -= seg.bytes
            freed_bytes += seg.bytes
            evicted_count += 1
            evicted_assets.add(seg.asset)

        if max_age_hours is not None and max_age_hours > 0:
            cutoff = now - max_age_hours * 3600.0
            ttl_candidates = [seg for seg in segments if not seg.pinned and seg.started_ts < cutoff]
            ttl_candidates.sort(key=lambda seg: (seg.started_ts, seg.asset))
            for seg in ttl_candidates:
                evict_one(seg, "ttl")

        if max_bytes is not None and current_bytes > max_bytes:
            quota_candidates = [seg for seg in segments if not seg.pinned and seg.asset not in evicted_assets]
            quota_candidates.sort(key=lambda seg: (1 if (protect_referenced and seg.referenced) else 0, seg.started_ts, seg.asset))
            for seg in quota_candidates:
                if current_bytes <= max_bytes:
                    break
                evict_one(seg, "quota")

        return freed_bytes, evicted_count

    def _delete_archive_blob(self, archive: dict[str, Any], cfg: dict[str, Any], *, network_timeout: float) -> None:
        backend = archive.get("backend")
        key = archive.get("key")
        profile_id = archive.get("profileId")
        if not isinstance(key, str) or not key:
            return
        profiles = cfg.get("profilesById") or {}
        profile = profiles.get(profile_id) if isinstance(profile_id, str) else None
        if backend == "directory":
            dir_cfg = (profile.get("directory") if isinstance(profile, dict) else None) or cfg.get("directory")
            if isinstance(dir_cfg, dict) and isinstance(dir_cfg.get("path"), str) and dir_cfg["path"]:
                ext_path = Path(dir_cfg["path"]).joinpath(*_validate_archive_key(key))
                ext_path.unlink(missing_ok=True)
        elif backend == "s3":
            s3_cfg = (profile.get("s3") if isinstance(profile, dict) else None) or cfg.get("s3")
            if isinstance(s3_cfg, dict):
                s3_delete_object(s3_cfg, key, timeout=network_timeout)

    def _evict_backend_segments_locked(
        self,
        *,
        cfg: dict[str, Any],
        pins: set[str],
        referenced: set[str],
        protect_referenced: bool,
        now: float,
        iso_now: str,
        network_timeout: float,
    ) -> tuple[int, int, list[str]]:
        max_bytes: int | None = cfg.get("maxBytes")
        max_age_hours: float | None = cfg.get("maxAgeHours")
        segments = self._collect_ready_video_segments(pins, referenced, require_local_file=False)
        if not segments:
            return 0, 0, []

        current_bytes = sum(seg.bytes for seg in segments)
        freed_bytes = 0
        evicted_count = 0
        errors: list[str] = []
        evicted_assets: set[str] = set()

        def evict_one(seg: _SegmentCandidate, reason: str) -> None:
            nonlocal current_bytes, freed_bytes, evicted_count
            archive = seg.meta.get("archive")
            if isinstance(archive, dict):
                try:
                    self._delete_archive_blob(archive, cfg, network_timeout=network_timeout)
                except Exception as error:
                    errors.append(f"{seg.asset}: {error}")
                    return
            local_freed = 0
            for candidate_path in (seg.local_path, seg.cache_path):
                if candidate_path.is_file():
                    try:
                        local_freed += candidate_path.stat().st_size
                        candidate_path.unlink(missing_ok=True)
                    except OSError:
                        pass
            updated = {k: v for k, v in seg.meta.items() if k != "archive"}
            updated.update(status="evicted", evictedAt=iso_now, evictedReason=reason)
            _atomic_json(seg.sidecar_path, updated)
            current_bytes -= seg.bytes
            freed_bytes += max(local_freed, seg.bytes)
            evicted_count += 1
            evicted_assets.add(seg.asset)

        if max_age_hours is not None and max_age_hours > 0:
            cutoff = now - max_age_hours * 3600.0
            ttl_candidates = [seg for seg in segments if not seg.pinned and seg.started_ts < cutoff]
            ttl_candidates.sort(key=lambda seg: (seg.started_ts, seg.asset))
            for seg in ttl_candidates:
                evict_one(seg, "ttl")

        if max_bytes is not None and current_bytes > max_bytes:
            quota_candidates = [seg for seg in segments if not seg.pinned and seg.asset not in evicted_assets]
            quota_candidates.sort(key=lambda seg: (1 if (protect_referenced and seg.referenced) else 0, seg.started_ts, seg.asset))
            for seg in quota_candidates:
                if current_bytes <= max_bytes:
                    break
                evict_one(seg, "quota")

        return freed_bytes, evicted_count, errors

    def clear_cache(self) -> dict[str, Any]:
        """Delete files in cache/ and local blobs that already have verified archive metadata."""
        pins = self._read_pins()
        with self._op_lock:
            freed = self._prune_local_cache_locked(0, pins)
        return {
            "freedBytes": freed,
            "archivedCount": 0,
            "evictedCount": 0,
            "errors": [],
        }

    def maintain(self, mode: str) -> dict[str, Any]:
        if mode == "sync":
            return self.sync_now()
        if mode == "prune":
            return self.prune_now()
        if mode == "clear_cache":
            return self.clear_cache()
        raise ValueError(f"Unsupported storage maintenance action: {mode!r}")

    # ------------------------------------------------------------------
    # Read Hydration (Local Spool -> Cache -> Directory / S3 Pull-Through)
    # ------------------------------------------------------------------

    def resolve_for_read(self, asset: str) -> Path:
        local_path = _timeline_path(self.timeline_dir, asset)
        if local_path.is_file():
            return local_path

        cache_root = self.timeline_dir / "cache"
        cache_path = _timeline_path(cache_root, asset)
        if cache_path.is_file():
            try:
                os.utime(cache_path, None)
            except OSError:
                pass
            return cache_path

        sidecar_path = _timeline_path(self.timeline_dir, asset + ".json")
        if not sidecar_path.is_file():
            raise ValueError("Recorded video is unavailable: status is missing")

        meta: dict[str, Any] = json.loads(_read_text_retry(sidecar_path))
        state = meta.get("status")
        archive = meta.get("archive") if isinstance(meta.get("archive"), dict) else None

        if state == "evicted" and not archive:
            raise ValueError("Recorded video was evicted by storage retention policy")
        if not archive:
            if state == "ready":
                raise ValueError("Recorded video is unavailable: segment is missing")
            raise ValueError(f"Recorded video is {state or 'unavailable'}: {meta.get('error', 'encoding has not finished')}")

        cfg = resolve_storage_config(self.workspace, self.home)
        profiles_by_id: dict[str, dict[str, Any]] = cfg.get("profilesById") or {}
        backend = archive.get("backend")
        profile_id = archive.get("profileId")
        key = archive.get("key")
        key_parts = _validate_archive_key(key)
        profile = profiles_by_id.get(profile_id) if isinstance(profile_id, str) else None

        if backend == "directory":
            dir_cfg = (profile.get("directory") if isinstance(profile, dict) else None) or cfg.get("directory")
            dir_path = dir_cfg.get("path") if isinstance(dir_cfg, dict) else None
            if not isinstance(dir_path, str) or not dir_path.strip():
                raise ValueError(f"External storage directory is unavailable: profile {profile_id!r} is not configured")
            external_path = Path(dir_path).joinpath(*key_parts)
            if not external_path.is_file():
                raise ValueError(f"External storage directory is unavailable: {external_path}")
            return external_path

        if backend == "s3":
            s3_cfg = (profile.get("s3") if isinstance(profile, dict) else None) or cfg.get("s3")
            if not isinstance(s3_cfg, dict):
                raise ValueError(f"S3 storage profile {profile_id!r} is not configured")
            assert isinstance(key, str)
            s3_get_to_file(s3_cfg, key, cache_path)
            pins = self._read_pins()
            with self._op_lock:
                self._prune_local_cache_locked(int(cfg["localCacheBytes"]), pins, exclude=cache_path)
            return cache_path

        raise ValueError(f"Unsupported timeline archive backend: {backend!r}")


# ---------------------------------------------------------------------------
# Offline CLI Entrypoint (python -m ludens_tools._storage)
# ---------------------------------------------------------------------------


def _try_acquire_writer_lock(lock_path: Path) -> Any:
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    handle = lock_path.open("a+b")
    try:
        if sys.platform == "win32":
            handle.seek(0)
            msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        return handle
    except OSError as error:
        handle.close()
        if isinstance(error, BlockingIOError) or (sys.platform == "win32" and error.errno == errno.EACCES):
            return None
        raise


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Maintain workspace timeline storage offline under writer.lock")
    parser.add_argument("--workspace", required=True, help="Workspace directory path")
    parser.add_argument("--action", required=True, choices=("sync", "prune", "clear_cache"))
    args = parser.parse_args(argv)

    workspace = Path(args.workspace).resolve()
    timeline_dir = workspace / ".ludens" / "timeline"
    if not timeline_dir.exists():
        sys.stdout.write(json.dumps({
            "ok": True,
            "action": args.action,
            "freedBytes": 0,
            "archivedCount": 0,
            "evictedCount": 0,
            "errors": [],
        }) + "\n")
        return 0

    lock_handle = _try_acquire_writer_lock(timeline_dir / "writer.lock")
    if lock_handle is None:
        print("Workspace timeline writer.lock is busy; route maintenance via live perception runtime", file=sys.stderr)
        return 2

    try:
        manager = TimelineStorageManager(workspace, timeline_dir, start_worker=False)
        result = manager.maintain(args.action)
        sys.stdout.write(json.dumps({"ok": True, "action": args.action, **result}) + "\n")
        return 0
    except Exception as error:
        print(f"{type(error).__name__}: {error}", file=sys.stderr)
        return 1
    finally:
        lock_handle.close()


if __name__ == "__main__":
    raise SystemExit(main())
