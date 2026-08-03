#!/usr/bin/env bash
#
# build-dummy-hcd.sh - build the dummy_hcd kernel module out of tree.
#
# dummy_hcd is a virtual USB Device Controller: it provides both a virtual host
# controller and a UDC, so a gadget bound to it enumerates as a real USB device
# on this machine. That is what lets the emulator present genuine USB string
# and interface descriptors - `manufacturer: CRYPTOTRUST`, `interface: 0..3` -
# instead of the empty manufacturer and interface -1 that UHID is forced to
# report, having no USB parent for hidapi to read.
#
# It matters because the OnlyKey test kit and python-onlykey both identify the
# device the way real software does:
#
#     d.manufacturer === 'CRYPTOTRUST' && d.product === 'ONLYKEY' && d.interface === 3
#
# Under UHID that can never match, and nothing under onlykey/ may be modified to
# make it match - so the emulator has to supply the fields for real.
#
# Ubuntu ships `# CONFIG_USB_DUMMY_HCD is not set`, so no package provides it and
# it has to be compiled. Everything else the gadget needs (libcomposite,
# usb_f_hid, CONFIG_USB_CONFIGFS_F_HID) is already in the stock kernel.
#
# This script needs no root. Installing the result does - see
# setup-permissions.sh, which is where the one-time privileged setup lives.
#
set -euo pipefail

KREL="$(uname -r)"
SRC_TAR=/usr/src/linux-source-${KREL%%-*}.tar.bz2
BUILD_DIR="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/build/dummy_hcd}"

if [[ ! -d /lib/modules/$KREL/build ]]; then
  echo "ERROR: no kernel build tree for $KREL." >&2
  echo "       sudo apt install linux-headers-$KREL" >&2
  exit 1
fi

if [[ ! -f $SRC_TAR ]]; then
  echo "ERROR: kernel source not found: $SRC_TAR" >&2
  echo "       sudo apt install linux-source-${KREL%%-*}" >&2
  exit 1
fi

echo "==> Extracting dummy_hcd.c from $SRC_TAR"
mkdir -p "$BUILD_DIR"
# The tarball's single top-level directory is named after the package, e.g.
# linux-source-7.0.0/. Derived rather than read from `tar -tf | head -1`,
# which makes tar die of SIGPIPE and, under `set -o pipefail`, aborts here.
TOP="linux-source-${KREL%%-*}"
tar -xjf "$SRC_TAR" -O "$TOP/drivers/usb/gadget/udc/dummy_hcd.c" > "$BUILD_DIR/dummy_hcd.c"
if [[ ! -s $BUILD_DIR/dummy_hcd.c ]]; then
  echo "ERROR: could not extract $TOP/drivers/usb/gadget/udc/dummy_hcd.c" >&2
  exit 1
fi

printf 'obj-m += dummy_hcd.o\n' > "$BUILD_DIR/Makefile"

echo "==> Building against /lib/modules/$KREL/build"
make -C "/lib/modules/$KREL/build" M="$BUILD_DIR" modules

echo
echo "Built: $BUILD_DIR/dummy_hcd.ko"
echo "Install it with:  sudo ./scripts/setup-permissions.sh"
