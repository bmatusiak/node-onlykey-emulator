#!/usr/bin/env bash
#
# raspberry_pi/setup-permissions.sh - the one privileged setup command on a Pi.
#
#   ./scripts/raspberry_pi/setup-permissions.sh      # as yourself, no sudo
#
# Run it once. Afterwards the emulator and pm2 run as your normal user; nothing
# in the day-to-day workflow needs root.
#
# How this differs from ../setup-permissions.sh
# ---------------------------------------------
# The privileged steps are the same - uhid, the udev rule, plugdev, and the
# vm.mmap_min_addr sysctl the emulated flash needs. What differs is the last
# step: this delegates to raspberry_pi/gadget-setup.sh, which binds the Pi's
# real dwc2 controller, instead of building and loading dummy_hcd.
#
# So nothing here compiles a kernel module, and the kernel headers and
# linux-source packages the dummy_hcd path needs are not required.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$SCRIPT_DIR/../.." && pwd)"
RULE_FILE=/etc/udev/rules.d/70-onlykey-emulator.rules
MODULE_FILE=/etc/modules-load.d/onlykey-emulator.conf
GROUP=plugdev

if [[ $EUID -eq 0 ]]; then
  TARGET_USER="${SUDO_USER:-root}"
  if [[ "$TARGET_USER" == "root" ]]; then
    echo "warning: running as root with no SUDO_USER." >&2
    echo "         Prefer:  ./scripts/raspberry_pi/setup-permissions.sh   (no sudo)" >&2
  fi
  SUDO=""
else
  TARGET_USER="$USER"
  SUDO="sudo"
  # Probe non-interactively first. `sudo -v` refreshes the credential timestamp,
  # but on the passwordless sudoers that Raspberry Pi OS ships by default it
  # demands a password it will never actually need, and with no tty to read one
  # it aborts a run that would have succeeded at every individual step.
  if sudo -n true 2>/dev/null; then
    echo "==> Root available without a password"
  else
    echo "==> This needs root for a few steps; authenticating once now"
    sudo -v || { echo "    cannot elevate - aborting" >&2; exit 1; }
  fi
fi

# ------------------------------------------------------------------- uhid
#
# Kept even though the gadget is the default transport: OKEMU_BRIDGE=uhid is a
# working fallback that needs no USB controller at all, and costs nothing here.
echo "==> Loading the uhid kernel module"
if $SUDO modprobe uhid 2>/dev/null; then
  echo "    uhid loaded"
elif [[ -e /dev/uhid ]]; then
  echo "    /dev/uhid already present (uhid built into the kernel)"
else
  echo "    ERROR: could not load uhid and /dev/uhid does not exist." >&2
  echo "           Your kernel may lack CONFIG_UHID." >&2
  exit 1
fi

echo "==> Making uhid load at boot ($MODULE_FILE)"
echo uhid | $SUDO tee "$MODULE_FILE" >/dev/null

# ------------------------------------------------------------------- udev
# The rule file itself is shared with the dummy_hcd path - it grants /dev/uhid
# and the hidraw nodes, neither of which is Pi-specific.
echo "==> Installing udev rule ($RULE_FILE)"
SRC_RULE="$REPO/scripts/70-onlykey-emulator.rules"
[[ -f "$SRC_RULE" ]] || { echo "    ERROR: rule file not found: $SRC_RULE" >&2; exit 1; }
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

# ----------------------------------------------------------------- sysctl
#
# The emulator maps the emulated MK20DX256 flash at its real addresses, and the
# firmware's key material sits low: certified_hw is enckeysectoradr+432 =
# 0x5BB0, dereferenced by every AES-GCM operation. With the default 65536 that
# address is unmappable and the device segfaults as soon as it encrypts
# anything. 4096, not 0: page zero stays unmapped, so a genuine NULL
# dereference still faults.
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
$SUDO udevadm trigger --subsystem-match=hidraw || true
$SUDO udevadm settle --timeout=5 || true

# ----------------------------------------------------------------- gadget
#
# Delegated rather than duplicated. Failure is not fatal: the UHID bridge
# (OKEMU_BRIDGE=uhid) still works without a gadget, it just cannot be seen by
# another machine.
echo
echo "==> USB gadget transport (real UDC)"
# node is typically an nvm install and so absent from root's PATH - resolve it
# here, while still unprivileged, and hand the path across.
GADGET_NODE="$(command -v node 2>/dev/null || true)"
$SUDO env NODE_BIN="$GADGET_NODE" SUDO_USER="$TARGET_USER" \
  "$SCRIPT_DIR/gadget-setup.sh" \
  || echo "    gadget setup failed - the UHID transport is still available"

echo
if [[ "${NEED_RELOGIN:-0}" == "1" ]]; then
  echo "NOTE: group membership only takes effect on a new login session."
  echo "      Log out and back in (or run 'newgrp $GROUP') before starting pm2."
  echo
fi
echo "Next:"
echo "  pm2 start ecosystem.config.js"
echo "  ./emulator/bin/press.js 1        # drive the buttons without the GUI"
