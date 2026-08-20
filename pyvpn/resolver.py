"""Optional DNS override for clients.

Sending traffic through the tunnel but leaving DNS pointed at the local
network is the classic leak: the destinations are still visible to whoever
runs that resolver.  Setting ``DNS =`` in a client config swaps
``/etc/resolv.conf`` for the duration of the session and puts the original
back afterwards.
"""

from __future__ import annotations

import logging
import shutil
from pathlib import Path

log = logging.getLogger("pyvpn.resolver")

RESOLV_CONF = Path("/etc/resolv.conf")


class Resolver:
    def __init__(self, servers: list[str], path: Path = RESOLV_CONF) -> None:
        self.servers = servers
        self.path = path
        self.backup = path.with_suffix(path.suffix + ".pyvpn-backup")
        self._applied = False

    def apply(self) -> None:
        if not self.servers:
            return
        try:
            if self.path.exists():
                shutil.copy2(self.path, self.backup)
            content = "".join(f"nameserver {server}\n" for server in self.servers)
            self.path.write_text(f"# written by pyvpn\n{content}")
        except OSError as exc:
            log.warning("could not set DNS servers: %s", exc)
            return
        self._applied = True
        log.info("DNS now resolved through %s", ", ".join(self.servers))

    def revert(self) -> None:
        if not self._applied:
            return
        try:
            if self.backup.exists():
                shutil.copy2(self.backup, self.path)
                self.backup.unlink()
            else:
                self.path.unlink(missing_ok=True)
        except OSError as exc:
            log.warning("could not restore %s: %s", self.path, exc)
        self._applied = False

    def __enter__(self) -> "Resolver":
        self.apply()
        return self

    def __exit__(self, *exc_info) -> None:
        self.revert()
