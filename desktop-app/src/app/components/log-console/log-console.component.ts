import { Component, EventEmitter, Input, Output } from '@angular/core';
import { LogEntry } from '../../services/websocket.service';

@Component({
  selector: 'app-log-console',
  templateUrl: './log-console.component.html'
})
export class LogConsoleComponent {
  @Input() logs: LogEntry[] = [];
  @Output() clearLogs = new EventEmitter<void>();

  typeColors: Record<string, string> = {
    success : '#10b981',
    send    : '#818cf8',
    recv    : '#06b6d4',
    warn    : '#f59e0b',
    error   : '#ef4444',
    info    : '#4a5568',
  };

  typePrefixes: Record<string, string> = {
    success : '✓',
    send    : '→',
    recv    : '←',
    warn    : '⚠',
    error   : '✗',
    info    : '·',
  };

  getColor(type: string): string {
    return this.typeColors[type] || '#4a5568';
  }

  getPrefix(type: string): string {
    return this.typePrefixes[type] || '·';
  }

  copyLogs() {
    const text = this.logs.map(l => `[${l.ts}] ${l.type.toUpperCase()}: ${l.msg}`).join('\n');
    navigator.clipboard.writeText(text).catch(err => console.error('Kopyalama hatası:', err));
  }
}
