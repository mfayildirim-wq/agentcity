// Szene: ein Diorama-Raum pro Haus (Auftrag), Stationen je Werkzeugart, Figuren laufen dorthin.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DRenderer } from 'three/addons/renderers/CSS2DRenderer.js';
import { CSS3DRenderer } from 'three/addons/renderers/CSS3DRenderer.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { Avatar } from './avatar.js';
import { agentColor } from './config.js';
import { Room, ROOM_W, ROOM_D, ROOM_GAP, DOOR, STREET } from './room.js';
import { houseOf, houseName } from './houses.js';
import { approachDir, roomFocus, isDouble } from './view.js';
import { Town } from './town.js';
import { MAX_LIVE_SCREENS } from './screen.js';

const SCREEN_BUDGET_MS = 500; // Abstand der Sichtbarkeitsprüfung der Leinwände

const ROW_LEN = 3; // Häuser je Reihe

// ---------------------------------------------------------------- Welt
export class World {
  // dragInfo(key) → { name, color } für ziehbare Figuren (steuerbare Hauptagenten) oder null;
  // onDropMeeting(key) – Figur auf ein Meeting-Pad fallen gelassen; onOpenScreen(sessionId) – Klick auf eine Leinwand;
  // screens: Container der CSS3D-Ebene (liegt unter dem Canvas, sichtbar durch den Ausschnitt der Leinwand)
  constructor(container, labelContainer, { onSelect, onHover, dragInfo = null, onDropMeeting = null, onOpenScreen = null, screens = null } = {}) {
    this.container = container;
    this.onSelect = onSelect;
    this.onHover = onHover;
    this.dragInfo = dragInfo;
    this.onDropMeeting = onDropMeeting;
    this.onOpenScreen = onOpenScreen;
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
    this.closeNext = false; // nächster Fokus = Nahsicht (Doppelklick)
    this.lastClick = null; // { t, x, y } zur Doppelklick-Erkennung

    // Canvas mit Alphakanal: Hintergrundfarbe kommt vom Dokument, die Leinwände scheinen durch ihren Ausschnitt
    const r = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance', alpha: true });
    r.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    r.setSize(container.clientWidth, container.clientHeight);
    r.setClearColor(0x000000, 0);
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
    // zweite Ebene: Leinwände als echte DOM-Elemente (CSS3D), gleiche Kamera
    this.screenRenderer = screens ? new CSS3DRenderer({ element: screens }) : null;
    this.screenRenderer?.setSize(container.clientWidth, container.clientHeight);
    this.screenBudgetAt = 0;

    const scene = new THREE.Scene();
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
    // linke Taste verschiebt, rechte dreht (Rad zoomt)
    controls.mouseButtons = { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE };
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

    this.town = new Town(scene); // Pflasterstraßen und Bäume um die Räume

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
    this.screenRenderer?.setSize(w, h);
  }

  bindEvents() {
    window.addEventListener('resize', () => this.applySize());
    const el = this.renderer.domElement;
    let down = null;
    el.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY }; });
    el.addEventListener('pointerup', (e) => {
      if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5 || this.dragDone) { this.dragDone = false; this.lastClick = null; return; }
      const last = this.lastClick;
      const dbl = isDouble(last, performance.now(), e.clientX, e.clientY);
      this.lastClick = { t: performance.now(), x: e.clientX, y: e.clientY };
      const key = this.pick(e);
      if (key) { this.selectClose(key, dbl); return; }
      if (dbl) {
        // Doppelklick auf den Boden: in das Haus fliegen, über dem der Zeiger liegt
        const room = this.roomAt(e);
        if (room) { this.focusRoom(room.id, true); return; }
      }
      // Klick auf eine Leinwand mit Inhalt öffnet die Session des gezeigten Artefakts
      const screen = this.pickScreen(e);
      if (screen?.screen?.artifact && this.onOpenScreen) { this.onOpenScreen(screen.screen.artifact.sessionId); return; }
      this.onSelect?.(null);
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
        this.onHover?.(key);
      }
      el.style.cursor = key || this.pickScreen(e)?.screen?.artifact ? 'pointer' : '';
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

  // Raum, dessen Leinwand unter dem Zeiger liegt
  pickScreen(e) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const cuts = [...this.rooms.values()].map((r) => r.screenCut).filter(Boolean);
    const hit = this.raycaster.intersectObjects(cuts, false)[0];
    return hit ? [...this.rooms.values()].find((r) => r.screenCut === hit.object) ?? null : null;
  }

  // ---------------------------------------------------------------- Leinwände
  // artifactsBySession: Map sessionId → Artefakte (neueste zuerst); Raum = Haus der Session;
  // ist ein Agent des Raums ausgewählt, zeigt die Leinwand dessen neuestes Artefakt
  syncScreens(artifactsBySession, agents, selected = null) {
    const roomOf = new Map(); // sessionId → Haus
    for (const a of agents) if (a.sessionId && (!roomOf.has(a.sessionId) || a.kind === 'main')) roomOf.set(a.sessionId, houseOf(a));
    const perRoom = new Map();
    for (const [sid, list] of artifactsBySession ?? []) {
      const house = roomOf.get(sid);
      if (!house || !list?.length) continue;
      if (!perRoom.has(house)) perRoom.set(house, []);
      perRoom.get(house).push(...list);
    }
    const sel = selected ? agents.find((a) => a.id === selected) : null;
    for (const [id, room] of this.rooms) {
      if (!room.screen) continue;
      const list = (perRoom.get(id) ?? []).sort((x, y) => (y.updatedAt ?? y.t ?? 0) - (x.updatedAt ?? x.t ?? 0));
      let pick = list[0] ?? null;
      if (sel && houseOf(sel) === id && sel.sessionId) pick = list.find((a) => a.sessionId === sel.sessionId) ?? pick;
      room.screen.setArtifact(pick, list.length, list.filter((a) => !a.seen).length);
    }
    this.updateScreenBudget(true);
  }

  // Nur Leinwände im Bild zeigen, davon höchstens MAX_LIVE_SCREENS (nach Kameradistanz) mit iframe
  updateScreenBudget(force = false) {
    const now = performance.now();
    if (!force && now - this.screenBudgetAt < SCREEN_BUDGET_MS) return;
    this.screenBudgetAt = now;
    if (!this.rooms.size) return;
    const frustum = new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse));
    const pos = new THREE.Vector3();
    const ranked = [];
    for (const room of this.rooms.values()) {
      if (!room.screen) continue;
      room.screenWorldPosition(pos);
      const visible = frustum.intersectsSphere(new THREE.Sphere(pos.clone(), 2.8));
      ranked.push({ room, visible, dist: visible ? pos.distanceTo(this.camera.position) : Infinity });
    }
    ranked.sort((x, y) => x.dist - y.dist);
    ranked.forEach((r, i) => r.room.screen.setMode(!r.visible ? 'off' : i < MAX_LIVE_SCREENS ? 'live' : 'card'));
  }

  // ---------------------------------------------------------------- Räume
  roomFor(id) {
    let room = this.rooms.get(id);
    if (!room) {
      room = new Room(id, this);
      this.rooms.set(id, room);
      this.scene.add(room.group);
      this.layoutRooms();
    }
    return room;
  }

  // Häuser in Reihen zu je ROW_LEN: das Haus mit der neuesten Session steht vorn links, ältere dahinter
  layoutRooms() {
    const rooms = [...this.rooms.values()].sort((a, b) => b.order - a.order || a.name.localeCompare(b.name));
    const n = Math.max(1, rooms.length);
    const cols = Math.min(n, ROW_LEN);
    const rows = Math.ceil(n / cols);
    rooms.forEach((room, i) => {
      const c = i % cols, rr = Math.floor(i / cols);
      room.group.position.set(
        (c - (cols - 1) / 2) * (ROOM_W + ROOM_GAP),
        0,
        ((rows - 1) / 2 - rr) * (ROOM_D + ROOM_GAP + 1.5),
      );
    });
    this.town.layout(rooms.map((room) => room.group.position));
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

  focusOn(key, close = false) {
    const av = this.avatars.get(key);
    if (!av) return;
    const closeFocus = close || (this.closeNext && performance.now() - this.closeNext < 800);
    this.closeNext = 0;
    const target = av.group.position.clone();
    target.y = 0.8;
    const dir = approachDir(this.camera.position.clone().sub(this.controls.target).toArray());
    const pos = target.clone().add(new THREE.Vector3(...dir).multiplyScalar(closeFocus ? 13 : 28));
    this.focus = { target, pos, follow: key };
  }

  // Leere Häuser abräumen, sobald die letzte Figur hinausgegangen ist (ohne auf ein Daten-Update zu warten)
  pruneRooms() {
    let changed = false;
    for (const [id, room] of this.rooms) {
      if (this.liveHouses?.has(id)) continue;
      if ([...this.avatars.values()].some((av) => av.room === room && !av.removed)) continue;
      room.dispose(); this.rooms.delete(id); changed = true;
    }
    if (changed) { this.layoutRooms(); if (!this.selected) this.resetView(); }
  }

  // Kamera fliegt in ein Haus (Doppelklick auf Boden, Raumschild oder Listenkopf)
  focusRoom(id, close = false) {
    const room = this.rooms.get(id);
    if (!room) return;
    const { target, pos } = roomFocus(room.group.position.toArray(), close);
    this.focus = { target: new THREE.Vector3(...target), pos: new THREE.Vector3(...pos) };
  }

  // Raum, über dem der Zeiger liegt (Schnitt mit dem Boden, Prüfung des Grundrisses)
  roomAt(e) {
    if (e.clientX === undefined) return null;
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const p = new THREE.Vector3();
    if (!this.raycaster.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), p)) return null;
    for (const room of this.rooms.values()) {
      const local = p.clone().sub(room.group.position);
      if (Math.abs(local.x) <= ROOM_W / 2 + 0.5 && Math.abs(local.z) <= ROOM_D / 2 + 0.5) return room;
    }
    return null;
  }

  select(key, focus = true) {
    if (this.selected && this.avatars.get(this.selected)) this.avatars.get(this.selected).selected = false;
    this.selected = key;
    if (key && this.avatars.get(key)) {
      this.avatars.get(key).selected = true;
      if (focus) this.focusOn(key);
    }
  }

  // Auswahl per Klick; bei Doppelklick fliegt die Kamera nah heran.
  // Das Store feuert 'selected' nur bei Wechsel (per rAF → world.select → focusOn):
  // gleiche Figur → direkt fokussieren; Wechsel → Nahsicht über closeNext, das focusOn verbraucht
  selectClose(key, dbl = false) {
    const same = this.selected === key;
    if (dbl) this.closeNext = performance.now();
    this.onSelect?.(key);
    if (dbl) {
      if (same) this.focusOn(key, true);
      else requestAnimationFrame(() => { if (this.closeNext) this.focusOn(key, true); });
    }
  }

  setLabelsVisible(v) {
    this.labelsVisible = v;
    for (const a of this.avatars.values()) a.setLabelsVisible(v);
  }

  // ---------------------------------------------------------------- Daten → Szene
  sync(agents) {
    const live = new Set(agents.map((a) => a.id));
    // Räume nach Haus (Auftrag), nicht nach Ordner
    const byRoom = new Map();
    for (const a of agents) {
      const k = houseOf(a);
      if (!byRoom.has(k)) byRoom.set(k, []);
      byRoom.get(k).push(a);
    }

    // Räume anlegen/aufräumen
    let changed = false;
    const firstRooms = this.rooms.size === 0; // erster Aufbau: Kamera sofort setzen statt anfliegen
    for (const name of byRoom.keys()) if (!this.rooms.has(name)) { this.roomFor(name); changed = true; }
    this.liveHouses = new Set(byRoom.keys()); // für pruneRooms: Häuser mit lebenden Agenten
    for (const [name, room] of this.rooms) {
      if (!byRoom.has(name) && ![...this.avatars.values()].some((av) => av.room === room && !av.removed)) {
        room.dispose(); this.rooms.delete(name); changed = true;
      }
    }
    // Raumschild: Name aus dem ältesten Hauptagenten, Ordner als Untertitel;
    // Reihenfolge: neueste Session des Hauses (Beitritt holt ein Haus nach vorn) – Änderung ordnet die Reihen neu
    for (const [name, list] of byRoom) {
      const room = this.rooms.get(name);
      room.setName(houseName(list), list.find((a) => a.kind === 'main')?.project ?? list[0]?.project);
      const order = Math.max(0, ...list.filter((a) => a.kind === 'main').map((a) => a.startedAt || 0));
      if (order !== room.order) { room.order = order; changed = true; }
    }
    if (changed) { this.layoutRooms(); if (!this.selected) this.resetView(firstRooms); }

    // Figuren anlegen/aktualisieren
    for (const a of agents) {
      let av = this.avatars.get(a.id);
      const room = this.rooms.get(houseOf(a));
      // Aussehen geändert (Farbe/Stil des Tools): Figur an gleicher Stelle neu aufbauen
      if (av && !av.leaving && av.look !== Avatar.lookOf(a)) {
        const old = av;
        av = new Avatar(a, { onLabelClick: (k) => this.onSelect?.(k), onLabelDoubleClick: (k) => this.selectClose(k, true) });
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
        av = new Avatar(a, { onLabelClick: (k) => this.onSelect?.(k), onLabelDoubleClick: (k) => this.selectClose(k, true) });
        av.room = room;
        av.setLabelsVisible(this.labelsVisible);
        room.group.add(av.group);
        // Subagenten erscheinen am Besprechungstisch neben dem Erzeuger, Hauptagenten kommen von der Straße durch die Tür
        const parent = a.parentId && this.avatars.get(a.parentId);
        if (parent && parent.room === room) {
          av.group.position.copy(parent.group.position).add(new THREE.Vector3((Math.random() - 0.5) * 1.2, 0, 0.8));
        } else {
          av.group.position.copy(STREET);
          av.entering = true;
          av.opacity = 1; // auf der Straße sofort sichtbar, kein Einblenden
          av.setOpacity(1);
        }
        this.avatars.set(a.id, av);
      }
      av.update(a);
    }
    for (const [key, av] of this.avatars) {
      if (!live.has(key)) {
        av.leave([DOOR.clone(), STREET.clone()]); // durch die Tür hinaus, auf der Straße verblassen
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
    // Neuankömmlinge laufen erst zur Tür, dann im Raum weiter
    const from = av.entering ? DOOR : av.group.position;
    const pts = this.route(room, from, slot.pos);
    av.walkTo(av.entering ? [DOOR.clone(), ...pts] : pts);
    av.entering = false;
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
      // Höhe: vor der Tür auf Straßenniveau, im Raum auf dem Boden
      const wantY = av.group.position.z > ROOM_D / 2 + 0.25 ? -0.45 : 0;
      av.group.position.y += (wantY - av.group.position.y) * Math.min(1, dt * 6);
      if (hadPath && !av.path.length) av.arrive?.();
      if (av.removed) {
        av.group.removeFromParent();
        av.dispose();
        this.avatars.delete(key);
        this.pruneRooms();
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
    this.screenRenderer?.render(this.scene, this.camera);
    this.labelRenderer.render(this.scene, this.camera);
    this.updateScreenBudget();
  }
}
