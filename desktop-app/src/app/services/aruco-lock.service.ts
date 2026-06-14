import { Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';

/**
 * Otonom ArUco kilitlenme servisi.
 *
 * Kurtarıcı quad'ın önündeki ESP32-CAM (cam.ino) MJPEG akışını okur,
 * kurtarılacak cyber'ın arkasındaki id=1 ArUco markerını tespit eder,
 * poz/derinlik tahmini yapar ve quad'a `drive {vx,vy,w}` komutları
 * göndererek markera kilitlenir. Kilit mesafesine gelince servo mandalını
 * kapatıp convoy modunu açar.
 *
 * Tespit tamamen tarayıcıda (js-aruco2) çalışır — firmware'e dokunmaz.
 * Quad'ın mevcut `drive`, `servo`, `convoy` komutları kullanılır.
 */

declare const window: any;

export type LockState =
  | 'idle'        // kapalı
  | 'detecting'   // sadece tespit (motorsuz) — overlay/HUD, komut gönderilmez
  | 'searching'   // marker aranıyor (tarama dönüşü)
  | 'approaching' // marker görüldü, yaklaşılıyor/hizalanıyor
  | 'locking'     // toleransta, kilit için stabil kare bekleniyor
  | 'locked';     // kilitlendi (servo + convoy)

export interface LockParams {
  markerId: number;        // hedef marker (1)
  dictionaryName: string;  // js-aruco2 sözlüğü
  markerSizeMm: number;    // basılan markerın kenar uzunluğu (mm)
  focalPx: number;         // kameranın odak uzaklığı (px, akış çözünürlüğünde)

  targetZmm: number;       // hedef kilit mesafesi (mm)
  zTolMm: number;          // derinlik toleransı (mm)
  latTol: number;          // yanal tolerans (normalize, |(-1..1)|)

  kpVy: number;            // derinlik kazancı (ileri/geri)
  kpVx: number;            // yanal kazanç (strafe / dönüş)
  maxV: number;            // sürüş bileşeni limiti (0..1)
  searchW: number;         // marker yokken tarama dönüş hızı

  useStrafe: boolean;      // yanal düzeltme: true=strafe(vx), false=dönüş(w)
  lostFrames: number;      // bu kadar kare görülmezse "kayıp"
  stableFrames: number;    // kilit için toleransta gereken kare
  tickMs: number;          // döngü periyodu

  servoLatch: number;      // kilit servo açısı
}

export interface LockObservation {
  state: LockState;
  found: boolean;
  z?: number;        // tahmini mesafe (mm)
  latNorm?: number;  // yanal ofset (-1..1), 0=ortada
  vx: number;
  vy: number;
  w: number;
  fps: number;
}

export const DEFAULT_LOCK_PARAMS: LockParams = {
  markerId: 1,
  dictionaryName: 'ARUCO_MIP_36h12',
  markerSizeMm: 70,
  focalPx: 280,        // QVGA (320px) OV2640 için kaba tahmin — sahada ayarla

  targetZmm: 250,
  zTolMm: 40,
  latTol: 0.08,

  kpVy: 0.0016,
  kpVx: 1.2,
  maxV: 0.45,
  searchW: 0.4,

  useStrafe: true,
  lostFrames: 8,
  stableFrames: 6,
  tickMs: 80,

  servoLatch: 90,
};

@Injectable({ providedIn: 'root' })
export class ArucoLockService {
  public obs$ = new BehaviorSubject<LockObservation>({
    state: 'idle', found: false, vx: 0, vy: 0, w: 0, fps: 0,
  });

  private running = false;
  private state: LockState = 'idle';
  private detector: any = null;
  private posit: any = null;
  private params: LockParams = DEFAULT_LOCK_PARAMS;

  private work = document.createElement('canvas');
  private workCtx = this.work.getContext('2d', { willReadFrequently: true } as any) as CanvasRenderingContext2D;

  private img: HTMLImageElement | null = null;
  private overlay: HTMLCanvasElement | null = null;
  private send: (obj: any) => boolean = () => false;
  private log: (msg: string, type?: string) => void = () => {};

  private detectOnly = false;
  private missCount = 0;
  private stableCount = 0;
  private frameCount = 0;
  private lastFpsT = 0;
  private fps = 0;
  private timer: any = null;

  private static scriptsLoaded = false;

  /** js-aruco2 vendored dosyalarını sırayla (cv→svd→posit→aruco) yükler. */
  private async ensureScripts(): Promise<void> {
    if (ArucoLockService.scriptsLoaded && window.AR && window.POS) return;
    const base = 'assets/js-aruco2/';
    const files = ['cv.js', 'svd.js', 'posit1.js', 'aruco.js'];
    for (const f of files) {
      await new Promise<void>((resolve, reject) => {
        // zaten yüklüyse atla
        if (document.querySelector(`script[data-aruco="${f}"]`)) return resolve();
        const s = document.createElement('script');
        s.src = base + f;
        s.async = false;
        s.dataset['aruco'] = f;
        s.onload = () => resolve();
        s.onerror = () => reject(new Error(`js-aruco2 yüklenemedi: ${f}`));
        document.head.appendChild(s);
      });
    }
    if (!window.AR || !window.POS || !window.CV) {
      throw new Error('js-aruco2 globalleri yüklenemedi (AR/POS/CV)');
    }
    ArucoLockService.scriptsLoaded = true;
  }

  async start(opts: {
    img: HTMLImageElement;
    overlay: HTMLCanvasElement;
    send: (obj: any) => boolean;
    log?: (msg: string, type?: string) => void;
    params?: Partial<LockParams>;
    detectOnly?: boolean;   // true: sadece tespit — robota komut gönderme
  }): Promise<void> {
    this.params = { ...DEFAULT_LOCK_PARAMS, ...(opts.params || {}) };
    this.img = opts.img;
    this.overlay = opts.overlay;
    this.send = opts.send;
    this.detectOnly = opts.detectOnly ?? false;
    if (opts.log) this.log = opts.log;

    await this.ensureScripts();

    this.detector = new window.AR.Detector({ dictionaryName: this.params.dictionaryName });
    this.posit = new window.POS.Posit(this.params.markerSizeMm, this.params.focalPx);

    this.running = true;
    this.state = this.detectOnly ? 'detecting' : 'searching';
    this.missCount = 0;
    this.stableCount = 0;
    this.frameCount = 0;
    this.lastFpsT = performance.now();
    this.log(this.detectOnly
      ? '🔍 Otomatik tespit başladı (motorsuz)'
      : `🎯 Otonom kilitlenme başladı (marker id=${this.params.markerId})`, 'success');
    this.loop();
  }

  stop(sendStop = true) {
    this.running = false;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.state = 'idle';
    this.clearOverlay();
    if (sendStop && !this.detectOnly) {
      this.send({ cmd: 'drive', vx: 0, vy: 0, w: 0 });
      this.send({ cmd: 'stop' });
    }
    this.emit(false);
    this.log(this.detectOnly ? '🔍 Otomatik tespit durduruldu' : '🎯 Otonom kilitlenme durduruldu', 'info');
  }

  isRunning() { return this.running; }
  getState() { return this.state; }

  updateParams(p: Partial<LockParams>) {
    this.params = { ...this.params, ...p };
    if (this.posit && (p.markerSizeMm !== undefined || p.focalPx !== undefined)) {
      this.posit = new window.POS.Posit(this.params.markerSizeMm, this.params.focalPx);
    }
  }

  private loop() {
    if (!this.running) return;
    let vx = 0, vy = 0, w = 0;
    let found = false;
    let z: number | undefined;
    let latNorm: number | undefined;

    const img = this.img;
    if (img && img.complete && img.naturalWidth > 0) {
      const W = img.naturalWidth, H = img.naturalHeight;
      if (this.work.width !== W) { this.work.width = W; this.work.height = H; }
      const ctx = this.workCtx!;
      ctx.drawImage(img, 0, 0, W, H);
      let imageData: ImageData | null = null;
      try { imageData = ctx.getImageData(0, 0, W, H); } catch { imageData = null; }

      if (imageData) {
        const markers = this.detector.detect(imageData) as Array<{ id: number; corners: { x: number; y: number }[] }>;
        const m = markers.find(mk => mk.id === this.params.markerId);

        if (m) {
          found = true;
          this.missCount = 0;

          // merkez ve yanal ofset
          let cx = 0, cy = 0;
          for (const c of m.corners) { cx += c.x; cy += c.y; }
          cx /= 4; cy /= 4;
          latNorm = (cx - W / 2) / (W / 2);

          // poz/derinlik tahmini (POSIT) — köşeler görüntü merkezine göre
          const centered = m.corners.map(c => ({ x: c.x - W / 2, y: H / 2 - c.y }));
          try {
            const pose = this.posit.pose(centered);
            z = Math.abs(pose.bestTranslation[2]);
          } catch {
            z = undefined;
          }

          if (this.detectOnly) {
            this.state = 'detecting';
          } else {
            ({ vx, vy, w } = this.control(z, latNorm));
          }
          this.drawMarker(m.corners, W, H);
        } else {
          this.missCount++;
          this.clearOverlay();
        }
      }
    }

    // durum makinesi (yalnız sürüş modunda komut gönderilir)
    if (this.detectOnly) {
      if (!found && this.missCount >= this.params.lostFrames) this.state = 'detecting';
    } else if (this.state !== 'locked') {
      if (!found && this.missCount >= this.params.lostFrames) {
        this.state = 'searching';
        this.stableCount = 0;
        vx = 0; vy = 0; w = this.params.searchW;  // tarama dönüşü
      }
      this.send({ cmd: 'drive', vx, vy, w });
    }

    // fps
    this.frameCount++;
    const now = performance.now();
    if (now - this.lastFpsT >= 1000) {
      this.fps = this.frameCount; this.frameCount = 0; this.lastFpsT = now;
    }

    this.obs$.next({ state: this.state, found, z, latNorm, vx, vy, w, fps: this.fps });

    if (this.running) this.timer = setTimeout(() => this.loop(), this.params.tickMs);
  }

  /** Kontrol yasası + kilit geçişi. */
  private control(z: number | undefined, latNorm: number): { vx: number; vy: number; w: number } {
    const p = this.params;
    let vx = 0, vy = 0, w = 0;

    // yanal hizalama
    const latErr = Math.abs(latNorm) < p.latTol ? 0 : latNorm;
    if (p.useStrafe) {
      vx = this.clamp(p.kpVx * latErr, p.maxV);          // marker sağdaysa sağa kay
    } else {
      w = this.clamp(-p.kpVx * latErr, p.maxV);          // marker sağdaysa sağa dön (gerekirse kazancın işaretini çevir)
    }

    // derinlik (ileri/geri)
    let zInTol = false;
    if (z !== undefined) {
      const zErr = z - p.targetZmm;
      zInTol = Math.abs(zErr) < p.zTolMm;
      vy = zInTol ? 0 : this.clamp(p.kpVy * zErr, p.maxV); // çok uzaksa ileri
    }

    const latInTol = Math.abs(latNorm) < p.latTol;
    const aligned = latInTol && zInTol && z !== undefined;

    if (aligned) {
      this.stableCount++;
      this.state = this.stableCount >= p.stableFrames ? 'locking' : 'approaching';
      vx = 0; vy = 0; w = 0;
      if (this.stableCount >= p.stableFrames) this.engageLock();
    } else {
      this.stableCount = 0;
      this.state = 'approaching';
    }

    return { vx, vy, w };
  }

  /** Kilit: dur → servo mandalı → convoy aç. */
  private engageLock() {
    this.state = 'locked';
    this.send({ cmd: 'drive', vx: 0, vy: 0, w: 0 });
    this.send({ cmd: 'servo', value: this.params.servoLatch });
    this.send({ cmd: 'convoy', value: 1 });
    this.log('🔒 Kilitlendi — servo mandalı kapandı, convoy açıldı', 'success');
    this.emit(true);
  }

  private clamp(v: number, lim: number) {
    if (v > lim) return lim;
    if (v < -lim) return -lim;
    return v;
  }

  private emit(found: boolean) {
    this.obs$.next({ ...this.obs$.value, state: this.state, found });
  }

  // ── overlay çizimi ───────────────────────────────────────────
  private drawMarker(corners: { x: number; y: number }[], srcW: number, srcH: number) {
    const cv = this.overlay, img = this.img;
    if (!cv || !img) return;
    const dw = img.clientWidth, dh = img.clientHeight;
    if (cv.width !== dw || cv.height !== dh) { cv.width = dw; cv.height = dh; }
    const ctx = cv.getContext('2d'); if (!ctx) return;
    const sx = dw / srcW, sy = dh / srcH;

    ctx.clearRect(0, 0, dw, dh);

    // hedef merkez çizgisi
    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(dw / 2, 0); ctx.lineTo(dw / 2, dh); ctx.stroke();

    // marker köşeleri
    ctx.strokeStyle = this.state === 'locked' ? '#10b981' : '#f59e0b';
    ctx.lineWidth = 3;
    ctx.beginPath();
    corners.forEach((c, i) => {
      const x = c.x * sx, y = c.y * sy;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.closePath(); ctx.stroke();

    // merkez nokta
    let cx = 0, cy = 0; for (const c of corners) { cx += c.x; cy += c.y; }
    cx = (cx / 4) * sx; cy = (cy / 4) * sy;
    ctx.fillStyle = ctx.strokeStyle;
    ctx.beginPath(); ctx.arc(cx, cy, 4, 0, Math.PI * 2); ctx.fill();
  }

  private clearOverlay() {
    const cv = this.overlay; if (!cv) return;
    const ctx = cv.getContext('2d'); if (ctx) ctx.clearRect(0, 0, cv.width, cv.height);
  }
}
