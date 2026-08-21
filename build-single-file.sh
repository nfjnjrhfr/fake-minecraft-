#!/bin/sh
# Bundles the whole package into one runnable file.
#
# zipapp needs the package to stay a package -- the modules import each other
# with relative imports -- so the archive gets pyvpn/ as a subdirectory and a
# __main__.py beside it, rather than the package contents at the root.
set -eu

out="${1:-pyvpn-server.pyz}"
stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT

mkdir "$stage/pyvpn"
for file in pyvpn/*.py; do
    cp "$file" "$stage/pyvpn/"
done

cat > "$stage/__main__.py" <<'PY'
import sys

from pyvpn.cli import main

if __name__ == "__main__":
    sys.exit(main())
PY

python3 -m zipapp "$stage" -o "$out" -p "/usr/bin/env python3"
chmod +x "$out"
echo "built $out ($(wc -c < "$out") bytes)"
