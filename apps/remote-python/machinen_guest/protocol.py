"""Guest protocol v3 constants, signature helper, and manifest builder."""

from __future__ import annotations

import sys
from typing import Any

NAME = "python_machine"
VERSION = "1.0.0"
PROTOCOL = 3

Signature = dict[str, Any]


def sig(returns: str, *params: tuple[str, str]) -> Signature:
    """Describe a function signature for the manifest.

    ``params`` are ``(name, type)`` pairs; types use the host's TS-ish notation.
    """
    return {"params": [{"name": n, "type": t} for n, t in params], "returns": returns}


def build_manifest(exposes: dict[str, dict[str, Signature]]) -> dict[str, Any]:
    """Build the /mf-manifest.json payload from ``path -> fn -> signature``."""
    return {
        "name": NAME,
        "protocol": PROTOCOL,
        "version": VERSION,
        "metaData": {
            "runtime": f"{sys.implementation.name} {sys.version.split()[0]}",
            "features": ["state"],
        },
        "exposes": exposes,
    }
