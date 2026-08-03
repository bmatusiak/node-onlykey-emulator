#!/usr/bin/env bash
#
# setup-permissions.sh - one-time privileged setup for the OnlyKey emulator.
#
# Run this ONCE with sudo. Afterwards the emulator, pm2 and the GUI all run as
# your normal user - nothing in the day-to-day workflow needs root.
#
#   sudo ./scripts/setup-permissions.sh
#
# What it does and why:
#
#   1. Loads the `uhid` kernel module, and makes that persist across reboots.
#      UHID is how the emulator presents itself to the OS as a real USB HID
#      device, so browsers and python-onlykey can talk to it.
#
#   2. Installs a udev rule giving your login session access to /dev/uhid,
#      which is root-only by default (crw------- root root). The rule uses
#      TAG+="uaccess", so the kernel hands access to whoever is logged in at
#      the seat - no group juggling, and it drops again when you log out.
#      A group fallback is included for headless/CI machines with no seat.
#
#   3. Lowers vm.mmap_min_addr to 4096 (one page).
#
#      The emulator maps the emulated flash at its real MK20DX256 addresses,
#      and the firmware's own key material sits low: certified_hw is
#      enckeysectoradr+432 = 0x5BB0, and okcrypto_split_sundae() dereferences
#      it on EVERY AES-GCM operation. With the default 65536 that address is
#      unmappable, so the device segfaults as soon as it encrypts anything -
#      storing a PIN, for instance.
#
#      4096, not 0: page zero stays unmapped, so a genuine NULL dereference
#      still faults. That is the mitigation this sysctl exists for, and it is
#      preserved. Setting it to 0 would not be.
#
set -euo pipefail

RULE_FILE=/etc/udev/rules.d/70-onlykey-emulator.rules
MODULE_FILE=/etc/modules-load.d/onlykey-emulator.conf
GROUP=plugdev

#
# Run this as YOURSELF, not under sudo:
#
#     ./scripts/setup-permissions.sh
#
# It elevates the individual steps that need root and leaves everything else
# unprivileged. That ordering matters: dummy_hcd is compiled here, and building
# under sudo would leave root-owned objects in build/ that you then need root to
# clean up - and, more importantly, runs a Makefile as root for no reason.
#
if [[ $EUID -eq 0 ]]; then
  TARGET_USER="${SUDO_USER:-root}"
  if [[ "$TARGET_USER" == "root" ]]; then
    echo "warning: running as root with no SUDO_USER." >&2
    echo "         Prefer:  ./scripts/setup-permissions.sh   (no sudo - it elevates itself)" >&2
  fi
  SUDO=""
else
  TARGET_USER="$USER"
  SUDO="sudo"
  # Prompt once up front rather than at each step, so the run does not stall
  # halfway through waiting for a password.
  echo "==> This needs root for a few steps; authenticating once now"
  sudo -v || { echo "    cannot elevate - aborting" >&2; exit 1; }
fi

echo "==> Loading the uhid kernel module"
if $SUDO modprobe uhid 2>/dev/null; then
  echo "    uhid loaded"
else
  # Built into the kernel rather than a module on some distros - fine either way.
  if [[ -e /dev/uhid ]]; then
    echo "    /dev/uhid already present (uhid built into the kernel)"
  else
    echo "    ERROR: could not load uhid and /dev/uhid does not exist." >&2
    echo "           Your kernel may lack CONFIG_UHID." >&2
    exit 1
  fi
fi

echo "==> Making uhid load at boot ($MODULE_FILE)"
echo uhid | $SUDO tee "$MODULE_FILE" >/dev/null

echo "==> Installing udev rule ($RULE_FILE)"
SRC_RULE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/70-onlykey-emulator.rules"
if [[ ! -f "$SRC_RULE" ]]; then
  echo "    ERROR: rule file not found: $SRC_RULE" >&2
  exit 1
fi
$SUDO install -m 0644 "$SRC_RULE" "$RULE_FILE"
echo "    installed from $SRC_RULE"

if ! getent group "$GROUP" >/dev/null; then
  echo "==> Creating group $GROUP"
  $SUDO groupadd "$GROUP"
fi

if [[ -n "$TARGET_USER" && "$TARGET_USER" != "root" ]]; then
  if id -nG "$TARGET_USER" | tr ' ' '\n' | grep -qx "$GROUP"; then
    echo "==> $TARGET_USER is already in $GROUP"
  else
    echo "==> Adding $TARGET_USER to $GROUP"
    $SUDO usermod -aG "$GROUP" "$TARGET_USER"
    NEED_RELOGIN=1
  fi
fi

echo "==> Lowering vm.mmap_min_addr to 4096 (page zero stays protected)"
$SUDO sysctl -w vm.mmap_min_addr=4096 >/dev/null
$SUDO tee /etc/sysctl.d/70-onlykey-emulator.conf >/dev/null <<'EOF'
# The OnlyKey emulator maps the emulated MK20DX256 flash at its real
# addresses; the firmware's key material lives at 0x5BB0 and is read by every
# AES-GCM operation. One page, so NULL dereferences still fault.
vm.mmap_min_addr = 4096
EOF
echo "    now: $(sysctl -n vm.mmap_min_addr)"

echo "==> Reloading udev rules"
$SUDO udevadm control --reload-rules
$SUDO udevadm trigger --subsystem-match=misc --sysname-match=uhid || true
# Re-apply to any hidraw nodes the emulator has already created, so a running
# emulator picks up the new permissions without being restarted.
$SUDO udevadm trigger --subsystem-match=hidraw || true
$SUDO udevadm settle --timeout=5 || true

# ---------------------------------------------------------------------------
# The USB gadget transport (default).
#
# UHID alone is not enough to stand in for hardware: a UHID device has no USB
# parent, so hidapi reports manufacturer '' and interface -1, and real software
# identifies an OnlyKey by exactly those fields. dummy_hcd gives us a virtual
# UDC so the gadget enumerates as a genuine USB device with real descriptors.
#
# Delegated to gadget-setup.sh rather than duplicated. Failure is not fatal:
# the UHID bridge (OKEMU_BRIDGE=uhid) still works without it.
# ---------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
KO="$SCRIPT_DIR/../build/dummy_hcd/dummy_hcd.ko"

echo
echo "==> USB gadget transport"

# Build the module if it is missing, so this stays the single setup command.
# Built as the invoking user, not root: the output lands in the repo's build/
# directory and root-owned artifacts there would need sudo to clean up later.
if [[ ! -f $KO ]]; then
  if [[ ! -d /lib/modules/$(uname -r)/build || ! -f /usr/src/linux-source-$(uname -r | cut -d- -f1).tar.bz2 ]]; then
    echo "    Kernel headers and/or source are missing. Install them, then re-run:"
    echo "      sudo apt install linux-headers-\$(uname -r) linux-source-\$(uname -r | cut -d- -f1)"
    echo "    Skipping the gadget; the UHID transport (OKEMU_BRIDGE=uhid) still works."
  else
    echo "    dummy_hcd.ko not built yet - building it now (unprivileged)"
    "$SCRIPT_DIR/build-dummy-hcd.sh" || true
  fi
fi

if [[ -f $KO ]]; then
  # Pass NODE_BIN through: gadget-setup.sh reads the HID descriptors with node,
  # which is usually a per-user nvm install and so absent from root's PATH.
  # node is typically an nvm install, so absent from root's PATH - resolve it
  # here, while still unprivileged, and hand the path across.
  GADGET_NODE="$(command -v node 2>/dev/null || true)"
  $SUDO env NODE_BIN="$GADGET_NODE" SUDO_USER="$TARGET_USER" \
    "$SCRIPT_DIR/gadget-setup.sh" \
    || echo "    gadget setup failed - the UHID transport is still available"
else
  echo "    not set up; the UHID transport (OKEMU_BRIDGE=uhid) still works."
fi

echo
echo "Done. /dev/uhid is now:"
ls -l /dev/uhid || true
echo
if [[ "${NEED_RELOGIN:-0}" == "1" ]]; then
  echo "NOTE: group membership only takes effect on a new login session."
  echo "      Log out and back in (or run 'newgrp $GROUP') before starting pm2."
  echo
fi
echo "Next:"
echo "  cd emulator && npm install && npm run rebuild"
echo "  pm2 start ecosystem.config.js"
