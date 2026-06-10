"""Module registry: maps MF-style expose paths to callable functions."""

from __future__ import annotations

from collections.abc import Callable, Iterable, Sequence
from dataclasses import dataclass
from typing import Any

from .protocol import Signature, build_manifest

Handler = Callable[..., Any]
FunctionEntry = tuple[Handler, Signature]


@dataclass(frozen=True)
class GuestModule:
    """One exposed module: an MF path plus its named functions."""

    path: str
    functions: dict[str, FunctionEntry]


class Registry:
    def __init__(self, modules: Iterable[GuestModule]) -> None:
        self._modules: dict[str, GuestModule] = {m.path: m for m in modules}

    def manifest(self) -> dict[str, Any]:
        return build_manifest(
            {
                path: {fn: signature for fn, (_, signature) in module.functions.items()}
                for path, module in self._modules.items()
            }
        )

    def dispatch(self, module: str, fn: str, args: Sequence[Any]) -> Any:
        mod = self._modules.get(module)
        if mod is None:
            raise ValueError(f'unknown module "{module}"')
        entry = mod.functions.get(fn)
        if entry is None:
            raise ValueError(f'module "{module}" has no function "{fn}"')
        handler, _ = entry
        return handler(*args)
