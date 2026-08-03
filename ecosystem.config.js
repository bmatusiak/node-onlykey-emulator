/*
 * pm2 configuration for the OnlyKey emulator.
 *
 *   pm2 start ecosystem.config.js      start the emulator
 *   pm2 logs onlykey-emulator          watch firmware debug output
 *   pm2 restart onlykey-emulator       manual restart
 *   pm2 stop onlykey-emulator
 *
 * pm2 is what makes CPU_RESTART() behave like a real device reset: the daemon
 * exits on the firmware's reboot request and pm2 brings it straight back. The
 * emulated flash and EEPROM are files, so device state survives - a reboot is
 * not a factory reset.
 *
 * Nothing here runs as root. Run scripts/setup-permissions.sh once to grant
 * /dev/uhid access; without it the emulator still runs, just with no HID
 * device exposed to the OS.
 */
module.exports = {
  apps: [
    {
      name: 'onlykey-emulator',
      script: 'emulator/bin/daemon.js',
      cwd: __dirname,

      /*
       * The daemon exits deliberately on every firmware reboot, so restarts
       * are normal operation rather than crash-looping. Keep the delay short
       * enough that a reboot feels instant, but non-zero so a genuinely broken
       * build cannot spin the CPU.
       */
      autorestart: true,
      restart_delay: 300,

      /*
       * Deliberately NOT using exp_backoff_restart_delay, and no low
       * max_restarts.
       *
       * Both exist to contain crash-loops, and both are actively wrong here:
       * every CPU_RESTART() is a restart, so a test run legitimately produces
       * hundreds. With exponential backoff the respawn delay grew until the
       * device took longer to come back than clients allow after a reset
       * (onlykey-testing's waitForDeviceReady gives 20s), and at
       * max_restarts: 50 pm2 stopped respawning altogether mid-suite, leaving
       * the device permanently absent.
       *
       * A fixed 300ms is the whole protection needed: it is imperceptible for
       * a reboot but still stops a genuinely broken build from spinning the
       * CPU. 0 disables the restart cap.
       */
      max_restarts: 0,

      /*
       * The firmware thread runs continuously and the native module maps fixed
       * address ranges at load; leave the process alone rather than reloading
       * it in place.
       */
      instances: 1,
      exec_mode: 'fork',
      watch: false,
      kill_timeout: 3000,

      env: {
        NODE_ENV: 'development',
      },
    },
  ],
};
