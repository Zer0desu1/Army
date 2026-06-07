import {
  Component, ElementRef, Input, Output, EventEmitter, AfterViewInit, OnDestroy, ViewChild, NgZone, SimpleChanges, OnChanges
} from '@angular/core';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RobotState } from '../../services/robot.service';

const BODY_L = 1.2, BODY_H = 0.32, BODY_W = 0.52;
const BODY_Y = 1.05;
const UPPER_L = 0.42, LOWER_L = 0.42, LEG_W = 0.10;
const SWING = Math.PI / 7;
const HEAD_S = 0.30;

interface LegGroup {
  hip: THREE.Group;
  knee: THREE.Group;
}

export interface TwinInstance {
  id?: string;
  name?: string;
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

  selector: 'app-digital-twin',
  templateUrl: './digital-twin.component.html'
})
export class DigitalTwinComponent implements AfterViewInit, OnDestroy, OnChanges {

  @ViewChild('twinCanvas', { static: true }) canvasRef!: ElementRef<HTMLCanvasElement>;
  @ViewChild('twinContainer', { static: true }) containerRef!: ElementRef<HTMLDivElement>;

  @Input() robotState!: RobotState;
  @Input() fleetRobots: {type: string, state: RobotState, id?: string, name?: string}[] | null = null;
  @Input() fleetSpacing: number = 1.0;
  @Input() robotType: string = 'dog';
  @Input() selectedFleetRobotId: string | null = null;
  @Output() selectFleetRobot = new EventEmitter<string>();
  @Output() fleetRobotMove = new EventEmitter<{id: string, cmd: string, steps?: number}>();

  private readonly STEPS_PER_UNIT = 3.5;
  private readonly STEPS_MIN = 1;
  private readonly STEPS_MAX = 20;

  public mapSize = 460;
  public mapRange = 4;
  public readonly mapRangeMin = 1;
  public readonly mapRangeMax = 15;

  public onMapWheel(e: WheelEvent) {
    e.preventDefault();
    const factor = e.deltaY > 0 ? 1.15 : 1 / 1.15;
    this.mapRange = Math.max(this.mapRangeMin, Math.min(this.mapRangeMax, this.mapRange * factor));
  }
  private fleetPositions = new Map<string, {x: number, z: number}>();
  private fleetTargets = new Map<string, {x: number, z: number}>();
  private selectionRing: THREE.Mesh | null = null;
  private targetMarker: THREE.Mesh | null = null;

  public waypoints: { id: string, name: string, type: 'base' | 'target', x: number, z: number }[] = [];
  public placingType: 'base' | 'target' | null = null;
  private waypointMeshes = new Map<string, THREE.Group>();

  public readonly robotBubble = 0.45;

  private renderer!: THREE.WebGLRenderer;
  private scene!: THREE.Scene;
  private camera!: THREE.PerspectiveCamera;
  private controls!: OrbitControls;
  private clock = new THREE.Clock();
  private frameId = 0;
  private ro!: ResizeObserver;

  private matBody!: THREE.MeshStandardMaterial;
  private matAccent!: THREE.MeshStandardMaterial;
  private matJoint!: THREE.MeshStandardMaterial;
  private matEye!: THREE.MeshStandardMaterial;
  private matLeg!: THREE.MeshStandardMaterial;

  private instances: TwinInstance[] = [];

  public get statusLabel(): string {
    if (this.fleetRobots) return 'Takım Modu';
    if (!this.instances[0]) return '○ BEKLİYOR';
    const s = this.instances[0].state;
    if (s.walking) return '● HAREKETLİ';
    if (s.sitting) return '◉ BEKLEMEDE / OTURUYOR';
    return '○ BEKLİYOR';
  }

  private emotionColorMap: Record<string, number> = {
    neutral: 0x6366f1, happy: 0xfbbf24, excited: 0xa855f7,
    sad: 0x60a5fa, scared: 0xf87171, angry: 0xef4444, sleepy: 0x818cf8,
  };

  constructor(private ngZone: NgZone) {}

  ngAfterViewInit() {
    this.ngZone.runOutsideAngular(() => {
      this.initMaterials();
      this.initScene();
      this.buildRobot();
      this.buildEnvironment();
      this.animate();
    });
  }

  ngOnChanges(ch: SimpleChanges) {
    if (ch['robotType'] || ch['fleetRobots'] || ch['fleetSpacing']) {
      if (this.scene) {
        this.ngZone.runOutsideAngular(() => {
          this.buildRobot();
        });
      }
    }
    if (ch['selectedFleetRobotId'] && this.scene) {
      this.ngZone.runOutsideAngular(() => this.updateSelectionRing());
    }
  }
ngOnDestroy() {
    cancelAnimationFrame(this.frameId);
    this.ro?.disconnect();
    this.controls?.dispose();
    this.renderer?.dispose();
  }

  private initMaterials() {
    this.matBody = new THREE.MeshStandardMaterial({
      color: 0x181c2e, metalness: 0.75, roughness: 0.28,
      emissive: 0x0c0f1a, emissiveIntensity: 0.15,
    });
    this.matAccent = new THREE.MeshStandardMaterial({
      color: 0x6366f1, emissive: 0x6366f1, emissiveIntensity: 0.7,
      metalness: 0.9, roughness: 0.1,
    });
    this.matJoint = new THREE.MeshStandardMaterial({
      color: 0x252a3e, metalness: 0.5, roughness: 0.5,
    });
    this.matEye = new THREE.MeshStandardMaterial({
      color: 0x6366f1, emissive: 0x6366f1, emissiveIntensity: 1.2,
      metalness: 1, roughness: 0,
    });
    this.matLeg = new THREE.MeshStandardMaterial({
      color: 0x1e2236, metalness: 0.65, roughness: 0.35,
    });
  }

  private initScene() {
    const canvas = this.canvasRef.nativeElement;
    const el = this.containerRef.nativeElement;
    const w = el.clientWidth, h = el.clientHeight;

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    this.renderer.setSize(w, h);
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.1;

    this.scene = new THREE.Scene();

    this.camera = new THREE.PerspectiveCamera(40, w / h, 0.1, 100);
    this.camera.position.set(2.8, 2.2, 2.8);

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.06;
    this.controls.target.set(0, 0.7, 0);
    this.controls.minDistance = 1.8;
    this.controls.maxDistance = 22;
    this.controls.maxPolarAngle = Math.PI / 2 + 0.15;
    this.controls.update();

    this.scene.add(new THREE.AmbientLight(0x3a3e5c, 0.6));

    const sun = new THREE.DirectionalLight(0xffffff, 1.2);
    sun.position.set(4, 8, 5);
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    sun.shadow.camera.near = 0.5;
    sun.shadow.camera.far = 20;
    sun.shadow.camera.left = -10;
    sun.shadow.camera.right = 10;
    sun.shadow.camera.top = 10;
    sun.shadow.camera.bottom = -10;
    this.scene.add(sun);

    const fill = new THREE.DirectionalLight(0x6366f1, 0.35);
    fill.position.set(-4, 3, -4);
    this.scene.add(fill);

    const rim = new THREE.PointLight(0xa855f7, 0.4, 12);
    rim.position.set(-2, 1, 2);
    this.scene.add(rim);

    this.ro = new ResizeObserver(() => this.onResize());
    this.ro.observe(el);
  }

  private onResize() {
    const el = this.containerRef.nativeElement;
    const w = el.clientWidth, h = el.clientHeight;
    if (w === 0 || h === 0) return;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  }

  private buildRobot() {
    this.instances.forEach(inst => this.scene.remove(inst.group));
    this.instances = [];

    const toBuild = this.fleetRobots ? this.fleetRobots : [{ type: this.robotType, state: this.robotState }];

    toBuild.forEach((item: any, idx) => {
      let inst: TwinInstance;
      switch (item.type) {
        case 'tank': inst = this.buildTank(item.state); break;
        case 'omni3': inst = this.buildOmni3(item.state); break;
        case 'omni4': inst = this.buildOmni4(item.state); break;
        case 'dog':
        default: inst = this.buildDog(item.state); break;
      }

      const id = item.id || String(idx);
      inst.id = id;
      inst.name = item.name;

      if (!this.fleetPositions.has(id)) {
        const offset = (idx - (toBuild.length - 1) / 2) * this.fleetSpacing;
        this.fleetPositions.set(id, { x: offset, z: 0 });
      }
      const p = this.fleetPositions.get(id)!;
      inst.group.position.x = p.x;
      inst.group.position.z = p.z;

      this.scene.add(inst.group);
      this.instances.push(inst);
    });

    const aliveIds = new Set(this.instances.map(i => i.id));
    Array.from(this.fleetPositions.keys()).forEach(k => {
      if (!aliveIds.has(k)) this.fleetPositions.delete(k);
    });

    this.updateSelectionRing();
  }

  public get fleetMapItems() {
    if (!this.fleetRobots) return [];
    const half = this.mapSize / 2;
    return this.fleetRobots.map((r, idx) => {
      const id = r.id || String(idx);
      const pos = this.fleetPositions.get(id) || { x: 0, z: 0 };
      const px = (pos.x / this.mapRange) * half + half;
      const py = (pos.z / this.mapRange) * half + half;
      return {
        id, idx,
        name: r.name || ('R' + (idx + 1)),
        type: r.type,
        px, py,
        selected: id === this.selectedFleetRobotId
      };
    });
  }

  public get selectedFleetRobotName(): string {
    const it = this.fleetMapItems.find(i => i.selected);
    return it ? it.name : '—';
  }

  public typeIcon(type: string): string {
    switch (type) {
      case 'dog': return '🐕';
      case 'tank': return '🚜';
      case 'omni3': return '🛸';
      case 'omni4': return '🚙';
      default: return '🤖';
    }
  }

  public onMapSelect(id: string) {
    this.selectFleetRobot.emit(id);
  }

  public onMapClick(e: MouseEvent) {
    const target = e.currentTarget as HTMLElement;
    const rect = target.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    const half = this.mapSize / 2;
    const x = ((px - half) / half) * this.mapRange;
    const z = ((py - half) / half) * this.mapRange;

    if (this.placingType) {
      this.addWaypoint(this.placingType, x, z);
      this.placingType = null;
      return;
    }

    const id = this.selectedFleetRobotId;
    if (!id) return;
    this.fleetTargets.set(id, { x, z });
    const { cmd, steps } = this.planMove(id, x, z);
    this.fleetRobotMove.emit({ id, cmd, steps });
  }

  private planMove(id: string, x: number, z: number): { cmd: string, steps: number } {
    const cur = this.fleetPositions.get(id) || { x: 0, z: 0 };
    const dx = x - cur.x;
    const dz = z - cur.z;
    const robot = this.fleetRobots?.find(r => r.id === id);
    const isOmni = robot?.type === 'omni3' || robot?.type === 'omni4';

    let cmd: string;
    let dist: number;
    if (isOmni && Math.abs(dx) > Math.abs(dz)) {
      cmd  = dx > 0 ? 'strafeRight' : 'strafeLeft';
      dist = Math.abs(dx);
    } else {
      cmd  = dz < 0 ? 'walk' : 'back';
      dist = Math.abs(dz);
    }

    let steps = Math.round(dist * this.STEPS_PER_UNIT);
    if (steps < this.STEPS_MIN) steps = this.STEPS_MIN;
    if (steps > this.STEPS_MAX) steps = this.STEPS_MAX;
    return { cmd, steps };
  }

  public startPlacing(type: 'base' | 'target') {
    this.placingType = (this.placingType === type) ? null : type;
  }

  private addWaypoint(type: 'base' | 'target', x: number, z: number) {
    const sameTypeCount = this.waypoints.filter(w => w.type === type).length + 1;
    const baseName = type === 'base' ? 'Üs' : 'Hedef';
    const name = sameTypeCount === 1 ? baseName : `${baseName} ${sameTypeCount}`;
    const id = 'wp_' + Date.now() + '_' + Math.floor(Math.random() * 1000);
    const wp = { id, name, type, x, z };
    this.waypoints.push(wp);
    this.addWaypointMesh(wp);
  }

  public removeWaypoint(id: string, e?: MouseEvent) {
    if (e) { e.preventDefault(); e.stopPropagation(); }
    this.waypoints = this.waypoints.filter(w => w.id !== id);
    const mesh = this.waypointMeshes.get(id);
    if (mesh) {
      this.scene.remove(mesh);
      mesh.traverse(o => {
        const m = o as any;
        if (m.geometry) m.geometry.dispose();
        if (m.material) {
          if (Array.isArray(m.material)) m.material.forEach((mm: any) => mm.dispose());
          else m.material.dispose();
        }
      });
      this.waypointMeshes.delete(id);
    }
  }

  public goToWaypoint(wp: {id: string, x: number, z: number}) {
    if (!this.fleetRobots) return;
    const targets = this.selectedFleetRobotId
      ? this.fleetRobots.filter(r => (r.id || '') === this.selectedFleetRobotId)
      : this.fleetRobots;

    targets.forEach((r, idx) => {
      const id = r.id;
      if (!id) return;

      const angle = (idx / Math.max(targets.length, 1)) * Math.PI * 2;
      const r0 = targets.length > 1 ? 0.5 : 0;
      const tx = wp.x + Math.cos(angle) * r0;
      const tz = wp.z + Math.sin(angle) * r0;
      this.fleetTargets.set(id, { x: tx, z: tz });
      const { cmd, steps } = this.planMove(id, tx, tz);
      this.fleetRobotMove.emit({ id, cmd, steps });
    });
  }

  public get waypointMapItems() {
    const half = this.mapSize / 2;
    return this.waypoints.map(w => ({
      ...w,
      px: (w.x / this.mapRange) * half + half,
      py: (w.z / this.mapRange) * half + half,
      icon: w.type === 'base' ? '🏠' : '🎯'
    }));
  }

  private addWaypointMesh(wp: { id: string, type: 'base' | 'target', x: number, z: number }) {
    if (!this.scene) return;
    const g = new THREE.Group();
    const color = wp.type === 'base' ? 0x10b981 : 0xef4444;

    const pole = new THREE.Mesh(
      new THREE.CylinderGeometry(0.025, 0.025, 0.55, 12),
      new THREE.MeshStandardMaterial({ color: 0xe5e7eb, metalness: 0.5, roughness: 0.4 })
    );
    pole.position.y = 0.275;
    pole.castShadow = true;
    g.add(pole);

    const bulb = new THREE.Mesh(
      new THREE.SphereGeometry(0.11, 20, 20),
      new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.7, metalness: 0.4, roughness: 0.3 })
    );
    bulb.position.y = 0.6;
    bulb.castShadow = true;
    g.add(bulb);

    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.28, 0.36, 48),
      new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide, transparent: true, opacity: 0.8 })
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.026;
    g.add(ring);

    const disc = new THREE.Mesh(
      new THREE.CircleGeometry(0.28, 48),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.15 })
    );
    disc.rotation.x = -Math.PI / 2;
    disc.position.y = 0.024;
    g.add(disc);

    g.position.set(wp.x, 0, wp.z);
    this.scene.add(g);
    this.waypointMeshes.set(wp.id, g);
  }

  public onMapMove(dir: 'up' | 'down' | 'left' | 'right') {
    const id = this.selectedFleetRobotId;
    if (!id) return;
    const cmdMap: Record<string, string> = { up: 'walk', down: 'back', left: 'left', right: 'right' };
    const step = 0.3;
    const p = this.fleetPositions.get(id) || { x: 0, z: 0 };
    if (dir === 'up') p.z -= step;
    if (dir === 'down') p.z += step;
    if (dir === 'left') p.x -= step;
    if (dir === 'right') p.x += step;
    const r = this.mapRange;
    p.x = Math.max(-r, Math.min(r, p.x));
    p.z = Math.max(-r, Math.min(r, p.z));
    this.fleetPositions.set(id, p);

    const inst = this.instances.find(i => i.id === id);
    if (inst) {
      inst.group.position.x = p.x;
      inst.group.position.z = p.z;
    }
    this.updateSelectionRing();
    this.fleetRobotMove.emit({ id, cmd: cmdMap[dir] });
  }

  private updateSelectionRing() {
    if (!this.scene) return;
    if (this.selectionRing) {
      this.scene.remove(this.selectionRing);
      this.selectionRing.geometry.dispose();
      (this.selectionRing.material as THREE.Material).dispose();
      this.selectionRing = null;
    }
    if (!this.fleetRobots || !this.selectedFleetRobotId) return;
    const inst = this.instances.find(i => i.id === this.selectedFleetRobotId);
    if (!inst) return;
    const geo = new THREE.RingGeometry(0.55, 0.7, 48);
    const mat = new THREE.MeshBasicMaterial({
      color: 0xfbbf24, side: THREE.DoubleSide, transparent: true, opacity: 0.9
    });
    this.selectionRing = new THREE.Mesh(geo, mat);
    this.selectionRing.rotation.x = -Math.PI / 2;
    this.selectionRing.position.set(inst.group.position.x, 0.03, inst.group.position.z);
    this.scene.add(this.selectionRing);
  }

  private buildDog(state: RobotState): TwinInstance {
    const inst: TwinInstance = { group: new THREE.Group(), mainBodyGrp: new THREE.Group(), legs: [], wheels: [], walkPhase: 0, sitLerp: 0, legAngles: [0,0,0,0], headTilt: 0, type: 'dog', state };
    inst.mainBodyGrp = new THREE.Group();

    const whiteMat = new THREE.MeshStandardMaterial({ color: 0xf8fafc, roughness: 0.4, metalness: 0.1 });
    const greenMat = new THREE.MeshStandardMaterial({ color: 0x84cc16, roughness: 0.4 });
    const blackMat = new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.8 });

    const BODY_W = 0.45;
    const BODY_H = 0.3;
    const BODY_L = 0.65;
    const BODY_Y = 0.5;

    const bodyGeo = new THREE.BoxGeometry(BODY_W, BODY_H, BODY_L);
    inst.body = new THREE.Mesh(bodyGeo, whiteMat);
    inst.body.position.y = BODY_Y;
    inst.body.castShadow = true;
    inst.group.add(inst.body);

    const faceGeo = new THREE.BoxGeometry(BODY_W * 0.8, BODY_H * 0.7, 0.02);
    const face = new THREE.Mesh(faceGeo, greenMat);
    face.position.set(0, 0, BODY_L / 2 + 0.01);
    inst.body.add(face);

    const eyeGeo = new THREE.CylinderGeometry(0.06, 0.06, 0.02, 16);
    inst.eyeL = new THREE.Mesh(eyeGeo, this.matEye.clone());
    inst.eyeL.rotation.x = Math.PI / 2;
    inst.eyeL.position.set(-0.1, 0, BODY_L / 2 + 0.02);
    inst.body.add(inst.eyeL);

    inst.eyeR = new THREE.Mesh(eyeGeo, this.matEye.clone());
    inst.eyeR.rotation.x = Math.PI / 2;
    inst.eyeR.position.set(0.1, 0, BODY_L / 2 + 0.02);
    inst.body.add(inst.eyeR);

    inst.headGrp = new THREE.Group();
    inst.tailGrp = new THREE.Group();
    inst.group.add(inst.headGrp);
    inst.group.add(inst.tailGrp);

    const LEG_L = 0.35;
    const LEG_W = 0.1;
    const LEG_D = 0.06;

    const legPositions = [
      { x: -BODY_W / 2 - 0.02, z:  BODY_L / 2 - 0.12 },
      { x:  BODY_W / 2 + 0.02, z:  BODY_L / 2 - 0.12 },
      { x: -BODY_W / 2 - 0.02, z: -BODY_L / 2 + 0.12 },
      { x:  BODY_W / 2 + 0.02, z: -BODY_L / 2 + 0.12 },
    ];

    inst.legs = [];
    for (let i = 0; i < 4; i++) {
      const pos = legPositions[i];
      const side = pos.x > 0 ? 1 : -1;

      const hip = new THREE.Group();
      hip.position.set(pos.x, BODY_Y, pos.z);

      const jointGeo = new THREE.CylinderGeometry(0.05, 0.05, 0.04, 16);
      const joint = new THREE.Mesh(jointGeo, blackMat);
      joint.rotation.z = Math.PI / 2;
      hip.add(joint);

      const legMesh = new THREE.Group();

      const legBox = new THREE.Mesh(new THREE.BoxGeometry(LEG_D, LEG_L, LEG_W), whiteMat);
      legBox.position.y = -LEG_L / 2;
      legBox.castShadow = true;
      legMesh.add(legBox);

      const topCap = new THREE.Mesh(new THREE.CylinderGeometry(LEG_W/2, LEG_W/2, LEG_D, 16), whiteMat);
      topCap.rotation.z = Math.PI/2;
      topCap.rotation.x = Math.PI/2;
      legMesh.add(topCap);

      const botCap = new THREE.Mesh(new THREE.CylinderGeometry(LEG_W/2, LEG_W/2, LEG_D, 16), whiteMat);
      botCap.rotation.z = Math.PI/2;
      botCap.rotation.x = Math.PI/2;
      botCap.position.y = -LEG_L;
      botCap.castShadow = true;
      legMesh.add(botCap);

      const stripeGeo = new THREE.BoxGeometry(0.01, LEG_L * 0.4, 0.02);
      const stripe = new THREE.Mesh(stripeGeo, greenMat);
      stripe.position.set(side * (LEG_D/2 + 0.005), -LEG_L * 0.6, 0);
      legMesh.add(stripe);

      legMesh.position.x = side * 0.03;

      hip.add(legMesh);

      const knee = new THREE.Group();
      hip.add(knee);

      inst.group.add(hip);
      inst.legs.push({ hip, knee });
    }

    return inst;
  }

  private buildTank(state: RobotState): TwinInstance {
    const inst: TwinInstance = { group: new THREE.Group(), mainBodyGrp: new THREE.Group(), legs: [], wheels: [], walkPhase: 0, sitLerp: 0, legAngles: [0,0,0,0], headTilt: 0, type: 'tank', state };

    inst.mainBodyGrp = new THREE.Group();
    inst.mainBodyGrp.position.y = 0.25;

    const whitePcbMat = new THREE.MeshStandardMaterial({ color: 0xf3f4f6, roughness: 0.8 });
    const grayPlasticMat = new THREE.MeshStandardMaterial({ color: 0x9ca3af, roughness: 0.6 });
    const blackRubberMat = new THREE.MeshStandardMaterial({ color: 0x1f2937, roughness: 0.9 });
    const bluePcbMat = new THREE.MeshStandardMaterial({ color: 0x1e3a8a, roughness: 0.7 });
    const redMat = new THREE.MeshStandardMaterial({ color: 0xef4444, roughness: 0.4 });
    const blackMat = new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.7 });

    const pcbGeo = new THREE.BoxGeometry(0.5, 0.04, 0.8);
    const pcb = new THREE.Mesh(pcbGeo, whitePcbMat);
    pcb.castShadow = true;
    inst.mainBodyGrp.add(pcb);

    const espGrp = new THREE.Group();
    espGrp.position.set(0, 0.05, 0.25);

    const espBase = new THREE.Mesh(new THREE.BoxGeometry(0.25, 0.03, 0.35), blackMat);
    espGrp.add(espBase);

    const espLens = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.06, 12), blackMat);
    espLens.rotation.x = Math.PI / 2;
    espLens.position.set(0, 0.06, 0.08);
    espGrp.add(espLens);

    inst.mainBodyGrp.add(espGrp);

    const driver = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.04, 0.25), bluePcbMat);
    driver.position.set(0, 0.04, -0.15);
    inst.mainBodyGrp.add(driver);

    const buzzer = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.1, 12), redMat);
    buzzer.position.set(0.12, 0.07, -0.3);
    inst.mainBodyGrp.add(buzzer);

    for (const side of [-1, 1]) {
      const sideFrameGrp = new THREE.Group();
      sideFrameGrp.position.x = side * 0.32;

      const frameGeo = new THREE.BoxGeometry(0.06, 0.12, 0.75);
      const frame = new THREE.Mesh(frameGeo, grayPlasticMat);
      frame.position.y = 0.02;
      sideFrameGrp.add(frame);

      const frameUp = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.15, 0.2), grayPlasticMat);
      frameUp.position.set(0, 0.12, -0.05);
      sideFrameGrp.add(frameUp);

      const wFrontGeo = new THREE.CylinderGeometry(0.12, 0.12, 0.08, 16);
      const wRearGeo = new THREE.CylinderGeometry(0.12, 0.12, 0.08, 16);
      const wTopGeo = new THREE.CylinderGeometry(0.08, 0.08, 0.08, 16);

      const wFront = new THREE.Mesh(wFrontGeo, grayPlasticMat);
      wFront.rotation.z = Math.PI / 2;
      wFront.position.set(side * 0.05, 0, 0.35);

      const wRear = new THREE.Mesh(wRearGeo, grayPlasticMat);
      wRear.rotation.z = Math.PI / 2;
      wRear.position.set(side * 0.05, 0, -0.35);

      const wTop = new THREE.Mesh(wTopGeo, grayPlasticMat);
      wTop.rotation.z = Math.PI / 2;
      wTop.position.set(side * 0.05, 0.22, -0.05);

      for(let w of [wFront, wRear, wTop]) {
         const r = w === wTop ? 0.08 : 0.12;
         for(let i=0; i<8; i++) {
            const notch = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.09, 0.02), grayPlasticMat);
            const angle = (i * Math.PI * 2) / 8;
            notch.position.set(Math.sin(angle)*r, 0, Math.cos(angle)*r);
            notch.rotation.y = angle;
            w.add(notch);
         }
         sideFrameGrp.add(w);
         inst.wheels.push(w);
      }

      const botSeg = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.015, 0.7, 8), blackRubberMat);
      botSeg.rotation.x = Math.PI/2;
      botSeg.position.set(side * 0.05, -0.13, 0);
      sideFrameGrp.add(botSeg);

      const backUpSeg = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.015, 0.42, 8), blackRubberMat);
      backUpSeg.position.set(side * 0.05, 0.16, -0.25);
      backUpSeg.rotation.x = -0.95;
      sideFrameGrp.add(backUpSeg);

      const frontUpSeg = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.015, 0.52, 8), blackRubberMat);
      frontUpSeg.position.set(side * 0.05, 0.16, 0.2);
      frontUpSeg.rotation.x = 1.05;
      sideFrameGrp.add(frontUpSeg);

      inst.mainBodyGrp.add(sideFrameGrp);
    }

    inst.group.add(inst.mainBodyGrp);

    return inst;
  }

  private buildOmni3(state: RobotState): TwinInstance {
    const inst: TwinInstance = { group: new THREE.Group(), mainBodyGrp: new THREE.Group(), legs: [], wheels: [], walkPhase: 0, sitLerp: 0, legAngles: [0,0,0,0], headTilt: 0, type: 'omni3', state };

    inst.mainBodyGrp = new THREE.Group();
    inst.mainBodyGrp.position.y = 0.25;

    const whiteMat = new THREE.MeshStandardMaterial({ color: 0xe5e7eb, roughness: 0.8, metalness: 0.1 });
    const blackMat = new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.8 });
    const pcbMat = new THREE.MeshStandardMaterial({ color: 0x1e3a8a, roughness: 0.7 });
    const batMat = new THREE.MeshStandardMaterial({ color: 0x60a5fa, roughness: 0.4 });
    const markerMat = new THREE.MeshBasicMaterial({ color: 0x050505 });
    const whiteMarkerMat = new THREE.MeshBasicMaterial({ color: 0xffffff });

    const plateGeo = new THREE.CylinderGeometry(0.6, 0.6, 0.04, 3);

    const plate1 = new THREE.Mesh(plateGeo, whiteMat);
    plate1.castShadow = true;
    plate1.receiveShadow = true;
    inst.mainBodyGrp.add(plate1);

    const plate2 = new THREE.Mesh(plateGeo, whiteMat);
    plate2.position.y = 0.25;
    plate2.castShadow = true;
    plate2.receiveShadow = true;
    inst.mainBodyGrp.add(plate2);

    const plate3 = new THREE.Mesh(plateGeo, whiteMat);
    plate3.position.y = 0.5;
    plate3.castShadow = true;
    plate3.receiveShadow = true;
    inst.mainBodyGrp.add(plate3);

    const standoffGeo = new THREE.CylinderGeometry(0.015, 0.015, 0.5, 8);
    for (let i = 0; i < 3; i++) {
      const angle = (i * Math.PI * 2) / 3;
      const sMesh = new THREE.Mesh(standoffGeo, this.matJoint);
      sMesh.position.set(Math.sin(angle) * 0.45, 0.25, Math.cos(angle) * 0.45);
      inst.mainBodyGrp.add(sMesh);
    }

    for (let i = 0; i < 3; i++) {
      const angle = (i * Math.PI * 2) / 3;
      const wheelGrp = new THREE.Group();
      wheelGrp.position.set(Math.sin(angle) * 0.55, -0.05, Math.cos(angle) * 0.55);
      wheelGrp.rotation.y = angle + Math.PI/2;

      const wheelAnimGrp = new THREE.Group();

      const hubGeo = new THREE.CylinderGeometry(0.06, 0.06, 0.08, 12);
      const hub = new THREE.Mesh(hubGeo, whiteMat);
      hub.rotation.z = Math.PI/2;
      wheelAnimGrp.add(hub);

      for (let j=0; j<8; j++) {
         const rollerGeo = new THREE.CylinderGeometry(0.025, 0.025, 0.09, 8);
         const roller = new THREE.Mesh(rollerGeo, blackMat);
         const rAngle = (j * Math.PI * 2) / 8;
         roller.position.set(0, Math.cos(rAngle)*0.1, Math.sin(rAngle)*0.1);
         roller.rotation.x = rAngle + Math.PI/2;
         wheelAnimGrp.add(roller);
      }

      wheelGrp.add(wheelAnimGrp);
      inst.mainBodyGrp.add(wheelGrp);
      inst.wheels.push(wheelAnimGrp);
    }

    const batGeo = new THREE.BoxGeometry(0.5, 0.15, 0.25);
    const bat = new THREE.Mesh(batGeo, batMat);
    bat.position.set(0, 0.1, 0);
    inst.mainBodyGrp.add(bat);

    const pcb1 = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.02, 0.25), pcbMat);
    pcb1.position.set(-0.2, 0.28, 0.1);
    inst.mainBodyGrp.add(pcb1);

    const pcb2 = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.02, 0.15), pcbMat);
    pcb2.position.set(0.15, 0.28, -0.2);
    inst.mainBodyGrp.add(pcb2);

    const markerGrp = new THREE.Group();
    markerGrp.position.set(0, 0.521, -0.1);
    markerGrp.rotation.x = -Math.PI / 2;

    const mBase = new THREE.Mesh(new THREE.PlaneGeometry(0.35, 0.35), markerMat);
    markerGrp.add(mBase);

    const mWhite1 = new THREE.Mesh(new THREE.PlaneGeometry(0.12, 0.12), whiteMarkerMat);
    mWhite1.position.set(-0.06, 0.06, 0.001);
    markerGrp.add(mWhite1);

    const mWhite2 = new THREE.Mesh(new THREE.PlaneGeometry(0.08, 0.08), whiteMarkerMat);
    mWhite2.position.set(0.08, -0.08, 0.001);
    markerGrp.add(mWhite2);

    const mWhite3 = new THREE.Mesh(new THREE.PlaneGeometry(0.06, 0.06), whiteMarkerMat);
    mWhite3.position.set(-0.08, -0.08, 0.001);
    markerGrp.add(mWhite3);

    inst.mainBodyGrp.add(markerGrp);

    const camGrp = new THREE.Group();
    camGrp.position.set(0, 0.52, 0.45);

    const mountGeo = new THREE.BoxGeometry(0.15, 0.15, 0.05);
    const mount = new THREE.Mesh(mountGeo, whiteMat);
    mount.position.set(0, 0.075, 0);
    camGrp.add(mount);

    const camPcb = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.14, 0.02), blackMat);
    camPcb.position.set(0, 0.1, 0.03);
    camPcb.rotation.x = -0.2;
    camGrp.add(camPcb);

    const lens = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.04, 12), new THREE.MeshStandardMaterial({color: 0x333333, metalness: 0.8}));
    lens.rotation.x = Math.PI/2;
    lens.position.set(0, 0.1, 0.05);
    camGrp.add(lens);

    inst.mainBodyGrp.add(camGrp);

    inst.group.add(inst.mainBodyGrp);

    return inst;
  }

  private buildOmni4(state: RobotState): TwinInstance {
    const inst: TwinInstance = { group: new THREE.Group(), mainBodyGrp: new THREE.Group(), legs: [], wheels: [], walkPhase: 0, sitLerp: 0, legAngles: [0,0,0,0], headTilt: 0, type: 'omni4', state };

    inst.mainBodyGrp = new THREE.Group();
    inst.mainBodyGrp.position.y = 0.25;

    const yellowMat = new THREE.MeshStandardMaterial({ color: 0xfacc15, roughness: 0.5, metalness: 0.3 });
    const blackMat = new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.8 });
    const grayMat = new THREE.MeshStandardMaterial({ color: 0x6b7280, roughness: 0.6 });
    const redMat = new THREE.MeshStandardMaterial({ color: 0xef4444, roughness: 0.4 });
    const silverMat = new THREE.MeshStandardMaterial({ color: 0x9ca3af, roughness: 0.4, metalness: 0.8 });

    const plateGeo = new THREE.BoxGeometry(0.9, 0.04, 0.9);
    const plate = new THREE.Mesh(plateGeo, yellowMat);
    plate.position.y = 0.2;
    plate.castShadow = true;
    plate.receiveShadow = true;
    inst.mainBodyGrp.add(plate);

    const boltGeo = new THREE.CylinderGeometry(0.015, 0.015, 0.05, 8);
    const boltPos = [-0.35, 0.35];
    for(let x of boltPos) {
      for(let z of boltPos) {

        const b1 = new THREE.Mesh(boltGeo, silverMat);
        b1.position.set(x + (x<0?0.05:-0.05), 0.21, z);
        inst.mainBodyGrp.add(b1);

        const b2 = new THREE.Mesh(boltGeo, silverMat);
        b2.position.set(x, 0.21, z + (z<0?0.05:-0.05));
        inst.mainBodyGrp.add(b2);
      }
    }

    const sidePanelGeo = new THREE.BoxGeometry(0.2, 0.15, 0.04);
    const sidePanel = new THREE.Mesh(sidePanelGeo, yellowMat);
    sidePanel.position.set(0, 0.1, 0.43);
    inst.mainBodyGrp.add(sidePanel);

    const switchGeo = new THREE.CylinderGeometry(0.03, 0.03, 0.02, 16);
    const switchMesh = new THREE.Mesh(switchGeo, redMat);
    switchMesh.rotation.x = Math.PI / 2;
    switchMesh.position.set(-0.04, 0.1, 0.46);
    inst.mainBodyGrp.add(switchMesh);

    const connGeo = new THREE.CylinderGeometry(0.02, 0.02, 0.02, 16);
    const connMesh = new THREE.Mesh(connGeo, silverMat);
    connMesh.rotation.x = Math.PI / 2;
    connMesh.position.set(0.04, 0.1, 0.46);
    inst.mainBodyGrp.add(connMesh);

    const wheelPositions = [
      { x: -0.45, z:  0.45, angle: -Math.PI/4 },
      { x:  0.45, z:  0.45, angle: Math.PI/4 },
      { x: -0.45, z: -0.45, angle: -Math.PI*3/4 },
      { x:  0.45, z: -0.45, angle: Math.PI*3/4 }
    ];

    for (let i = 0; i < 4; i++) {
      const pos = wheelPositions[i];

      const motorGeo = new THREE.CylinderGeometry(0.04, 0.04, 0.15, 12);
      const motor = new THREE.Mesh(motorGeo, blackMat);
      motor.position.set(pos.x * 0.75, 0.12, pos.z * 0.75);
      motor.rotation.y = pos.angle + Math.PI/2;
      motor.rotation.z = Math.PI/2;
      inst.mainBodyGrp.add(motor);

      const wheelGrp = new THREE.Group();
      wheelGrp.position.set(pos.x, 0.12, pos.z);

      wheelGrp.rotation.y = pos.angle;

      const wheelAnimGrp = new THREE.Group();

      const hubGeo = new THREE.CylinderGeometry(0.07, 0.07, 0.06, 12);
      const hub = new THREE.Mesh(hubGeo, grayMat);
      hub.rotation.z = Math.PI/2;
      wheelAnimGrp.add(hub);

      const screwGeo = new THREE.CylinderGeometry(0.015, 0.015, 0.08, 8);
      const screw = new THREE.Mesh(screwGeo, silverMat);
      screw.rotation.z = Math.PI/2;
      wheelAnimGrp.add(screw);

      for (let j = 0; j < 8; j++) {
         const rollerGeo = new THREE.CylinderGeometry(0.025, 0.025, 0.07, 8);
         const roller = new THREE.Mesh(rollerGeo, blackMat);
         const rAngle = (j * Math.PI * 2) / 8;
         roller.position.set(0, Math.cos(rAngle)*0.11, Math.sin(rAngle)*0.11);
         roller.rotation.x = rAngle + Math.PI/2;
         wheelAnimGrp.add(roller);
      }

      wheelGrp.add(wheelAnimGrp);
      inst.mainBodyGrp.add(wheelGrp);
      inst.wheels.push(wheelAnimGrp);
    }

    inst.group.add(inst.mainBodyGrp);

    return inst;
  }

  private buildEnvironment() {
    const R = 8;

    const platGeo = new THREE.CylinderGeometry(R, R, 0.04, 96);
    const platMat = new THREE.MeshStandardMaterial({
      color: 0x3b4266, metalness: 0.4, roughness: 0.6
    });
    const platform = new THREE.Mesh(platGeo, platMat);
    platform.position.y = -0.02;
    platform.receiveShadow = true;
    this.scene.add(platform);

    const ringGeo = new THREE.RingGeometry(R - 0.04, R + 0.04, 128);
    const ringMat = new THREE.MeshBasicMaterial({
      color: 0x6366f1, side: THREE.DoubleSide, transparent: true, opacity: 0.7
    });
    const neonRing = new THREE.Mesh(ringGeo, ringMat);
    neonRing.rotation.x = -Math.PI / 2;
    neonRing.position.y = 0.01;
    this.scene.add(neonRing);

    for (const r of [1.2, 2.5, 4.5]) {
      const innerRing = new THREE.Mesh(
        new THREE.RingGeometry(r, r + 0.03, 96),
        new THREE.MeshBasicMaterial({
          color: 0xa855f7, side: THREE.DoubleSide, transparent: true, opacity: 0.35
        })
      );
      innerRing.rotation.x = -Math.PI / 2;
      innerRing.position.y = 0.012;
      this.scene.add(innerRing);
    }

    const gridHelper = new THREE.GridHelper(R * 2, 40, 0x818cf8, 0x4f46e5);
    gridHelper.position.y = 0.015;
    (gridHelper.material as THREE.Material).transparent = true;
    (gridHelper.material as THREE.Material).opacity = 0.55;
    this.scene.add(gridHelper);

    for (let i = 0; i < 8; i++) {
      const angle = (i / 8) * Math.PI * 2;
      const marker = new THREE.Mesh(
        new THREE.BoxGeometry(0.1, 0.01, 0.1),
        this.matAccent
      );
      marker.position.set(Math.cos(angle) * (R - 0.4), 0.025, Math.sin(angle) * (R - 0.4));
      this.scene.add(marker);
    }
  }

  private animate() {
    this.frameId = requestAnimationFrame(() => this.animate());
    const dt = this.clock.getDelta();
    const t = this.clock.getElapsedTime();

    this.controls.update();

    for (const inst of this.instances) {
      if (!inst.state) continue;

      this.updateEmotionColor(inst);

      if (inst.id) {
        const t = this.fleetTargets.get(inst.id);
        if (t) {
          const cur = this.fleetPositions.get(inst.id) || { x: inst.group.position.x, z: inst.group.position.z };
          const dx = t.x - cur.x;
          const dz = t.z - cur.z;
          const dist = Math.hypot(dx, dz);
          const bubble = this.robotBubble;
          const minSep = bubble * 2;

          if (dist > 0.05) {

            let vx = dx / dist;
            let vz = dz / dist;
            let nearestNx = 0, nearestNz = 0, nearestD = Infinity;

            for (const other of this.instances) {
              if (other === inst || !other.id) continue;
              const ddx = cur.x - other.group.position.x;
              const ddz = cur.z - other.group.position.z;
              const d = Math.hypot(ddx, ddz);
              const lookAhead = minSep + 0.4;
              if (d < lookAhead) {
                const nx = d > 0.001 ? ddx / d : 1;
                const nz = d > 0.001 ? ddz / d : 0;
                if (d < nearestD) { nearestD = d; nearestNx = nx; nearestNz = nz; }

                const dot = vx * nx + vz * nz;
                if (dot < 0) { vx -= dot * nx; vz -= dot * nz; }

                if (d < minSep) {
                  const pushOut = minSep - d;
                  cur.x += nx * pushOut;
                  cur.z += nz * pushOut;
                }
              }
            }

            let vlen = Math.hypot(vx, vz);
            if (vlen < 0.05 && nearestD < Infinity) {
              vx = -nearestNz;
              vz = nearestNx;
              vlen = 1;
            }

            if (vlen > 0.01) {
              const speed = 1.2;
              const stepMag = Math.min(speed * dt, dist);
              cur.x += (vx / vlen) * stepMag;
              cur.z += (vz / vlen) * stepMag;
              inst.group.position.x = cur.x;
              inst.group.position.z = cur.z;
              inst.group.rotation.y = Math.atan2(vx, vz);
              this.fleetPositions.set(inst.id, cur);
              inst.state.walking = true;
            }
          } else {
            this.fleetPositions.set(inst.id, cur);
            this.fleetTargets.delete(inst.id);
            inst.state.walking = false;
          }
        }
      }

      if (this.selectionRing && inst.id === this.selectedFleetRobotId) {
        this.selectionRing.position.x = inst.group.position.x;
        this.selectionRing.position.z = inst.group.position.z;
      }

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
