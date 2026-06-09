"""Expose ./counter: warm-state counter backed by a CounterState instance."""

from __future__ import annotations

from ..protocol import sig
from ..registry import GuestModule
from ..state import CounterState

PATH = "./counter"


def build(state: CounterState) -> GuestModule:
    return GuestModule(
        path=PATH,
        functions={
            "increment": (state.increment, sig("number")),
            "current": (state.current, sig("number")),
        },
    )
