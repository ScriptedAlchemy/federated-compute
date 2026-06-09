"""Warm state that survives snapshot/restore via /mf/state."""

from __future__ import annotations

import threading
from typing import Any


class CounterState:
    """Counter shared across ThreadingHTTPServer request threads — guarded."""

    def __init__(self) -> None:
        self.count = 0
        self._lock = threading.Lock()

    def increment(self) -> int:
        with self._lock:
            self.count += 1
            return self.count

    def current(self) -> int:
        with self._lock:
            return self.count

    def dehydrate(self) -> dict[str, Any]:
        with self._lock:
            return {"counter": self.count}

    def rehydrate(self, state: dict[str, Any]) -> None:
        with self._lock:
            self.count = int(state.get("counter", 0))
