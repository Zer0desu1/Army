import { Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';

export type RobotType = 'dog' | 'tank' | 'omni3' | 'omni4';

export interface RobotConfig {
  id: string;
  name: string;
  type: RobotType;
  ip: string;
  hasCamera: boolean;
  camIp?: string;
  modules: string[];
  headingOffset?: number;
}

export interface Team {
  id: string;
  name: string;
  robotIds: string[];
  spacing: number;
}

export interface RobotState {
  status: 'offline' | 'connecting' | 'online';
  speed: number;
  walking: boolean;
  sitting: boolean;
  emotionName?: string;

  temperature?: number;
  distance?: number;
  heading?: number;
  ax?: number; ay?: number; az?: number;
  gx?: number; gy?: number; gz?: number;
  avoidActive?: boolean;
  stabilizeActive?: boolean;
  stabilizeTarget?: number;

  pidKp?: number;
  pidKi?: number;

  revBoost?: number;
}

export interface LogEntry {
  msg: string;
  type: 'info' | 'success' | 'warn' | 'error' | 'send' | 'recv';
  ts: string;
}

export class RobotInstance {
  config: RobotConfig;
  status: 'offline' | 'connecting' | 'online' = 'offline';
  state: RobotState = { status: 'offline', emotionName: 'neutral', speed: 80, sitting: false, walking: false };
  logs: LogEntry[] = [];
  ws: WebSocket | null = null;
  private readonly WS_PORT = 81;

  constructor(config: RobotConfig, private triggerUpdate: () => void) {
    this.config = config;
  }

  addLog(msg: string, type: LogEntry['type'] = 'info') {
    const ts = new Date().toLocaleTimeString('tr-TR', { hour12: false });
    this.logs.unshift({ msg, type, ts });
    if (this.logs.length > 100) this.logs.pop();
    this.triggerUpdate();
  }

  clearLogs() {
    this.logs = [];
    this.triggerUpdate();
  }

  connect() {
    if (!this.config.ip || this.config.ip.trim() === '') return;
    if (this.ws) this.ws.close();

    this.status = 'connecting';
    this.addLog(`Bağlanıyor → ws://${this.config.ip.trim()}:${this.WS_PORT}`, 'info');
    this.triggerUpdate();

    try {
      this.ws = new WebSocket(`ws://${this.config.ip.trim()}:${this.WS_PORT}`);
      this.ws.onopen = () => {
        this.status = 'online';
        this.addLog(`✓ Bağlantı kuruldu`, 'success');
        this.triggerUpdate();
      };
      this.ws.onclose = () => {
        this.status = 'offline';
        this.addLog('Bağlantı kesildi', 'warn');
        this.triggerUpdate();
      };
      this.ws.onerror = () => {
        this.status = 'offline';
        this.addLog('Bağlantı hatası — IP veya port doğru mu?', 'error');
        this.triggerUpdate();
      };
      this.ws.onmessage = (e) => {
        try {
          const data = JSON.parse(e.data);

          if (data.state) {
            this.state = { ...this.state, ...data.state };
          }
          if (data.temperature !== undefined) this.state.temperature = data.temperature;
          if (data.temp !== undefined)        this.state.temperature = data.temp;

          if (data.distance !== undefined) {
            this.state.distance = data.distance > 1000 ? Math.round(data.distance / 10) : data.distance;
          }
          if (data.heading !== undefined) this.state.heading = data.heading;
          if (data.acc) {
            this.state.ax = data.acc.x; this.state.ay = data.acc.y; this.state.az = data.acc.z;
          }
          if (data.gyro) {
            this.state.gx = data.gyro.x; this.state.gy = data.gyro.y; this.state.gz = data.gyro.z;
          }
          if (data.speed !== undefined)  this.state.speed  = data.speed;
          if (data.moving !== undefined) this.state.walking = data.moving;

          if (data.type === 'avoid' && data.active !== undefined) {
            this.state.avoidActive = !!data.active;
            this.addLog(data.active ? '🚧 Engelden kaçış AÇIK' : '🚧 Engelden kaçış KAPALI',
                        data.active ? 'success' : 'info');
          }

          if (data.type === 'pid') {
            if (data.kp !== undefined) this.state.pidKp = data.kp;
            if (data.ki !== undefined) this.state.pidKi = data.ki;
            this.addLog(`⚙️ PID: Kp=${this.state.pidKp} Ki=${this.state.pidKi}`, 'recv');
          }

          if (data.type === 'trim') {
            if (data.rev !== undefined) this.state.revBoost = data.rev;
            this.addLog(`⚙️ Trim: rev=${this.state.revBoost}`, 'recv');
          }

          if (data.type === 'stabilize' && data.active !== undefined) {
            this.state.stabilizeActive = !!data.active;
            if (data.target !== undefined) this.state.stabilizeTarget = data.target;
            this.addLog(data.active
              ? `🧭 Stabilize AÇIK — hedef ${Math.round(data.target ?? 0)}°`
              : '🧭 Stabilize KAPALI',
              data.active ? 'success' : 'info');
          }
        } catch {
          this.addLog(`← ham: ${e.data}`, 'recv');
        }
        this.triggerUpdate();
      };
    } catch(err: any) {
      this.status = 'offline';
      this.addLog(`Hata: ${err.message}`, 'error');
      this.triggerUpdate();
    }
  }

  disconnect() {
    this.ws?.close();
    this.status = 'offline';
    this.triggerUpdate();
  }

  send(cmd: string, value: any = null): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.addLog('⚠ Bağlı değil! Önce bağlantı kur.', 'error');
      return false;
    }
    const payload = value !== null ? { cmd, value } : { cmd };
    this.ws.send(JSON.stringify(payload));
    this.addLog(`→ ${cmd}${value !== null ? ` [${value}]` : ''}`, 'send');
    return true;
  }

  sendRaw(obj: any): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(obj));
    return true;
  }

  sendWifi(ssid: string, pass: string): boolean {
    if (!ssid || !ssid.trim()) {
      this.addLog('⚠ SSID boş olamaz', 'error');
      return false;
    }
    const ok = this.sendRaw({ cmd: 'wifi', ssid: ssid.trim(), pass: pass ?? '' });
    if (ok) {
      this.addLog(`📶 WiFi bilgisi gönderildi → ${ssid.trim()} (robot yeniden başlatılıyor)`, 'send');
    } else {
      this.addLog('⚠ Bağlı değil — önce AP\'ye bağlanıp robotu connect et', 'error');
    }
    return ok;
  }

  sendPid(values: { kp?: number; ki?: number }): boolean {
    const payload: any = { cmd: 'pid' };
    if (values.kp !== undefined) payload.kp = values.kp;
    if (values.ki !== undefined) payload.ki = values.ki;
    const ok = this.sendRaw(payload);
    if (ok) {
      const parts: string[] = [];
      if (values.kp !== undefined) parts.push(`Kp=${values.kp}`);
      if (values.ki !== undefined) parts.push(`Ki=${values.ki}`);
      this.addLog(`⚙️ PID gönder → ${parts.join(' ')}`, 'send');
    } else {
      this.addLog('⚠ Bağlı değil — PID gönderilemedi', 'error');
    }
    return ok;
  }

  sendTrim(rev: number): boolean {
    const ok = this.sendRaw({ cmd: 'trim', rev });
    if (ok) this.addLog(`⚙️ Trim gönder → rev=${rev}`, 'send');
    else    this.addLog('⚠ Bağlı değil — trim gönderilemedi', 'error');
    return ok;
  }

  sendWifiReset(): boolean {
    const ok = this.sendRaw({ cmd: 'wifiReset' });
    if (ok) this.addLog('🔄 WiFi sıfırlama gönderildi — robot AP moduna dönecek', 'send');
    return ok;
  }

  zeroHeading(): boolean {
    if (this.state.heading === undefined) {
      this.addLog('⚠ Pusula verisi yok — robot bağlı mı?', 'error');
      return false;
    }
    this.config.headingOffset = this.state.heading;
    this.addLog(`🧭 Yön sıfırlandı: ham ${Math.round(this.state.heading)}° → ileri = 0°`, 'success');
    return true;
  }

  effectiveHeading(): number | undefined {
    if (this.state.heading === undefined) return undefined;
    const offset = this.config.headingOffset ?? 0;
    let h = this.state.heading - offset;
    while (h > 180)  h -= 360;
    while (h < -180) h += 360;
    return h;
  }

  private driveLoopId: any = null;
  private driveStopTimer: any = null;
  private setpointHeading: number | null = null;
  private gyroIntegral = 0;
  private lastDriveT = 0;

  driveStraight(direction: 'forward' | 'back', steps: number, msPerStep = 250) {

    this.stopDrive(false);

    const hasCompass = this.config.modules?.includes('compass');
    const hasImu     = this.config.modules?.includes('imu');
    if (!hasCompass && !hasImu) {
      this.send(direction === 'forward' ? 'walk' : 'back', steps);
      return;
    }

    this.setpointHeading = 0;
    this.gyroIntegral    = 0;
    this.lastDriveT      = performance.now();

    const dir   = direction === 'forward' ? 1.0 : -1.0;
    const Kp        = 0.018;
    const Kp_align  = 0.030;
    const Kp_gyro   = 0.6;
    const DEADZONE_DEG = 5;

    type Phase = 'aligning' | 'driving';
    let phase: Phase = 'aligning';
    let stableTicks = 0;
    const STABLE_REQUIRED = 4;

    this.addLog(`🎯 Hizalama başladı → hedef 0° (±${DEADZONE_DEG}°)`, 'info');

    this.driveLoopId = setInterval(() => {
      let err = 0;

      if (hasCompass && this.state.heading !== undefined) {

        const eff = this.effectiveHeading();
        err = eff !== undefined ? eff : 0;
      } else if (hasImu) {
        const now = performance.now();
        const dt  = (now - this.lastDriveT) / 1000;
        this.lastDriveT = now;
        this.gyroIntegral += (this.state.gz ?? 0) * dt * (180 / Math.PI);
        err = this.gyroIntegral;
      }

      const inDeadzone = Math.abs(err) < DEADZONE_DEG;

      if (phase === 'aligning') {
        if (inDeadzone) {
          stableTicks++;
          if (stableTicks >= STABLE_REQUIRED) {
            phase = 'driving';
            this.addLog(`✅ Hizalandı (${Math.round(err)}°) → ${direction === 'forward' ? 'ileri' : 'geri'} sürüş`, 'success');
          }
        } else {
          stableTicks = 0;
        }

        const Kused = hasCompass ? Kp_align : Kp_gyro;
        let w = inDeadzone ? 0 : -Kused * err;
        if (w > 1)  w = 1;
        if (w < -1) w = -1;
        this.sendRaw({ cmd: 'drive', vx: 0, vy: 0, w });
        return;
      }

      let errCorr = inDeadzone ? 0 : err;
      const Kused = hasCompass ? Kp : Kp_gyro;
      let w = -Kused * errCorr;
      if (w > 1)  w = 1;
      if (w < -1) w = -1;

      this.sendRaw({ cmd: 'drive', vx: 0, vy: dir, w });
    }, 50);

    if (steps && steps > 0) {
      const totalMs = Math.max(200, steps * msPerStep);
      this.driveStopTimer = setTimeout(() => this.stopDrive(true), totalMs);
    }
  }

  stopDrive(sendStop: boolean) {
    if (this.driveLoopId)    { clearInterval(this.driveLoopId);   this.driveLoopId = null; }
    if (this.driveStopTimer) { clearTimeout(this.driveStopTimer); this.driveStopTimer = null; }
    this.setpointHeading = null;
    if (sendStop) {
      this.sendRaw({ cmd: 'drive', vx: 0, vy: 0, w: 0 });
      this.send('stop');
    }
  }
}

@Injectable({
  providedIn: 'root'
})
export class RobotService {
  robots: RobotInstance[] = [];
  robots$ = new BehaviorSubject<RobotInstance[]>([]);

  teams: Team[] = [];
  teams$ = new BehaviorSubject<Team[]>([]);

  activeRobotId: string | null = null;
  activeRobot$ = new BehaviorSubject<RobotInstance | null>(null);

  constructor() {
    this.loadRobots();
    this.loadTeams();
  }

  private updateState() {
    this.robots$.next([...this.robots]);
    const active = this.robots.find(r => r.config.id === this.activeRobotId) || null;
    this.activeRobot$.next(active);
  }

  addRobot(config: RobotConfig) {
    const robot = new RobotInstance(config, () => this.updateState());
    this.robots.push(robot);
    this.saveRobots();
    this.setActiveRobot(robot.config.id);
  }

  updateRobotConfig(id: string, config: RobotConfig) {
    const robot = this.robots.find(r => r.config.id === id);
    if (robot) {
      robot.config = config;
      this.saveRobots();
      this.updateState();
    }
  }

  removeRobot(id: string) {
    const robot = this.robots.find(r => r.config.id === id);
    if (robot) robot.disconnect();
    this.robots = this.robots.filter(r => r.config.id !== id);

    if (this.activeRobotId === id) {
      this.activeRobotId = this.robots.length > 0 ? this.robots[0].config.id : null;
    }
    this.saveRobots();
    this.updateState();
  }

  setActiveRobot(id: string) {
    this.activeRobotId = id;
    this.updateState();
  }

  private saveRobots() {
    const configs = this.robots.map(r => r.config);
    localStorage.setItem('robot_configs', JSON.stringify(configs));
  }

  private loadRobots() {
    try {
      const stored = localStorage.getItem('robot_configs');
      if (stored) {
        const configs: RobotConfig[] = JSON.parse(stored);
        this.robots = configs.map(c => new RobotInstance(c, () => this.updateState()));
        if (this.robots.length > 0) {
          this.activeRobotId = this.robots[0].config.id;
        }
      }
    } catch(e) {}
    this.updateState();
  }

  private saveTeams() {
    localStorage.setItem('teams', JSON.stringify(this.teams));
    this.teams$.next([...this.teams]);
  }

  private loadTeams() {
    try {
      const saved = localStorage.getItem('teams');
      if (saved) {
        this.teams = JSON.parse(saved);
        this.teams$.next([...this.teams]);
      }
    } catch (e) {
      console.error('Takımlar yüklenemedi', e);
    }
  }

  addTeam(team: Team) {
    this.teams.push(team);
    this.saveTeams();
  }

  updateTeam(teamId: string, updated: Team) {
    const idx = this.teams.findIndex(t => t.id === teamId);
    if (idx > -1) {
      this.teams[idx] = updated;
      this.saveTeams();
    }
  }

  removeTeam(teamId: string) {
    this.teams = this.teams.filter(t => t.id !== teamId);
    this.saveTeams();
  }
}
