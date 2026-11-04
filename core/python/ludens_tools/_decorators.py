"""Capability declarations and optional recording at the actual Python call."""

from functools import wraps
import hashlib
import inspect
import os
from pathlib import Path
import time
import uuid

from ._context import current, eval_env, invocation, request
from ._observation_history import validate_sample


_clock = "python-capability-" + uuid.uuid4().hex


def _mark(target, kind):
    flags = getattr(target, "__ludens_declaration__", None)
    if flags is None:
        source = Path(target.__code__.co_filename).resolve()
        workspace = Path(current()["workspace"]).resolve()
        path = os.path.relpath(source, workspace)
        # This is the loaded version, not whatever may be edited later on disk.
        code_sha = target.__globals__.get("__ludens_source_sha__")
        if code_sha is None and source.is_file():
            code_sha = hashlib.sha256(source.read_bytes()).hexdigest()
        identity = {"id": f"python/{path}:{target.__qualname__}", "codeSHA": code_sha,
                    "origin": {"path": path, "function": target.__qualname__, "line": target.__code__.co_firstlineno}}
        flags = {"capability": False, "recorded": False, "observe": False}
        original = target

        def finish(result, started):
            finished = time.monotonic()
            context = current()
            if not flags["recorded"]:
                return result
            validate_sample(result, context["workspace"])
            message = {"sample": result, "identity": identity,
                       "sampling": {"clock": _clock, "startedAtMs": started * 1000,
                                    "finishedAtMs": finished * 1000},
                       "generation": context.get("generation"), "runId": context.get("run_id"),
                       "trace": context["trace"]}
            local = context.get("timeline_append")
            result = local(**message) if local is not None else request(
                context["socket_path"], {"kind": "timeline", "argv": [], "action": "append", **message}, context["timeout"])
            recording = context.get("recording_window")
            if recording is not None:
                recording.recorded()
            return result

        def check():
            if flags["recorded"] and not flags["capability"]:
                raise ValueError("@record requires @capability on the same function")
            if flags["observe"] and not flags["capability"]:
                raise ValueError("@observe requires @capability on the same function")

        if inspect.iscoroutinefunction(target):
            @wraps(target)
            async def wrapped(*args, **kwargs):
                check()
                with invocation(identity):
                    started = time.monotonic()
                    return finish(await original(*args, **kwargs), started)
        else:
            @wraps(target)
            def wrapped(*args, **kwargs):
                check()
                with invocation(identity):
                    started = time.monotonic()
                    return finish(original(*args, **kwargs), started)
        wrapped.__ludens_declaration__ = flags
        wrapped.__ludens_identity__ = identity
        target = wrapped
    flags[kind] = True
    target.__ludens_capability__ = flags["capability"]
    target.__ludens_recorded__ = flags["recorded"]
    target.__ludens_observe__ = flags["observe"]
    return target


def capability(function=None):
    """Expose an ordinary function through the workspace capability catalog."""
    return (lambda target: _mark(target, "capability")) if function is None else _mark(function, "capability")


def record(function=None):
    """Record each successful @capability result envelope on the workspace timeline."""
    return (lambda target: _mark(target, "recorded")) if function is None else _mark(function, "recorded")


def observe(function=None):
    """Mark the workspace's unique observation capability for the agent loop."""
    return (lambda target: _mark(target, "observe")) if function is None else _mark(function, "observe")


def _target_identity(target):
    if isinstance(target, str):
        return target
    marked = getattr(target, "__ludens_identity__", None)
    if marked is not None:
        return marked["id"]
    source = Path(target.__code__.co_filename).resolve()
    workspace = Path(current()["workspace"]).resolve()
    return "python/" + os.path.relpath(source, workspace).replace(os.sep, "/") + ":" + target.__qualname__

def _declaration_identity(target):
    """Stable identity for a top-level declaration (function or class)."""
    if inspect.isfunction(target):
        filename, line = target.__code__.co_filename, target.__code__.co_firstlineno
    else:
        filename = inspect.getsourcefile(target)
        line = inspect.getsourcelines(target)[1]
    source = Path(filename).resolve()
    workspace = Path(current()["workspace"]).resolve()
    path = os.path.relpath(source, workspace)
    code_sha = target.__globals__.get("__ludens_source_sha__") if inspect.isfunction(target) else None
    if code_sha is None and source.is_file():
        code_sha = hashlib.sha256(source.read_bytes()).hexdigest()
    return {"id": f"python/{path}:{target.__qualname__}", "codeSHA": code_sha,
            "origin": {"path": path, "function": target.__qualname__, "line": line}}


def _declare_eval_env(target):
    """Turn a documented top-level class or function into a first-class eval env."""
    if not (inspect.getdoc(target) or "").strip():
        raise TypeError("@eval_env requires a docstring")
    target.__ludens_eval_env__ = True
    target.__ludens_identity__ = _declaration_identity(target)
    if isinstance(target, type) and "__enter__" not in target.__dict__ and "__exit__" not in target.__dict__:
        def __enter__(self):
            stack = getattr(self, "_ludens_eval_env_cm", None)
            if stack is None:
                stack = []
                setattr(self, "_ludens_eval_env_cm", stack)
            manager = eval_env(self)
            stack.append(manager)
            manager.__enter__()
            return self

        def __exit__(self, *exception):
            stack = getattr(self, "_ludens_eval_env_cm", None) or []
            manager = stack.pop() if stack else None
            return manager.__exit__(*exception) if manager is not None else False

        target.__enter__ = __enter__
        target.__exit__ = __exit__
    return target


def _eval_env_id(env):
    if env is None:
        return None
    if isinstance(env, str):
        if env.strip():
            return env.strip()
        raise TypeError("@eval_capability env must be an @eval_env declaration or env ID string")
    identity = getattr(env, "__ludens_identity__", None)
    if getattr(env, "__ludens_eval_env__", False) and isinstance(identity, dict):
        return identity.get("id")
    raise TypeError("@eval_capability env must be an @eval_env class/function or capability env ID")


def eval_capability(target, env=None):
    """Bind an evaluation function to a @capability; static discovery resolves it."""
    capability_id = _target_identity(target)
    env_id = _eval_env_id(env)

    def decorate(function):
        function.__ludens_eval__ = True
        function.__ludens_eval_target__ = capability_id
        function.__ludens_eval_env_target__ = env_id
        return function

    return decorate


eval = eval_capability
