#include "esp_camera.h"
#include <WiFi.h>
#include "esp_http_server.h"

// ─── Wi-Fi Ayarları (Ana kodunuzdaki ile aynı yapıldı) ───
const char* ssid     = "VodafoneNet-303b10";
const char* password = "5209403306v";

// ─── AI-Thinker ESP32-CAM Pin Tanımlamaları ───
#define PWDN_GPIO_NUM     32
#define RESET_GPIO_NUM    -1
#define XCLK_GPIO_NUM      0
#define SIOD_GPIO_NUM     26
#define SIOC_GPIO_NUM     27
#define Y9_GPIO_NUM       35
#define Y8_GPIO_NUM       34
#define Y7_GPIO_NUM       39
#define Y6_GPIO_NUM       36
#define Y5_GPIO_NUM       21
#define Y4_GPIO_NUM       19
#define Y3_GPIO_NUM       18
#define Y2_GPIO_NUM        5
#define VSYNC_GPIO_NUM    25
#define HREF_GPIO_NUM     23
#define PCLK_GPIO_NUM     22

httpd_handle_t stream_httpd = NULL;

// ─── Video Akışı (MJPEG) Format Ayarları ───
#define PART_BOUNDARY "123456789000000000000987654321"
static const char* _STREAM_CONTENT_TYPE = "multipart/x-mixed-replace;boundary=" PART_BOUNDARY;
static const char* _STREAM_BOUNDARY = "\r\n--" PART_BOUNDARY "\r\n";
static const char* _STREAM_PART = "Content-Type: image/jpeg\r\nContent-Length: %u\r\n\r\n";

esp_err_t stream_handler(httpd_req_t *req) {
  camera_fb_t * fb = NULL;
  esp_err_t res = ESP_OK;
  size_t _jpg_buf_len = 0;
  uint8_t * _jpg_buf = NULL;
  char * part_buf[64];

  res = httpd_resp_set_type(req, _STREAM_CONTENT_TYPE);
  if (res == ESP_OK) {
    httpd_resp_set_hdr(req, "Access-Control-Allow-Origin", "*");
  }
  if (res != ESP_OK) return res;

  while (true) {
    fb = esp_camera_fb_get();
    if (!fb) {
      Serial.println("Kamera karesi (frame) alinamadi!");
      res = ESP_FAIL;
      break;
    }

    // Frame'i kendi heap buffer'ımıza KOPYALA, FB'yi hemen kameraya geri ver.
    // Böylece HTTP gönderimi sırasında DMA için her zaman boş bir slot kalır
    // → DMA overflow'ın asıl nedeni budur.
    _jpg_buf_len = fb->len;
    _jpg_buf = (uint8_t*) malloc(_jpg_buf_len);
    if (!_jpg_buf) {
      esp_camera_fb_return(fb);
      Serial.println("malloc başarısız (heap dolu)");
      res = ESP_FAIL;
      break;
    }
    memcpy(_jpg_buf, fb->buf, _jpg_buf_len);
    esp_camera_fb_return(fb);
    fb = NULL;

    // Şimdi rahatça gönder — kamera DMA bu sırada bir sonraki frame'i yazıyor.
    size_t hlen = snprintf((char *)part_buf, 64, _STREAM_PART, _jpg_buf_len);
    res = httpd_resp_send_chunk(req, (const char *)part_buf, hlen);
    if (res == ESP_OK) {
      res = httpd_resp_send_chunk(req, (const char *)_jpg_buf, _jpg_buf_len);
    }
    if (res == ESP_OK) {
      res = httpd_resp_send_chunk(req, _STREAM_BOUNDARY, strlen(_STREAM_BOUNDARY));
    }

    free(_jpg_buf);
    _jpg_buf = NULL;

    if (res != ESP_OK) break;
  }
  return res;
}

void startCameraServer() {
  httpd_config_t config = HTTPD_DEFAULT_CONFIG();
  
  // Kontrol paneli kameraları 81 portundan beklediği için portu 81 yapıyoruz.
  // Bu sayede uygulamada Otomatik Tarama yaptığınızda kamerayı da bulabileceksiniz.
  config.server_port = 81; 

  httpd_uri_t stream_uri = {
    .uri       = "/stream",
    .method    = HTTP_GET,
    .handler   = stream_handler,
    .user_ctx  = NULL
  };

  Serial.printf("Kamera yayini port %d uzerinde baslatiliyor...\n", config.server_port);
  if (httpd_start(&stream_httpd, &config) == ESP_OK) {
    httpd_register_uri_handler(stream_httpd, &stream_uri);
  }
}

#include "soc/soc.h"           // Brownout detector kapatmak için
#include "soc/rtc_cntl_reg.h"  // Brownout detector kapatmak için

void setup() {
  // Brownout detector AÇIK — voltaj düşerse "Brownout detector was triggered"
  // mesajı görerek güç problemini kesin tanımlayabiliriz.
  // (Önceden WRITE_PERI_REG ile kapatılmıştı — şimdi tanı için açık.)

  Serial.begin(115200);
  Serial.setDebugOutput(false);   // detaylı esp-idf log'ları stack kullanır, kapat
  Serial.println();

  // Gücün toparlanması için biraz bekle
  delay(1000);

  // 1. Wi-Fi Bağlantısı — yayın gücü VARSAYILANDA kalsın.
  // 8.5 dBm gibi düşük güç stream throughput'unu kısıtlıyor → http_send_chunk
  // bloklanıyor → frame buffer'lar boşaltılamıyor → DMA overflow.
  Serial.print("Wi-Fi'a baglaniliyor");
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);                  // WiFi modem-sleep KAPALI: stream gecikmesi azalır
  WiFi.begin(ssid, password);
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }
  Serial.println("\nWiFi baglandi!");

  // Wi-Fi sonrası gücün dengelenmesi için bekle
  delay(500);

  camera_config_t config;
  config.ledc_channel = LEDC_CHANNEL_0;
  config.ledc_timer = LEDC_TIMER_0;
  config.pin_d0 = Y2_GPIO_NUM;
  config.pin_d1 = Y3_GPIO_NUM;
  config.pin_d2 = Y4_GPIO_NUM;
  config.pin_d3 = Y5_GPIO_NUM;
  config.pin_d4 = Y6_GPIO_NUM;
  config.pin_d5 = Y7_GPIO_NUM;
  config.pin_d6 = Y8_GPIO_NUM;
  config.pin_d7 = Y9_GPIO_NUM;
  config.pin_xclk = XCLK_GPIO_NUM;
  config.pin_pclk = PCLK_GPIO_NUM;
  config.pin_vsync = VSYNC_GPIO_NUM;
  config.pin_href = HREF_GPIO_NUM;
  config.pin_sscb_sda = SIOD_GPIO_NUM;
  config.pin_sscb_scl = SIOC_GPIO_NUM;
  config.pin_pwdn = PWDN_GPIO_NUM;
  config.pin_reset = RESET_GPIO_NUM;
  // OV2640 SCCB probe için 20 MHz nominal şart — daha düşükte sensör ID
  // register'ları bozuk okunuyor (init 0x106 NOT_SUPPORTED hatası verir).
  config.xclk_freq_hz = 20000000;
  config.pixel_format = PIXFORMAT_JPEG;
  config.grab_mode    = CAMERA_GRAB_WHEN_EMPTY;   // resmi CameraWebServer örneği bunu kullanır
  config.fb_location  = CAMERA_FB_IN_PSRAM;
  // cam_task stack canary çözümü — varsayılan 2048 byte yetmiyor, 8 KB ver.
  // Yeni library sürümlerinde bu field var; eski sürümde derleme hatası verirse
  // satırı yorum yap.
  config.task_stack_size = 8192;

  // PSRAM diagnostiği — DMA overflow'ın ana sebebi genelde "PSRAM yok"
  bool hasPSRAM = psramFound();
  Serial.printf("PSRAM: %s  (heap=%d, psram=%d)\n",
                hasPSRAM ? "BULUNDU" : "YOK!",
                ESP.getFreeHeap(),
                hasPSRAM ? ESP.getFreePsram() : 0);

  if (hasPSRAM) {
    // cam_task stack canary çözümü: fb_count=1 ile dahili kuyruğu azalt.
    // PSRAM hâlâ JPEG buffer'ı için kullanılır, sadece çift buffer yok.
    config.frame_size   = FRAMESIZE_QVGA;   // 320x240
    config.jpeg_quality = 18;
    config.fb_count     = 1;                // 2 yerine 1 — cam_task stack'i daha rahat
  } else {
    // PSRAM YOK: küçük çözünürlük zorunlu, tek buffer, DRAM
    config.frame_size   = FRAMESIZE_QQVGA;  // 160x120 — DMA overflow'a en güvenli
    config.jpeg_quality = 20;
    config.fb_count     = 1;
    config.fb_location  = CAMERA_FB_IN_DRAM;
  }

  // 2. Kamerayı Başlat
  esp_err_t err = esp_camera_init(&config);
  if (err != ESP_OK) {
    Serial.printf("Kamera baslatilamadi! Hata Kodu: 0x%x\n", err);
    return;
  }

  // Sensör default'larıyla bırak — set_xxx çağrıları bazı board+lib versiyonu
  // kombinasyonlarında cam_task stack overflow yaratıyor.

  // Sunucuyu Çalıştır
  startCameraServer();

  Serial.print("Kamera Yayini Hazir: http://");
  Serial.print(WiFi.localIP());
  Serial.println(":81/stream");
}

void loop() {
  // HTTP sunucusu (stream) arka planda asenkron çalışır, 
  // Loop döngüsü rahat kalsın diye uzun aralıklarla bekletiyoruz.
  delay(10000);
}
