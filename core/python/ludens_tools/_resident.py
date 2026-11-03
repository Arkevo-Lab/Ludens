"""Shared source loading and fixed-rate execution for workspace residents."""

import hashlib
import importlib.abc
import importlib.machinery
import inspect
import json
import os
from pathlib import Path
import sys
import threading
import time
import types
import uuid

from ._capabilities import load_function
from ._context import current, scope
from ._observation_history import validate_effect, validate_transition
from ._recording import RecordingWindow
from .client import Client


class WorkspaceSourceLoader(importlib.machinery.SourceFileLoader):
    def __init__(self, fullname, path, remember):
        super().__init__(fullname, path)
        self.remember = remember

    def get_code(self, fullname):
        raw = self.get_data(self.path)
        self.remember(Path(self.path), raw)
        module = sys.modules[fullname]
        module.__ludens_source_sha__ = hashlib.sha256(raw).hexdigest()
        module.__ludens_source_bytes__ = raw
        return self.source_to_code(raw, self.path)


class WorkspaceImports(importlib.abc.MetaPathFinder):
    def __init__(self, workspace, remember):
        self.workspace = workspace
        self.remember = remember

    def find_spec(self, fullname, path=None, target=None):
        spec = importlib.machinery.PathFinder.find_spec(fullname, path)
        if (spec and spec.origin and spec.origin.endswith(".py")
                and Path(spec.origin).resolve().is_relative_to(self.workspace)):
            spec.loader = WorkspaceSourceLoader(fullname, spec.origin, self.remember)
        return spec


class _TopLevelEntry:
    """Adapt a top-level @observe @record @capability function to the resident entry."""

    def __init__(self, function):
        self._function = function

    def start(self, context):
        pass

    def close(self):
        pass

    def __getattr__(self, name):
        if name == "sample" or name == self._function.__name__:
            return self._function
        raise AttributeError(name)


def load_instance(message, role, class_name, method_name, *, recorded=False):
    workspace = Path(message["workspace"]).resolve()
    source = message.get("source")
    if message.get("sourceError"):
        raise RuntimeError(message["sourceError"])
    if source is None:
        raise NotImplementedError(f"Implement workspace/{role}.py:{class_name}, then reload it.")
    manifest = {}
    manifest_lock = threading.Lock()
    manifest_path = Path(message["runDir"]) / role / message["generation"] / "sources.json"
    manifest_path.parent.mkdir(parents=True, exist_ok=True)

    def remember(path, raw):
        with manifest_lock:
            manifest[str(path.relative_to(workspace))] = hashlib.sha256(raw).hexdigest()
            temporary = manifest_path.with_suffix(".tmp")
            temporary.write_text(json.dumps(manifest, indent=2) + "\n")
            temporary.replace(manifest_path)

    sys.path.insert(0, str(workspace))
    sys.meta_path.insert(0, WorkspaceImports(workspace, remember))
    module = types.ModuleType(role)
    module.__file__ = str(workspace / f"{role}.py")
    module.__ludens_source_sha__ = hashlib.sha256(source.encode("utf-8")).hexdigest()
    module.__ludens_source_bytes__ = source.encode("utf-8")
    sys.modules[role] = module
    remember(Path(module.__file__), module.__ludens_source_bytes__)
    exec(compile(source, module.__file__, "exec"), module.__dict__)
    klass = getattr(module, class_name, None)
    if klass is not None:
        instance = klass()
        for name in ("start", method_name, "close"):
            if not callable(getattr(instance, name, None)):
                raise TypeError(f"{class_name} must implement {name}()")
        method = getattr(instance, method_name)
        if not getattr(method, "__ludens_capability__", False):
            raise TypeError(f"{class_name}.{method_name} must use @capability")
        if recorded and not getattr(method, "__ludens_recorded__", False):
            raise TypeError(f"{class_name}.{method_name} must use @capability and @record")
        if method.__ludens_identity__["id"] != f"python/{role}.py:{class_name}.{method_name}":
            raise TypeError(f"The entry method must be defined as {role}.py:{class_name}.{method_name}")
    else:
        # Select the decorated observation entry, not a hardcoded function name.
        functions = [value for value in vars(module).values()
                     if callable(value) and getattr(value, "__ludens_observe__", False)
                     and getattr(value, "__module__", None) == module.__name__]
        if len(functions) != 1:
            raise ValueError("Declare exactly one top-level @observe capability in perception.py")
        function = functions[0]
        if not getattr(function, "__ludens_capability__", False):
            raise TypeError("@observe requires @capability on the same function")
        if recorded and not getattr(function, "__ludens_recorded__", False):
            raise TypeError("The observation entry must use @capability and @record")
        instance, method = _TopLevelEntry(function), function
    if inspect.iscoroutinefunction(method):
        raise TypeError(f"{class_name}.{method_name} must be synchronous; use def, not async def")
    return instance


class StateMachine:
    """One-process continuous state machine over the resident's own capabilities.

    Every state runs inside this process, so instance attributes and workspace
    module globals are zero-copy shared context across perception and action.
    """

    def __init__(self, instance, module, method, context):
        self.instance = instance
        self.module = module
        self.workspace = context.get("workspace")
        self.lock = threading.Lock()
        self.active_callable = method
        self.active_arguments = {}
        identity = getattr(method, "__ludens_identity__", None)
        self.active_state = identity["id"] if isinstance(identity, dict) else getattr(method, "__name__", None)
        self.epoch = context.get("epoch")
        self.input_generation = context.get("trace", {}).get("inputGeneration")
        self.actuation_enabled = context.get("actuate", context.get("actuation_enabled"))

    def state(self):
        with self.lock:
            return {"state": self.active_state, "arguments": dict(self.active_arguments), "epoch": self.epoch}

    def set_lease(self, epoch, input_generation):
        """Adopt the host-authorized control lease without restarting."""
        with self.lock:
            self.epoch = epoch
            self.input_generation = input_generation
            return {"epoch": self.epoch, "inputGeneration": self.input_generation}

    def transition_to(self, to, arguments):
        """Move straight to another capability; returns the updated state."""
        if not isinstance(to, str) or not to:
            raise ValueError("A transition requires a nonempty target capability")
        if arguments is None:
            arguments = {}
        if not isinstance(arguments, dict) or not all(isinstance(key, str) for key in arguments):
            raise TypeError("Transition arguments must be an object with string keys")
        return self._set_state(self._resolve(to), arguments, to)

    def tick(self):
        """Run the active state once, then execute its effects and transition."""
        with self.lock:
            active_callable, active_arguments = self.active_callable, self.active_arguments
        result = active_callable(**active_arguments)
        if not isinstance(result, dict):
            return result
        effect, transition = result.get("effect"), result.get("transition")
        # Envelope validation applies even when the capability is not @recorded.
        if effect is not None:
            validate_effect(effect)
        if transition is not None:
            validate_transition(transition)
        if effect is not None:
            self._execute_effect(effect)
        if transition is not None:
            self._apply_transition(transition)
        return result

    def _set_state(self, target, arguments, fallback):
        with self.lock:
            self.active_callable = target
            self.active_arguments = dict(arguments)
            identity = getattr(target, "__ludens_identity__", None)
            self.active_state = identity["id"] if isinstance(identity, dict) else fallback
            return {"state": self.active_state, "arguments": dict(self.active_arguments), "epoch": self.epoch}

    def _resolve(self, name):
        active_module = sys.modules.get(getattr(self.active_callable, "__module__", ""))
        for owner in (self.instance, active_module, self.module):
            if owner is not None:
                candidate = getattr(owner, name, None)
                if callable(candidate) and getattr(candidate, "__ludens_capability__", False):
                    return candidate
        if isinstance(name, str) and name.startswith("python/"):
            relative, separator, function = name.removeprefix("python/").rpartition(":")
            if separator and relative.endswith(".py") and function.isidentifier():
                return load_function(self.workspace, relative, function)
        raise ValueError(f"Unknown transition target capability: {name}")

    def _execute_effect(self, effect):
        context = current()
        socket_path = context.get("socket_path") or os.environ.get("LUDENS_SOCKET")
        with self.lock:
            epoch, input_generation = self.epoch, self.input_generation
        for item in ([effect] if isinstance(effect, dict) else effect):
            target = item["id"]
            arguments = item["arguments"] if item.get("arguments") is not None else (item.get("args") or {})
            # Actuation needs the control lease, a reachable host socket, or
            # an in-process python/ capability.
            if not target.startswith("python/") and epoch is None and self.actuation_enabled is False:
                continue
            if not (target.startswith("python/") or epoch is not None or socket_path):
                continue
            trace = dict(context.get("trace", {}))
            trace.pop("inputGeneration", None)
            if input_generation:
                trace["inputGeneration"] = input_generation
            # The lease epoch and inputGeneration must win over the tick's own.
            with scope({**context, "trace": trace, "epoch": epoch}):
                try:
                    Client().call(target, arguments)
                except Exception as error:
                    if "STALE_EPOCH" in str(error) or "STALE_INPUT_GENERATION" in str(error):
                        with self.lock:
                            if self.epoch == epoch:
                                self.epoch = None
                                self.input_generation = None
                        continue
                    raise

    def _apply_transition(self, transition):
        if isinstance(transition, str):
            self._set_state(self._resolve(transition), {}, transition)
            return
        to = transition["to"]
        arguments = transition["arguments"] if transition.get("arguments") is not None else (transition.get("args") or {})
        self._set_state(self._resolve(to), arguments, to)


def run_continuously(method, hz, context, stopped, send, *, role, halt_on_error=False, video_metrics=None, tick=None):
    """Run serial steps without overlap or catch-up, retaining bounded diagnostics."""
    previous_status = None
    purpose = f"continuous-{role}"
    trace = {**context["trace"], "recordingPurpose": purpose}
    recording = RecordingWindow(send, trace, context["generation"], hz, role=role)

    def record_event(event_type, data, trace, origin, channel):
        send({"event": "recording", "type": event_type, "data": data,
              "trace": trace, "origin": origin, "channel": channel})

    context = {**context, "trace": trace, "recording_purpose": purpose,
               "recording_window": recording, "recording_observer": recording.observe,
               "recording_sink": record_event}
    reason = "stopped"
    try:
        while not stopped.is_set():
            started = time.monotonic()
            trace = {**context["trace"], "spanId": uuid.uuid4().hex[:16]}
            if context["trace"].get("spanId"):
                trace["parentSpanId"] = context["trace"]["spanId"]
            try:
                with scope({**context, "trace": trace}):
                    step = tick if tick is not None else method
                    step()  # @record owns persistence; ordinary returns stay local.
                status = ("ready", None)
            except Exception as error:
                state = "unimplemented" if isinstance(error, NotImplementedError) else "error"
                status = (state, f"{type(error).__name__}: {error}")
            if previous_status != status:
                send({"event": "status", "state": status[0], "error": status[1],
                      "transient": not halt_on_error})
            previous_status = status
            recording.sampled((time.monotonic() - started) * 1000, status[0] == "ready")
            recording.flush(video=video_metrics() if video_metrics else None)
            if halt_on_error and status[0] != "ready":
                reason = "failed"
                break
            stopped.wait(max(0, 1 / hz - (time.monotonic() - started)))
    finally:
        recording.flush(reason=reason, video=video_metrics() if video_metrics else None)
