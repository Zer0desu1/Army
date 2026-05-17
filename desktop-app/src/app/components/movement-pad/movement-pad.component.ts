import { Component, EventEmitter, Input, Output } from '@angular/core';

@Component({
  selector: 'app-movement-pad',
  templateUrl: './movement-pad.component.html'
})
export class MovementPadComponent {
  @Input() steps!: number;
  @Input() disabled!: boolean;
  @Input() avoidActive: boolean = false;
  @Input() stabilizeActive: boolean = false;
  @Output() sendCommand = new EventEmitter<{cmd: string, value?: number}>();

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
