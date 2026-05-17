import { Component, EventEmitter, Input, Output } from '@angular/core';

export const EMOTIONS = [
  { id: 'happy',   label: 'Mutlu',      emoji: '😄', color: '#fbbf24' },
  { id: 'excited', label: 'Heyecanlı',  emoji: '⚡',  color: '#a855f7' },
  { id: 'sad',     label: 'Üzgün',      emoji: '😢', color: '#60a5fa' },
  { id: 'scared',  label: 'Korkmuş',    emoji: '😨', color: '#f87171' },
  { id: 'angry',   label: 'Sinirli',    emoji: '😠', color: '#ef4444' },
  { id: 'sleepy',  label: 'Uykulu',     emoji: '😴', color: '#818cf8' },
  { id: 'neutral', label: 'Normal',     emoji: '😐', color: '#6b7280' },
];

@Component({
  selector: 'app-emotion-panel',
  templateUrl: './emotion-panel.component.html'
})
export class EmotionPanelComponent {
  @Input() activeEmotion!: string;
  @Input() disabled!: boolean;
  @Output() emotionSelect = new EventEmitter<string>();

  emotions = EMOTIONS;

  handleEmotion(id: string) {
    if (this.disabled) return;
    this.emotionSelect.emit(id);
  }
}
