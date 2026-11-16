"""Small synchronous client for the independent Baseware Unix-socket or Named Pipe service."""

import json
import os
import socket
import sys
import time
import uuid


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
                raise TimeoutError("Baseware pipe connection timed out")
            if kernel32.WaitNamedPipeW(pipe_path, min(wait_ms, 5000)):
                continue
            wait_err = ctypes.get_last_error()
            if wait_err == ERROR_FILE_NOT_FOUND:
                raise FileNotFoundError(pipe_path)
            if wait_err == 121:  # ERROR_SEM_TIMEOUT
                if deadline is not None and _remaining_ms() <= 0:
                    raise TimeoutError("Baseware pipe connection timed out")
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
                raise TimeoutError("Baseware timed out waiting for named pipe")
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

    import ctypes
    import select

    class UnixAddress(ctypes.Structure):
        _fields_ = [("family", ctypes.c_ushort), ("path", ctypes.c_char * 108)]

    path = os.fsencode(socket_path)
    if len(path) >= 108:
        raise ValueError("Baseware socket path is too long for Winsock")
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
                raise TimeoutError("Baseware connection timed out")
            error = connection.getsockopt(socket.SOL_SOCKET, socket.SO_ERROR)
            if error:
                raise ctypes.WinError(error)
        return connection
    except BaseException:
        connection.close()
        raise


class BasewareError(RuntimeError):
    """A service error, retaining its structured wire representation."""

    def __init__(self, error):
        self.error = error
        super().__init__(error.get("message", str(error)) if isinstance(error, dict) else str(error))


class Client:
    """Use the caller's socket, epoch and trace; each request owns one connection.

    Ludens keeps the control lease alive separately. This client neither acquires
    a lease automatically nor retries commands after a connection failure.
    """

    def __init__(self, socket_path=None, *, epoch=None, trace=None, timeout=None):
        self.socket_path = socket_path if socket_path is not None else os.environ.get("BASEWARE_SOCKET")
        self.epoch = epoch if epoch is not None else os.environ.get("BASEWARE_EPOCH")
        self.trace = trace if trace is not None else json.loads(os.environ.get("BASEWARE_TRACE", "{}"))
        self.timeout = timeout

    def request(self, kind, **fields):
        if not self.socket_path:
            raise ValueError("BASEWARE_SOCKET or socket_path is required")
        request = {"kind": kind, **fields}
        if self.epoch is not None:
            request["epoch"] = self.epoch
        if self.trace:
            request["trace"] = self.trace
        request_id = str(uuid.uuid4())
        wire = json.dumps({"id": request_id, "request": request}, allow_nan=False).encode("utf-8") + b"\n"
        with _connect_local(self.socket_path, self.timeout) as connection:
            connection.sendall(wire)
            with connection.makefile("rb") as incoming:
                for line in incoming:
                    reply = json.loads(line)
                    # A subscribed service may interleave events with replies.
                    if reply.get("id") != request_id or "ok" not in reply:
                        continue
                    if reply["ok"]:
                        return reply.get("value")
                    raise BasewareError(reply.get("error", "Baseware request failed"))
        raise ConnectionError("Baseware disconnected before replying; the request was not retried")

    def status(self):
        return self.request("status")

    def list(self):
        return self.request("list")

    def help(self, capability_id):
        return self.request("help", id=capability_id)

    def controller(self, capability_id, arguments=None):
        if arguments is None:
            arguments = {}
        if not isinstance(arguments, dict):
            raise TypeError("Tool arguments must be a JSON object")
        return self.request("controller", id=capability_id, arguments=arguments)

    def release(self):
        return self.request("release")

    def revoke(self):
        return self.request("revoke")


__all__ = ["Client", "BasewareError"]
