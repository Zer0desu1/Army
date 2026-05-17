import { Component, HostListener, OnInit } from '@angular/core';
import { RobotConfig, RobotInstance, RobotService, RobotType, Team } from './services/robot.service';
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

  // Takım üyesi için status bilgisi (online/offline/connecting)
  getTeamMember(id: string) {
    return this.robotService.robots.find(r => r.config.id === id);
  }
  
  // Robot Builder State
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

  // Modal form data
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

  // AI State
  aiEnabled = false;
  isAiLoading = false;
  aiModel: cocoSsd.ObjectDetection | null = null;
  aiLoopReq: number | null = null;

  camTimestamp = Date.now();

  refreshCamera() {
    this.camTimestamp = Date.now();
  }

  actionButtons = [
    { cmd: 'sit',   icon: '🪑', label: 'Otur' },
    { cmd: 'stand', icon: '🦴', label: 'Kalk' },
    { cmd: 'greet', icon: '🐾', label: 'Selamla' },
  ];

  teams: Team[] = [];
  activeTeam: Team | null = null;
  selectedFleetRobotId: string | null = null;
  
  // Modal for Teams
  showTeamModal = false;
  teamFormData: Team = { id: '', name: 'Yeni Takım', robotIds: [], spacing: 0.5 };

  constructor(public robotService: RobotService) {}

  ngOnInit() {
    this.robotService.robots$.subscribe(r => this.robots = r);
    this.robotService.activeRobot$.subscribe(r => {
      // Only set active robot if we don't have an active team, or if activeTeam is null
      if (!this.activeTeam) {
        this.activeRobot = r;
      }
    });
    this.robotService.teams$.subscribe(t => {
       this.teams = t;
       if (this.activeTeam) {
         this.activeTeam = this.teams.find(tm => tm.id === this.activeTeam!.id) || null;
         if (!this.activeTeam) this.selectRobot(this.robots[0]); // fallback
       }
    });
  }

  selectRobot(robot: RobotInstance) {
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
    // Mesafe-bazlı dinamik adım sayısı: haritadan gelen `steps` varsa onu kullan,
    // yoksa global slider değerine düş.
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
    this.builderStep = 3; // Go straight to network config for edits
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

  // Active Robot Actions
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

  // Heading-hold artık ESP32 tarafında — app sadece walk/back N gönderir,
  // robot kendi step sayısı kadar düz çizgide gider ve durur.
  private dispatchMove(r: any, cmd: string, value: any) {
    if (cmd === 'stop') {
      r.stopDrive?.(false);   // varsa eski app-tarafı döngüyü iptal et
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
      // If a single robot is selected on the local map, target only it; otherwise broadcast.
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
    const moveCmds = ['walk', 'back', 'left', 'right'];
    if (moveCmds.includes(cmd)) {
      r.state = { ...r.state, walking: true, sitting: false };
      
      // Stop the animation after roughly the steps duration
      const msPerStep = 600; 
      const steps = value ? Number(value) : 1;
      setTimeout(() => {
        // Double check if walking wasn't manually stopped in the meantime
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

  // Pusula offset kalibrasyonu — robotun şu anki yönünü "ileri" olarak işaretle
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

    switch (event.key) {
      case 'ArrowUp':    event.preventDefault(); this.sendCommand('walk', this.steps);  break;
      case 'ArrowDown':  event.preventDefault(); this.sendCommand('back', this.steps);  break;
      case 'ArrowLeft':  event.preventDefault(); this.sendCommand('left', this.steps);  break;
      case 'ArrowRight': event.preventDefault(); this.sendCommand('right', this.steps); break;
      case ' ':          event.preventDefault(); this.sendCommand('stop');         break;
      case 's':          this.sendCommand('sit');   break;
      case 'f':          this.sendCommand('stand'); break;
      case 'g':          this.sendCommand('greet'); break;
    }
  }

  // --- AI Vision Methods ---
  aiFps = 0;
  private aiLastTime = 0;
  private aiFrameCount = 0;
  private aiRunning = false;

  async toggleAI() {
    this.aiEnabled = !this.aiEnabled;
    if (this.aiEnabled) {
      this.isAiLoading = true;
      try {
        if (!this.aiModel) {
          // WebGL backend'i kullan (GPU hızlandırma)
          await tf.setBackend('webgl');
          await tf.ready();
          // mobilenet_v2 daha doğru classification yapar
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
          // Düşük güvenli sonuçları filtrele, en fazla 20 nesne döndür
          const predictions = await this.aiModel.detect(img, 20, 0.4);
          ctx.clearRect(0, 0, canvas.width, canvas.height);

          // Ölçek oranları (natural -> client boyutu)
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
            
            // Kutu çiz
            ctx.strokeStyle = color;
            ctx.lineWidth = 2;
            ctx.strokeRect(x, y, w, h);
            
            // Etiket arka planı
            const label = `${p.class} ${score}%`;
            ctx.font = 'bold 13px Inter, sans-serif';
            const textW = ctx.measureText(label).width + 8;
            const textH = 20;
            const textY = y > textH + 4 ? y - textH - 2 : y + 2;
            ctx.fillStyle = color;
            ctx.globalAlpha = 0.85;
            ctx.fillRect(x, textY, textW, textH);
            ctx.globalAlpha = 1;
            
            // Etiket yazısı
            ctx.fillStyle = '#fff';
            ctx.fillText(label, x + 4, textY + 14);
          });

          // FPS Hesapla
          this.aiFrameCount++;
          const now = performance.now();
          if (now - this.aiLastTime >= 1000) {
            this.aiFps = this.aiFrameCount;
            this.aiFrameCount = 0;
            this.aiLastTime = now;
          }
        } catch (e) {
          // Stream hataları sessizce yoksay
        }
      }
    }
    
    // Bir sonraki kareyi 100ms sonra işle (~10 FPS hedef, UI donmaz)
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
