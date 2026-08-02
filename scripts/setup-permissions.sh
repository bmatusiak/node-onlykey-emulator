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

if [[ $EUID -ne 0 ]]; then
  echo "This script needs root. Re-run with:  sudo $0" >&2
  exit 1
fi

# The user who invoked sudo - that is who should end up with access.
TARGET_USER="${SUDO_USER:-}"
if [[ -z "$TARGET_USER" || "$TARGET_USER" == "root" ]]; then
  echo "warning: could not determine the non-root user (SUDO_USER unset)." >&2
  echo "         Skipping group membership; the uaccess rule will still apply." >&2
fi

echo "==> Loading the uhid kernel module"
if modprobe uhid 2>/dev/null; then
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
echo "uhid" > "$MODULE_FILE"

echo "==> Installing udev rule ($RULE_FILE)"
SRC_RULE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/70-onlykey-emulator.rules"
if [[ ! -f "$SRC_RULE" ]]; then
  echo "    ERROR: rule file not found: $SRC_RULE" >&2
  exit 1
fi
install -m 0644 "$SRC_RULE" "$RULE_FILE"
echo "    installed from $SRC_RULE"

if ! getent group "$GROUP" >/dev/null; then
  echo "==> Creating group $GROUP"
  groupadd "$GROUP"
fi

if [[ -n "$TARGET_USER" && "$TARGET_USER" != "root" ]]; then
  if id -nG "$TARGET_USER" | tr ' ' '\n' | grep -qx "$GROUP"; then
    echo "==> $TARGET_USER is already in $GROUP"
  else
    echo "==> Adding $TARGET_USER to $GROUP"
    usermod -aG "$GROUP" "$TARGET_USER"
    NEED_RELOGIN=1
  fi
fi

echo "==> Lowering vm.mmap_min_addr to 4096 (page zero stays protected)"
sysctl -w vm.mmap_min_addr=4096 >/dev/null
cat > /etc/sysctl.d/70-onlykey-emulator.conf <<'EOF'
# The OnlyKey emulator maps the emulated MK20DX256 flash at its real
# addresses; the firmware's key material lives at 0x5BB0 and is read by every
# AES-GCM operation. One page, so NULL dereferences still fault.
vm.mmap_min_addr = 4096
EOF
echo "    now: $(sysctl -n vm.mmap_min_addr)"

echo "==> Reloading udev rules"
udevadm control --reload-rules
udevadm trigger --subsystem-match=misc --sysname-match=uhid || true
# Re-apply to any hidraw nodes the emulator has already created, so a running
# emulator picks up the new permissions without being restarted.
udevadm trigger --subsystem-match=hidraw || true
udevadm settle --timeout=5 || true

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
