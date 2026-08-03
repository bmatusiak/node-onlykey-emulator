node-onlykey-emulator
=====================

Runs the [OnlyKey firmware](onlykey/OnlyKey-Firmware) as a Node.js native addon,
so you can develop and test against an OnlyKey without the hardware. It is built
from the same sources the device is, with a **two-site** host adaptation behind
`#ifdef OK_EMULATOR` — the device toolchain never defines it, so the firmware
you flash is unaffected. The real Teensyduino core and OnlyKey's own libraries
are compiled as they ship; only the parts that touch silicon are replaced.

The emulator exposes the same four HID interfaces as a DEBUG-build device
(three in production), a NeoPixel LED, six buttons, and file-backed flash and
EEPROM that persist across restarts.

---

## Requirements

* Linux. The default transport is a **USB gadget** (`dummy_hcd` + `f_hid`), which
  needs kernel headers and matching kernel source to build one small module —
  see [Why a USB gadget](#why-a-usb-gadget). A UHID fallback needs neither.
* Node.js 18+ and a C++ toolchain (`build-essential`, `python3`)
* [pm2](https://pm2.keymetrics.io/) — supervises the emulator process
* The firmware sources and Teensyduino toolchain under `onlykey/` (see `setup.sh`)

### Why a USB gadget

Real software identifies an OnlyKey by fields that come from the USB
descriptor. The test kit does

```js
d.manufacturer === 'CRYPTOTRUST' && d.product === 'ONLYKEY' && d.interface === 3
```

and python-onlykey and `@vincss-public-projects/fido2-client` do the same.
A UHID device has no USB parent, so hidapi cannot supply `manufacturer` or
`interface` — it reports `''` and `-1`, always, and **no unmodified client can
match it**. Since nothing under `onlykey/` may be changed to accommodate the
emulator, the emulator has to present those fields for real.

`dummy_hcd` provides a virtual USB Device Controller; the gadget bound to it
enumerates through the kernel's own USB stack:

```
$ lsusb -d 1d50:60fc
Bus 005 Device 002: ID 1d50:60fc OpenMoko, Inc. OnlyKey Two-factor Authentication…

iface=0 usagePage=0x0001 manufacturer="CRYPTOTRUST" product="ONLYKEY"
iface=1 usagePage=0xf1d0 manufacturer="CRYPTOTRUST" product="ONLYKEY"
iface=2 usagePage=0xffab manufacturer="CRYPTOTRUST" product="ONLYKEY"
iface=3 usagePage=0xffc9 manufacturer="CRYPTOTRUST" product="ONLYKEY"
```

Set `OKEMU_BRIDGE=uhid` to use the old UHID transport instead. It needs no
kernel module and is fine for HID-plumbing work, but the unmodified test kit
cannot see it.

---

## One-time setup

### 1. Fetch sources and dependencies

```sh
./setup.sh
```

### 2. Grant device access (the one privileged step)

The gadget needs `dummy_hcd`, which Ubuntu does not ship
(`# CONFIG_USB_DUMMY_HCD is not set`), so it has to be compiled — everything
else it needs (`libcomposite`, `usb_f_hid`, `CONFIG_USB_CONFIGFS_F_HID`) is
already in the stock kernel. Install the kernel headers and source first:

```sh
sudo apt install linux-headers-$(uname -r) linux-source-$(uname -r | cut -d- -f1)
```

Then run **the one setup command** — as yourself, *without* sudo. It elevates
only the individual steps that need root, so the kernel module is compiled
unprivileged rather than leaving root-owned objects in `build/`:

```sh
./scripts/setup-permissions.sh
```

It builds `dummy_hcd` if needed, installs it, loads the
gadget modules, creates the USB gadget, installs the udev rules
(`/dev/uhid` and `/dev/hidg*`), lowers `vm.mmap_min_addr`, and enables a
systemd unit that rebuilds the gadget at boot — configfs is volatile, so
without that the device is absent after a reboot.

**Nothing afterwards needs sudo** — not the daemon, not pm2, not the GUI.

Two helpers it calls, occasionally useful on their own:

```sh
./scripts/build-dummy-hcd.sh            # rebuild the module (no root)
sudo ./scripts/gadget-setup.sh --down   # tear the gadget down
sudo systemctl restart onlykey-gadget   # rebuild it
```

The gadget is built from [`emulator/lib/hid-descriptors.js`](emulator/lib/hid-descriptors.js),
which is the single source of truth for the four interfaces — the UHID bridge
builds its `UHID_CREATE2` from the same table, so the two transports cannot
drift apart.

The udev/uhid half by hand, if you prefer:

```sh
# make the uhid module available, now and at boot
sudo modprobe uhid
echo uhid | sudo tee /etc/modules-load.d/onlykey-emulator.conf

# install the rule
sudo install -m 0644 scripts/70-onlykey-emulator.rules \
    /etc/udev/rules.d/70-onlykey-emulator.rules

# join the fallback group (headless/CI machines; harmless otherwise)
sudo groupadd -f plugdev
sudo usermod -aG plugdev "$USER"

# apply without rebooting
sudo udevadm control --reload-rules
sudo udevadm trigger --subsystem-match=misc --sysname-match=uhid
```

Group membership only applies to a **new login session** — log out and back in
(or `newgrp plugdev`) before starting pm2. Check it worked:

```sh
ls -l /dev/uhid      # should no longer be  crw------- root root
```

> The rule uses `TAG+="uaccess"`, which grants the device to whoever is logged
> in at the local seat and revokes it at logout. `GROUP`/`MODE` is a fallback
> for headless machines with no seat. See
> [scripts/70-onlykey-emulator.rules](scripts/70-onlykey-emulator.rules).

The script also lowers `vm.mmap_min_addr` to **4096**:

```sh
sudo sysctl -w vm.mmap_min_addr=4096
```

The emulator maps the emulated flash at its real MK20DX256 addresses, and the
firmware's key material sits low — `certified_hw` is `enckeysectoradr + 432` =
`0x5BB0`, and `okcrypto_split_sundae()` dereferences it on *every* AES-GCM
operation. At the default 65536 that address cannot be mapped and the device
segfaults the moment it encrypts anything, such as storing a PIN.

> **4096, not 0.** Page zero stays unmapped, so a genuine NULL dereference
> still faults — the mitigation this sysctl exists for is preserved. The
> emulator only needs to reach `0x5800`.

Without it the emulator still boots and the HID interfaces work, but any
crypto operation will crash; it prints a warning at startup saying so.

### 3. Build the native module

```sh
cd emulator
npm install
npm run rebuild
```

---

## Running

```sh
pm2 start ecosystem.config.js     # start
pm2 logs onlykey-emulator         # firmware debug output
pm2 restart onlykey-emulator
pm2 stop onlykey-emulator
```

pm2 is what makes the firmware's `CPU_RESTART()` behave like a real device
reset: the daemon exits on a reboot request and pm2 brings it straight back.
Flash and EEPROM are files, so **a reboot is not a factory reset** — the
emulated device keeps its keys, PINs and slots, exactly as hardware keeps flash
across a reset.

### IPC topology

The **GUI listens** and the **emulator dials in** — the reverse of the obvious
arrangement, and deliberately so. The emulator exits on every `CPU_RESTART()`
and is respawned by pm2, so it is the wrong process to own the socket: each
reboot would destroy it and leave the GUI reconnecting into a race (and a
socket file left by a killed process makes the next bind fail with
EADDRINUSE). With the long-lived process listening, a device reboot is just a
client disconnect and reconnect, and the GUI keeps its window, log and state.

Socket: `$XDG_RUNTIME_DIR/onlykey-emulator.sock`, mode `0600`.

Running headless is fine — with nothing listening the emulator retries quietly
and carries on. The HID interfaces do not depend on this channel, so the test
harness works with no GUI running.

### The GUI

```sh
cd ui
npm install     # first time
npm start       # nw .
```

The window shows the NeoPixel colour live, six clickable buttons (click for a
short press, hold past 400 ms for a long one), and a colour-coded log of every
HID interface with per-interface filters. Toolbar buttons cover restart,
rebuild-and-restart, and factory reset.

The GUI hosts the IPC socket, so it can be started before or after the
emulator — the emulator dials in whenever it comes up. It holds no authority
over the device and survives the daemon restarting underneath it; the status
dot goes red and back to green as the device detaches and re-attaches.

**Unplug / Plug in** is a real power cycle, because that is what it is on
hardware: an OnlyKey is bus-powered, so pulling the cable both removes it from
the bus *and* cuts power to the MCU. Unplug therefore unbinds the gadget from
the UDC — Linux stops seeing the device entirely, and the hidraw nodes are
renumbered on re-plug exactly as on real re-enumeration — **and** stops the
emulator process, so the firmware loses its RAM.

That matters for more than realism. `exceeded_login_attempts()` is

```c
while (1==1) { hidprint("Error password attempts for this session exceeded, "
                        "remove OnlyKey and reinsert to attempt login"); }
```

an infinite loop with no exit: on hardware the removal resets the MCU, which is
the only way out. While unplug left the firmware running, the device's own
documented recovery did nothing.

Stopping goes through `pm2 stop` rather than `process.exit()` — pm2's job here
is respawning the daemon after `CPU_RESTART()`, so a plain exit would come
straight back up. *Restart device* remains the reboot-without-unplugging path.

---

## Using it from Node

```js
const emu = require('./emulator');

emu.start();
emu.on('led',  (px)   => console.log('LED', px[0]));
emu.on('log',  (text) => process.stdout.write(text));   // HID4 debug output
emu.on('hid',  (buf, iface) => console.log('HID', iface, buf.toString('hex')));

emu.pressButton(3);                  // short press
emu.pressButton(1, { long: true });  // long press
```

Or over IPC — host the socket and let the emulator dial in. This is what the
GUI does, and it is what survives device reboots:

```js
const IpcHost = require('./emulator/lib/ipc-host');
const h = new IpcHost().listen();

h.on('device-connect',    () => console.log('device attached'));
h.on('device-disconnect', () => console.log('device rebooting; it will dial back in'));
h.on('log',               (m) => process.stdout.write(m.text));

h.press(3);
h._send({ t: 'setPlugged', plugged: false });   // unplug the USB cable
```

### HID interfaces

Numbering is `usb_desc.h`'s, which is what the firmware uses. The GUI labels
them HID1–HID4, i.e. interface + 1.

| # | Interface | Usage page | Direction | Purpose |
|---|-----------|-----------|-----------|---------|
| 0 | Keyboard | — | device → host | typed output |
| 1 | RawHID | `0xF1D0` | both | FIDO / CTAP / WebAuthn |
| 2 | RawHID2 | `0xFFAB` | both | OnlyKey vendor protocol (python-onlykey, the app) |
| 3 | SEREMU | — | both | debug console — **DEBUG builds only** |

### Buttons

Button presses go through the firmware's own debug harness on HID4, not the
analog touch pads — see `touch_sense_loop()` in `okcore.cpp`. An ASCII digit
selects the button and a terminator commits it: newline for a short press,
space for a long one.

The same channel carries the firmware's other debug commands, which
`emulator/index.js` wraps:

| Command | Method | Effect |
|---------|--------|--------|
| `8` | `restartDevice()` | reboot (no data touched) |
| `0` then `C` | `wipeUserspace()` + `confirmWipe()` | wipe PINs/profile/slots |
| `9` then `C` | `wipeAll()` + `confirmWipe()` | full wipe, forces bootloader |

Both wipes require the explicit confirmation step — that is the firmware's own
safeguard, not something added here.

---

## How it works

`kinetis.h` is nothing but register definitions over `<stdint.h>`, so it
compiles on x86 and only faults at *runtime*. The emulator therefore `mmap`s
the Kinetis peripheral windows **at their real MK20DX256 addresses** — every
`*(volatile uint32_t *)0x40020000` in the firmware lands in ordinary process
memory, and no register shimming is needed at all. The 256 KB flash array is
mapped the same way but file-backed, so the firmware's direct
`*(unsigned int *)adr` reads of its own storage work verbatim and persistence
comes for free.

`CPU_RESTART()` is a write to the Cortex-M `AIRCR` register. Against plain
memory that store would silently succeed and the firmware would keep running in
a state it believes is unreachable, so that page is mapped read-only and the
resulting fault parks the firmware thread and raises a `restart` event.

### Running 32-bit firmware on a 64-bit host

The firmware is correct on an ILP32 target and not always correct here. Two
classes of divergence, both now fixed in the OnlyKey sources themselves:

**Pointer size.** Every flash field is read and written through
`okcore_flashget/set_common`, which walk storage with `unsigned long *adr;
adr++`. That steps 4 bytes on the MK20DX256 and **8** on x86-64, so each field
was written into twice its own space — four data bytes then four untouched
`0xFF`:

```
noncehash  4B 3A E3 F3 FF FF FF FF 76 5E F3 4C FF FF FF FF ...
```

Readers and writers were equally wrong, so any single field still round-tripped
— which is why setup appeared to work. But the field *offsets* are plain byte
arithmetic (`adr + EElen_noncehash`), so they did not double: the setter put
the PIN hash 64 bytes into the sector while the getter read it from byte 32,
halfway through the nonce.

**Address zero is readable flash on the target.** `okeeprom_eeset_failedlogins(0)`
passes a null *pointer*, not a value; on hardware that reads the vector table's
initial stack pointer, whose low byte is `0x00`, so it stores zero and is
correct by coincidence. Hosted, page zero is unmapped and it is a segfault —
which fired on the branch taken when a *correct* PIN had just been entered.
`byteprint(NULL, 32)` and `factorydefault()`'s 64 KB dump from 0 are the same
pattern.

Two host-side bugs of the same flavour are worth knowing about:
`systick_millis_count` must be advanced by a thread standing in for the SysTick
interrupt, because `payload()` waits in `while (millis() < wait) recvmsg(0);`
and never calls `micros()`; and `f_hid`'s interrupt-IN queue is shallow, so
device→host reports must be queued and retried on `EAGAIN` rather than
dropped — discarding them lost the debug output the test harness synchronises
on.

**Where these fixes live.** They are in the OnlyKey sources, not in a patch
script. Most are unconditional, because they were latent bugs on the MK20DX256
too — falling off the end of a non-void function, returning a pointer to a dead
stack frame, dereferencing a null `uint8_t *`. The device build gets those fixes
as well, which is the point.

Only **two** sites are genuinely emulator-specific and carry an
`#ifdef OK_EMULATOR` gate, with the original preserved in the `#else`:

| Site | Why it cannot be shared |
| --- | --- |
| `okcore.cpp` — `factorydefault()`'s DEBUG dump | Walks 64 KB from address 0. Valid flash on the target; unmapped here, so it starts at `0x1000`. |
| `password.cpp` — `extern Profile_Offset` | The file declares it at two block scopes with two different types, which modern GCC rejects. Making them agree is required to compile; correcting them to match `okcore.cpp`'s `int` definition would change what the device reads back from a negative offset. |

`OK_EMULATOR` is defined only by [`emulator/binding.gyp`](emulator/binding.gyp).
Grep for it to audit the full divergence:

```
grep -rn OK_EMULATOR onlykey/
```

**Nothing under `onlykey/` is written to by the build.**
[`emulator/scripts/stage.js`](emulator/scripts/stage.js) assembles a build tree
by copying — the same thing OnlyKey's own `in-docker-build.sh` does — and layers
`emulator/core-override/` on top. One textual patch survives, against the
vendored Teensy core's `kinetis.h`: it defines `__disable_irq()`/`__enable_irq()`
as `CPSID i`/`CPSIE i` inline assembly, and a header's own `#define` always wins
over anything predefined from outside, so there is no way to override it. That
core is not OnlyKey code and should not carry emulator knowledge. Regenerate
with `npm run stage`; never edit `emulator/.stage/` directly.

```
emulator/
  binding.gyp          two targets: firmware (gnu++11) + N-API addon (C++17)
  index.js             EventEmitter wrapper
  bin/daemon.js        the process pm2 supervises
  lib/
    hid-descriptors.js the four HID interfaces - one source of truth
    gadget-bridge.js   USB gadget transport (default)
    uhid-bridge.js     UHID transport (OKEMU_BRIDGE=uhid)
    power.js           unplug = unbind UDC + pm2 stop
    ipc-host.js        the GUI listens
    ipc-peer.js        the emulator dials in
  src/                 HAL, flash, restart trap, N-API surface
  core-override/       host replacements for the Teensy peripheral drivers
  shim/                headers that shadow upstream ones
  scripts/             stage.js, gen-sources.js
  .stage/              generated build tree (gitignored)

scripts/
  build-dummy-hcd.sh   compile dummy_hcd out of tree (no root)
  gadget-setup.sh      create/bind the USB gadget (root, one-time)
  setup-permissions.sh udev rules, sysctl, and the above (root, one-time)
```

The native addon knows nothing about Linux: it exposes HID as events and a
send call, and the bridge modules are plain JS that drive the OS. Swapping UHID
for the USB gadget touched only `lib/`, leaving the addon, IPC and GUI alone.
