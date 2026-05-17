# Army — Multi-Robot Kontrol Sistemi

ESP32 tabanlı robotları (omni-tekerlek, quadruped, paletli) WiFi + WebSocket üzerinden tek bir masaüstü uygulamasıyla kontrol eden tam yığın bir proje. Robotlar IMU + pusula + ToF sensörleriyle düz çizgide gitme, engelden kaçma ve yön sabitleme gibi otonom davranışlar yapabilir; uygulama tarafında 3D digital twin, takım yönetimi, kamera akışı ve TensorFlow.js ile yapay zeka nesne tespiti vardır.

## İçerik

```
.
├── cyber.ino          # 3-tekerlekli omni holonomik robot firmware'i
├── dog.ino            # Quadruped robot köpek firmware'i
├── cam.ino            # ESP32-CAM MJPEG video stream firmware'i
├── desktop-app/       # Angular 17 + Electron masaüstü kontrol paneli
├── app.md             # Uygulama dokümantasyonu
└── dog.md             # Köpek robot dokümantasyonu
```

## Donanım

| Bileşen | Adres / Pin | Görev |
|---|---|---|
| ESP32 DevKit | — | Ana kontrolcü, WiFi + WebSocket sunucu |
| 3 × DC motor + H-Bridge | GPIO 32/33, 25/26, 27/14 | Omni-tekerlek sürüş (LEDC PWM, 20 kHz) |
| VL53L0X | I²C 0x29 | Önde ToF mesafe sensörü (mm) |
| MPU6050 | I²C 0x68 | İvmeölçer + jiroskop (ax/ay/az + gx/gy/gz) |
| QMC5883L | I²C 0x0D | Pusula (yaw heading) |
| ESP32-CAM (opsiyonel) | OV2640 | MJPEG video, port 81 |

I²C SDA = GPIO 21, SCL = GPIO 22, 400 kHz fast mode.

## Robot Yetenekleri (Firmware)

### Sensör Füzyonu
- **Boot'ta MPU6050 jiro kalibrasyonu** — 300 örnek üzerinden bias hesabı, statik drift sıfırlanır
- **Tilt-compensated heading** — accel'den roll/pitch çıkar, mag vektörünü yatay düzleme döndür, eğimde de doğru azimuth
- **Complementary filter** — `yaw_fused = α·(yaw_fused + gz·dt) + (1-α)·yaw_mag`, α = 0.98. Gyro kısa vadede hakim, mag uzun vadede drift düzeltir. Kalman'ın %95 performansı, 15 satırda.

### Otonom Davranışlar
- **Heading-Hold (düz gitme)** — `walk N`/`back N` komutunda başlangıç yönü kilitlenir, P-kontrolcü ile (`w = Kp × err`, dead-zone ±3°, doyum ±0.45) tekerlek hızları otomatik dengelenir
- **Engelden Kaçış** — ToF mesafesine bakarak ileri sür → engel görünce zigzag dön → açıklıkta tekrar ileri. State machine, bloklamaz.
- **Gyro Stabilize** — altındaki platform dönse bile robot sabit yöne bakar; `fusedYaw` kilitlenir, P-kontrolcü ters yönde düzeltir

### WebSocket Komutları (port 81)
```json
{ "cmd": "walk",       "value": 5 }            // 5 adım ileri (heading-hold ile)
{ "cmd": "back",       "value": 3 }
{ "cmd": "left|right", "value": 3 }            // yerinde dönüş
{ "cmd": "strafeLeft|strafeRight", "value": 3 }// yan kayma (omni)
{ "cmd": "drive", "vx": 0, "vy": 1.0, "w": 0 } // sürekli hız kontrolü (-1..+1)
{ "cmd": "stop" }                              // tüm otonom modları kapatır + motor dur
{ "cmd": "speed",     "value": 70 }            // 10–100
{ "cmd": "avoid",     "value": 1|0 }           // engelden kaçış aç/kapat
{ "cmd": "stabilize", "value": 1|0 }           // gyro stabilize aç/kapat
{ "cmd": "calibrate" }                         // MPU6050 yeniden kalibre
{ "cmd": "wifi",      "ssid": "...", "pass": "..." } // dinamik WiFi provizyon (NVS kaydı + restart)
{ "cmd": "wifiReset" }                         // kayıtlı WiFi'ı sil, AP moduna dön
```

200 ms aralıklarla telemetri yayını:
```json
{ "type":"cyber", "speed":50, "moving":true, "distance":420, "heading":127,
  "acc":{"x":..,"y":..,"z":..}, "gyro":{"x":..,"y":..,"z":..}, "temp":34.2 }
```

### WiFi Provizyon
- Boot'ta NVS'ten kayıtlı SSID/pass dener
- Bağlanamazsa `Cyber` SSID + `cyber1234` parolasıyla **AP modu** açar (192.168.4.1)
- App'ten AP'ye bağlanıp WiFi bilgisi gönderilir → kaydeder → restart → ev WiFi'ına geçer

## Desktop App (Angular 17 + Electron)

- **Filodaki tüm robotları** WebSocket üzerinden kontrol
- **Takım yönetimi** — birden fazla robotu grup olarak yönet, broadcast veya bireysel komut, daraltılabilir sidebar, üye başına bağlantı durumu
- **3D Digital Twin** — Three.js ile gerçek zamanlı robot animasyonu (yürüme, oturma, sallanma)
- **Local Map** — haritada robotu seçip hedefe tıkla, robot mesafeye **orantılı adım sayısıyla** gider. Üs (🏠) / hedef (🎯) waypoint'leri konabilir.
- **Hareket pad'i** — yön tuşları + klavye kontrolü (oklar, space, s/f/g)
- **Engelden Kaç** ve **Gyro Stabilize** butonları
- **WiFi yapılandır** — bağlıyken yeni WiFi creds göndererek robotu yeni ağa al
- **Kamera akışı** + **TensorFlow.js COCO-SSD** ile canlı nesne tespiti (~10 FPS)
- **Log konsolu**, hız/adım slider'ları, sensör paneli (ToF, IMU, heading, sıcaklık)

### Kurulum

```bash
cd desktop-app
npm install
npm run electron:dev   # Geliştirme (Angular serve + Electron birlikte)
npm run dist           # Production build (NSIS installer)
```

## Firmware Kurulum

Arduino IDE veya PlatformIO ile:

**Gerekli kütüphaneler:**
- WebSocketsServer (Markus Sattler)
- ArduinoJson (v6.x)
- Adafruit VL53L0X
- Adafruit MPU6050
- QMC5883LCompass
- ESP32 Arduino core 2.0.x (cam.ino için 2.0.17 önerilir)

**WiFi:** `cyber.ino` içinde fallback SSID/şifre sabitlerini değiştir veya NVS'i kullan. Dinamik provizyon için AP moduna düşmesini bekleyip app'ten gönder.

**Board:** "AI Thinker ESP32-CAM" (cam.ino) ya da standart ESP32 Dev Module (cyber.ino).

## Mimari

```
┌──────────────────────────────────┐
│    Electron Desktop App          │
│  ┌────────────────────────────┐  │
│  │  Angular 17 (TypeScript)   │  │
│  │  ├ RobotService            │  │
│  │  ├ DigitalTwin (Three.js)  │  │
│  │  ├ CocoSSD (TF.js)         │  │
│  │  └ MovementPad/Camera/UI   │  │
│  └────────────────────────────┘  │
└──────────────┬───────────────────┘
               │  WebSocket :81 (JSON)
               │  HTTP :81/stream (MJPEG)
               ▼
┌──────────────────────────────────┐
│  ESP32 Robot (cyber.ino)         │
│  ├ Sensor füzyon (50 Hz)         │
│  │   ├ MPU6050 + bias            │
│  │   ├ Tilt-compensated mag      │
│  │   └ Complementary filter      │
│  ├ Kontrol döngüsü (P)           │
│  │   ├ Heading-hold              │
│  │   ├ Avoidance state machine   │
│  │   └ Gyro stabilize            │
│  ├ Holonomik kinematik (3 omni)  │
│  └ WebSocket sunucu              │
└──────────────────────────────────┘
```

## Lisans

Kişisel/eğitim amaçlı — istediğin gibi fork'la, değiştir, kullan.
