/*
 * 方塊劍鬥 —— BLE 對戰中繼
 * ==========================================
 *
 * 為什麼需要這個？
 *   瀏覽器的 Web Bluetooth 只能當「中央端」（central），沒辦法把自己廣播成一個
 *   BLE 周邊裝置。所以兩支手機的瀏覽器沒辦法直接用藍牙連在一起。
 *   這顆 ESP32 就是中間那個周邊裝置：兩邊都連上它，它把收到的封包原封不動
 *   轉發給另一邊，對遊戲來說就等同於一條藍牙直連的管線。
 *
 * 硬體
 *   任何一片 ESP32 開發板（ESP32 / ESP32-S3 / ESP32-C3 都可以）。
 *
 * 燒錄步驟
 *   1. Arduino IDE 安裝「esp32 by Espressif Systems」開發板套件。
 *   2. 開啟這個檔案，選好你的板子與序列埠，直接上傳。
 *   3. 上電後它會以「SwordDuel-Relay」這個名字廣播。
 *
 * 玩法
 *   兩台裝置都打開遊戲 -> 藍牙 / 連線對戰 -> 連線方式選「藍牙 BLE」
 *   -> 一邊選房主、一邊選挑戰者 -> 各自按「連線」並挑 SwordDuel-Relay。
 *   兩邊都連上之後就會自動配對開打。
 *
 * 備註
 *   - 用的是 Nordic UART Service（NUS），跟遊戲端 src/net/transport.js 的 UUID 一致。
 *   - 遊戲封包很小（狀態 20 bytes、輸入 4 bytes），預設 MTU 就夠用。
 *   - 這支韌體不解析封包內容，純粹轉發，所以之後改協定也不用重燒。
 */

#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <BLE2902.h>

#define SERVICE_UUID        "6e400001-b5a3-f393-e0a9-e50e24dcca9e"
#define CHARACTERISTIC_RX   "6e400002-b5a3-f393-e0a9-e50e24dcca9e"  // 遊戲端寫入
#define CHARACTERISTIC_TX   "6e400003-b5a3-f393-e0a9-e50e24dcca9e"  // 中繼端通知

#define DEVICE_NAME         "SwordDuel-Relay"
#define MAX_PEERS           2

static BLECharacteristic* txCharacteristic = nullptr;
static BLEServer* bleServer = nullptr;
static int connectedCount = 0;

// 統計，方便用序列埠監控看有沒有在轉發
static unsigned long packetsRelayed = 0;
static unsigned long bytesRelayed = 0;
static unsigned long lastReport = 0;

class RelayServerCallbacks : public BLEServerCallbacks {
  void onConnect(BLEServer* server) override {
    connectedCount = server->getConnectedCount();
    Serial.printf("[BLE] 有裝置連上，目前 %d/%d\n", connectedCount, MAX_PEERS);
    // 還沒滿兩台就繼續廣播，好讓第二位玩家也能連進來
    if (connectedCount < MAX_PEERS) {
      server->startAdvertising();
      Serial.println("[BLE] 繼續廣播，等待另一位玩家…");
    } else {
      Serial.println("[BLE] 兩邊都到齊，開打！");
    }
  }

  void onDisconnect(BLEServer* server) override {
    connectedCount = server->getConnectedCount();
    Serial.printf("[BLE] 有裝置離線，目前 %d/%d\n", connectedCount, MAX_PEERS);
    server->startAdvertising();
  }
};

class RelayCallbacks : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic* characteristic) override {
    String value = characteristic->getValue();
    if (value.length() == 0) return;

    // 直接把收到的位元組原樣通知出去。
    // BLE 的 notify 會送給所有已訂閱的連線，包含寫進來的那一邊；
    // 遊戲端本來就會忽略自己送出的封包型別，所以不需要在這裡做來源過濾。
    txCharacteristic->setValue((uint8_t*)value.c_str(), value.length());
    txCharacteristic->notify();

    packetsRelayed++;
    bytesRelayed += value.length();
  }
};

void setup() {
  Serial.begin(115200);
  delay(300);
  Serial.println();
  Serial.println("=== 方塊劍鬥 BLE 中繼 ===");

  BLEDevice::init(DEVICE_NAME);
  // 加大 MTU，狀態封包可以一次送完不用分片
  BLEDevice::setMTU(185);

  bleServer = BLEDevice::createServer();
  bleServer->setCallbacks(new RelayServerCallbacks());

  BLEService* service = bleServer->createService(SERVICE_UUID);

  txCharacteristic = service->createCharacteristic(
      CHARACTERISTIC_TX, BLECharacteristic::PROPERTY_NOTIFY);
  txCharacteristic->addDescriptor(new BLE2902());

  BLECharacteristic* rxCharacteristic = service->createCharacteristic(
      CHARACTERISTIC_RX,
      BLECharacteristic::PROPERTY_WRITE | BLECharacteristic::PROPERTY_WRITE_NR);
  rxCharacteristic->setCallbacks(new RelayCallbacks());

  service->start();

  BLEAdvertising* advertising = BLEDevice::getAdvertising();
  advertising->addServiceUUID(SERVICE_UUID);
  advertising->setScanResponse(true);
  // 這兩行是 iPhone 的連線相容性設定
  advertising->setMinPreferred(0x06);
  advertising->setMinPreferred(0x12);
  BLEDevice::startAdvertising();

  Serial.printf("已開始廣播，裝置名稱：%s\n", DEVICE_NAME);
  Serial.println("在遊戲裡選「藍牙 BLE」連線，兩台裝置都連到這一顆即可。");
}

void loop() {
  // 每 5 秒回報一次流量，方便確認封包真的有在跑
  if (millis() - lastReport > 5000) {
    lastReport = millis();
    if (packetsRelayed > 0) {
      Serial.printf("[統計] 已轉發 %lu 個封包 / %lu bytes，連線數 %d\n",
                    packetsRelayed, bytesRelayed, connectedCount);
    }
  }
  delay(10);
}
