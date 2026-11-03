"""Synchronous access to the workspace's unified capability interface."""

from __future__ import annotations

from contextvars import ContextVar
import builtins
import math
from pathlib import Path
import time
from typing import Any
import uuid
from ._context import LudensError, continuous, current, request, scope
from ._observation_history import _iso, read_timeline, timestamp

_in_eval_env_observe = ContextVar("ludens_in_eval_env_observe", default=False)


class RecordWindow:
    """Wall-clock bounds for a recorded operation."""

    def __enter__(self) -> "RecordWindow":
        self.start_time = time.time()
        self.start = _iso(self.start_time)
        self.end: str | None = None
        self.end_time: float | None = None
        return self

    def __exit__(self, *exception: Any) -> None:
        self.end_time = max(self.start_time, time.time())
        self.end = _iso(self.end_time)

    @property
    def duration(self) -> float | None:
        if not hasattr(self, "start_time"):
            return None
        return (self.end_time if self.end_time is not None else time.time()) - self.start_time

    def to_dict(self) -> dict[str, str]:
        return {"start": self.start, **({"end": self.end} if self.end is not None else {})}


def record_window() -> RecordWindow:
    return RecordWindow()


def _replay_time(value: str | float | int, name: str) -> str:
    if isinstance(value, str):
        return _iso(timestamp(value, name))
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ValueError(f"{name} must be a finite numeric timestamp or ISO timestamp")
    return _iso(float(value))


class Client:
    """Call driver or Python capabilities using the current control epoch.

    Python functions run in this process. Driver requests use one connection;
    the client never acquires control or retries actions.
    """

    def __init__(self, socket_path: str | None = None, *, epoch: str | None = None,
                 trace: dict[str, Any] | None = None, timeout: float | None = None) -> None:
        self.socket_path = socket_path
        self.epoch = epoch
        self.trace = trace
        self.timeout = timeout

    def _context(self) -> dict[str, Any]:
        # Resolve defaults at the call site, so a module-level Client also
        # inherits the active local function's trace.
        parent = current()
        context = {**parent, **{key: value for key, value in {
            "socket_path": self.socket_path, "epoch": self.epoch,
            "trace": self.trace, "timeout": self.timeout,
        }.items() if value is not None}}
        # A client may choose its call trace, but it cannot accidentally discard
        # the sampler's purpose or run ownership across a driver boundary.
        trace = dict(context["trace"])
        if continuous(parent):
            trace["recordingPurpose"] = parent.get("recording_purpose") or parent["trace"]["recordingPurpose"]
        for key in ("recordingId", "inputGeneration"):
            if parent.get("trace", {}).get(key):
                trace[key] = parent["trace"][key]
        context["trace"] = trace
        return context

    def _request(self, action: str, **fields: Any) -> Any:
        context = self._context()
        message = {"kind": "controller", "argv": [], "action": action, **fields}
        if context["epoch"] is not None:
            message["epoch"] = context["epoch"]
        if context["trace"]:
            message["trace"] = context["trace"]
        return request(context["socket_path"], message, context["timeout"])

    def list(self) -> Any:
        """List registered driver and workspace capabilities."""
        env = current().get("eval_env")
        if env is not None and hasattr(env, "list") and callable(env.list):
            return env.list()
        return self._request("list")

    def help(self, capability_id: str) -> Any:
        """Read the selected capability's description and arguments."""
        env = current().get("eval_env")
        if env is not None and hasattr(env, "help") and callable(env.help):
            return env.help(capability_id)
        return self._request("help", id=capability_id)

    def observe(self, query: dict[str, Any] | None = None) -> Any:
        """Read timeline history without sampling; returns the same envelope as ludens observe."""
        context = self._context()
        env = context.get("eval_env")
        if (env is not None and not _in_eval_env_observe.get()
                and hasattr(env, "observe") and callable(env.observe)):
            token = _in_eval_env_observe.set(True)
            try:
                raw = env.observe(query or {})
            finally:
                _in_eval_env_observe.reset(token)
            if isinstance(raw, list):
                return {"queryId": "eval-env-" + uuid.uuid4().hex[:8], "ok": True, "records": raw, "hasMore": False}
            if isinstance(raw, dict):
                return {"queryId": "eval-env-" + uuid.uuid4().hex[:8], "ok": True, "records": [], "hasMore": False, **raw}
            raise ValueError("eval_env.observe must return a record list or observation envelope dict")
        if context["socket_path"] is None:
            return self._offline_timeline(context, query)
        try:
            return request(context["socket_path"], {
                "kind": "perception", "argv": ["observe"], "query": query or {},
                **({"epoch": context["epoch"]} if context["epoch"] is not None else {}), "trace": context["trace"],
            }, context["timeout"])
        except (FileNotFoundError, ConnectionRefusedError):
            return self._offline_timeline(context, query)
        except LudensError as error:
            # A host that never started or already stopped still serves reads.
            text = str(error)
            if "ENOENT" in text or "ECONNREFUSED" in text or "Unavailable" in text:
                return self._offline_timeline(context, query)
            raise

    @staticmethod
    def _offline_timeline(context: dict[str, Any], query: dict[str, Any] | None) -> Any:
        result = read_timeline(context["workspace"], query)
        return {"queryId": "offline-" + uuid.uuid4().hex[:8], "ok": True, **result}

    def replay(self, window: Any = None, *, start: str | float | int | None = None,
               end: str | float | int | None = None, around: str | None = None,
               before_seconds: float = 2.0, after_seconds: float = 2.0,
               capability: str | None = None, max_records: int = 256) -> builtins.list[dict[str, Any]]:
        """Read an ordered time slice across all capabilities unless filtered."""
        if isinstance(max_records, bool) or not isinstance(max_records, int) or max_records < 1:
            raise ValueError("max_records must be a positive integer")
        for name, value in (("before_seconds", before_seconds), ("after_seconds", after_seconds)):
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value < 0:
                raise ValueError(f"{name} must be a finite non-negative number")

        query: dict[str, Any] = {"after": 0}
        if around is not None:
            if window is not None or start is not None or end is not None:
                raise ValueError("around cannot be combined with window, start, or end")
            anchor = self.observe({"id": around, **({"capability": capability} if capability is not None else {})})
            if not anchor.get("records"):
                raise ValueError(f"Timeline record not found: {around}")
            record = anchor["records"][0]
            at = timestamp(record["recordedAt"], "recordedAt")
            query["start"] = _iso(at - float(before_seconds))
            query["end"] = _iso(at + float(after_seconds))
        else:
            window_start: str | float | int | None = None
            window_end: str | float | int | None = None
            if isinstance(window, RecordWindow):
                window_start, window_end = window.start, window.end
            elif isinstance(window, dict):
                window_start, window_end = window.get("start"), window.get("end")
                if capability is None:
                    capability = window.get("capability")
            elif window is not None:
                raise TypeError("window must be a RecordWindow or dict")
            selected_start = start if start is not None else window_start
            selected_end = end if end is not None else window_end
            if selected_start is not None:
                query["start"] = _replay_time(selected_start, "start")
            if selected_end is not None:
                query["end"] = _replay_time(selected_end, "end")
        query["capability"] = capability if capability is not None else "*"

        records: list[dict[str, Any]] = []
        while len(records) < max_records:
            page = self.observe({**query, "limit": min(64, max_records - len(records))})
            batch = page.get("records", [])
            records.extend(batch)
            if not page.get("hasMore") or not batch:
                break
            query["after"] = page.get("nextAfter", batch[-1]["sequence"])
        return records

    def call(self, capability_id: str, arguments: dict[str, Any] | None = None) -> Any:
        """Call a driver or local Python function with named arguments."""
        if capability_id.startswith("python/"):
            from ._capabilities import call_local
            context = self._context()
            with scope(context):
                return call_local(Path(context["workspace"]), capability_id, arguments if arguments is not None else {})
        if arguments is None:
            arguments = {}
        if not isinstance(arguments, dict):
            raise TypeError("Driver capability arguments must be a JSON object")
        env = current().get("eval_env")
        if env is not None:
            if hasattr(env, "call") and callable(env.call):
                return env.call(capability_id, arguments)
            if callable(env):
                return env(capability_id, arguments)
            raise ValueError("eval_env must define call(capability_id, arguments) or be callable to handle " + capability_id)
        fields = {"id": capability_id, "arguments": arguments}
        return self._request("call", **fields)


def replay(window: Any = None, *, start: str | float | int | None = None,
           end: str | float | int | None = None, around: str | None = None,
           before_seconds: float = 2.0, after_seconds: float = 2.0,
           capability: str | None = None, max_records: int = 256) -> list[dict[str, Any]]:
    """Read timeline records using the ambient client context."""
    return Client().replay(window, start=start, end=end, around=around,
                           before_seconds=before_seconds, after_seconds=after_seconds,
                           capability=capability, max_records=max_records)
