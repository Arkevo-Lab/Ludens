"""Programmable workspace `loop.py` SDK contracts, hot-reload, fault isolation, and scope propagation."""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import queue
import socketserver
import subprocess
import sys
import threading
import time
from typing import Any
import unittest

import ludens_tools
from ludens_tools import (
    Consolidate,
    Loop,
    Prompt,
    Stop,
    TurnContext,
    TurnInjection,
    Wait,
)

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _support import TemporaryDirectory, UnixStreamServer, stop_process


class LoopWorker:
    """JSON-line client harness driving `python -m ludens_tools._loop`."""

    def __init__(self, root: Path, *, socket_path: str | None = None, extra_env: dict[str, str] | None = None) -> None:
        self.root = root
        self.messages: list[dict[str, Any]] = []
        self.pending: dict[str, queue.Queue[dict[str, Any]]] = {}
        self.lock = threading.Lock()
        self._seq = 0
        self.stderr_path = root / "loop-worker.stderr"
        self.stderr = self.stderr_path.open("w", encoding="utf-8")
        env = {**os.environ, "LUDENS_WORKSPACE": str(root), "BASEWARE_TRACE": "{}"}
        env.pop("BASEWARE_EPOCH", None)
        if socket_path:
            env["LUDENS_SOCKET"] = socket_path
        if extra_env:
            env.update(extra_env)
        self.process = subprocess.Popen(
            [sys.executable, "-u", "-m", "ludens_tools._loop"],
            cwd=root,
            env=env,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=self.stderr,
            text=True,
            encoding="utf-8",
        )

        def read_stdout() -> None:
            assert self.process.stdout is not None
            for line in self.process.stdout:
                msg = json.loads(line)
                self.messages.append(msg)
                req_id = msg.get("id")
                if isinstance(req_id, str) and req_id in self.pending:
                    self.pending[req_id].put(msg)

        self.reader = threading.Thread(target=read_stdout, daemon=True)
        self.reader.start()

    def request(self, msg_type: str, **fields: Any) -> dict[str, Any]:
        with self.lock:
            self._seq += 1
            req_id = f"req-{self._seq}"
            inbox: queue.Queue[dict[str, Any]] = queue.Queue()
            self.pending[req_id] = inbox
            assert self.process.stdin is not None
            self.process.stdin.write(json.dumps({"id": req_id, "type": msg_type, **fields}) + "\n")
            self.process.stdin.flush()
        try:
            return inbox.get(timeout=5)
        finally:
            self.pending.pop(req_id, None)

    def close(self) -> None:
        if self.process.poll() is None:
            try:
                reply = self.request("shutdown")
                assert reply.get("ok") is True
            except Exception:
                pass
        stop_process(self.process)
        if self.process.stdin is not None:
            self.process.stdin.close()
        self.reader.join(timeout=1)
        if self.process.stdout is not None:
            self.process.stdout.close()
        self.stderr.close()


def _sample_wire_context(**overrides: Any) -> dict[str, Any]:
    base: dict[str, Any] = {
        "turn": 2,
        "llmTurns": 1,
        "initialMessage": "stabilize target",
        "defaultPrompt": "Continue autonomous step.",
        "steered": False,
        "perception": {
            "ok": True,
            "records": [
                {
                    "id": "rec-1",
                    "sequence": 7,
                    "recordedAt": "2026-11-17T05:00:00Z",
                    "text": "altitude=12m",
                    "data": {"altitude": 12},
                }
            ],
        },
        "perceptionState": {"state": "python/perception.py:Perception.sample", "arguments": {}},
        "eventPool": {"pending": 1},
        "lastTurn": {"toolCalls": 2},
        "remainingSeconds": 45.5,
        "loopFault": None,
    }
    base.update(overrides)
    return base


class LoopSdkUnitTests(unittest.TestCase):
    def test_public_exports_and_default_base_class(self) -> None:
        for symbol in ("Loop", "TurnContext", "TurnInjection", "Prompt", "Consolidate", "Wait", "Stop"):
            self.assertIn(symbol, ludens_tools.__all__)
            self.assertTrue(hasattr(ludens_tools, symbol))

        ctx = TurnContext.from_wire(_sample_wire_context())
        base_loop = Loop()
        action = base_loop.step(ctx)
        self.assertIsInstance(action, Prompt)
        self.assertIsNone(action.prompt)
        inj = base_loop.inject(ctx)
        self.assertIsInstance(inj, TurnInjection)
        assert isinstance(inj, TurnInjection)
        self.assertTrue(inj.attach_images)
        self.assertEqual(
            inj.to_payload(),
            {
                "ok": True,
                "records": ctx.perception["records"],
                "perceptionState": {"state": "python/perception.py:Perception.sample", "arguments": {}},
                "eventPool": {"pending": 1},
            },
        )

    def test_turn_context_accepts_camel_and_snake_case_and_deep_copies_injections(self) -> None:
        snake = TurnContext.from_wire(
            {
                "turn": 4,
                "llm_turns": 3,
                "initial_message": None,
                "default_prompt": "keep going",
                "steered": True,
                "perception": {
                    "ok": False,
                    "error": {"code": "NOT_READY", "message": "warming"},
                    "availability": {"persistent": True, "expired": False},
                },
                "perception_state": {"state": "idle"},
                "event_pool": {"count": 2},
                "last_turn": {"action": "wait"},
                "remaining_seconds": 12.0,
                "fault": {"phase": "step", "error": "boom"},
            }
        )
        self.assertEqual(snake.turn, 4)
        self.assertEqual(snake.llm_turns, 3)
        self.assertIsNone(snake.initial_message)
        self.assertEqual(snake.default_prompt, "keep going")
        self.assertTrue(snake.steered)
        self.assertEqual(snake.remaining_seconds, 12.0)

        inj = snake.default_inject()
        inj.extra.append({"hint": "check sensor"})
        inj.attach_images = False
        assert inj.perception_state is not None
        inj.perception_state["state"] = "mutated"
        self.assertEqual(snake.perception_state, {"state": "idle"})
        self.assertEqual(
            inj.to_payload(),
            {
                "ok": False,
                "error": {"code": "NOT_READY", "message": "warming"},
                "availability": {"persistent": True, "expired": False},
                "perceptionState": {"state": "mutated"},
                "eventPool": {"count": 2},
                "loopFault": {"phase": "step", "error": "boom"},
                "extra": [{"hint": "check sensor"}],
            },
        )

    def test_action_validation(self) -> None:
        self.assertEqual(Wait(0).seconds, 0.0)
        self.assertEqual(Wait(1.5, reason="poll").reason, "poll")
        self.assertEqual(Stop().reason, "completed")
        self.assertEqual(Consolidate("compact").prompt, "compact")
        for bad in (-0.01, float("nan"), float("inf"), -float("inf"), True):
            with self.assertRaises((ValueError, TypeError)):
                Wait(bad)  # type: ignore[arg-type]


class LoopWorkerTests(unittest.TestCase):
    def test_absent_loop_py_tracks_sources_and_returns_unimplemented(self) -> None:
        with TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            worker = LoopWorker(root)
            try:
                loaded = worker.request("load", workspace=str(root))
                self.assertEqual(
                    loaded,
                    {
                        "id": loaded["id"],
                        "ok": True,
                        "implemented": False,
                        "generation": None,
                        "codeSHA": None,
                    },
                )
                sources_path = root / ".ludens" / "runtime" / "loop" / "sources.json"
                self.assertTrue(sources_path.is_file())
                self.assertEqual(json.loads(sources_path.read_text(encoding="utf-8")), {"loop.py": None})

                step_reply = worker.request("step", workspace=str(root), context=_sample_wire_context())
                self.assertTrue(step_reply["ok"])
                self.assertFalse(step_reply["implemented"])
                self.assertIsNone(step_reply["generation"])
                self.assertEqual(step_reply["action"]["kind"], "prompt")
                self.assertEqual(step_reply["action"]["injection"]["mode"], "structured")
                self.assertTrue(step_reply["action"]["injection"]["attachImages"])
            finally:
                worker.close()

    def test_turn_injection_mutation_and_custom_inject_modes(self) -> None:
        with TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            worker = LoopWorker(root)
            try:
                # 1. Mutable TurnInjection disabling images and appending extra metadata.
                (root / "loop.py").write_text(
                    """from ludens_tools import Loop

class Loop(Loop):
    def inject(self, ctx):
        print("noisy debug print on stdout")
        inj = ctx.default_inject()
        inj.attach_images = False
        inj.extra.append({"turn": ctx.turn, "note": "lean"})
        return inj
""",
                    encoding="utf-8",
                )
                step1 = worker.request("step", workspace=str(root), context=_sample_wire_context(turn=5))
                self.assertTrue(step1["ok"])
                self.assertTrue(step1["implemented"])
                inj1 = step1["action"]["injection"]
                self.assertEqual(inj1["mode"], "structured")
                self.assertFalse(inj1["attachImages"])
                self.assertEqual(inj1["payload"]["extra"], [{"turn": 5, "note": "lean"}])

                # 2. Standalone class Loop (no base class) returning dict, str, and None.
                (root / "loop.py").write_text(
                    """class Loop:
    def inject(self, ctx):
        if ctx.turn == 1:
            return {"custom": [r["id"] for r in ctx.perception["records"]]}
        if ctx.turn == 2:
            return f"TURN={ctx.turn}"
        return None
""",
                    encoding="utf-8",
                )
                as_dict = worker.request("step", workspace=str(root), context=_sample_wire_context(turn=1))
                self.assertEqual(
                    as_dict["action"]["injection"],
                    {"mode": "custom_json", "payload": {"custom": ["rec-1"]}, "attachImages": True},
                )
                as_text = worker.request("inject", workspace=str(root), context=_sample_wire_context(turn=2))
                self.assertEqual(
                    as_text["injection"],
                    {"mode": "custom_text", "payload": "TURN=2", "attachImages": True},
                )
                as_none = worker.request("step", workspace=str(root), context=_sample_wire_context(turn=3))
                self.assertEqual(
                    as_none["action"]["injection"],
                    {"mode": "none", "payload": None, "attachImages": False},
                )
            finally:
                worker.close()
            self.assertIn("noisy debug print on stdout", (root / "loop-worker.stderr").read_text(encoding="utf-8"))

    def test_step_actions_and_stateful_instance_across_turns(self) -> None:
        with TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            (root / "loop.py").write_text(
                """from ludens_tools import Consolidate, Prompt, Stop, Wait

class Loop:
    def __init__(self):
        self.calls = 0

    def step(self, ctx):
        self.calls += 1
        if self.calls == 1:
            return Wait(0.25, reason="awaiting_frame")
        if self.calls == 2:
            return Consolidate(prompt="summarize observations")
        if self.calls == 3:
            return Prompt(prompt="execute plan", injection={"call": self.calls})
        return Stop(reason="goal_met")
""",
                encoding="utf-8",
            )
            worker = LoopWorker(root)
            try:
                r1 = worker.request("step", workspace=str(root), context=_sample_wire_context())
                self.assertEqual(r1["action"], {"kind": "wait", "seconds": 0.25, "reason": "awaiting_frame"})
                gen = r1["generation"]
                self.assertIsInstance(gen, str)

                # Subsequent load without file edits preserves the stateful Loop instance.
                load_check = worker.request("load", workspace=str(root))
                self.assertEqual(load_check["generation"], gen)

                r2 = worker.request("step", workspace=str(root), context=_sample_wire_context())
                self.assertEqual(r2["generation"], gen)
                self.assertEqual(r2["action"], {"kind": "consolidate", "prompt": "summarize observations"})

                r3 = worker.request("step", workspace=str(root), context=_sample_wire_context())
                self.assertEqual(
                    r3["action"],
                    {
                        "kind": "prompt",
                        "prompt": "execute plan",
                        "injection": {"mode": "custom_json", "payload": {"call": 3}, "attachImages": True},
                    },
                )

                r4 = worker.request("step", workspace=str(root), context=_sample_wire_context())
                self.assertEqual(r4["action"], {"kind": "stop", "reason": "goal_met"})
            finally:
                worker.close()

    def test_hot_reload_on_loop_and_helper_edits_and_fault_recovery(self) -> None:
        with TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            worker = LoopWorker(root)
            pid = worker.process.pid
            try:
                (root / "helper.py").write_text('LABEL = "v1"\n', encoding="utf-8")
                loop_code = """import helper
from ludens_tools import Loop, Prompt

class Loop(Loop):
    def step(self, ctx):
        return Prompt(prompt=helper.LABEL)
"""
                (root / "loop.py").write_text(loop_code, encoding="utf-8")
                expected_sha = hashlib.sha256(loop_code.encode("utf-8")).hexdigest()

                first = worker.request("step", workspace=str(root), context=_sample_wire_context())
                self.assertTrue(first["ok"])
                self.assertEqual(first["codeSHA"], expected_sha)
                self.assertEqual(first["action"]["prompt"], "v1")
                gen1 = first["generation"]

                sources = json.loads((root / ".ludens" / "runtime" / "loop" / "sources.json").read_text(encoding="utf-8"))
                self.assertIn("loop.py", sources)
                self.assertIn("helper.py", sources)

                # Editing imported helper.py without touching loop.py triggers hot-reload!
                (root / "helper.py").write_text('LABEL = "v2"\n', encoding="utf-8")
                second = worker.request("step", workspace=str(root), context=_sample_wire_context())
                self.assertTrue(second["ok"])
                self.assertNotEqual(second["generation"], gen1)
                self.assertEqual(second["action"]["prompt"], "v2")

                # Syntax error in loop.py returns ok=False without killing the worker process.
                broken_syntax = "def broken(:\n"
                (root / "loop.py").write_text(broken_syntax, encoding="utf-8")
                broken_sha = hashlib.sha256(broken_syntax.encode("utf-8")).hexdigest()
                syntax_reply = worker.request("step", workspace=str(root), context=_sample_wire_context())
                self.assertFalse(syntax_reply["ok"])
                self.assertTrue(syntax_reply["implemented"])
                self.assertEqual(syntax_reply["codeSHA"], broken_sha)
                self.assertIn("SyntaxError", syntax_reply["error"])
                self.assertEqual(worker.process.pid, pid)
                self.assertIsNone(worker.process.poll())

                # Runtime exception in step() also returns ok=False and keeps worker alive.
                (root / "loop.py").write_text(
                    """from ludens_tools import Loop

class Loop(Loop):
    def step(self, ctx):
        return 1 / 0
""",
                    encoding="utf-8",
                )
                runtime_reply = worker.request("step", workspace=str(root), context=_sample_wire_context())
                self.assertFalse(runtime_reply["ok"])
                self.assertIn("ZeroDivisionError", runtime_reply["error"])
                self.assertIn("loop.py:5", runtime_reply["error"])
                self.assertIsNone(worker.process.poll())

                # Fixing loop.py recovers automatically on the very next step.
                (root / "loop.py").write_text(loop_code, encoding="utf-8")
                recovered = worker.request("step", workspace=str(root), context=_sample_wire_context())
                self.assertTrue(recovered["ok"])
                self.assertEqual(recovered["action"]["prompt"], "v2")
                self.assertEqual(worker.process.pid, pid)

                # Deleting loop.py returns cleanly to unimplemented state.
                (root / "loop.py").unlink()
                removed = worker.request("load", workspace=str(root))
                self.assertTrue(removed["ok"])
                self.assertFalse(removed["implemented"])
                self.assertIsNone(removed["generation"])
            finally:
                worker.close()

    def test_contract_validation_faults_and_clean_eof_exit(self) -> None:
        with TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            worker = LoopWorker(root)
            try:
                # Missing class Loop
                (root / "loop.py").write_text("X = 1\n", encoding="utf-8")
                r_missing = worker.request("load", workspace=str(root))
                self.assertFalse(r_missing["ok"])
                self.assertTrue(r_missing["implemented"])
                self.assertIn("class Loop", r_missing["error"])

                # Standalone class Loop with neither step nor inject
                (root / "loop.py").write_text("class Loop:\n    pass\n", encoding="utf-8")
                r_empty = worker.request("load", workspace=str(root))
                self.assertFalse(r_empty["ok"])
                self.assertIn("step() or inject()", r_empty["error"])

                # Async def step rejected at load time
                (root / "loop.py").write_text("class Loop:\n    async def step(self, ctx):\n        return None\n", encoding="utf-8")
                r_async = worker.request("load", workspace=str(root))
                self.assertFalse(r_async["ok"])
                self.assertIn("synchronous", r_async["error"])

                # Invalid step return type, invalid inject return type, NaN payload, and explicit Prompt(injection=None)
                (root / "loop.py").write_text(
                    """from ludens_tools import Prompt

class Loop:
    def inject(self, ctx):
        if ctx.turn == 1:
            return 12345
        if ctx.turn == 2:
            return {"bad": float("nan")}
        return {"should_not_run": True}

    def step(self, ctx):
        if ctx.turn == 0:
            return "not-an-action"
        if ctx.turn == 3:
            return Prompt(prompt="skip-context", injection=None)
        return Prompt()
""",
                    encoding="utf-8",
                )
                bad_step = worker.request("step", workspace=str(root), context=_sample_wire_context(turn=0))
                self.assertFalse(bad_step["ok"])
                self.assertIn("Prompt, Consolidate, Wait, or Stop", bad_step["error"])

                bad_inj = worker.request("step", workspace=str(root), context=_sample_wire_context(turn=1))
                self.assertFalse(bad_inj["ok"])
                self.assertIn("TurnInjection, dict, str, or None", bad_inj["error"])

                nan_inj = worker.request("inject", workspace=str(root), context=_sample_wire_context(turn=2))
                self.assertFalse(nan_inj["ok"])
                self.assertIn("finite JSON", nan_inj["error"])

                override_none = worker.request("step", workspace=str(root), context=_sample_wire_context(turn=3))
                self.assertTrue(override_none["ok"])
                self.assertEqual(
                    override_none["action"],
                    {
                        "kind": "prompt",
                        "prompt": "skip-context",
                        "injection": {"mode": "none", "payload": None, "attachImages": False},
                    },
                )

                # Closing stdin directly (PythonWorker.stop() path) exits cleanly with code 0.
                assert worker.process.stdin is not None
                worker.process.stdin.close()
                self.assertEqual(worker.process.wait(timeout=3), 0)
            finally:
                worker.close()

    def test_scope_epoch_and_trace_propagate_to_client_calls_and_capabilities(self) -> None:
        with TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            socket_path = str(root / "host.sock")
            received: list[dict[str, Any]] = []

            class HostHandler(socketserver.StreamRequestHandler):
                def handle(self) -> None:
                    raw = self.rfile.readline()
                    if not raw:
                        return
                    msg = json.loads(raw.decode("utf-8"))
                    received.append(msg)
                    if msg.get("kind") == "perception":
                        value: Any = {"ok": True, "records": [{"id": "obs-9", "sequence": 9}], "hasMore": False}
                    else:
                        value = {"result": {"content": [{"type": "text", "text": "actuated"}]}}
                    self.wfile.write((json.dumps({"ok": True, "value": value}) + "\n").encode("utf-8"))

            server = UnixStreamServer(socket_path, HostHandler)
            serving = threading.Thread(target=server.serve_forever, daemon=True)
            serving.start()
            worker: LoopWorker | None = None
            try:
                (root / "skills.py").write_text(
                    """from ludens_tools import Client, capability

@capability
def actuate(power: int = 1):
    \"\"\"Invoke a controller capability under the active loop epoch.\"\"\"
    Client().call("controller/thruster.fire", {"power": power})
    obs = Client().observe({"after": 8})
    return {"fired": power, "seen": len(obs["records"])}
""",
                    encoding="utf-8",
                )
                (root / "loop.py").write_text(
                    """from ludens_tools import Client, Loop, Stop

class Loop(Loop):
    def step(self, ctx):
        outcome = Client().call("python/skills.py:actuate", {"power": 7})
        return Stop(reason=f"done:{outcome['fired']}:{outcome['seen']}")
""",
                    encoding="utf-8",
                )
                worker = LoopWorker(root)
                reply = worker.request(
                    "step",
                    workspace=str(root),
                    socketPath=socket_path,
                    scope={
                        "epoch": "epoch-loop-77",
                        "trace": {"traceId": "trace-abc", "spanId": "span-root", "recordingId": "run-42"},
                    },
                    context=_sample_wire_context(),
                )
                self.assertTrue(reply["ok"], reply)
                self.assertEqual(reply["action"], {"kind": "stop", "reason": "done:7:1"})

                controller_calls = [m for m in received if m.get("kind") == "controller"]
                self.assertEqual(len(controller_calls), 1)
                self.assertEqual(controller_calls[0]["id"], "controller/thruster.fire")
                self.assertEqual(controller_calls[0]["arguments"], {"power": 7})
                self.assertEqual(controller_calls[0]["epoch"], "epoch-loop-77")
                self.assertEqual(controller_calls[0]["trace"]["traceId"], "trace-abc")
                self.assertEqual(controller_calls[0]["trace"]["parentSpanId"], "span-root")
                self.assertNotIn("modelCallId", controller_calls[0]["trace"])

                observe_calls = [m for m in received if m.get("kind") == "perception"]
                self.assertEqual(len(observe_calls), 1)
                self.assertEqual(observe_calls[0]["epoch"], "epoch-loop-77")
                self.assertEqual(observe_calls[0]["query"], {"after": 8})

                ws_events = [m for m in received if m.get("kind") == "workspace_event"]
                self.assertEqual([m["event"]["type"] for m in ws_events], ["python_call_start", "python_call_end"])
                self.assertEqual(ws_events[0]["epoch"], "epoch-loop-77")
                self.assertEqual(ws_events[0]["runId"], "run-42")

                # Hot-reload also tracks skills.py loaded via Client().call("python/skills.py:actuate")!
                sources = json.loads((root / ".ludens" / "runtime" / "loop" / "sources.json").read_text(encoding="utf-8"))
                self.assertIn("skills.py", sources)
                (root / "skills.py").write_text(
                    """from ludens_tools import capability

@capability
def actuate(power: int = 1):
    \"\"\"Updated local capability.\"\"\"
    return {"fired": power * 10, "seen": 0}
""",
                    encoding="utf-8",
                )
                reloaded = worker.request(
                    "step",
                    workspace=str(root),
                    socketPath=socket_path,
                    scope={"epoch": "epoch-loop-77", "trace": {"traceId": "trace-abc", "recordingId": "run-42"}},
                    context=_sample_wire_context(),
                )
                self.assertTrue(reloaded["ok"], reloaded)
                self.assertNotEqual(reloaded["generation"], reply["generation"])
                self.assertEqual(reloaded["action"], {"kind": "stop", "reason": "done:70:0"})
            finally:
                if worker is not None:
                    worker.close()
                server.shutdown()
                server.server_close()
                serving.join(timeout=1)
                Path(socket_path).unlink(missing_ok=True)


if __name__ == "__main__":
    unittest.main()
