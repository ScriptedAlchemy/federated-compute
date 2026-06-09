"""Expose ./data: text and list utilities."""

from __future__ import annotations

from collections import Counter

from ..protocol import sig
from ..registry import GuestModule

PATH = "./data"


def word_count(text: str) -> dict[str, int]:
    return dict(Counter(text.lower().split()))


def sort_numbers(values: list[float]) -> list[float]:
    return sorted(values)


def build() -> GuestModule:
    return GuestModule(
        path=PATH,
        functions={
            "wordCount": (word_count, sig("Record<string, number>", ("text", "string"))),
            "sortNumbers": (sort_numbers, sig("number[]", ("values", "number[]"))),
        },
    )
