"""Expose ./stats: descriptive statistics over number arrays."""

from __future__ import annotations

import statistics

from ..protocol import sig
from ..registry import GuestModule

PATH = "./stats"


def mean(values: list[float]) -> float:
    return statistics.fmean(values)


def median(values: list[float]) -> float:
    return statistics.median(values)


def stdev(values: list[float]) -> float:
    return statistics.stdev(values)


def build() -> GuestModule:
    numbers_sig = sig("number", ("values", "number[]"))
    return GuestModule(
        path=PATH,
        functions={
            "mean": (mean, numbers_sig),
            "median": (median, numbers_sig),
            "stdev": (stdev, numbers_sig),
        },
    )
