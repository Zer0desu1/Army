import re

with open('src/app/components/digital-twin/digital-twin.component.ts', 'r', encoding='utf-8') as f:
    content = f.read()

# 1. Update the interface and class properties
replacement = """
export interface TwinInstance {
  type: string;
  state: RobotState;
  group: THREE.Group;
  mainBodyGrp: THREE.Group;
  body?: THREE.Mesh;
  legs: LegGroup[];
  wheels: THREE.Object3D[];
  headGrp?: THREE.Group;
  tailGrp?: THREE.Group;
  eyeL?: THREE.Mesh;
  eyeR?: THREE.Mesh;
  walkPhase: number;
  sitLerp: number;
  legAngles: number[];
  headTilt: number;
}

@Component({
"""
content = re.sub(r'@Component\(\{', replacement, content, 1)

content = re.sub(r'@Input\(\) robotState!: RobotState;', r'@Input() robotState!: RobotState;\n  @Input() fleetRobots: {type: string, state: RobotState}[] | null = null;\n  @Input() fleetSpacing: number = 1.0;', content)

# 2. Replace class state variables with array
props_to_remove = [
    r'private robot!: THREE\.Group;\s*',
    r'private body!: THREE\.Mesh;\s*',
    r'private headGrp!: THREE\.Group;\s*',
    r'private eyeL!: THREE\.Mesh;\s*',
    r'private eyeR!: THREE\.Mesh;\s*',
    r'private tailGrp!: THREE\.Group;\s*',
    r'private legs: LegGroup\[\] = \[\];\s*',
    r'private wheels: THREE\.Object3D\[\] = \[\];\s*',
    r'private mainBodyGrp!: THREE\.Group;\s*',
    r'private walkPhase = 0;\s*',
    r'private isWalking = false;\s*',
    r'private isSitting = false;\s*',
    r'private emotion = \'neutral\';\s*',
    r'private speed = 50;\s*',
    r'private legAngles = \[0, 0, 0, 0\];\s*',
    r'private sitLerp = 0;\s*',
    r'private headTilt = 0;\s*'
]
for p in props_to_remove:
    content = re.sub(p, '', content)

content = re.sub(r'/\* ── Animation state ── \*/', r'private instances: TwinInstance[] = [];\n', content)

# 3. Modify get statusLabel() 
content = re.sub(r'get statusLabel\(\): string \{.*?return \'○ BEKLİYOR\';\s*\}', r"""get statusLabel(): string {
    if (this.fleetRobots) return 'Takım Modu';
    if (!this.instances[0]) return '○ BEKLİYOR';
    const s = this.instances[0].state;
    if (s.walking) return '● HAREKETLİ';
    if (s.sitting) return '◉ BEKLEMEDE / OTURUYOR';
    return '○ BEKLİYOR';
  }""", content, flags=re.DOTALL)

# 4. Modify buildRobot router
build_robot_new = """
  private buildRobot() {
    this.instances.forEach(inst => this.scene.remove(inst.group));
    this.instances = [];

    const toBuild = this.fleetRobots ? this.fleetRobots : [{ type: this.robotType, state: this.robotState }];

    toBuild.forEach((item, idx) => {
      let inst: TwinInstance;
      switch (item.type) {
        case 'tank': inst = this.buildTank(item.state); break;
        case 'omni3': inst = this.buildOmni3(item.state); break;
        case 'omni4': inst = this.buildOmni4(item.state); break;
        case 'dog':
        default: inst = this.buildDog(item.state); break;
      }
      
      const offset = (idx - (toBuild.length - 1) / 2) * this.fleetSpacing;
      inst.group.position.x = offset;
      
      this.scene.add(inst.group);
      this.instances.push(inst);
    });
  }
"""
content = re.sub(r'private buildRobot\(\) \{.*?(?=/\* ═══════════════════════════════════════════════════════)', build_robot_new, content, flags=re.DOTALL)

# 5. Fix ngOnChanges
ng_on_changes_new = """
  ngOnChanges(ch: SimpleChanges) {
    if (ch['robotType'] || ch['fleetRobots'] || ch['fleetSpacing']) {
      if (this.scene) {
        this.ngZone.runOutsideAngular(() => {
          this.buildRobot();
        });
      }
    }
  }
"""
content = re.sub(r'ngOnChanges\(ch: SimpleChanges\) \{.*?(?=ngOnDestroy\(\))', ng_on_changes_new, content, flags=re.DOTALL)


# 6. Replace `this.` with `inst.` inside build methods.
def replace_this_with_inst(match):
    body = match.group(0)
    body = re.sub(r'this\.robot\b', 'inst.group', body)
    body = re.sub(r'this\.mainBodyGrp\b', 'inst.mainBodyGrp', body)
    body = re.sub(r'this\.legs\b', 'inst.legs', body)
    body = re.sub(r'this\.wheels\b', 'inst.wheels', body)
    body = re.sub(r'this\.headGrp\b', 'inst.headGrp', body)
    body = re.sub(r'this\.tailGrp\b', 'inst.tailGrp', body)
    body = re.sub(r'this\.eyeL\b', 'inst.eyeL', body)
    body = re.sub(r'this\.eyeR\b', 'inst.eyeR', body)
    body = re.sub(r'this\.body\b', 'inst.body', body)
    return body

# Extract build sections and replace
content = re.sub(r'(private buildDog\(\) \{.*?\n  \})', replace_this_with_inst, content, flags=re.DOTALL)
content = re.sub(r'(private buildTank\(\) \{.*?\n  \})', replace_this_with_inst, content, flags=re.DOTALL)
content = re.sub(r'(private buildOmni3\(\) \{.*?\n  \})', replace_this_with_inst, content, flags=re.DOTALL)
content = re.sub(r'(private buildOmni4\(\) \{.*?\n  \})', replace_this_with_inst, content, flags=re.DOTALL)

# Change method signatures and insert `inst` declaration
content = re.sub(r'private buildDog\(\) \{', r"""private buildDog(state: RobotState): TwinInstance {
    const inst: TwinInstance = { group: new THREE.Group(), mainBodyGrp: new THREE.Group(), legs: [], wheels: [], walkPhase: 0, sitLerp: 0, legAngles: [0,0,0,0], headTilt: 0, type: 'dog', state };
    inst.mainBodyGrp = new THREE.Group();
""", content)

content = re.sub(r'private buildTank\(\) \{', r"""private buildTank(state: RobotState): TwinInstance {
    const inst: TwinInstance = { group: new THREE.Group(), mainBodyGrp: new THREE.Group(), legs: [], wheels: [], walkPhase: 0, sitLerp: 0, legAngles: [0,0,0,0], headTilt: 0, type: 'tank', state };
""", content)

content = re.sub(r'private buildOmni3\(\) \{', r"""private buildOmni3(state: RobotState): TwinInstance {
    const inst: TwinInstance = { group: new THREE.Group(), mainBodyGrp: new THREE.Group(), legs: [], wheels: [], walkPhase: 0, sitLerp: 0, legAngles: [0,0,0,0], headTilt: 0, type: 'omni3', state };
""", content)

content = re.sub(r'private buildOmni4\(\) \{', r"""private buildOmni4(state: RobotState): TwinInstance {
    const inst: TwinInstance = { group: new THREE.Group(), mainBodyGrp: new THREE.Group(), legs: [], wheels: [], walkPhase: 0, sitLerp: 0, legAngles: [0,0,0,0], headTilt: 0, type: 'omni4', state };
""", content)

# Return inst at the end of each build function. Using rfind to insert return inst;
def append_return(match):
    m = match.group(0)
    return m[:-3] + "\n    return inst;\n  }"

content = re.sub(r'(private buildDog\(.*?\n  \})', append_return, content, flags=re.DOTALL)
content = re.sub(r'(private buildTank\(.*?\n  \})', append_return, content, flags=re.DOTALL)
content = re.sub(r'(private buildOmni3\(.*?\n  \})', append_return, content, flags=re.DOTALL)
content = re.sub(r'(private buildOmni4\(.*?\n  \})', append_return, content, flags=re.DOTALL)


# 7. Update animate methods to take inst
animate_new = """
  private animate() {
    this.frameId = requestAnimationFrame(() => this.animate());
    const dt = this.clock.getDelta();
    const t = this.clock.getElapsedTime();

    this.controls.update();

    for (const inst of this.instances) {
      if (!inst.state) continue;
      
      this.updateEmotionColor(inst);

      if (inst.type === 'dog') {
        this.animateWalkDog(inst, dt, t);
        this.animateSitDog(inst, dt);
        this.animateEmotionDog(inst, dt, t);
        this.animateIdleDog(inst, dt, t);
      } else {
        this.animateWheeledRobot(inst, dt, t);
      }
    }

    this.renderer.render(this.scene, this.camera);
  }

  /* ── Wheeled Robots Animation ── */
  private animateWheeledRobot(inst: TwinInstance, dt: number, t: number) {
    const spd = (inst.state.speed || 50) / 50;
    
    if (inst.state.walking) {
      for (const w of inst.wheels) {
        if (inst.type === 'tank') w.rotation.y -= dt * 5 * spd; 
        else w.rotation.x -= dt * 5 * spd; 
      }
      if (inst.mainBodyGrp) inst.mainBodyGrp.position.y = 0.25 + Math.sin(t * 15 * spd) * 0.005;
    } else {
      if (inst.mainBodyGrp) inst.mainBodyGrp.position.y = 0.25;
    }
    
    if (!inst.state.walking && inst.mainBodyGrp) {
       inst.mainBodyGrp.position.y = 0.25 + Math.sin(t * 2) * 0.005;
    }
  }

  /* ── Dog Walk ── */
  private animateWalkDog(inst: TwinInstance, dt: number, t: number) {
    const spd = (inst.state.speed || 50) / 50;
    if (inst.state.walking && !inst.state.sitting) {
      inst.walkPhase += dt * 5 * spd;
      const s = Math.sin(inst.walkPhase) * (Math.PI / 7);
      inst.legAngles[0] =  s; 
      inst.legAngles[1] = -s; 
      inst.legAngles[2] = -s; 
      inst.legAngles[3] =  s; 

      inst.group.position.y = Math.sin(inst.walkPhase * 2) * 0.015;
      inst.group.rotation.z = Math.sin(inst.walkPhase) * 0.015;
    } else {
      for (let i = 0; i < 4; i++) inst.legAngles[i] *= 0.9;
      if (!inst.state.sitting) {
        inst.group.position.y *= 0.92;
        inst.group.rotation.z *= 0.92;
      }
    }

    for (let i = 0; i < 4; i++) {
      if (!inst.legs[i]) continue;
      const leg = inst.legs[i];
      leg.hip.rotation.x += (inst.legAngles[i] - leg.hip.rotation.x) * 0.2;
    }
  }

  /* ── Dog Sit ── */
  private animateSitDog(inst: TwinInstance, dt: number) {
    if (inst.type !== 'dog' || !inst.legs.length) return;
    
    const sitTarget = inst.state.sitting ? 1 : 0;
    inst.sitLerp += (sitTarget - inst.sitLerp) * 3 * dt;

    if (inst.sitLerp > 0.01) {
      inst.legs[0].hip.rotation.x += (-1.4 * inst.sitLerp - inst.legs[0].hip.rotation.x) * 0.1;
      inst.legs[1].hip.rotation.x += (-1.4 * inst.sitLerp - inst.legs[1].hip.rotation.x) * 0.1;
      inst.legs[2].hip.rotation.x += (1.4 * inst.sitLerp - inst.legs[2].hip.rotation.x) * 0.1;
      inst.legs[3].hip.rotation.x += (1.4 * inst.sitLerp - inst.legs[3].hip.rotation.x) * 0.1;

      const targetY = -0.3 * inst.sitLerp;
      inst.group.position.y += (targetY - inst.group.position.y) * 0.1;
    }
  }

  /* ── Dog Emotion ── */
  private animateEmotionDog(inst: TwinInstance, dt: number, t: number) {
    if(!inst.tailGrp || !inst.headGrp) return;

    switch (inst.state.emotionName) {
      case 'happy':
        inst.tailGrp.rotation.y = Math.sin(t * 12) * 0.5;
        inst.headTilt = Math.sin(t * 3) * 0.05;
        break;
      case 'excited':
        inst.tailGrp.rotation.y = Math.sin(t * 15) * 0.6;
        inst.headTilt = 0;
        break;
      case 'sad':
        inst.tailGrp.rotation.y = 0;
        inst.tailGrp.rotation.x = -0.6;
        inst.headTilt = 0.4;
        break;
      case 'scared':
        inst.tailGrp.rotation.x = -0.8;
        inst.headTilt = -0.2;
        break;
      case 'sleepy':
        inst.tailGrp.rotation.x = -0.4;
        inst.headTilt = Math.sin(t) * 0.02;
        break;
      default:
        inst.tailGrp.rotation.set(0, 0, 0);
        inst.headTilt *= 0.9;
        break;
    }

    inst.headGrp.rotation.z += (inst.headTilt - inst.headGrp.rotation.z) * 0.1;
  }

  /* ── Dog Idle ── */
  private animateIdleDog(inst: TwinInstance, dt: number, t: number) {
    if (!inst.state.walking && !inst.state.sitting) {
      if(inst.headGrp) {
        inst.headGrp.rotation.y = Math.sin(t * 0.5) * 0.1;
        inst.headGrp.rotation.x = Math.sin(t * 0.3) * 0.05;
      }
      if(inst.tailGrp && inst.state.emotionName === 'neutral') {
        inst.tailGrp.rotation.y = Math.sin(t * 2) * 0.1;
      }
    }
  }

  /* ── Update Emotion Colors ── */
  private updateEmotionColor(inst: TwinInstance) {
    if (!inst.state) return;
    const colorHex = this.emotionColorMap[inst.state.emotionName || 'neutral'] || 0x6366f1;
    this.matAccent.color.setHex(colorHex);
    this.matAccent.emissive.setHex(colorHex);
    
    if (inst.eyeL) {
       (inst.eyeL.material as THREE.MeshStandardMaterial).color.setHex(colorHex);
       (inst.eyeL.material as THREE.MeshStandardMaterial).emissive.setHex(colorHex);
    }
    if (inst.eyeR) {
       (inst.eyeR.material as THREE.MeshStandardMaterial).color.setHex(colorHex);
       (inst.eyeR.material as THREE.MeshStandardMaterial).emissive.setHex(colorHex);
    }
  }
}
"""
content = re.sub(r'private animate\(\) \{.*$', animate_new, content, flags=re.DOTALL)

with open('src/app/components/digital-twin/digital-twin.component.ts', 'w', encoding='utf-8') as f:
    f.write(content)
