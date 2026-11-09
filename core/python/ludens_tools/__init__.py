"""Ordinary Python capabilities, timeline records and Shiori run evidence."""

from typing import Any

from ._context import LudensError, eval_env
from .client import Client, RecordWindow, record_window, replay
from ._decorators import capability, record, observe, eval_capability, eval


def call(capability_id: str, arguments: dict[str, Any] | None = None, *, machine: str | None = None) -> Any:
    """Call a capability using the ambient client context, optionally pinned to a machine."""
    return Client().call(capability_id, arguments, machine=machine)


def machines() -> Any:
    """List mounted and registered machines in the current workspace."""
    return Client().machines()


def use_machine(machine_id: str) -> Any:
    """Switch the active primary machine in the current workspace."""
    return Client().use_machine(machine_id)


def connect_machines(*machine_ids: str) -> Any:
    """Mount one or more machines concurrently in Baseware."""
    return Client().connect_machines(*machine_ids)


def disconnect_machines(machine_id: str) -> Any:
    """Unmount a secondary machine from Baseware."""
    return Client().disconnect_machines(machine_id)


__all__ = ["Client", "RecordWindow", "record_window", "replay", "LudensError", "capability", "record", "observe", "eval_capability", "eval", "eval_env", "call", "machines", "use_machine", "connect_machines", "disconnect_machines"]
