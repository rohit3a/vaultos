#!/usr/bin/env bash
# Install a packaged VaultOS Preview Linux build for the current user.
#
#   scripts/install-linux.sh [--from DIR|ARCHIVE] [--prefix DIR] [--harden] [--enable-service]
#
#   --from DIR|ARCHIVE  build folder or .tar.gz from `npm run dist:linux`
#                       (default: dist/vaultos-preview-linux-<arch> in this checkout)
#   --prefix DIR        absolute install folder (default: ~/.local/opt/vaultos-preview)
#   --harden            run sudo to make chrome-sandbox root-owned and setuid
#   --enable-service    write, enable and start the systemd user unit that runs this
#                       checkout's backend.cjs (needs `npm ci --omit=dev` here first)
#
# Without --harden nothing runs as root; without --enable-service no service is written.
# Vault data is never touched: it stays in ~/.config/VaultOS-Preview (or VAULTOS_DATA_DIR).
set -euo pipefail

die() { echo "install-linux: $*" >&2; exit 1; }

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
from="" prefix="$HOME/.local/opt/vaultos-preview" harden=0 enable_service=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --from) [[ $# -ge 2 ]] || die "--from needs a value"; from="$2"; shift 2 ;;
    --prefix) [[ $# -ge 2 ]] || die "--prefix needs a value"; prefix="$2"; shift 2 ;;
    --harden) harden=1; shift ;;
    --enable-service) enable_service=1; shift ;;
    -h|--help) sed -n '2,14p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown option: $1 (see --help)" ;;
  esac
done

[[ "$(uname -s)" == Linux ]] || die "this installer is for Linux"

# Paths end up in a .desktop Exec line and a systemd unit, which give these characters meaning.
safe_path() {
  [[ "$1" == /* ]] || die "$2 must be an absolute path: $1"
  case "$1" in *[\"\\\`\$%\&\|]*|*$'\n'*) die "$2 contains characters that cannot be written safely: $1" ;; esac
}

xdg_dir() { if [[ -n "${!1:-}" && "${!1}" == /* ]]; then printf '%s' "${!1}"; else printf '%s' "$2"; fi; }

case "$(uname -m)" in
  x86_64|amd64) arch=x64 ;;
  aarch64|arm64) arch=arm64 ;;
  *) die "unsupported architecture: $(uname -m)" ;;
esac

prefix="${prefix%/}"
safe_path "$prefix" "--prefix"
[[ "$prefix" != "$HOME" && "$prefix" != "$(dirname "$HOME")" && "$prefix" == /*/* ]] || die "refusing to install into $prefix"
desktop_file="$(xdg_dir XDG_DATA_HOME "$HOME/.local/share")/applications/org.vaultos.preview.desktop"
unit_file="$(xdg_dir XDG_CONFIG_HOME "$HOME/.config")/systemd/user/vaultos-preview-backend.service"

# Never replace a folder that is not a previous VaultOS Preview install.
if [[ -e "$prefix" ]]; then
  [[ -d "$prefix" ]] || die "$prefix exists and is not a folder"
  if [[ -n "$(ls -A "$prefix")" && ! ( -x "$prefix/vaultos-preview" && -f "$prefix/resources/app.asar" ) ]]; then
    die "$prefix is not empty and is not a VaultOS Preview install; choose another --prefix"
  fi
  if command -v pgrep >/dev/null 2>&1 && pgrep -f -- "$prefix/vaultos-preview" >/dev/null 2>&1; then
    die "VaultOS Preview is running from $prefix; quit it and retry"
  fi
fi

tmp="$(mktemp -d)" staging=""
trap 'rm -rf "$tmp" ${staging:+"$staging"}' EXIT

src="${from:-$repo/dist/vaultos-preview-linux-$arch}"
if [[ -f "$src" ]]; then
  if [[ -f "$src.sha256" ]]; then
    (cd "$(dirname "$src")" && sha256sum -c "$(basename "$src").sha256") || die "checksum mismatch for $src"
  else
    echo "note: no $(basename "$src").sha256 next to the archive; skipping checksum verification"
  fi
  tar -xzf "$src" -C "$tmp"
  src="$tmp/vaultos-preview-linux-$arch"
fi
[[ -x "$src/vaultos-preview" && -f "$src/resources/app.asar" && -f "$src/chrome-sandbox" ]] \
  || die "no VaultOS Preview linux-$arch build at $src; run 'npm run dist:linux' or pass --from"

mkdir -p "$(dirname "$prefix")"
staging="$(mktemp -d "$(dirname "$prefix")/.vaultos-preview-install.XXXXXX")"
cp -R "$src/." "$staging/"
chmod 755 "$staging"

# A hardened helper is root-owned, so a fresh copy would silently lose the sandbox. Keep the
# old one only when it is byte-identical; a different helper means a different Electron.
kept_helper=0
if [[ -u "$prefix/chrome-sandbox" && "$(stat -c %u "$prefix/chrome-sandbox")" == 0 ]]; then
  if cmp -s "$prefix/chrome-sandbox" "$staging/chrome-sandbox"; then
    mv -f "$prefix/chrome-sandbox" "$staging/chrome-sandbox"
    kept_helper=1
  else
    echo "note: this build has a different chrome-sandbox helper; it must be hardened again"
  fi
fi

cat > "$staging/vaultos-preview.sh" <<'LAUNCH'
#!/usr/bin/env bash
# Start VaultOS Preview with the Chromium sandbox whenever this system can provide one.
# Checked at each launch, so hardening the helper later takes effect without reinstalling.
set -euo pipefail
here="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
helper="$here/chrome-sandbox"

suid_helper() { [[ -u "$helper" && "$(stat -c %u "$helper" 2>/dev/null)" == 0 ]]; }
# Chromium uses unprivileged user namespaces when the kernel allows them. Ubuntu 24.04+
# restricts them through AppArmor, which leaves only the setuid helper.
userns_sandbox() {
  [[ "$(cat /proc/sys/kernel/unprivileged_userns_clone 2>/dev/null || echo 1)" != 0 ]] &&
  [[ "$(cat /proc/sys/user/max_user_namespaces 2>/dev/null || echo 1)" != 0 ]] &&
  [[ "$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null || echo 0)" != 1 ]]
}

if suid_helper || userns_sandbox; then
  exec "$here/vaultos-preview" "$@"
fi
echo "VaultOS Preview: the Chromium sandbox is unavailable; starting with --no-sandbox." >&2
printf 'To enable it: sudo chown root:root %q && sudo chmod 4755 %q\n' "$helper" "$helper" >&2
exec "$here/vaultos-preview" --no-sandbox "$@"
LAUNCH
chmod 755 "$staging/vaultos-preview.sh"

if [[ -e "$prefix" ]]; then
  mv "$prefix" "$staging.old"
  mv "$staging" "$prefix"
  rm -rf "$staging.old"
else
  mv "$staging" "$prefix"
fi

mkdir -p "$(dirname "$desktop_file")"
cat > "$desktop_file.tmp" <<DESKTOP
[Desktop Entry]
Type=Application
Name=VaultOS Preview
Comment=Local vault for project secrets with an MCP bridge for coding agents
Exec="$prefix/vaultos-preview.sh"
Icon=$prefix/vaultos-preview.png
Terminal=false
Categories=Development;Utility;
StartupWMClass=VaultOS Preview
DESKTOP
chmod 644 "$desktop_file.tmp"
mv -f "$desktop_file.tmp" "$desktop_file"
command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$(dirname "$desktop_file")" >/dev/null 2>&1 || true

echo "installed:"
echo "  app       $prefix/vaultos-preview"
echo "  launcher  $prefix/vaultos-preview.sh"
echo "  desktop   $desktop_file"

helper="$prefix/chrome-sandbox"
harden_cmd="$(printf 'sudo chown root:root %q && sudo chmod 4755 %q' "$helper" "$helper")"
if [[ $harden == 1 && $kept_helper == 0 ]]; then
  echo "Running: $harden_cmd"
  sudo chown root:root "$helper"
  sudo chmod 4755 "$helper"
fi
if [[ -u "$helper" && "$(stat -c %u "$helper")" == 0 ]]; then
  echo "  sandbox   setuid helper installed"
else
  echo "  sandbox   checked at each launch; if this system restricts user namespaces"
  echo "            (Ubuntu 24.04+), the app starts with --no-sandbox until you run:"
  echo "            $harden_cmd"
fi

if [[ $enable_service == 1 ]]; then
  command -v systemctl >/dev/null 2>&1 || die "systemctl is not available; the backend service needs systemd"
  node="$(command -v node || true)"
  [[ -n "$node" ]] || die "node is not on PATH; install Node.js 22+ for the backend service"
  "$node" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' || die "the backend service needs Node.js 22+ ($node)"
  backend="$repo/backend.cjs"
  safe_path "$node" "node path"
  safe_path "$backend" "backend path"
  [[ -f "$backend" && -d "$repo/node_modules" ]] || die "run 'npm ci --omit=dev --ignore-scripts' in $repo before --enable-service"
  mkdir -p "$(dirname "$unit_file")"
  sed -e "s|@NODE@|$node|g" -e "s|@BACKEND@|$backend|g" "$repo/scripts/vaultos-preview-backend.service" > "$unit_file.tmp"
  chmod 644 "$unit_file.tmp"
  mv -f "$unit_file.tmp" "$unit_file"
  systemctl --user daemon-reload
  systemctl --user enable --now vaultos-preview-backend.service
  echo "  service   $unit_file (enabled)"
  echo "            It unlocks only if background access is enabled in Settings."
  echo "            Status: systemctl --user status vaultos-preview-backend.service"
else
  echo "  service   not installed (pass --enable-service to run the headless backend under systemd)"
fi
