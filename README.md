# NFC Keyboard

An Android app that reads NFC tags and barcodes/QR codes, then sends the extracted text to a Windows PC via Bluetooth HID — emulating a physical keyboard. No drivers required on the PC side; Windows treats it as a standard Bluetooth keyboard.

## How It Works

```
NFC Tag / Barcode  →  Android App  →  Bluetooth HID  →  Windows PC
                                        (keyboard emulation)
```

1. Pair the phone with the PC via Bluetooth (standard Windows pairing)
2. Scan an NFC tag or barcode in the app
3. The text is instantly "typed" into whatever has focus on the PC

Designed for warehouse/factory workflows where scanned codes need to feed into desktop applications without manual re-entry.

---

## Features

- **NFC tag reading** — NDEF records (text and URI types), NfcA/B/F/V technologies
- **Barcode & QR scanning** — camera-based, via Expo Barcode Scanner
- **Bluetooth HID emulation** — acts as a keyboard on Android 9+ (API 28+)
- **Auto-reconnect** — exponential backoff when the BT connection drops
- **Foreground service** — keeps the connection alive when the app is backgrounded
- **Settings**:
  - Append Enter after each scan
  - Line selector — send all lines or a specific line (1–3) from multi-line data
  - Character substitution rules — transform scanned text before sending (e.g., replace `,` with `\t`)

---

## Requirements

| Requirement | Minimum |
|---|---|
| Android | 9.0 (API 28) |
| Bluetooth | BT Classic (HID profile) |
| NFC | Hardware required |
| PC OS | Windows 10/11 (standard BT pairing) |

---

## Setup

### First-time PC Pairing

1. In the app, tap **Make visible to PC** (opens a 5-minute discoverability window)
2. On Windows: **Settings → Bluetooth → Add device** → select the phone
3. Windows automatically installs the HID keyboard driver
4. The phone shows as a connected keyboard — no further configuration needed

### Reconnecting

After the initial pairing, tap **Connect** in the app. If the connection is stale, use **Force Reconnect** (takes ~12–15 seconds to re-register the HID profile).

---

## Development

### Prerequisites

- Node.js 18+
- Android Studio + Android SDK (API 28+)
- A physical Android device (NFC and BT HID require real hardware)

### Install & Run

```bash
npm install
npm run android     # builds and deploys to a connected device
```

For the Metro bundler only (if the app is already installed):

```bash
npm run start
```

### Project Structure

```
NFC-Keyboard/
├── App.js                          # Main UI and app logic (React Native)
├── index.js                        # Expo entry point
├── android/
│   └── app/src/main/java/com/nfckeyboard/app/
│       ├── HIDKeyboardModule.kt    # Native BT HID module (core logic)
│       ├── HIDKeyboardPackage.kt   # React Native bridge
│       └── HIDForegroundService.kt # Background connection service
└── package.json
```

### Key Dependencies

| Package | Purpose |
|---|---|
| `react-native-nfc-manager` | NFC tag reading |
| `expo-barcode-scanner` | Camera barcode/QR scanning |
| `HIDKeyboardModule` (native) | Bluetooth HID keyboard emulation |

### Building a Release APK

```bash
cd android
./gradlew assembleRelease
```

The APK will be at `android/app/build/outputs/apk/release/app-release.apk`.

> A release signing keystore is required. Configure `storeFile`, `storePassword`, `keyAlias`, and `keyPassword` in `android/gradle.properties` (do not commit credentials).

---

## Architecture Notes

- **HID emulation** uses Android's `BluetoothHidDevice` API, available from API 28. The app registers a standard keyboard HID descriptor and translates ASCII text to HID key reports (one report per character, 8 ms apart).
- **Reconnect logic** in `HIDKeyboardModule.kt` uses exponential backoff from 3 s up to 30 s. The saved device MAC is persisted in SharedPreferences so reconnection survives app restarts.
- **Settings** are stored via `SharedPreferences` through `HIDKeyboardModule.setPreference()` / `getPreference()` — no external storage or database needed.
- **Substitution rules** are applied in `App.js` before calling `sendKeystrokes`, so the native module always receives final, ready-to-type text.

---

## Changelog

| Version | Summary |
|---|---|
| v1.5 | Scan line selector in Settings |
| v1.4 | Character substitution rules in Settings |
| v1.3 | Fix BT reconnect failure after app restart |
| v1.2 | Settings menu with Append Enter toggle |
| v1.1 | Barcode/QR scan + side-by-side button layout |
