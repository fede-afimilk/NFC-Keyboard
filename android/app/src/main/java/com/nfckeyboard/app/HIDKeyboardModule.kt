package com.nfckeyboard.app

import android.annotation.SuppressLint
import android.bluetooth.*
import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import android.os.Build
import android.os.Handler
import android.os.Looper
import com.facebook.react.bridge.*
import com.facebook.react.modules.core.DeviceEventManagerModule
import java.util.concurrent.Executor
import java.util.concurrent.Executors

class HIDKeyboardModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    private val bluetoothAdapter: BluetoothAdapter? = BluetoothAdapter.getDefaultAdapter()
    private var bluetoothHidDevice: BluetoothHidDevice? = null
    private var connectedHost: BluetoothDevice? = null
    private val prefs: SharedPreferences =
        reactContext.getSharedPreferences("nfc_keyboard", Context.MODE_PRIVATE)
    private val mainHandler = Handler(Looper.getMainLooper())
    private val autoReconnectHandler = Handler(Looper.getMainLooper())
    private val executor: Executor = Executors.newSingleThreadExecutor()

    private var appRegistered = false
    private var isManualDisconnect = false
    private var reconnectAttempts = 0
    private val MAX_RECONNECT_ATTEMPTS = 8

    companion object {
        // Standard USB HID keyboard report descriptor
        private val KEYBOARD_DESCRIPTOR = byteArrayOf(
            0x05.toByte(), 0x01.toByte(),  // Usage Page (Generic Desktop)
            0x09.toByte(), 0x06.toByte(),  // Usage (Keyboard)
            0xA1.toByte(), 0x01.toByte(),  // Collection (Application)
            0x05.toByte(), 0x07.toByte(),  //   Usage Page (Key Codes)
            0x19.toByte(), 0xE0.toByte(),  //   Usage Min (0xE0 = Left Control)
            0x29.toByte(), 0xE7.toByte(),  //   Usage Max (0xE7 = Right GUI)
            0x15.toByte(), 0x00.toByte(),  //   Logical Min (0)
            0x25.toByte(), 0x01.toByte(),  //   Logical Max (1)
            0x75.toByte(), 0x01.toByte(),  //   Report Size (1)
            0x95.toByte(), 0x08.toByte(),  //   Report Count (8) modifier bits
            0x81.toByte(), 0x02.toByte(),  //   Input (Data, Variable, Absolute)
            0x95.toByte(), 0x01.toByte(),  //   Report Count (1)
            0x75.toByte(), 0x08.toByte(),  //   Report Size (8)
            0x81.toByte(), 0x01.toByte(),  //   Input (Constant) reserved byte
            0x95.toByte(), 0x06.toByte(),  //   Report Count (6) key slots
            0x75.toByte(), 0x08.toByte(),  //   Report Size (8)
            0x15.toByte(), 0x00.toByte(),  //   Logical Min (0)
            0x25.toByte(), 0x65.toByte(),  //   Logical Max (101)
            0x05.toByte(), 0x07.toByte(),  //   Usage Page (Key Codes)
            0x19.toByte(), 0x00.toByte(),  //   Usage Min (0)
            0x29.toByte(), 0x65.toByte(),  //   Usage Max (101)
            0x81.toByte(), 0x00.toByte(),  //   Input (Data, Array)
            0xC0.toByte()                  // End Collection
        )

        // [modifier_byte, hid_keycode] for each ASCII character
        private val CHAR_MAP: Map<Char, Pair<Int, Int>> = buildMap {
            val letters = "abcdefghijklmnopqrstuvwxyz"
            letters.forEachIndexed { i, c ->
                put(c, Pair(0x00, 0x04 + i))
                put(c.uppercaseChar(), Pair(0x02, 0x04 + i))
            }
            "1234567890".forEachIndexed { i, c -> put(c, Pair(0x00, 0x1E + i)) }
            put('!', Pair(0x02, 0x1E)); put('@', Pair(0x02, 0x1F))
            put('#', Pair(0x02, 0x20)); put('$', Pair(0x02, 0x21))
            put('%', Pair(0x02, 0x22)); put('^', Pair(0x02, 0x23))
            put('&', Pair(0x02, 0x24)); put('*', Pair(0x02, 0x25))
            put('(', Pair(0x02, 0x26)); put(')', Pair(0x02, 0x27))
            put(' ', Pair(0x00, 0x2C)); put('\n', Pair(0x00, 0x28))
            put('\t', Pair(0x00, 0x2B)); put('\b', Pair(0x00, 0x2A))
            put('-', Pair(0x00, 0x2D)); put('_', Pair(0x02, 0x2D))
            put('=', Pair(0x00, 0x2E)); put('+', Pair(0x02, 0x2E))
            put('[', Pair(0x00, 0x2F)); put('{', Pair(0x02, 0x2F))
            put(']', Pair(0x00, 0x30)); put('}', Pair(0x02, 0x30))
            put('\\', Pair(0x00, 0x31)); put('|', Pair(0x02, 0x31))
            put(';', Pair(0x00, 0x33)); put(':', Pair(0x02, 0x33))
            put('\'', Pair(0x00, 0x34)); put('"', Pair(0x02, 0x34))
            put('`', Pair(0x00, 0x35)); put('~', Pair(0x02, 0x35))
            put(',', Pair(0x00, 0x36)); put('<', Pair(0x02, 0x36))
            put('.', Pair(0x00, 0x37)); put('>', Pair(0x02, 0x37))
            put('/', Pair(0x00, 0x38)); put('?', Pair(0x02, 0x38))
        }
    }

    private val hidCallback = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
        object : BluetoothHidDevice.Callback() {
            override fun onAppStatusChanged(pluggedDevice: BluetoothDevice?, registered: Boolean) {
                appRegistered = registered
                val params = Arguments.createMap()
                params.putBoolean("registered", registered)
                sendEvent("HIDAppStatus", params)
                // If app was unregistered unexpectedly (e.g. BT stack restart), re-register
                if (!registered && bluetoothHidDevice != null) {
                    mainHandler.postDelayed({ tryRegisterApp() }, 1000)
                }
            }

            @SuppressLint("MissingPermission")
            override fun onConnectionStateChanged(device: BluetoothDevice, state: Int) {
                when (state) {
                    BluetoothProfile.STATE_CONNECTED -> {
                        connectedHost = device
                        reconnectAttempts = 0
                        isManualDisconnect = false
                        autoReconnectHandler.removeCallbacksAndMessages(null)
                        val params = Arguments.createMap()
                        params.putString("status", "connected")
                        params.putString("device", device.name ?: device.address)
                        params.putString("address", device.address)
                        sendEvent("HIDConnectionState", params)
                    }
                    BluetoothProfile.STATE_DISCONNECTED -> {
                        if (connectedHost?.address == device.address) connectedHost = null
                        val params = Arguments.createMap()
                        params.putString("status", "disconnected")
                        params.putString("device", device.name ?: device.address)
                        params.putString("address", device.address)
                        sendEvent("HIDConnectionState", params)
                        // Auto-reconnect only if not a manual disconnect and under attempt limit
                        if (!isManualDisconnect) {
                            val savedMac = prefs.getString("saved_device_mac", null)
                            if (savedMac != null && reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
                                scheduleReconnect(savedMac)
                            } else if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
                                val failParams = Arguments.createMap()
                                failParams.putString("status", "reconnect_failed")
                                sendEvent("HIDConnectionState", failParams)
                            }
                        }
                    }
                }
            }
        }
    } else null

    private val profileListener = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
        object : BluetoothProfile.ServiceListener {
            @SuppressLint("MissingPermission")
            override fun onServiceConnected(profile: Int, proxy: BluetoothProfile) {
                if (profile == BluetoothProfile.HID_DEVICE) {
                    bluetoothHidDevice = proxy as BluetoothHidDevice
                    // Unregister stale app before re-registering to avoid conflicts
                    if (appRegistered) {
                        try { bluetoothHidDevice?.unregisterApp() } catch (_: Exception) {}
                        appRegistered = false
                    }
                    tryRegisterApp()
                }
            }

            override fun onServiceDisconnected(profile: Int) {
                if (profile == BluetoothProfile.HID_DEVICE) {
                    try { bluetoothHidDevice?.unregisterApp() } catch (_: Exception) {}
                    bluetoothHidDevice = null
                    appRegistered = false
                    connectedHost = null
                }
            }
        }
    } else null

    private fun tryRegisterApp() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.P) return
        val hid = bluetoothHidDevice ?: return
        val sdp = BluetoothHidDeviceAppSdpSettings(
            "NFC Keyboard",
            "NFC to BT Keyboard",
            "NFC Keyboard App",
            BluetoothHidDevice.SUBCLASS1_KEYBOARD,
            KEYBOARD_DESCRIPTOR
        )
        hid.registerApp(sdp, null, null, executor, hidCallback!!)
    }

    override fun getName(): String = "HIDKeyboardModule"

    @ReactMethod
    fun initialize(promise: Promise) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.P) {
            promise.reject("UNSUPPORTED", "Android 9 (API 28) required for Bluetooth HID")
            return
        }
        try {
            val ok = bluetoothAdapter?.getProfileProxy(
                reactApplicationContext, profileListener, BluetoothProfile.HID_DEVICE
            ) ?: false
            promise.resolve(ok)
        } catch (e: Exception) {
            promise.reject("ERROR", e.message)
        }
    }

    @ReactMethod
    fun isBluetoothEnabled(promise: Promise) {
        promise.resolve(bluetoothAdapter?.isEnabled ?: false)
    }

    @SuppressLint("MissingPermission")
    @ReactMethod
    fun getPairedDevices(promise: Promise) {
        try {
            val list = Arguments.createArray()
            bluetoothAdapter?.bondedDevices?.forEach { device ->
                val map = Arguments.createMap()
                map.putString("name", device.name ?: "Unknown")
                map.putString("address", device.address)
                list.pushMap(map)
            }
            promise.resolve(list)
        } catch (e: Exception) {
            promise.reject("ERROR", e.message)
        }
    }

    @SuppressLint("MissingPermission")
    @ReactMethod
    fun connectToHost(macAddress: String, promise: Promise) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.P) {
            promise.reject("UNSUPPORTED", "Android 9+ required")
            return
        }
        val hid = bluetoothHidDevice
        if (hid == null) {
            promise.reject("NOT_READY", "HID service not initialized yet, try again in a moment")
            return
        }
        try {
            val device = bluetoothAdapter?.getRemoteDevice(macAddress)
                ?: run { promise.reject("NOT_FOUND", "Device not found"); return }

            val ok = hid.connect(device)
            if (ok) {
                prefs.edit()
                    .putString("saved_device_mac", macAddress)
                    .putString("saved_device_name", device.name ?: macAddress)
                    .apply()
                promise.resolve(true)
            } else {
                promise.reject("CONNECT_FAILED", "Could not initiate connection")
            }
        } catch (e: Exception) {
            promise.reject("ERROR", e.message)
        }
    }

    @ReactMethod
    fun isConnected(promise: Promise) {
        promise.resolve(connectedHost != null)
    }

    @SuppressLint("MissingPermission")
    @ReactMethod
    fun disconnect(promise: Promise) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.P) {
            promise.reject("UNSUPPORTED", "Android 9+ required")
            return
        }
        isManualDisconnect = true
        autoReconnectHandler.removeCallbacksAndMessages(null)
        reconnectAttempts = 0
        try {
            connectedHost?.let { bluetoothHidDevice?.disconnect(it) }
            connectedHost = null
            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject("ERROR", e.message)
        }
    }

    @SuppressLint("MissingPermission")
    @ReactMethod
    fun forceReconnect(promise: Promise) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.P) {
            promise.reject("UNSUPPORTED", "Android 9+ required")
            return
        }
        val savedMac = prefs.getString("saved_device_mac", null)
            ?: run { promise.reject("NO_DEVICE", "No saved device"); return }
        isManualDisconnect = false
        reconnectAttempts = 0
        autoReconnectHandler.removeCallbacksAndMessages(null)
        // Re-register app to force fresh HID state, then connect
        try {
            if (appRegistered) {
                bluetoothHidDevice?.unregisterApp()
                appRegistered = false
            }
            mainHandler.postDelayed({
                tryRegisterApp()
                mainHandler.postDelayed({ scheduleReconnect(savedMac) }, 1500)
            }, 500)
            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject("ERROR", e.message)
        }
    }

    @SuppressLint("MissingPermission")
    @ReactMethod
    fun sendKeystrokes(text: String, promise: Promise) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.P) {
            promise.reject("UNSUPPORTED", "Android 9+ required")
            return
        }
        val host = connectedHost ?: run { promise.reject("NOT_CONNECTED", "No host connected"); return }
        val hid = bluetoothHidDevice ?: run { promise.reject("NOT_READY", "HID not initialized"); return }

        executor.execute {
            try {
                val keyUp = byteArrayOf(0, 0, 0, 0, 0, 0, 0, 0)
                for (ch in text) {
                    val (mod, code) = CHAR_MAP[ch] ?: continue
                    val keyDown = byteArrayOf(mod.toByte(), 0, code.toByte(), 0, 0, 0, 0, 0)
                    hid.sendReport(host, 0, keyDown)
                    Thread.sleep(8)
                    hid.sendReport(host, 0, keyUp)
                    Thread.sleep(8)
                }
                mainHandler.post { promise.resolve(text.length) }
            } catch (e: Exception) {
                mainHandler.post { promise.reject("SEND_ERROR", e.message) }
            }
        }
    }

    @ReactMethod
    fun getSavedDevice(promise: Promise) {
        val mac = prefs.getString("saved_device_mac", null)
        val name = prefs.getString("saved_device_name", null)
        if (mac != null) {
            val map = Arguments.createMap()
            map.putString("address", mac)
            map.putString("name", name ?: mac)
            promise.resolve(map)
        } else {
            promise.resolve(null)
        }
    }

    @SuppressLint("MissingPermission")
    private fun scheduleReconnect(mac: String) {
        reconnectAttempts++
        // Exponential backoff: 3s, 6s, 12s, 20s, 30s (capped)
        val delayMs = minOf(3000L * reconnectAttempts, 30000L)
        autoReconnectHandler.removeCallbacksAndMessages(null)
        autoReconnectHandler.postDelayed({
            if (isManualDisconnect || connectedHost != null) return@postDelayed
            val hid = bluetoothHidDevice ?: return@postDelayed
            if (!appRegistered) return@postDelayed
            try {
                val device = bluetoothAdapter?.getRemoteDevice(mac) ?: return@postDelayed
                val ok = hid.connect(device)
                // If rejected immediately (false), schedule next attempt right away
                if (!ok && reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
                    scheduleReconnect(mac)
                }
            } catch (_: Exception) {
                if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) scheduleReconnect(mac)
            }
        }, delayMs)
    }

    @ReactMethod
    fun startForegroundService(promise: Promise) {
        try {
            val intent = Intent(reactApplicationContext, HIDForegroundService::class.java).apply {
                action = HIDForegroundService.ACTION_START
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                reactApplicationContext.startForegroundService(intent)
            } else {
                reactApplicationContext.startService(intent)
            }
            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject("ERROR", e.message)
        }
    }

    @ReactMethod
    fun makeDiscoverable(promise: Promise) {
        val activity = currentActivity
        if (activity == null) {
            promise.reject("NO_ACTIVITY", "No active activity")
            return
        }
        try {
            val intent = Intent(BluetoothAdapter.ACTION_REQUEST_DISCOVERABLE).apply {
                putExtra(BluetoothAdapter.EXTRA_DISCOVERABLE_DURATION, 300)
            }
            activity.startActivity(intent)
            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject("ERROR", e.message)
        }
    }

    @ReactMethod
    fun getPreference(key: String, promise: Promise) {
        promise.resolve(prefs.getString(key, null))
    }

    @ReactMethod
    fun setPreference(key: String, value: String, promise: Promise) {
        prefs.edit().putString(key, value).apply()
        promise.resolve(true)
    }

    @ReactMethod
    fun addListener(eventName: String) {}

    @ReactMethod
    fun removeListeners(count: Int) {}

    private fun sendEvent(name: String, params: WritableMap?) {
        reactApplicationContext
            .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
            .emit(name, params)
    }
}
