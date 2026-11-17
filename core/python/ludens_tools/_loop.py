"""Programmable workspace outer control loop SDK and resident JSON-line worker."""

from __future__ import annotations

from collections.abc import Callable, Mapping
from contextlib import contextmanager
import copy
from dataclasses import dataclass, field
import hashlib
import inspect
import json
import math
import os
from pathlib import Path
import signal
import sys
import threading
import time
import traceback
from typing import Any
import uuid

_UNSET: Any = object()


def _pick(mapping: Mapping[str, Any], *keys: str, default: Any = None) -> Any:
    for key in keys:
        if key in mapping:
            return mapping[key]
    return default


@dataclass
class TurnInjection:
    """Mutable round-start `<observation_context>` builder passed to `Loop.inject`."""

    records: list[dict[str, Any]] = field(default_factory=list)
    perception_state: dict[str, Any] | None = None
    event_pool: dict[str, Any] | None = None
    fault: dict[str, Any] | None = None
    extra: list[Any] = field(default_factory=list)
    attach_images: bool = True
    ok: bool = True
    error: str | dict[str, Any] | None = None
    availability: dict[str, Any] | None = None

    def to_payload(self) -> dict[str, Any]:
        if self.ok:
            payload: dict[str, Any] = {"ok": True, "records": list(self.records)}
        else:
            payload = {"ok": False}
            if self.error:
                payload["error"] = self.error
            if self.availability is not None:
                payload["availability"] = self.availability
        if self.perception_state is not None:
            payload["perceptionState"] = self.perception_state
        if self.event_pool is not None:
            payload["eventPool"] = self.event_pool
        if self.fault is not None:
            payload["loopFault"] = self.fault
        if len(self.extra) > 0:
            payload["extra"] = list(self.extra)
        return payload


@dataclass
class TurnContext:
    """Read-only snapshot of turn state delivered to `Loop.step` and `Loop.inject`."""

    turn: int
    llm_turns: int
    initial_message: str | None
    default_prompt: str
    steered: bool
    perception: dict[str, Any]
    perception_state: dict[str, Any] | None = None
    event_pool: dict[str, Any] | None = None
    last_turn: dict[str, Any] | None = None
    remaining_seconds: float | None = None
    fault: dict[str, Any] | None = None

    @classmethod
    def from_wire(cls, raw: Mapping[str, Any]) -> TurnContext:
        if not isinstance(raw, Mapping):
            raise TypeError("TurnContext wire payload must be a JSON object")
        initial_raw = _pick(raw, "initial_message", "initialMessage", default=None)
        default_prompt_raw = _pick(raw, "default_prompt", "defaultPrompt", default="")
        perception_raw = raw.get("perception")
        perception_state_raw = _pick(raw, "perception_state", "perceptionState", default=None)
        event_pool_raw = _pick(raw, "event_pool", "eventPool", default=None)
        last_turn_raw = _pick(raw, "last_turn", "lastTurn", default=None)
        remaining_raw = _pick(raw, "remaining_seconds", "remainingSeconds", default=None)
        fault_raw = _pick(raw, "fault", "loopFault", "loop_fault", default=None)
        return cls(
            turn=int(raw.get("turn", 0)),
            llm_turns=int(_pick(raw, "llm_turns", "llmTurns", default=0)),
            initial_message=str(initial_raw) if initial_raw is not None else None,
            default_prompt="" if default_prompt_raw is None else str(default_prompt_raw),
            steered=bool(raw.get("steered", False)),
            perception=copy.deepcopy(dict(perception_raw)) if isinstance(perception_raw, Mapping) else {"ok": True, "records": []},
            perception_state=copy.deepcopy(dict(perception_state_raw)) if isinstance(perception_state_raw, Mapping) else None,
            event_pool=copy.deepcopy(dict(event_pool_raw)) if isinstance(event_pool_raw, Mapping) else None,
            last_turn=copy.deepcopy(dict(last_turn_raw)) if isinstance(last_turn_raw, Mapping) else None,
            remaining_seconds=float(remaining_raw) if remaining_raw is not None else None,
            fault=copy.deepcopy(dict(fault_raw)) if isinstance(fault_raw, Mapping) else None,
        )

    def default_inject(self) -> TurnInjection:
        perception = self.perception if isinstance(self.perception, dict) else {}
        raw_ok = perception.get("ok")
        ok = bool(raw_ok) if raw_ok is not None else True
        raw_records = perception.get("records")
        records = copy.deepcopy(list(raw_records)) if isinstance(raw_records, list) else []
        error = copy.deepcopy(perception.get("error")) if "error" in perception else None
        raw_availability = perception.get("availability")
        availability = copy.deepcopy(raw_availability) if isinstance(raw_availability, dict) else None
        return TurnInjection(
            records=records,
            perception_state=copy.deepcopy(self.perception_state),
            event_pool=copy.deepcopy(self.event_pool),
            fault=copy.deepcopy(self.fault),
            extra=[],
            attach_images=True,
            ok=ok,
            error=error,
            availability=availability,
        )


@dataclass
class Prompt:
    """Run an LLM turn with optional prompt override and context injection."""

    prompt: str | None = None
    injection: Any = _UNSET

    def __post_init__(self) -> None:
        if self.prompt is not None and not isinstance(self.prompt, str):
            raise TypeError("Prompt.prompt must be a string or None")


@dataclass
class Consolidate:
    """Run an in-cycle memory/file consolidation turn without ending the cycle."""

    prompt: str | None = None

    def __post_init__(self) -> None:
        if self.prompt is not None and not isinstance(self.prompt, str):
            raise TypeError("Consolidate.prompt must be a string or None")


@dataclass
class Wait:
    """Pause between loop steps without spending LLM tokens; human Steer preempts immediately."""

    seconds: float = 1.0
    reason: str | None = None

    def __post_init__(self) -> None:
        if (
            isinstance(self.seconds, bool)
            or not isinstance(self.seconds, (int, float))
            or not math.isfinite(self.seconds)
            or self.seconds < 0
        ):
            raise ValueError("Wait.seconds must be a finite non-negative number")
        self.seconds = float(self.seconds)
        if self.reason is not None and not isinstance(self.reason, str):
            raise TypeError("Wait.reason must be a string or None")


@dataclass
class Stop:
    """Conclude the autonomous cycle cleanly with an explicit reason."""

    reason: str = "completed"

    def __post_init__(self) -> None:
        if not isinstance(self.reason, str):
            raise TypeError("Stop.reason must be a string")


LoopAction = Prompt | Consolidate | Wait | Stop


class Loop:
    """Base class for optional workspace `loop.py` control loops."""

    def inject(self, ctx: TurnContext) -> TurnInjection | dict[str, Any] | str | None:
        return ctx.default_inject()

    def step(self, ctx: TurnContext) -> LoopAction:
        return Prompt()


def _normalize_injection(inj: Any) -> dict[str, Any]:
    if isinstance(inj, TurnInjection):
        normalized: dict[str, Any] = {
            "mode": "structured",
            "payload": inj.to_payload(),
            "attachImages": bool(inj.attach_images),
        }
    elif isinstance(inj, dict):
        normalized = {
            "mode": "custom_json",
            "payload": inj,
            "attachImages": True,
        }
    elif isinstance(inj, str):
        normalized = {
            "mode": "custom_text",
            "payload": inj,
            "attachImages": True,
        }
    elif inj is None:
        normalized = {
            "mode": "none",
            "payload": None,
            "attachImages": False,
        }
    else:
        raise TypeError(
            f"Loop injection must be TurnInjection, dict, str, or None; got {type(inj).__name__}"
        )
    try:
        json.dumps(normalized, allow_nan=False)
    except (TypeError, ValueError) as exc:
        raise TypeError(f"Loop injection payload must be finite JSON: {exc}") from exc
    return normalized


def _normalize_action(
    action: Any,
    ctx: TurnContext,
    inject_fn: Callable[[TurnContext], Any],
) -> dict[str, Any]:
    if isinstance(action, Prompt):
        if action.prompt is not None and not isinstance(action.prompt, str):
            raise TypeError("Prompt.prompt must be a string or None")
        raw_injection = inject_fn(ctx) if action.injection is _UNSET else action.injection
        return {
            "kind": "prompt",
            "prompt": action.prompt,
            "injection": _normalize_injection(raw_injection),
        }
    if isinstance(action, Consolidate):
        if action.prompt is not None and not isinstance(action.prompt, str):
            raise TypeError("Consolidate.prompt must be a string or None")
        return {
            "kind": "consolidate",
            "prompt": action.prompt,
        }
    if isinstance(action, Wait):
        if (
            isinstance(action.seconds, bool)
            or not isinstance(action.seconds, (int, float))
            or not math.isfinite(action.seconds)
            or action.seconds < 0
        ):
            raise ValueError("Wait.seconds must be a finite non-negative number")
        if action.reason is not None and not isinstance(action.reason, str):
            raise TypeError("Wait.reason must be a string or None")
        return {
            "kind": "wait",
            "seconds": float(action.seconds),
            "reason": action.reason,
        }
    if isinstance(action, Stop):
        reason = action.reason if isinstance(action.reason, str) else str(action.reason)
        return {
            "kind": "stop",
            "reason": reason,
        }
    raise TypeError(
        f"Loop.step must return Prompt, Consolidate, Wait, or Stop; got {type(action).__name__}"
    )


def _format_error(exc: BaseException, workspace: Path) -> str:
    resolved = workspace.resolve()
    if isinstance(exc, SyntaxError):
        filename = exc.filename
        if isinstance(filename, str):
            try:
                rel = Path(filename).resolve().relative_to(resolved).as_posix()
            except (OSError, ValueError):
                rel = filename
        else:
            rel = "loop.py"
        msg = exc.msg or str(exc)
        if exc.lineno is not None:
            return f"{type(exc).__name__}: {msg} ({rel}:{exc.lineno})"
        return f"{type(exc).__name__}: {msg} ({rel})"

    location: str | None = None
    for frame in reversed(traceback.extract_tb(exc.__traceback__)):
        try:
            rel = Path(frame.filename).resolve().relative_to(resolved).as_posix()
        except (OSError, ValueError):
            continue
        location = f"{rel}:{frame.lineno} in {frame.name}"
        break
    base = f"{type(exc).__name__}: {exc}"
    return f"{base} ({location})" if location else base


def _digest_file(path: Path) -> str | None:
    try:
        return hashlib.sha256(path.read_bytes()).hexdigest()
    except FileNotFoundError:
        return None


@dataclass
class _ResidentLoopState:
    workspace: Path | None = None
    loaded_once: bool = False
    ok: bool = True
    implemented: bool = False
    generation: str | None = None
    code_sha: str | None = None
    error: str | None = None
    instance: Any = None
    manifest: dict[str, str | None] = field(default_factory=dict)

    def step_fn(self, ctx: TurnContext) -> Any:
        method = getattr(self.instance, "step", None) if self.instance is not None else None
        if callable(method):
            return method(ctx)
        return Prompt()

    def inject_fn(self, ctx: TurnContext) -> Any:
        method = getattr(self.instance, "inject", None) if self.instance is not None else None
        if callable(method):
            return method(ctx)
        return ctx.default_inject()


class _LoopController:
    """In-process lifecycle and hot-reload manager for workspace `loop.py`."""

    def __init__(self) -> None:
        self.state = _ResidentLoopState()

    def close_instance(self) -> None:
        old = self.state.instance
        self.state.instance = None
        if old is None:
            return
        close_fn = getattr(old, "close", None)
        if callable(close_fn):
            try:
                sig = inspect.signature(close_fn)
                required = [
                    param for param in sig.parameters.values()
                    if param.default is inspect.Parameter.empty
                    and param.kind in (inspect.Parameter.POSITIONAL_ONLY, inspect.Parameter.POSITIONAL_OR_KEYWORD)
                ]
                if not required:
                    close_fn()
            except Exception:
                traceback.print_exc(file=sys.stderr)

    def has_source_changes(self, workspace: Path) -> bool:
        resolved = workspace.resolve()
        if not self.state.loaded_once or self.state.workspace != resolved:
            return True
        tracked = dict(self.state.manifest)
        if "loop.py" not in tracked:
            tracked["loop.py"] = self.state.code_sha
        for rel_path, expected_sha in tracked.items():
            if _digest_file(resolved / rel_path) != expected_sha:
                return True
        return False

    def _manifest_paths(self, workspace: Path, run_dir: str | None, generation: str) -> list[Path]:
        paths = [workspace / ".ludens" / "runtime" / "loop" / "sources.json"]
        if isinstance(run_dir, str) and run_dir:
            base = Path(run_dir).resolve() / "loop"
            paths.append(base / "sources.json")
            paths.append(base / generation / "sources.json")
        return paths

    def ensure_loaded(
        self,
        workspace: Path,
        *,
        run_dir: str | None = None,
        requested_generation: str | None = None,
        force: bool = False,
    ) -> _ResidentLoopState:
        from ._context import current, scope
        from ._resident import load_optional_resident

        resolved = workspace.resolve()
        os.environ["LUDENS_WORKSPACE"] = str(resolved)
        if not force and not self.has_source_changes(resolved):
            return self.state

        previous_manifest = dict(self.state.manifest) if self.state.workspace == resolved else None
        self.close_instance()
        generation = (
            requested_generation
            if isinstance(requested_generation, str) and requested_generation
            else str(uuid.uuid4())
        )
        manifest_paths = self._manifest_paths(resolved, run_dir, generation)
        try:
            with scope({**current(), "workspace": str(resolved)}):
                loaded = load_optional_resident(
                    resolved,
                    "loop",
                    "Loop",
                    ("step", "inject"),
                    manifest_paths=manifest_paths,
                    previous_manifest=previous_manifest,
                )
        except Exception as exc:
            traceback.print_exc(file=sys.stderr)
            code_sha = getattr(exc, "__ludens_code_sha__", None) or _digest_file(resolved / "loop.py")
            manifest = getattr(exc, "__ludens_manifest__", None)
            if not isinstance(manifest, dict):
                manifest = {"loop.py": code_sha}
            self.state = _ResidentLoopState(
                workspace=resolved,
                loaded_once=True,
                ok=False,
                implemented=True,
                generation=None,
                code_sha=code_sha,
                error=_format_error(exc, resolved),
                instance=None,
                manifest=manifest,
            )
            return self.state

        if not loaded["implemented"]:
            self.state = _ResidentLoopState(
                workspace=resolved,
                loaded_once=True,
                ok=True,
                implemented=False,
                generation=None,
                code_sha=None,
                error=None,
                instance=None,
                manifest=loaded["manifest"],
            )
            return self.state

        self.state = _ResidentLoopState(
            workspace=resolved,
            loaded_once=True,
            ok=True,
            implemented=True,
            generation=generation,
            code_sha=loaded["code_sha"],
            error=None,
            instance=loaded["instance"],
            manifest=loaded["manifest"],
        )
        return self.state


@contextmanager
def _execution_scope(workspace: Path, message: Mapping[str, Any]):
    from ._context import current, scope

    resolved_str = str(workspace.resolve())
    os.environ["LUDENS_WORKSPACE"] = resolved_str
    msg_socket = message.get("socketPath")
    if isinstance(msg_socket, str) and msg_socket:
        os.environ["LUDENS_SOCKET"] = msg_socket

    base = current()
    raw_scope = message.get("scope")
    msg_scope = raw_scope if isinstance(raw_scope, Mapping) else {}

    socket_path = (
        msg_socket
        if isinstance(msg_socket, str) and msg_socket
        else (msg_scope.get("socketPath") if isinstance(msg_scope.get("socketPath"), str) else os.environ.get("LUDENS_SOCKET") or base.get("socket_path"))
    )
    epoch = msg_scope["epoch"] if "epoch" in msg_scope else message.get("epoch", base.get("epoch"))
    raw_trace = msg_scope.get("trace") if "trace" in msg_scope else message.get("trace")
    trace: dict[str, Any] = dict(raw_trace) if isinstance(raw_trace, Mapping) else dict(base.get("trace") or {})

    run_dir = message.get("runDir")
    run_id = (
        message.get("runId")
        or msg_scope.get("runId")
        or (Path(run_dir).name if isinstance(run_dir, str) and run_dir else None)
        or os.environ.get("LUDENS_RUN_ID")
        or base.get("run_id")
        or trace.get("recordingId")
    )
    diagnostics = (
        message.get("diagnostics")
        if isinstance(message.get("diagnostics"), str)
        else os.environ.get("LUDENS_LOG_DIAGNOSTICS", base.get("diagnostics", "normal"))
    )

    call_context: dict[str, Any] = {
        **base,
        "workspace": resolved_str,
        "socket_path": socket_path,
        "epoch": epoch,
        "trace": trace,
        "run_id": run_id,
        "diagnostics": diagnostics,
    }

    prev_epoch = os.environ.get("BASEWARE_EPOCH")
    prev_trace = os.environ.get("BASEWARE_TRACE")
    if isinstance(epoch, str) and epoch:
        os.environ["BASEWARE_EPOCH"] = epoch
    else:
        os.environ.pop("BASEWARE_EPOCH", None)
    os.environ["BASEWARE_TRACE"] = json.dumps(trace, allow_nan=False)
    try:
        with scope(call_context):
            yield
    finally:
        if prev_epoch is None:
            os.environ.pop("BASEWARE_EPOCH", None)
        else:
            os.environ["BASEWARE_EPOCH"] = prev_epoch
        if prev_trace is None:
            os.environ.pop("BASEWARE_TRACE", None)
        else:
            os.environ["BASEWARE_TRACE"] = prev_trace


def main() -> int:
    protocol = os.fdopen(os.dup(sys.stdout.fileno()), "w", buffering=1, encoding="utf-8")
    os.dup2(sys.stderr.fileno(), sys.stdout.fileno())
    sys.stdout = sys.stderr
    protocol_lock = threading.Lock()
    controller = _LoopController()

    def send(payload: dict[str, Any]) -> None:
        with protocol_lock:
            protocol.write(json.dumps(payload, allow_nan=False) + "\n")
            protocol.flush()

    def terminate(_signum: int, _frame: Any) -> None:
        raise SystemExit(0)

    signal.signal(signal.SIGTERM, terminate)
    try:
        for raw_line in sys.stdin.buffer:
            line = raw_line.strip()
            if not line:
                continue
            try:
                message = json.loads(line.decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError) as error:
                print(f"Invalid loop worker request: {error}", file=sys.stderr)
                continue
            if not isinstance(message, dict):
                print("Invalid loop worker request: expected JSON object", file=sys.stderr)
                continue

            req_id = message.get("id")
            cmd = message.get("type") or message.get("action")
            raw_workspace = message.get("workspace") or os.environ.get("LUDENS_WORKSPACE") or os.getcwd()
            workspace = Path(str(raw_workspace)).resolve()
            run_dir = message.get("runDir") if isinstance(message.get("runDir"), str) else None
            requested_gen = message.get("generation") if isinstance(message.get("generation"), str) else None

            if cmd == "shutdown":
                send({"id": req_id, "ok": True})
                break

            started = time.perf_counter()
            try:
                if cmd == "load":
                    os.environ["LUDENS_WORKSPACE"] = str(workspace)
                    if isinstance(message.get("socketPath"), str) and message["socketPath"]:
                        os.environ["LUDENS_SOCKET"] = message["socketPath"]
                    force = bool(message.get("force")) or (controller.state.loaded_once and not controller.state.ok)
                    state = controller.ensure_loaded(
                        workspace,
                        run_dir=run_dir,
                        requested_generation=requested_gen,
                        force=force,
                    )
                    if not state.implemented:
                        send({
                            "id": req_id,
                            "ok": True,
                            "implemented": False,
                            "generation": None,
                            "codeSHA": None,
                        })
                    elif state.ok:
                        send({
                            "id": req_id,
                            "ok": True,
                            "implemented": True,
                            "generation": state.generation,
                            "codeSHA": state.code_sha,
                        })
                    else:
                        send({
                            "id": req_id,
                            "ok": False,
                            "implemented": True,
                            "generation": None,
                            "error": state.error or "Failed to load loop.py",
                            "codeSHA": state.code_sha,
                        })
                elif cmd == "step":
                    state = controller.ensure_loaded(
                        workspace,
                        run_dir=run_dir,
                        requested_generation=requested_gen,
                    )
                    ctx = TurnContext.from_wire(message.get("context") or {})
                    if not state.implemented:
                        elapsed_ms = round((time.perf_counter() - started) * 1000, 2)
                        send({
                            "id": req_id,
                            "ok": True,
                            "implemented": False,
                            "generation": None,
                            "codeSHA": None,
                            "durationMs": elapsed_ms,
                            "action": {
                                "kind": "prompt",
                                "prompt": None,
                                "injection": _normalize_injection(ctx.default_inject()),
                            },
                        })
                    elif not state.ok:
                        elapsed_ms = round((time.perf_counter() - started) * 1000, 2)
                        send({
                            "id": req_id,
                            "ok": False,
                            "implemented": True,
                            "generation": None,
                            "codeSHA": state.code_sha,
                            "durationMs": elapsed_ms,
                            "error": state.error or "Failed to load loop.py",
                        })
                    else:
                        with _execution_scope(workspace, message):
                            action = state.step_fn(ctx)
                            wire_action = _normalize_action(action, ctx, state.inject_fn)
                        elapsed_ms = round((time.perf_counter() - started) * 1000, 2)
                        send({
                            "id": req_id,
                            "ok": True,
                            "implemented": True,
                            "generation": state.generation,
                            "codeSHA": state.code_sha,
                            "durationMs": elapsed_ms,
                            "action": wire_action,
                        })
                elif cmd == "inject":
                    state = controller.ensure_loaded(
                        workspace,
                        run_dir=run_dir,
                        requested_generation=requested_gen,
                    )
                    ctx = TurnContext.from_wire(message.get("context") or {})
                    if not state.implemented:
                        elapsed_ms = round((time.perf_counter() - started) * 1000, 2)
                        send({
                            "id": req_id,
                            "ok": True,
                            "implemented": False,
                            "generation": None,
                            "codeSHA": None,
                            "durationMs": elapsed_ms,
                            "injection": _normalize_injection(ctx.default_inject()),
                        })
                    elif not state.ok:
                        elapsed_ms = round((time.perf_counter() - started) * 1000, 2)
                        send({
                            "id": req_id,
                            "ok": False,
                            "implemented": True,
                            "generation": None,
                            "codeSHA": state.code_sha,
                            "durationMs": elapsed_ms,
                            "error": state.error or "Failed to load loop.py",
                        })
                    else:
                        with _execution_scope(workspace, message):
                            raw_injection = state.inject_fn(ctx)
                            normalized_injection = _normalize_injection(raw_injection)
                        elapsed_ms = round((time.perf_counter() - started) * 1000, 2)
                        send({
                            "id": req_id,
                            "ok": True,
                            "implemented": True,
                            "generation": state.generation,
                            "codeSHA": state.code_sha,
                            "durationMs": elapsed_ms,
                            "injection": normalized_injection,
                        })
                else:
                    raise ValueError(f"Unknown loop worker command: {cmd!r}")
            except Exception as exc:
                traceback.print_exc(file=sys.stderr)
                elapsed_ms = round((time.perf_counter() - started) * 1000, 2)
                send({
                    "id": req_id,
                    "ok": False,
                    "implemented": controller.state.implemented,
                    "generation": controller.state.generation,
                    "codeSHA": controller.state.code_sha,
                    "durationMs": elapsed_ms,
                    "error": _format_error(exc, workspace),
                })
    finally:
        controller.close_instance()
        protocol.close()
    return 0


if __name__ == "__main__":
    from ludens_tools._loop import main as _module_main

    raise SystemExit(_module_main())
