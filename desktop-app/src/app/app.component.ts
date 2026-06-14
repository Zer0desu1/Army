import { Component, HostListener, OnInit } from '@angular/core';
import { RobotConfig, RobotInstance, RobotService, RobotType, Team } from './services/robot.service';
import { ArucoLockService, LockObservation, LockParams, DEFAULT_LOCK_PARAMS } from './services/aruco-lock.service';
import * as tf from '@tensorflow/tfjs';
import * as cocoSsd from '@tensorflow-models/coco-ssd';

@Component({
  selector: 'app-root',
  templateUrl: './app.component.html'
})
export class AppComponent implements OnInit {
  robots: RobotInstance[] = [];
  activeRobot: RobotInstance | null = null;

  showAddModal = false;
  editingRobotId: string | null = null;
  syncMode = false;
  sidebarCategory: 'robots' | 'teams' = 'robots';
  teamSidebarCollapsed = false;

  toggleTeamSidebar() {
    this.teamSidebarCollapsed = !this.teamSidebarCollapsed;
  }

  getTeamMember(id: string) {
    return this.robotService.robots.find(r => r.config.id === id);
  }

  builderStep = 1;
  availableModules = [
    { id: 'camera', name: 'ESP32-CAM', icon: '📷', desc: 'Video akışı ve yapay zeka' },
    { id: 'ultrasonic', name: 'Mesafe Sensörü (HC-SR04)', icon: '📏', desc: 'Çarpışma önleme' },
    { id: 'temperature', name: 'Sıcaklık (DHT11)', icon: '🌡️', desc: 'Ortam sıcaklığı' },
    { id: 'lidar', name: 'Mini LIDAR', icon: '📡', desc: 'Haritalama' },
    { id: 'tof', name: 'ToF Lazer (VL53L0X)', icon: '🔦', desc: 'Hassas mesafe (I²C)' },
    { id: 'imu', name: 'IMU (MPU6050)', icon: '🎯', desc: 'İvme + jiro, düz gitme telafisi' },
    { id: 'compass', name: 'Pusula (QMC5883L)', icon: '🧭', desc: 'Yön kilidi, manyetik kuzey' }
  ];

  formData: RobotConfig = {
    id: '',
    name: 'Yeni Robot',
    type: 'dog',
    ip: '192.168.1.',
    hasCamera: false,
    camIp: '',
    modules: []
  };

  steps = 5;

  aiEnabled = false;
  isAiLoading = false;
  aiModel: cocoSsd.ObjectDetection | null = null;
  aiLoopReq: number | null = null;

  camTimestamp = Date.now();

  refreshCamera() {
    this.camTimestamp = Date.now();
  }

  // ── Otonom ArUco kilitlenme ──────────────────────────────────
  lockEnabled = false;
  lockDetecting = false;   // motorsuz otomatik tespit aktif mi
  lockObs: LockObservation | null = null;
  lockShowParams = false;
  lockParams: LockParams = { ...DEFAULT_LOCK_PARAMS };
  private readonly lockStateLabels: Record<string, string> = {
    idle: 'Kapalı',
    detecting: 'Tespit…',
    searching: 'Aranıyor…',
    approaching: 'Yaklaşıyor',
    locking: 'Hizalanıyor',
    locked: 'KİLİTLENDİ',
  };

  get lockStateLabel(): string {
    return this.lockObs ? (this.lockStateLabels[this.lockObs.state] ?? this.lockObs.state) : 'Kapalı';
  }

  async toggleLock() {
    if (this.lockEnabled) {
      this.arucoLock.stop();
      this.lockEnabled = false;
      this.startAutoDetect();   // tam kilit kapandı → motorsuz tespite geri dön
      return;
    }

    const robot = this.activeRobot;
    if (!robot || robot.status !== 'online') {
      robot?.addLog('⚠ Kilitlenme için robot bağlı olmalı', 'error');
      return;
    }
    if (!robot.config.camIp) {
      robot.addLog('⚠ Kamera IP girilmemiş — kilitlenme için akış gerekli', 'error');
      return;
    }

    const img = document.getElementById('active-cam-feed') as HTMLImageElement;
    const overlay = document.getElementById('active-ai-canvas') as HTMLCanvasElement;
    if (!img || !overlay) return;

    // YZ ve motorsuz tespit aynı canvas'ı/servisi paylaşır — tam kilitten önce durdur
    if (this.aiEnabled) { this.aiRunning = false; this.aiEnabled = false; this.clearCanvas(); }
    this.stopAutoDetect();

    try {
      await this.arucoLock.start({
        img,
        overlay,
        send: (obj) => robot.sendRaw(obj),
        log: (msg, type) => robot.addLog(msg, (type as any) ?? 'info'),
        params: this.lockParams,
      });
      this.lockEnabled = true;
    } catch (err: any) {
      robot.addLog(`⚠ Kilitlenme başlatılamadı: ${err?.message ?? err}`, 'error');
      this.lockEnabled = false;
    }
  }

  /** Kamera verisi gelince motorsuz otomatik tespit (sadece overlay/HUD; robota komut gitmez). */
  async startAutoDetect() {
    const robot = this.activeRobot;
    if (!robot || robot.config.type !== 'omni4' || !robot.config.camIp) return;
    if (this.aiEnabled || this.lockEnabled) return;            // AI ya da tam kilit açıkken çalışma
    if (this.lockDetecting || this.arucoLock.isRunning()) return;

    const img = document.getElementById('active-cam-feed') as HTMLImageElement;
    const overlay = document.getElementById('active-ai-canvas') as HTMLCanvasElement;
    if (!img || !overlay) return;

    try {
      await this.arucoLock.start({
        img,
        overlay,
        send: () => false,        // motorsuz: hiçbir komut gönderme
        log: (msg, type) => robot.addLog(msg, (type as any) ?? 'info'),
        params: this.lockParams,
        detectOnly: true,
      });
      this.lockDetecting = true;
    } catch (err: any) {
      robot.addLog(`⚠ Otomatik tespit başlatılamadı: ${err?.message ?? err}`, 'error');
    }
  }

  stopAutoDetect() {
    if (!this.lockDetecting) return;
    this.arucoLock.stop(false);   // motorsuz — komut göndermeden durdur
    this.lockDetecting = false;
  }

  /** Kamera <img> bir kare yükleyince ("kamera verisi var") tespiti otomatik başlatır. */
  onCamFeedLoad() {
    this.startAutoDetect();
  }

  applyLockParams() {
    this.arucoLock.updateParams(this.lockParams);
  }

  actionButtons = [
    { cmd: 'sit',   icon: '🪑', label: 'Otur' },
    { cmd: 'stand', icon: '🦴', label: 'Kalk' },
    { cmd: 'greet', icon: '🐾', label: 'Selamla' },
  ];

  teams: Team[] = [];
  activeTeam: Team | null = null;
  selectedFleetRobotId: string | null = null;

  showTeamModal = false;
  teamFormData: Team = { id: '', name: 'Yeni Takım', robotIds: [], spacing: 0.5 };

  constructor(public robotService: RobotService, private arucoLock: ArucoLockService) {}

  ngOnInit() {
    this.arucoLock.obs$.subscribe(o => this.lockObs = o);
    this.robotService.robots$.subscribe(r => this.robots = r);
    this.robotService.activeRobot$.subscribe(r => {

      if (!this.activeTeam) {
        this.activeRobot = r;
      }
    });
    this.robotService.teams$.subscribe(t => {
       this.teams = t;
       if (this.activeTeam) {
         this.activeTeam = this.teams.find(tm => tm.id === this.activeTeam!.id) || null;
         if (!this.activeTeam) this.selectRobot(this.robots[0]);
       }
    });
  }

  selectRobot(robot: RobotInstance) {
    if (this.lockEnabled) { this.arucoLock.stop(); this.lockEnabled = false; }
    this.stopAutoDetect();   // yeni robotun akışı yüklenince (load) tekrar başlatır
    this.activeTeam = null;
    this.robotService.setActiveRobot(robot.config.id);
  }

  get teamRobots() {
    if (!this.activeTeam) return null;
    return this.activeTeam.robotIds
      .map(id => this.robots.find(r => r.config.id === id))
      .filter(r => !!r)
      .map(r => ({ type: r!.config.type, state: r!.state, id: r!.config.id, name: r!.config.name }));
  }

  selectTeam(team: Team) {
    this.activeTeam = team;
    this.activeRobot = null;
    this.selectedFleetRobotId = team.robotIds[0] || null;
  }

  onSelectFleetRobot(id: string) {
    this.selectedFleetRobotId = id;
  }

  onFleetRobotMove(event: {id: string, cmd: string, steps?: number}) {
    const r = this.robotService.robots.find(robot => robot.config.id === event.id);
    if (!r) return;

    const stepsToUse = event.steps !== undefined ? event.steps : this.steps;
    this.optimisticStateUpdate(r, event.cmd, stepsToUse);
    if (r.status === 'online') r.send(event.cmd, stepsToUse);
  }

  clearFleetSelection() {
    this.selectedFleetRobotId = null;
  }

  openTeamModal() {
    this.teamFormData = { id: Date.now().toString(), name: 'Yeni Takım', robotIds: [], spacing: 0.8 };
    this.showTeamModal = true;
  }

  saveTeam() {
    this.robotService.addTeam(this.teamFormData);
    this.showTeamModal = false;
    this.selectTeam(this.teamFormData);
  }

  deleteTeam(id: string) {
    if(confirm('Takımı silmek istediğinize emin misiniz?')) {
      this.robotService.removeTeam(id);
    }
  }

  toggleTeamRobot(robotId: string) {
    const idx = this.teamFormData.robotIds.indexOf(robotId);
    if (idx > -1) this.teamFormData.robotIds.splice(idx, 1);
    else this.teamFormData.robotIds.push(robotId);
  }

  getRobotName(id: string): string {
    const r = this.robots.find(r => r.config.id === id);
    return r ? r.config.name : 'Bilinmeyen Robot';
  }

  getTypeIcon(type: RobotType): string {
    switch(type) {
      case 'dog': return '🐕';
      case 'tank': return '🚜';
      case 'omni3': return '🛸';
      case 'omni4': return '🚙';
      default: return '🤖';
    }
  }

  getTypeLabel(type: RobotType): string {
    switch(type) {
      case 'dog': return 'Robot Köpek';
      case 'tank': return 'Mini Tank (Paletli)';
      case 'omni3': return '3-Teker Omni Mobil';
      case 'omni4': return '4-Teker Omni Mobil';
      default: return 'Robot';
    }
  }

  isScanning = false;
  foundIPs: string[] = [];

  async scanNetwork() {
    if ((window as any).electronAPI?.scanNetwork) {
      this.isScanning = true;
      this.foundIPs = [];
      try {
        const ips = await (window as any).electronAPI.scanNetwork();
        this.foundIPs = ips;
      } catch (err) {
        console.error('Tarama hatası:', err);
      }
      this.isScanning = false;
    } else {
      alert('Otomatik tarama sadece masaüstü uygulamasında kullanılabilir.');
    }
  }

  useScannedIp(ip: string, target: 'ip' | 'camIp') {
    if (target === 'ip') this.formData.ip = ip;
    else this.formData.camIp = ip;
  }

  openAddModal() {
    this.editingRobotId = null;
    this.builderStep = 1;
    this.formData = {
      id: Date.now().toString(),
      name: 'Yeni Robot',
      type: 'dog',
      ip: '192.168.1.',
      hasCamera: false,
      camIp: '',
      modules: []
    };
    this.showAddModal = true;
  }

  openEditModal(robot: RobotInstance) {
    this.editingRobotId = robot.config.id;
    this.builderStep = 3;
    this.formData = { ...robot.config, modules: robot.config.modules || [] };
    this.showAddModal = true;
  }

  toggleModule(modId: string) {
    if (!this.formData.modules) this.formData.modules = [];
    const idx = this.formData.modules.indexOf(modId);
    if (idx > -1) {
      this.formData.modules.splice(idx, 1);
    } else {
      this.formData.modules.push(modId);
    }
    this.formData.hasCamera = this.formData.modules.includes('camera');
  }

  nextStep() {
    if (this.builderStep < 3) this.builderStep++;
  }

  prevStep() {
    if (this.builderStep > 1) this.builderStep--;
  }

  saveRobot() {
    if (!this.formData.modules) this.formData.modules = [];
    this.formData.hasCamera = this.formData.modules.includes('camera');

    if (this.editingRobotId) {
      this.robotService.updateRobotConfig(this.editingRobotId, this.formData);
    } else {
      this.robotService.addRobot(this.formData);
    }
    this.showAddModal = false;
  }

  deleteRobot(id: string) {
    if(confirm('Bu robotu silmek istediğinize emin misiniz?')) {
      this.robotService.removeRobot(id);
      this.showAddModal = false;
    }
  }

  connectActive() {
    if (this.syncMode) {
      this.robotService.robots.forEach(r => r.connect());
    } else if (this.activeRobot) {
      this.activeRobot.connect();
    }
  }

  disconnectActive() {
    if (this.syncMode) {
      this.robotService.robots.forEach(r => r.disconnect());
    } else if (this.activeRobot) {
      this.activeRobot.disconnect();
    }
  }

  provisionActiveWifi(creds: { ssid: string; pass: string }) {
    if (!this.activeRobot) return;
    this.activeRobot.sendWifi(creds.ssid, creds.pass);
  }

  resetActiveWifi() {
    if (!this.activeRobot) return;
    if (confirm('Robotun WiFi ayarlarını silip AP moduna dönmesini istiyor musunuz?')) {
      this.activeRobot.sendWifiReset();
    }
  }

  private dispatchMove(r: any, cmd: string, value: any) {
    if (cmd === 'stop') {
      r.stopDrive?.(false);
    }
    r.send(cmd, value);
  }

  sendCommand(cmd: string, value: any = null) {
    if (this.syncMode) {
      this.robotService.robots.forEach(r => {
        if (r.status === 'online') {
          this.optimisticStateUpdate(r, cmd, value);
          this.dispatchMove(r, cmd, value);
        }
      });
    } else if (this.activeTeam) {

      const targetIds = this.selectedFleetRobotId
        ? [this.selectedFleetRobotId]
        : this.activeTeam.robotIds;
      targetIds.forEach(id => {
        const r = this.robotService.robots.find(robot => robot.config.id === id);
        if (r && r.status === 'online') {
          this.optimisticStateUpdate(r, cmd, value);
          this.dispatchMove(r, cmd, value);
        } else if (r) {
          this.optimisticStateUpdate(r, cmd, value);
        }
      });
    } else {
      if (this.activeRobot) {
        this.optimisticStateUpdate(this.activeRobot, cmd, value);
        if (this.activeRobot.status === 'online') {
          this.dispatchMove(this.activeRobot, cmd, value);
        }
      }
    }
  }

  private optimisticStateUpdate(r: any, cmd: string, value: any) {
    const moveCmds = ['walk', 'back', 'left', 'right', 'strafeLeft', 'strafeRight'];
    if (moveCmds.includes(cmd)) {
      r.state = { ...r.state, walking: true, sitting: false };

      const msPerStep = 600;
      const steps = value ? Number(value) : 1;
      setTimeout(() => {

        if (r.state.walking) {
           r.state = { ...r.state, walking: false };
        }
      }, steps * msPerStep);

    } else if (cmd === 'stop') {
      r.state = { ...r.state, walking: false, avoidActive: false, stabilizeActive: false };
    } else if (cmd === 'sit') {
      r.state = { ...r.state, sitting: true, walking: false };
    } else if (cmd === 'stand') {
      r.state = { ...r.state, sitting: false };
    } else if (cmd === 'emotion') {
      r.state = { ...r.state, emotionName: value };
    }
  }

  setSpeedActive(val: number) {
    this.sendCommand('speed', val);
  }

  sendPidActive(values: { kp?: number; ki?: number }) {
    if (this.syncMode) {
      this.robotService.robots.forEach(r => {
        if (r.status === 'online') r.sendPid(values);
      });
    } else if (this.activeRobot && this.activeRobot.status === 'online') {
      this.activeRobot.sendPid(values);
    }
  }

  sendTrimActive(rev: number) {
    if (this.syncMode) {
      this.robotService.robots.forEach(r => {
        if (r.status === 'online') r.sendTrim(rev);
      });
    } else if (this.activeRobot && this.activeRobot.status === 'online') {
      this.activeRobot.sendTrim(rev);
    }
  }

  zeroHeading() {
    if (this.activeRobot && this.activeRobot.zeroHeading()) {
      this.robotService.updateRobotConfig(this.activeRobot.config.id, this.activeRobot.config);
    }
  }

  setSpeedEvent(event: Event) {
    const val = Number((event.target as HTMLInputElement).value);
    if (this.syncMode) {
      this.robotService.robots.forEach(r => {
        if (r.status === 'online') r.state.speed = val;
      });
    } else if (this.activeRobot) {
      this.activeRobot.state.speed = val;
    }
  }

  setSteps(event: Event) {
    const val = (event.target as HTMLInputElement).value;
    this.steps = Number(val);
  }

  @HostListener('window:keydown', ['$event'])
  handleKeyboardEvent(event: KeyboardEvent) {
    if (!this.activeRobot || this.activeRobot.status !== 'online') return;
    if ((event.target as HTMLElement).tagName === 'INPUT' || (event.target as HTMLElement).tagName === 'SELECT') return;

    const omni4 = this.activeRobot.config.type === 'omni4';
    switch (event.key) {
      case 'ArrowUp':    event.preventDefault(); this.sendCommand('walk', this.steps);  break;
      case 'ArrowDown':  event.preventDefault(); this.sendCommand('back', this.steps);  break;
      case 'ArrowLeft':  event.preventDefault(); this.sendCommand(omni4 ? 'strafeLeft'  : 'left',  this.steps); break;
      case 'ArrowRight': event.preventDefault(); this.sendCommand(omni4 ? 'strafeRight' : 'right', this.steps); break;
      case 'q': case 'Q': if (omni4) this.sendCommand('left',  this.steps); break;
      case 'e': case 'E': if (omni4) this.sendCommand('right', this.steps); break;
      case ' ':          event.preventDefault(); this.sendCommand('stop');         break;
      case 's':          this.sendCommand('sit');   break;
      case 'f':          this.sendCommand('stand'); break;
      case 'g':          this.sendCommand('greet'); break;
    }
  }

  aiFps = 0;
  private aiLastTime = 0;
  private aiFrameCount = 0;
  private aiRunning = false;

  async toggleAI() {
    // YZ, tam kilit ve motorsuz tespit aynı canvas'ı paylaşır — YZ açılırken hepsini durdur
    if (!this.aiEnabled) {
      if (this.lockEnabled) { this.arucoLock.stop(); this.lockEnabled = false; }
      this.stopAutoDetect();
    }
    this.aiEnabled = !this.aiEnabled;
    if (this.aiEnabled) {
      this.isAiLoading = true;
      try {
        if (!this.aiModel) {

          await tf.setBackend('webgl');
          await tf.ready();

          this.aiModel = await cocoSsd.load({ base: 'mobilenet_v2' });
        }
        this.isAiLoading = false;
        this.aiRunning = true;
        this.runAiLoop();
      } catch (err) {
        console.error('Yapay Zeka Yüklenemedi:', err);
        this.aiEnabled = false;
        this.isAiLoading = false;
      }
    } else {
      this.aiRunning = false;
      this.clearCanvas();
      this.aiFps = 0;
      this.startAutoDetect();   // YZ kapandı → motorsuz tespite geri dön
    }
  }

  async runAiLoop() {
    if (!this.aiRunning || !this.aiModel) return;

    const img = document.getElementById('active-cam-feed') as HTMLImageElement;
    const canvas = document.getElementById('active-ai-canvas') as HTMLCanvasElement;

    if (img && canvas && img.complete && img.naturalHeight !== 0) {
      if (canvas.width !== img.clientWidth || canvas.height !== img.clientHeight) {
        canvas.width = img.clientWidth;
        canvas.height = img.clientHeight;
      }

      const ctx = canvas.getContext('2d');
      if (ctx) {
        try {

          const predictions = await this.aiModel.detect(img, 20, 0.4);
          ctx.clearRect(0, 0, canvas.width, canvas.height);

          const scaleX = canvas.width / img.naturalWidth;
          const scaleY = canvas.height / img.naturalHeight;

          predictions.forEach(p => {
            const x = p.bbox[0] * scaleX;
            const y = p.bbox[1] * scaleY;
            const w = p.bbox[2] * scaleX;
            const h = p.bbox[3] * scaleY;
            const isPerson = p.class === 'person';
            const color = isPerson ? '#10b981' : '#a855f7';
            const score = Math.round(p.score * 100);

            ctx.strokeStyle = color;
            ctx.lineWidth = 2;
            ctx.strokeRect(x, y, w, h);

            const label = `${p.class} ${score}%`;
            ctx.font = 'bold 13px Inter, sans-serif';
            const textW = ctx.measureText(label).width + 8;
            const textH = 20;
            const textY = y > textH + 4 ? y - textH - 2 : y + 2;
            ctx.fillStyle = color;
            ctx.globalAlpha = 0.85;
            ctx.fillRect(x, textY, textW, textH);
            ctx.globalAlpha = 1;

            ctx.fillStyle = '#fff';
            ctx.fillText(label, x + 4, textY + 14);
          });

          this.aiFrameCount++;
          const now = performance.now();
          if (now - this.aiLastTime >= 1000) {
            this.aiFps = this.aiFrameCount;
            this.aiFrameCount = 0;
            this.aiLastTime = now;
          }
        } catch (e) {

        }
      }
    }

    if (this.aiRunning) {
      setTimeout(() => this.runAiLoop(), 100);
    }
  }

  clearCanvas() {
    const canvas = document.getElementById('active-ai-canvas') as HTMLCanvasElement;
    if (canvas) {
      const ctx = canvas.getContext('2d');
      if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
  }
}
