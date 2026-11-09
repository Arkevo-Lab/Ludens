"""Synchronous access to the workspace's unified capability interface."""

from __future__ import annotations
from contextvars import ContextVar
import builtins
import copy
import math
from pathlib import Path
import threading
import time
from typing import Any
import uuid
from ._context import LudensError, continuous, current, record_client_rpc, request, scope
from ._observation_history import MAIN_CAPABILITY, _StreamMediaRef, _iso, read_timeline, timestamp
_in_eval_env_observe = ContextVar("ludens_in_eval_env_observe", default=False)
_LATEST_OBSERVE_LOCK = threading.Lock()

def _timed_request(method, context, message):
    """One driver RPC, timed and rolled into the active invocation's rpc stats."""
    started = time.perf_counter()
    try:
        return request(context["socket_path"], message, context["timeout"])
    except BaseException:
        record_client_rpc(method, round((time.perf_counter() - started) * 1000), False)
        raise
    record_client_rpc(method, round((time.perf_counter() - started) * 1000), True)

_LATEST_OBSERVE_CACHE: dict[tuple[str, str], tuple[int, dict[str, Any]]] = {}


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
        return _timed_request(f"controller.{action}", context, message)

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

    def state(self) -> Any:
        """Inspect the active capability and arguments of the resident perception state machine."""
        context = self._context()
        return _timed_request("perception.state", context, {
            "kind": "perception", "argv": ["state"],
            **({"epoch": context["epoch"]} if context["epoch"] is not None else {}), "trace": context["trace"],
        })

    def transition(self, to: str, arguments: dict[str, Any] | None = None) -> Any:
        """Transition the resident perception state machine to another capability."""
        if not isinstance(to, str) or not to:
            raise ValueError("A transition requires a nonempty target capability")
        if arguments is None:
            arguments = {}
        if not isinstance(arguments, dict) or not all(isinstance(key, str) for key in arguments):
            raise TypeError("Transition arguments must be a JSON object")
        context = self._context()
        return _timed_request("perception.transition", context, {
            "kind": "perception", "argv": ["transition", to], "arguments": arguments,
            **({"epoch": context["epoch"]} if context["epoch"] is not None else {}), "trace": context["trace"],
        })

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
        q = dict(query or {})
        eligible = (set(q.keys()) <= {"capability", "limit"} and q.get("limit") in (None, 1)
                    and q.get("capability") != "*")
        if context["socket_path"] is None:
            return self._offline_timeline(context, query)
        cache_key = None
        cached = None
        if eligible:
            cache_key = (str(Path(context["workspace"]).resolve()), str(q.get("capability") or MAIN_CAPABILITY))
            with _LATEST_OBSERVE_LOCK:
                cached = _LATEST_OBSERVE_CACHE.get(cache_key)
        req_query = {**q, "ifNoneMatchSequence": cached[0]} if cached is not None else q
        try:
            reply = _timed_request("perception.observe", context, {
                "kind": "perception", "argv": ["observe"], "query": req_query,
                **({"epoch": context["epoch"]} if context["epoch"] is not None else {}), "trace": context["trace"],
            })
        except (FileNotFoundError, ConnectionRefusedError):
            return self._offline_timeline(context, query)
        except LudensError as error:
            # A host that never started or already stopped still serves reads.
            text = str(error)
            if "ENOENT" in text or "ECONNREFUSED" in text or "Unavailable" in text:
                return self._offline_timeline(context, query)
            raise
        if cache_key is not None and isinstance(reply, dict) and reply.get("ok") is True:
            if reply.get("unchanged") is True and cached is not None and reply.get("sequence") == cached[0]:
                restored = {key: value for key, value in reply.items() if key not in ("unchanged", "sequence")}
                restored["records"] = [copy.deepcopy(cached[1])]
                echoed = restored.get("query")
                if isinstance(echoed, dict) and "ifNoneMatchSequence" not in q:
                    restored["query"] = {key: value for key, value in echoed.items() if key != "ifNoneMatchSequence"}
                return restored
            records = reply.get("records") or []
            if len(records) == 1 and isinstance(records[0].get("sequence"), int):
                with _LATEST_OBSERVE_LOCK:
                    _LATEST_OBSERVE_CACHE[cache_key] = (records[0]["sequence"], copy.deepcopy(records[0]))
                echoed = reply.get("query")
                if isinstance(echoed, dict) and "ifNoneMatchSequence" not in q:
                    reply["query"] = {key: value for key, value in echoed.items() if key != "ifNoneMatchSequence"}
        return reply

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
            if anchor.get("ok") is False:
                raise LudensError(str((anchor.get("error") or {}).get("message") or "Observation query failed"))
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
        page_limit = min(64, max_records)
        while len(records) < max_records:
            limit = min(page_limit, max_records - len(records))
            try:
                page = self.observe({**query, "limit": limit})
            except (ValueError, LudensError) as error:
                if "exceed the query byte budget" in str(error):
                    if limit > 1:
                        page_limit = max(1, limit // 2)
                        continue
                raise
            if page.get("ok") is False:
                message = str((page.get("error") or {}).get("message") or "Observation query failed")
                if "exceed the query byte budget" in message and limit > 1:
                    page_limit = max(1, limit // 2)
                    continue
                raise LudensError(message)
            batch = page.get("records", [])
            records.extend(batch)
            if not page.get("hasMore") or not batch:
                break
            query["after"] = page.get("nextAfter", batch[-1]["sequence"])
        return records

    def call(self, capability_id: str, arguments: dict[str, Any] | None = None, *, machine: str | None = None) -> Any:
        """Call a driver or local Python function with named arguments."""
        if machine is not None:
            if not isinstance(machine, str) or not machine.strip():
                raise ValueError("machine must be a non-empty string")
            if capability_id.startswith("controller/"):
                rest = capability_id[len("controller/"):]
                if not rest.startswith(f"{machine}/"):
                    capability_id = f"controller/{machine}/{rest}"
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
        result = self._request("call", **fields)
        if isinstance(result, dict):
            observations = result.get("observations")
            outcome = result.get("result")
            content = outcome.get("content") if isinstance(outcome, dict) else None
            if isinstance(observations, list):
                # Baseware spools stream media to disk and omits the inline
                # Base64 payload; wrap the content block in a lazy reference.
                for obs in observations:
                    if isinstance(obs, dict) and isinstance(obs.get("path"), str) and obs["path"]:
                        source_meta = {key: obs[key] for key in ("id", "controllerId", "machineId", "timing", "sourceSequence")
                                       if key in obs}
                        if "machineId" not in source_meta:
                            ctrl_id = obs.get("controllerId")
                            if isinstance(ctrl_id, str) and "/" in ctrl_id:
                                source_meta["machineId"] = ctrl_id.split("/", 1)[0]
                            elif machine:
                                source_meta["machineId"] = machine
                        index = obs.get("contentIndex")
                        if (isinstance(content, list) and isinstance(index, int)
                                and 0 <= index < len(content) and isinstance(content[index], dict)):
                            block = content[index]
                            block["path"] = obs["path"]
                            block["data"] = _StreamMediaRef(
                                block.get("data") if isinstance(block.get("data"), str) else "",
                                path=obs["path"], sha256=obs.get("sha256"), media_bytes=obs.get("bytes"),
                                media_type=obs.get("mediaType") or block.get("mimeType"), source=source_meta)
        return result

    def machines(self) -> Any:
        """List mounted and registered machines in the current workspace."""
        context = self._context()
        return _timed_request("machine.list", context, {
            "kind": "machine", "argv": ["list"],
            **({"epoch": context["epoch"]} if context["epoch"] is not None else {}), "trace": context["trace"],
        })

    def use_machine(self, machine_id: str) -> Any:
        """Switch the active primary machine in the current workspace."""
        if not isinstance(machine_id, str) or not machine_id.strip():
            raise ValueError("machine_id must be a non-empty string")
        context = self._context()
        return _timed_request("machine.use", context, {
            "kind": "machine", "argv": ["use", machine_id.strip()],
            **({"epoch": context["epoch"]} if context["epoch"] is not None else {}), "trace": context["trace"],
        })

    def connect_machines(self, *machine_ids: str) -> Any:
        """Mount one or more machines concurrently in Baseware."""
        cleaned = [m.strip() for m in machine_ids if isinstance(m, str) and m.strip()]
        if not cleaned:
            raise ValueError("connect_machines requires at least one machine_id")
        context = self._context()
        return _timed_request("machine.connect", context, {
            "kind": "machine", "argv": ["connect", *cleaned],
            **({"epoch": context["epoch"]} if context["epoch"] is not None else {}), "trace": context["trace"],
        })

    def disconnect_machines(self, machine_id: str) -> Any:
        """Unmount a secondary machine from Baseware."""
        if not isinstance(machine_id, str) or not machine_id.strip():
            raise ValueError("machine_id must be a non-empty string")
        context = self._context()
        return _timed_request("machine.disconnect", context, {
            "kind": "machine", "argv": ["disconnect", machine_id.strip()],
            **({"epoch": context["epoch"]} if context["epoch"] is not None else {}), "trace": context["trace"],
        })


def replay(window: Any = None, *, start: str | float | int | None = None,
           end: str | float | int | None = None, around: str | None = None,
           before_seconds: float = 2.0, after_seconds: float = 2.0,
           capability: str | None = None, max_records: int = 256) -> list[dict[str, Any]]:
    """Read timeline records using the ambient client context."""
    return Client().replay(window, start=start, end=end, around=around,
                           before_seconds=before_seconds, after_seconds=after_seconds,
                           capability=capability, max_records=max_records)
