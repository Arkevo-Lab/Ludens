"""Cross-platform helpers shared by the offline Python tests.

`core/scripts/test-python.py` loads every `*.test.py` through `spec_from_file_location`, so tests
import this module after putting their own directory on `sys.path`.

* `TemporaryDirectory` closes every `ObservationHistory` opened beneath it before removing the
  directory: Windows keeps `writer.lock` open exclusively, so removal would otherwise fail.
* `stop_process` ends a `ludens_tools._perception` subprocess by closing stdin and waiting for its
  clean EOF exit. Windows `terminate()` is `TerminateProcess(..., 1)`, which skips `finally` blocks
  and reports exit code 1, so it is only a fallback.
* `kill_tree` is the crash simulation (`taskkill /T` on Windows, where the venv launcher would otherwise survive).
* `UnixStreamServer` is `socketserver.ThreadingUnixStreamServer` on POSIX and a Winsock `AF_UNIX`
  server on Windows (the same `sockaddr_un` layout as `ludens_tools._context._connect_local`).
"""

from pathlib import Path
import select
import socket
import socketserver
import subprocess
import sys
import tempfile
import threading
import weakref

from ludens_tools._observation_history import ObservationHistory

_histories = weakref.WeakSet()
_history_init = ObservationHistory.__init__


def _tracked_init(self, *args, **kwargs):
    _history_init(self, *args, **kwargs)
    _histories.add(self)


if ObservationHistory.__init__ is _history_init:
    ObservationHistory.__init__ = _tracked_init


class TemporaryDirectory(tempfile.TemporaryDirectory):
    """`tempfile.TemporaryDirectory` that releases histories living inside it first."""

    def _close_histories(self):
        root = Path(self.name).resolve()
        for history in list(_histories):
            try:
                inside = Path(history.directory).resolve().is_relative_to(root)
            except (OSError, ValueError):
                inside = False
            if inside:
                history.close()

    def cleanup(self):
        self._close_histories()
        super().cleanup()


def kill_tree(process):
    """Kill a worker and its children; a Windows venv python.exe is a launcher over the real interpreter."""
    if sys.platform == "win32":
        subprocess.run(["taskkill", "/PID", str(process.pid), "/T", "/F"], capture_output=True, timeout=10)
    try:
        process.kill()
    except OSError:
        pass


def stop_process(process, timeout=3):
    """Close stdin so the worker exits through its own EOF path; force it only on timeout."""
    try:
        process.stdin.close()
    except Exception:
        pass
    try:
        process.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        process.terminate()
        try:
            process.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            kill_tree(process)
            process.wait()


class _WinsockUnixServer:
    """Threaded stream server on a Winsock AF_UNIX socket; CPython's socket module cannot bind it."""

    def __init__(self, path, handler):
        import ctypes

        class UnixAddress(ctypes.Structure):
            _fields_ = [("family", ctypes.c_ushort), ("path", ctypes.c_char * 108)]

        encoded = str(path).encode("utf-8")
        if len(encoded) >= 108:
            raise ValueError("socket path is too long for Winsock")
        self._handler = handler
        self._family = 1  # AF_UNIX in Winsock
        self._winsock = ctypes.WinDLL("Ws2_32.dll")
        winsock = self._winsock
        winsock.bind.argtypes = [ctypes.c_size_t, ctypes.POINTER(UnixAddress), ctypes.c_int]
        winsock.listen.argtypes = [ctypes.c_size_t, ctypes.c_int]
        winsock.accept.argtypes = [ctypes.c_size_t, ctypes.c_void_p, ctypes.c_void_p]
        winsock.accept.restype = ctypes.c_size_t
        self._listener = socket.socket(self._family, socket.SOCK_STREAM)
        address = UnixAddress(self._family, encoded)
        try:
            if winsock.bind(self._listener.fileno(), ctypes.byref(address), ctypes.sizeof(address)) != 0:
                raise ctypes.WinError(winsock.WSAGetLastError())
            if winsock.listen(self._listener.fileno(), 64) != 0:
                raise ctypes.WinError(winsock.WSAGetLastError())
        except BaseException:
            self._listener.close()
            raise
        self._stop = threading.Event()
        self._stopped = threading.Event()
        self._stopped.set()

    def serve_forever(self, poll_interval=0.05):
        self._stopped.clear()
        try:
            while not self._stop.is_set():
                readable, _, _ = select.select([self._listener], [], [], poll_interval)
                if not readable:
                    continue
                handle = self._winsock.accept(self._listener.fileno(), None, None)
                if handle in (0, 2 ** 64 - 1, 2 ** 32 - 1):  # INVALID_SOCKET
                    continue
                connection = socket.socket(self._family, socket.SOCK_STREAM, fileno=handle)
                threading.Thread(target=self._serve, args=(connection,), daemon=True).start()
        finally:
            self._stopped.set()

    def _serve(self, connection):
        try:
            self._handler(connection, "", self)
        finally:
            try:
                connection.close()
            except OSError:
                pass

    def shutdown(self):
        self._stop.set()
        self._stopped.wait()

    def server_close(self):
        self._listener.close()


UnixStreamServer = _WinsockUnixServer if sys.platform == "win32" else socketserver.ThreadingUnixStreamServer
