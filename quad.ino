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

const char* SSID     = "WIFI_ADI";
const char* PASSWORD = "WIFI_SIFRE";

const char* AP_SSID  = "Quad";
const char* AP_PASS  = "quad1234";

Preferences prefs;

#define M1_IN1 32
#define M1_IN2 33
#define M2_IN1 5
#define M2_IN2 18
#define M3_IN1 25
#define M3_IN2 26
#define M4_IN1 19
#define M4_IN2 21

#define PWM_FREQ  20000
#define PWM_RES   8

float REV_BOOST = 1.0f;

#if ESP_ARDUINO_VERSION_MAJOR >= 3
  static inline void pwmSetup(int pin) { ledcAttach(pin, PWM_FREQ, PWM_RES); }
  static inline void pwmWrite(int pin, int duty) { ledcWrite(pin, duty); }
#else

  int pinToChannel(int pin) {
    if (pin == M1_IN1) return 0;
    if (pin == M1_IN2) return 1;
    if (pin == M2_IN1) return 2;
    if (pin == M2_IN2) return 3;
    if (pin == M3_IN1) return 4;
    if (pin == M3_IN2) return 5;
    if (pin == M4_IN1) return 6;
    if (pin == M4_IN2) return 7;
    return -1;
  }
  static inline void pwmSetup(int pin) {
    int ch = pinToChannel(pin);
    if (ch < 0) return;
    ledcSetup(ch, PWM_FREQ, PWM_RES);
    ledcAttachPin(pin, ch);
  }
  static inline void pwmWrite(int pin, int duty) {
    int ch = pinToChannel(pin);
    if (ch >= 0) ledcWrite(ch, duty);
  }
#endif

#define I2C_SDA 22
#define I2C_SCL 23

#define SERVO_PIN     4
#define SERVO_DEFAULT 90
#define SERVO_FREQ    50
#define SERVO_RES     16
#define SERVO_MIN_US  500
#define SERVO_MAX_US  2400
#define SERVO_CH      8
int servoAngle = 0;

void servoWrite(int angle) {
  angle = constrain(angle, 0, 180);
  long us = SERVO_MIN_US + (long)(SERVO_MAX_US - SERVO_MIN_US) * angle / 180;
  uint32_t maxDuty = (1UL << SERVO_RES) - 1;
  uint32_t duty = (uint32_t)((uint64_t)us * maxDuty / 20000);
#if ESP_ARDUINO_VERSION_MAJOR >= 3
  ledcWrite(SERVO_PIN, duty);
#else
  ledcWrite(SERVO_CH, duty);
#endif
}

void servoSetup() {
#if ESP_ARDUINO_VERSION_MAJOR >= 3
  ledcAttach(SERVO_PIN, SERVO_FREQ, SERVO_RES);
#else
  ledcSetup(SERVO_CH, SERVO_FREQ, SERVO_RES);
  ledcAttachPin(SERVO_PIN, SERVO_CH);
#endif
}

#define UART_RX2 16
#define UART_TX2 17
#define UART_BAUD 9600

bool convoyActive = false;

int  convoyCyberSpeed = 100;

Adafruit_VL53L0X  tof;
Adafruit_MPU6050  imu;
QMC5883LCompass   compass;

bool hasTof = false, hasImu = false, hasCompass = false;

float gyroBiasX = 0.0f, gyroBiasY = 0.0f, gyroBiasZ = 0.0f;
bool  imuCalibrated = false;

const float FUSION_ALPHA = 0.98f;
float fusedYaw = 0.0f;
unsigned long lastFusionT = 0;
bool fusionReady = false;

WebSocketsServer webSocket = WebSocketsServer(81);

struct RobotState {
  int   speed     = 75;
  bool  isMoving  = false;
  unsigned long lastAction = 0;
  uint16_t distanceMm = 0;
  float    ax = 0, ay = 0, az = 0;
  float    gx = 0, gy = 0, gz = 0;
  float    temperature = 0;
  int      heading = 0;
};
RobotState robot;

unsigned long lastSensorRead = 0;
unsigned long lastTelemetry  = 0;

enum AvoidPhase : uint8_t { AV_FORWARD, AV_TURNING };
bool          avoidActive    = false;
AvoidPhase    avoidPhase     = AV_FORWARD;
int8_t        avoidTurnDir   = +1;
unsigned long avoidPhaseT0   = 0;
const uint16_t AVOID_SAFE_MM     = 350;
const uint16_t AVOID_CLEAR_MM    = 500;
const uint16_t AVOID_TURN_MAX_MS = 1800;
const uint16_t AVOID_TURN_MIN_MS = 200;
const float    AVOID_FWD_SPEED   = 0.7f;
const float    AVOID_TURN_RATE   = 0.7f;

bool          stabilizeActive = false;
float         stabilizeTargetYaw = 0.0f;
unsigned long lastStabilizeTick  = 0;
const float   STAB_KP        = 0.030f;
const float   STAB_DEADZONE  = 1.5f;
const float   STAB_W_MAX     = 0.85f;
const int     STAB_TICK_MS   = 20;

void smartDelay(unsigned long ms) {
  unsigned long start = millis();
  while (millis() - start < ms) {
    webSocket.loop();
    delay(1);
  }
}
#define delay smartDelay

void driveMotor(int pinIn1, int pinIn2, int v) {

  v = constrain(v, -255, 255);
  if (v > 0) {
    pwmWrite(pinIn1, v);
    pwmWrite(pinIn2, 0);
  } else if (v < 0) {
    int pwm = (int)((-v) * REV_BOOST);
    if (pwm > 255) pwm = 255;
    pwmWrite(pinIn1, 0);
    pwmWrite(pinIn2, pwm);
  } else {
    pwmWrite(pinIn1, 0);
    pwmWrite(pinIn2, 0);
  }
}

void driveWheels(int fl, int fr, int rl, int rr) {
  driveMotor(M1_IN1, M1_IN2, -rl);
  driveMotor(M2_IN1, M2_IN2, -fr);
  driveMotor(M3_IN1, M3_IN2,  fl);
  driveMotor(M4_IN1, M4_IN2,  rr);
  robot.isMoving = (fl || fr || rl || rr);
}

void omniDrive(float vx, float vy, float w) {

  float vFL = vy - vx + w;
  float vFR = vy + vx + w;
  float vRL = vy - vx - w;
  float vRR = vy + vx - w;

  float maxv = fmaxf(fmaxf(fabsf(vFL), fabsf(vFR)),
                     fmaxf(fabsf(vRL), fabsf(vRR)));
  if (maxv < 1.0f) maxv = 1.0f;
  vFL /= maxv;  vFR /= maxv;  vRL /= maxv;  vRR /= maxv;

  float scale = robot.speed / 100.0f;
  driveWheels((int)(vFL * 255 * scale), (int)(vFR * 255 * scale),
              (int)(vRL * 255 * scale), (int)(vRR * 255 * scale));
}

void stopAll() {
  omniDrive(0, 0, 0);
  robot.isMoving = false;
}

const int STEP_MS = 250;

float HH_KP = 0.030f;
float HH_KI = 0.0010f;
const float HH_DEADZONE = 3.0f;
const float HH_W_MAX    = 0.45f;
const float HH_I_MAX    = 0.30f;
const int   HH_TICK_MS  = 20;

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
    delay(5);
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

float angleDiff(float target, float current) {
  float d = target - current;
  while (d > 180.0f)  d -= 360.0f;
  while (d < -180.0f) d += 360.0f;
  return d;
}

float tiltCompensatedHeading() {
  float roll  = atan2f(robot.ay, robot.az);
  float pitch = atan2f(-robot.ax,
                       sqrtf(robot.ay * robot.ay + robot.az * robot.az));
  float mx = (float)compass.getX();
  float my = (float)compass.getY();
  float mz = (float)compass.getZ();
  float cosR = cosf(roll),  sinR = sinf(roll);
  float cosP = cosf(pitch), sinP = sinf(pitch);
  float Xh = mx * cosP + mz * sinP;
  float Yh = mx * sinR * sinP + my * cosR - mz * sinR * cosP;
  float headingRad = atan2f(-Yh, Xh);
  float headingDeg = headingRad * 180.0f / (float)M_PI;
  if (headingDeg < 0) headingDeg += 360.0f;
  return headingDeg;
}

void updateFusedYaw() {
  if (!hasImu && !hasCompass) return;
  unsigned long now = millis();
  if (lastFusionT == 0) { lastFusionT = now; return; }
  float dt = (now - lastFusionT) / 1000.0f;
  lastFusionT = now;
  if (dt <= 0 || dt > 0.5f) return;

  float magYaw = fusionReady ? fusedYaw : 0.0f;
  bool haveMag = false;
  if (hasCompass && hasImu) {
    magYaw  = tiltCompensatedHeading();
    haveMag = true;
  } else if (hasCompass) {
    magYaw  = (float)robot.heading;
    haveMag = true;
  }

  float gyroYaw = fusedYaw + (hasImu ? robot.gz * dt * 180.0f / (float)M_PI : 0.0f);

  if (!fusionReady) {
    fusedYaw = haveMag ? magYaw : 0.0f;
    fusionReady = true;
    return;
  }

  if (haveMag) {
    float delta = angleDiff(magYaw, gyroYaw);
    fusedYaw = gyroYaw + (1.0f - FUSION_ALPHA) * delta;
  } else {
    fusedYaw = gyroYaw;
  }

  while (fusedYaw < 0)       fusedYaw += 360.0f;
  while (fusedYaw >= 360.0f) fusedYaw -= 360.0f;
}

void readSensors();

void driveStraight(float vy, unsigned long totalMs) {
  if (!hasCompass && !hasImu) {
    omniDrive(0, vy, 0);
    delay(totalMs);
    stopAll();
    return;
  }

  readSensors();
  unsigned long t0 = millis();
  while (!fusionReady && millis() - t0 < 500) {
    delay(20);
    readSensors();
  }
  float targetYaw = fusedYaw;

  float iAccum = 0.0f;
  unsigned long lastTick = millis();
  unsigned long start    = lastTick;

  while (millis() - start < totalMs) {
    webSocket.loop();
    readSensors();

    unsigned long now = millis();
    float dt = (now - lastTick) / 1000.0f;
    lastTick = now;

    float err = angleDiff(fusedYaw, targetYaw);

    float Kp = HH_KP;
    float Ki = HH_KI;

    float w = 0.0f;
    if (fabsf(err) > HH_DEADZONE) {
      iAccum += err * dt;
      float iLimit = (Ki > 1e-6f) ? (HH_I_MAX / Ki) : 0.0f;
      if (iAccum >  iLimit) iAccum =  iLimit;
      if (iAccum < -iLimit) iAccum = -iLimit;

      w = Kp * err + Ki * iAccum;
      if (w >  HH_W_MAX) w =  HH_W_MAX;
      if (w < -HH_W_MAX) w = -HH_W_MAX;
    } else {
      iAccum *= 0.95f;
    }

    omniDrive(0, vy, w);
    delay(HH_TICK_MS);
  }

  stopAll();
}

void moveForward(int steps)  { driveStraight(+1.0f, (unsigned long)steps * STEP_MS); }
void moveBackward(int steps) { driveStraight(-1.0f, (unsigned long)steps * STEP_MS); }

void rotateLeft(int steps) {
  for (int i = 0; i < steps; i++) { omniDrive(0, 0, 1.0f);  delay(STEP_MS); }
  stopAll();
}
void rotateRight(int steps) {
  for (int i = 0; i < steps; i++) { omniDrive(0, 0, -1.0f); delay(STEP_MS); }
  stopAll();
}
void strafeLeft(int steps) {
  for (int i = 0; i < steps; i++) { omniDrive(-1.0f, 0, 0); delay(STEP_MS); }
  stopAll();
}
void strafeRight(int steps) {
  for (int i = 0; i < steps; i++) { omniDrive(+1.0f, 0, 0); delay(STEP_MS); }
  stopAll();
}

void motorTest() {
  stopAll();
  struct { int in1, in2; const char* name; } M[4] = {
    { M1_IN1, M1_IN2, "M1 (kod: FL)" },
    { M2_IN1, M2_IN2, "M2 (kod: FR)" },
    { M3_IN1, M3_IN2, "M3 (kod: RL)" },
    { M4_IN1, M4_IN2, "M4 (kod: RR)" }
  };
  for (int i = 0; i < 4; i++) {
    Serial.printf("🔧 TEST %d → %s (ham ileri)\n", i + 1, M[i].name);
    String msg = String("{\"type\":\"motorTest\",\"step\":") + (i + 1) + ",\"motor\":\"" + M[i].name + "\"}";
    webSocket.broadcastTXT(msg);
    driveMotor(M[i].in1, M[i].in2, 160);
    delay(1500);
    driveMotor(M[i].in1, M[i].in2, 0);
    delay(900);
  }
  Serial.println("✅ Motor testi bitti");
  webSocket.broadcastTXT("{\"type\":\"motorTest\",\"step\":0}");
}

void kinTest() {
  stopAll();
  const int P = 200;
  struct { int fl, fr, rl, rr; const char* name; } T[4] = {
    { +P, +P, +P, +P, "A [+,+,+,+]" },
    { +P, -P, +P, -P, "B [+,-,+,-]" },
    { +P, +P, -P, -P, "C [+,+,-,-]" },
    { +P, -P, -P, +P, "D [+,-,-,+]" }
  };
  for (int i = 0; i < 4; i++) {
    Serial.printf("🧭 KIN %d → %s\n", i + 1, T[i].name);
    String msg = String("{\"type\":\"kinTest\",\"step\":") + (i + 1) + ",\"pattern\":\"" + T[i].name + "\"}";
    webSocket.broadcastTXT(msg);
    driveWheels(T[i].fl, T[i].fr, T[i].rl, T[i].rr);
    delay(1700);
    driveWheels(0, 0, 0, 0);
    delay(1100);
  }
  Serial.println("✅ Kinematik testi bitti");
  webSocket.broadcastTXT("{\"type\":\"kinTest\",\"step\":0}");
}

void avoidanceTick() {
  if (!avoidActive) return;
  if (!hasTof) { avoidActive = false; stopAll(); return; }

  uint16_t d = robot.distanceMm;
  unsigned long now = millis();
  unsigned long phaseMs = now - avoidPhaseT0;
  bool blocked = (d > 0 && d < AVOID_SAFE_MM);
  bool clear   = (d == 0 || d > AVOID_CLEAR_MM);

  if (avoidPhase == AV_FORWARD) {
    if (blocked) {
      avoidTurnDir = -avoidTurnDir;
      avoidPhase   = AV_TURNING;
      avoidPhaseT0 = now;
      stopAll();
      Serial.printf("🚧 Engel %dmm → %s dön\n", d, avoidTurnDir > 0 ? "sola" : "sağa");
      return;
    }
    omniDrive(0, AVOID_FWD_SPEED, 0);
  } else {
    if (phaseMs > AVOID_TURN_MIN_MS && clear) {
      avoidPhase   = AV_FORWARD;
      avoidPhaseT0 = now;
      Serial.printf("✅ Açık (%dmm) → ileri\n", d);
      return;
    }
    if (phaseMs > AVOID_TURN_MAX_MS) {
      avoidTurnDir = -avoidTurnDir;
      avoidPhaseT0 = now;
    }
    omniDrive(0, 0, AVOID_TURN_RATE * avoidTurnDir);
  }
}

void stabilizeTick() {
  if (!stabilizeActive) return;
  if (!hasImu && !hasCompass) { stabilizeActive = false; stopAll(); return; }

  unsigned long now = millis();
  if (now - lastStabilizeTick < (unsigned long)STAB_TICK_MS) return;
  lastStabilizeTick = now;

  float err = angleDiff(fusedYaw, stabilizeTargetYaw);
  float w = 0.0f;
  if (fabsf(err) > STAB_DEADZONE) {
    w = STAB_KP * err;
    if (w >  STAB_W_MAX) w =  STAB_W_MAX;
    if (w < -STAB_W_MAX) w = -STAB_W_MAX;
  }
  omniDrive(0, 0, w);
}

void greet() {
  for (int i = 0; i < 2; i++) {
    omniDrive(0, 0, 0.8f);  delay(200);
    omniDrive(0, 0, -0.8f); delay(400);
    omniDrive(0, 0, 0.8f);  delay(200);
    stopAll();              delay(150);
  }
}

void readSensors() {
  unsigned long now = millis();
  if (now - lastSensorRead < 50) return;
  lastSensorRead = now;

  if (hasTof) {
    VL53L0X_RangingMeasurementData_t m;
    tof.rangingTest(&m, false);
    robot.distanceMm = (m.RangeStatus != 4) ? m.RangeMilliMeter : 0;
  }
  if (hasImu) {
    sensors_event_t a, g, t;
    imu.getEvent(&a, &g, &t);
    robot.ax = a.acceleration.x;
    robot.ay = a.acceleration.y;
    robot.az = a.acceleration.z;
    robot.gx = g.gyro.x - gyroBiasX;
    robot.gy = g.gyro.y - gyroBiasY;
    robot.gz = g.gyro.z - gyroBiasZ;
    robot.temperature = t.temperature;
  }
  if (hasCompass) {
    compass.read();
    int h = compass.getAzimuth();
    if (h < 0) h += 360;
    robot.heading = h;
  }
  updateFusedYaw();
}

void sendStatus() {
  StaticJsonDocument<384> resp;
  resp["type"]     = "quad";
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

  if (convoyActive &&
      (cmd == "walk" || cmd == "back" || cmd == "left" || cmd == "right" ||
       cmd == "strafeLeft" || cmd == "strafeRight" || cmd == "drive" ||
       cmd == "stop")) {
    Serial2.println(msg);
  }

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
    float vx = doc["vx"] | 0.0f;
    float vy = doc["vy"] | 0.0f;
    float w  = doc["w"]  | 0.0f;
    omniDrive(vx, vy, w);
  }
  else if (cmd == "stop") {
    avoidActive     = false;
    stabilizeActive = false;
    stopAll();
  }
  else if (cmd == "stabilize") {
    bool on = (doc["value"] | 0) != 0;
    if (on && !hasImu && !hasCompass) {
      webSocket.broadcastTXT("{\"type\":\"stabilize\",\"status\":\"error\",\"msg\":\"IMU/pusula yok\"}");
      return;
    }
    if (on) {
      avoidActive = false;
      readSensors();
      unsigned long t0 = millis();
      while (!fusionReady && millis() - t0 < 500) { delay(20); readSensors(); }
      stabilizeTargetYaw = fusedYaw;
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
    return;
  }
  else if (cmd == "avoid") {
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
    return;
  }
  else if (cmd == "greet") {
    greet();
  }
  else if (cmd == "servo") {

    int ang = doc["value"] | SERVO_DEFAULT;
    servoAngle = constrain(ang, 0, 180);
    servoWrite(servoAngle);
    Serial.printf("🦾 Servo → %d°\n", servoAngle);
    StaticJsonDocument<64> ack;
    ack["type"]  = "servo";
    ack["angle"] = servoAngle;
    String out; serializeJson(ack, out);
    webSocket.broadcastTXT(out);
    return;
  }
  else if (cmd == "uart") {

    String data = doc["value"] | "";
    Serial2.println(data);
    Serial.println("📡 UART2 gönderildi: " + data);
    StaticJsonDocument<128> ack;
    ack["type"] = "uart";
    ack["sent"] = data;
    String out; serializeJson(ack, out);
    webSocket.broadcastTXT(out);
    return;
  }
  else if (cmd == "convoy") {

    convoyActive = (doc["value"] | 0) != 0;
    if (convoyActive) {

      Serial2.printf("{\"cmd\":\"speed\",\"value\":%d}\n", convoyCyberSpeed);
    } else {
      Serial2.println("{\"cmd\":\"stop\"}");
    }
    StaticJsonDocument<96> ack;
    ack["type"]        = "convoy";
    ack["active"]      = convoyActive;
    ack["cyberSpeed"]  = convoyCyberSpeed;
    String out; serializeJson(ack, out);
    webSocket.broadcastTXT(out);
    Serial.printf("🚚 Convoy: %s (cyber hız=%d)\n", convoyActive ? "ON" : "OFF", convoyCyberSpeed);
    return;
  }
  else if (cmd == "convoySpeed") {

    convoyCyberSpeed = constrain((int)(doc["value"] | 100), 10, 100);
    if (convoyActive) {
      Serial2.printf("{\"cmd\":\"speed\",\"value\":%d}\n", convoyCyberSpeed);
    }
    StaticJsonDocument<64> ack;
    ack["type"]       = "convoySpeed";
    ack["cyberSpeed"] = convoyCyberSpeed;
    String out; serializeJson(ack, out);
    webSocket.broadcastTXT(out);
    Serial.printf("🚚 Cyber hız → %d\n", convoyCyberSpeed);
    return;
  }
  else if (cmd == "motorTest") {
    motorTest();
    return;
  }
  else if (cmd == "kinTest") {
    kinTest();
    return;
  }
  else if (cmd == "speed") {
    robot.speed = constrain((int)(doc["value"] | 50), 10, 100);
  }
  else if (cmd == "wifi") {
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
      delay(1000);
      ESP.restart();
    } else {
      webSocket.broadcastTXT("{\"type\":\"wifi\",\"status\":\"error\",\"msg\":\"ssid bos\"}");
    }
    return;
  }
  else if (cmd == "pid") {
    bool changed = false;
    if (doc.containsKey("kp")) { HH_KP = doc["kp"].as<float>(); changed = true; }
    if (doc.containsKey("ki")) { HH_KI = doc["ki"].as<float>(); changed = true; }
    if (changed) {
      prefs.begin("pid", false);
      prefs.putFloat("kp", HH_KP);
      prefs.putFloat("ki", HH_KI);
      prefs.end();
    }
    StaticJsonDocument<96> ack;
    ack["type"] = "pid";
    ack["kp"]   = HH_KP;
    ack["ki"]   = HH_KI;
    String out; serializeJson(ack, out);
    webSocket.broadcastTXT(out);
    Serial.printf("⚙️ PID: Kp=%.4f Ki=%.4f\n", HH_KP, HH_KI);
    return;
  }
  else if (cmd == "trim") {
    if (doc.containsKey("rev")) {
      REV_BOOST = doc["rev"].as<float>();
      if (REV_BOOST < 0.5f) REV_BOOST = 0.5f;
      if (REV_BOOST > 2.0f) REV_BOOST = 2.0f;
      prefs.begin("trim", false);
      prefs.putFloat("rev", REV_BOOST);
      prefs.end();
    }
    StaticJsonDocument<96> ack;
    ack["type"] = "trim";
    ack["rev"]  = REV_BOOST;
    String out; serializeJson(ack, out);
    webSocket.broadcastTXT(out);
    Serial.printf("⚙️ Trim: rev=%.3f\n", REV_BOOST);
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
    case WStype_CONNECTED: {
      Serial.printf("İstemci #%u bağlandı\n", num);
      sendStatus();
      StaticJsonDocument<96> ack;
      ack["type"] = "pid";
      ack["kp"]   = HH_KP;
      ack["ki"]   = HH_KI;
      String out; serializeJson(ack, out);
      webSocket.sendTXT(num, out);
      StaticJsonDocument<96> tack;
      tack["type"] = "trim";
      tack["rev"]  = REV_BOOST;
      String tout; serializeJson(tack, tout);
      webSocket.sendTXT(num, tout);
      break;
    }
    case WStype_DISCONNECTED:
      Serial.printf("İstemci #%u ayrıldı\n", num);
      avoidActive     = false;
      stabilizeActive = false;
      stopAll();
      break;
    case WStype_TEXT:
      processCommand(String((char*)payload));
      break;
    default:
      break;
  }
}

void setupMotor(int pin) {
  pwmSetup(pin);
  pwmWrite(pin, 0);
}

void setup() {
  Serial.begin(115200);
  Serial.println("\n🤖 QUAD başlatılıyor (4 omni tekerlek, X-konfig)...");

  setupMotor(M1_IN1); setupMotor(M1_IN2);
  setupMotor(M2_IN1); setupMotor(M2_IN2);
  setupMotor(M3_IN1); setupMotor(M3_IN2);
  setupMotor(M4_IN1); setupMotor(M4_IN2);
  stopAll();

  servoSetup();
  servoWrite(servoAngle);
  Serial.printf("🦾 Servo hazır (GPIO%d), açı=%d°\n", SERVO_PIN, servoAngle);

  Serial2.begin(UART_BAUD, SERIAL_8N1, UART_RX2, UART_TX2);
  Serial.printf("📡 UART2 hazır (RX2=%d, TX2=%d, %d baud)\n", UART_RX2, UART_TX2, UART_BAUD);

  Wire.begin(I2C_SDA, I2C_SCL);
  Wire.setClock(400000);

  if (tof.begin(0x29, false, &Wire)) {
    hasTof = true;
    Serial.println("✅ VL53L0X bulundu (0x29)");
  } else {
    Serial.println("⚠️ VL53L0X bulunamadı");
  }

  if (imu.begin(0x68, &Wire)) {
    hasImu = true;
    imu.setAccelerometerRange(MPU6050_RANGE_4_G);
    imu.setGyroRange(MPU6050_RANGE_500_DEG);
    imu.setFilterBandwidth(MPU6050_BAND_21_HZ);
    Serial.println("✅ MPU6050 bulundu (0x68)");
    delay(100);
    calibrateGyro(300);
  } else {
    Serial.println("⚠️ MPU6050 bulunamadı");
  }

  compass.init();
  compass.read();
  hasCompass = true;
  Serial.println("✅ QMC5883L başlatıldı (0x0D)");

  prefs.begin("pid", true);
  HH_KP = prefs.getFloat("kp", HH_KP);
  HH_KI = prefs.getFloat("ki", HH_KI);
  prefs.end();
  Serial.printf("⚙️ PID yüklendi: Kp=%.4f Ki=%.4f\n", HH_KP, HH_KI);

  prefs.begin("trim", true);
  REV_BOOST = prefs.getFloat("rev", REV_BOOST);
  prefs.end();
  Serial.printf("⚙️ Trim yüklendi: rev=%.3f\n", REV_BOOST);

  if (hasImu || hasCompass) {
    Serial.print("🔗 Pusula-jiro senkronu");
    fusionReady = false;
    lastFusionT = 0;
    for (int i = 0; i < 20; i++) {
      readSensors();
      delay(20);
      if (i % 5 == 0) Serial.print(".");
    }
    Serial.printf("\n✅ Senkron: fusedYaw=%.1f° (ref pusula=%d°)\n",
                  fusedYaw, robot.heading);
  }

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
  }

  webSocket.begin();
  webSocket.onEvent(webSocketEvent);
  Serial.println("🔌 WebSocket port 81'de hazır");

  robot.lastAction = millis();
}

void loop() {
  webSocket.loop();
  readSensors();
  avoidanceTick();
  stabilizeTick();

  unsigned long now = millis();
  if (now - lastTelemetry > 200) {
    lastTelemetry = now;
    sendStatus();
  }

  delay(5);
}
