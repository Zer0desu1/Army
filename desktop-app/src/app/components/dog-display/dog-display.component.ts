import { Component, Input } from '@angular/core';
import { RobotState } from '../../services/robot.service';
import { EMOTIONS } from '../emotion-panel/emotion-panel.component';

@Component({
  selector: 'app-dog-display',
  templateUrl: './dog-display.component.html'
})
export class DogDisplayComponent {
  @Input() robotState!: RobotState;

  get emotionName() {
    return this.robotState.emotionName || 'neutral';
  }

  get emotionObj() {
    return EMOTIONS.find(e => e.id === this.emotionName) || EMOTIONS.find(e => e.id === 'neutral')!;
  }

  get animClass() {
    if (this.robotState.walking) return 'walking';
    if (this.robotState.sitting) return 'sitting';
    if (this.emotionName === 'happy') return 'happy';
    if (this.emotionName === 'excited') return 'excited';
    return '';
  }

  get statusText() {
    if (this.robotState.walking) return 'Yürüyor…';
    if (this.robotState.sitting) return 'Oturuyor';
    return 'Bekliyor';
  }
}
