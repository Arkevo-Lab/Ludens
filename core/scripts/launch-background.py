#!/usr/bin/env python3
"""Cross-platform detached background job launcher and lifecycle helper (no auto-restart)."""
import argparse
import ctypes
import hashlib
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import tempfile
import time

PRESERVED_ENV_KEYS = (
    "HOME", "USER", "LOGNAME", "TMPDIR", "TEMP", "TMP", "LANG", "LC_ALL",
    "DISPLAY", "WAYLAND_DISPLAY", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS",
    "SYSTEMROOT", "COMSPEC", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "PATHEXT",
    "XDG_STATE_HOME", "LUDENS_PYTHON", "LUDENS_HOME", "SSH_AUTH_SOCK",
    "LUDENS_PERCEPTION_HOT_SECONDS", "LUDENS_PERCEPTION_PERSIST", "LUDENS_PERCEPTION_SEGMENT_SECONDS",
    "LUDENS_PERCEPTION_HOT_BYTES", "LUDENS_PERCEPTION_SEGMENT_BYTES",
)


def pid_alive(pid: int | None) -> bool:
    if not isinstance(pid, int) or pid <= 0:
        return False
    if os.name == "nt":
        PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
        STILL_ACTIVE = 259
        handle = ctypes.windll.kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
        if not handle:
            return False
        try:
            code = ctypes.c_ulong()
            if not ctypes.windll.kernel32.GetExitCodeProcess(handle, ctypes.byref(code)):
                return False
            return code.value == STILL_ACTIVE
        finally:
            ctypes.windll.kernel32.CloseHandle(handle)
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


def atomic_write_json(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, indent=2)
            handle.write("\n")
        os.replace(tmp_name, path)
    except BaseException:
        try:
            os.unlink(tmp_name)
        except OSError:
            pass
        raise


def read_state(path: Path) -> dict | None:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return None


def status_command(state_file: Path) -> int:
    data = read_state(state_file)
    if data is None:
        print(json.dumps({"registered": False, "pid": None, "state": None, "lastExitCode": None}))
        return 0
    raw_pid = data.get("pid")
    alive = pid_alive(raw_pid)
    if alive:
        print(json.dumps({"registered": True, "pid": raw_pid, "state": "running", "lastExitCode": None}))
        return 0
    exit_code = data.get("lastExitCode")
    if not isinstance(exit_code, int):
        exit_code = -1 if raw_pid else None
    print(json.dumps({"registered": True, "pid": None, "state": "exited", "lastExitCode": exit_code}))
    return 0


def terminate_tree(pid: int) -> None:
    if not pid_alive(pid):
        return
    if os.name == "nt":
        subprocess.run(["taskkill", "/PID", str(pid), "/T", "/F"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        return
    try:
        os.killpg(pid, signal.SIGTERM)
    except (ProcessLookupError, PermissionError, OSError):
        try:
            os.kill(pid, signal.SIGTERM)
        except ProcessLookupError:
            return
    deadline = time.monotonic() + 5.0
    while time.monotonic() < deadline:
        if not pid_alive(pid):
            return
        time.sleep(0.05)
    try:
        os.killpg(pid, signal.SIGKILL)
    except (ProcessLookupError, PermissionError, OSError):
        try:
            os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass


def stop_command(state_file: Path) -> int:
    data = read_state(state_file)
    if data is None:
        return 0
    pid = data.get("pid")
    supervisor_pid = data.get("supervisorPid")
    if isinstance(pid, int) and pid > 0:
        terminate_tree(pid)
        deadline = time.monotonic() + 2.0
        while time.monotonic() < deadline and pid_alive(pid):
            time.sleep(0.05)
    if isinstance(supervisor_pid, int) and supervisor_pid > 0:
        deadline = time.monotonic() + 2.0
        while time.monotonic() < deadline and pid_alive(supervisor_pid):
            time.sleep(0.02)
    try:
        state_file.unlink()
    except FileNotFoundError:
        pass
    return 0


def supervise_command() -> int:
    spec = json.loads(sys.stdin.read())
    state_file = Path(spec["stateFile"])
    log_file = Path(spec["log"])
    log_file.parent.mkdir(parents=True, exist_ok=True)
    spawn_kwargs: dict = {
        "cwd": spec["workspace"],
        "env": spec["env"],
        "stdin": subprocess.DEVNULL,
    }
    if os.name == "nt":
        spawn_kwargs["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP
    else:
        spawn_kwargs["start_new_session"] = True
    try:
        with log_file.open("ab") as out:
            spawn_kwargs["stdout"] = out
            spawn_kwargs["stderr"] = out
            child = subprocess.Popen(spec["command"], **spawn_kwargs)
    except BaseException as error:
        sys.stdout.write(json.dumps({"ok": False, "error": str(error)}) + "\n")
        sys.stdout.flush()
        return 1

    record = {
        "version": 1,
        "label": spec["label"],
        "name": spec["name"],
        "workspace": spec["workspace"],
        "command": spec["command"],
        "env": spec["env"],
        "log": spec["log"],
        "pid": child.pid,
        "supervisorPid": os.getpid(),
        "state": "running",
        "lastExitCode": None,
        "startedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    atomic_write_json(state_file, record)
    sys.stdout.write(json.dumps({"ok": True, "pid": child.pid}) + "\n")
    sys.stdout.flush()

    devnull = os.open(os.devnull, os.O_RDWR)
    for stream_fd in (0, 1, 2):
        try:
            os.dup2(devnull, stream_fd)
        except OSError:
            pass
    os.close(devnull)

    exit_code = child.wait()
    current = read_state(state_file)
    if current is not None and current.get("pid") == child.pid and state_file.exists():
        current["pid"] = None
        current["state"] = "exited"
        current["lastExitCode"] = int(exit_code)
        current["exitedAt"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        if state_file.exists():
            try:
                atomic_write_json(state_file, current)
            except OSError:
                pass
    return 0


def resolve_command_and_env(raw_command: list[str]) -> tuple[list[str], dict[str, str]]:
    extra_env: dict[str, str] = {}
    command = list(raw_command)
    if command and command[0] == "env":
        idx = 1
        while idx < len(command) and "=" in command[idx] and not command[idx].startswith("="):
            key, value = command[idx].split("=", 1)
            extra_env[key] = value
            idx += 1
        command = command[idx:]
    return command, extra_env


def main() -> int:
    if len(sys.argv) == 2 and sys.argv[1] == "--supervise":
        return supervise_command()
    if len(sys.argv) == 3 and sys.argv[1] == "--status":
        return status_command(Path(sys.argv[2]).resolve())
    if len(sys.argv) == 3 and sys.argv[1] == "--stop":
        return stop_command(Path(sys.argv[2]).resolve())

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--label", help="Explicit job label for a shared application")
    parser.add_argument("--log-dir", type=Path, help="Explicit log and state directory for a shared application")
    parser.add_argument("name", help="Job name, e.g. host or emulator")
    parser.add_argument("command", nargs=argparse.REMAINDER, help="Command and arguments to run in the current workspace")
    args = parser.parse_args()
    if not args.command:
        parser.error("a command is required")

    command, extra_env = resolve_command_and_env(args.command)
    if not command:
        parser.error("a command is required")

    workspace = Path.cwd().resolve()
    identity = hashlib.sha256(str(workspace).encode()).hexdigest()[:16]
    label = args.label or f"dev.ludens.core.{identity}.{args.name}"
    logs = args.log_dir.resolve() if args.log_dir else workspace / "logs" / "background"
    state_file = logs / f"{args.name}.job.json"
    output = logs / f"{args.name}.log"

    if state_file.exists():
        parser.error(f"job already registered: {label}; stop it before replacing it")

    search_path = extra_env.get("PATH") or os.environ.get("PATH", os.defpath)
    executable = shutil.which(command[0], path=search_path)
    if not executable:
        parser.error(f"command not found: {command[0]}")

    logs.mkdir(parents=True, exist_ok=True)
    job_env = {
        "PATH": search_path,
        **{key: os.environ[key] for key in PRESERVED_ENV_KEYS if key in os.environ},
        **extra_env,
    }
    for forbidden in list(job_env):
        if forbidden.startswith("BASEWARE_") or forbidden in ("LUDENS_WORKSPACE", "LUDENS_SOCKET"):
            del job_env[forbidden]

    spec = {
        "label": label,
        "name": args.name,
        "workspace": str(workspace),
        "command": [str(Path(executable).resolve()), *command[1:]],
        "env": job_env,
        "log": str(output),
        "stateFile": str(state_file),
    }

    detach_kwargs: dict = {
        "stdin": subprocess.PIPE,
        "stdout": subprocess.PIPE,
        "stderr": subprocess.PIPE,
        "text": True,
    }
    if os.name == "nt":
        detach_kwargs["creationflags"] = subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP
    else:
        detach_kwargs["start_new_session"] = True

    supervisor = subprocess.Popen([sys.executable, str(Path(__file__).resolve()), "--supervise"], **detach_kwargs)
    assert supervisor.stdin is not None and supervisor.stdout is not None and supervisor.stderr is not None
    supervisor.stdin.write(json.dumps(spec))
    supervisor.stdin.close()
    line = supervisor.stdout.readline().strip()
    supervisor.stdout.close()
    if not line:
        err = supervisor.stderr.read().strip()
        supervisor.stderr.close()
        raise RuntimeError(err or "background supervisor failed to initialize")
    supervisor.stderr.close()
    handshake = json.loads(line)
    if not handshake.get("ok"):
        raise RuntimeError(handshake.get("error") or "background job failed to start")

    print(json.dumps({
        "target": label,
        "pid": handshake["pid"],
        "workspace": str(workspace),
        "log": str(output),
        "stateFile": str(state_file),
    }))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
