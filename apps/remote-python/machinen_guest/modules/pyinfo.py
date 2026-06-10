"""Expose ./python: runtime introspection of the guest interpreter."""

from __future__ import annotations

import os
import sys
from typing import Any

from ..protocol import sig
from ..registry import GuestModule

PATH = "./python"


def info() -> dict[str, Any]:
    return {
        "pid": os.getpid(),
        "pythonVersion": sys.version.split()[0],
        "implementation": sys.implementation.name,
        "hint": "this ran inside the Python machine, not in the host process",
    }


def build() -> GuestModule:
    return GuestModule(
        path=PATH,
        functions={
            "info": (
                info,
                sig("{ pid: number; pythonVersion: string; implementation: string; hint: string }"),
            ),
        },
    )
