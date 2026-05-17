# 🐾 Robot Köpek — ESP32 + 4 Servo Projesi

> ESP32 mikrodenetleyicisi ve 4 adet servo motor kullanılarak yapılmış, duygu tabanlı davranış sistemine sahip robot köpek projesi.

---

## 📦 Donanım Gereksinimleri

| Bileşen | Adet | Açıklama |
|---|---|---|
| ESP32 Dev Board | 1 | Wi-Fi + BT destekli |
| MG996R / SG90 Servo | 4 | Sol ön, sağ ön, sol arka, sağ arka bacaklar |
| LiPo Pil (7.4V) veya 5V güç adaptörü | 1 | Servolara ayrı güç önerilir |
| L7805 / DC-DC Buck Converter | 1 | Servo gücü düzenlemesi |
| Buzzer (pasif, opsiyonel) | 1 | Ses efektleri için |
| LED (opsiyonel) | 2 | Göz/duygu göstergesi |
| Bağlantı kabloları | — | Jumper/DuPont |

### Pin Bağlantıları

```
ESP32 GPIO 13  →  Sol Ön Servo   (SIG)
ESP32 GPIO 12  →  Sağ Ön Servo   (SIG)
ESP32 GPIO 14  →  Sol Arka Servo  (SIG)
ESP32 GPIO 27  →  Sağ Arka Servo  (SIG)

Servolar: VCC → 5V (harici güç), GND → Ortak GND
ESP32 3.3V   →  ESP32'nin kendi beslemesi
```

> ⚠️ **Önemli:** Servoları ESP32'nin 3.3V veya 5V pininden beslemek yerine harici güç kaynağı kullanın. Aksi takdirde ESP32 yeniden başlayabilir veya zarar görebilir.

---

## 🛠️ Yazılım Kurulumu

### Arduino IDE Ayarları

1. Arduino IDE'yi açın (2.x önerilir)
2. **File → Preferences → Additional Board Manager URLs** kısmına ekleyin:
   ```
   https://raw.githubusercontent.com/espressif/arduino-esp32/gh-pages/package_esp32_index.json
   ```
3. **Tools → Board → Board Manager** → `esp32` aratıp yükleyin
4. **Board:** `ESP32 Dev Module` seçin
5. **Upload Speed:** `115200`
6. **Flash Frequency:** `80MHz`

### Gerekli Kütüphaneler

```
ESP32Servo   →  Library Manager'dan yükle
ArduinoJson  →  Library Manager'dan yükle (v6.x)
WiFi         →  ESP32 ile birlikte gelir
WebSocketsServer  →  Library Manager'dan yükle
```

---

## 🤖 Arduino Kodu

### Tam Kaynak Kodu

```cpp
/*
 * ============================================================
 *  ROBOT KÖPEK — ESP32 + 4 SERVO
 *  Yürüme Gaitaları + Duygu Tabanlı Davranış + WebSocket Kontrol
 * ============================================================
 *  Servo Atamaları:
 *    GPIO 13 → Sol Ön  (FL)
 *    GPIO 12 → Sağ Ön  (FR)
 *    GPIO 14 → Sol Arka (RL)
 *    GPIO 27 → Sağ Arka (RR)
 * ============================================================
 */

#include <ESP32Servo.h>
#include <WiFi.h>
#include <WebSocketsServer.h>
#include <ArduinoJson.h>

// ─── Wi-Fi Ayarları ──────────────────────────────────────────
const char* SSID     = "WIFI_ADINIZ";
const char* PASSWORD = "WIFI_SIFRENIZ";

// ─── Servo Pin Tanımları ─────────────────────────────────────
#define PIN_FL 13   // Sol Ön
#define PIN_FR 12   // Sağ Ön
#define PIN_RL 14   // Sol Arka
#define PIN_RR 27   // Sağ Arka

// ─── Servo Nesneleri ─────────────────────────────────────────
Servo servoFL, servoFR, servoRL, servoRR;

// ─── WebSocket Sunucusu (Port 81) ────────────────────────────
WebSocketsServer webSocket = WebSocketsServer(81);

// ─── Duygu Durumları ─────────────────────────────────────────
enum Emotion {
  NEUTRAL,
  HAPPY,
  SAD,
  EXCITED,
  SCARED,
  ANGRY,
  SLEEPY
};

// ─── Robot Durumu ────────────────────────────────────────────
struct RobotState {
  Emotion emotion     = NEUTRAL;
  bool    isWalking   = false;
  bool    isSitting   = false;
  int     speed       = 50;         // 0–100
  int     stepDelay   = 200;        // ms
  unsigned long lastAction = 0;
  unsigned long idleTime   = 0;
};

RobotState robot;

// ─── Servo Orta Pozisyonları (Kalibrasyon için ayarlayın) ────
const int CENTER_FL = 90;
const int CENTER_FR = 90;
const int CENTER_RL = 90;
const int CENTER_RR = 90;

// ─── Yardımcı Fonksiyon: Tüm Servolar Orta ──────────────────
void allCenter() {
  servoFL.write(CENTER_FL);
  servoFR.write(CENTER_FR);
  servoRL.write(CENTER_RL);
  servoRR.write(CENTER_RR);
}

// ─── Oturma Pozu ─────────────────────────────────────────────
void sitDown() {
  servoFL.write(CENTER_FL + 30);
  servoFR.write(CENTER_FR - 30);
  servoRL.write(CENTER_RL - 45);
  servoRR.write(CENTER_RR + 45);
  robot.isSitting = true;
  robot.isWalking = false;
}

// ─── Ayağa Kalkma ────────────────────────────────────────────
void standUp() {
  allCenter();
  delay(300);
  robot.isSitting = false;
}

// ─── İleri Yürüme Gaitası (Çapraz çift destek) ───────────────
void walkForward(int steps) {
  robot.isWalking = true;
  robot.isSitting = false;
  int d = map(robot.speed, 0, 100, 400, 80);

  // SWING açısı: havadaki bacağın ne kadar ileri sallandığı
  const int SWING = 30;
  // PUSH açısı: yerdeki bacağın gövdeyi ne kadar ittiği
  const int PUSH  = 20;

  for (int i = 0; i < steps; i++) {
    if (!robot.isWalking) break;

    // ── Faz 1 ──────────────────────────────────────────────
    // FL + RR → ileri sallan (havada)
    // FR + RL → geri it     (yerde, gövdeyi öne taşı)
    servoFL.write(CENTER_FL + SWING);   // FL ileri
    servoRR.write(CENTER_RR - SWING);   // RR ileri
    servoFR.write(CENTER_FR + PUSH);    // FR geri it
    servoRL.write(CENTER_RL - PUSH);    // RL geri it
    delay(d / 2);

    // Hepsini merkeze al (geçiş)
    allCenter();
    delay(d / 4);

    // ── Faz 2 ──────────────────────────────────────────────
    // FR + RL → ileri sallan (havada)
    // FL + RR → geri it     (yerde, gövdeyi öne taşı)
    servoFR.write(CENTER_FR - SWING);   // FR ileri
    servoRL.write(CENTER_RL + SWING);   // RL ileri
    servoFL.write(CENTER_FL - PUSH);    // FL geri it
    servoRR.write(CENTER_RR + PUSH);    // RR geri it
    delay(d / 2);

    // Merkeze al
    allCenter();
    delay(d / 4);
  }
}

// void walkBackward(int steps) {
  robot.isWalking = true;
  int d = map(robot.speed, 0, 100, 400, 80);

  const int SWING = 30;
  const int PUSH  = 20;

  for (int i = 0; i < steps; i++) {
    if (!robot.isWalking) break;

    // Faz 1: FL + RR geri sallan, FR + RL ileri it
    servoFL.write(CENTER_FL - SWING);
    servoRR.write(CENTER_RR + SWING);
    servoFR.write(CENTER_FR - PUSH);
    servoRL.write(CENTER_RL + PUSH);
    delay(d / 2);
    allCenter();
    delay(d / 4);

    // Faz 2: FR + RL geri sallan, FL + RR ileri it
    servoFR.write(CENTER_FR + SWING);
    servoRL.write(CENTER_RL - SWING);
    servoFL.write(CENTER_FL + PUSH);
    servoRR.write(CENTER_RR - PUSH);
    delay(d / 2);
    allCenter();
    delay(d / 4);
  }
}

// ─── Sola Dönme ──────────────────────────────────────────────
void turnLeft(int steps) {
  robot.isWalking = true;
  int d = map(robot.speed, 0, 100, 400, 100);

  for (int i = 0; i < steps; i++) {
    if (!robot.isWalking) break;

    // Sol bacaklar geri, sağ bacaklar ileri
    servoFL.write(CENTER_FL - 20);
    servoRL.write(CENTER_RL - 20);
    delay(d / 2);
    servoFR.write(CENTER_FR - 20);
    servoRR.write(CENTER_RR - 20);
    delay(d / 2);
    allCenter();
    delay(d / 4);
  }
}

// ─── Sağa Dönme ──────────────────────────────────────────────
void turnRight(int steps) {
  robot.isWalking = true;
  int d = map(robot.speed, 0, 100, 400, 100);

  for (int i = 0; i < steps; i++) {
    if (!robot.isWalking) break;

    servoFR.write(CENTER_FR + 20);
    servoRR.write(CENTER_RR + 20);
    delay(d / 2);
    servoFL.write(CENTER_FL + 20);
    servoRL.write(CENTER_RL + 20);
    delay(d / 2);
    allCenter();
    delay(d / 4);
  }
}

// ═══════════════════════════════════════════════════════════════
//  DUYGU DAVRANIŞLARI
// ═══════════════════════════════════════════════════════════════

// Mutlu: Kuyruk sallama (arka servo sallantısı)
void behaviorHappy() {
  for (int i = 0; i < 4; i++) {
    servoRR.write(CENTER_RR + 30);
    servoRL.write(CENTER_RL - 20);
    delay(150);
    servoRR.write(CENTER_RR - 30);
    servoRL.write(CENTER_RL + 20);
    delay(150);
  }
  allCenter();
}

// Heyecanlı: Yerinde koşma hareketi
void behaviorExcited() {
  for (int i = 0; i < 6; i++) {
    servoFL.write(CENTER_FL + 35);
    servoFR.write(CENTER_FR - 35);
    delay(80);
    servoFL.write(CENTER_FL - 35);
    servoFR.write(CENTER_FR + 35);
    delay(80);
  }
  allCenter();
}

// Üzgün: Yavaş baş sallama + eğilme
void behaviorSad() {
  servoFL.write(CENTER_FL + 15);
  servoFR.write(CENTER_FR - 15);
  delay(800);
  allCenter();
  delay(400);
  servoFL.write(CENTER_FL + 15);
  servoFR.write(CENTER_FR - 15);
  delay(800);
  allCenter();
}

// Korkmuş: Titreme
void behaviorScared() {
  for (int i = 0; i < 8; i++) {
    servoFL.write(CENTER_FL + 8);
    servoFR.write(CENTER_FR - 8);
    servoRL.write(CENTER_RL + 8);
    servoRR.write(CENTER_RR - 8);
    delay(60);
    servoFL.write(CENTER_FL - 8);
    servoFR.write(CENTER_FR + 8);
    servoRL.write(CENTER_RL - 8);
    servoRR.write(CENTER_RR + 8);
    delay(60);
  }
  allCenter();
}

// Sinirli: Hızlı ayak vurma
void behaviorAngry() {
  for (int i = 0; i < 3; i++) {
    servoFL.write(CENTER_FL + 40);
    delay(100);
    servoFL.write(CENTER_FL);
    delay(80);
    servoFR.write(CENTER_FR - 40);
    delay(100);
    servoFR.write(CENTER_FR);
    delay(80);
  }
}

// Uykulu: Yavaşça çöküş
void behaviorSleepy() {
  for (int angle = 0; angle <= 20; angle += 2) {
    servoFL.write(CENTER_FL + angle);
    servoFR.write(CENTER_FR - angle);
    servoRL.write(CENTER_RL - angle / 2);
    servoRR.write(CENTER_RR + angle / 2);
    delay(100);
  }
}

// Selamlama: Ön pençe kaldırma
void behaviorGreet() {
  servoFL.write(CENTER_FL + 60);
  delay(600);
  servoFL.write(CENTER_FL);
  delay(300);
  servoFL.write(CENTER_FL + 60);
  delay(600);
  servoFL.write(CENTER_FL);
}

// ─── Duygu uygula ────────────────────────────────────────────
void applyEmotion(Emotion e) {
  robot.emotion = e;
  switch (e) {
    case HAPPY:    behaviorHappy();    break;
    case EXCITED:  behaviorExcited();  break;
    case SAD:      behaviorSad();      break;
    case SCARED:   behaviorScared();   break;
    case ANGRY:    behaviorAngry();    break;
    case SLEEPY:   behaviorSleepy();   break;
    default:       allCenter();        break;
  }
}

// ─── Boşta kalma davranışı ───────────────────────────────────
void idleBehavior() {
  unsigned long now = millis();
  if (now - robot.lastAction > 10000) {  // 10 saniye hareketsizlik
    robot.idleTime += now - robot.lastAction;
    robot.lastAction = now;

    int r = random(0, 4);
    switch (r) {
      case 0: behaviorHappy();  break;  // Rastgele mutlu
      case 1:                           // Etrafına bak
        servoFL.write(CENTER_FL + 20);
        servoFR.write(CENTER_FR - 20);
        delay(500);
        allCenter();
        break;
      case 2: behaviorSleepy(); break;  // Uykulu hisset
      case 3: behaviorGreet();  break;  // Selamla
    }
  }

  // 30 saniye hareketsizse otur
  if (robot.idleTime > 30000 && !robot.isSitting) {
    sitDown();
    robot.emotion = SLEEPY;
  }
}

// ═══════════════════════════════════════════════════════════════
//  WEB SOCKET — KOMUT İŞLEME
// ═══════════════════════════════════════════════════════════════

/*
 * Gelen JSON formatı:
 * { "cmd": "walk",    "value": 10  }
 * { "cmd": "emotion", "value": "happy" }
 * { "cmd": "speed",   "value": 75  }
 * { "cmd": "stop"                  }
 * { "cmd": "sit"                   }
 * { "cmd": "stand"                 }
 * { "cmd": "greet"                 }
 * { "cmd": "back"                  }
 * { "cmd": "left"                  }
 * { "cmd": "right"                 }
 */

void processCommand(String msg) {
  StaticJsonDocument<200> doc;
  DeserializationError err = deserializeJson(doc, msg);
  if (err) {
    Serial.println("JSON parse hatası: " + String(err.c_str()));
    return;
  }

  String cmd = doc["cmd"].as<String>();
  robot.lastAction = millis();
  robot.idleTime   = 0;

  Serial.print("Komut: "); Serial.println(cmd);

  if (cmd == "walk") {
    int steps = doc["value"] | 5;
    standUp();
    walkForward(steps);
  }
  else if (cmd == "back") {
    int steps = doc["value"] | 3;
    standUp();
    walkBackward(steps);
  }
  else if (cmd == "left") {
    standUp();
    turnLeft(doc["value"] | 3);
  }
  else if (cmd == "right") {
    standUp();
    turnRight(doc["value"] | 3);
  }
  else if (cmd == "stop") {
    robot.isWalking = false;
    allCenter();
  }
  else if (cmd == "sit") {
    sitDown();
  }
  else if (cmd == "stand") {
    standUp();
  }
  else if (cmd == "greet") {
    standUp();
    behaviorGreet();
  }
  else if (cmd == "speed") {
    robot.speed = constrain(doc["value"] | 50, 10, 100);
  }
  else if (cmd == "emotion") {
    String emotionStr = doc["value"] | "neutral";
    if      (emotionStr == "happy")   applyEmotion(HAPPY);
    else if (emotionStr == "sad")     applyEmotion(SAD);
    else if (emotionStr == "excited") applyEmotion(EXCITED);
    else if (emotionStr == "scared")  applyEmotion(SCARED);
    else if (emotionStr == "angry")   applyEmotion(ANGRY);
    else if (emotionStr == "sleepy")  applyEmotion(SLEEPY);
    else                              applyEmotion(NEUTRAL);
  }

  // Durum yanıtı gönder
  String status = "{\"emotion\":\"" + String(robot.emotion) +
                  "\",\"speed\":" + String(robot.speed) +
                  ",\"sitting\":" + String(robot.isSitting ? "true" : "false") + "}";
  webSocket.broadcastTXT(status);
}

void webSocketEvent(uint8_t num, WStype_t type, uint8_t* payload, size_t length) {
  switch (type) {
    case WStype_CONNECTED:
      Serial.printf("İstemci #%u bağlandı\n", num);
      break;
    case WStype_DISCONNECTED:
      Serial.printf("İstemci #%u ayrıldı\n", num);
      break;
    case WStype_TEXT:
      processCommand(String((char*)payload));
      break;
    default:
      break;
  }
}

// ═══════════════════════════════════════════════════════════════
//  SETUP & LOOP
// ═══════════════════════════════════════════════════════════════

void setup() {
  Serial.begin(115200);
  Serial.println("\n🐾 Robot Köpek başlatılıyor...");

  // Servo başlatma
  servoFL.attach(PIN_FL, 500, 2400);
  servoFR.attach(PIN_FR, 500, 2400);
  servoRL.attach(PIN_RL, 500, 2400);
  servoRR.attach(PIN_RR, 500, 2400);
  allCenter();
  delay(500);

  // Başlangıç animasyonu
  behaviorHappy();

  // Wi-Fi bağlantısı
  WiFi.begin(SSID, PASSWORD);
  Serial.print("Wi-Fi bağlanıyor");
  int tries = 0;
  while (WiFi.status() != WL_CONNECTED && tries < 20) {
    delay(500);
    Serial.print(".");
    tries++;
  }

  if (WiFi.status() == WL_CONNECTED) {
    Serial.println("\n✅ Bağlandı! IP: " + WiFi.localIP().toString());
    behaviorExcited();  // Wi-Fi bulununca heyecanlan
  } else {
    Serial.println("\n⚠️ Wi-Fi bulunamadı, AP modu başlatılıyor...");
    WiFi.softAP("RobotKopek", "kopek1234");
    Serial.println("AP IP: " + WiFi.softAPIP().toString());
    applyEmotion(SAD);
  }

  // WebSocket başlat
  webSocket.begin();
  webSocket.onEvent(webSocketEvent);
  Serial.println("🔌 WebSocket sunucusu port 81'de başladı");
}

void loop() {
  webSocket.loop();

  // Boşta kalma davranışı
  if (!robot.isWalking && !robot.isSitting) {
    idleBehavior();
  }

  delay(10);
}
```

---

## 📡 WebSocket İletişim Protokolü

### Gönderilen Komutlar (Masaüstü App → ESP32)

| Komut JSON | Açıklama |
|---|---|
| `{"cmd":"walk","value":10}` | 10 adım ileri yürü |
| `{"cmd":"back","value":5}` | 5 adım geri yürü |
| `{"cmd":"left","value":3}` | Sola dön |
| `{"cmd":"right","value":3}` | Sağa dön |
| `{"cmd":"stop"}` | Dur |
| `{"cmd":"sit"}` | Otur |
| `{"cmd":"stand"}` | Ayağa kalk |
| `{"cmd":"greet"}` | Selamla (pençe kaldır) |
| `{"cmd":"speed","value":75}` | Hız ayarla (0–100) |
| `{"cmd":"emotion","value":"happy"}` | Duygu ata |

### Duygu Değerleri

`neutral` · `happy` · `sad` · `excited` · `scared` · `angry` · `sleepy`

### ESP32'nin Yanıt Formatı

```json
{
  "emotion": 1,
  "speed": 75,
  "sitting": false
}
```

---

## 🖥️ Masaüstü Kontrol Uygulaması

### Teknoloji Önerisi

| Seçenek | Avantaj | Dezavantaj |
|---|---|---|
| **Electron + React** | Web teknolojileri, hızlı geliştirme | Ağır |
| **Python + PyQt6** | Hafif, native görünüm | Daha az modern |
| **Tauri + React** | Hafif, Rust tabanlı, native | Daha karmaşık kurulum |

**Önerilen:** Electron + React (WebSocket desteği kolay, hızlı prototipleme)

### WebSocket Bağlantısı (JavaScript)

```javascript
const ws = new WebSocket('ws://192.168.1.XX:81');

ws.onopen = () => console.log('Robot köpeğe bağlandı!');
ws.onmessage = (e) => {
  const state = JSON.parse(e.data);
  updateUI(state);
};

// Komut gönder
function sendCommand(cmd, value = null) {
  const payload = value !== null ? { cmd, value } : { cmd };
  ws.send(JSON.stringify(payload));
}

// Kullanım örnekleri
sendCommand('walk', 10);
sendCommand('emotion', 'happy');
sendCommand('speed', 80);
sendCommand('stop');
```

---

## 🔧 Servo Kalibrasyon Rehberi

1. Tüm servoları `90°` konumuna alın (`allCenter()`)
2. Köpeğin düz durduğunu kontrol edin
3. Eğer bir bacak eğikse, o servonun `CENTER_XX` sabitini ±5 ile ayarlayın
4. Yürüme sırasında bacak salınım açısını (`+25` / `-25`) mekanik yapınıza göre ayarlayın

```cpp
// Örnek: Sol ön servo 5 derece sola yatıksa
const int CENTER_FL = 85;  // 90 yerine 85
```

---

## 🐞 Sorun Giderme

| Belirti | Olası Neden | Çözüm |
|---|---|---|
| Servo titriyor | Yetersiz güç | Harici 5V güç kaynağı kullan |
| ESP32 yeniden başlıyor | Akım yetersiz | Güçlü adaptör / LiPo pil |
| Wi-Fi'ye bağlanmıyor | Şifre yanlış | SSID/password kontrol et |
| Bacaklar ters hareket | Pin veya faz hatası | `CENTER_XX` değerini ters çevir |
| WebSocket bağlanmıyor | IP yanlış | Serial Monitor'dan doğru IP'yi al |

---

## 📁 Proje Yapısı

```
RobotKopek/
├── firmware/
│   └── robot_kopek.ino        ← Ana Arduino kodu
├── desktop-app/
│   ├── package.json
│   ├── main.js                ← Electron ana süreç
│   └── src/
│       ├── App.jsx            ← React arayüz
│       └── websocket.js       ← WS yönetim modülü
├── docs/
│   └── RobotKopek_Dokumantasyon.md
└── README.md
```

---

## 🔮 Geliştirme Fikirleri

- **IMU (MPU6050):** Düşme algılama → otomatik kalkma davranışı
- **Ultrasonik Sensör (HC-SR04):** Engel algılama, otomatik kaçınma
- **Kamera (ESP32-CAM):** Görüntü aktarımı + yüz tanıma
- **Mikrofon:** Ses komutları (el çırpma → gel, vb.)
- **NeoPixel LED:** Göz rengi ile duygu gösterimi
- **OTA Güncelleme:** Wi-Fi üzerinden firmware yükleme

---

*Hazırlanma tarihi: 2025 · ESP32 Arduino Framework · WebSocket tabanlı kontrol*