I want to build an emulator for OnlyKey, a hardware security key that provides secure authentication and encryption. The emulator will simulate the behavior of the OnlyKey device, allowing developers to test their applications without needing the physical hardware.

To build an emulator for OnlyKey, we will use the onlykey sourcecode and include in as a native nodejs module. This will allow us to run the OnlyKey code in a Node.js environment, enabling developers to interact with the emulator as if they were using the actual hardware device.

We will also need to setup a hid emulator. A sample is found at `scripts/hid_setup.js`. The origianl device has 4 hid interfaces in debug mode, 3 in production mode. The emulator will simulate these interfaces, allowing developers to test their applications with the same HID communication as the physical device. HID interfaces should be events on the native modules, where javascript can read and also write to each hid device.

We will focus on a minimal implementation of the OnlyKey emulator, loading the necessary OnlyKey code and providing a basic interface for developers to interact with. The emulator will support key functionalities such as generating keys, signing messages, and encrypting/decrypting data.

Nodejs has 2 sides native and javascript. The native side will handle the OnlyKey code, while the javascript side will provide a user-friendly interface showing "color" if the emulated newpixel led. native side will also handle the communication with the hid emulator while javascript proxies the functionality, simulating the behavior of the OnlyKey device. Javascript will also provide communication for button presses up to 6 button (1-6) and the led color. 

The firmware code needs to be adapted slightly to stub out physical hardware peripherals (GPIO pins, physical USB drivers, hardware timer interrupts) while retaining the cryptographic and protocol state machines. Simulated EEPROM / Flash storage (file-backed) will be used to store persistent data, and the emulator will provide a way to reset or clear this storage to simulate a factory reset.

keep do not touch the original onlykey sourcecode, we will use it as is. The emulator will be a wrapper around the original code, providing the necessary stubs and interfaces to allow it to run in a Node.js environment.

simulated button press is handled on hid4 interface,  read onlykey sourcecode for details. The emulator will provide a way to simulate button presses through the GUI, allowing developers to test their applications without needing the physical device.

location of the original onlykey sourcecode is `node-onlykey-emulator/onlykey`. The emulator will be built in `node-onlykey-emulator/emulator`. The emulator will be a Node.js module that can be imported and used in other Node.js applications.

The UI will be located in `ui` directory, nwjs will be use for the GUI part of the emulator, allowing developers to interact with the emulator through a graphical interface. The GUI will display the current state of the OnlyKey device, including the LED color and button states, and will provide controls for simulating button presses and other interactions. It will also include a debug log to show the communication between the emulator and the OnlyKey code, allowing developers to see how their applications are interacting with the emulated device when `#DEBUG` flag is set. The GUI will be built using HTML, CSS, and JavaScript, and will communicate with the Node.js emulator module through a simple API. 

A Bridge Between GUI useing IPC nodejs tcp domain sockets and the native emulator, allowing the GUI to send commands to the emulator and receive responses. The emulator will listen for incoming connections from the GUI and handle requests such as button presses, LED color changes, and other interactions. The GUI will also be able to request the current state of the emulator, including the LED color and button states, and display this information to the user.

GUI will send button presses over IPC to the running native emulator, which will then simulate the button press and update the state of the OnlyKey code accordingly.

CPU_RESTART will simulate a event passed to javascript, allowing the GUI to trigger a re-compile and restart of the onlykey emulator process. This will allow developers to test changes to the OnlyKey code for automated testing without needing to manually restart the emulator and recompile.