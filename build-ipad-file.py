"""Bundles the package into one .py file that Pyto can open and run.

A .pyz is a zip, which an iOS editor cannot open as a script, so this writes
a plain source file instead. Rather than rewriting the relative imports --
which would mean touching every module and getting the order right -- the
module sources travel compressed inside the file and are served to the
normal import machinery by a small finder. Imports then resolve exactly as
they do from the real package.

    python3 build-ipad-file.py            # writes pyvpn-ipad.py
"""

from __future__ import annotations

import base64
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parent
PACKAGE = ROOT / "pyvpn"

HEADER = '''#!/usr/bin/env python3
"""pyvpn on iOS -- the parts of it that a phone or tablet can actually run.

Open this in Pyto and press run. It performs the real handshake and the real
encryption between two endpoints inside this process, over loopback UDP.

What runs here:
    key agreement, the Noise handshake, packet encryption, replay rejection

What cannot run here, on any iOS app:
    the tunnel interface itself. Creating one needs /dev/net/tun and root,
    and iOS gives an app neither. Carrying real traffic therefore needs a
    Linux machine -- this file proves the cryptography works, not that your
    iPad has become a VPN.

Needs the full version of Pyto, which bundles the `cryptography` package.
"""

import base64 as _base64
import importlib.abc as _abc
import importlib.util as _util
import sys as _sys
import zlib as _zlib


class _Loader(_abc.Loader):
    """Executes a module whose source came from the table below."""

    def __init__(self, name, source, is_package):
        self._name = name
        self._source = source
        self._is_package = is_package

    def create_module(self, spec):
        return None

    def exec_module(self, module):
        exec(compile(self._source, "<%s>" % self._name, "exec"), module.__dict__)

    def is_package(self, name):
        return self._is_package


class _Finder(_abc.MetaPathFinder):
    def find_spec(self, name, path=None, target=None):
        if name not in _MODULES:
            return None
        blob, is_package = _MODULES[name]
        source = _zlib.decompress(_base64.b64decode(blob)).decode("utf-8")
        loader = _Loader(name, source, is_package)
        spec = _util.spec_from_loader(name, loader, is_package=is_package)
        if is_package:
            spec.submodule_search_locations = []
        return spec


'''

FOOTER = '''
_sys.meta_path.insert(0, _Finder())


def _run():
    from pyvpn.cli import main

    # Pyto starts a script with no arguments, and the check suite is the one
    # thing here worth running unattended.
    argv = _sys.argv[1:] or ["selftest"]
    return main(argv)


if __name__ == "__main__":
    raise SystemExit(_run())
'''


def main() -> int:
    entries = []
    for path in sorted(PACKAGE.glob("*.py")):
        stem = path.stem
        name = "pyvpn" if stem == "__init__" else "pyvpn.%s" % stem
        blob = base64.b64encode(zlib.compress(path.read_bytes(), 9)).decode("ascii")
        wrapped = "\n".join(
            '        "%s"' % blob[index : index + 88] for index in range(0, len(blob), 88)
        )
        entries.append(
            '    "%s": (\n%s,\n        %s,\n    ),'
            % (name, wrapped, "True" if stem == "__init__" else "False")
        )

    out = ROOT / "pyvpn-ipad.py"
    out.write_text(
        HEADER + "_MODULES = {\n" + "\n".join(entries) + "\n}\n" + FOOTER,
        encoding="utf-8",
    )
    print("wrote %s (%s bytes, %d modules)" % (out.name, f"{out.stat().st_size:,}", len(entries)))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
