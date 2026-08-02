/*
 * addon.cpp - the N-API surface.
 *
 * The firmware is a bare-metal program: setup() then an endless loop(). It
 * cannot run on the JS thread, so it gets its own std::thread and everything
 * it produces (LED changes, keystrokes, debug output, HID replies, reboot
 * requests) crosses back through ThreadSafeFunctions.
 *
 * JS surface:
 *   start({ storageDir, onLed, onKeyboard, onLog, onHid, onRestart })
 *   sendHid(buffer, iface)   host -> device, iface 1=FIDO 2=vendor
 *   setButton(n, down)       n = 1..6
 *   factoryReset()
 *   stop()
 */
#include <napi.h>

#include <thread>
#include <vector>

#include "ok_hal.h"

namespace {

struct Emu {
  std::thread thread;
  bool running = false;

  Napi::ThreadSafeFunction led;
  Napi::ThreadSafeFunction stream;
  Napi::ThreadSafeFunction restart;
};

Emu g;

/* ------------------------------------------------------------- sinks */

void on_led(const okemu_rgb *px, int count, void * /*ctx*/) {
  if (!g.led) return;
  std::vector<okemu_rgb> snap(px, px + count);
  g.led.NonBlockingCall([snap](Napi::Env env, Napi::Function cb) {
    Napi::Array arr = Napi::Array::New(env, snap.size());
    for (size_t i = 0; i < snap.size(); i++) {
      Napi::Object o = Napi::Object::New(env);
      o.Set("r", Napi::Number::New(env, snap[i].r));
      o.Set("g", Napi::Number::New(env, snap[i].g));
      o.Set("b", Napi::Number::New(env, snap[i].b));
      arr.Set(i, o);
    }
    cb.Call({arr});
  });
}

/*
 * The whole USB bus as one stream: onStream(buffer, iface, dir). JS demuxes on
 * iface (0 keyboard, 1 FIDO, 2 vendor, 3 SEREMU) and dir ('out' = device to
 * host, 'in' = host to device), which is exactly what the UI debug log wants.
 */
void on_stream(const uint8_t *d, size_t n, int iface, int dir, void *) {
  if (!g.stream) return;
  std::vector<uint8_t> buf(d, d + n);
  g.stream.NonBlockingCall([buf, iface, dir](Napi::Env env, Napi::Function cb) {
    cb.Call({Napi::Buffer<uint8_t>::Copy(env, buf.data(), buf.size()),
             Napi::Number::New(env, iface),
             Napi::String::New(env, dir == OKEMU_DIR_IN ? "in" : "out")});
  });
}

void on_restart(void * /*ctx*/) {
  if (!g.restart) return;
  g.restart.NonBlockingCall([](Napi::Env env, Napi::Function cb) {
    cb.Call({});
  });
}

/* ---------------------------------------------------------- bindings */

Napi::Value Start(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  if (g.running) {
    Napi::Error::New(env, "emulator already started").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  if (info.Length() < 1 || !info[0].IsObject()) {
    Napi::TypeError::New(env, "start(options) requires an object")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }

  Napi::Object opt = info[0].As<Napi::Object>();
  std::string dir = opt.Has("storageDir")
                        ? opt.Get("storageDir").As<Napi::String>().Utf8Value()
                        : std::string("./.onlykey-storage");

  char err[512] = {0};
  if (okemu_hal_init(dir.c_str(), err, sizeof err) != 0) {
    Napi::Error::New(env, err).ThrowAsJavaScriptException();
    return env.Undefined();
  }

  struct { const char *name; Napi::ThreadSafeFunction *slot; } cbs[] = {
    {"onLed",     &g.led},
    {"onStream",  &g.stream},
    {"onRestart", &g.restart},
  };
  for (auto &c : cbs) {
    if (opt.Has(c.name) && opt.Get(c.name).IsFunction()) {
      *c.slot = Napi::ThreadSafeFunction::New(
          env, opt.Get(c.name).As<Napi::Function>(), c.name, 0, 1);
    }
  }

  okemu_set_led_sink(on_led, nullptr);
  okemu_set_stream_sink(on_stream, nullptr);
  okemu_set_restart_sink(on_restart, nullptr);

  /*
   * Detached immediately: the firmware sits in an endless loop() with no
   * cooperative exit, so it is never joined. Leaving a joinable std::thread
   * alive would make its destructor call std::terminate() whenever the process
   * exits without stop() - which is what any plain process.exit() does.
   */
  g.running = true;
  std::thread([] {
    okemu_firmware_run();   /* returns only on CPU_RESTART() */
    g.running = false;
  }).detach();

  return env.Undefined();
}

Napi::Value SendHid(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsBuffer()) {
    Napi::TypeError::New(env, "sendHid(buffer[, iface]) requires a Buffer")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }
  auto buf = info[0].As<Napi::Buffer<uint8_t>>();
  int iface = (info.Length() > 1 && info[1].IsNumber())
                  ? info[1].As<Napi::Number>().Int32Value()
                  : OKEMU_IFACE_FIDO;
  if (okemu_hid_deliver(buf.Data(), buf.Length(), iface) != 0) {
    Napi::Error::New(env,
        "interface is not writable (0 = keyboard is device->host only); "
        "use 1 = FIDO, 2 = vendor, 3 = SEREMU")
        .ThrowAsJavaScriptException();
  }
  return env.Undefined();
}

/*
 * The keyboard interface's control-transfer channel, driven by the UHID
 * bridge: kbdSetReport(buffer) on a host SET_REPORT, kbdGetReport() to answer
 * a host GET_REPORT.
 */
Napi::Value KbdSetReport(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsBuffer()) {
    Napi::TypeError::New(env, "kbdSetReport(buffer) requires a Buffer")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }
  auto buf = info[0].As<Napi::Buffer<uint8_t>>();
  okemu_kbd_set_report(buf.Data(), (uint32_t)buf.Length());
  return env.Undefined();
}

Napi::Value KbdGetReport(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  uint8_t out[8] = {0};
  int n = okemu_kbd_get_report(out);
  return Napi::Buffer<uint8_t>::Copy(env, out, n);
}

Napi::Value SetButton(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  if (info.Length() < 2 || !info[0].IsNumber()) {
    Napi::TypeError::New(env, "setButton(n, down) requires (number, boolean)")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }
  okemu_set_button(info[0].As<Napi::Number>().Int32Value(),
                   info[1].ToBoolean().Value() ? 1 : 0);
  return env.Undefined();
}

Napi::Value FactoryReset(const Napi::CallbackInfo &info) {
  okemu_factory_reset();
  return info.Env().Undefined();
}

Napi::Value Stop(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  okemu_hal_shutdown();
  for (auto *t : {&g.led, &g.stream, &g.restart}) {
    if (*t) { t->Release(); }
  }
  /*
   * The firmware thread sits in an endless loop(); there is no cooperative
   * exit short of a reboot request, so it is left detached and the process
   * teardown reclaims it. Restarts respawn the process anyway.
   */
  if (g.thread.joinable()) g.thread.detach();
  g.running = false;
  return env.Undefined();
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("start",        Napi::Function::New(env, Start));
  exports.Set("sendHid",      Napi::Function::New(env, SendHid));
  exports.Set("setButton",    Napi::Function::New(env, SetButton));
  exports.Set("factoryReset", Napi::Function::New(env, FactoryReset));
  exports.Set("stop",         Napi::Function::New(env, Stop));
  exports.Set("kbdSetReport", Napi::Function::New(env, KbdSetReport));
  exports.Set("kbdGetReport", Napi::Function::New(env, KbdGetReport));
  /* usb_desc.h interface numbers; HIDn in the UI is interface n-1. */
  exports.Set("IFACE_KEYBOARD", Napi::Number::New(env, OKEMU_IFACE_KEYBOARD));
  exports.Set("IFACE_FIDO",     Napi::Number::New(env, OKEMU_IFACE_FIDO));
  exports.Set("IFACE_VENDOR",   Napi::Number::New(env, OKEMU_IFACE_VENDOR));
  exports.Set("IFACE_SEREMU",   Napi::Number::New(env, OKEMU_IFACE_SEREMU));
  return exports;
}

}  // namespace

NODE_API_MODULE(onlykey_emulator, Init)
