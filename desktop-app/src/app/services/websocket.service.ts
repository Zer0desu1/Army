import { Injectable } from '@angular/core';
import { BehaviorSubject, Subject } from 'rxjs';

export interface RobotState {
  emotion: number;
  emotionName?: string;
  speed: number;
  sitting: boolean;
  walking: boolean;
}

export interface LogEntry {
  msg: string;
  type: 'info' | 'success' | 'warn' | 'error' | 'send' | 'recv';
  ts: string;
}

@Injectable({
  providedIn: 'root'
})
export class WebsocketService {
  private ws: WebSocket | null = null;
  private readonly WS_PORT = 81;

  public status$ = new BehaviorSubject<'offline' | 'connecting' | 'online'>('offline');
  public robotState$ = new BehaviorSubject<RobotState>({
    emotion: 0,
    emotionName: 'neutral',
    speed: 50,
    sitting: false,
    walking: false
  });
  public logs$ = new BehaviorSubject<LogEntry[]>([]);

  constructor() {}

  private addLog(msg: string, type: LogEntry['type'] = 'info') {
    const ts = new Date().toLocaleTimeString('tr-TR', { hour12: false });
    const currentLogs = this.logs$.value;
    this.logs$.next([{ msg, type, ts }, ...currentLogs].slice(0, 100));
  }

  public clearLogs() {
    this.logs$.next([]);
  }

  public connect(ip: string) {
    if (!ip || ip.trim() === '') return;
    if (this.ws) {
      this.ws.close();
    }

    this.status$.next('connecting');
    this.addLog(`Bağlanıyor → ws://${ip.trim()}:${this.WS_PORT}`, 'info');

    try {
      this.ws = new WebSocket(`ws://${ip.trim()}:${this.WS_PORT}`);

      this.ws.onopen = () => {
        this.status$.next('online');
        this.addLog(`✓ Bağlantı kuruldu (${ip.trim()}:${this.WS_PORT})`, 'success');
      };

      this.ws.onclose = () => {
        this.status$.next('offline');
        this.addLog('Bağlantı kesildi', 'warn');
      };

      this.ws.onerror = () => {
        this.status$.next('offline');
        this.addLog('Bağlantı hatası — IP veya port doğru mu?', 'error');
      };

      this.ws.onmessage = (e) => {
        try {
          const state = JSON.parse(e.data);
          this.robotState$.next({ ...this.robotState$.value, ...state });
          this.addLog(`← durum alındı (hız:${state.speed} | duygu:${state.emotionName ?? state.emotion})`, 'recv');
        } catch {
          this.addLog(`← ham mesaj: ${e.data}`, 'recv');
        }
      };
    } catch (err: any) {
      this.status$.next('offline');
      this.addLog(`Hata: ${err.message}`, 'error');
    }
  }

  public disconnect() {
    this.ws?.close();
    this.status$.next('offline');
  }

  public send(cmd: string, value: any = null): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.addLog('⚠ Bağlı değil! Önce bağlantı kur.', 'error');
      return false;
    }
    const payload = value !== null ? { cmd, value } : { cmd };
    this.ws.send(JSON.stringify(payload));
    this.addLog(`→ ${cmd}${value !== null ? ` [${value}]` : ''}`, 'send');
    return true;
  }
}
