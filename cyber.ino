/*
 * ============================================================
 *  CYBER — ESP32 + 3 OMNI TEKERLEK (Holonomik Robot)
 *  WebSocket Kontrol — dog.ino ile aynı komut arayüzü
 * ============================================================
 *  Motor Sürücü Pin Atamaları (H-Köprü IN1/IN2):
 *    Motor 1 (ön)     → GPIO 32 (IN1), GPIO 33 (IN2)
 *    Motor 2 (sağ-arka) → GPIO 25 (IN1), GPIO 26 (IN2)
 *    Motor 3 (sol-arka) → GPIO 27 (IN1), GPIO 14 (IN2)
 *
 *  Tekerlek Yerleşimi (üstten bakış):
 *        M1 (90°)
 *           ▲
 *           │
 *    M3 ────●──── M2
 *   (210°)      (330°)
 *
 *  Holonomik kinematik:
 *    v_i = -vx*sin(θ_i) + vy*cos(θ_i) + ω*R
 *
 *  Gerekli Kütüphaneler:
 *    - WiFi (built-in)
 *    - WebSocketsServer (Markus Sattler)
 *    - ArduinoJson (v6.x)
 * ============================================================
 */

#include <WiFi.h>
#include <WebSocketsServer.h>
#include <ArduinoJson.h>
#include <Preferences.h>
#include <Wire.h>
#include <Adafruit_VL53L0X.h>
#include <Adafruit_MPU6050.h>
#include <Adafruit_Sensor.h>
#include <QMC5883LCompass.h>
#include <math.h>

// ─── Wi-Fi Ayarları (fallback — NVS boşsa kullanılır) ────────
const char* SSID     = "VodafoneNet-303b10";
const char* PASSWORD = "5209403306v";

// ─── AP modu (provizyon için) ────────────────────────────────
const char* AP_SSID  = "Cyber";
const char* AP_PASS  = "cyber1234";

Preferences prefs;

// ─── Motor Pin Tanımları ─────────────────────────────────────
#define M1_IN1 32
#define M1_IN2 33
#define M2_IN1 25
#define M2_IN2 26
#define M3_IN1 27
#define M3_IN2 14

// ─── PWM Ayarları (ESP32 Arduino core v3.x — pin tabanlı LEDC) ─
#define PWM_FREQ  20000   // 20 kHz (sessiz)
#define PWM_RES   8       // 8-bit → 0–255

// ─── I²C Pinleri (3 sensör paylaşıyor) ───────────────────────
#define I2C_SDA 21
#define I2C_SCL 22

// ─── Sensör Nesneleri ────────────────────────────────────────
Adafruit_VL53L0X  tof;       // 0x29
Adafruit_MPU6050  imu;       // 0x68
QMC5883LCompass   compass;   // 0x0D (HMC5883L modülün ise QMC->HMC kütüphanesine geç)

bool hasTof = false, hasImu = false, hasCompass = false;

// ─── Jiro bias (kalibrasyon sonrası her okumadan çıkarılır) ─
float gyroBiasX = 0.0f, gyroBiasY = 0.0f, gyroBiasZ = 0.0f;
bool  imuCalibrated = false;

// ─── Sensör Füzyon Durumu ────────────────────────────────────
// Complementary filter: yaw_fused = α·(yaw_fused + gz·dt) + (1-α)·yaw_mag
// α büyük (~0.98) → kısa vadede jiro hakim (pürüzsüz, hızlı),
// (1-α) küçük (~0.02) → uzun vadede mag düzeltir (drift sıfırlanır).
const float FUSION_ALPHA = 0.98f;
float fusedYaw = 0.0f;                 // derece, 0..360 — füzyon edilmiş heading
unsigned long lastFusionT = 0;
bool fusionReady = false;

// ─── WebSocket ───────────────────────────────────────────────
WebSocketsServer webSocket = WebSocketsServer(81);

// ─── Robot Durumu ────────────────────────────────────────────
struct RobotState {
  int   speed     = 50;    // 0–100
  bool  isMoving  = false;
  unsigned long lastAction = 0;

  // Sensör son okumaları
  uint16_t distanceMm = 0;     // VL53L0X (mm)
  float    ax = 0, ay = 0, az = 0;     // m/s²
  float    gx = 0, gy = 0, gz = 0;     // rad/s
  float    temperature = 0;            // °C (MPU6050)
  int      heading = 0;                // 0–359 derece (pusula)
};
RobotState robot;

unsigned long lastSensorRead = 0;
unsigned long lastTelemetry  = 0;

// ─── Engelden Kaçış (Obstacle Avoidance) Durumu ──────────────
enum AvoidPhase : uint8_t { AV_FORWARD, AV_TURNING };
bool          avoidActive    = false;
AvoidPhase    avoidPhase     = AV_FORWARD;
int8_t        avoidTurnDir   = +1;          // +1 sola (CCW), -1 sağa (CW)
unsigned long avoidPhaseT0   = 0;           // faz başlangıcı
const uint16_t AVOID_SAFE_MM     = 350;     // bu mesafenin altında engel var
const uint16_t AVOID_CLEAR_MM    = 500;     // bu mesafenin üstünde "açık"
const uint16_t AVOID_TURN_MAX_MS = 1800;    // bir yöne en fazla bu kadar döner
const uint16_t AVOID_TURN_MIN_MS = 200;     // minimum dönüş süresi (debouncing)
const float    AVOID_FWD_SPEED   = 0.7f;    // ileri hız (0..1)
const float    AVOID_TURN_RATE   = 0.7f;    // dönüş hızı (0..1)

// ─── Gyro Stabilize (Heading Lock) ───────────────────────────
// Aktifse robot, altındaki platform dönse bile sabit bir yöne
// bakmaya çalışır — fusedYaw'ı kilitler, sapma oldukça karşı dönüş uygular.
bool          stabilizeActive = false;
float         stabilizeTargetYaw = 0.0f;
unsigned long lastStabilizeTick  = 0;
const float   STAB_KP        = 0.030f;   // pusula/jiro için kazanç
const float   STAB_DEADZONE  = 1.5f;     // ±1.5° — daha hassas
const float   STAB_W_MAX     = 0.85f;    // hızlı tepki için yüksek doyum
const int     STAB_TICK_MS   = 20;       // 50 Hz

// Akıllı bekleme
void smartDelay(unsigned long ms) {
  unsigned long start = millis();
  while (millis() - start < ms) {
    webSocket.loop();
    delay(1);
  }
}
#define delay smartDelay

// ─── Tek Motor Sür ───────────────────────────────────────────
// v: -255..+255  (işaret yön, büyüklük PWM) — doğrudan pin'e yazıyoruz
void driveMotor(int pinIn1, int pinIn2, int v) {
  v = constrain(v, -255, 255);
  if (v > 0) {
    ledcWrite(pinIn1, v);
    ledcWrite(pinIn2, 0);
  } else if (v < 0) {
    ledcWrite(pinIn1, 0);
    ledcWrite(pinIn2, -v);
  } else {
    ledcWrite(pinIn1, 0);
    ledcWrite(pinIn2, 0);
  }
}

// ─── Holonomik Sürüş ─────────────────────────────────────────
// vx: sağ-sol (+sağ), vy: ileri-geri (+ileri), w: dönüş (+saat-tersi)
// Tüm değerler -1.0 .. +1.0
void omniDrive(float vx, float vy, float w) {
  // Tekerlek açıları (radyan): M1=90°, M2=330°, M3=210°
  const float a1 = M_PI / 2.0f;          // 90°
  const float a2 = 11.0f * M_PI / 6.0f;  // 330°
  const float a3 = 7.0f  * M_PI / 6.0f;  // 210°

  float v1 = -vx * sinf(a1) + vy * cosf(a1) + w;
  float v2 = -vx * sinf(a2) + vy * cosf(a2) + w;
  float v3 = -vx * sinf(a3) + vy * cosf(a3) + w;

  // Normalize (>1 olursa hepsini ölçekle)
  float maxv = fmaxf(fmaxf(fabsf(v1), fabsf(v2)), fmaxf(fabsf(v3), 1.0f));
  v1 /= maxv;  v2 /= maxv;  v3 /= maxv;

  // Hız ölçeği uygula
  float scale = robot.speed / 100.0f;   // 0..1
  int pwm1 = (int)(v1 * 255 * scale);
  int pwm2 = (int)(v2 * 255 * scale);
  int pwm3 = (int)(v3 * 255 * scale);

  driveMotor(M1_IN1, M1_IN2, pwm1);
  driveMotor(M2_IN1, M2_IN2, pwm2);
  driveMotor(M3_IN1, M3_IN2, pwm3);

  robot.isMoving = (pwm1 || pwm2 || pwm3);
}

void stopAll() {
  omniDrive(0, 0, 0);
  robot.isMoving = false;
}

// ─── Hareket Komutları (dog.ino step mantığıyla) ─────────────
// step başına ~250 ms sürüş
const int STEP_MS = 250;

// ─── Heading-Hold (düz çizgide gitme) ────────────────────────
// Başlangıçta sensör yönünü kilitler, sapma oldukça w (dönüş) ile telafi eder.
// Pusula varsa onu kullanır (mutlak yön), yoksa MPU6050 jiroskobunu entegre eder.
//
// Kontrol: w = -Kp * err  → err sağa kaymışsa pozitif → w negatif → sola düzeltir.
// (omniDrive'da +w = saat-tersi = sola dönüş)
const float HH_KP_COMPASS = 0.025f;   // pusula için kazanç (derece başına)
const float HH_KP_GYRO    = 0.6f;     // jiro entegrali için kazanç
const float HH_DEADZONE   = 3.0f;     // ±3° altı düzeltme yok (titreme önleme)
const float HH_W_MAX      = 0.45f;    // maks. düzeltme oranı (sürüşü bozmasın)
const int   HH_TICK_MS    = 20;       // 50 Hz kontrol döngüsü

// ─── MPU6050 Jiro Kalibrasyonu ───────────────────────────────
// Robot HAREKETSİZ duruyorken çağırılır. N örnek alır, ortalamayı
// bias olarak kaydeder. Sonra her okumadan bu bias çıkarılır.
void calibrateGyro(int samples = 300) {
  if (!hasImu) return;
  Serial.print("🧪 MPU6050 kalibrasyonu (robotu sabit tutun)");
  double sx = 0, sy = 0, sz = 0;
  int ok = 0;
  for (int i = 0; i < samples; i++) {
    sensors_event_t a, g, t;
    if (imu.getEvent(&a, &g, &t)) {
      sx += g.gyro.x;
      sy += g.gyro.y;
      sz += g.gyro.z;
      ok++;
    }
    if (i % 50 == 0) Serial.print(".");
    delay(5);   // ~1.5 sn toplam
  }
  if (ok > 10) {
    gyroBiasX = sx / ok;
    gyroBiasY = sy / ok;
    gyroBiasZ = sz / ok;
    imuCalibrated = true;
    Serial.printf("\n✅ Bias: gx=%.4f gy=%.4f gz=%.4f rad/s\n",
                  gyroBiasX, gyroBiasY, gyroBiasZ);
  } else {
    Serial.println("\n⚠️ Kalibrasyon başarısız (IMU yanıt vermedi)");
  }
}

// Pusula açı farkını -180..+180 aralığına getir (360° sınırı atlatma)
float angleDiff(float target, float current) {
  float d = target - current;
  while (d > 180.0f)  d -= 360.0f;
  while (d < -180.0f) d += 360.0f;
  return d;
}

// ─── Tilt-Compensated Mag Heading ────────────────────────────
// Düz pusulanın aksine, robot eğildiğinde (roll/pitch) de doğru yön verir.
// Akım: accel'den roll/pitch çıkar → mag vektörünü yatay düzleme döndür →
// atan2 ile azimuth hesapla.
float tiltCompensatedHeading() {
  // Roll: gövdenin x ekseni etrafındaki eğimi (sağa-sola yatma)
  // Pitch: y ekseni etrafındaki eğimi (öne-arkaya kalkma)
  float roll  = atan2f(robot.ay, robot.az);
  float pitch = atan2f(-robot.ax,
                       sqrtf(robot.ay * robot.ay + robot.az * robot.az));

  // Ham mag bileşenleri (QMC5883LCompass — read() readSensors'da çağrılıyor)
  float mx = (float)compass.getX();
  float my = (float)compass.getY();
  float mz = (float)compass.getZ();

  // Düzlem-yatay mag bileşenleri
  float cosR = cosf(roll),  sinR = sinf(roll);
  float cosP = cosf(pitch), sinP = sinf(pitch);
  float Xh = mx * cosP + mz * sinP;
  float Yh = mx * sinR * sinP + my * cosR - mz * sinR * cosP;

  float headingRad = atan2f(-Yh, Xh);
  float headingDeg = headingRad * 180.0f / (float)M_PI;
  if (headingDeg < 0) headingDeg += 360.0f;
  return headingDeg;
}

// ─── Complementary Filter (gyro + mag → drift-siz yaw) ──────
// Sık çağrılır (her readSensors içinde). Tek başına çağrıldığında
// gz integralini mag heading ile yavaşça birleştirir.
void updateFusedYaw() {
  if (!hasImu && !hasCompass) return;

  unsigned long now = millis();
  if (lastFusionT == 0) { lastFusionT = now; return; }
  float dt = (now - lastFusionT) / 1000.0f;
  lastFusionT = now;
  if (dt <= 0 || dt > 0.5f) return;     // glitch koruması

  // Mag heading (varsa tilt-compensated, yoksa atla)
  float magYaw = fusionReady ? fusedYaw : 0.0f;
  bool haveMag = false;
  if (hasCompass && hasImu) {
    magYaw  = tiltCompensatedHeading();
    haveMag = true;
  } else if (hasCompass) {
    magYaw  = (float)robot.heading;     // ham fallback
    haveMag = true;
  }

  // Gyro integrasyonu (rad/s → derece)
  float gyroYaw = fusedYaw + (hasImu ? robot.gz * dt * 180.0f / (float)M_PI : 0.0f);

  // Başlangıçta mag'ı al, sonra füzyona geç
  if (!fusionReady) {
    fusedYaw = haveMag ? magYaw : 0.0f;
    fusionReady = true;
    return;
  }

  if (haveMag) {
    // Wrap-aware füzyon: gyroYaw ile magYaw arasındaki fark üzerinden harmanla
    float delta = angleDiff(magYaw, gyroYaw);
    fusedYaw = gyroYaw + (1.0f - FUSION_ALPHA) * delta;
  } else {
    fusedYaw = gyroYaw;     // sadece gyro
  }

  // 0..360 normalize
  while (fusedYaw < 0)      fusedYaw += 360.0f;
  while (fusedYaw >= 360.0f) fusedYaw -= 360.0f;
}

// vy: +1.0 ileri, -1.0 geri. totalMs boyunca düz git.
// Heading kaynağı: füzyon edilmiş yaw (gyro + tilt-compensated mag).
void driveStraight(float vy, unsigned long totalMs) {
  if (!hasCompass && !hasImu) {
    // Sensör yoksa açık döngü fallback
    omniDrive(0, vy, 0);
    delay(totalMs);
    stopAll();
    return;
  }

  // Başlangıç yönünü kilitle — füzyon hazır değilse birkaç tick bekle
  readSensors();
  unsigned long t0 = millis();
  while (!fusionReady && millis() - t0 < 500) {
    delay(20);
    readSensors();
  }
  float targetYaw = fusedYaw;

  unsigned long start = millis();

  while (millis() - start < totalMs) {
    webSocket.loop();
    readSensors();   // içeride updateFusedYaw çağrılır

    // err > 0 → sağa kaymışız → sola düzelt (+w = saat-tersi)
    float err = angleDiff(fusedYaw, targetYaw);

    // Kazanç: pusula varsa mutlak referans güvenilir → COMPASS kazancı
    float Kp = hasCompass ? HH_KP_COMPASS : HH_KP_GYRO;

    float w = 0.0f;
    if (fabsf(err) > HH_DEADZONE) {
      w = Kp * err;
      if (w >  HH_W_MAX) w =  HH_W_MAX;
      if (w < -HH_W_MAX) w = -HH_W_MAX;
    }

    omniDrive(0, vy, w);
    delay(HH_TICK_MS);
  }

  stopAll();
}

void moveForward(int steps) {
  driveStraight(1.0f, (unsigned long)steps * STEP_MS);
}

void moveBackward(int steps) {
  driveStraight(-1.0f, (unsigned long)steps * STEP_MS);
}

void rotateLeft(int steps) {
  for (int i = 0; i < steps; i++) {
    omniDrive(0, 0, 1.0f);
    delay(STEP_MS);
  }
  stopAll();
}

void rotateRight(int steps) {
  for (int i = 0; i < steps; i++) {
    omniDrive(0, 0, -1.0f);
    delay(STEP_MS);
  }
  stopAll();
}

void strafeLeft(int steps) {
  for (int i = 0; i < steps; i++) {
    omniDrive(-1.0f, 0, 0);
    delay(STEP_MS);
  }
  stopAll();
}

void strafeRight(int steps) {
  for (int i = 0; i < steps; i++) {
    omniDrive(1.0f, 0, 0);
    delay(STEP_MS);
  }
  stopAll();
}

// ─── Engelden Kaçış Tick ─────────────────────────────────────
// loop() içinden çağrılır. ToF mesafesine bakarak ileri sürer,
// engel görürse döner ve açıklığı bulunca tekrar ileri gider.
// Komutla başlatılır/durdurulur, bloklamaz, telemetri & komutlar canlı kalır.
void avoidanceTick() {
  if (!avoidActive) return;
  if (!hasTof) {
    Serial.println("⚠️ Avoid: ToF yok, mod kapatılıyor");
    avoidActive = false;
    stopAll();
    return;
  }

  uint16_t d = robot.distanceMm;             // mm; 0 = okuma yok / out of range
  unsigned long now = millis();
  unsigned long phaseMs = now - avoidPhaseT0;

  // 0 mm "geçersiz" — engel yokmuş gibi davran (otherwise robot sürekli döner)
  bool blocked = (d > 0 && d < AVOID_SAFE_MM);
  bool clear   = (d == 0 || d > AVOID_CLEAR_MM);

  if (avoidPhase == AV_FORWARD) {
    if (blocked) {
      // Engelle karşılaştık → dönüş fazına geç
      // Son dönüş yönünü değiştir (zigzag), ilk seferde sola
      avoidTurnDir = -avoidTurnDir;
      avoidPhase   = AV_TURNING;
      avoidPhaseT0 = now;
      stopAll();
      Serial.printf("🚧 Engel %dmm → %s dön\n", d, avoidTurnDir > 0 ? "sola" : "sağa");
      return;
    }
    // Açık — ileri sür (heading-hold olmadan; ToF reaksiyon hızı önemli)
    omniDrive(0, AVOID_FWD_SPEED, 0);
  }
  else { // AV_TURNING
    // Min süre geçmeden çıkma (sensör flicker'ı önlemek için)
    if (phaseMs > AVOID_TURN_MIN_MS && clear) {
      avoidPhase   = AV_FORWARD;
      avoidPhaseT0 = now;
      Serial.printf("✅ Açık (%dmm) → ileri\n", d);
      return;
    }
    // Max süre dolduysa yön değiştir, bir daha dene
    if (phaseMs > AVOID_TURN_MAX_MS) {
      avoidTurnDir = -avoidTurnDir;
      avoidPhaseT0 = now;
      Serial.println("⟳ Hâlâ engel, ters yönü dene");
    }
    omniDrive(0, 0, AVOID_TURN_RATE * avoidTurnDir);
  }
}

// ─── Gyro Stabilize Tick ─────────────────────────────────────
// loop() içinden çağrılır. fusedYaw'ı stabilizeTargetYaw'a kilitlemek
// için robotu ters yönde döndürür. Avoid modunu engellemez ama beraber
// kullanılması mantıklı değil — komut handler avoid'i kapatır.
void stabilizeTick() {
  if (!stabilizeActive) return;
  if (!hasImu && !hasCompass) {
    Serial.println("⚠️ Stabilize: IMU/pusula yok, mod kapatılıyor");
    stabilizeActive = false;
    stopAll();
    return;
  }

  unsigned long now = millis();
  if (now - lastStabilizeTick < (unsigned long)STAB_TICK_MS) return;
  lastStabilizeTick = now;

  // err > 0 → platform robotu sola döndürmüş (yaw arttı varsayımıyla)
  // → ters yöne (saat-yönü, -w) düzelt
  float err = angleDiff(fusedYaw, stabilizeTargetYaw);

  float w = 0.0f;
  if (fabsf(err) > STAB_DEADZONE) {
    w = STAB_KP * err;
    if (w >  STAB_W_MAX) w =  STAB_W_MAX;
    if (w < -STAB_W_MAX) w = -STAB_W_MAX;
  }

  // Sadece dönüş — vx/vy = 0 (yerinde yönü koru)
  omniDrive(0, 0, w);
}

// Küçük selamlama: yerinde sağa-sola sallan
void greet() {
  for (int i = 0; i < 2; i++) {
    omniDrive(0, 0, 0.8f);  delay(200);
    omniDrive(0, 0, -0.8f); delay(400);
    omniDrive(0, 0, 0.8f);  delay(200);
    stopAll();              delay(150);
  }
}

// ═══════════════════════════════════════════════════════════════
//  WEB SOCKET — KOMUT İŞLEME (dog.ino ile uyumlu)
// ═══════════════════════════════════════════════════════════════

// ─── Sensör Okuma (non-blocking, 50 ms aralıkla) ──────────────
void readSensors() {
  unsigned long now = millis();
  if (now - lastSensorRead < 50) return;
  lastSensorRead = now;

  // VL53L0X — mesafe (mm). 8190 = out of range
  if (hasTof) {
    VL53L0X_RangingMeasurementData_t m;
    tof.rangingTest(&m, false);
    robot.distanceMm = (m.RangeStatus != 4) ? m.RangeMilliMeter : 0;
  }

  // MPU6050 — ivme + jiro + sıcaklık
  if (hasImu) {
    sensors_event_t a, g, t;
    imu.getEvent(&a, &g, &t);
    robot.ax = a.acceleration.x;
    robot.ay = a.acceleration.y;
    robot.az = a.acceleration.z;
    // Kalibrasyon bias'ı çıkar (statik drift'i sıfırlar)
    robot.gx = g.gyro.x - gyroBiasX;
    robot.gy = g.gyro.y - gyroBiasY;
    robot.gz = g.gyro.z - gyroBiasZ;
    robot.temperature = t.temperature;
  }

  // QMC5883L — pusula yönü (ham, telemetri için)
  if (hasCompass) {
    compass.read();
    int h = compass.getAzimuth();        // -180..180
    if (h < 0) h += 360;                 // 0..359
    robot.heading = h;
  }

  // Sensör füzyonu — drift-siz, tilt-compensated yaw güncelle
  updateFusedYaw();
}

void sendStatus() {
  StaticJsonDocument<384> resp;
  resp["type"]     = "cyber";
  resp["speed"]    = robot.speed;
  resp["moving"]   = robot.isMoving;
  resp["distance"] = robot.distanceMm;
  resp["heading"]  = robot.heading;
  JsonObject acc = resp.createNestedObject("acc");
  acc["x"] = robot.ax; acc["y"] = robot.ay; acc["z"] = robot.az;
  JsonObject gyr = resp.createNestedObject("gyro");
  gyr["x"] = robot.gx; gyr["y"] = robot.gy; gyr["z"] = robot.gz;
  resp["temp"]     = robot.temperature;
  String out;
  serializeJson(resp, out);
  webSocket.broadcastTXT(out);
}

void processCommand(String msg) {
  StaticJsonDocument<200> doc;
  DeserializationError err = deserializeJson(doc, msg);
  if (err) {
    Serial.println("JSON hata: " + String(err.c_str()));
    return;
  }

  String cmd = doc["cmd"].as<String>();
  robot.lastAction = millis();
  Serial.print("Komut: "); Serial.println(cmd);

  if (cmd == "walk") {
    moveForward(doc["value"] | 5);
  }
  else if (cmd == "back") {
    moveBackward(doc["value"] | 3);
  }
  else if (cmd == "left") {
    rotateLeft(doc["value"] | 3);
  }
  else if (cmd == "right") {
    rotateRight(doc["value"] | 3);
  }
  else if (cmd == "strafeLeft") {
    strafeLeft(doc["value"] | 3);
  }
  else if (cmd == "strafeRight") {
    strafeRight(doc["value"] | 3);
  }
  else if (cmd == "drive") {
    // Sürekli kontrol: {"cmd":"drive","vx":..,"vy":..,"w":..}
    float vx = doc["vx"] | 0.0f;
    float vy = doc["vy"] | 0.0f;
    float w  = doc["w"]  | 0.0f;
    omniDrive(vx, vy, w);
  }
  else if (cmd == "stop") {
    avoidActive     = false;   // kaçış modu da kapansın
    stabilizeActive = false;   // stabilize de kapansın
    stopAll();
  }
  else if (cmd == "stabilize") {
    // Gyro stabilize aç/kapat: {"cmd":"stabilize","value":1/0}
    bool on = (doc["value"] | 0) != 0;
    if (on && !hasImu && !hasCompass) {
      webSocket.broadcastTXT("{\"type\":\"stabilize\",\"status\":\"error\",\"msg\":\"IMU/pusula yok\"}");
      return;
    }
    if (on) {
      avoidActive = false;             // çakışmasın
      readSensors();
      // füzyon hazır değilse kısa bekle
      unsigned long t0 = millis();
      while (!fusionReady && millis() - t0 < 500) { delay(20); readSensors(); }
      stabilizeTargetYaw = fusedYaw;   // mevcut yönü kilitle
      lastStabilizeTick  = 0;
    } else {
      stopAll();
    }
    stabilizeActive = on;
    StaticJsonDocument<96> ack;
    ack["type"]   = "stabilize";
    ack["active"] = on;
    ack["target"] = stabilizeTargetYaw;
    String out; serializeJson(ack, out);
    webSocket.broadcastTXT(out);
    Serial.printf("🧭 Stabilize: %s (target=%.1f°)\n", on ? "ON" : "OFF", stabilizeTargetYaw);
    return;
  }
  else if (cmd == "avoid") {
    // Engelden kaçış modu aç/kapat: {"cmd":"avoid","value":1} veya 0
    bool on = (doc["value"] | 0) != 0;
    if (on && !hasTof) {
      webSocket.broadcastTXT("{\"type\":\"avoid\",\"status\":\"error\",\"msg\":\"ToF yok\"}");
      return;
    }
    avoidActive  = on;
    avoidPhase   = AV_FORWARD;
    avoidPhaseT0 = millis();
    avoidTurnDir = +1;
    if (!on) stopAll();
    StaticJsonDocument<96> ack;
    ack["type"]   = "avoid";
    ack["active"] = on;
    String out; serializeJson(ack, out);
    webSocket.broadcastTXT(out);
    Serial.printf("🚧 Avoid: %s\n", on ? "ON" : "OFF");
    return;
  }
  else if (cmd == "greet") {
    greet();
  }
  else if (cmd == "speed") {
    robot.speed = constrain((int)(doc["value"] | 50), 10, 100);
  }
  else if (cmd == "wifi") {
    // Dinamik WiFi provizyonu: {"cmd":"wifi","ssid":"...","pass":"..."}
    String s = doc["ssid"] | "";
    String p = doc["pass"] | "";
    if (s.length() > 0) {
      prefs.begin("wifi", false);
      prefs.putString("ssid", s);
      prefs.putString("pass", p);
      prefs.end();
      StaticJsonDocument<128> ack;
      ack["type"] = "wifi";
      ack["status"] = "saved";
      ack["ssid"] = s;
      String out; serializeJson(ack, out);
      webSocket.broadcastTXT(out);
      Serial.println("WiFi kaydedildi, 1 sn sonra restart...");
      delay(1000);
      ESP.restart();
    } else {
      webSocket.broadcastTXT("{\"type\":\"wifi\",\"status\":\"error\",\"msg\":\"ssid bos\"}");
    }
    return;
  }
  else if (cmd == "calibrate") {
    stopAll();
    calibrateGyro(300);
    webSocket.broadcastTXT("{\"type\":\"calib\",\"status\":\"done\"}");
    return;
  }
  else if (cmd == "wifiReset") {
    prefs.begin("wifi", false);
    prefs.clear();
    prefs.end();
    webSocket.broadcastTXT("{\"type\":\"wifi\",\"status\":\"reset\"}");
    delay(500);
    ESP.restart();
    return;
  }

  sendStatus();
}

void webSocketEvent(uint8_t num, WStype_t type, uint8_t* payload, size_t length) {
  switch (type) {
    case WStype_CONNECTED:
      Serial.printf("İstemci #%u bağlandı\n", num);
      sendStatus();
      break;
    case WStype_DISCONNECTED:
      Serial.printf("İstemci #%u ayrıldı\n", num);
      avoidActive     = false;
      stabilizeActive = false;
      stopAll();  // Güvenlik
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

void setupMotor(int pin) {
  ledcAttach(pin, PWM_FREQ, PWM_RES);   // ESP32 core v3.x API
  ledcWrite(pin, 0);
}

void setup() {
  Serial.begin(115200);
  Serial.println("\n🤖 CYBER başlatılıyor (3 omni tekerlek)...");

  // Motor PWM kurulumu (ESP32 core v3.x pin tabanlı LEDC)
  setupMotor(M1_IN1);
  setupMotor(M1_IN2);
  setupMotor(M2_IN1);
  setupMotor(M2_IN2);
  setupMotor(M3_IN1);
  setupMotor(M3_IN2);
  stopAll();

  // ─── I²C başlat (3 sensör paylaşıyor) ──────────────────────
  Wire.begin(I2C_SDA, I2C_SCL);
  Wire.setClock(400000);   // 400 kHz fast mode

  // VL53L0X
  if (tof.begin(0x29, false, &Wire)) {
    hasTof = true;
    Serial.println("✅ VL53L0X bulundu (0x29)");
  } else {
    Serial.println("⚠️ VL53L0X bulunamadı");
  }

  // MPU6050
  if (imu.begin(0x68, &Wire)) {
    hasImu = true;
    imu.setAccelerometerRange(MPU6050_RANGE_4_G);
    imu.setGyroRange(MPU6050_RANGE_500_DEG);
    imu.setFilterBandwidth(MPU6050_BAND_21_HZ);
    Serial.println("✅ MPU6050 bulundu (0x68)");
    delay(100);
    calibrateGyro(300);     // Boot'ta sabit dur, bias'ı ölç
  } else {
    Serial.println("⚠️ MPU6050 bulunamadı");
  }

  // QMC5883L pusula
  compass.init();
  // Basit varlık testi: WHO_AM_I yerine bir okuma denemesi
  compass.read();
  hasCompass = true;   // Kütüphane sessiz başlatıyor; donanım yoksa heading=0 kalır
  Serial.println("✅ QMC5883L başlatıldı (0x0D)");

  // Wi-Fi — önce NVS'den oku, yoksa fallback sabitleri kullan
  prefs.begin("wifi", true);
  String savedSsid = prefs.getString("ssid", "");
  String savedPass = prefs.getString("pass", "");
  prefs.end();

  const char* useSsid = savedSsid.length() ? savedSsid.c_str() : SSID;
  const char* usePass = savedPass.length() ? savedPass.c_str() : PASSWORD;
  Serial.printf("Wi-Fi denenecek: %s (%s)\n", useSsid,
                savedSsid.length() ? "NVS" : "fallback");

  WiFi.begin(useSsid, usePass);
  Serial.print("Wi-Fi bağlanıyor");
  int tries = 0;
  while (WiFi.status() != WL_CONNECTED && tries < 20) {
    delay(500);
    Serial.print(".");
    tries++;
  }

  if (WiFi.status() == WL_CONNECTED) {
    Serial.println("\n✅ Bağlandı! IP: " + WiFi.localIP().toString());
  } else {
    Serial.println("\n⚠️ AP modu başlatılıyor (provizyon için)...");
    WiFi.softAP(AP_SSID, AP_PASS);
    Serial.println("AP IP: " + WiFi.softAPIP().toString());
    Serial.println("→ App'ten ws://192.168.4.1:81 ile bağlanıp WiFi gönderin");
  }

  webSocket.begin();
  webSocket.onEvent(webSocketEvent);
  Serial.println("🔌 WebSocket port 81'de hazır");

  robot.lastAction = millis();
}

void loop() {
  webSocket.loop();
  readSensors();
  avoidanceTick();   // avoidActive false ise hızlıca geri döner
  stabilizeTick();   // stabilizeActive false ise hızlıca geri döner

  // 200 ms'de bir telemetri yayını
  unsigned long now = millis();
  if (now - lastTelemetry > 200) {
    lastTelemetry = now;
    sendStatus();
  }

  delay(5);
}
