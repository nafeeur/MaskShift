#!/usr/bin/env bash
set -euo pipefail

PREFIX="${MASKSHIFT_PREFIX:-$HOME/.local}"
SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_SERVICE=0
UNINSTALL=0

usage() {
  cat <<USAGE
MaskShift installer

Usage: ./install.sh [--prefix PATH] [--systemd-user] [--uninstall]

  --prefix PATH     Install under PATH (default: ~/.local)
  --systemd-user    Install and enable the user-level automation daemon service
  --uninstall       Remove the installed application and command link
USAGE
}

while (($#)); do
  case "$1" in
    --prefix) PREFIX="${2:?missing prefix}"; shift 2 ;;
    --systemd-user) INSTALL_SERVICE=1; shift ;;
    --uninstall) UNINSTALL=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

APP_PARENT="$PREFIX/lib"
APP_DIR="$APP_PARENT/maskshift"
BIN_DIR="$PREFIX/bin"
BIN_LINK="$BIN_DIR/maskshift"

if ((UNINSTALL)); then
  if command -v systemctl >/dev/null 2>&1; then
    systemctl --user disable --now maskshift.service >/dev/null 2>&1 || true
    rm -f "$HOME/.config/systemd/user/maskshift.service"
    systemctl --user daemon-reload >/dev/null 2>&1 || true
  fi
  rm -f "$BIN_LINK"
  rm -rf "$APP_DIR"
  echo "MaskShift removed from $PREFIX"
  exit 0
fi

command -v node >/dev/null 2>&1 || { echo "Node.js 22 or newer is required." >&2; exit 1; }
node -e 'const major=Number(process.versions.node.split(".")[0]); if(major<22){console.error("Node.js 22 or newer is required; found "+process.version);process.exit(1)}'

mkdir -p "$APP_PARENT" "$BIN_DIR"
STAGE_DIR="$(mktemp -d "$APP_PARENT/.maskshift-stage.XXXXXX")"
BACKUP_DIR="$APP_PARENT/.maskshift-old.$$"
cleanup() {
  if [[ -n "${STAGE_DIR:-}" ]]; then rm -rf "$STAGE_DIR"; fi
  if [[ -n "${BACKUP_DIR:-}" ]]; then rm -rf "$BACKUP_DIR"; fi
  return 0
}
trap cleanup EXIT

# Stage a complete copy so upgrades never retain files removed by a newer release.
tar \
  --exclude='./.git' \
  --exclude='./.maskshift' \
  --exclude='./node_modules' \
  --exclude='./dist' \
  --exclude='./coverage' \
  --exclude='./MaskShift-*.zip' \
  --exclude='./MaskShift-*.tar.gz' \
  -C "$SOURCE_DIR" -cf - . | tar -C "$STAGE_DIR" -xf -
chmod +x "$STAGE_DIR/bin/maskshift.mjs" "$STAGE_DIR/start.sh" "$STAGE_DIR/install.sh"

if [[ -e "$APP_DIR" ]]; then
  mv "$APP_DIR" "$BACKUP_DIR"
fi
if ! mv "$STAGE_DIR" "$APP_DIR"; then
  [[ -e "$BACKUP_DIR" ]] && mv "$BACKUP_DIR" "$APP_DIR"
  echo "MaskShift installation failed while activating the staged release." >&2
  exit 1
fi
STAGE_DIR=""
rm -rf "$BACKUP_DIR"
BACKUP_DIR=""
rm -f "$BIN_LINK"
printf -v MASKSHIFT_ENTRY '%q' "$APP_DIR/bin/maskshift.mjs"
cat > "$BIN_LINK" <<EOF
#!/usr/bin/env bash
exec node --no-warnings $MASKSHIFT_ENTRY "\$@"
EOF
chmod +x "$BIN_LINK"

if ((INSTALL_SERVICE)); then
  command -v systemctl >/dev/null 2>&1 || { echo "systemctl is required for --systemd-user" >&2; exit 1; }
  mkdir -p "$HOME/.config/systemd/user" "$HOME/.config/maskshift"
  MASKSHIFT_BIN="$BIN_LINK" node - "$APP_DIR/deploy/maskshift.service" <<'NODE' > "$HOME/.config/systemd/user/maskshift.service"
const fs = require('node:fs');
const source = fs.readFileSync(process.argv[2], 'utf8');
process.stdout.write(source.replaceAll('%h/.local/bin/maskshift', process.env.MASKSHIFT_BIN));
NODE
  systemctl --user daemon-reload
  systemctl --user enable --now maskshift.service
fi

echo "MaskShift installed: $APP_DIR"
echo "Command: $BIN_LINK"
if [[ ":$PATH:" != *":$BIN_DIR:"* ]]; then
  echo "Add $BIN_DIR to PATH to invoke 'maskshift' directly."
fi
if ((INSTALL_SERVICE)); then
  echo "Automation daemon enabled: systemctl --user status maskshift.service"
fi
echo "Start the interface with: $BIN_LINK"
echo "Or run headless with:     $BIN_LINK run \"make the tests pass\""
