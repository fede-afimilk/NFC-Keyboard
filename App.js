import React, { useEffect, useState, useRef } from 'react';
import {
  SafeAreaView,
  Text,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  View,
  NativeModules,
  NativeEventEmitter,
  PermissionsAndroid,
  Platform,
  ActivityIndicator,
  Modal,
  Switch,
  TextInput,
} from 'react-native';
import NfcManager, { NfcTech } from 'react-native-nfc-manager';
import { BarCodeScanner } from 'expo-barcode-scanner';
import { StatusBar } from 'expo-status-bar';

const { HIDKeyboardModule } = NativeModules;
const hidEmitter = HIDKeyboardModule ? new NativeEventEmitter(HIDKeyboardModule) : null;

// ── NFC helpers ──────────────────────────────────────────────────────────────

function tagIdToHex(id) {
  if (!id) return 'N/A';
  return Array.from(id).map(b => b.toString(16).padStart(2, '0').toUpperCase()).join(':');
}

function extractTextFromTag(tag) {
  if (!tag?.ndefMessage?.length) return null;
  for (const record of tag.ndefMessage) {
    try {
      if (record.tnf === 1 && record.type) {
        const typeChar = String.fromCharCode(...record.type);
        if (typeChar === 'T' && record.payload?.length > 0) {
          const langLen = record.payload[0] & 0x3f;
          return String.fromCharCode(...record.payload.slice(1 + langLen));
        }
        if (typeChar === 'U' && record.payload?.length > 0) {
          const prefixes = ['', 'http://www.', 'https://www.', 'http://', 'https://', 'tel:', 'mailto:'];
          const prefix = prefixes[record.payload[0]] || '';
          return prefix + String.fromCharCode(...record.payload.slice(1));
        }
      }
    } catch (_) {}
  }
  return null;
}

function decodeNdefRecords(tag) {
  if (!tag?.ndefMessage?.length) return [];
  return tag.ndefMessage.map((record, i) => {
    try {
      if (record.tnf === 1 && record.type) {
        const typeChar = String.fromCharCode(...record.type);
        if (typeChar === 'T' && record.payload?.length > 0) {
          const langLen = record.payload[0] & 0x3f;
          return { index: i, kind: 'Text', value: String.fromCharCode(...record.payload.slice(1 + langLen)) };
        }
        if (typeChar === 'U' && record.payload?.length > 0) {
          const prefixes = ['', 'http://www.', 'https://www.', 'http://', 'https://', 'tel:', 'mailto:', 'ftp://anonymous:anonymous@', 'ftp://ftp.', 'ftps://', 'sftp://'];
          const prefix = prefixes[record.payload[0]] || '';
          return { index: i, kind: 'URI', value: prefix + String.fromCharCode(...record.payload.slice(1)) };
        }
      }
    } catch (_) {}
    const hex = Array.from(record.payload || []).map(b => b.toString(16).padStart(2, '0')).join(' ').toUpperCase();
    return { index: i, kind: 'Raw', value: hex || '(empty)' };
  });
}

// ── Bluetooth helpers ─────────────────────────────────────────────────────────

async function requestBtPermissions() {
  if (Platform.OS !== 'android') return true;
  if (Platform.Version >= 33) {
    await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS);
  }
  if (Platform.Version >= 31) {
    const results = await PermissionsAndroid.requestMultiple([
      PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
      PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
    ]);
    return Object.values(results).every(r => r === PermissionsAndroid.RESULTS.GRANTED);
  }
  return true;
}

// ── App ───────────────────────────────────────────────────────────────────────

const NFC_STATE = { INIT: 'init', IDLE: 'idle', SCANNING: 'scanning', SUCCESS: 'success', ERROR: 'error', UNSUPPORTED: 'unsupported' };

export default function App() {
  // NFC
  const [nfcState, setNfcState] = useState(NFC_STATE.INIT);
  const [tag, setTag] = useState(null);
  const [nfcError, setNfcError] = useState('');

  // Bluetooth
  const [btReady, setBtReady] = useState(false);
  const [btError, setBtError] = useState('');
  const [btConnected, setBtConnected] = useState(false);
  const [btDeviceName, setBtDeviceName] = useState('');
  const [pairedDevices, setPairedDevices] = useState([]);
  const [connecting, setConnecting] = useState(false);
  const [showDevices, setShowDevices] = useState(false);

  // Discoverable
  const [discoverableError, setDiscoverableError] = useState('');

  // Send status (NFC)
  const [sendStatus, setSendStatus] = useState(null); // null | 'sending' | 'ok' | 'error'
  const [sentText, setSentText] = useState('');
  const [reconnectFailed, setReconnectFailed] = useState(false);

  const sendStatusTimer = useRef(null);

  // Settings
  const [showSettings, setShowSettings] = useState(false);
  const [appendEnter, setAppendEnter] = useState(false);
  const [charSubstitutions, setCharSubstitutions] = useState([]);
  const [newSubFrom, setNewSubFrom] = useState('');
  const [newSubTo, setNewSubTo] = useState('');
  const [showAddSub, setShowAddSub] = useState(false);
  const [scanLine, setScanLine] = useState('all'); // 'all' | '1' | '2' | '3'

  // Barcode / QR
  const [bcScanning, setBcScanning] = useState(false);
  const [bcData, setBcData] = useState(null);
  const [bcError, setBcError] = useState('');
  const [bcSendStatus, setBcSendStatus] = useState(null);
  const [bcSentText, setBcSentText] = useState('');
  const bcScannedRef = useRef(false);
  const bcSendStatusTimer = useRef(null);

  // ── Init ────────────────────────────────────────────────────────────────────

  useEffect(() => {
    NfcManager.start()
      .then(() => NfcManager.isSupported())
      .then(supported => setNfcState(supported ? NFC_STATE.IDLE : NFC_STATE.UNSUPPORTED))
      .catch(() => setNfcState(NFC_STATE.UNSUPPORTED));

    initBluetooth();

    if (HIDKeyboardModule?.getPreference) {
      HIDKeyboardModule.getPreference('appendEnter')
        .then(v => { if (v === 'true') setAppendEnter(true); })
        .catch(() => {});
      HIDKeyboardModule.getPreference('charSubstitutions')
        .then(v => { if (v) setCharSubstitutions(JSON.parse(v)); })
        .catch(() => {});
      HIDKeyboardModule.getPreference('scanLine')
        .then(v => { if (v) setScanLine(v); })
        .catch(() => {});
    }

    return () => {
      NfcManager.cancelTechnologyRequest().catch(() => {});
    };
  }, []);

  function toggleAppendEnter(value) {
    setAppendEnter(value);
    if (HIDKeyboardModule?.setPreference) {
      HIDKeyboardModule.setPreference('appendEnter', String(value)).catch(() => {});
    }
  }

  function saveSubstitutions(rules) {
    setCharSubstitutions(rules);
    if (HIDKeyboardModule?.setPreference) {
      HIDKeyboardModule.setPreference('charSubstitutions', JSON.stringify(rules)).catch(() => {});
    }
  }

  function applyLineFilter(text) {
    if (scanLine === 'all') return text;
    const lines = text.split('\n');
    const idx = parseInt(scanLine, 10) - 1;
    return lines[idx] ?? '';
  }

  function applySubstitutions(text) {
    return charSubstitutions.reduce(
      (t, rule) => (rule.from ? t.split(rule.from).join(rule.to) : t),
      text
    );
  }

  function prepareText(text) {
    return applySubstitutions(applyLineFilter(text));
  }

  function toggleScanLine(value) {
    setScanLine(value);
    if (HIDKeyboardModule?.setPreference) {
      HIDKeyboardModule.setPreference('scanLine', value).catch(() => {});
    }
  }

  async function initBluetooth() {
    setBtError('');
    if (!HIDKeyboardModule) {
      setBtError('HID module not loaded. Rebuild the app.');
      return;
    }
    const granted = await requestBtPermissions();
    if (!granted) {
      setBtError('Bluetooth permissions denied. Enable them in Settings.');
      return;
    }
    try {
      await HIDKeyboardModule.initialize();
      await HIDKeyboardModule.startForegroundService();
      setBtReady(true);
      const saved = await HIDKeyboardModule.getSavedDevice();
      if (saved) {
        setBtDeviceName(saved.name);
      }
    } catch (e) {
      setBtError(e?.message || 'Failed to initialize Bluetooth HID');
    }
  }

  const connectTimeoutRef = useRef(null);

  useEffect(() => {
    if (!hidEmitter) return;
    const subConn = hidEmitter.addListener('HIDConnectionState', event => {
      clearTimeout(connectTimeoutRef.current);
      if (event.status === 'connected') {
        setBtConnected(true);
        setBtDeviceName(event.device);
        setShowDevices(false);
        setConnecting(false);
        setBtError('');
        setReconnectFailed(false);
      } else if (event.status === 'reconnect_failed') {
        setBtConnected(false);
        setConnecting(false);
        setReconnectFailed(true);
        setBtError('Could not reconnect. Use "Force reconnect" or re-pair the device.');
      } else {
        setBtConnected(false);
        setConnecting(false);
      }
    });
    const subApp = hidEmitter.addListener('HIDAppStatus', () => {
      // App auto re-registers on unregister — no UI action needed
    });
    return () => { subConn.remove(); subApp.remove(); };
  }, []);

  // ── Bluetooth actions ────────────────────────────────────────────────────────

  async function loadPairedDevices() {
    if (!HIDKeyboardModule) return;
    try {
      const devices = await HIDKeyboardModule.getPairedDevices();
      setPairedDevices(devices);
      setShowDevices(true);
    } catch (e) {}
  }

  async function connectDevice(address, name) {
    setConnecting(true);
    setBtDeviceName(name);
    setBtError('');
    try {
      await HIDKeyboardModule.connectToHost(address);
      // connection result comes via HIDConnectionState event
      connectTimeoutRef.current = setTimeout(() => {
        setConnecting(false);
        setBtError('No response from PC. Make sure Windows finished installing the HID driver (wait 1 min and retry).');
      }, 12000);
    } catch (e) {
      setConnecting(false);
      setBtDeviceName('');
      setBtError(e?.message || 'Connection error');
    }
  }

  async function disconnect() {
    try {
      await HIDKeyboardModule.disconnect();
      setBtConnected(false);
      setBtDeviceName('');
      setReconnectFailed(false);
    } catch (e) {}
  }

  async function forceReconnect() {
    setReconnectFailed(false);
    setBtError('');
    setConnecting(true);
    try {
      await HIDKeyboardModule.forceReconnect();
      connectTimeoutRef.current = setTimeout(() => {
        setConnecting(false);
        setBtError('No response. If the issue persists, re-pair the device from scratch.');
      }, 15000);
    } catch (e) {
      setConnecting(false);
      setBtError(e?.message || 'Force reconnect failed');
    }
  }

  // ── Barcode / QR scan ────────────────────────────────────────────────────────

  async function startBarcodeSccan() {
    setBcData(null);
    setBcError('');
    setBcSendStatus(null);
    setBcSentText('');
    const { status } = await BarCodeScanner.requestPermissionsAsync();
    if (status !== 'granted') {
      setBcError('Camera permission denied. Enable it in Settings.');
      return;
    }
    bcScannedRef.current = false;
    setBcScanning(true);
  }

  async function handleBarCodeScanned({ type, data }) {
    if (bcScannedRef.current) return;
    bcScannedRef.current = true;
    setBcScanning(false);
    setBcData({ type, data });
    if (btConnected && HIDKeyboardModule) {
      await sendBarcodeText(data);
    }
  }

  async function sendBarcodeText(text) {
    const final = prepareText(text);
    setBcSendStatus('sending');
    setBcSentText(final);
    clearTimeout(bcSendStatusTimer.current);
    try {
      await HIDKeyboardModule.sendKeystrokes(appendEnter ? final + '\n' : final);
      setBcSendStatus('ok');
    } catch (e) {
      setBcSendStatus('error');
    }
    bcSendStatusTimer.current = setTimeout(() => setBcSendStatus(null), 4000);
  }

  async function sendBarcodeManually() {
    if (!bcData || !btConnected) return;
    await sendBarcodeText(bcData.data);
  }

  // ── NFC scan ─────────────────────────────────────────────────────────────────

  async function startScan() {
    setTag(null);
    setNfcError('');
    setSendStatus(null);
    setSentText('');
    setNfcState(NFC_STATE.SCANNING);
    try {
      await NfcManager.requestTechnology(
        [NfcTech.Ndef, NfcTech.NfcA, NfcTech.NfcB, NfcTech.NfcF, NfcTech.NfcV],
        { alertMessage: 'Hold NFC tag close' }
      );
      const detected = await NfcManager.getTag();
      setTag(detected);
      setNfcState(NFC_STATE.SUCCESS);

      // Auto-send if BT connected
      if (btConnected && HIDKeyboardModule) {
        const text = extractTextFromTag(detected);
        if (text) {
          await sendText(text);
        }
      }
    } catch (e) {
      const msg = e?.message ?? '';
      if (msg === 'cancelled' || msg === 'UserCancel') {
        setNfcState(NFC_STATE.IDLE);
      } else {
        setNfcError(msg || 'Could not read tag');
        setNfcState(NFC_STATE.ERROR);
      }
    } finally {
      NfcManager.cancelTechnologyRequest().catch(() => {});
    }
  }

  async function sendText(text) {
    const final = prepareText(text);
    setSendStatus('sending');
    setSentText(final);
    clearTimeout(sendStatusTimer.current);
    try {
      await HIDKeyboardModule.sendKeystrokes(appendEnter ? final + '\n' : final);
      setSendStatus('ok');
    } catch (e) {
      setSendStatus('error');
    }
    sendStatusTimer.current = setTimeout(() => setSendStatus(null), 4000);
  }

  async function sendManually() {
    if (!tag || !btConnected) return;
    const text = extractTextFromTag(tag);
    if (text) await sendText(text);
  }

  const cancelScan = () => {
    NfcManager.cancelTechnologyRequest().catch(() => {});
    setNfcState(NFC_STATE.IDLE);
  };

  const resetAll = () => {
    setTag(null);
    setNfcError('');
    setSendStatus(null);
    setSentText('');
    setNfcState(NFC_STATE.IDLE);
    setBcData(null);
    setBcError('');
    setBcSendStatus(null);
    setBcSentText('');
  };

  // ── Render ────────────────────────────────────────────────────────────────────

  if (nfcState === NFC_STATE.INIT) {
    return (
      <SafeAreaView style={styles.container}>
        <ActivityIndicator size="large" color="#1565c0" style={{ marginTop: 80 }} />
        <Text style={styles.initText}>Starting...</Text>
      </SafeAreaView>
    );
  }

  const tagRecords = decodeNdefRecords(tag);
  const tagText = extractTextFromTag(tag);

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar style="auto" />

      {/* ── Settings modal ── */}
      <Modal visible={showSettings} animationType="slide" transparent={true} onRequestClose={() => setShowSettings(false)}>
        <View style={styles.settingsOverlay}>
          <View style={styles.settingsPanel}>
            <View style={styles.settingsHeader}>
              <Text style={styles.settingsPanelTitle}>Settings</Text>
              <TouchableOpacity onPress={() => setShowSettings(false)} style={styles.settingsCloseBtn}>
                <Text style={styles.settingsCloseText}>✕</Text>
              </TouchableOpacity>
            </View>
            <ScrollView showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">

            <View style={styles.settingRow}>
              <View style={styles.settingInfo}>
                <Text style={styles.settingLabel}>Append Enter after scan</Text>
                <Text style={styles.settingDesc}>Sends Enter automatically after the scanned text</Text>
              </View>
              <Switch
                value={appendEnter}
                onValueChange={toggleAppendEnter}
                trackColor={{ false: '#ccc', true: '#1565c0' }}
                thumbColor="#fff"
              />
            </View>

            {/* Send line selector */}
            <View style={styles.settingRow}>
              <View style={styles.settingInfo}>
                <Text style={styles.settingLabel}>Send line</Text>
                <Text style={styles.settingDesc}>Which line of the scanned text to send</Text>
              </View>
              <View style={styles.linePickerRow}>
                {['all', '1', '2', '3'].map(opt => (
                  <TouchableOpacity
                    key={opt}
                    style={[styles.lineChip, scanLine === opt && styles.lineChipActive]}
                    onPress={() => toggleScanLine(opt)}
                  >
                    <Text style={[styles.lineChipText, scanLine === opt && styles.lineChipTextActive]}>
                      {opt === 'all' ? 'All' : opt}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
            </View>

            {/* Character substitutions */}
            <View style={styles.subSection}>
              <Text style={styles.subSectionTitle}>Character substitutions</Text>
              <Text style={styles.subSectionDesc}>Replace text in scanned output before sending</Text>
            </View>

            {charSubstitutions.length === 0 && !showAddSub && (
              <Text style={styles.subEmpty}>No substitutions defined</Text>
            )}

            {charSubstitutions.map((rule, i) => (
              <View key={i} style={styles.subRuleRow}>
                <Text style={styles.subRuleFrom}>"{rule.from}"</Text>
                <Text style={styles.subRuleArrow}> → </Text>
                <Text style={styles.subRuleTo}>"{rule.to}"</Text>
                <TouchableOpacity
                  style={styles.subDeleteBtn}
                  onPress={() => saveSubstitutions(charSubstitutions.filter((_, j) => j !== i))}
                >
                  <Text style={styles.subDeleteText}>✕</Text>
                </TouchableOpacity>
              </View>
            ))}

            {showAddSub ? (
              <View style={styles.subAddForm}>
                <View style={styles.subAddRow}>
                  <TextInput
                    style={styles.subInput}
                    placeholder="Replace"
                    value={newSubFrom}
                    onChangeText={setNewSubFrom}
                    autoCapitalize="none"
                    autoCorrect={false}
                  />
                  <Text style={styles.subArrow}>→</Text>
                  <TextInput
                    style={styles.subInput}
                    placeholder="With (empty = delete)"
                    value={newSubTo}
                    onChangeText={setNewSubTo}
                    autoCapitalize="none"
                    autoCorrect={false}
                  />
                </View>
                <View style={styles.subAddBtns}>
                  <TouchableOpacity
                    style={[styles.subBtn, !newSubFrom && styles.subBtnDisabled]}
                    disabled={!newSubFrom}
                    onPress={() => {
                      if (!newSubFrom) return;
                      saveSubstitutions([...charSubstitutions, { from: newSubFrom, to: newSubTo }]);
                      setNewSubFrom('');
                      setNewSubTo('');
                      setShowAddSub(false);
                    }}
                  >
                    <Text style={styles.subBtnText}>Add</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.subBtn, styles.subBtnSecondary]}
                    onPress={() => { setShowAddSub(false); setNewSubFrom(''); setNewSubTo(''); }}
                  >
                    <Text style={styles.subBtnSecondaryText}>Cancel</Text>
                  </TouchableOpacity>
                </View>
              </View>
            ) : (
              <TouchableOpacity style={styles.subAddTrigger} onPress={() => setShowAddSub(true)}>
                <Text style={styles.subAddTriggerText}>+ Add substitution</Text>
              </TouchableOpacity>
            )}
            </ScrollView>
          </View>
        </View>
      </Modal>

      <View style={styles.headerRow}>
        <Text style={styles.title}>NFC Keyboard</Text>
        <TouchableOpacity style={styles.settingsIconBtn} onPress={() => setShowSettings(true)}>
          <Text style={styles.settingsIcon}>⚙</Text>
        </TouchableOpacity>
      </View>

      <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>

        {/* ── Bluetooth Section ── */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Bluetooth</Text>

          {!btReady ? (
            <View>
              <Text style={styles.errorText}>
                {btError || 'HID not available (requires Android 9+)'}
              </Text>
              {btError ? (
                <TouchableOpacity style={[styles.smallBtn, { marginTop: 10, alignSelf: 'flex-start' }]} onPress={initBluetooth}>
                  <Text style={styles.smallBtnText}>Retry</Text>
                </TouchableOpacity>
              ) : null}
            </View>
          ) : btConnected ? (
            <View style={styles.connectedRow}>
              <View style={styles.dot} />
              <Text style={styles.connectedText}>Connected: <Text style={styles.deviceName}>{btDeviceName}</Text></Text>
              <TouchableOpacity style={styles.smallBtn} onPress={disconnect}>
                <Text style={styles.smallBtnText}>Disconnect</Text>
              </TouchableOpacity>
            </View>
          ) : connecting ? (
            <View>
              <View style={styles.connectedRow}>
                <ActivityIndicator size="small" color="#1565c0" />
                <Text style={[styles.mutedText, { marginLeft: 8 }]}>Connecting to {btDeviceName}...</Text>
              </View>
              {btError ? <Text style={[styles.errorText, { marginTop: 6 }]}>{btError}</Text> : null}
            </View>
          ) : (
            <View>
              <View style={styles.disconnectedRow}>
                <View style={[styles.dot, styles.dotOff]} />
                <Text style={styles.mutedText}>Disconnected</Text>
                <TouchableOpacity style={styles.smallBtn} onPress={loadPairedDevices}>
                  <Text style={styles.smallBtnText}>View devices</Text>
                </TouchableOpacity>
              </View>
              {reconnectFailed && (
                <TouchableOpacity
                  style={[styles.smallBtn, { marginTop: 8, alignSelf: 'flex-start', backgroundColor: '#fff3e0' }]}
                  onPress={forceReconnect}
                >
                  <Text style={[styles.smallBtnText, { color: '#e65100' }]}>Force reconnect</Text>
                </TouchableOpacity>
              )}
              {btError ? <Text style={[styles.errorText, { marginTop: 6 }]}>{btError}</Text> : null}
              {showDevices && (
                <View style={styles.deviceList}>
                  {pairedDevices.length === 0 ? (
                    <Text style={styles.mutedText}>No paired devices</Text>
                  ) : (
                    pairedDevices.map(d => (
                      <TouchableOpacity
                        key={d.address}
                        style={styles.deviceRow}
                        onPress={() => connectDevice(d.address, d.name)}
                      >
                        <Text style={styles.deviceRowName}>{d.name}</Text>
                        <Text style={styles.deviceRowAddr}>{d.address}</Text>
                      </TouchableOpacity>
                    ))
                  )}
                </View>
              )}
              <TouchableOpacity
                style={[styles.smallBtn, { marginTop: 10, alignSelf: 'flex-start', backgroundColor: '#fce4ec' }]}
                onPress={async () => {
                  setDiscoverableError('');
                  try {
                    await HIDKeyboardModule.makeDiscoverable();
                  } catch (e) {
                    setDiscoverableError(e?.message || 'Failed to enable discoverability');
                  }
                }}
              >
                <Text style={[styles.smallBtnText, { color: '#c62828' }]}>Make visible to PC (5 min)</Text>
              </TouchableOpacity>
              {discoverableError ? (
                <Text style={[styles.errorText, { marginTop: 6 }]}>{discoverableError}</Text>
              ) : null}
              <Text style={styles.hint}>
                Tap "Make visible to PC", accept the system dialog, then on Windows: Bluetooth → Add device → Bluetooth → find "NFC Keyboard"
              </Text>
            </View>
          )}
        </View>

        {/* ── Barcode / QR Section ── */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Barcode / QR</Text>

          {bcError ? <Text style={styles.errorText}>{bcError}</Text> : null}

          {bcData && (
            <View style={styles.tagBox}>
              <View style={styles.record}>
                <Text style={styles.recordKind}>{String(bcData.type).split('.').pop()}</Text>
                <Text style={styles.recordValue}>{bcData.data}</Text>
              </View>

              {bcSendStatus === 'sending' && (
                <View style={styles.sendRow}>
                  <ActivityIndicator size="small" color="#1565c0" />
                  <Text style={styles.sendingText}>Sending...</Text>
                </View>
              )}
              {bcSendStatus === 'ok' && (
                <View style={[styles.sendRow, styles.sendOk]}>
                  <Text style={styles.sendOkText}>✓ Sent: "{bcSentText.length > 30 ? bcSentText.slice(0, 30) + '…' : bcSentText}"</Text>
                </View>
              )}
              {bcSendStatus === 'error' && (
                <View style={[styles.sendRow, styles.sendErr]}>
                  <Text style={styles.sendErrText}>Send error</Text>
                </View>
              )}

              {btConnected && bcSendStatus === null && (
                <TouchableOpacity style={styles.sendBtn} onPress={sendBarcodeManually}>
                  <Text style={styles.sendBtnText}>Send "{bcData.data.length > 30 ? bcData.data.slice(0, 30) + '…' : bcData.data}"</Text>
                </TouchableOpacity>
              )}
              {!btConnected && (
                <Text style={[styles.hint, { marginTop: 8 }]}>Connect Bluetooth to send to PC</Text>
              )}
            </View>
          )}
        </View>

        {/* ── NFC Section ── */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>NFC</Text>

          {nfcState === NFC_STATE.UNSUPPORTED && (
            <Text style={styles.errorText}>NFC not available on this device</Text>
          )}

          {nfcState === NFC_STATE.SCANNING && (
            <View style={styles.scanningBox}>
              <Text style={styles.scanningText}>Hold NFC tag close...</Text>
            </View>
          )}

          {nfcState === NFC_STATE.ERROR && (
            <Text style={styles.errorText}>{nfcError}</Text>
          )}

          {tag && (
            <View style={styles.tagBox}>
              <View style={styles.row}>
                <Text style={styles.label}>ID</Text>
                <Text style={styles.value}>{tagIdToHex(tag.id)}</Text>
              </View>
              <View style={styles.row}>
                <Text style={styles.label}>Technology</Text>
                <Text style={styles.value}>{(tag.techTypes || []).map(t => t.split('.').pop()).join(', ') || 'N/A'}</Text>
              </View>

              {tagRecords.length > 0 ? (
                tagRecords.map(r => (
                  <View key={r.index} style={styles.record}>
                    <Text style={styles.recordKind}>{r.kind}</Text>
                    <Text style={styles.recordValue}>{r.value}</Text>
                  </View>
                ))
              ) : (
                <Text style={styles.mutedText}>No NDEF data</Text>
              )}

              {/* Send status */}
              {sendStatus === 'sending' && (
                <View style={styles.sendRow}>
                  <ActivityIndicator size="small" color="#1565c0" />
                  <Text style={styles.sendingText}>Sending...</Text>
                </View>
              )}
              {sendStatus === 'ok' && (
                <View style={[styles.sendRow, styles.sendOk]}>
                  <Text style={styles.sendOkText}>✓ Sent: "{sentText}"</Text>
                </View>
              )}
              {sendStatus === 'error' && (
                <View style={[styles.sendRow, styles.sendErr]}>
                  <Text style={styles.sendErrText}>Send error</Text>
                </View>
              )}

              {/* Manual send button if connected but auto-send didn't fire */}
              {btConnected && tagText && sendStatus === null && (
                <TouchableOpacity style={styles.sendBtn} onPress={sendManually}>
                  <Text style={styles.sendBtnText}>Send "{tagText.length > 30 ? tagText.slice(0, 30) + '…' : tagText}"</Text>
                </TouchableOpacity>
              )}
              {!btConnected && tagText && (
                <Text style={[styles.hint, { marginTop: 8 }]}>Connect Bluetooth to send to PC</Text>
              )}
            </View>
          )}
        </View>
      </ScrollView>

      {/* ── Barcode camera modal ── */}
      <Modal visible={bcScanning} animationType="slide" onRequestClose={() => setBcScanning(false)}>
        <View style={styles.scannerContainer}>
          <BarCodeScanner
            onBarCodeScanned={handleBarCodeScanned}
            style={StyleSheet.absoluteFillObject}
          />
          <View style={styles.scannerOverlay}>
            <View style={styles.scannerFrame} />
            <Text style={styles.scannerHint}>Point camera at the code</Text>
            <TouchableOpacity style={styles.scannerCancelBtn} onPress={() => setBcScanning(false)}>
              <Text style={styles.scannerCancelText}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* ── Bottom action buttons ── */}
      {nfcState === NFC_STATE.SCANNING ? (
        <TouchableOpacity style={[styles.btn, styles.btnCancel]} onPress={cancelScan}>
          <Text style={styles.btnText}>Cancel</Text>
        </TouchableOpacity>
      ) : (nfcState === NFC_STATE.SUCCESS || bcData) ? (
        <TouchableOpacity style={styles.btn} onPress={resetAll}>
          <Text style={styles.btnText}>Scan again</Text>
        </TouchableOpacity>
      ) : (
        <View style={styles.btnRow}>
          <TouchableOpacity style={[styles.btn, styles.btnHalf]} onPress={startScan} disabled={nfcState === NFC_STATE.UNSUPPORTED}>
            <Text style={styles.btnText}>Scan NFC</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[styles.btn, styles.btnHalf, styles.btnBarcode]} onPress={startBarcodeSccan}>
            <Text style={styles.btnText}>Scan Barcode / QR</Text>
          </TouchableOpacity>
        </View>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f0f2f5', alignItems: 'stretch', paddingHorizontal: 16, paddingBottom: 20 },
  headerRow: { flexDirection: 'row', alignItems: 'center', marginTop: 20, marginBottom: 16 },
  title: { flex: 1, fontSize: 26, fontWeight: '700', color: '#111', textAlign: 'center' },
  settingsIconBtn: { position: 'absolute', right: 0, padding: 8 },
  settingsIcon: { fontSize: 22, color: '#555' },

  // Settings modal
  settingsOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'flex-end' },
  settingsPanel: { backgroundColor: '#fff', borderTopLeftRadius: 20, borderTopRightRadius: 20, paddingHorizontal: 20, paddingBottom: 40, maxHeight: '80%' },
  settingsHeader: { flexDirection: 'row', alignItems: 'center', paddingVertical: 16, borderBottomWidth: 1, borderBottomColor: '#eee', marginBottom: 8 },
  settingsPanelTitle: { flex: 1, fontSize: 17, fontWeight: '700', color: '#111' },
  settingsCloseBtn: { padding: 4 },
  settingsCloseText: { fontSize: 18, color: '#888' },
  settingRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: '#f0f0f0' },
  settingInfo: { flex: 1, marginRight: 12 },
  settingLabel: { fontSize: 15, fontWeight: '600', color: '#111' },
  settingDesc: { fontSize: 12, color: '#888', marginTop: 2 },

  // Line picker
  linePickerRow: { flexDirection: 'row', gap: 6 },
  lineChip: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 20, borderWidth: 1, borderColor: '#ddd', backgroundColor: '#f5f5f5' },
  lineChipActive: { backgroundColor: '#1565c0', borderColor: '#1565c0' },
  lineChipText: { fontSize: 13, fontWeight: '600', color: '#555' },
  lineChipTextActive: { color: '#fff' },

  // Character substitutions
  subSection: { paddingTop: 18, paddingBottom: 6 },
  subSectionTitle: { fontSize: 13, fontWeight: '700', color: '#444' },
  subSectionDesc: { fontSize: 11, color: '#aaa', marginTop: 2 },
  subEmpty: { fontSize: 12, color: '#bbb', fontStyle: 'italic', paddingVertical: 8 },
  subRuleRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: '#f5f5f5' },
  subRuleFrom: { fontSize: 14, color: '#c62828', fontFamily: 'monospace', fontWeight: '600' },
  subRuleArrow: { fontSize: 14, color: '#888', marginHorizontal: 2 },
  subRuleTo: { fontSize: 14, color: '#2e7d32', fontFamily: 'monospace', fontWeight: '600', flex: 1 },
  subDeleteBtn: { padding: 6 },
  subDeleteText: { fontSize: 15, color: '#ccc' },
  subAddForm: { paddingTop: 10 },
  subAddRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 10 },
  subInput: { flex: 1, borderWidth: 1, borderColor: '#ddd', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8, fontSize: 14, fontFamily: 'monospace', backgroundColor: '#fafafa' },
  subArrow: { fontSize: 18, color: '#888' },
  subAddBtns: { flexDirection: 'row', gap: 8 },
  subBtn: { flex: 1, backgroundColor: '#1565c0', borderRadius: 8, paddingVertical: 10, alignItems: 'center' },
  subBtnDisabled: { backgroundColor: '#c5cae9' },
  subBtnText: { color: '#fff', fontWeight: '600', fontSize: 14 },
  subBtnSecondary: { backgroundColor: '#f5f5f5' },
  subBtnSecondaryText: { color: '#555', fontWeight: '600', fontSize: 14 },
  subAddTrigger: { marginTop: 10, paddingVertical: 12, alignItems: 'center', borderRadius: 8, borderWidth: 1, borderColor: '#e0e0e0', borderStyle: 'dashed' },
  subAddTriggerText: { fontSize: 13, color: '#1565c0', fontWeight: '600' },
  initText: { fontSize: 16, color: '#666', textAlign: 'center', marginTop: 12 },
  scroll: { flex: 1 },
  scrollContent: { paddingBottom: 8 },

  section: { backgroundColor: '#fff', borderRadius: 14, padding: 16, marginBottom: 14, shadowColor: '#000', shadowOpacity: 0.05, shadowRadius: 6, elevation: 2 },
  sectionTitle: { fontSize: 12, fontWeight: '700', color: '#888', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 12 },

  // BT connected
  connectedRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8 },
  dot: { width: 10, height: 10, borderRadius: 5, backgroundColor: '#2e7d32' },
  dotOff: { backgroundColor: '#bbb' },
  connectedText: { flex: 1, fontSize: 14, color: '#333' },
  deviceName: { fontWeight: '700', color: '#1565c0' },
  disconnectedRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  smallBtn: { backgroundColor: '#e8eaf6', borderRadius: 8, paddingHorizontal: 12, paddingVertical: 6, marginLeft: 'auto' },
  smallBtnText: { fontSize: 12, fontWeight: '600', color: '#3949ab' },

  deviceList: { marginTop: 10, borderTopWidth: 1, borderTopColor: '#eee', paddingTop: 8 },
  deviceRow: { paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: '#f0f0f0' },
  deviceRowName: { fontSize: 14, fontWeight: '600', color: '#1a1a1a' },
  deviceRowAddr: { fontSize: 11, color: '#999', fontFamily: 'monospace' },

  hint: { fontSize: 11, color: '#aaa', marginTop: 10, fontStyle: 'italic' },
  mutedText: { fontSize: 13, color: '#999' },

  // NFC
  scanningBox: { backgroundColor: '#e3f2fd', borderRadius: 10, paddingVertical: 16, alignItems: 'center', borderWidth: 1, borderColor: '#90caf9' },
  scanningText: { fontSize: 15, color: '#1565c0', fontWeight: '500' },
  errorText: { fontSize: 13, color: '#c62828', textAlign: 'center' },

  tagBox: { marginTop: 4 },
  row: { flexDirection: 'row', marginBottom: 6, flexWrap: 'wrap' },
  label: { fontSize: 12, fontWeight: '600', color: '#777', minWidth: 80, marginRight: 4 },
  value: { fontSize: 12, color: '#1a1a1a', flex: 1, fontFamily: 'monospace' },
  record: { backgroundColor: '#f5f5f5', borderRadius: 8, padding: 10, marginTop: 8, borderLeftWidth: 3, borderLeftColor: '#1565c0' },
  recordKind: { fontSize: 10, fontWeight: '700', color: '#1565c0', textTransform: 'uppercase', marginBottom: 2 },
  recordValue: { fontSize: 14, color: '#111', fontFamily: 'monospace' },

  // Send
  sendRow: { flexDirection: 'row', alignItems: 'center', marginTop: 12, padding: 10, borderRadius: 8, gap: 8 },
  sendingText: { fontSize: 13, color: '#1565c0' },
  sendOk: { backgroundColor: '#e8f5e9' },
  sendOkText: { fontSize: 13, color: '#2e7d32', fontWeight: '600', flex: 1 },
  sendErr: { backgroundColor: '#ffebee' },
  sendErrText: { fontSize: 13, color: '#c62828' },
  sendBtn: { backgroundColor: '#e3f2fd', borderRadius: 8, padding: 10, marginTop: 10, alignItems: 'center' },
  sendBtnText: { fontSize: 13, color: '#1565c0', fontWeight: '600' },

  // Main button
  btn: { backgroundColor: '#1565c0', borderRadius: 12, paddingVertical: 16, alignItems: 'center', marginTop: 8 },
  btnRow: { flexDirection: 'row', gap: 10, marginTop: 8 },
  btnHalf: { flex: 1 },
  btnBarcode: { backgroundColor: '#2e7d32' },
  btnCancel: { backgroundColor: '#757575' },
  btnText: { color: '#fff', fontSize: 16, fontWeight: '600' },

  // Barcode scanner modal
  scannerContainer: { flex: 1, backgroundColor: '#000' },
  scannerOverlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'space-between', paddingVertical: 60 },
  scannerFrame: { width: 240, height: 240, borderWidth: 2, borderColor: '#fff', borderRadius: 12, opacity: 0.7 },
  scannerHint: { color: '#fff', fontSize: 15, fontWeight: '500', textAlign: 'center', backgroundColor: 'rgba(0,0,0,0.5)', paddingHorizontal: 16, paddingVertical: 6, borderRadius: 8 },
  scannerCancelBtn: { backgroundColor: '#fff', borderRadius: 12, paddingVertical: 14, paddingHorizontal: 48 },
  scannerCancelText: { color: '#1a1a1a', fontWeight: '700', fontSize: 16 },
});
