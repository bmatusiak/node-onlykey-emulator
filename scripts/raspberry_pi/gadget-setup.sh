#!/usr/bin/env bash
#
# raspberry_pi/gadget-setup.sh - bring the gadget up on the Pi's REAL USB port.
#
#   sudo ./scripts/raspberry_pi/gadget-setup.sh          # create and bind
#   sudo ./scripts/raspberry_pi/gadget-setup.sh --down   # tear down
#
# How this differs from ../gadget-setup.sh
# ----------------------------------------
# The one in scripts/ binds to dummy_hcd, a VIRTUAL controller. That is a
# same-machine loopback: the emulated OnlyKey is visible to the machine running
# it and to nothing else. It is the right answer on a desktop, whose USB ports
# are host-only and which therefore has no device controller at all.
#
# A Pi has a real one (dwc2, on the USB-C port), so the gadget can enumerate on
# a physical cable and a SEPARATE host - a Windows box, say - sees a genuine
# OnlyKey. That is the entire reason this file exists.
#
# Nothing here touches dummy_hcd, and nothing in scripts/ is modified. The two
# paths are independent; pick one per machine.
#
# Prerequisite: /boot/firmware/config.txt needs
#
#     dtoverlay=dwc2,dr_mode=peripheral
#
# and a reboot, or there is no controller to bind to. See README.md here.
#
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT_SELF="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
GADGET=/sys/kernel/config/usb_gadget/onlykey
RULE=/etc/udev/rules.d/71-onlykey-gadget.rules
TARGET_USER="${SUDO_USER:-root}"

[[ $EUID -eq 0 ]] || { echo "needs root:  sudo $0 $*" >&2; exit 1; }

# node is usually a per-user install (nvm/fnm/volta), so root's PATH lacks it.
# Honour NODE_BIN=... first (sudo passes VAR=value through), then root's PATH,
# then the invoking user's login shell - which is where nvm puts it.
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
echo "==> Loading modules"
modprobe libcomposite
modprobe usb_f_hid 2>/dev/null || true
# dwc2 is built into the Raspberry Pi OS kernel rather than a module, so this
# is a no-op there; it is here for kernels that do ship it separately.
modprobe dwc2 2>/dev/null || true
printf 'libcomposite\n' > /etc/modules-load.d/onlykey-gadget.conf

mountpoint -q /sys/kernel/config || mount -t configfs none /sys/kernel/config

# dummy_udc.0 is dummy_hcd's controller (see emulator/lib/power.js) and is
# explicitly not what this script is for - refusing it keeps a machine that has
# both from silently getting the loopback when it asked for the real port.
UDC="${OKEMU_UDC:-$(ls /sys/class/udc 2>/dev/null | grep -v '^dummy_udc' | head -1 || true)}"
if [[ -z $UDC ]]; then
  echo "ERROR: no real USB device controller under /sys/class/udc." >&2
  echo >&2
  echo "       On a Raspberry Pi, add to /boot/firmware/config.txt:" >&2
  echo "           dtoverlay=dwc2,dr_mode=peripheral" >&2
  echo "       then reboot. Put it under [all] - the otg_mode and dwc2 lines" >&2
  echo "       shipped in that file sit under [cm4]/[cm5] filters and do not" >&2
  echo "       apply to a Pi 4 Model B." >&2
  echo >&2
  echo "       For same-machine loopback instead, use ../gadget-setup.sh," >&2
  echo "       which builds dummy_hcd's virtual controller." >&2
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
#
# Read from emulator/lib/hid-descriptors.js rather than written out here. That
# file is the single source of truth for the descriptors, the IDs and the
# per-interface protocol/subclass/report_length - and those are not uniform:
# the keyboard is a boot device (protocol 1, subclass 1, 8-byte reports) while
# the other three are 64-byte raw HID. Hand-copying them is how the older
# emulate-onlykey-hid.sh ended up wrong.
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
# 500mA is what a real OnlyKey asks for. The Pi cannot actually live on that
# through this port, which is why it wants GPIO power - see README.md.
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
KERNEL=="hidg[0-9]*", TAG+="uaccess", GROUP="plugdev", MODE="0660"
EOF
udevadm control --reload-rules
udevadm trigger --subsystem-match=hidg 2>/dev/null || true
udevadm settle --timeout=5 || true
for n in /dev/hidg*; do [[ -e $n ]] && chown "$TARGET_USER" "$n" 2>/dev/null || true; done

# --------------------------------------------------------------- at boot
#
# configfs is volatile: the whole gadget tree vanishes on reboot. Without this
# the device is simply absent after a restart until someone re-runs this by
# hand. Same unit name as the dummy_hcd path deliberately - a machine uses one
# or the other, never both, so they must not fight over the same gadget.
UNIT=/etc/systemd/system/onlykey-gadget.service
cat > "$UNIT" <<EOF
[Unit]
Description=OnlyKey emulator USB gadget (Raspberry Pi, real UDC)
# configfs must be mounted before the gadget can be built. The controller
# itself comes from the dwc2 overlay, which is up long before userspace.
After=systemd-modules-load.service sys-kernel-config.mount
Requires=sys-kernel-config.mount

[Service]
Type=oneshot
RemainAfterExit=yes
Environment=NODE_BIN=$NODE_BIN
ExecStart=$SCRIPT_SELF
ExecStop=$SCRIPT_SELF --down
User=root

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable onlykey-gadget.service >/dev/null 2>&1 \
  && echo "==> Installed $UNIT (gadget is rebuilt at boot)" \
  || echo "    could not enable onlykey-gadget.service - re-run this script after a reboot"

# ------------------------------------------------------------- diagnostics
echo
echo "================= RESULT ================="
echo "--- /sys/class/udc ---";   ls /sys/class/udc
echo "--- bound to ---";         cat "$GADGET/UDC"
echo "--- gadget endpoints ---"; ls -l /dev/hidg* 2>&1 || echo "NO /dev/hidg* !"
# 'not attached' here just means no host cable yet - the gadget is still built.
echo "--- port state ---";       cat "/sys/class/udc/$UDC/state" 2>/dev/null || true
echo "=========================================="
