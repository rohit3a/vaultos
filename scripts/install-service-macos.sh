#!/usr/bin/env bash
# Install or remove a per-user LaunchAgent that runs `backend.cjs --service`, the optional
# always-on VaultOS Preview owner. Nothing runs this automatically.
#
# The service uses Node.js and the same source checkout as the MCP bridge. The packaged app
# cannot run backend.cjs itself: its Electron fuses disable RunAsNode. The service starts
# serving only after background access is enabled in the desktop's Settings, waits while the
# desktop owns the vault, and exits if background access is off.
set -euo pipefail

label="org.vaultos.preview.backend"
plist="$HOME/Library/LaunchAgents/$label.plist"
log_dir="$HOME/Library/Logs/VaultOS-Preview"
source_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
node="$(command -v node || true)"
data_dir=""
sync_repo=""
mode="install"

usage() {
  cat <<EOF
Usage: $0 [--node PATH] [--source DIR] [--data-dir DIR] [--sync-repo DIR] [--print]
       $0 --uninstall

  --node PATH      Node.js 22+ to run the backend (default: node on PATH)
  --source DIR     VaultOS source checkout (default: this script's checkout)
  --data-dir DIR   Absolute VAULTOS_DATA_DIR, only if you use a nondefault one
  --sync-repo DIR  Absolute VAULTOS_SYNC_REPO, only if you use a nondefault one
  --print          Print the LaunchAgent property list without installing it
  --uninstall      Stop the service and remove its LaunchAgent
EOF
}

die() { echo "$*" >&2; exit 1; }

while (($#)); do
  case $1 in
    --uninstall) mode="uninstall" ;;
    --print) mode="print" ;;
    --node) node=${2:?--node needs a path}; shift ;;
    --source) source_dir=${2:?--source needs a directory}; shift ;;
    --data-dir) data_dir=${2:?--data-dir needs a directory}; shift ;;
    --sync-repo) sync_repo=${2:?--sync-repo needs a directory}; shift ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; exit 2 ;;
  esac
  shift
done

[[ $(uname -s) == Darwin ]] || die "This installer is for macOS LaunchAgents."
domain="gui/$(id -u)"

if [[ $mode == uninstall ]]; then
  launchctl bootout "$domain/$label" 2>/dev/null || true
  rm -f "$plist"
  echo "Removed $label. Vault data, Keychain items and logs were not touched."
  exit 0
fi

[[ -n $node && -x $node ]] || die "Node.js 22+ not found. Pass --node /absolute/path/to/node."
[[ $node == /* ]] || node="$(cd "$(dirname "$node")" && pwd)/$(basename "$node")"
major="$("$node" -p 'process.versions.node.split(".")[0]')"
((major >= 22)) || die "Node.js 22+ is required; $node is $("$node" --version)."
source_dir="$(cd "$source_dir" && pwd)"
[[ -f $source_dir/backend.cjs && -f $source_dir/autosync.js && -d $source_dir/node_modules ]] \
  || die "$source_dir is not a VaultOS source checkout with installed dependencies (npm ci --omit=dev --ignore-scripts)."
[[ -x $source_dir/build/native/vaultos-keychain ]] \
  || die "Build the Keychain helper first: (cd '$source_dir' && npm run build:native)"
for dir in "$data_dir" "$sync_repo"; do
  [[ -z $dir || $dir == /* ]] || die "Directories must be absolute: $dir"
done

xml() {
  local amp='&amp;' lt='&lt;' gt='&gt;' s=$1
  s=${s//&/"$amp"}
  s=${s//</"$lt"}
  s=${s//>/"$gt"}
  printf '%s' "$s"
}

env_entry() { printf '    <key>%s</key><string>%s</string>\n' "$1" "$(xml "$2")"; }

render() {
  cat <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key><array>
    <string>$(xml "$node")</string><string>$(xml "$source_dir/backend.cjs")</string><string>--service</string>
  </array>
  <key>WorkingDirectory</key><string>$(xml "$source_dir")</string>
  <key>EnvironmentVariables</key><dict>
$(env_entry PATH "$(dirname "$node"):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin")
$([[ -n $data_dir ]] && env_entry VAULTOS_DATA_DIR "$data_dir")
$([[ -n $sync_repo ]] && env_entry VAULTOS_SYNC_REPO "$sync_repo")
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>ProcessType</key><string>Background</string>
  <key>StandardErrorPath</key><string>$(xml "$log_dir/backend.log")</string>
</dict></plist>
EOF
}

if [[ $mode == print ]]; then
  render
  exit 0
fi

mkdir -p "$HOME/Library/LaunchAgents"
mkdir -p -m 700 "$log_dir"
tmp="$(mktemp "$plist.XXXXXX")"
render >"$tmp"
plutil -lint -s "$tmp" || { rm -f "$tmp"; die "Generated property list is invalid."; }
chmod 644 "$tmp"
mv "$tmp" "$plist"
launchctl bootout "$domain/$label" 2>/dev/null || true
launchctl bootstrap "$domain" "$plist"
echo "Installed $label."
echo "It serves only while background access is enabled and no VaultOS window owns the vault."
echo "Log: $log_dir/backend.log   Remove: $0 --uninstall"
