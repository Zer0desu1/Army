import { Component, EventEmitter, Input, OnChanges, Output, SimpleChanges } from '@angular/core';

@Component({
  selector: 'app-movement-pad',
  templateUrl: './movement-pad.component.html'
})
export class MovementPadComponent implements OnChanges {
  @Input() steps!: number;
  @Input() disabled!: boolean;
  @Input() robotType?: string;
  @Input() avoidActive: boolean = false;
  @Input() stabilizeActive: boolean = false;

  @Input() pidKp?: number;
  @Input() pidKi?: number;
  @Input() revBoost?: number;
  @Output() sendCommand = new EventEmitter<{cmd: string, value?: number | string}>();
  @Output() sendPid = new EventEmitter<{ kp?: number; ki?: number }>();
  @Output() sendTrim = new EventEmitter<number>();

  servoOn = false;
  uartMsg = '';
  convoyOn = false;
  convoyCyberSpeed = 100;

  pidShow = false;
  pidForm = { kp: 0.030, ki: 0.0010, rev: 1.0 };

  ngOnChanges(changes: SimpleChanges) {
    if (this.pidKp    !== undefined) this.pidForm.kp  = this.pidKp;
    if (this.pidKi    !== undefined) this.pidForm.ki  = this.pidKi;
    if (this.revBoost !== undefined) this.pidForm.rev = this.revBoost;

    if (changes['robotType']) {
      const omni4 = this.robotType === 'omni4';
      const l = this.directions.find(d => d.row === 2 && d.col === 1);
      const r = this.directions.find(d => d.row === 2 && d.col === 3);
      if (l) { l.cmd = omni4 ? 'strafeLeft'  : 'left';  l.label = omni4 ? 'Sola Kay' : 'Sol'; }
      if (r) { r.cmd = omni4 ? 'strafeRight' : 'right'; r.label = omni4 ? 'Sağa Kay' : 'Sağ'; }
    }
  }

  togglePid() { this.pidShow = !this.pidShow; }

  applyPid() {
    this.sendPid.emit({
      kp: Number(this.pidForm.kp),
      ki: Number(this.pidForm.ki),
    });
  }

  applyTrim() {
    this.sendTrim.emit(Number(this.pidForm.rev));
  }

  toggleServo() {
    if (this.disabled) return;
    this.servoOn = !this.servoOn;
    this.sendCommand.emit({ cmd: 'servo', value: this.servoOn ? 90 : 0 });
  }

  sendUart() {
    if (this.disabled) return;
    const msg = (this.uartMsg ?? '').trim();
    if (!msg) return;
    this.sendCommand.emit({ cmd: 'uart', value: msg });
  }

  toggleConvoy() {
    if (this.disabled) return;
    this.convoyOn = !this.convoyOn;
    this.sendCommand.emit({ cmd: 'convoy', value: this.convoyOn ? 1 : 0 });
  }

  setConvoyCyberSpeed(val: number) {
    this.convoyCyberSpeed = val;
    this.sendCommand.emit({ cmd: 'convoySpeed', value: val });
  }

  toggleAvoid() {
    if (this.disabled) return;
    this.sendCommand.emit({ cmd: 'avoid', value: this.avoidActive ? 0 : 1 });
  }

  toggleStabilize() {
    if (this.disabled) return;
    this.sendCommand.emit({ cmd: 'stabilize', value: this.stabilizeActive ? 0 : 1 });
  }

  directions = [
    { cmd: null,    icon: '',   label: '',      row: 1, col: 1 },
    { cmd: 'walk',  icon: '↑',  label: 'İleri', row: 1, col: 2 },
    { cmd: null,    icon: '',   label: '',      row: 1, col: 3 },
    { cmd: 'left',  icon: '←',  label: 'Sol',   row: 2, col: 1 },
    { cmd: 'stop',  icon: '■',  label: 'Dur',   row: 2, col: 2 },
    { cmd: 'right', icon: '→',  label: 'Sağ',   row: 2, col: 3 },
    { cmd: null,    icon: '',   label: '',      row: 3, col: 1 },
    { cmd: 'back',  icon: '↓',  label: 'Geri',  row: 3, col: 2 },
    { cmd: null,    icon: '',   label: '',      row: 3, col: 3 },
  ];

  activeCmd: string | null = null;
  holdRef: any;

  startHold(cmd: string | null) {
    if (!cmd || this.disabled) return;
    if (cmd === 'stop') {
      this.sendCommand.emit({ cmd: 'stop' });
      return;
    }
    this.activeCmd = cmd;
    this.sendCommand.emit({ cmd, value: this.steps });
    this.holdRef = setInterval(() => this.sendCommand.emit({ cmd, value: this.steps }), 800);
  }

  stopHold() {
    clearInterval(this.holdRef);
    this.activeCmd = null;
  }
}
