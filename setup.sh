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
    # Neither fetcher is guaranteed present - this box has wget but no curl.
    if command -v curl >/dev/null 2>&1; then
      curl -fsSL "$AGE_URL" | tar -xz -C "$tmp"
    elif command -v wget >/dev/null 2>&1; then
      wget -qO- "$AGE_URL" | tar -xz -C "$tmp"
    else
      echo "!! neither curl nor wget found - install one, or drop age and" >&2
      echo "   age-keygen into onlykey/okpqc-venv/bin by hand." >&2
      rm -rf "$tmp"; exit 1
    fi
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
if command -v docker >/dev/null 2>&1; then
  echo "== building the firmware toolchain image"
  make -C ./arduino-1.6.5-r5-teensy_127 docker-build-toolchain
else
  echo "!! docker not found - skipping the firmware toolchain image."
  echo "   The emulator still builds; you just cannot produce a device .hex."
fi

# --- node -------------------------------------------------------------------
#
# The emulator has its own dependencies and a native addon. The root package has
# neither dependencies nor workspaces, so installing there does not reach it.
echo "== building the emulator addon"
cd "$ROOT/emulator"
npm install
npm run build

echo "== installing the GUI"
cd "$ROOT/ui"
npm install

cd "$ROOT"
npm install

echo
echo "Setup complete. Start the emulator with pm2 - see README's Running section."
