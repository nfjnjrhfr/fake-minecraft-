#!/usr/bin/env bash
# Copies the bridge plugin into the local Roblox Studio plugins folder.
# Studio picks it up immediately - no restart needed.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
plugin_source="$repo_root/plugin/RobloxStudioBridge.server.luau"

if [[ ! -f "$plugin_source" ]]; then
  echo "Cannot find $plugin_source" >&2
  exit 1
fi

case "$(uname -s)" in
  Darwin)
    plugin_dir="$HOME/Documents/Roblox/Plugins"
    ;;
  MINGW*|MSYS*|CYGWIN*)
    plugin_dir="$LOCALAPPDATA/Roblox/Plugins"
    ;;
  *)
    # WSL, or Linux running Studio through Wine.
    if [[ -n "${LOCALAPPDATA:-}" ]]; then
      plugin_dir="$LOCALAPPDATA/Roblox/Plugins"
    elif [[ -d "/mnt/c/Users/$USER/AppData/Local/Roblox/Plugins" ]]; then
      plugin_dir="/mnt/c/Users/$USER/AppData/Local/Roblox/Plugins"
    else
      echo "Could not work out where Roblox Studio keeps its plugins on this system." >&2
      echo "Copy $plugin_source into that folder by hand." >&2
      exit 1
    fi
    ;;
esac

mkdir -p "$plugin_dir"
cp "$plugin_source" "$plugin_dir/RobloxStudioBridge.server.luau"
echo "Installed the bridge plugin to $plugin_dir"
echo "Now run: npm run serve"
