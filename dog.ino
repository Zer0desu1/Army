#include <ESP32Servo.h>
#include <WiFi.h>
#include <WebSocketsServer.h>
#include <ArduinoJson.h>

const char* SSID     = "WIFI_ADI";
const char* PASSWORD = "WIFI_SIFRE";

#define PIN_FL 25
#define PIN_FR 26
#define PIN_RL 19
#define PIN_RR 22

Servo servoFL, servoFR, servoRL, servoRR;

WebSocketsServer webSocket = WebSocketsServer(81);

enum Emotion {
  NEUTRAL  = 0,
  HAPPY    = 1,
  SAD      = 2,
  EXCITED  = 3,
  SCARED   = 4,
  ANGRY    = 5,
  SLEEPY   = 6
};

struct RobotState {
  Emotion emotion     = NEUTRAL;
  bool    isWalking   = false;
  bool    isSitting   = false;
  int     speed       = 50;
  int     stepDelay   = 200;
  unsigned long lastAction = 0;
  unsigned long idleTime   = 0;
};

RobotState robot;

void smartDelay(unsigned long ms) {
  unsigned long start = millis();
  while (millis() - start < ms) {
    webSocket.loop();
    delay(1);
  }
}
#define delay smartDelay

const int CENTER_FL = 90;
const int CENTER_FR = 90;
const int CENTER_RL = 90;
const int CENTER_RR = 90;

void allCenter() {
  servoFL.write(CENTER_FL);
  servoFR.write(CENTER_FR);
  servoRL.write(CENTER_RL);
  servoRR.write(CENTER_RR);
}

void sitDown() {
  servoFL.write(CENTER_FL + 30);
  servoFR.write(CENTER_FR - 30);
  servoRL.write(CENTER_RL - 45);
  servoRR.write(CENTER_RR + 45);
  robot.isSitting = true;
  robot.isWalking = false;
}

void standUp() {
  allCenter();
  delay(300);
  robot.isSitting = false;
}

static inline void setLegs(int phaseA, int phaseB) {

  servoFL.write(CENTER_FL + phaseA);
  servoRR.write(CENTER_RR - phaseA);
  servoFR.write(CENTER_FR - phaseB);
  servoRL.write(CENTER_RL + phaseB);
}

void walkForward(int steps) {
  robot.isWalking = true;
  robot.isSitting = false;
  int d = map(robot.speed, 0, 100, 400, 80);

  const int STRIDE = 30;
  const int RES    = 12;

  setLegs(STRIDE, -STRIDE);
  delay(d / 4);

  for (int i = 0; i < steps; i++) {
    if (!robot.isWalking) break;

    for (int k = 1; k <= RES; k++) {
      int a = STRIDE - (2 * STRIDE * k) / RES;
      int b = (k <= RES / 2)
        ? -STRIDE + (4 * STRIDE * k) / RES
        : STRIDE;
      setLegs(a, b);
      delay(d / RES);
    }

    if (!robot.isWalking) break;

    for (int k = 1; k <= RES; k++) {
      int b = STRIDE - (2 * STRIDE * k) / RES;
      int a = (k <= RES / 2)
        ? -STRIDE + (4 * STRIDE * k) / RES
        : STRIDE;
      setLegs(a, b);
      delay(d / RES);
    }
  }

  allCenter();
}

void walkBackward(int steps) {
  robot.isWalking = true;
  int d = map(robot.speed, 0, 100, 400, 80);

  const int SWING = 30;
  const int PUSH  = 20;

  for (int i = 0; i < steps; i++) {
    if (!robot.isWalking) break;

    servoFL.write(CENTER_FL - SWING);
    servoRR.write(CENTER_RR + SWING);
    servoFR.write(CENTER_FR - PUSH);
    servoRL.write(CENTER_RL + PUSH);
    delay(d / 2);
    allCenter();
    delay(d / 4);

    servoFR.write(CENTER_FR + SWING);
    servoRL.write(CENTER_RL - SWING);
    servoFL.write(CENTER_FL + PUSH);
    servoRR.write(CENTER_RR - PUSH);
    delay(d / 2);
    allCenter();
    delay(d / 4);
  }
}

void turnLeft(int steps) {
  robot.isWalking = true;
  int d = map(robot.speed, 0, 100, 400, 100);

  for (int i = 0; i < steps; i++) {
    if (!robot.isWalking) break;

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

void behaviorSleepy() {
  for (int angle = 0; angle <= 20; angle += 2) {
    servoFL.write(CENTER_FL + angle);
    servoFR.write(CENTER_FR - angle);
    servoRL.write(CENTER_RL - angle / 2);
    servoRR.write(CENTER_RR + angle / 2);
    delay(100);
  }
}

void behaviorGreet() {
  servoFL.write(CENTER_FL + 60);
  delay(600);
  servoFL.write(CENTER_FL);
  delay(300);
  servoFL.write(CENTER_FL + 60);
  delay(600);
  servoFL.write(CENTER_FL);
}

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

void idleBehavior() {
  unsigned long now = millis();
  if (now - robot.lastAction > 10000) {
    robot.idleTime += now - robot.lastAction;
    robot.lastAction = now;

    int r = random(0, 4);
    switch (r) {
      case 0: behaviorHappy();  break;
      case 1:
        servoFL.write(CENTER_FL + 20);
        servoFR.write(CENTER_FR - 20);
        delay(500);
        allCenter();
        break;
      case 2: behaviorSleepy(); break;
      case 3: behaviorGreet();  break;
    }
  }

  if (robot.idleTime > 30000 && !robot.isSitting) {
    sitDown();
    robot.emotion = SLEEPY;
  }
}

void sendStatus() {
  const char* emotionNames[] = {"neutral","happy","sad","excited","scared","angry","sleepy"};
  StaticJsonDocument<128> resp;
  resp["emotion"] = robot.emotion;
  resp["emotionName"] = emotionNames[robot.emotion];
  resp["speed"]   = robot.speed;
  resp["sitting"] = robot.isSitting;
  resp["walking"] = robot.isWalking;

  String out;
  serializeJson(resp, out);
  webSocket.broadcastTXT(out);
}

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
    if (robot.isWalking) return;
    int steps = doc["value"] | 5;
    standUp();
    walkForward(steps);
    robot.isWalking = false;
  }
  else if (cmd == "back") {
    if (robot.isWalking) return;
    int steps = doc["value"] | 3;
    standUp();
    walkBackward(steps);
    robot.isWalking = false;
  }
  else if (cmd == "left") {
    if (robot.isWalking) return;
    standUp();
    turnLeft(doc["value"] | 3);
    robot.isWalking = false;
  }
  else if (cmd == "right") {
    if (robot.isWalking) return;
    standUp();
    turnRight(doc["value"] | 3);
    robot.isWalking = false;
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
      break;
    case WStype_TEXT:
      processCommand(String((char*)payload));
      break;
    default:
      break;
  }
}

void setup() {
  Serial.begin(115200);
  Serial.println("\n🐾 Robot Köpek başlatılıyor...");

  servoFL.attach(PIN_FL, 500, 2400);
  servoFR.attach(PIN_FR, 500, 2400);
  servoRL.attach(PIN_RL, 500, 2400);
  servoRR.attach(PIN_RR, 500, 2400);
  allCenter();
  delay(500);

  behaviorHappy();

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
    behaviorExcited();
  } else {
    Serial.println("\n⚠️ Wi-Fi bulunamadı, AP modu başlatılıyor...");
    WiFi.softAP("RobotKopek", "kopek1234");
    Serial.println("AP IP: " + WiFi.softAPIP().toString());
    applyEmotion(SAD);
  }

  webSocket.begin();
  webSocket.onEvent(webSocketEvent);
  Serial.println("🔌 WebSocket sunucusu port 81'de başladı");

  robot.lastAction = millis();
}

void loop() {
  webSocket.loop();

  if (!robot.isWalking && !robot.isSitting) {
    idleBehavior();
  }

  delay(10);
}
