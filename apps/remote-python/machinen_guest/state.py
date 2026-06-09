"""Warm state that survives snapshot/restore via /mf/state."""

from __future__ import annotations

from typing import Any


class CounterState:
    def __init__(self) -> None:
        self.count = 0

    def increment(self) -> int:
        self.count += 1
        return self.count

    def current(self) -> int:
        return self.count

    def dehydrate(self) -> dict[str, Any]:
        return {"counter": self.count}

    def rehydrate(self, state: dict[str, Any]) -> None:
        self.count = int(state.get("counter", 0))
