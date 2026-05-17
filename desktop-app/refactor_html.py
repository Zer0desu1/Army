import re

with open('src/app/app.component.html', 'r', encoding='utf-8') as f:
    content = f.read()

# 1. Add Teams section in sidebar
sidebar_insert = """
    <!-- TAKIMLAR (TEAMS) -->
    <div style="padding: 12px; margin-top: 8px;">
      <div style="font-size: 11px; font-weight: 700; color: var(--text-muted); margin-bottom: 8px;">TAKIMLAR</div>
      <div class="robot-items">
        <button *ngFor="let t of teams" class="robot-item" [class.active]="activeTeam === t" (click)="selectTeam(t)">
          <span class="type-icon">🛡️</span>
          <div class="robot-info">
            <div class="r-name">{{t.name}}</div>
            <div style="font-size: 10px; color: var(--text-muted);">{{t.robotIds.length}} Robot</div>
          </div>
        </button>
      </div>
      <button class="btn-ghost" style="width: 100%; border: 1px dashed var(--border); padding: 8px; border-radius: 8px; margin-top: 8px;" (click)="openTeamModal()">
        + Takım Oluştur
      </button>
    </div>
"""
content = re.sub(r'(<div class="robot-items">.*?</div>)', r'\1' + sidebar_insert, content, count=1, flags=re.DOTALL)


# 2. Add Team Modal
team_modal = """
  <!-- TEAM BUILDER MODAL -->
  <div class="modal-overlay" *ngIf="showTeamModal">
    <div class="modal-content" style="max-width: 500px;">
      <div class="modal-header">
        <h2 style="font-size: 20px; font-weight: 700;">Takım Oluştur</h2>
        <button class="close-btn" (click)="showTeamModal = false">✕</button>
      </div>
      <div class="modal-body" style="display: flex; flex-direction: column; gap: 16px;">
        <label class="form-group">
          <span>Takım Adı</span>
          <input type="text" [(ngModel)]="teamFormData.name" placeholder="Örn: Alfa Timi">
        </label>
        
        <div class="form-group">
          <span>Takımdaki Robotlar</span>
          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 8px;">
            <label *ngFor="let r of robots" style="display: flex; align-items: center; gap: 8px; cursor: pointer; padding: 8px; border: 1px solid var(--border); border-radius: 6px;" [style.border-color]="teamFormData.robotIds.includes(r.config.id) ? 'var(--accent)' : ''">
              <input type="checkbox" 
                     [checked]="teamFormData.robotIds.includes(r.config.id)" 
                     (change)="toggleTeamRobot(r.config.id)" 
                     style="width: 16px; height: 16px;">
              <span>{{r.config.name}}</span>
            </label>
          </div>
        </div>
        
        <label class="form-group">
          <span>Robotlar Arası Mesafe (Metre)</span>
          <input type="range" min="0.5" max="3" step="0.1" [(ngModel)]="teamFormData.spacing">
          <div style="font-size: 11px; text-align: right; color: var(--accent);">{{teamFormData.spacing}}m</div>
        </label>

        <button class="btn-primary" style="margin-top: 16px;" (click)="saveTeam()" [disabled]="teamFormData.name.length < 2 || teamFormData.robotIds.length < 1">Takımı Kaydet</button>
      </div>
    </div>
  </div>
"""
content = re.sub(r'</div>\s*$', team_modal + '\n</div>', content, flags=re.DOTALL)


# 3. Modify "EMPTY STATE" to check !activeRobot && !activeTeam
content = re.sub(r'<div class="empty-state" \*ngIf="!activeRobot">', r'<div class="empty-state" *ngIf="!activeRobot && !activeTeam">', content)

# 4. Modify workspace wrapper
# Currently `<div class="robot-workspace" *ngIf="activeRobot">`
content = re.sub(r'<div class="robot-workspace" \*ngIf="activeRobot">', r'<div class="robot-workspace" *ngIf="activeRobot || activeTeam">', content)

# 5. Modify LEFT PANEL to handle activeTeam
left_panel_regex = r'(<!-- LEFT PANEL: Config & Status -->.*?)(?=<!-- CENTER PANEL: Display & Control -->)'
left_panel_match = re.search(left_panel_regex, content, re.DOTALL)

if left_panel_match:
    old_left = left_panel_match.group(1)
    # Wrap old_left in *ngIf="activeRobot"
    # Create team version of left panel
    team_left = """
    <!-- LEFT PANEL: TEAM CONFIG -->
    <aside *ngIf="activeTeam" style="padding: 16px; display: flex; flex-direction: column; gap: 16px; border-right: 1px solid var(--border); overflow-y: auto;">
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
        <div style="font-weight: 700; font-size: 16px; display: flex; align-items: center; gap: 8px;">
          <span>🛡️</span><span>{{activeTeam.name}}</span>
        </div>
        <button class="btn-danger" style="padding: 6px 12px; font-size: 11px;" (click)="deleteTeam(activeTeam.id)">Sil</button>
      </div>
      
      <div class="glass-panel" style="padding: 16px;">
        <div class="section-label">Takım Üyeleri ({{activeTeam.robotIds.length}})</div>
        <div style="display: flex; flex-direction: column; gap: 8px;">
          <div *ngFor="let id of activeTeam.robotIds" style="font-size: 12px; display: flex; justify-content: space-between;">
             <span>{{ (robots | async) }}</span>
             <span style="color: var(--text-muted)">{{id}}</span>
          </div>
        </div>
      </div>
      
      <!-- Speed & Steps -->
      <div class="glass-panel" style="padding: 16px;">
        <div class="section-label">⚡ Ortak Hız & Adım</div>
        
        <div style="margin-bottom: 4px; font-size: 11px; color: var(--text-muted);">Adım Sayısı</div>
        <div class="slider-row">
          <input type="range" min="1" max="20" [value]="steps" (input)="setSteps($event)" />
          <span class="slider-val">{{steps}}</span>
        </div>
      </div>
    </aside>
    """
    
    # We need a small hack to just add *ngIf="activeRobot" to the aside tag
    new_left = re.sub(r'<aside ', r'<aside *ngIf="activeRobot" ', old_left, 1)
    
    content = content[:left_panel_match.start()] + new_left + team_left + content[left_panel_match.end():]

# 6. Update Digital Twin instantiation
content = re.sub(
    r'<app-digital-twin \[robotState\]="activeRobot\.state" \[robotType\]="activeRobot\.config\.type"></app-digital-twin>',
    r"""<app-digital-twin *ngIf="activeRobot" [robotState]="activeRobot.state" [robotType]="activeRobot.config.type"></app-digital-twin>
        <app-digital-twin *ngIf="activeTeam" [fleetRobots]="teamRobots" [fleetSpacing]="activeTeam.spacing"></app-digital-twin>""",
    content
)

# 7. Movement Pad disabled check
content = re.sub(r'\[disabled\]="activeRobot\.status !== \'online\'"', r'[disabled]="(activeRobot && activeRobot.status !== \'online\') || (activeTeam && false)"', content)

# 8. Right Panel (*ngIf="activeRobot")
content = re.sub(r'<aside style="padding: 16px; display: flex; flex-direction: column; gap: 16px; border-left: 1px solid var\(--border\); overflow: hidden;">', r'<aside *ngIf="activeRobot" style="padding: 16px; display: flex; flex-direction: column; gap: 16px; border-left: 1px solid var(--border); overflow: hidden;">', content)

with open('src/app/app.component.html', 'w', encoding='utf-8') as f:
    f.write(content)
