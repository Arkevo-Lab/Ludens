"""Internal JSON bridge. Discovery parses source only; invocation executes it."""

import contextlib
import hashlib
import json
import math
import os
from pathlib import Path
import sys
import traceback

from ludens_tools._capabilities import discover, load_eval_function, load_function, validate
from ludens_tools._context import current, offline_timeline_append, scope


def verified_source(workspace, path, expected):
    source = (workspace / path).resolve()
    source.relative_to(workspace)
    raw = source.read_bytes()
    if hashlib.sha256(raw).hexdigest() != expected:
        raise ValueError("Capability source changed after discovery; refresh before invoking it")
    return raw


def invoke(workspace, request):
    capability = request["capability"]
    validate(request["arguments"], capability["parameters"])
    raw = verified_source(workspace, capability["origin"]["path"], capability["codeSHA"])
    # -B prevents cache writes, but still reads existing timestamp-based pyc.
    # Give this fresh process a nonexistent cache root so quick helper edits load.
    sys.pycache_prefix = str(workspace / "__pycache__" / ("ludens-" + os.urandom(12).hex()))
    with invocation_output():
        function = load_function(workspace, capability["origin"]["path"], capability["origin"]["function"], raw=raw)
        result = function(**request["arguments"])
        # JSON is the cross-process contract; incidental prints go to stderr.
        encoded = json.dumps({"ok": True, "result": result}, allow_nan=False)
    return encoded


EVAL_RESULT_ERROR = "Eval function must return a non-empty dict of finite numeric rewards or {rewards, details, passed}"


def _numeric_rewards(value):
    if not isinstance(value, dict) or not value:
        return None
    rewards = {}
    for name, score in value.items():
        if not isinstance(name, str) or type(score) not in (int, float) or not math.isfinite(score):
            return None
        rewards[name] = score
    return rewards


def _eval_rewards(result):
    """Split an eval result into (rewards, details, passed); reject any other shape."""
    envelope, details, passed = result, None, True
    if isinstance(result, dict) and isinstance(result.get("rewards"), dict):
        if set(result) - {"rewards", "details", "passed"}:
            raise ValueError(EVAL_RESULT_ERROR)
        envelope, details = result["rewards"], result.get("details")
        if details is not None and not isinstance(details, dict):
            raise ValueError(EVAL_RESULT_ERROR)
        if "passed" in result:
            if type(result["passed"]) is not bool:
                raise ValueError(EVAL_RESULT_ERROR)
            passed = result["passed"]
    rewards = _numeric_rewards(envelope)
    if rewards is None:
        raise ValueError(EVAL_RESULT_ERROR)
    if details is not None:
        json.dumps(details, allow_nan=False)
    return rewards, details, passed


def evaluate(workspace, request):
    capability = request["capability"]
    binding = capability.get("eval")
    if not isinstance(binding, dict) or not isinstance(binding.get("origin"), dict):
        raise ValueError("Eval execution requires a capability with a bound @eval_capability")
    sources = {path: verified_source(workspace, path, expected) for path, expected in (
        (capability["origin"]["path"], capability["codeSHA"]),
        (binding["origin"]["path"], binding["codeSHA"]))}
    # Evals replay committed evidence; they never inherit live device control.
    os.environ.pop("LUDENS_EPOCH", None)
    os.environ.pop("BASEWARE_EPOCH", None)
    sys.pycache_prefix = str(workspace / "__pycache__" / ("ludens-" + os.urandom(12).hex()))
    with invocation_output():
        function = load_eval_function(workspace, binding["origin"]["path"], binding["origin"]["function"],
                                      raw=sources[binding["origin"]["path"]])
        with scope({**current(), "timeline_append": offline_timeline_append()}):
            rewards, details, passed = _eval_rewards(function())
        encoded = json.dumps({"ok": True, "passed": passed, "rewards": rewards,
                              **({"details": details} if details is not None else {})}, allow_nan=False)
    return encoded


@contextlib.contextmanager
def invocation_output():
    # Redirect the descriptor too, so subprocesses and native libraries cannot
    # mix incidental stdout into the bridge's single JSON reply.
    sys.stdout.flush()
    saved_stdout = os.dup(1)
    try:
        os.dup2(2, 1)
        with contextlib.redirect_stdout(sys.stderr):
            yield
    finally:
        sys.stderr.flush()
        os.dup2(saved_stdout, 1)
        os.close(saved_stdout)


def main():
    request = {}
    try:
        request = json.load(sys.stdin)
        workspace = Path(request["workspace"]).resolve()
        if request["action"] == "discover":
            print(json.dumps(discover(workspace), allow_nan=False))
        elif request["action"] == "invoke":
            print(invoke(workspace, request))
        elif request["action"] == "eval":
            print(evaluate(workspace, request))
        else:
            raise ValueError("Unknown Python bridge action")
    except BaseException as error:
        print(json.dumps({"ok": False, "error": {"type": type(error).__name__, "message": str(error),
                         "traceback": traceback.format_exc()}}))
        return 1
    return 0


if __name__ == "__main__":
    # This is a package-internal script, not a directory of top-level user
    # modules. Leaving its folder on sys.path shadows namespace packages such
    # as workspace/benchmarks/ with ludens_tools/benchmarks.py.
    package_directory = Path(__file__).resolve().parent
    sys.path[:] = [entry for entry in sys.path if Path(entry).resolve() != package_directory]
    sys.exit(main())
