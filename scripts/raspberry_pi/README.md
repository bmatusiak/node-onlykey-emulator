Raspberry Pi: the emulator as a real USB device
==============================================

Everything in this folder exists for one purpose: making the emulated OnlyKey
appear on a **physical USB port**, so a *separate* machine — a Windows box, say
— enumerates it as a genuine OnlyKey and can be used to test the firmware.

That is a different goal from the one the rest of the repo is set up for, and
the two do not mix. Use one path per machine.

| | `scripts/` (the default) | `scripts/raspberry_pi/` (this) |
|---|---|---|
| Controller | `dummy_hcd`, virtual | `dwc2`, the Pi's real one |
| Who can see the device | only the machine running it | any host you plug into |
| Needs a compiled kernel module | yes | no |
| Needs kernel headers + `linux-source` | yes | no |

Nothing here modifies anything in `scripts/`. The dummy_hcd path still works
exactly as before, on this machine or any other.

Prerequisites
-------------

**1. Put the USB-C port into device mode.** Add to `/boot/firmware/config.txt`,
under `[all]`:

```
dtoverlay=dwc2,dr_mode=peripheral
```

then reboot. Watch out for the `otg_mode=1` and `dtoverlay=dwc2,dr_mode=host`
lines already in that file — they sit under `[cm4]` and `[cm5]` filters, which
match Compute Modules, **not** a Pi 4 Model B. On a 4B they are inert, so the
line above has to be added rather than edited.

Confirm afterwards:

```sh
ls /sys/class/udc        # expect: fe980000.usb
```

An empty result means the overlay did not take, and no gadget is possible.

**2. Power the Pi from the GPIO pins.** On a Pi 4B the USB-C port is *both* the
power input and the only device-mode port. Once it is the data link to the
host, the Pi is drawing from a PC port that supplies 500–900 mA against the
3 A a Pi 4 can want — it will brown out mid-test.

Feed 5 V into GPIO pins 4 and 6 instead and leave USB-C for data only. Note
that GPIO power bypasses the board's input polyfuse and protection, so the
supply needs to be well regulated.

**3. Use a data-capable USB-C cable.** Plenty are charge-only and will silently
give you nothing.

Setup
-----

```sh
./scripts/raspberry_pi/setup-permissions.sh    # as yourself, no sudo
pm2 start ecosystem.config.js
```

The first command loads `uhid`, installs the udev rules, lowers
`vm.mmap_min_addr`, then hands off to `gadget-setup.sh` here, which builds the
gadget on the real UDC and installs a systemd unit to rebuild it at boot —
configfs is volatile and does not survive a reboot.

To rebuild or tear the gadget down on its own:

```sh
sudo ./scripts/raspberry_pi/gadget-setup.sh
sudo ./scripts/raspberry_pi/gadget-setup.sh --down
```

Driving it without the GUI
--------------------------

NW.js is not needed. `emulator/bin/press.js` is a headless replacement for the
GUI's buttons:

```sh
./emulator/bin/press.js 1          # tap button 1
./emulator/bin/press.js 1 2 3 4    # a PIN, sent in one write
./emulator/bin/press.js 3:long     # tap | hold | long | longest
./emulator/bin/press.js --watch    # stream LED and debug output
```

Only one of `press.js` and the GUI can run at a time — the socket topology is
inverted from the obvious one, and whoever listens owns the device. See the
comments at the top of that file.

What the host should see
------------------------

`ONLYKEY` by `CRYPTOTRUST`, with four HID interfaces. Real software identifies
an OnlyKey by `manufacturer === 'CRYPTOTRUST' && product === 'ONLYKEY' &&
interface === 3`, which is why `gadget-setup.sh` generates the descriptors from
`emulator/lib/hid-descriptors.js` rather than hard-coding them.

That also matters per interface: the keyboard is a boot device (`protocol 1,
subclass 1`, 8-byte reports) while the other three are 64-byte raw HID, and
SEREMU's OUT size is 32. The older `scripts/emulate-onlykey-hid.sh` sets all
four to `protocol 0, subclass 0, report_length 64`, and creates its gadget at
`usb_gadget/my_gadget1` rather than the `usb_gadget/onlykey` that
`emulator/lib/gadget-bridge.js` looks for. Do not use it for this.

Troubleshooting
---------------

`cat /sys/class/udc/fe980000.usb/state` reports the port. `not attached` means
no host cable. Note that `configured` can also show up with only a power supply
attached, because dwc2 sees VBUS — so it is not on its own proof that a host
enumerated anything. The Windows Device Manager is the real test.
