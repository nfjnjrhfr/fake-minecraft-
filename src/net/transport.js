// 連線層。三種管道共用同一個介面，遊戲邏輯完全不用管底下是什麼：
//
//   send(bytes)            送出一則訊息（自動分片）
//   onMessage = (bytes)=>{} 收到完整訊息
//   onStatus  = (s,msg)=>{} 連線狀態變化
//   close()
//
//  1. BluetoothTransport  —— Web Bluetooth GATT + Nordic UART Service。
//     瀏覽器只能當 central（不能廣播成周邊裝置），所以兩支手機直連需要一顆
//     BLE 中繼（tools/esp32-ble-relay 有現成韌體），雙方都連上同一顆中繼即可。
//  2. ChannelTransport    —— 同一台機器兩個分頁／視窗，用來測試與雙人同機。
//  3. WebRTCTransport     —— 手動貼上 offer/answer，不需要伺服器，同 WiFi 直連。

import { fragment, Reassembler, DEFAULT_MTU } from './protocol.js';

export const STATUS = {
  IDLE: 'idle',
  SCANNING: 'scanning',
  CONNECTING: 'connecting',
  CONNECTED: 'connected',
  DISCONNECTED: 'disconnected',
  ERROR: 'error',
};

class BaseTransport {
  constructor() {
    this.onMessage = () => {};
    this.onStatus = () => {};
    this.reasm = new Reassembler();
    this.mtu = DEFAULT_MTU;
    this.status = STATUS.IDLE;
    this.stats = { sent: 0, received: 0, bytesSent: 0, bytesReceived: 0, drops: 0 };
  }
  setStatus(s, msg) {
    this.status = s;
    this.onStatus(s, msg);
  }
  /** 收到原始片段時呼叫。 */
  handleRaw(bytes) {
    this.stats.received++;
    this.stats.bytesReceived += bytes.length;
    const msg = this.reasm.push(bytes);
    if (msg) this.onMessage(msg);
  }
  get connected() { return this.status === STATUS.CONNECTED; }
}

// ---------------------------------------------------------------------------
// 1. 藍牙（Web Bluetooth / Nordic UART Service）
// ---------------------------------------------------------------------------

export const NUS = {
  service: '6e400001-b5a3-f393-e0a9-e50e24dcca9e',
  rx: '6e400002-b5a3-f393-e0a9-e50e24dcca9e',   // 我方寫入（對方讀）
  tx: '6e400003-b5a3-f393-e0a9-e50e24dcca9e',   // 通知（我方讀）
};

export class BluetoothTransport extends BaseTransport {
  constructor() {
    super();
    this.device = null;
    this.rxChar = null;
    this.queue = [];
    this.flushing = false;
  }

  /**
   * 藍牙到底能不能用，以及不能用的話是卡在哪一關。
   *
   * 只檢查 navigator.bluetooth 存不存在是不夠的：頁面被嵌在 iframe 裡時
   * API 物件照樣存在，但只要外層沒有用 allow="bluetooth" 授權，
   * requestDevice() 就會丟 SecurityError。那種情況要先講清楚，
   * 不能讓使用者按下去才看到看不懂的錯誤。
   *
   * @returns {{ ok: boolean, reason?: string, detail?: string }}
   */
  static get availability() {
    if (typeof navigator === 'undefined' || !navigator.bluetooth) {
      return {
        ok: false, reason: 'unsupported',
        detail: '這個瀏覽器沒有 Web Bluetooth。Safari 與 Firefox 都沒有實作，'
              + '而 iPhone 上所有瀏覽器都是用 Safari 的引擎，所以 iOS 一律不能用。'
              + '請改用電腦版 Chrome / Edge，或 Android 版 Chrome。',
      };
    }
    if (typeof window !== 'undefined' && !window.isSecureContext) {
      return {
        ok: false, reason: 'insecure',
        detail: '藍牙只在安全來源下開放。請用 HTTPS 網址，或在本機跑 localhost。',
      };
    }
    // Permissions Policy：被 iframe 包住而且沒被授權時，這裡會回 false
    const policy = (typeof document !== 'undefined')
      ? (document.permissionsPolicy || document.featurePolicy) : null;
    if (policy?.allowsFeature && !policy.allowsFeature('bluetooth')) {
      return {
        ok: false, reason: 'blocked',
        detail: '這個頁面被嵌在 iframe 裡，而外層沒有把藍牙權限授權下來'
              + '（需要 allow="bluetooth"）。請把遊戲下載到本機執行，'
              + '或改用「同網路直連」。',
      };
    }
    return { ok: true };
  }

  static get available() {
    return BluetoothTransport.availability.ok;
  }

  async connect(opts = {}) {
    const avail = BluetoothTransport.availability;
    if (!avail.ok) {
      this.setStatus(STATUS.ERROR, avail.detail);
      throw new Error(`Web Bluetooth unavailable: ${avail.reason}`);
    }
    this.setStatus(STATUS.SCANNING, '搜尋藍牙裝置中…');
    try {
      this.device = await navigator.bluetooth.requestDevice({
        filters: opts.namePrefix
          ? [{ namePrefix: opts.namePrefix }, { services: [NUS.service] }]
          : [{ services: [NUS.service] }],
        optionalServices: [NUS.service],
      });
    } catch (err) {
      // requestDevice 的失敗原因差很多，分開講才幫得上忙
      switch (err.name) {
        case 'NotFoundError':
          // 使用者按取消，或是掃不到任何符合的裝置
          this.setStatus(STATUS.IDLE,
            '沒有選到裝置。請確認 BLE 中繼已經開機並在廣播'
            + '（韌體在 tools/esp32-ble-relay）。');
          break;
        case 'SecurityError':
          this.setStatus(STATUS.ERROR,
            '瀏覽器擋下了藍牙存取，通常是頁面被嵌在沒有授權的 iframe 裡，'
            + '或不是安全來源。請改在本機執行。');
          break;
        case 'NotSupportedError':
          this.setStatus(STATUS.ERROR, '這台裝置的藍牙介面卡不支援，或藍牙沒有開啟。');
          break;
        default:
          this.setStatus(STATUS.ERROR, `藍牙錯誤：${err.name} — ${err.message}`);
      }
      throw err;
    }

    this.device.addEventListener('gattserverdisconnected', () => {
      this.setStatus(STATUS.DISCONNECTED, '藍牙連線中斷');
    });

    this.setStatus(STATUS.CONNECTING, `連線到 ${this.device.name || '裝置'}…`);
    const server = await this.device.gatt.connect();
    const service = await server.getPrimaryService(NUS.service);
    this.rxChar = await service.getCharacteristic(NUS.rx);
    const txChar = await service.getCharacteristic(NUS.tx);

    await txChar.startNotifications();
    txChar.addEventListener('characteristicvaluechanged', (e) => {
      const dv = e.target.value;
      this.handleRaw(new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength));
    });

    // 部分平台能協商更大的 MTU，這裡保守用 20 保證相容
    this.mtu = opts.mtu || DEFAULT_MTU;
    this.setStatus(STATUS.CONNECTED, `已連線：${this.device.name || '藍牙裝置'}`);
    return this;
  }

  send(bytes) {
    if (!this.rxChar) return;
    for (const part of fragment(bytes, this.mtu)) this.queue.push(part);
    // 佇列太長代表塞車了，丟掉舊的狀態封包（丟包比延遲好）
    if (this.queue.length > 24) {
      this.stats.drops += this.queue.length - 12;
      this.queue.splice(0, this.queue.length - 12);
    }
    this.flush();
  }

  async flush() {
    if (this.flushing) return;
    this.flushing = true;
    while (this.queue.length) {
      const part = this.queue.shift();
      try {
        // 無回應寫入省一半來回時間；不支援就退回一般寫入
        if (this.rxChar.writeValueWithoutResponse) {
          await this.rxChar.writeValueWithoutResponse(part);
        } else {
          await this.rxChar.writeValue(part);
        }
        this.stats.sent++;
        this.stats.bytesSent += part.length;
      } catch (err) {
        this.stats.drops++;
        if (!this.device?.gatt?.connected) {
          this.setStatus(STATUS.DISCONNECTED, '藍牙連線中斷');
          break;
        }
      }
    }
    this.flushing = false;
  }

  close() {
    try { this.device?.gatt?.disconnect(); } catch { /* 已經斷了 */ }
    this.setStatus(STATUS.IDLE, '已離線');
  }
}

// ---------------------------------------------------------------------------
// 2. 同機分頁（BroadcastChannel）
// ---------------------------------------------------------------------------

export class ChannelTransport extends BaseTransport {
  constructor(roomName = 'sword-duel') {
    super();
    this.roomName = roomName;
    this.chan = null;
    this.mtu = 4096;     // 同機不用分片
  }

  static get available() {
    return typeof BroadcastChannel !== 'undefined';
  }

  async connect() {
    this.setStatus(STATUS.CONNECTING, '等待另一個分頁…');
    this.chan = new BroadcastChannel(this.roomName);
    this.chan.onmessage = (e) => {
      if (e.data instanceof ArrayBuffer) this.handleRaw(new Uint8Array(e.data));
      else if (ArrayBuffer.isView(e.data)) this.handleRaw(new Uint8Array(e.data.buffer));
    };
    this.setStatus(STATUS.CONNECTED, `房間：${this.roomName}`);
    return this;
  }

  send(bytes) {
    if (!this.chan) return;
    // BroadcastChannel 會複製 buffer，直接送整包
    this.chan.postMessage(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    this.stats.sent++;
    this.stats.bytesSent += bytes.length;
  }

  close() {
    this.chan?.close();
    this.chan = null;
    this.setStatus(STATUS.IDLE, '已關閉');
  }
}

// ---------------------------------------------------------------------------
// 3. WebRTC（手動交換連線碼，不需要伺服器）
// ---------------------------------------------------------------------------

export class WebRTCTransport extends BaseTransport {
  constructor() {
    super();
    this.pc = null;
    this.dc = null;
    this.mtu = 4096;
  }

  static get available() {
    return typeof RTCPeerConnection !== 'undefined';
  }

  _setupChannel(dc) {
    this.dc = dc;
    dc.binaryType = 'arraybuffer';
    dc.onopen = () => this.setStatus(STATUS.CONNECTED, 'WebRTC 已連線');
    dc.onclose = () => this.setStatus(STATUS.DISCONNECTED, 'WebRTC 已中斷');
    dc.onmessage = (e) => this.handleRaw(new Uint8Array(e.data));
  }

  _newPeer() {
    // 只走本地網路候選，同一個 WiFi 下不需要 STUN
    this.pc = new RTCPeerConnection({ iceServers: [] });
    return this.pc;
  }

  /** 房主：產生邀請碼。 */
  async createOffer() {
    this.setStatus(STATUS.CONNECTING, '產生邀請碼…');
    const pc = this._newPeer();
    this._setupChannel(pc.createDataChannel('duel', {
      ordered: false, maxRetransmits: 0,   // 即時對戰重傳沒意義
    }));
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await this._waitIce(pc);
    return compressSdp(pc.localDescription);
  }

  /** 加入者：吃下邀請碼，產生回應碼。 */
  async acceptOffer(code) {
    this.setStatus(STATUS.CONNECTING, '解析邀請碼…');
    const pc = this._newPeer();
    pc.ondatachannel = (e) => this._setupChannel(e.channel);
    await pc.setRemoteDescription(expandSdp(code, 'offer'));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await this._waitIce(pc);
    return compressSdp(pc.localDescription);
  }

  /** 房主：吃下回應碼，完成連線。 */
  async acceptAnswer(code) {
    await this.pc.setRemoteDescription(expandSdp(code, 'answer'));
  }

  _waitIce(pc) {
    return new Promise((resolve) => {
      if (pc.iceGatheringState === 'complete') return resolve();
      const done = () => {
        if (pc.iceGatheringState === 'complete') {
          pc.removeEventListener('icegatheringstatechange', done);
          resolve();
        }
      };
      pc.addEventListener('icegatheringstatechange', done);
      setTimeout(resolve, 2500);   // 收斂太慢就先用現有候選
    });
  }

  send(bytes) {
    if (this.dc?.readyState !== 'open') return;
    try {
      this.dc.send(bytes);
      this.stats.sent++;
      this.stats.bytesSent += bytes.length;
    } catch { this.stats.drops++; }
  }

  close() {
    try { this.dc?.close(); this.pc?.close(); } catch { /* 忽略 */ }
    this.setStatus(STATUS.IDLE, '已關閉');
  }
}

function compressSdp(desc) {
  return btoa(JSON.stringify({ t: desc.type, s: desc.sdp }))
    .replace(/\+/g, '-').replace(/\//g, '_');
}

function expandSdp(code, fallbackType) {
  const json = JSON.parse(atob(code.trim().replace(/-/g, '+').replace(/_/g, '/')));
  return { type: json.t || fallbackType, sdp: json.s };
}

// ---------------------------------------------------------------------------
// 4. 本機迴圈（單機測試用，直接把兩端接在一起）
// ---------------------------------------------------------------------------

export class LoopbackTransport extends BaseTransport {
  constructor(latencyMs = 40, lossRate = 0) {
    super();
    this.latency = latencyMs;
    this.loss = lossRate;
    this.peer = null;
    this.mtu = 4096;
  }
  static pair(latencyMs = 40, lossRate = 0) {
    const a = new LoopbackTransport(latencyMs, lossRate);
    const b = new LoopbackTransport(latencyMs, lossRate);
    a.peer = b; b.peer = a;
    a.setStatus(STATUS.CONNECTED, '本機迴圈');
    b.setStatus(STATUS.CONNECTED, '本機迴圈');
    return [a, b];
  }
  send(bytes) {
    if (!this.peer) return;
    if (Math.random() < this.loss) { this.stats.drops++; return; }
    const copy = bytes.slice();
    this.stats.sent++;
    setTimeout(() => this.peer.handleRaw(copy), this.latency);
  }
  close() { this.setStatus(STATUS.IDLE, '已關閉'); }
}
