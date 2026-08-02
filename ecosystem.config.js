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
      exp_backoff_restart_delay: 200,
      max_restarts: 50,

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
