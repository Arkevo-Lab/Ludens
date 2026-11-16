"""Injected call context and metadata-only logging for workspace Python."""

from contextlib import contextmanager
from contextvars import ContextVar
from datetime import datetime, timezone
import json
import os
import socket
import sys
import time
import traceback
import uuid


class LudensError(RuntimeError):
    """The Ludens host rejected a request."""


def _connect_named_pipe(pipe_path, timeout):
    import ctypes

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    INVALID_HANDLE_VALUE = ctypes.c_void_p(-1).value
    GENERIC_READ = 0x80000000
    GENERIC_WRITE = 0x40000000
    OPEN_EXISTING = 3
    FILE_FLAG_OVERLAPPED = 0x40000000
    INFINITE = 0xFFFFFFFF
    ERROR_FILE_NOT_FOUND = 2
    ERROR_BROKEN_PIPE = 109
    ERROR_PIPE_BUSY = 231
    ERROR_NO_DATA = 232
    ERROR_PIPE_NOT_CONNECTED = 233
    WAIT_TIMEOUT = 258
    ERROR_IO_PENDING = 997

    class _Overlapped(ctypes.Structure):
        _fields_ = [
            ("Internal", ctypes.c_size_t),
            ("InternalHigh", ctypes.c_size_t),
            ("Offset", ctypes.c_uint32),
            ("OffsetHigh", ctypes.c_uint32),
            ("hEvent", ctypes.c_void_p),
        ]

    kernel32.CreateFileW.argtypes = [
        ctypes.c_wchar_p, ctypes.c_uint32, ctypes.c_uint32, ctypes.c_void_p,
        ctypes.c_uint32, ctypes.c_uint32, ctypes.c_void_p,
    ]
    kernel32.CreateFileW.restype = ctypes.c_void_p
    kernel32.WaitNamedPipeW.argtypes = [ctypes.c_wchar_p, ctypes.c_uint32]
    kernel32.WaitNamedPipeW.restype = ctypes.c_int
    kernel32.CreateEventW.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_int, ctypes.c_wchar_p]
    kernel32.CreateEventW.restype = ctypes.c_void_p
    kernel32.CloseHandle.argtypes = [ctypes.c_void_p]
    kernel32.CloseHandle.restype = ctypes.c_int
    kernel32.WriteFile.argtypes = [
        ctypes.c_void_p, ctypes.c_void_p, ctypes.c_uint32,
        ctypes.POINTER(ctypes.c_uint32), ctypes.POINTER(_Overlapped),
    ]
    kernel32.WriteFile.restype = ctypes.c_int
    kernel32.ReadFile.argtypes = [
        ctypes.c_void_p, ctypes.c_void_p, ctypes.c_uint32,
        ctypes.POINTER(ctypes.c_uint32), ctypes.POINTER(_Overlapped),
    ]
    kernel32.ReadFile.restype = ctypes.c_int
    kernel32.GetOverlappedResultEx.argtypes = [
        ctypes.c_void_p, ctypes.POINTER(_Overlapped), ctypes.POINTER(ctypes.c_uint32),
        ctypes.c_uint32, ctypes.c_int,
    ]
    kernel32.GetOverlappedResultEx.restype = ctypes.c_int
    kernel32.CancelIoEx.argtypes = [ctypes.c_void_p, ctypes.POINTER(_Overlapped)]
    kernel32.CancelIoEx.restype = ctypes.c_int

    deadline = None if timeout is None else time.monotonic() + float(timeout)

    def _remaining_ms():
        if deadline is None:
            return INFINITE
        return max(0, int((deadline - time.monotonic()) * 1000))

    while True:
        handle = kernel32.CreateFileW(
            pipe_path, GENERIC_READ | GENERIC_WRITE, 0, None, OPEN_EXISTING, FILE_FLAG_OVERLAPPED, None,
        )
        if handle is not None and handle != INVALID_HANDLE_VALUE:
            break
        err = ctypes.get_last_error()
        if err == ERROR_FILE_NOT_FOUND:
            raise FileNotFoundError(pipe_path)
        if err == ERROR_PIPE_BUSY:
            wait_ms = 5000 if deadline is None else _remaining_ms()
            if deadline is not None and wait_ms <= 0:
                raise TimeoutError("Ludens pipe connection timed out")
            if kernel32.WaitNamedPipeW(pipe_path, min(wait_ms, 5000)):
                continue
            wait_err = ctypes.get_last_error()
            if wait_err == ERROR_FILE_NOT_FOUND:
                raise FileNotFoundError(pipe_path)
            if wait_err == 121:  # ERROR_SEM_TIMEOUT
                if deadline is not None and _remaining_ms() <= 0:
                    raise TimeoutError("Ludens pipe connection timed out")
                continue
            raise ctypes.WinError(wait_err)
        raise ctypes.WinError(err)

    class _NamedPipeReader:
        def __init__(self, conn):
            self._conn = conn
            self._buffer = bytearray()

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def readline(self):
            while True:
                idx = self._buffer.find(b"\n")
                if idx >= 0:
                    end = idx + 1
                    line = bytes(self._buffer[:end])
                    del self._buffer[:end]
                    return line
                chunk = self._conn._read_chunk(65536)
                if not chunk:
                    line = bytes(self._buffer)
                    self._buffer.clear()
                    return line
                self._buffer.extend(chunk)

        def __iter__(self):
            return self

        def __next__(self):
            line = self.readline()
            if not line:
                raise StopIteration
            return line

    class _NamedPipeConnection:
        def __init__(self, pipe_handle):
            self._handle = pipe_handle
            self._io_deadline = None

        def __enter__(self):
            return self

        def __exit__(self, *args):
            self.close()

        def close(self):
            if self._handle is not None:
                kernel32.CloseHandle(self._handle)
                self._handle = None

        def _timeout_ms(self):
            if self._io_deadline is None:
                return INFINITE
            return max(0, int((self._io_deadline - time.monotonic()) * 1000))

        def _await_overlapped(self, op_ok, ov, transferred, *, is_read):
            if op_ok:
                return transferred.value
            err = ctypes.get_last_error()
            if is_read and err in (ERROR_BROKEN_PIPE, ERROR_NO_DATA, ERROR_PIPE_NOT_CONNECTED):
                return 0
            if not is_read and err in (ERROR_BROKEN_PIPE, ERROR_NO_DATA, ERROR_PIPE_NOT_CONNECTED):
                raise BrokenPipeError(str(ctypes.WinError(err)))
            if err != ERROR_IO_PENDING:
                raise ctypes.WinError(err)
            done = kernel32.GetOverlappedResultEx(
                self._handle, ctypes.byref(ov), ctypes.byref(transferred), self._timeout_ms(), False,
            )
            if done:
                return transferred.value
            err2 = ctypes.get_last_error()
            if err2 == WAIT_TIMEOUT:
                kernel32.CancelIoEx(self._handle, ctypes.byref(ov))
                kernel32.GetOverlappedResultEx(
                    self._handle, ctypes.byref(ov), ctypes.byref(transferred), INFINITE, False,
                )
                raise TimeoutError("Ludens timed out waiting for named pipe")
            if is_read and err2 in (ERROR_BROKEN_PIPE, ERROR_NO_DATA, ERROR_PIPE_NOT_CONNECTED):
                return 0
            if not is_read and err2 in (ERROR_BROKEN_PIPE, ERROR_NO_DATA, ERROR_PIPE_NOT_CONNECTED):
                raise BrokenPipeError(str(ctypes.WinError(err2)))
            raise ctypes.WinError(err2)

        def sendall(self, data):
            self._io_deadline = None if timeout is None else time.monotonic() + float(timeout)
            view = memoryview(data)
            offset = 0
            while offset < len(view):
                chunk = bytes(view[offset:offset + 65536])
                buf = ctypes.create_string_buffer(chunk, len(chunk))
                event = kernel32.CreateEventW(None, 1, 0, None)
                if not event:
                    raise ctypes.WinError(ctypes.get_last_error())
                try:
                    ov = _Overlapped(hEvent=event)
                    written = ctypes.c_uint32(0)
                    ok = kernel32.WriteFile(
                        self._handle, buf, len(chunk), ctypes.byref(written), ctypes.byref(ov),
                    )
                    offset += self._await_overlapped(ok, ov, written, is_read=False)
                finally:
                    kernel32.CloseHandle(event)

        def _read_chunk(self, size):
            self._io_deadline = None if timeout is None else time.monotonic() + float(timeout)
            buf = ctypes.create_string_buffer(size)
            event = kernel32.CreateEventW(None, 1, 0, None)
            if not event:
                raise ctypes.WinError(ctypes.get_last_error())
            try:
                ov = _Overlapped(hEvent=event)
                read_bytes = ctypes.c_uint32(0)
                ok = kernel32.ReadFile(
                    self._handle, buf, size, ctypes.byref(read_bytes), ctypes.byref(ov),
                )
                count = self._await_overlapped(ok, ov, read_bytes, is_read=True)
                return buf.raw[:count]
            finally:
                kernel32.CloseHandle(event)

        def makefile(self, mode="rb"):
            if mode != "rb":
                raise ValueError("Unsupported pipe mode")
            return _NamedPipeReader(self)

    return _NamedPipeConnection(handle)


def _connect_local(socket_path, timeout):
    if sys.platform != "win32":
        connection = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            connection.settimeout(timeout)
            connection.connect(socket_path)
            return connection
        except BaseException:
            connection.close()
            raise

    if isinstance(socket_path, str) and socket_path.startswith("\\\\.\\pipe\\"):
        return _connect_named_pipe(socket_path, timeout)

    # Winsock supports AF_UNIX, but Windows CPython does not marshal sockaddr_un.
    import ctypes
    import select

    class UnixAddress(ctypes.Structure):
        _fields_ = [("family", ctypes.c_ushort), ("path", ctypes.c_char * 108)]

    path = os.fsencode(socket_path)
    if len(path) >= 108:
        raise ValueError("Ludens socket path is too long for Winsock")
    family = 1  # AF_UNIX in Winsock
    address = UnixAddress(family, path)
    winsock = ctypes.WinDLL("Ws2_32.dll")
    winsock.connect.argtypes = [ctypes.c_size_t, ctypes.POINTER(UnixAddress), ctypes.c_int]
    connection = socket.socket(family, socket.SOCK_STREAM)
    try:
        connection.settimeout(timeout)
        if winsock.connect(connection.fileno(), ctypes.byref(address), ctypes.sizeof(address)) != 0:
            error = winsock.WSAGetLastError()
            if not timeout or error != 10035:  # WSAEWOULDBLOCK
                raise ctypes.WinError(error)
            _, writable, exceptional = select.select([], [connection], [connection], timeout)
            if not writable and not exceptional:
                raise TimeoutError("Ludens connection timed out")
            error = connection.getsockopt(socket.SOL_SOCKET, socket.SO_ERROR)
            if error:
                raise ctypes.WinError(error)
        return connection
    except BaseException:
        connection.close()
        raise


def request(socket_path, message, timeout=None):
    if not socket_path:
        raise ValueError("LUDENS_SOCKET or socket_path is required")
    wire = json.dumps(message, allow_nan=False).encode("utf-8") + b"\n"
    with _connect_local(socket_path, timeout) as connection:
        connection.sendall(wire)
        with connection.makefile("rb") as incoming:
            line = incoming.readline()
            if not line:
                raise ConnectionError("Ludens disconnected before replying; the request was not retried")
            reply = json.loads(line)
            if reply["ok"]:
                return reply.get("value")
            raise LudensError(reply["error"])


_active = ContextVar("ludens_call_context", default=None)
_CURRENT_RPC_STATS = ContextVar("ludens_current_rpc_stats", default=None)


def record_client_rpc(method, duration_ms, ok):
    """Accumulate client RPC evidence inside the active invocation scope."""
    stats = _CURRENT_RPC_STATS.get()
    if not isinstance(stats, dict):
        return
    stats["calls"] += 1
    stats["durationMs"] += max(0, int(duration_ms))
    if not ok:
        stats["errors"] += 1
    if method == "controller.call":
        stats["controllerCalls"] += 1
    if method.startswith("perception.") or method in ("devices.observations",):
        stats["observeCalls"] += 1

_clock_id = "python-" + uuid.uuid4().hex
_sequence = 0
_warned = False


def current():
    active = _active.get()
    if active is not None:
        return active
    return {
        "socket_path": os.environ.get("LUDENS_SOCKET"),
        "epoch": os.environ.get("BASEWARE_EPOCH"),
        "trace": json.loads(os.environ.get("BASEWARE_TRACE", "{}")),
        "workspace": os.environ.get("LUDENS_WORKSPACE", os.getcwd()),
        "run_id": os.environ.get("LUDENS_RUN_ID"),
        "diagnostics": os.environ.get("LUDENS_LOG_DIAGNOSTICS", "normal"),
        "timeout": None,
    }


@contextmanager
def scope(context):
    token = _active.set(context)
    try:
        yield
    finally:
        _active.reset(token)


def continuous(context):
    return (context.get("recording_purpose") == "continuous-perception"
            or context.get("trace", {}).get("recordingPurpose") == "continuous-perception")

def offline_timeline_append(records_sink=None):
    """Build a timeline_append for offline/simulated runs; no host socket needed."""
    sequence = 0

    def timeline_append(**message):
        nonlocal sequence
        sequence += 1
        record_id = "eval-record-" + uuid.uuid4().hex[:8]
        envelope = {**message["sample"], "timeline": {"recordId": record_id, "sequence": sequence}}
        if isinstance(records_sink, list):
            records_sink.append(envelope)
        return envelope

    return timeline_append


def eval_env(target=None):
    """Declare a reusable eval environment, or mount one at runtime, offline."""
    import inspect
    if target is None:
        from ._decorators import _declare_eval_env
        return _declare_eval_env
    if isinstance(target, type) or inspect.isfunction(target):
        # Decorator form: stamp a top-level class or function as a first-class env.
        from ._decorators import _declare_eval_env
        return _declare_eval_env(target)
    return _runtime_eval_env(target)


@contextmanager
def _runtime_eval_env(env):
    """Run closed-loop capabilities against a surrogate environment, offline."""
    base = current()
    recorded = getattr(env, "recorded", None)
    if not isinstance(recorded, list):
        recorded = []
        try:
            setattr(env, "recorded", recorded)
        except (AttributeError, TypeError):
            pass
    with scope({**base, "eval_env": env, "timeline_append": offline_timeline_append(recorded)}):
        yield env


def diagnostic_channel(context):
    """Local observers run even when this call has no persistent event."""
    if continuous(context):
        return "diagnostic" if context.get("diagnostics", "normal") == "full" else None
    return "event"


def emit(context, event_type, data):
    """Diagnostics must not change a function's result or retry device actions."""
    global _sequence, _warned
    host_available = context.get("run_id") and context.get("socket_path")
    sink = context.get("event_sink")
    observer = context.get("recording_observer")
    recorder = context.get("recording_sink")
    channel = diagnostic_channel(context)
    if not host_available and sink is None and observer is None and recorder is None:
        return
    _sequence += 1
    origin = {"eventId": f"{_clock_id}:{_sequence}", "clockId": _clock_id,
              "seq": _sequence, "at": datetime.now(timezone.utc).isoformat(),
              "atMs": time.monotonic() * 1000}
    for observer_sink in (sink, observer):
        if observer_sink is None:
            continue
        try:
            observer_sink(context, event_type, data, origin)
        except Exception as error:
            if not _warned:
                print(f"Ludens Python logging unavailable: {error}", file=sys.stderr)
                _warned = True
    if channel is None or not (host_available or recorder):
        return
    try:
        if recorder is not None:
            recorder(event_type, data, context["trace"], origin, channel)
            return
        request(context["socket_path"], {
            "kind": "workspace_event", "argv": [], "runId": context["run_id"],
            "epoch": context["epoch"], "trace": context["trace"],
            "event": {"type": event_type, "data": data, "origin": origin,
                      **({"channel": channel} if channel == "diagnostic" else {})},
        }, timeout=1)
    except Exception as error:
        if not _warned:
            print(f"Ludens Python logging unavailable: {error}", file=sys.stderr)
            _warned = True


@contextmanager
def invocation(identity):
    parent = current()
    trace = {**parent["trace"], "traceId": parent["trace"].get("traceId") or uuid.uuid4().hex,
             "spanId": uuid.uuid4().hex[:16]}
    if parent["trace"].get("spanId"):
        trace["parentSpanId"] = parent["trace"]["spanId"]
    if parent["epoch"] is not None:
        trace["epoch"] = parent["epoch"]
    if continuous(parent):
        trace["recordingPurpose"] = parent.get("recording_purpose") or parent["trace"]["recordingPurpose"]
    context = {**parent, "trace": trace}
    data = {**identity, "pid": os.getpid()}
    with scope(context):
        rpc_stats = {"calls": 0, "errors": 0, "durationMs": 0,
                     "controllerCalls": 0, "observeCalls": 0}
        token = _CURRENT_RPC_STATS.set(rpc_stats)
        emit(context, "python_call_start", data)
        started = time.monotonic()
        try:
            yield
        except BaseException as error:
            emit(context, "python_call_end", {**data, "outcome": "error",
                 "durationMs": (time.monotonic() - started) * 1000,
                 "errorType": type(error).__name__, "error": f"{type(error).__name__}: {error}",
                 **({"traceback": traceback.format_exc()} if context.get("diagnostics") == "full" else {}),
                 "rpc": dict(rpc_stats)})
            raise
        else:
            emit(context, "python_call_end", {**data, "outcome": "success",
                 "durationMs": (time.monotonic() - started) * 1000, "rpc": dict(rpc_stats)})
        finally:
            _CURRENT_RPC_STATS.reset(token)
            parent_stats = _CURRENT_RPC_STATS.get()
            if isinstance(parent_stats, dict):
                for key, value in rpc_stats.items():
                    parent_stats[key] = parent_stats.get(key, 0) + value
