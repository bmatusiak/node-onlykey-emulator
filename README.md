node-onlykey-emulator
=====================

Runs the **unmodified** [OnlyKey firmware](onlykey/OnlyKey-Firmware) as a Node.js
native addon, so you can develop and test against an OnlyKey without the
hardware. The real Teensyduino core and OnlyKey's own libraries are compiled as
they ship; only the parts that touch silicon are replaced.

The emulator exposes the same four HID interfaces as a DEBUG-build device
(three in production), a NeoPixel LED, six buttons, and file-backed flash and
EEPROM that persist across restarts.

---

## Requirements

* Linux (the HID bridge uses the kernel's UHID interface)
* Node.js 18+ and a C++ toolchain (`build-essential`, `python3`)
* [pm2](https://pm2.keymetrics.io/) — supervises the emulator process
* The firmware sources and Teensyduino toolchain under `onlykey/` (see `setup.sh`)

---

## One-time setup

### 1. Fetch sources and dependencies

```sh
./setup.sh
```

### 2. Grant access to `/dev/uhid`

`/dev/uhid` is root-only by default. Installing a udev rule once means
**nothing afterwards needs sudo** — not the daemon, not pm2, not the GUI.

Either run the script:

```sh
sudo ./scripts/setup-permissions.sh
```

…or do the same by hand:

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

**Unplug / Plug in** models the USB cable: it tears the HID interfaces down and
back up, so the OS and every client see the key removed and reinserted (hidraw
nodes are renumbered on re-plug, exactly as on real re-enumeration). The
firmware keeps running with its RAM intact — for a power cycle use *Restart
device*.

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

**The upstream sources under `onlykey/` are never modified.**
[`emulator/scripts/stage.js`](emulator/scripts/stage.js) assembles a build tree
by copying — the same thing OnlyKey's own `in-docker-build.sh` does — and layers
`emulator/core-override/` on top. It applies exactly three documented textual
patches, listed in `PATCHES` in that file. Regenerate with `npm run stage`;
never edit `emulator/.stage/` directly.

```
emulator/
  binding.gyp          two targets: firmware (gnu++11) + N-API addon (C++17)
  index.js             EventEmitter wrapper
  bin/daemon.js        the process pm2 supervises
  lib/                 IPC protocol, server, client
  src/                 HAL, flash, restart trap, N-API surface
  core-override/       host replacements for the Teensy peripheral drivers
  shim/                headers that shadow upstream ones
  scripts/             stage.js, gen-sources.js
  .stage/              generated build tree (gitignored)
```
