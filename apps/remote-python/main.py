"""Machine guest service in Python.

Thin entrypoint for the federated-compute guest protocol v3 service; the
implementation lives in the ``machinen_guest`` package next to this file.
Stdlib only: run with `python3 main.py`.
"""

import os

from machinen_guest.modules import default_modules
from machinen_guest.registry import Registry
from machinen_guest.server import ServerConfig, serve
from machinen_guest.state import CounterState


def main() -> None:
    config = ServerConfig(port=int(os.environ.get("PORT", "3803")))
    state = CounterState()
    registry = Registry(default_modules(state))
    try:
        serve(config, registry, state)
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
