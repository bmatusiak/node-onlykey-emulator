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

> **Not required:** lowering `vm.mmap_min_addr`. The emulator maps the emulated
> flash at its real MK20DX256 addresses and falls back to mapping from
> `0x10000` when the lowest 64 KiB is unavailable, which still covers all
> device storage. Lowering that sysctl weakens a real kernel mitigation and the
> emulator does not need it.

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

The daemon listens on a Unix domain socket, by default
`$XDG_RUNTIME_DIR/onlykey-emulator.sock`, mode `0600`.

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

The GUI is only an IPC client — start the emulator with pm2 first. It holds no
authority over the device and reconnects on its own, so it survives the daemon
being restarted underneath it; the status dot goes red and back to green.

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

Or over IPC, which is what the GUI uses and what survives restarts:

```js
const IpcClient = require('./emulator/lib/ipc-client');
const c = new IpcClient().connect();

c.on('ready', (m) => console.log('attached', m));
c.on('log',   (m) => process.stdout.write(m.text));
c.on('restart', () => console.log('device rebooted; pm2 is respawning it'));

c.press(3);
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
