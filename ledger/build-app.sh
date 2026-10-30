#!/usr/bin/env bash
# Builds LedgerHQ/app-ethereum 1.23.0 for the Nano S Plus with the Covenant EIP-7702 delegate
# added to its 7702 whitelist, as a separate app named "Covenant 7702" (it coexists with the
# official Ethereum app), and prints / runs the ledgerblue sideload command.
#
#   ledger/build-app.sh [--patch-only] [--load] [delegate-address]
#   ledger/build-app.sh --delete
#
#   delegate-address  defaults to app/src/generated/delegate.json .address
#   --patch-only      clone + patch the whitelist and show the diff; no build (no docker needed)
#   --load            after building, sideload with python3 -m ledgerblue.loadApp on this host
#   --delete          delete the sideloaded "Covenant 7702" app from the device
#
# Why a separate APPNAME is safe: nothing in the app's own logic branches on APPNAME (it is only
# used by clone_main, compiled for CHAIN != ethereum). Other apps (Exchange/swap, clones,
# plugin installs) look the Ethereum app up by the name "Ethereum" and keep using the official
# one. The sideloaded app is not signed by Ledger, so the device warns that it is not genuine.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD_DIR="$ROOT/ledger/build"
APP_DIR="$BUILD_DIR/app-ethereum"
REPO="https://github.com/LedgerHQ/app-ethereum.git"
TAG="1.23.0"
IMAGE="${LEDGER_BUILDER_IMAGE:-ghcr.io/ledgerhq/ledger-app-builder/ledger-app-builder-lite:latest}"
APPNAME="Covenant 7702"
NANOSP_TARGET_ID="0x33100004"
WHITELIST="src/features/sign_authorization_eip7702/whitelist_7702.c"

die() {
  echo "error: $*" >&2
  exit 1
}

PATCH_ONLY=0
LOAD=0
DELETE=0
ADDRESS=""
for arg in "$@"; do
  case "$arg" in
    --patch-only) PATCH_ONLY=1 ;;
    --load) LOAD=1 ;;
    --delete) DELETE=1 ;;
    -h | --help)
      sed -n '2,17p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    -*) die "unknown option $arg" ;;
    *)
      [[ -z "$ADDRESS" ]] || die "more than one address given"
      ADDRESS="$arg"
      ;;
  esac
done

require_ledgerblue() {
  python3 -c 'import ledgerblue' 2>/dev/null ||
    die "python3 -m ledgerblue is not importable; install it with: python3 -m pip install ledgerblue"
}

if [[ "$DELETE" == 1 ]]; then
  require_ledgerblue
  echo "Deleting \"$APPNAME\" from the Nano S Plus (confirm on the device) ..."
  python3 -m ledgerblue.deleteApp --targetId "$NANOSP_TARGET_ID" --appName "$APPNAME"
  exit 0
fi

if [[ -z "$ADDRESS" ]]; then
  ADDRESS="$(python3 -c 'import json, sys; print(json.load(open(sys.argv[1]))["address"])' "$ROOT/app/src/generated/delegate.json")"
fi
[[ "$ADDRESS" =~ ^0x[0-9a-fA-F]{40}$ ]] || die "invalid delegate address: $ADDRESS"
echo "Covenant delegate: $ADDRESS (chain id 1)"

if [[ "$PATCH_ONLY" == 0 ]]; then
  command -v docker >/dev/null 2>&1 ||
    die "docker is not installed (needed for the Ledger app builder image $IMAGE); install Docker Desktop, or use --patch-only to only patch the source"
  docker info >/dev/null 2>&1 || die "docker is installed but not running; start Docker Desktop"
fi

# ---------------------------------------------------------------- clone (clean every run)
rm -rf "$APP_DIR"
mkdir -p "$BUILD_DIR"
git -c advice.detachedHead=false clone --quiet --depth 1 --branch "$TAG" "$REPO" "$APP_DIR"
# Only the plugin SDK submodule is needed for the build.
git -C "$APP_DIR" submodule --quiet update --init --depth 1 ethereum-plugin-sdk

# ---------------------------------------------------------------- patch the 7702 whitelist
python3 - "$APP_DIR/$WHITELIST" "$ADDRESS" <<'PY'
import re, sys

path, address = sys.argv[1], sys.argv[2]
src = open(path).read()

# Last line of the Simple7702Account entry (0x4Cd241E8d1510e30b2076397afc7508Ae59C66c9).
anchor = "0x63, 0x97, 0xaf, 0xc7, 0x50, 0x8A, 0xe5, 0x9C, 0x66, 0xc9}},\n"
if '.name = "Simple7702Account"' not in src or src.count(anchor) != 1:
    sys.exit(f"error: anchor (end of the Simple7702Account entry) not found exactly once in {path}; the upstream whitelist changed, patch it by hand")
if src.index(anchor) < src.index('.name = "Simple7702Account"'):
    sys.exit("error: anchor is not the Simple7702Account entry")

raw = bytes.fromhex(address[2:])
if ", ".join(f"0x{b:02x}" for b in raw[:10]).lower() in src.lower():
    sys.exit(f"error: {address} already looks whitelisted in {path}")
fmt = lambda bs: ", ".join(f"0x{b:02x}" for b in bs)
entry = (
    f"    // Covenant EIP-7702 delegate {address}, Ethereum mainnet only\n"
    "    // (added by covenant/ledger/build-app.sh)\n"
    "    {.chain_id = 1,\n"
    '     .name = "Covenant",\n'
    f"     .address = {{{fmt(raw[:10])},\n"
    f"                 {fmt(raw[10:])}}}}},\n"
)
patched = src.replace(anchor, anchor + entry)

count = lambda s: len(re.findall(r"\.chain_id\s*=", s))
if count(patched) != count(src) + 1 or patched.count('.name = "Covenant"') != 1:
    sys.exit("error: the whitelist entry count did not grow by one")
open(path, "w").write(patched)
PY

echo
echo "== whitelist change (review it) =="
git -C "$APP_DIR" --no-pager diff -- "$WHITELIST"
echo

if [[ "$PATCH_ONLY" == 1 ]]; then
  echo "Patched source in $APP_DIR (--patch-only: not built)."
  exit 0
fi

# ---------------------------------------------------------------- build in the builder image
# Prints APP_LOAD_PARAMS one argument per line, evaluated by the shell (the SDK computes
# --dataSize / --installparamsSize from debug/app.map inside the value), quotes preserved.
cat >"$APP_DIR/covenant-print.mk" <<'MK'
covenant-print-load-params:
	@for a in $(APP_LOAD_PARAMS); do printf '%s\n' "$$a"; done
MK

MAKE_ARGS="BOLOS_SDK=\$NANOSP_SDK 'APPNAME=\"$APPNAME\"'"
echo "Building for Nano S Plus in $IMAGE (APPNAME=\"$APPNAME\") ..."
# As the host user (Ledger's recommended invocation), so ledger/build/ stays removable.
docker run --rm --user "$(id -u):$(id -g)" -e HOME=/tmp -v "$APP_DIR:/app" -w /app "$IMAGE" sh -c "
  set -e
  git config --global --add safe.directory /app
  make -j \$(nproc) $MAKE_ARGS
  make --no-print-directory -f Makefile -f covenant-print.mk covenant-print-load-params $MAKE_ARGS > bin/load-params.txt
"

[[ -f "$APP_DIR/bin/app.hex" ]] || die "build did not produce bin/app.hex"
LOAD_ARGS=()
while IFS= read -r line; do LOAD_ARGS+=("$line"); done <"$APP_DIR/bin/load-params.txt"
[[ "${#LOAD_ARGS[@]}" -gt 0 ]] || die "could not extract APP_LOAD_PARAMS"
printf '%s\n' "${LOAD_ARGS[@]}" | grep -qx -- "$NANOSP_TARGET_ID" || die "APP_LOAD_PARAMS is not for the Nano S Plus ($NANOSP_TARGET_ID)"

echo
echo "Built $APP_DIR/bin/app.hex"
[[ -f "$APP_DIR/bin/app.sha256" ]] && echo "app hash: $(cat "$APP_DIR/bin/app.sha256")"
echo
echo "Sideload (Nano S Plus unlocked, on the dashboard; needs python3 -m pip install ledgerblue):"
printf '  cd %q && python3 -m ledgerblue.loadApp' "$APP_DIR"
printf ' %q' "${LOAD_ARGS[@]}"
echo
echo "Then open \"$APPNAME\" on the device, Settings -> enable \"EIP-7702\" and \"Blind signing\"."

if [[ "$LOAD" == 1 ]]; then
  require_ledgerblue
  echo
  echo "Loading (confirm on the device) ..."
  (cd "$APP_DIR" && python3 -m ledgerblue.loadApp "${LOAD_ARGS[@]}")
fi
