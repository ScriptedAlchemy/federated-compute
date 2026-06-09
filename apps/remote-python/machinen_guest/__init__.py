"""Machine guest implementation of the federated-compute guest protocol v3.

Packages the HTTP server, module registry, warm state, and the exposed
modules. Stdlib only; the entrypoint stays ``main.py`` next to this package.
"""

from .protocol import NAME, PROTOCOL, VERSION

__all__ = ["NAME", "PROTOCOL", "VERSION"]
