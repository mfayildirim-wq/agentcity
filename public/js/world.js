// Szene: ein Diorama-Raum pro Projekt, Stationen je Werkzeugart, Figuren laufen dorthin.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { Avatar } from './avatar.js';
import { STATIONS, agentColor } from './config.js';

const ROOM_W = 16;
const ROOM_D = 12;
const ROOM_GAP = 5;
const DOOR = new THREE.Vector3(0, 0, ROOM_D / 2 - 0.4);

const mat = (color, extra = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.8, metalness: 0.02, ...extra });
const M = {
  floor: mat('#e7e1d7'),
  floorEdge: mat('#c9c0b2'),
  wall: mat('#d9dee6'),
  wallTop: mat('#f2f4f7'),
  wood: mat('#b88a5e'),
  woodDark: mat('#8a6443'),
  metal: mat('#3a3f4b', { roughness: 0.45, metalness: 0.35 }),
  screen: mat('#11151c', { roughness: 0.3 }),
  fabric: mat('#7d8aa0'),
  fabricDark: mat('#5f6b80'),
  plant: mat('#5c9a63'),
  pot: mat('#e9e4dc'),
  white: mat('#f7f7f5'),
  tile: new THREE.LineBasicMaterial({ color: '#d5cdc0', transparent: true, opacity: 0.55 }),
};

function box(w, h, d, material, x = 0, y = 0, z = 0) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
  m.position.set(x, y + h / 2, z);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}
function cyl(rt, rb, h, material, x = 0, y = 0, z = 0, seg = 24) {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, seg), material);
  m.position.set(x, y + h / 2, z);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

// ---------------------------------------------------------------- Möbel
function screenMat(color) {
  return new THREE.MeshStandardMaterial({ color: '#0e1218', emissive: color, emissiveIntensity: 0.55, roughness: 0.35 });
}

function monitor(color, x, z, rotY = 0) {
  const g = new THREE.Group();
  g.add(box(0.12, 0.28, 0.12, M.metal, 0, 0, 0));
  const frame = box(1.05, 0.62, 0.06, M.metal, 0, 0.28, 0);
  g.add(frame);
  const s = new THREE.Mesh(new THREE.PlaneGeometry(0.95, 0.52), screenMat(color));
  s.position.set(0, 0.59, 0.035);
  g.add(s);
  g.position.set(x, 0.78, z);
  g.rotation.y = rotY;
  g.userData.screen = s;
  return g;
}

function desk(w, d, x, z) {
  const g = new THREE.Group();
  g.add(box(w, 0.06, d, M.wood, 0, 0.72, 0));
  for (const sx of [-1, 1]) g.add(box(0.06, 0.72, d - 0.1, M.woodDark, sx * (w / 2 - 0.08), 0, 0));
  g.position.set(x, 0, z);
  return g;
}

function plant(x, z, s = 1) {
  const g = new THREE.Group();
  g.add(cyl(0.22, 0.17, 0.38, M.pot, 0, 0, 0));
  const leaves = new THREE.Mesh(new THREE.IcosahedronGeometry(0.42, 0), M.plant);
  leaves.position.y = 0.78;
  leaves.scale.set(1, 1.25, 1);
  leaves.castShadow = true;
  g.add(leaves);
  g.position.set(x, 0, z);
  g.scale.setScalar(s);
  return g;
}

function bookshelf(x, z, w = 2.2) {
  const g = new THREE.Group();
  g.add(box(w, 2.1, 0.45, M.woodDark, 0, 0, 0));
  const palette = ['#c0603f', '#3f6fb0', '#d9a62e', '#4d8f6b', '#8b5fa8', '#e7e1d7', '#2f3a4d'];
  for (let shelf = 0; shelf < 4; shelf++) {
    const y = 0.12 + shelf * 0.5;
    g.add(box(w - 0.12, 0.04, 0.4, M.wood, 0, y, 0.03));
    let bx = -w / 2 + 0.14;
    let i = shelf * 3;
    while (bx < w / 2 - 0.2) {
      const bw = 0.07 + ((i * 37) % 5) * 0.015;
      const bh = 0.3 + ((i * 53) % 4) * 0.035;
      const b = box(bw, bh, 0.3, mat(palette[i % palette.length]), bx + bw / 2, y + 0.04, 0.06);
      b.rotation.z = (i % 9 === 0) ? 0.18 : 0;
      g.add(b);
      bx += bw + 0.012;
      i++;
    }
  }
  g.position.set(x, 0, z);
  return g;
}

function sofa(x, z, rotY = 0) {
  const g = new THREE.Group();
  g.add(box(2.6, 0.38, 0.95, M.fabric, 0, 0.06, 0));
  g.add(box(2.6, 0.55, 0.25, M.fabric, 0, 0.42, -0.36));
  for (const sx of [-1, 1]) g.add(box(0.22, 0.6, 0.95, M.fabric, sx * 1.3, 0.06, 0));
  for (const sx of [-0.62, 0.62]) g.add(box(1.15, 0.1, 0.7, M.fabricDark, sx, 0.44, 0.08));
  g.position.set(x, 0, z);
  g.rotation.y = rotY;
  return g;
}

function rug(x, z, w, d, color) {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, d), mat(color, { roughness: 1 }));
  m.rotation.x = -Math.PI / 2;
  m.position.set(x, 0.006, z);
  m.receiveShadow = true;
  return m;
}

function stationPad(x, z, w, d, color) {
  const g = new THREE.Group();
  const shape = new THREE.Shape();
  const r = 0.35, hw = w / 2, hd = d / 2;
  shape.moveTo(-hw + r, -hd);
  shape.lineTo(hw - r, -hd); shape.quadraticCurveTo(hw, -hd, hw, -hd + r);
  shape.lineTo(hw, hd - r); shape.quadraticCurveTo(hw, hd, hw - r, hd);
  shape.lineTo(-hw + r, hd); shape.quadraticCurveTo(-hw, hd, -hw, hd - r);
  shape.lineTo(-hw, -hd + r); shape.quadraticCurveTo(-hw, -hd, -hw + r, -hd);
  const fill = new THREE.Mesh(new THREE.ShapeGeometry(shape), new THREE.MeshStandardMaterial({ color, transparent: true, opacity: 0.1, roughness: 1, depthWrite: false }));
  fill.rotation.x = -Math.PI / 2;
  fill.position.y = 0.004;
  fill.receiveShadow = true;
  const edge = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(shape.getPoints(8).map((p) => new THREE.Vector3(p.x, 0, -p.y))), new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.45 }));
  edge.position.y = 0.008;
  g.add(fill, edge);
  g.position.set(x, 0, z);
  g.userData.fill = fill;
  return g;
}

// ---------------------------------------------------------------- Raum
class Room {
  constructor(name, world) {
    this.name = name;
    this.world = world;
    this.group = new THREE.Group();
    this.animated = [];
    this.stations = {};
    this.build();
    this.buildLabel();
  }

  build() {
    const g = this.group;
    const hw = ROOM_W / 2, hd = ROOM_D / 2;

    // Boden als Sockel mit Kante
    const base = box(ROOM_W + 0.5, 0.45, ROOM_D + 0.5, M.floorEdge, 0, -0.45, 0);
    base.castShadow = false;
    g.add(base);
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(ROOM_W, ROOM_D), M.floor);
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    g.add(floor);
    const pts = [];
    for (let x = -hw + 1; x < hw; x += 1) pts.push(new THREE.Vector3(x, 0.003, -hd), new THREE.Vector3(x, 0.003, hd));
    for (let z = -hd + 1; z < hd; z += 1) pts.push(new THREE.Vector3(-hw, 0.003, z), new THREE.Vector3(hw, 0.003, z));
    g.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(pts), M.tile));

    // Rück- und Seitenwand (Diorama)
    g.add(box(ROOM_W + 0.5, 2.6, 0.25, M.wall, 0, 0, -hd - 0.125));
    g.add(box(0.25, 2.6, ROOM_D + 0.25, M.wall, -hw - 0.125, 0, -0.125 + 0.125));
    g.add(box(ROOM_W + 0.5, 0.08, 0.3, M.wallTop, 0, 2.6, -hd - 0.125));
    g.add(box(0.3, 0.08, ROOM_D + 0.25, M.wallTop, -hw - 0.125, 2.6, 0));
    // Fensterstreifen an der Rückwand
    for (const wx of [-4.2, 4.2]) {
      const win = new THREE.Mesh(new THREE.PlaneGeometry(2.6, 1), new THREE.MeshStandardMaterial({ color: '#cfe3f5', emissive: '#9cc6ea', emissiveIntensity: 0.35, roughness: 0.2 }));
      win.position.set(wx, 1.65, -hd + 0.005);
      g.add(win);
    }

    // Stationen ------------------------------------------------------------
    // Terminal (hinten links)
    const term = new THREE.Group();
    term.add(desk(2.6, 0.9, 0, 0));
    const m1 = monitor(STATIONS.terminal.color, -0.6, -0.15);
    const m2 = monitor(STATIONS.terminal.color, 0.6, -0.15);
    term.add(m1, m2);
    term.position.set(-5, 0, -4.6);
    g.add(term);
    this.addStation('terminal', -5, -4.4, 3.6, 3.0, [[-0.6, 0.75], [0.6, 0.75], [-1.7, 0.95], [1.7, 0.95]], Math.PI, [m1.userData.screen, m2.userData.screen]);

    // Werkbank (hinten Mitte)
    const wb = new THREE.Group();
    wb.add(desk(3.6, 0.95, 0, 0));
    const w1 = monitor(STATIONS.workbench.color, -1.05, -0.15);
    const w2 = monitor(STATIONS.workbench.color, 0, -0.15);
    const w3 = monitor(STATIONS.workbench.color, 1.05, -0.15);
    wb.add(w1, w2, w3);
    wb.position.set(0.6, 0, -4.6);
    g.add(wb);
    this.addStation('workbench', 0.6, -4.4, 4.6, 3.0, [[-1.05, 0.75], [0, 0.75], [1.05, 0.75], [-2.2, 0.95], [2.2, 0.95]], Math.PI, [w1.userData.screen, w2.userData.screen, w3.userData.screen]);

    // Bibliothek (rechts hinten)
    g.add(bookshelf(4.75, -5.55, 1.9));
    g.add(bookshelf(6.75, -5.55, 1.9));
    g.add(rug(5.75, -3.9, 3.4, 2.2, '#e3d2b4'));
    this.addStation('library', 5.75, -3.9, 4.0, 3.0, [[-1.0, -0.6], [1.0, -0.6], [0, -0.6], [-1.1, 0.7], [1.1, 0.7]], null);

    // Web-Portal (rechts vorne)
    const portal = new THREE.Group();
    portal.add(cyl(0.95, 1.05, 0.14, M.metal, 0, 0, 0, 40));
    const ringMat = new THREE.MeshStandardMaterial({ color: STATIONS.portal.color, emissive: STATIONS.portal.color, emissiveIntensity: 0.9, roughness: 0.3 });
    const torus = new THREE.Mesh(new THREE.TorusGeometry(0.8, 0.06, 12, 64), ringMat);
    torus.position.y = 1.25;
    torus.castShadow = true;
    const torus2 = new THREE.Mesh(new THREE.TorusGeometry(0.55, 0.035, 10, 48), ringMat);
    torus2.position.y = 1.25;
    const globe = new THREE.Mesh(new THREE.IcosahedronGeometry(0.32, 1), new THREE.MeshStandardMaterial({ color: '#bfeaf2', emissive: STATIONS.portal.color, emissiveIntensity: 0.35, roughness: 0.4, flatShading: true }));
    globe.position.y = 1.25;
    portal.add(torus, torus2, globe);
    portal.position.set(5.4, 0, 2.6);
    g.add(portal);
    this.animated.push((t, act) => {
      const k = 0.4 + act * 1.6;
      torus.rotation.y = t * 0.6 * k; torus.rotation.x = Math.sin(t * 0.4) * 0.3;
      torus2.rotation.x = t * 0.9 * k; globe.rotation.y = -t * 0.5 * k;
      ringMat.emissiveIntensity = 0.5 + act * 0.7 + Math.sin(t * 3) * 0.1;
    });
    this.addStation('portal', 5.4, 2.6, 3.6, 3.4, [[-1.3, 0.4], [0, 1.4], [1.3, 0.4], [-1.0, -1.1], [1.0, -1.1]], 'center');

    // Besprechungstisch (Mitte) – hier entstehen Subagenten
    const meet = new THREE.Group();
    meet.add(cyl(1.15, 1.15, 0.06, M.white, 0, 0.72, 0, 48));
    meet.add(cyl(0.12, 0.3, 0.72, M.metal, 0, 0, 0, 16));
    meet.position.set(-0.6, 0, 1.2);
    g.add(meet);
    this.meetingCenter = new THREE.Vector3(-0.6, 0, 1.2);
    const seats = [];
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2 + Math.PI / 8;
      seats.push([Math.sin(a) * 1.7, Math.cos(a) * 1.7]);
    }
    this.addStation('meeting', -0.6, 1.2, 4.4, 4.4, seats, 'center');

    // Lounge (vorne links)
    g.add(rug(-5.2, 3.3, 4, 2.6, '#cdd5e1'));
    g.add(sofa(-5.2, 3.9, 0));
    g.add(box(1.2, 0.36, 0.6, M.wood, -5.2, 0, 5.05));
    g.add(plant(-7.3, 4.9, 1.1));
    g.add(plant(7.3, -5.4 + 9.8, 0.9));
    g.add(plant(-7.3, -5.4, 0.9));
    this.addStation('lounge', -5.2, 3.4, 4.4, 3.0, [[-0.62, 0.45], [0.62, 0.45], [-1.7, -0.6], [1.7, -0.6], [0, -1.6]], 0);
    this.loungeSeats = 2;

    // Spawnpunkt am Eingang
    const mat2 = new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.5 });
    const door = new THREE.Mesh(new THREE.PlaneGeometry(2.2, 0.5), mat2);
    door.rotation.x = -Math.PI / 2;
    door.position.set(0, 0.005, hd - 0.25);
    g.add(door);

    // Hindernisse für einfache Wegplanung (Kreis, lokal)
    this.obstacles = [
      { x: -0.6, z: 1.2, r: 1.45 },
      { x: 5.4, z: 2.6, r: 1.1 },
      { x: -5.2, z: 5.05, r: 0.7 },
      { x: -5.2, z: 3.9, r: 1.0 },
    ];
  }

  addStation(id, x, z, w, d, slots, facing, screens = []) {
    const pad = stationPad(x, z, w, d, STATIONS[id].color);
    this.group.add(pad);
    const c = new THREE.Vector3(x, 0, z);
    this.stations[id] = {
      id,
      center: c,
      pad,
      screens,
      slots: slots.map(([sx, sz]) => {
        const p = new THREE.Vector3(x + sx, 0, z + sz);
        let f = facing;
        if (facing === 'center') f = Math.atan2(c.x - p.x, c.z - p.z);
        else if (facing == null) f = Math.atan2(sx > 0 ? 0.6 : -0.2, sz < 0 ? -1 : 0.4);
        return { pos: p, facing: f };
      }),
      activity: 0,
    };
    // Bibliothek: Blick zum Regal
    if (id === 'library') {
      const s = this.stations[id].slots;
      s[0].facing = Math.PI; s[1].facing = Math.PI; s[2].facing = Math.PI; s[3].facing = 0.4; s[4].facing = -0.4;
    }
  }

  buildLabel() {
    const el = document.createElement('div');
    el.className = 'room-label';
    el.innerHTML = `<span class="room-dot"></span><span class="room-name"></span><span class="room-count"></span>`;
    el.querySelector('.room-name').textContent = this.name;
    this.countEl = el.querySelector('.room-count');
    this.labelEl = el;
    const lbl = new CSS2DObject(el);
    lbl.position.set(-ROOM_W / 2 + 0.2, 0, ROOM_D / 2 + 0.7);
    lbl.center.set(0, 0.5);
    this.group.add(lbl);
    this.label = lbl;
  }

  tick(t, dt) {
    const drag = this.world.dragging;
    for (const st of Object.values(this.stations)) {
      st.activity += ((st.busy ? 1 : 0) - st.activity) * Math.min(1, dt * 3);
      // beim Ziehen einer Figur leuchtet das Meeting-Pad als Ablageziel
      const hint = drag && st.id === 'meeting' ? (drag.room === this ? 0.34 : 0.16 + Math.sin(t * 5) * 0.05) : 0;
      st.pad.userData.fill.material.opacity = 0.08 + st.activity * 0.16 + hint;
      st.screens.forEach((s, i) => {
        s.material.emissiveIntensity = 0.15 + st.activity * (0.65 + Math.sin(t * 6 + i * 1.7) * 0.12);
      });
    }
    for (const fn of this.animated) fn(t, this.stations.portal.activity);
  }

  dispose() {
    this.labelEl.remove();
    this.group.removeFromParent();
  }
}

// ---------------------------------------------------------------- Welt
export class World {
  // dragInfo(key) → { name, color } für ziehbare Figuren (steuerbare Hauptagenten) oder null;
  // onDropMeeting(key) – Figur auf ein Meeting-Pad fallen gelassen
  constructor(container, labelContainer, { onSelect, onHover, dragInfo = null, onDropMeeting = null } = {}) {
    this.container = container;
    this.onSelect = onSelect;
    this.onHover = onHover;
    this.dragInfo = dragInfo;
    this.onDropMeeting = onDropMeeting;
    this.meetingIds = new Set(); // Teilnehmer offener Besprechungen: bleiben am Tisch
    this.drag = null;
    this.dragging = null; // { key, room } während des Ziehens
    this.rooms = new Map();
    this.avatars = new Map();
    this.links = new Map();
    this.selected = null;
    this.labelsVisible = true;
    this.clock = new THREE.Clock();
    this.focus = null;

    const r = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    r.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    r.setSize(container.clientWidth, container.clientHeight);
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFSoftShadowMap;
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = 1.0;
    r.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(r.domElement);
    this.renderer = r;

    const lr = new CSS2DRenderer({ element: labelContainer });
    lr.setSize(container.clientWidth, container.clientHeight);
    this.labelRenderer = lr;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#161a21');
    scene.fog = new THREE.Fog('#161a21', 70, 150);
    const pmrem = new THREE.PMREMGenerator(r);
    scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environmentIntensity = 0.35;
    this.scene = scene;

    const cam = new THREE.PerspectiveCamera(30, container.clientWidth / container.clientHeight, 0.5, 400);
    this.camera = cam;

    const controls = new OrbitControls(cam, r.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.maxPolarAngle = Math.PI * 0.42;
    controls.minPolarAngle = Math.PI * 0.12;
    controls.minDistance = 8;
    controls.maxDistance = 140;
    controls.screenSpacePanning = false;
    controls.addEventListener('start', () => { this.focus = null; });
    this.controls = controls;

    scene.add(new THREE.HemisphereLight('#e9eefc', '#3b3f48', 1.1));
    const sun = new THREE.DirectionalLight('#fff3e3', 2.4);
    sun.castShadow = true;
    sun.shadow.mapSize.set(4096, 4096);
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.03;
    sun.shadow.radius = 4;
    scene.add(sun, sun.target);
    this.sun = sun;

    // Großer Untergrund
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(600, 600), new THREE.MeshStandardMaterial({ color: '#1c2129', roughness: 1 }));
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.46;
    ground.receiveShadow = true;
    scene.add(ground);
    const grid = new THREE.GridHelper(600, 150, '#252b35', '#20252e');
    grid.position.y = -0.455;
    scene.add(grid);

    this.linkGroup = new THREE.Group();
    scene.add(this.linkGroup);

    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();
    this.bindEvents();
    this.layoutRooms();
    this.resetView(true);
    this.loop = this.loop.bind(this);
    r.setAnimationLoop(this.loop);
  }

  // Bildmitte in den freien Bereich neben der Seitenleiste verschieben
  setInset(px) {
    this.inset = px;
    this.applySize();
  }

  applySize() {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    this.camera.aspect = w / h;
    if (this.inset) this.camera.setViewOffset(w, h, this.inset / 2, 0, w, h);
    else this.camera.clearViewOffset();
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this.labelRenderer.setSize(w, h);
  }

  bindEvents() {
    window.addEventListener('resize', () => this.applySize());
    const el = this.renderer.domElement;
    let down = null;
    el.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY }; });
    el.addEventListener('pointerup', (e) => {
      if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5 || this.dragDone) { this.dragDone = false; return; }
      const key = this.pick(e);
      this.onSelect?.(key);
    });
    // Drag & Drop einer Figur (Capture-Phase am Container: vor OrbitControls, die während des Ziehens ruhen)
    this.container.addEventListener('pointerdown', (e) => this.dragStart(e), true);
    window.addEventListener('pointermove', (e) => this.dragMove(e));
    window.addEventListener('pointerup', (e) => this.dragEnd(e, false));
    window.addEventListener('pointercancel', (e) => this.dragEnd(e, true));
    // Esc bricht das Ziehen ab (Capture-Phase, damit Esc nicht zusätzlich die Auswahl aufhebt)
    window.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || !this.drag) return;
      e.stopImmediatePropagation();
      e.preventDefault();
      this.dragEnd({}, true);
    }, true);
    // Fensterwechsel während des Ziehens: abbrechen, Kamera wieder freigeben
    window.addEventListener('blur', () => { if (this.drag) this.dragEnd({}, true); });
    el.addEventListener('pointermove', (e) => {
      if (this.dragging) return;
      const key = this.pick(e);
      if (key !== this.hoverKey) {
        if (this.hoverKey && this.avatars.get(this.hoverKey)) this.avatars.get(this.hoverKey).hovered = false;
        this.hoverKey = key;
        if (key) this.avatars.get(key).hovered = true;
        el.style.cursor = key ? 'pointer' : '';
        this.onHover?.(key);
      }
    });
  }

  dragStart(e) {
    this.dragDone = false;
    if (e.button !== 0 || !this.dragInfo || this.drag) return;
    const key = this.pick(e);
    const info = key && this.dragInfo(key);
    if (!info) return;
    this.drag = { key, info, x: e.clientX, y: e.clientY, pointerId: e.pointerId };
    this.controls.enabled = false; // kein Drehen, solange eine Figur gegriffen ist
    // Zeiger festhalten: Loslassen außerhalb des Canvas (über Panels) kommt trotzdem an
    try { this.renderer.domElement.setPointerCapture(e.pointerId); } catch { /* Zeiger schon weg */ }
  }

  dragMove(e) {
    const d = this.drag;
    if (!d || e.pointerId !== d.pointerId) return;
    if (!this.dragging) {
      if (Math.hypot(e.clientX - d.x, e.clientY - d.y) < 6) return;
      this.dragging = { key: d.key, room: null };
      const g = document.createElement('div');
      g.className = 'drag-ghost';
      g.innerHTML = '<span class="av sm"><svg viewBox="0 0 32 32"><path d="M16 4 28 16 16 28 4 16Z"/></svg></span><span></span><em>auf den Besprechungstisch ziehen</em>';
      g.querySelector('.av').style.setProperty('--c', d.info.color);
      g.querySelector('span:nth-child(2)').textContent = d.info.name;
      document.body.appendChild(g);
      d.ghost = g;
      this.renderer.domElement.style.cursor = 'grabbing';
    }
    this.dragging.room = this.meetingPadAt(e);
    d.ghost.style.transform = `translate(${e.clientX + 14}px, ${e.clientY + 10}px)`;
    d.ghost.classList.toggle('ok', !!this.dragging.room);
  }

  dragEnd(e, cancel) {
    const d = this.drag;
    if (!d || (e.pointerId !== undefined && e.pointerId !== d.pointerId)) return;
    this.drag = null;
    this.controls.enabled = true;
    try { this.renderer.domElement.releasePointerCapture(d.pointerId); } catch { /* nicht gehalten */ }
    if (!this.dragging) return;
    const room = !cancel && this.meetingPadAt(e);
    this.dragging = null;
    this.dragDone = true; // Loslassen ist keine Auswahl
    d.ghost?.remove();
    this.renderer.domElement.style.cursor = '';
    if (room) this.onDropMeeting?.(d.key);
  }

  // Raum, dessen Meeting-Pad unter dem Zeiger liegt (Schnitt mit dem Boden)
  meetingPadAt(e) {
    if (e.clientX === undefined) return null;
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const p = new THREE.Vector3();
    if (!this.raycaster.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), p)) return null;
    for (const room of this.rooms.values()) {
      const local = p.clone().sub(room.group.position);
      if (Math.hypot(local.x - room.meetingCenter.x, local.z - room.meetingCenter.z) < 2.4) return room;
    }
    return null;
  }

  // Teilnehmer offener Besprechungen (danach sync aufrufen)
  setMeetingIds(ids) {
    const next = new Set(ids);
    const same = next.size === this.meetingIds.size && [...next].every((x) => this.meetingIds.has(x));
    this.meetingIds = next;
    return !same;
  }

  pick(e) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const objs = [...this.avatars.values()].filter((a) => !a.leaving).map((a) => a.group);
    const hit = this.raycaster.intersectObjects(objs, true)[0];
    return hit?.object.userData.agentKey || null;
  }

  // ---------------------------------------------------------------- Räume
  roomFor(name) {
    let room = this.rooms.get(name);
    if (!room) {
      room = new Room(name, this);
      this.rooms.set(name, room);
      this.scene.add(room.group);
      this.layoutRooms();
    }
    return room;
  }

  layoutRooms() {
    const rooms = [...this.rooms.values()].sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
    const n = Math.max(1, rooms.length);
    const cols = Math.ceil(Math.sqrt(n));
    const rows = Math.ceil(n / cols);
    rooms.forEach((room, i) => {
      const c = i % cols, rr = Math.floor(i / cols);
      room.group.position.set(
        (c - (cols - 1) / 2) * (ROOM_W + ROOM_GAP),
        0,
        (rr - (rows - 1) / 2) * (ROOM_D + ROOM_GAP + 1.5),
      );
    });
    this.bounds = { w: cols * (ROOM_W + ROOM_GAP), d: rows * (ROOM_D + ROOM_GAP + 1.5) };
    const ext = Math.max(this.bounds.w, this.bounds.d) * 0.62 + 6;
    const sc = this.sun.shadow.camera;
    sc.left = -ext; sc.right = ext; sc.top = ext; sc.bottom = -ext; sc.near = 1; sc.far = 220;
    sc.updateProjectionMatrix();
    this.sun.position.set(ext * 0.55 + 18, 60, ext * 0.35 + 22);
    this.sun.target.position.set(0, 0, 0);
  }

  resetView(instant = false) {
    const b = this.bounds || { w: ROOM_W, d: ROOM_D };
    const size = Math.max(b.w, b.d * 1.25);
    const dist = Math.max(28, size * 1.45);
    const target = new THREE.Vector3(0, 0, 0.8);
    const pos = new THREE.Vector3(dist * 0.58, dist * 0.72, dist * 0.78);
    this.select(null, false);
    if (instant) {
      this.camera.position.copy(pos);
      this.controls.target.copy(target);
      this.controls.update();
    } else {
      this.focus = { target, pos };
    }
  }

  focusOn(key) {
    const av = this.avatars.get(key);
    if (!av) return;
    const target = av.group.position.clone();
    target.y = 0.8;
    const dir = this.camera.position.clone().sub(this.controls.target).normalize();
    const pos = target.clone().add(dir.multiplyScalar(28));
    this.focus = { target, pos, follow: key };
  }

  select(key, focus = true) {
    if (this.selected && this.avatars.get(this.selected)) this.avatars.get(this.selected).selected = false;
    this.selected = key;
    if (key && this.avatars.get(key)) {
      this.avatars.get(key).selected = true;
      if (focus) this.focusOn(key);
    }
  }

  setLabelsVisible(v) {
    this.labelsVisible = v;
    for (const a of this.avatars.values()) a.setLabelsVisible(v);
  }

  // ---------------------------------------------------------------- Daten → Szene
  sync(agents) {
    const live = new Set(agents.map((a) => a.id));
    const byRoom = new Map();
    for (const a of agents) {
      if (!byRoom.has(a.project)) byRoom.set(a.project, []);
      byRoom.get(a.project).push(a);
    }

    // Räume anlegen/aufräumen
    let changed = false;
    for (const name of byRoom.keys()) if (!this.rooms.has(name)) { this.roomFor(name); changed = true; }
    for (const [name, room] of this.rooms) {
      if (!byRoom.has(name) && ![...this.avatars.values()].some((av) => av.room === room && !av.removed)) {
        room.dispose(); this.rooms.delete(name); changed = true;
      }
    }
    if (changed) { this.layoutRooms(); if (!this.selected) this.resetView(); }

    // Figuren anlegen/aktualisieren
    for (const a of agents) {
      let av = this.avatars.get(a.id);
      const room = this.rooms.get(a.project);
      // Aussehen geändert (Farbe/Stil des Tools): Figur an gleicher Stelle neu aufbauen
      if (av && !av.leaving && av.look !== Avatar.lookOf(a)) {
        const old = av;
        av = new Avatar(a, { onLabelClick: (k) => this.onSelect?.(k) });
        Object.assign(av, { room: old.room, selected: old.selected, hovered: old.hovered, path: old.path, facing: old.facing,
          targetFacing: old.targetFacing, atStation: old.atStation, atLounge: old.atLounge, slotKey: old.slotKey,
          stationId: old.stationId, opacity: 1 });
        // Ankunft der alten Figur auf die neue übertragen
        const nav = av;
        if (old.arrive) av.arrive = () => { old.arrive(); nav.atStation = old.atStation; nav.atLounge = old.atLounge; };
        av.group.position.copy(old.group.position);
        av.group.rotation.y = old.facing;
        av.setOpacity(1);
        av.setLabelsVisible(this.labelsVisible);
        old.group.parent?.add(av.group);
        old.group.parent?.remove(old.group);
        old.dispose();
        this.avatars.set(a.id, av);
      }
      if (!av) {
        av = new Avatar(a, { onLabelClick: (k) => this.onSelect?.(k) });
        av.room = room;
        av.setLabelsVisible(this.labelsVisible);
        room.group.add(av.group);
        // Subagenten erscheinen am Besprechungstisch neben dem Erzeuger, Hauptagenten am Eingang
        const parent = a.parentId && this.avatars.get(a.parentId);
        if (parent && parent.room === room) {
          av.group.position.copy(parent.group.position).add(new THREE.Vector3((Math.random() - 0.5) * 1.2, 0, 0.8));
        } else {
          av.group.position.copy(DOOR);
        }
        this.avatars.set(a.id, av);
      }
      av.update(a);
    }
    for (const [key, av] of this.avatars) {
      if (!live.has(key)) {
        av.leave(DOOR.clone());
        if (this.selected === key) this.onSelect?.(null);
      }
    }

    // Stationen zuweisen
    for (const [name, room] of this.rooms) {
      const list = (byRoom.get(name) || []);
      for (const st of Object.values(room.stations)) { st.busy = false; st.queue = []; }
      for (const a of list) {
        const st = this.stationFor(a);
        room.stations[st].queue.push(a);
        if (a.status === 'tool') room.stations[st].busy = true;
      }
      const active = list.filter((a) => a.status !== 'done' && a.status !== 'idle').length;
      room.countEl.textContent = `${list.length}`;
      room.labelEl.classList.toggle('active', active > 0);
      room.order = Math.min(...list.map((a) => a.startedAt || Infinity));
      for (const st of Object.values(room.stations)) {
        // Stabile Sitzordnung: Hauptagent vorne, dann nach Startzeit
        // am Tisch sitzen Besprechungsteilnehmer vorn (feste Plätze)
        const rank = (a) => (st.id === 'meeting' && this.meetingIds.has(a.id) ? 0 : 1);
        st.queue.sort((x, y) => rank(x) - rank(y)
          || (x.kind === y.kind ? (x.startedAt || 0) - (y.startedAt || 0) : x.kind === 'main' ? -1 : 1));
        st.queue.forEach((a, i) => this.place(this.avatars.get(a.id), room, st, i));
      }
    }

    this.syncLinks(agents);
  }

  stationFor(a) {
    // Besprechung: am Tisch bleiben; nur für Werkzeuge kurz zur Station (und zurück)
    if (this.meetingIds.has(a.id) && a.kind === 'main') {
      if ((a.status === 'tool' || a.status === 'waiting_permission') && a.category) return a.category;
      return 'meeting';
    }
    if ((a.status === 'tool' || a.status === 'waiting_permission') && a.category) return a.category;
    if (a.status === 'waiting_user') return a.kind === 'main' ? 'lounge' : 'meeting';
    if (a.status === 'idle') return 'lounge';
    if (a.status === 'done') return 'meeting';
    // Denken: am letzten Ort bleiben, sonst Besprechungstisch
    const av = this.avatars.get(a.id);
    return av?.stationId && av.stationId !== 'lounge' ? av.stationId : 'meeting';
  }

  place(av, room, st, index) {
    if (!av || av.leaving) return;
    const slotKey = `${st.id}:${index}`;
    if (av.slotKey === slotKey) return;
    av.slotKey = slotKey;
    av.stationId = st.id;
    let slot = st.slots[index];
    if (!slot) {
      // Überlauf: Ring um die Station
      const k = index - st.slots.length;
      const ang = k * 2.4;
      const rad = 2.2 + Math.floor(k / 6) * 0.8;
      const pos = st.center.clone().add(new THREE.Vector3(Math.sin(ang) * rad, 0, Math.cos(ang) * rad));
      pos.x = THREE.MathUtils.clamp(pos.x, -ROOM_W / 2 + 0.6, ROOM_W / 2 - 0.6);
      pos.z = THREE.MathUtils.clamp(pos.z, -ROOM_D / 2 + 0.6, ROOM_D / 2 - 0.6);
      slot = { pos, facing: Math.atan2(st.center.x - pos.x, st.center.z - pos.z) };
    }
    av.atStation = false;
    av.atLounge = false;
    av.walkTo(this.route(room, av.group.position, slot.pos));
    av.setFacing(slot.facing);
    av.arrive = () => {
      av.atStation = st.id !== 'lounge';
      av.atLounge = st.id === 'lounge' && index < room.loungeSeats;
    };
  }

  // Gerader Weg mit Umweg um runde Hindernisse
  route(room, from, to) {
    const pts = [];
    let cur = from.clone();
    for (let guard = 0; guard < 4; guard++) {
      let hit = null;
      for (const o of room.obstacles) {
        const c = new THREE.Vector3(o.x, 0, o.z);
        if (c.distanceTo(to) < o.r + 0.2) continue;
        const seg = to.clone().sub(cur);
        const len = seg.length();
        if (len < 0.01) break;
        const tt = THREE.MathUtils.clamp(c.clone().sub(cur).dot(seg) / (len * len), 0, 1);
        const closest = cur.clone().add(seg.clone().multiplyScalar(tt));
        if (closest.distanceTo(c) < o.r && tt > 0.02 && tt < 0.98) { hit = { o, c, closest }; break; }
      }
      if (!hit) break;
      let away = hit.closest.clone().sub(hit.c);
      if (away.lengthSq() < 1e-4) away.set(-(to.z - cur.z), 0, to.x - cur.x);
      away.normalize().multiplyScalar(hit.o.r + 0.45);
      const wp = hit.c.clone().add(away);
      pts.push(wp);
      cur = wp;
    }
    pts.push(to.clone());
    return pts;
  }

  syncLinks(agents) {
    const want = new Set();
    for (const a of agents) {
      if (a.kind !== 'sub' || !a.parentId || a.status === 'done') continue;
      const id = `${a.id}`;
      want.add(id);
      if (!this.links.has(id)) {
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(24 * 3), 3));
        const line = new THREE.Line(geo, new THREE.LineDashedMaterial({ color: agentColor(a), dashSize: 0.25, gapSize: 0.18, transparent: true, opacity: 0.7 }));
        line.frustumCulled = false;
        this.linkGroup.add(line);
        this.links.set(id, { line, child: a.id, parent: a.parentId });
      }
    }
    for (const [id, l] of this.links) {
      if (!want.has(id)) { l.line.geometry.dispose(); l.line.material.dispose(); l.line.removeFromParent(); this.links.delete(id); }
    }
  }

  updateLinks(t) {
    const p0 = new THREE.Vector3(), p1 = new THREE.Vector3(), mid = new THREE.Vector3();
    for (const l of this.links.values()) {
      const c = this.avatars.get(l.child), p = this.avatars.get(l.parent);
      if (!c || !p || c.room !== p.room) { l.line.visible = false; continue; }
      l.line.visible = true;
      c.group.getWorldPosition(p0); p.group.getWorldPosition(p1);
      p0.y += 1.25; p1.y += 1.35;
      mid.copy(p0).add(p1).multiplyScalar(0.5);
      mid.y += 0.6 + p0.distanceTo(p1) * 0.18;
      const curve = new THREE.QuadraticBezierCurve3(p0, mid, p1);
      const arr = l.line.geometry.attributes.position.array;
      for (let i = 0; i < 24; i++) {
        const v = curve.getPoint(i / 23);
        arr[i * 3] = v.x; arr[i * 3 + 1] = v.y; arr[i * 3 + 2] = v.z;
      }
      l.line.geometry.attributes.position.needsUpdate = true;
      l.line.computeLineDistances();
      l.line.material.opacity = 0.35 + 0.3 * Math.min(c.opacity, p.opacity) + Math.sin(t * 3) * 0.05;
    }
  }

  loop() {
    const dt = Math.min(this.clock.getDelta(), 0.05);
    const t = this.clock.elapsedTime;

    for (const [key, av] of this.avatars) {
      const hadPath = av.path.length > 0;
      av.tick(dt, t);
      if (hadPath && !av.path.length) av.arrive?.();
      if (av.removed) {
        av.group.removeFromParent();
        av.dispose();
        this.avatars.delete(key);
      }
    }
    for (const room of this.rooms.values()) room.tick(t, dt);
    this.updateLinks(t);

    if (this.focus) {
      if (this.focus.follow) {
        const av = this.avatars.get(this.focus.follow);
        if (av) {
          const target = av.group.getWorldPosition(new THREE.Vector3());
          target.y = 0.8;
          const delta = target.clone().sub(this.focus.target);
          this.focus.target.add(delta);
          this.focus.pos.add(delta);
        }
      }
      const k = Math.min(1, dt * 3.2);
      this.controls.target.lerp(this.focus.target, k);
      this.camera.position.lerp(this.focus.pos, k);
      if (!this.focus.follow && this.camera.position.distanceTo(this.focus.pos) < 0.05) this.focus = null;
    }

    this.controls.update();
    this.renderer.render(this.scene, this.camera);
    this.labelRenderer.render(this.scene, this.camera);
  }
}
