# pyvpn

一個真正能用的 VPN：把整台機器的流量加密後經隧道送到伺服器，再由伺服器 NAT 出去連上**真實的網際網路**。

加密握手採 **Noise_IKpsk2**（X25519 + ChaCha20-Poly1305 + BLAKE2s），與 WireGuard 相同的密碼學構造；隧道走 Linux TUN 裝置，因此是完整的三層 VPN，不是只轉發某個 port 的 proxy。

```
   你的機器                                    VPN 伺服器                真實網際網路
┌──────────────┐                          ┌──────────────┐
│ 應用程式      │                          │              │
│    ↓         │                          │              │
│ 預設路由 →   │   加密後的 UDP           │   解密 →     │
│  TUN vpn0    │ ═══════════════════════▶ │  TUN vpn0    │──── NAT ────▶  8.8.8.8
│ 10.9.0.2     │  ChaCha20-Poly1305       │  10.9.0.1    │              one.one.one.one
└──────────────┘  誰都看不到內容           └──────────────┘                  ...
```

網站看到的來源 IP 是伺服器的 IP，不是你的。中間任何人（Wi-Fi、ISP）只看得到你和伺服器之間有加密的 UDP 封包在跑。

---

## 快速開始

```bash
pip install -r requirements.txt

# 先確認這台機器跑得動（不需要 root）
python3 -m pyvpn selftest
```

### 1. 產生設定

在任何一台機器上執行，把 `vpn.example.com` 換成伺服器的公開位址：

```bash
python3 -m pyvpn init --endpoint vpn.example.com:51820 --clients 2 --dns 1.1.1.1
```

會在 `./vpn-config/` 產生 `server.conf` 與 `client1.conf`、`client2.conf`，
金鑰、預共享金鑰、隧道位址都配好了（檔案權限 `0600`，裡面有私鑰）。

### 2. 啟動伺服器

把 `server.conf` 放到伺服器上（一台有公開 IP 的 Linux 主機），然後：

```bash
sudo python3 -m pyvpn server -c server.conf
```

伺服器會自動建立 TUN 介面、開啟 IPv4 轉發、掛上 NAT 規則。
記得在防火牆/雲端安全群組開放 **UDP 51820**。

### 3. 啟動客戶端

```bash
sudo python3 -m pyvpn client -c client1.conf
```

客戶端會把預設路由改道到隧道。驗證一下：

```bash
curl https://api.ipify.org      # 應該顯示伺服器的 IP
```

停掉程式（Ctrl-C）後，路由、DNS、防火牆規則都會自動還原。

---

## 實測：真的連到網際網路

`scripts/local_demo.py` 會在同一台機器上跑一整套真實環境：客戶端放在獨立的
network namespace（有自己的 TUN 和預設路由），透過 veth 連到主機上的伺服器。
那個 namespace **沒有其他對外路徑**，所以任何成功的連線都必定走過隧道。

```console
$ sudo python3 scripts/local_demo.py

1. host side: veth pair, tunnel interface and NAT
  [PASS] veth pyvpn-host (172.31.9.1) linked to the client namespace
  [PASS] server listening on UDP 172.31.9.1:51820 with NAT enabled

2. inside the client namespace, before the VPN is up
  [PASS] 1.1.1.1:443 is unreachable without the tunnel -- expected, the
         namespace has no other way out

3. bringing the tunnel up in the client namespace
  [PASS] encrypted session established with the server
         routes: 0.0.0.0/1 dev pyvpn0, 128.0.0.0/1 dev pyvpn0, ...

4. real traffic, from the namespace to the internet
  [PASS] DNS query to 8.8.8.8 resolved example.com to 104.20.23.154
  [PASS] TCP connection to 1.1.1.1:443 established
  [PASS] HTTPS request to one.one.one.one returned 206 bytes of content
  [PASS] the internet sees this traffic coming from 136.111.133.233
         -- the server's address, not the client's

The tunnel carried real internet traffic end to end.
```

---

## 加密設計

### 握手

每次連線都跑一次 Noise_IKpsk2，一來一回兩個封包就建立好工作階段：

```
發起方                                          回應方
  e, es, s, ss          ────────────▶
                        ◀────────────           e, ee, se, psk
```

得到的性質：

| 性質 | 怎麼來的 |
|---|---|
| 雙向身分驗證 | `ss` 與 `se` 兩次 DH 都必須用到對應的長期私鑰 |
| 前向保密 | 每次握手產生新的臨時金鑰，用完立刻銷毀（`_burn()`） |
| 發起方身分隱藏 | 發起方的公鑰是**加密**後才送出的，竊聽者看不到是誰在連 |
| 抗重放 | 每個 initiation 帶單調遞增的 TAI64N 時戳，回應方只接受更新的 |
| 額外一層防護 | 可選的預共享金鑰混入鏈金鑰，即使 X25519 被打破也還有一道 |
| 抗 DoS | `mac1` 讓伺服器在做任何橢圓曲線運算前就丟掉亂送的封包，另有每來源 IP 的速率限制 |

### 資料封包

```
type(1) reserved(3) receiver(4) counter(8) │ ChaCha20-Poly1305(payload + padding)
└──────────── 標頭同時是 AEAD 的 AAD ─────┘
```

- 每個封包一個遞增 counter 當 nonce，永不重複。
- 收端用 2048 bit 的滑動視窗（RFC 6479）擋重放，同時容忍網路亂序。
- 內容補齊到 16 bytes 邊界，稍微遮掩封包長度；收端依 IP 標頭的長度欄位裁掉。
- 每 120 秒或 2⁶⁰ 個封包換一次金鑰；180 秒後舊金鑰一律作廢。

### Cryptokey routing

`AllowedIPs` 同時是路由表和存取控制清單：

- **送出時**：依目的位址做最長前綴比對，決定用哪個 peer 的金鑰加密。
- **收到時**：解密後檢查來源位址是否落在該 peer 的 `AllowedIPs` 內，
  否則丟棄。所以一個客戶端**無法偽裝**成另一個客戶端。

### 漫遊

任何通過驗證的封包都會更新該 peer 的端點位址，所以客戶端換 Wi-Fi、
換 4G、被 NAT 換 port，連線都不會斷，也不用重新握手。

---

## 設定檔

格式接近 `wg-quick`，一個 `[Interface]` 加上任意多個 `[Peer]`。

### 伺服器

```ini
[Interface]
PrivateKey = <base64>        # python3 -m pyvpn genkey
Address    = 10.9.0.1/24     # 隧道內的位址（需含網段前綴）
ListenPort = 51820
MTU        = 1400
NAT        = on              # 把客戶端流量轉發出去上網
# WanInterface = eth0        # 自動偵測，猜錯時再手動指定

[Peer]                       # 每個客戶端一段
PublicKey    = <base64>
AllowedIPs   = 10.9.0.2/32   # 這個客戶端唯一被允許使用的位址
PresharedKey = <base64>      # 選用，python3 -m pyvpn genpsk
```

### 客戶端

```ini
[Interface]
PrivateKey = <base64>
Address    = 10.9.0.2/24
MTU        = 1400
ListenPort = 0               # 0 = 隨便挑一個空的 port
DNS        = 1.1.1.1         # 選用；不設的話 DNS 查詢仍走原本的解析器

[Peer]
PublicKey           = <伺服器公鑰>
Endpoint            = vpn.example.com:51820
AllowedIPs          = 0.0.0.0/0    # 全部流量走隧道；改成特定網段就是分流
PersistentKeepalive = 25           # 維持 NAT 對應
PresharedKey        = <base64>
```

`AllowedIPs = 0.0.0.0/0` 時，客戶端不會刪掉系統原本的預設路由，而是加上
`0.0.0.0/1` 與 `128.0.0.0/1` 兩條更精確的路由蓋過它——這樣即使程式被強制
中止，原本的路由仍然完好。

---

## 指令

| 指令 | 用途 |
|---|---|
| `pyvpn init --endpoint HOST:PORT` | 產生配套的伺服器與客戶端設定 |
| `pyvpn genkey` / `pubkey` / `genpsk` | 金鑰工具 |
| `pyvpn server -c server.conf` | 執行伺服器（需 root） |
| `pyvpn client -c client.conf` | 執行客戶端（需 root） |
| `pyvpn show -c FILE` | 檢視設定摘要（不會印出私鑰） |
| `pyvpn selftest` | 在本機驗證整條資料路徑 |

執行中對行程送 `SIGUSR1` 會印出目前狀態（握手時間、傳輸量、被丟棄的封包）：

```bash
sudo kill -USR1 $(pgrep -f 'pyvpn server')
```

---

## 網頁版：該連哪一國？

`docs/` 底下有一個單頁工具，可以在 **Safari 直接開、免登入、加到主畫面**。
它量測你當下的網速與到各國的延遲，算出應該連哪一個國家的節點，並產生對應的
客戶端設定。

```bash
cd docs && python3 -m http.server 8000   # 本機預覽
node docs/logic.test.mjs                # 驗證建議演算法
python3 docs/browser.test.py            # 瀏覽器端對端測試（需 playwright）
```

要拿到公開、免登入的網址，在 GitHub 的 **Settings → Pages** 選
`Deploy from a branch`，資料夾選 `/docs`。詳見 [`docs/README.md`](docs/README.md)。

判斷方式：

```
可容忍延遲 = 10 ms + min(下載速度, 100 Mbps) × 0.8
```

線路慢的時候這個窗口很窄（1 Mbps 約 11 ms），只有最近的節點堪用；
線路快的時候窗口寬（100 Mbps 約 90 ms），就能依你想要的出口國家自由挑。

> **網頁不能自己建立 VPN 連線。** iOS 只允許有 NetworkExtension 權限的原生
> App 接管系統流量，Safari 沒有這個 API。這個頁面負責「選哪一國」，
> 實際連線仍由上面的 `pyvpn` 客戶端執行。

---

## 開發

```bash
make test        # 完整測試（139 項，不需要 root）
make selftest    # 本機資料路徑檢查
make demo        # 完整真實環境示範（需要 root）
python3 scripts/benchmark.py
```

### 程式結構

| 模組 | 職責 |
|---|---|
| `pyvpn/crypto.py` | X25519、ChaCha20-Poly1305、BLAKE2s、HKDF、TAI64N |
| `pyvpn/noise.py` | Noise_IKpsk2 握手狀態機 |
| `pyvpn/messages.py` | 線路格式的編解碼 |
| `pyvpn/replay.py` | 抗重放滑動視窗 |
| `pyvpn/peer.py` | 每個 peer 的金鑰、計時器、端點 |
| `pyvpn/device.py` | 事件迴圈與雙向資料路徑 |
| `pyvpn/tun.py` | TUN 裝置與介面/路由設定（純 ioctl，不依賴 `ip` 指令） |
| `pyvpn/nat.py` | 伺服器端轉發與 NAT（iptables，關閉時完整還原） |
| `pyvpn/routing.py` | 客戶端路由改道 |
| `pyvpn/server.py` / `client.py` | 兩端的組裝與生命週期 |

測試涵蓋密碼學原語、握手（含各種偽造與竄改）、封包格式、抗重放視窗、
設定解析、cryptokey routing，以及一組跑在真實 UDP socket 上的端對端測試
（握手、雙向加解密、重放拒絕、竄改拒絕、來源位址偽造拒絕、換金鑰）。

---

## 已知限制

誠實說明，請在採用前確認這些對你不是問題：

- **不與 WireGuard 互通**。密碼學構造相同，但協定識別字串與線路格式是自訂的。
  不要拿 WireGuard 客戶端連這個伺服器。
- **未經第三方安全稽核**。密碼學本身用的是 `cryptography` 套件（背後是
  OpenSSL/Rust 的常數時間實作），但協定的組裝是本專案自己寫的。
  真正高風險的場景請用 WireGuard。
- **隧道內只支援 IPv4**。IPv6 封包會被丟棄並計數，`AllowedIPs` 也只吃 IPv4。
- **沒有實作 cookie reply**。抗 DoS 只有 `mac1` 檢查加上每來源 IP 的速率限制，
  沒有 WireGuard 完整的 cookie 機制。
- **吞吐量受限於 Python**。實測兩端同機約 **50 Mbit/s**；
  單看 AEAD 本身可以到約 490 Mbit/s，所以瓶頸是每封包的 Python 開銷而非加密。
  要跑滿 Gigabit 請用核心態的 WireGuard。
- **只支援 Linux**，因為用到 TUN、`iptables` 與 Linux 的 ioctl 介面。
- 伺服器需要 root（或 `CAP_NET_ADMIN`）才能建立介面與改防火牆規則。

## 授權

MIT
