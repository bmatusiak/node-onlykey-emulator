#!/usr/bin/env bash
#
# Materialises the workspace: the component checkouts under onlykey/, the Python
# venv generated from them, and the built emulator addon.
#
# onlykey/ is a swap slot, not a dependency tree - see README's "Why onlykey/ is
# not committed here". Nothing here pins a revision: every clone tracks its
# default branch, so a component can be swapped for a different fork or revision
# without touching this repo.
#
# Safe to re-run: existing checkouts are left alone rather than re-cloned.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

AGE_VERSION="v1.2.1"

# Downloads $1 to stdout with whichever fetcher this machine has. Neither is
# guaranteed - a stock Ubuntu server has wget and no curl, and a minimal
# container often has curl and no wget.
FETCHER=""
if command -v curl >/dev/null 2>&1; then
  FETCHER="curl"
elif command -v wget >/dev/null 2>&1; then
  FETCHER="wget"
fi

fetch() {
  case "$FETCHER" in
    curl) curl -fsSL "$1" ;;
    wget) wget -qO- "$1" ;;
    *)    echo "!! no downloader available" >&2; return 1 ;;
  esac
}

# Check everything up front. Failing on the first missing tool beats discovering
# it after seven clones and a venv build.
missing=()
for tool in git python3 make tar install npm node; do
  command -v "$tool" >/dev/null 2>&1 || missing+=("$tool")
done
[ -n "$FETCHER" ] || missing+=("curl or wget")

if [ ${#missing[@]} -gt 0 ]; then
  echo "!! missing required tools: ${missing[*]}" >&2
  echo "   Docker is optional and only gates the device .hex build." >&2
  exit 1
fi

echo "== using $FETCHER for downloads"

# Clone into $2 only if it is not already there, so re-running is a no-op.
clone() {
  if [ -d "$2/.git" ]; then
    echo "== $2 already present, skipping"
  else
    echo "== cloning $2"
    git clone "$1" "$2"
  fi
}

mkdir -p "$ROOT/onlykey"
cd "$ROOT/onlykey"

# --- component checkouts ----------------------------------------------------
clone https://github.com/bm-ok/arduino-1.6.5-r5-teensy_127 ./arduino-1.6.5-r5-teensy_127
clone https://github.com/bm-ok/0c-coder-libraries          ./libraries
clone https://github.com/bm-ok/OnlyKey-Firmware            ./OnlyKey-Firmware
clone https://github.com/bm-ok/0c-coder-onlykey.github.io  ./onlykey.github.io
clone https://github.com/bm-ok/0c-coder-lib-agent          ./lib-agent
clone https://github.com/bm-ok/0c-coder-python-onlykey     ./python-onlykey
clone https://github.com/bm-ok/onlykey-alpha-testing       ./onlykey-testing

git -C ./python-onlykey submodule update --init onlykey-solo-python

# --- Python venv ------------------------------------------------------------
#
# Generated from the checkouts above, which is why it is not committed.
# onlykey-testing's lib/config.js resolves its tools through ./okpqc-venv/bin
# (VENV_BIN), so all of these have to land here or tests fail in ways that look
# like device faults rather than a missing tool.
echo "== provisioning okpqc-venv"
[ -d ./okpqc-venv ] || python3 -m venv ./okpqc-venv
./okpqc-venv/bin/pip install --upgrade pip

#   onlykey        -> onlykey-cli, age-plugin-onlykey
#   lib-agent      -> the agent framework
#   onlykey-agent  -> onlykey-agent, onlykey-gpg
./okpqc-venv/bin/pip install -e "./python-onlykey[age]"
./okpqc-venv/bin/pip install -e ./lib-agent -e ./lib-agent/agents/onlykey

# age and age-keygen are upstream Go binaries. pip cannot supply them -
# python-onlykey's [age] extra is only cryptography + kyber-py - but test/05 and
# test/11 shell out to `age`, so fetch them into the same bin/ the tests search.
if [ ! -x ./okpqc-venv/bin/age ]; then
  case "$(uname -m)" in
    x86_64|amd64)  AGE_ARCH=amd64 ;;
    aarch64|arm64) AGE_ARCH=arm64 ;;
    *)             AGE_ARCH="" ;;
  esac
  if [ -n "$AGE_ARCH" ]; then
    echo "== fetching age $AGE_VERSION ($AGE_ARCH)"
    AGE_URL="https://github.com/FiloSottile/age/releases/download/${AGE_VERSION}/age-${AGE_VERSION}-linux-${AGE_ARCH}.tar.gz"
    tmp="$(mktemp -d)"
    fetch "$AGE_URL" | tar -xz -C "$tmp"
    install -m 0755 "$tmp/age/age" "$tmp/age/age-keygen" ./okpqc-venv/bin/
    rm -rf "$tmp"
  else
    echo "!! unknown arch $(uname -m) - install age/age-keygen into" >&2
    echo "   onlykey/okpqc-venv/bin by hand, or test/05 and test/11 will fail." >&2
  fi
fi

# --- device toolchain -------------------------------------------------------
#
# Only needed to build a .hex for real hardware, or to check that a firmware
# change still compiles for the device. The emulator itself does not use it.
#
# The image must be amd64 whatever the host is: the legacy Arduino/Teensyduino
# bundle ships pre-compiled x86_64 binaries, so a native arm64 build succeeds and
# then produces an image that cannot execute them. DOCKER_DEFAULT_PLATFORM is a
# no-op on x86_64 and routes through qemu-user-static's binfmt handler elsewhere
# - correct but slow. `make docker-build` needs the same variable set.
if ! command -v docker >/dev/null 2>&1; then
  echo "!! docker not found - skipping the firmware toolchain image."
  echo "   The emulator still builds; you just cannot produce a device .hex."
elif [ "$(uname -m)" != "x86_64" ] && [ ! -e /proc/sys/fs/binfmt_misc/qemu-x86_64 ]; then
  echo "!! no qemu-x86_64 binfmt handler - skipping the firmware toolchain image."
  echo "   Install qemu-user-static and binfmt-support, then re-run to build it."
  echo "   The emulator still builds; you just cannot produce a device .hex."
else
  echo "== building the firmware toolchain image (linux/amd64)"
  DOCKER_DEFAULT_PLATFORM=linux/amd64 \
    make -C ./arduino-1.6.5-r5-teensy_127 docker-build-toolchain
fi

# --- node -------------------------------------------------------------------
#
# The emulator has its own dependencies and a native addon. The root package has
# neither dependencies nor workspaces, so installing there does not reach it.
echo "== building the emulator addon"
cd "$ROOT/emulator"
# gypfile:true makes npm run `node-gyp rebuild` as an implicit install script.
# binding.gyp includes sources.gypi, which only `npm run stage` generates - and
# that runs later - so the implicit build always fails on a fresh checkout.
# Skip it, then drive the real build through rebuild (stage -> configure ->
# build); plain `build` would skip configure and find no Makefile.
npm install --ignore-scripts
npm run rebuild

echo "== installing the GUI"
cd "$ROOT/ui"
npm install

cd "$ROOT"
npm install

echo
echo "Setup complete. Start the emulator with pm2 - see README's Running section."
