#!/usr/bin/env bash
#
# gadget-setup.sh - bring up the emulated OnlyKey as a REAL USB device.
#
#   sudo ./scripts/gadget-setup.sh          # create and bind
#   sudo ./scripts/gadget-setup.sh --down   # tear down
#
# Why this exists
# ---------------
# UHID devices have no USB parent, so hidapi cannot report `manufacturer` or
# `interface` and returns '' and -1. Real software identifies an OnlyKey by
# exactly those fields:
#
#     d.manufacturer === 'CRYPTOTRUST' && d.product === 'ONLYKEY' && d.interface === 3
#
# Nothing under onlykey/ may be modified to accommodate the emulator, so the
# emulator has to supply them for real. dummy_hcd provides a virtual UDC; the
# gadget bound to it enumerates through the kernel's USB stack as a genuine
# device, descriptors and all.
#
# Root is needed once, here. Afterwards the daemon runs unprivileged: the UDC
# file (bind/unbind = plug/unplug) is chowned to the invoking user and the
# /dev/hidg* nodes are handed over by udev.
#
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GADGET=/sys/kernel/config/usb_gadget/onlykey
KREL="$(uname -r)"
KO="$REPO/build/dummy_hcd/dummy_hcd.ko"
RULE=/etc/udev/rules.d/71-onlykey-gadget.rules
TARGET_USER="${SUDO_USER:-root}"

[[ $EUID -eq 0 ]] || { echo "needs root:  sudo $0 $*" >&2; exit 1; }

# node is usually installed per-user (nvm/fnm/volta), so root's PATH does not
# have it. Resolve it through the invoking user's login shell.
# Honour an explicit NODE_BIN=... in the environment first (sudo passes
# VAR=value assignments through), then root's PATH, then the invoking user's
# login shell - which is where nvm/fnm put it.
NODE_BIN="${NODE_BIN:-}"
[[ -n $NODE_BIN ]] || NODE_BIN="$(command -v node 2>/dev/null || true)"
if [[ -z $NODE_BIN && $TARGET_USER != root ]]; then
  NODE_BIN="$(su - "$TARGET_USER" -c 'command -v node' 2>/dev/null || true)"
fi

teardown() {
  [[ -d $GADGET ]] || return 0
  echo "==> Tearing down existing gadget"
  echo "" > "$GADGET/UDC" 2>/dev/null || true
  for l in "$GADGET"/configs/c.1/hid.usb*; do [[ -L $l ]] && rm -f "$l"; done
  rmdir "$GADGET"/configs/c.1/strings/0x409 2>/dev/null || true
  rmdir "$GADGET"/configs/c.1 2>/dev/null || true
  for f in "$GADGET"/functions/hid.usb*; do [[ -d $f ]] && rmdir "$f"; done
  rmdir "$GADGET"/strings/0x409 2>/dev/null || true
  rmdir "$GADGET" 2>/dev/null || true
}

if [[ ${1:-} == --down ]]; then teardown; echo "down."; exit 0; fi

# ---------------------------------------------------------------- modules
if [[ ! -f $KO ]]; then
  echo "ERROR: $KO not found. Build it first (no root needed):" >&2
  echo "       ./scripts/build-dummy-hcd.sh" >&2
  exit 1
fi

echo "==> Installing dummy_hcd into /lib/modules/$KREL/updates"
install -D -m 0644 "$KO" "/lib/modules/$KREL/updates/dummy_hcd.ko"
depmod -a

echo "==> Loading modules"
modprobe libcomposite
modprobe usb_f_hid 2>/dev/null || true
modprobe dummy_hcd 2>/dev/null || insmod "/lib/modules/$KREL/updates/dummy_hcd.ko"
printf 'libcomposite\ndummy_hcd\n' > /etc/modules-load.d/onlykey-gadget.conf

mountpoint -q /sys/kernel/config || mount -t configfs none /sys/kernel/config

UDC="$(ls /sys/class/udc 2>/dev/null | head -1 || true)"
if [[ -z $UDC ]]; then
  echo "ERROR: no UDC appeared under /sys/class/udc after loading dummy_hcd." >&2
  dmesg | tail -20 >&2
  exit 1
fi
echo "    UDC available: $UDC"

if [[ -z $NODE_BIN ]]; then
  echo "ERROR: node not found (root PATH has none, and none via $TARGET_USER's login shell)." >&2
  echo "       Re-run with an explicit path, e.g.  sudo NODE_BIN=\$(command -v node) $0" >&2
  exit 1
fi
echo "    node: $NODE_BIN"

# ------------------------------------------------------------- descriptors
DESCDIR="$(mktemp -d)"
trap 'rm -rf "$DESCDIR"' EXIT
"$NODE_BIN" -e '
const fs = require("fs");
const { INTERFACES } = require(process.argv[1] + "/emulator/lib/hid-descriptors");
const out = process.argv[2];
INTERFACES.forEach((s, i) => {
  fs.writeFileSync(`${out}/hid${i}.bin`, s.desc);
  fs.writeFileSync(`${out}/hid${i}.meta`,
    `${s.protocol} ${s.subclass} ${s.inSize} ${s.name}\n`);
});
' "$REPO" "$DESCDIR"

# ------------------------------------------------------------------ gadget
teardown
echo "==> Creating gadget at $GADGET"
mkdir -p "$GADGET"
cd "$GADGET"

IDS="$("$NODE_BIN" -e '
const d = require(process.argv[1] + "/emulator/lib/hid-descriptors");
console.log(`${d.VENDOR_ID} ${d.PRODUCT_ID}`);
' "$REPO")"
read -r VID PID <<< "$IDS"
printf '0x%04x\n' "$VID" > idVendor
printf '0x%04x\n' "$PID" > idProduct

echo 0x0200 > bcdUSB
echo 0x0100 > bcdDevice

mkdir -p strings/0x409
"$NODE_BIN" -e '
const d = require(process.argv[1] + "/emulator/lib/hid-descriptors");
const fs = require("fs");
fs.writeFileSync("strings/0x409/manufacturer", d.MANUFACTURER);
fs.writeFileSync("strings/0x409/product", d.PRODUCT_NAME);
fs.writeFileSync("strings/0x409/serialnumber", d.SERIAL_NUMBER);
' "$REPO"

mkdir -p configs/c.1/strings/0x409
echo "OnlyKey" > configs/c.1/strings/0x409/configuration
echo 500 > configs/c.1/MaxPower

for i in 0 1 2 3; do
  read -r proto subcl rlen nm < "$DESCDIR/hid$i.meta"
  echo "    function hid.usb$i  ($nm: protocol=$proto subclass=$subcl report_length=$rlen)"
  mkdir -p "functions/hid.usb$i"
  echo "$proto"  > "functions/hid.usb$i/protocol"
  echo "$subcl"  > "functions/hid.usb$i/subclass"
  echo "$rlen"   > "functions/hid.usb$i/report_length"
  cat "$DESCDIR/hid$i.bin" > "functions/hid.usb$i/report_desc"
  ln -s "functions/hid.usb$i" "configs/c.1/hid.usb$i"
done

echo "==> Binding to $UDC"
echo "$UDC" > UDC
sleep 1

# ------------------------------------------------------------- permissions
# The UDC file is plug/unplug: writing the controller name attaches the device,
# writing an empty string detaches it. Handing it to the invoking user is what
# keeps the daemon unprivileged.
chown "$TARGET_USER" "$GADGET/UDC" 2>/dev/null || true

cat > "$RULE" <<'EOF'
# OnlyKey emulator - USB gadget HID endpoints.
# /dev/hidgN is the gadget side of each HID interface: the emulator writes
# device->host reports to it and reads host->device reports from it.
# TAG+="uaccess" grants it to whoever is logged in at the local seat; the
# group fallback covers headless/CI machines with no seat.
KERNEL=="hidg[0-9]*", TAG+="uaccess", GROUP="plugdev", MODE="0660"
EOF
udevadm control --reload-rules
udevadm trigger --subsystem-match=hidg 2>/dev/null || true
udevadm settle --timeout=5 || true
for n in /dev/hidg*; do [[ -e $n ]] && chown "$TARGET_USER" "$n" 2>/dev/null || true; done

# ------------------------------------------------------------- diagnostics
echo
echo "================= RESULT ================="
echo "--- /sys/class/udc ---";      ls /sys/class/udc
echo "--- gadget endpoints ---";    ls -l /dev/hidg* 2>&1 || echo "NO /dev/hidg* !"
echo "--- lsusb ---";               lsusb -d 1d50:60fc 2>&1 || true
echo "--- as hidapi sees it ---"
sudo -u "$TARGET_USER" "$NODE_BIN" -e '
try {
  const hid = require(process.argv[1] + "/onlykey/onlykey-testing/node_modules/node-hid");
  const all = hid.devices().filter(d => d.vendorId === 0x1d50 && d.productId === 0x60fc);
  if (!all.length) { console.log("  (no 1d50:60fc devices enumerated)"); }
  for (const d of all) {
    console.log(`  iface=${d.interface} usagePage=0x${(d.usagePage||0).toString(16)} ` +
                `manufacturer=${JSON.stringify(d.manufacturer)} product=${JSON.stringify(d.product)} ${d.path}`);
  }
} catch (e) { console.log("  node-hid check skipped:", e.message); }
' "$REPO" 2>&1
echo "=========================================="
