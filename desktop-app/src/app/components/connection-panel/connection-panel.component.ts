import { Component, EventEmitter, Input, Output } from '@angular/core';

@Component({
  selector: 'app-connection-panel',
  templateUrl: './connection-panel.component.html'
})
export class ConnectionPanelComponent {
  @Input() ip!: string;
  @Input() status!: 'offline' | 'connecting' | 'online';
  
  @Output() ipChange = new EventEmitter<string>();
  @Output() connect = new EventEmitter<string>();
  @Output() disconnect = new EventEmitter<void>();
  @Output() provisionWifi = new EventEmitter<{ssid: string; pass: string}>();
  @Output() resetWifi = new EventEmitter<void>();

  inputVal = '';

  // WiFi provizyon paneli
  showWifiPanel = false;
  wifiSsid = '';
  wifiPass = '';

  toggleWifiPanel() {
    this.showWifiPanel = !this.showWifiPanel;
  }

  submitWifi() {
    if (!this.wifiSsid.trim()) return;
    this.provisionWifi.emit({ ssid: this.wifiSsid.trim(), pass: this.wifiPass });
    this.wifiSsid = '';
    this.wifiPass = '';
    this.showWifiPanel = false;
  }

  ngOnInit() {
    this.inputVal = this.ip;
  }

  ngOnChanges(changes: any) {
    if (changes.ip && changes.ip.currentValue !== undefined) {
      this.inputVal = changes.ip.currentValue;
    }
  }
  get isOnline() { return this.status === 'online'; }
  get isConnecting() { return this.status === 'connecting'; }

  get statusLabel() {
    return { online: 'Bağlı', offline: 'Bağlı Değil', connecting: 'Bağlanıyor…' }[this.status];
  }

  get statusColor() {
    return { online: 'var(--success)', offline: 'var(--danger)', connecting: 'var(--warn)' }[this.status];
  }

  handleConnect() {
    this.ipChange.emit(this.inputVal);
    this.connect.emit(this.inputVal);
  }
}
