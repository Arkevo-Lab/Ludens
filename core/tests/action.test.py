"""Resident action uses ordinary capabilities and the existing timeline writer."""

import hashlib
import json
import os
from pathlib import Path
import queue
import socketserver
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

from ludens_tools import Client, capability
from ludens_tools._capabilities import discover
from ludens_tools._context import current, scope
from ludens_tools._recording import RecordingWindow


class Worker:
    def __init__(self, root, role, source, *, generation="generation-one", socket_path=None, extra_env=None):
        self.root, self.role = root, role
        self.messages, self.pending, self.lock = [], {}, threading.Lock()
        self.stderr = (root / f"{role}-{generation}.stderr").open("w")
        env = {**os.environ, "LUDENS_WORKSPACE": str(root), "BASEWARE_TRACE": "{}"}
        if socket_path:
            env["LUDENS_SOCKET"] = socket_path
        if extra_env:
            env.update(extra_env)
        self.process = subprocess.Popen([sys.executable, "-u", "-m", f"ludens_tools._{role}"],
            cwd=root, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=self.stderr, text=True)

        def read():
            for line in self.process.stdout:
                message = json.loads(line)
                self.messages.append(message)
                if message.get("id") in self.pending:
                    self.pending[message["id"]].put(message)

        self.reader = threading.Thread(target=read, daemon=True)
        self.reader.start()
        self.started = self.request(action="start", workspace=str(root), runDir=str(root / "logs" / "run"),
            generation=generation, source=source, diagnostics="normal", epoch="fixed-epoch",
            trace={"recordingId": "run", "inputGeneration": generation})

    def request(self, **fields):
        identity = str(time.monotonic_ns())
        response = queue.Queue()
        self.pending[identity] = response
        with self.lock:
            self.process.stdin.write(json.dumps({"id": identity, **fields}) + "\n")
            self.process.stdin.flush()
        reply = response.get(timeout=5)
        del self.pending[identity]
        return reply

    def wait(self, predicate, timeout=3):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if predicate():
                return
            time.sleep(.01)
        raise AssertionError("Worker did not reach the expected state")

    def close(self):
        self.process.terminate()
        try:
            self.process.wait(timeout=4)
        finally:
            if self.process.poll() is None:
                self.process.kill()
                self.process.wait()
            self.process.stdin.close()
            self.reader.join(timeout=1)
            self.process.stdout.close()
            self.stderr.close()


PERCEPTION = '''from ludens_tools import capability, record
class Perception:
    def start(self, context): self.count = 0
    @record
    @capability
    def sample(self):
        self.count += 1
        return {"data": {"frame": self.count}}
    def close(self): pass
'''

ACTION = '''from pathlib import Path
import json
from ludens_tools import Client, capability, record
from ludens_tools._context import current
from helper import identify
@record
@capability
def decision(count: int, source: dict) -> dict:
    """Record the decision and the perception it used."""
    return {"data": {"count": count, "version": identify()}, "sources": [source]}
class Action:
    step_hz = 2.0
    def start(self, context):
        self.count = 0
        self.model = object()
        self.client = Client(trace={"traceId": "custom"})
    @capability
    def step(self):
        self.count += 1
        view = self.client.observe()
        decision(self.count, view["records"][0]["timeline"])
        Path("steps").write_text(str(self.count))
        if self.count == 3:
            raise RuntimeError("failed after a recorded decision")
        return self.model
    def close(self):
        Path("closed").write_text(json.dumps({"count": self.count, "trace": current()["trace"]}))
'''


STATE_MACHINE = '''from ludens_tools import capability, record, observe
class Perception:
    def start(self, context):
        self.ticks = 0
        self.aims = []
    @observe
    @record
    @capability
    def sample(self):
        self.ticks += 1
        return {"data": {"state": "sample", "ticks": self.ticks},
                "transition": {"to": "aim", "arguments": {"offset": 2}}}
    @record
    @capability
    def aim(self, offset: int = 0):
        self.aims.append(offset)
        return {"data": {"state": "aim", "offset": offset, "ticks": self.ticks},
                "effect": {"id": "controller/reel.spin", "arguments": {"speed": offset + 1}},
                "transition": "reel"}
    @record
    @capability
    def reel(self):
        return {"data": {"state": "reel"}}
    def close(self): pass
'''


TOP_LEVEL_ENTRY = '''from ludens_tools import capability, record, observe
@observe
@record
@capability
def inspect():
    """Sense without a resident class."""
    return {"data": {"entry": "function"}, "transition": "python/helper.py:assist"}
'''

class ActionTests(unittest.TestCase):
    def test_manual_history_query_omits_absent_epoch(self):
        # A socket path keeps observe on the live request path; without one it
        # reads the committed timeline offline instead of building a message.
        with scope({**current(), "epoch": None}), patch("ludens_tools.client.request", return_value={"records": []}) as rpc:
            self.assertEqual(Client("/tmp/ludens-manual.sock").observe({"after": 1}), {"records": []})
        self.assertNotIn("epoch", rpc.call_args.args[1])
        self.assertEqual(rpc.call_args.args[1]["query"], {"after": 1})

    def test_step_hz_attribute_is_ignored_and_env_configures_the_rate(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            action = None
            try:
                action = Worker(root, "action", "from ludens_tools import capability\nclass Action:\n"
                                                 "    step_hz = 2.0\n"
                                                 "    def start(self, context): pass\n"
                                                 "    @capability\n    def step(self): return None\n"
                                                 "    def close(self): pass\n",
                                extra_env={"LUDENS_ACTION_STEP_HZ": "5"})
                self.assertTrue(action.started["ok"])
                self.assertEqual(action.started["result"]["stepHz"], 5)
            finally:
                if action:
                    action.close()

    def test_two_residents_share_history_and_action_failure_never_retries(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            helper = 'from ludens_tools import capability\n@capability\ndef identify(): return "loaded-v1"\n'
            (root / "helper.py").write_text(helper)
            perception = Worker(root, "perception", PERCEPTION)
            perception.wait(lambda: any(x.get("event") == "sample" for x in perception.messages))
            socket_path = str(root / "host.sock")
            received = []

            class Handler(socketserver.StreamRequestHandler):
                def handle(self):
                    message = json.loads(self.rfile.readline())
                    received.append(message)
                    if message["kind"] == "perception":
                        response = perception.request(action="observe", query=message["query"])
                    elif message["kind"] == "timeline":
                        response = perception.request(**{k: v for k, v in message.items() if k not in ("kind", "argv")})
                    else:
                        raise AssertionError("Unexpected per-call logging RPC")
                    self.wfile.write((json.dumps({"ok": response["ok"], "value": response.get("result"),
                        "error": response.get("error")}) + "\n").encode())

            server = socketserver.ThreadingUnixStreamServer(socket_path, Handler)
            serving = threading.Thread(target=server.serve_forever, daemon=True)
            serving.start()
            action = None
            try:
                action = Worker(root, "action", ACTION, socket_path=socket_path)
                self.assertTrue(action.started["ok"])
                self.assertEqual(action.started["result"]["stepHz"], 30)
                action.wait(lambda: any(x.get("state") == "error" for x in action.messages))
                time.sleep(.1)
                self.assertEqual((root / "steps").read_text(), "3")
                rows = perception.request(action="observe", query={"capability": "python/action.py:decision", "after": 0})["result"]["records"]
                self.assertEqual([x["data"]["count"] for x in rows], [1, 2, 3])
                self.assertTrue(all(x["data"]["version"] == "loaded-v1" for x in rows))
                self.assertTrue(all(x["trace"]["epoch"] == "fixed-epoch" for x in rows))
                self.assertTrue(all(x["trace"]["inputGeneration"] == "generation-one" for x in rows))
                for message in received:
                    self.assertEqual(message["trace"]["recordingPurpose"], "continuous-action")
                    self.assertEqual(message["trace"]["inputGeneration"], "generation-one")
                self.assertEqual(len(received), 6)
                self.assertEqual(perception.request(action="observe")["result"]["records"][0]["capability"], "python/perception.py:Perception.sample")
                stats = [x for x in action.messages if x.get("type") == "action_stats"]
                self.assertEqual(len(stats), 1)
                self.assertEqual(stats[0]["data"]["step"]["recorded"], 3)
                self.assertEqual(stats[0]["data"]["step"]["failed"], 1)
                self.assertFalse(any(x.get("type", "").startswith("python_call") for x in action.messages))
                manifest = json.loads((root / "logs/run/action/generation-one/sources.json").read_text())
                self.assertEqual(manifest["helper.py"], hashlib.sha256(helper.encode()).hexdigest())
                self.assertEqual(manifest["action.py"], hashlib.sha256(ACTION.encode()).hexdigest())
                before = len(perception.messages)
                action.close()
                self.assertEqual(json.loads((root / "closed").read_text())["count"], 3)
                self.assertIsNone(perception.process.poll())
                perception.wait(lambda: len(perception.messages) > before)
            finally:
                if action and action.process.poll() is None:
                    action.close()
                server.shutdown()
                server.server_close()
                serving.join(timeout=1)
                perception.close()

    def test_capability_methods_preserve_objects_without_becoming_cli_entries(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            source = '''from ludens_tools import capability, record
MODEL = object()
@capability
def model():
    """Reuse an in-memory object."""
    return MODEL
class Action:
    @capability
    def step(self): return MODEL
    @record
    @capability
    def saved(self): return {"data": True}
def quality():
    """Measure the actual local action capability."""
    value = Action().step()
    return {"metrics": {"same_model": {"value": int(value is MODEL), "unit": "flag"}}}
'''
            (root / "program.py").write_text(source)
            catalog = discover(root)
            self.assertEqual(catalog["diagnostics"], [])
            self.assertEqual([x["origin"]["function"] for x in catalog["capabilities"]], ["model"])
            namespace = {"__name__": "program", "__file__": str(root / "program.py")}
            exec(compile(source, str(root / "program.py"), "exec"), namespace)
            self.assertIs(namespace["model"](), namespace["MODEL"])
            self.assertIs(namespace["Action"]().step(), namespace["MODEL"])

    def test_action_tick_statistics_do_not_scale_with_frequency(self):
        for hz in (1, 10, 30):
            with self.subTest(hz=hz):
                clock, events = [0.0], []
                parent = {**current(), "workspace": str(Path.cwd()), "socket_path": "not-used.sock", "run_id": "run",
                    "epoch": "one", "trace": {"recordingPurpose": "continuous-action", "inputGeneration": "old"},
                    "recording_purpose": "continuous-action", "diagnostics": "normal"}
                window = RecordingWindow(events.append, parent["trace"], "old", hz,
                    clock=lambda: clock[0], role="action")
                parent.update(recording_observer=window.observe)
                @capability
                def step(): return object()
                with scope(parent), patch("ludens_tools._context.request") as rpc:
                    for index in range(hz * 10):
                        step()
                        window.sampled(1, True)
                        clock[0] = (index + 1) / hz
                        window.flush()
                    window.flush(reason="stopped")
                rpc.assert_not_called()
                self.assertEqual([x["type"] for x in events], ["action_stats"] * 2)
                self.assertEqual(sum(x["data"]["step"]["completed"] for x in events), hz * 10)

    def test_state_machine_shares_context_executes_effects_and_answers_rpc(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            socket_path = str(root / "controller.sock")
            controller = []

            class Handler(socketserver.StreamRequestHandler):
                def handle(self):
                    message = json.loads(self.rfile.readline())
                    controller.append(message)
                    self.wfile.write((json.dumps({"ok": True, "value": {"result": {"content": []}}}) + "\n").encode())

            server = socketserver.ThreadingUnixStreamServer(socket_path, Handler)
            serving = threading.Thread(target=server.serve_forever, daemon=True)
            serving.start()
            worker = None
            try:
                worker = Worker(root, "perception", STATE_MACHINE, socket_path=socket_path)
                self.assertTrue(worker.started["ok"])

                def records():
                    return worker.request(action="observe", query={"capability": "*", "after": 0})["result"]["records"]

                def until(predicate, timeout=5):
                    deadline = time.monotonic() + timeout
                    while time.monotonic() < deadline:
                        if predicate():
                            return True
                        time.sleep(.02)
                    return False

                self.assertTrue(until(lambda: any(x["capability"] == "python/perception.py:Perception.reel" for x in records())))
                rows = records()
                # sample -> aim shares the instance's in-memory context.
                self.assertEqual(rows[0]["capability"], "python/perception.py:Perception.sample")
                self.assertEqual(rows[0]["data"], {"state": "sample", "ticks": 1})
                self.assertEqual(rows[0]["transition"], {"to": "aim", "arguments": {"offset": 2}})
                self.assertEqual(rows[1]["capability"], "python/perception.py:Perception.aim")
                self.assertEqual(rows[1]["data"], {"state": "aim", "offset": 2, "ticks": 1})
                self.assertEqual(rows[1]["effect"], {"id": "controller/reel.spin", "arguments": {"speed": 3}})
                self.assertEqual(rows[1]["transition"], "reel")
                self.assertEqual(rows[2]["capability"], "python/perception.py:Perception.reel")
                # The controller socket received the effect call from the very same tick.
                spins = [x for x in controller if x.get("id") == "controller/reel.spin"]
                self.assertEqual(len(spins), 1, controller)
                self.assertEqual(spins[0]["kind"], "controller")
                self.assertEqual(spins[0]["arguments"], {"speed": 3})
                self.assertEqual(spins[0]["epoch"], "fixed-epoch")
                # RPC: inspect, re-lease, and externally transition the machine.
                state = worker.request(action="state")["result"]
                self.assertEqual(state, {"state": "python/perception.py:Perception.reel", "arguments": {}, "epoch": "fixed-epoch"})
                lease = worker.request(action="lease", epoch="lease-epoch", inputGeneration="lease-gen")["result"]
                self.assertEqual(lease, {"epoch": "lease-epoch", "inputGeneration": "lease-gen"})
                moved = worker.request(action="transition", to="aim", arguments={"offset": 9})["result"]
                self.assertEqual(moved["state"], "python/perception.py:Perception.aim")
                self.assertEqual(moved["arguments"], {"offset": 9})
                self.assertEqual(moved["epoch"], "lease-epoch")
                self.assertTrue(until(lambda: any(x.get("epoch") == "lease-epoch" for x in controller)))
                respun = [x for x in controller if x.get("epoch") == "lease-epoch"]
                self.assertEqual([x["arguments"] for x in respun], [{"speed": 10}])
                self.assertEqual(respun[0]["trace"]["inputGeneration"], "lease-gen")
                self.assertEqual([x["data"]["offset"] for x in records()
                                  if x["capability"] == "python/perception.py:Perception.aim"], [2, 9])
                failed = worker.request(action="transition", to="nosuch")
                self.assertFalse(failed["ok"])
                self.assertIn("Unknown transition target capability: nosuch", failed["error"]["message"])
            finally:
                if worker and worker.process.poll() is None:
                    worker.close()
                server.shutdown()
                server.server_close()
                serving.join(timeout=1)
                Path(socket_path).unlink(missing_ok=True)

    def test_top_level_observe_function_entry_transitions_across_modules(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            (root / "helper.py").write_text('''from ludens_tools import capability, record
shared = []
@record
@capability
def assist():
    """Assist from a helper module."""
    shared.append("assisted")
    return {"data": {"helped": True}, "transition": "finish"}
@record
@capability
def finish():
    """Read the same module's in-memory context."""
    return {"data": {"shared": shared}}
''')
            worker = Worker(root, "perception", TOP_LEVEL_ENTRY)
            try:
                self.assertTrue(worker.started["ok"])
                deadline = time.monotonic() + 5
                rows = []
                while time.monotonic() < deadline:
                    rows = worker.request(action="observe", query={"capability": "*", "after": 0})["result"]["records"]
                    if any(x["capability"] == "python/helper.py:finish" for x in rows):
                        break
                    time.sleep(.02)
                self.assertEqual(rows[0]["capability"], "python/perception.py:inspect")
                self.assertEqual(rows[0]["data"], {"entry": "function"})
                self.assertEqual(rows[0]["transition"], "python/helper.py:assist")
                self.assertEqual(next(x["data"] for x in rows if x["capability"] == "python/helper.py:finish"),
                                 {"shared": ["assisted"]})
                self.assertEqual(worker.request(action="observe")["result"]["records"][0]["data"],
                                 {"entry": "function"})
            finally:
                worker.close()


if __name__ == "__main__":
    unittest.main()
