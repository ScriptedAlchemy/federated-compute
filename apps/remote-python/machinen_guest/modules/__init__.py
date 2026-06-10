"""Exposed modules, one file per MF expose path."""

from __future__ import annotations

from ..registry import GuestModule
from ..state import CounterState
from . import counter, data, pyinfo, stats


def default_modules(counter_state: CounterState) -> list[GuestModule]:
    """Assemble today's exposes in manifest order."""
    return [
        stats.build(),
        data.build(),
        counter.build(counter_state),
        pyinfo.build(),
    ]


__all__ = ["default_modules"]
