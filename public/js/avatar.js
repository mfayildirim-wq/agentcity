// Stilisierte Figur aus Grundkörpern – leicht, schattenwerfend, animierbar.
import * as THREE from 'three';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { agentColor, avatarStyle, hash, STATUS, STATIONS, agentName } from './config.js';
import { personOf } from './person.js';
import { esc } from './ui/common.js';

const capsule = (r, len) => new THREE.CapsuleGeometry(r, len, 6, 12);
const TAU = Math.PI * 2;
// Haarschalen lassen vorn ein Fenster fürs Gesicht frei (phi ab π/2+0.8 bis π/2−0.8)
const hairShell = (thetaStart, thetaLen) => new THREE.SphereGeometry(0.235, 24, 8, Math.PI / 2 + 0.8, TAU - 1.6, thetaStart, thetaLen);
const GEO = {
  leg: capsule(0.1, 0.42),
  arm: capsule(0.068, 0.4),
  torso: capsule(0.23, 0.32),
  head: new THREE.SphereGeometry(0.2, 24, 18),
  hair: new THREE.SphereGeometry(0.212, 24, 12, 0, TAU, 0, Math.PI * 0.55),   // kurze Haarkappe
  buzz: new THREE.SphereGeometry(0.206, 24, 10, 0, TAU, 0, Math.PI * 0.5),    // Stoppeln, eng am Kopf
  hairSide: hairShell(Math.PI * 0.55, Math.PI * 0.2),                          // langes Haar: setzt die Kappe seitlich/hinten fort
  hairBack: new THREE.CapsuleGeometry(0.17, 0.26, 4, 12),                       // langes Haar hinten bis zu den Schultern
  bobTop: new THREE.SphereGeometry(0.235, 24, 10, 0, TAU, 0, Math.PI * 0.42),  // Bob: Pony bis über die Augen
  bobSide: hairShell(Math.PI * 0.42, Math.PI * 0.3),                            // Bob: Seiten bis zum Kinn
  bun: new THREE.SphereGeometry(0.085, 12, 10),
  ponytail: new THREE.CapsuleGeometry(0.06, 0.3, 4, 10),
  curl: new THREE.SphereGeometry(0.075, 10, 8),                                 // Locken: Kugeln auf dem Deckhaar
  beard: new THREE.SphereGeometry(0.208, 20, 8, -0.1, Math.PI + 0.2, Math.PI * 0.66, Math.PI * 0.3), // Kinn, Wangen, Koteletten – ab Mundhöhe
  lens: new THREE.TorusGeometry(0.055, 0.008, 6, 20),
  bridge: new THREE.BoxGeometry(0.05, 0.008, 0.008),
  temple: new THREE.BoxGeometry(0.008, 0.008, 0.19),                            // Brillenbügel bis zum Ohr
  mouth: new THREE.BoxGeometry(0.06, 0.012, 0.01),
  collar: new THREE.TorusGeometry(0.2, 0.025, 8, 28),                           // Kragenring in Tool-/Typfarbe
  skirt: new THREE.CylinderGeometry(0.22, 0.27, 0.32, 20, 1, true),
  eye: new THREE.SphereGeometry(0.026, 8, 6),
  hand: new THREE.SphereGeometry(0.075, 10, 8),
  shoe: new THREE.BoxGeometry(0.17, 0.08, 0.26),
  ring: new THREE.RingGeometry(0.42, 0.5, 40),
  disc: new THREE.CircleGeometry(0.42, 32),
  gem: new THREE.OctahedronGeometry(0.13, 0),
  badge: new THREE.CylinderGeometry(0.07, 0.07, 0.02, 16),
  // Figurenstile je Tool (dezent, aus Grundkörpern)
  capCrown: new THREE.SphereGeometry(0.218, 24, 10, 0, Math.PI * 2, 0, Math.PI * 0.5),
  capBand: new THREE.CylinderGeometry(0.219, 0.219, 0.035, 24, 1, true),
  capBrim: new THREE.CylinderGeometry(0.17, 0.17, 0.016, 24, 1, false, -Math.PI / 2, Math.PI),
  hood: new THREE.SphereGeometry(0.248, 24, 14, 0, Math.PI * 2, 0, Math.PI * 0.64),
  hoodRim: new THREE.TorusGeometry(0.2, 0.03, 8, 28),
  scarf: new THREE.TorusGeometry(0.135, 0.05, 10, 28),
  scarfEnd: new THREE.BoxGeometry(0.075, 0.2, 0.035),
  visor: new THREE.CylinderGeometry(0.207, 0.207, 0.07, 28, 1, true, -1.15, 2.3),
};

const mat = (color, extra = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.72, metalness: 0.02, ...extra });

const WALK_SPEED = 2.1;

export class Avatar {
  constructor(agent, { onLabelClick, onLabelDoubleClick } = {}) {
    this.key = agent.id;
    this.kind = agent.kind;
    this.data = agent;
    this.group = new THREE.Group();
    this.group.userData.agentKey = agent.id;
    this.path = [];
    this.phase = (hash(agent.id) % 1000) / 160;
    this.facing = 0;
    this.opacity = 0;          // Einblenden beim Betreten
    this.leaving = false;
    this.removed = false;
    this.selected = false;
    this.hovered = false;
    this.anim = 'idle';
    this.blend = { walk: 0, work: 0, think: 0, sit: 0, raise: 0, floor: 0 };
    this.materials = [];
    this.build(agent);
    this.buildLabel(agent, onLabelClick, onLabelDoubleClick);
  }

  m(color, extra) { const x = mat(color, extra); this.materials.push(x); return x; }

  // Aussehen (Farbe + Stil): ändert es sich (Tool-Einstellungen), baut die Welt die Figur neu
  static lookOf(a) { return `${agentColor(a)}|${a.kind === 'main' ? avatarStyle(a) : 'sub'}`; }

  build(a) {
    this.look = Avatar.lookOf(a);
    const isMain = a.kind === 'main';
    this.style = isMain ? avatarStyle(a) : null;
    // Person (Geschlecht, Frisur, Haut, Kleidung …) hängt nur an der Id; die Tool-/Typfarbe liegt auf Zubehör und Kragen
    const tool = new THREE.Color(agentColor(a));
    const p = personOf(a, agentColor(a)); // Hemd meidet die Tool-/Typfarbe
    this.person = p;
    const skin = this.m(p.skin);
    const hair = this.m(p.hairColor, { roughness: 0.85 });
    const shirtM = this.m(isMain ? p.shirt : tool); // Subagenten tragen weiter ihre Typfarbe
    const pantsM = this.m(p.pants);
    const legM = p.skirt ? skin : pantsM;
    const shoeM = this.m('#2a2c33');
    const eyeM = this.m('#1b1d22', { roughness: 0.3 });
    const female = p.gender === 'f';
    const xs = female ? 0.88 : 1, zs = female ? 0.74 : 0.8; // Oberkörper: Frauen schmaler

    const body = new THREE.Group();
    body.scale.setScalar(p.height); // Körpergröße, Füße bleiben am Boden
    this.body = body;
    this.group.add(body);

    // Beine mit Drehpunkt an der Hüfte
    const mkLeg = (x) => {
      const pivot = new THREE.Group();
      pivot.position.set(x, 0.72, 0);
      const leg = new THREE.Mesh(GEO.leg, legM);
      leg.position.y = -0.31;
      const shoe = new THREE.Mesh(GEO.shoe, shoeM);
      shoe.position.set(0, -0.68, 0.04);
      pivot.add(leg, shoe);
      body.add(pivot);
      return pivot;
    };
    this.legL = mkLeg(-0.12);
    this.legR = mkLeg(0.12);

    if (p.skirt) {
      const skirt = new THREE.Mesh(GEO.skirt, this.m(p.pants, { side: THREE.DoubleSide }));
      skirt.position.y = 0.62;
      body.add(skirt);
    }

    const torso = new THREE.Mesh(GEO.torso, shirtM);
    torso.position.y = 1.02;
    torso.scale.set(xs, 1, zs);
    body.add(torso);
    this.torso = torso;

    const mkArm = (x) => {
      const pivot = new THREE.Group();
      pivot.position.set(x, 1.27, 0);
      const arm = new THREE.Mesh(GEO.arm, shirtM);
      arm.position.y = -0.24;
      const hand = new THREE.Mesh(GEO.hand, skin);
      hand.position.y = -0.5;
      pivot.add(arm, hand);
      body.add(pivot);
      return pivot;
    };
    const shoulder = female ? 0.28 : 0.31;
    this.armL = mkArm(-shoulder);
    this.armR = mkArm(shoulder);

    // Kragenring: schmaler Ring am Hals in Tool-/Typfarbe, damit die Zugehörigkeit auch ohne Zubehör sichtbar ist
    const collar = new THREE.Mesh(GEO.collar, this.m(tool, { emissive: tool, emissiveIntensity: 0.2 }));
    collar.rotation.x = Math.PI / 2;
    collar.position.y = 1.35;
    collar.scale.set((0.155 * xs + 0.012) / 0.2, (0.155 * zs + 0.012) / 0.2, 1); // liegt auf dem Oberkörper auf
    body.add(collar);

    const head = new THREE.Group();
    head.position.y = 1.58;
    const skull = new THREE.Mesh(GEO.head, skin);
    const cap = new THREE.Mesh(GEO.hair, hair);
    cap.rotation.x = -0.35;
    cap.position.set(0, 0.015, -0.02);
    const eyeL = new THREE.Mesh(GEO.eye, eyeM); eyeL.position.set(-0.07, 0.01, 0.185);
    const eyeR = new THREE.Mesh(GEO.eye, eyeM); eyeR.position.set(0.07, 0.01, 0.185);
    head.add(skull, cap, eyeL, eyeR);
    body.add(head);
    this.head = head;
    this.hairParts = [cap]; // alles Haar – unter der Kapuze unsichtbar
    this.hairBulk = 1;      // volle Frisuren brauchen eine größere Schirmmütze
    this.buildHair(p.hair, { head, hair, cap, underCap: this.style === 'cap' });

    const mouth = new THREE.Mesh(GEO.mouth, this.m(new THREE.Color(p.skin).lerp(new THREE.Color('#4a2e24'), 0.5)));
    mouth.position.set(0, -0.08, 0.19);
    head.add(mouth);
    if (p.beard) {
      const beard = new THREE.Mesh(GEO.beard, hair);
      beard.position.set(0, -0.005, 0.005);
      head.add(beard);
    }
    if (p.glasses) this.buildGlasses(head);

    // Hauptagent: Figurenstil seines Tools; Subagent: Abzeichen auf der Brust
    if (isMain) {
      this.buildStyle(this.style, tool, { head, body });
    } else {
      const badge = new THREE.Mesh(GEO.badge, this.m('#ffffff', { emissive: '#ffffff', emissiveIntensity: 0.25 }));
      badge.rotation.x = Math.PI / 2;
      // auf der Brustfläche (Oberkörper ist je Person unterschiedlich breit/tief)
      badge.position.set(0.1, 1.12, Math.sqrt(1 - (0.1 / (0.23 * xs)) ** 2) * 0.23 * zs + 0.012);
      body.add(badge);
    }

    // Statusring am Boden
    this.ringMat = new THREE.MeshBasicMaterial({ color: STATUS.idle.color, transparent: true, opacity: 0.85, depthWrite: false });
    const ring = new THREE.Mesh(GEO.ring, this.ringMat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.012;
    this.group.add(ring);
    this.ring = ring;

    this.selMat = new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0, depthWrite: false });
    const sel = new THREE.Mesh(GEO.disc, this.selMat);
    sel.rotation.x = -Math.PI / 2;
    sel.position.y = 0.01;
    sel.scale.setScalar(1.25);
    this.group.add(sel);

    const s = a.kind === 'main' ? 1.5 : 1.25;
    this.group.scale.setScalar(s);

    this.group.traverse((o) => {
      if (o.isMesh) {
        o.castShadow = o !== ring && o !== sel;
        o.userData.agentKey = a.id;
      }
    });
    this.setOpacity(0);
  }

  // Frisur aus Grundkörpern; `cap` ist die kurze Haarkappe (Stil `short`), `underCap` = Schirmmütze darüber
  buildHair(style, { head, hair, cap, underCap }) {
    const add = (...meshes) => { head.add(...meshes); this.hairParts.push(...meshes); };
    if (style === 'bald') { cap.visible = false; return; }
    if (style === 'buzz') { cap.geometry = GEO.buzz; return; }
    if (style === 'long') {
      // Kappe auf Schalengröße, Seiten/Hinterkopf setzen sie nahtlos fort, dahinter fällt das Haar bis zu den Schultern
      cap.scale.setScalar(0.235 / 0.212);
      const side = new THREE.Mesh(GEO.hairSide, hair);
      side.rotation.copy(cap.rotation); side.position.copy(cap.position);
      const back = new THREE.Mesh(GEO.hairBack, hair);
      back.position.set(0, -0.14, -0.1); back.scale.set(1.12, 1, 0.75);
      add(side, back);
      this.hairBulk = 1.1;
    } else if (style === 'bob') {
      cap.geometry = GEO.bobTop; cap.rotation.set(0, 0, 0); cap.position.set(0, 0, 0);
      add(new THREE.Mesh(GEO.bobSide, hair));
      this.hairBulk = 1.1;
    } else if (style === 'bun') {
      const b = new THREE.Mesh(GEO.bun, hair);
      b.position.set(0, underCap ? 0.04 : 0.12, underCap ? -0.22 : -0.2);
      add(b);
    } else if (style === 'ponytail') {
      const t = new THREE.Mesh(GEO.ponytail, hair);
      t.position.set(0, -0.1, -0.2); t.rotation.x = 0.25; // hängt vom Hinterkopf in den Nacken
      add(t);
    } else if (style === 'curly') {
      if (underCap) { this.hairBulk = 1.06; return; } // unter der Schirmmütze nur die Kappe, Mütze sitzt etwas weiter
      // Kranz aus Locken auf dem Deckhaar plus eine obenauf
      const n = 8;
      for (let i = 0; i < n; i++) {
        const ang = (i / n) * TAU;
        const c = new THREE.Mesh(GEO.curl, hair);
        c.position.set(Math.sin(ang) * 0.16, 0.12 + Math.cos(ang * 2) * 0.03, Math.cos(ang) * 0.16 - 0.02);
        add(c);
      }
      const top = new THREE.Mesh(GEO.curl, hair); top.position.set(0, 0.19, -0.02); add(top);
    }
  }

  // Brille: zwei Ringe, Steg, Bügel bis zu den Ohren (leicht nach hinten gedreht, damit nichts vor dem Gesicht schwebt)
  buildGlasses(head) {
    const m = this.m('#2a2d33', { roughness: 0.4, metalness: 0.3 });
    for (const s of [-1, 1]) {
      const lens = new THREE.Mesh(GEO.lens, m);
      lens.position.set(s * 0.07, 0.01, 0.19);
      lens.rotation.y = s * 0.3;
      const temple = new THREE.Mesh(GEO.temple, m);
      temple.position.set(s * 0.167, 0.015, 0.087);
      temple.rotation.y = -s * 0.37;
      head.add(lens, temple);
    }
    const bridge = new THREE.Mesh(GEO.bridge, m);
    bridge.position.set(0, 0.015, 0.2);
    head.add(bridge);
  }

  // gem: schwebende Raute · cap: Schirmmütze · hoodie: Kapuze · scarf: Schal · visor: dunkler Augenstreifen
  buildStyle(style, color, { head, body }) {
    const c = new THREE.Color(color);
    const darker = c.clone().lerp(new THREE.Color('#1c2029'), 0.35);
    const lighter = c.clone().lerp(new THREE.Color('#ffffff'), 0.45);
    if (style === 'cap') {
      const k = this.hairBulk; // sitzt über vollem Haar etwas weiter
      const m = this.m(darker, { roughness: 0.8 });
      const crown = new THREE.Mesh(GEO.capCrown, m);
      crown.position.set(0, 0.03, -0.01);
      crown.scale.set(1.04 * k, 0.98 * k, 1.06 * k);
      const band = new THREE.Mesh(GEO.capBand, this.m(lighter, { roughness: 0.7 }));
      band.position.set(0, 0.045, -0.01);
      band.scale.set(1.04 * k, 1, 1.06 * k);
      const brim = new THREE.Mesh(GEO.capBrim, m);
      brim.position.set(0, 0.04, 0.15 + (k - 1) * 0.2);
      brim.scale.set(k, 1, 1.15);
      brim.rotation.x = 0.12;
      head.add(crown, band, brim);
    } else if (style === 'hoodie') {
      const m = this.m(c.clone().lerp(new THREE.Color('#2a2f3a'), 0.12), { roughness: 0.9 });
      const hood = new THREE.Mesh(GEO.hood, m);
      hood.rotation.x = -0.62;
      hood.position.set(0, 0.0, -0.035);
      const rim = new THREE.Mesh(GEO.hoodRim, m);
      rim.position.set(0, 0.03, 0.06);
      rim.rotation.x = -0.62;
      rim.scale.set(1.02, 1.08, 1);
      for (const h of this.hairParts) h.visible = false; // Kapuze verdeckt die Frisur
      head.add(hood, rim);
    } else if (style === 'scarf') {
      const m = this.m(lighter, { roughness: 0.85 });
      const ring = new THREE.Mesh(GEO.scarf, m);
      ring.rotation.x = Math.PI / 2;
      ring.position.y = 1.39;
      ring.scale.set(1, 0.86, 1);
      const end = new THREE.Mesh(GEO.scarfEnd, m);
      end.position.set(0.085, 1.27, 0.165);
      end.rotation.set(-0.12, 0, 0.12);
      body.add(ring, end);
    } else if (style === 'visor') {
      const band = new THREE.Mesh(GEO.visor, this.m('#14171d', {
        roughness: 0.22, metalness: 0.55, emissive: c, emissiveIntensity: 0.18, side: THREE.DoubleSide,
      }));
      band.position.y = 0.015;
      head.add(band);
    } else {
      const gem = new THREE.Mesh(GEO.gem, this.m(c, { emissive: c, emissiveIntensity: 0.55, roughness: 0.35, metalness: 0.2 }));
      gem.position.y = 2.12;
      this.group.add(gem);
      this.gem = gem;
    }
  }

  buildLabel(a, onClick, onDoubleClick) {
    const el = document.createElement('div');
    el.className = `tag ${a.kind}`;
    el.innerHTML = `<div class="bubble"></div><div class="tag-name"><i></i><span></span></div>`;
    el.addEventListener('pointerdown', (e) => { e.stopPropagation(); onClick?.(this.key); });
    el.addEventListener('dblclick', (e) => { e.stopPropagation(); onDoubleClick?.(this.key); });
    this.labelEl = el;
    this.bubbleEl = el.querySelector('.bubble');
    this.nameEl = el.querySelector('.tag-name span');
    this.dotEl = el.querySelector('.tag-name i');
    this.label = new CSS2DObject(el);
    this.label.position.set(0, a.kind === 'main' ? 2.45 : 2.05, 0);
    this.label.center.set(0.5, 1);
    this.group.add(this.label);
    this.lastBubble = '';
    this.bubbleUntil = 0;
  }

  update(a) {
    const prev = this.data;
    this.data = a;
    const name = agentName(a);
    if (this.nameEl.textContent !== name) this.nameEl.textContent = name;
    const statusColor = a.status === 'tool' && a.category ? STATIONS[a.category].color : STATUS[a.status]?.color || STATUS.idle.color;
    this.ringMat.color.set(statusColor);
    this.dotEl.style.background = statusColor;
    this.labelEl.dataset.status = a.status;

    // Sprechblase bei neuem Werkzeug bzw. Statuswechsel
    let bubble = '';
    if (a.status === 'tool' && a.tool) bubble = `<b>${esc(a.tool.replace(/^mcp__/, '').replace(/__/g, ' · '))}</b>${a.detail ? ' ' + esc(a.detail) : ''}`;
    else if (a.status === 'waiting_user' && a.source === 'acp') bubble = a.lastText ? esc(a.lastText) : '<b>Bereit</b>';
    else if (a.status === 'waiting_user') bubble = a.detail ? `<b>Frage</b> ${esc(a.detail)}` : '<b>Wartet</b> auf deine Antwort';
    else if (a.status === 'waiting_permission') bubble = '<b>Erlaubnis</b> wird benötigt';
    else if (a.status === 'error') bubble = '<b>Fehler</b>';
    else if (a.source === 'acp' && a.lastText && (a.status === 'thinking' || a.lastText !== prev?.lastText)) bubble = esc(a.lastText);
    else if (a.status === 'thinking') bubble = '<span class="dots"><i></i><i></i><i></i></span>';
    else if (a.status === 'done' && prev?.status !== 'done') bubble = '<b>Fertig</b>';
    if (bubble !== this.lastBubble) {
      this.lastBubble = bubble;
      this.bubbleEl.innerHTML = bubble;
      const sticky = a.status === 'waiting_permission' || a.status === 'error' || (a.status === 'waiting_user' && a.source !== 'acp')
        || (a.status === 'thinking' && !(a.source === 'acp' && a.lastText));
      this.bubbleUntil = performance.now() + (sticky ? 1e9 : a.source === 'acp' && a.lastText && bubble === esc(a.lastText) ? 12000 : 7000);
    }
  }

  setLabelsVisible(v) { this.labelsVisible = v; }

  walkTo(points) {
    this.path = points.map((p) => p.clone());
  }

  setFacing(angle) { this.targetFacing = angle; }

  // Verlassen: Wegpunkte (z. B. Tür, dann Straße) ablaufen, danach ausblenden
  leave(points) {
    if (this.leaving) return;
    this.leaving = true;
    this.walkTo(Array.isArray(points) ? points : [points]);
  }

  setOpacity(v) {
    for (const m of this.materials) {
      m.transparent = v < 0.999;
      m.opacity = v;
    }
    this.ringMat.opacity = 0.85 * v;
  }

  tick(dt, t) {
    const g = this.group;
    let moving = false;

    if (this.path.length) {
      const target = this.path[0];
      const dx = target.x - g.position.x;
      const dz = target.z - g.position.z;
      const dist = Math.hypot(dx, dz);
      const step = WALK_SPEED * dt;
      if (dist <= step) {
        g.position.x = target.x; g.position.z = target.z;
        this.path.shift();
      } else {
        g.position.x += (dx / dist) * step;
        g.position.z += (dz / dist) * step;
        this.facingGoal = Math.atan2(dx, dz);
        moving = true;
      }
    }
    if (!moving && this.targetFacing != null) this.facingGoal = this.targetFacing;
    if (this.facingGoal != null) {
      let d = this.facingGoal - this.facing;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      this.facing += d * Math.min(1, dt * 8);
      g.rotation.y = this.facing;
    }

    // Ein-/Ausblenden
    const want = this.leaving && !this.path.length ? 0 : 1;
    if (Math.abs(this.opacity - want) > 0.001) {
      this.opacity += Math.sign(want - this.opacity) * Math.min(Math.abs(want - this.opacity), dt * 1.6);
      this.setOpacity(this.opacity);
      if (this.leaving && this.opacity <= 0.001) this.removed = true;
    }

    // Animationszustand
    const s = this.data.status;
    let anim = 'idle';
    if (moving) anim = 'walk';
    else if (s === 'waiting_permission') anim = 'raise';
    else if (s === 'error') anim = 'floor';
    else if (s === 'tool') anim = this.atStation ? 'work' : 'idle';
    else if (s === 'thinking') anim = 'think';
    else if (s === 'idle' || (s === 'waiting_user' && this.atLounge)) anim = 'sit';
    for (const k of Object.keys(this.blend)) {
      const goal = k === anim ? 1 : 0;
      this.blend[k] += (goal - this.blend[k]) * Math.min(1, dt * 7);
    }
    this.pose(t + this.phase);

    if (this.gem) {
      this.gem.rotation.y += dt * 1.2;
      this.gem.position.y = 2.12 + Math.sin(t * 2 + this.phase) * 0.05;
    }

    // Statusring: orange pulsierend bei Rückfrage, sonst ruhig
    if (s === 'waiting_permission') {
      const k = 1 + Math.sin(t * 6) * 0.09;
      this.ring.scale.set(k, k, 1);
      this.ringMat.opacity = (0.55 + 0.4 * (0.5 + 0.5 * Math.sin(t * 6))) * this.opacity;
    } else if (this.ring.scale.x !== 1) {
      this.ring.scale.set(1, 1, 1);
      this.ringMat.opacity = 0.85 * this.opacity;
    }

    this.selMat.opacity += (((this.selected ? 0.22 : this.hovered ? 0.12 : 0)) - this.selMat.opacity) * Math.min(1, dt * 10);

    const showBubble = performance.now() < this.bubbleUntil && this.lastBubble;
    this.bubbleEl.classList.toggle('on', !!showBubble && this.opacity > 0.5 && (this.labelsVisible !== false || this.selected));
    this.labelEl.classList.toggle('hidden-tag', (this.labelsVisible === false && !this.selected && !this.hovered) || this.opacity < 0.3);
    this.labelEl.classList.toggle('sel', this.selected);
  }

  pose(t) {
    const { walk, work, think, sit, raise, floor } = this.blend;
    const w = Math.sin(t * 9);
    const breathe = Math.sin(t * 1.8) * 0.012;

    // Beine
    this.legL.rotation.x = w * 0.55 * walk - sit * 1.35;
    this.legR.rotation.x = -w * 0.55 * walk - sit * 1.35;

    // Arme: Gehen pendeln, Arbeiten tippen, Denken Hand ans Kinn
    const type = Math.sin(t * 16) * 0.08;
    this.armL.rotation.x = -w * 0.5 * walk + (-1.15 + type) * work - 0.15 * think - 0.5 * sit;
    this.armR.rotation.x = w * 0.5 * walk + (-1.15 - type) * work - 2.3 * think - 0.5 * sit;
    this.armR.rotation.z = 0.55 * think;
    this.armL.rotation.z = -0.06 * (1 - walk);
    this.armR.rotation.z += 0.06 * (1 - walk - think);
    // Hand heben (Rückfrage): rechter Arm hoch, leichtes Winken
    this.armR.rotation.x = this.armR.rotation.x * (1 - raise) + (-2.9 + Math.sin(t * 5) * 0.08) * raise;
    this.armR.rotation.z += -0.15 * raise;
    // Fehler: auf dem Boden sitzen, Beine nach vorn
    this.legL.rotation.x = this.legL.rotation.x * (1 - floor) - 1.35 * floor;
    this.legR.rotation.x = this.legR.rotation.x * (1 - floor) - 1.35 * floor;
    this.armL.rotation.x = this.armL.rotation.x * (1 - floor) + 0.35 * floor;
    this.armR.rotation.x = this.armR.rotation.x * (1 - floor) + 0.35 * floor;

    // Körper
    const bob = Math.abs(Math.sin(t * 9)) * 0.045 * walk;
    this.body.position.y = bob + breathe - sit * 0.3 - floor * 0.5;
    this.body.position.z = sit * -0.12;
    this.torso.rotation.x = 0.08 * walk + 0.1 * work;
    this.head.rotation.x = 0.18 * work - 0.12 * think + 0.2 * floor - 0.15 * raise + Math.sin(t * 0.7) * 0.03;
    this.head.rotation.y = Math.sin(t * 0.45) * 0.25 * (1 - walk - work) + 0.2 * think;
    this.head.rotation.z = 0.12 * think;
  }

  dispose() {
    this.labelEl.remove();
    for (const m of this.materials) m.dispose();
    this.ringMat.dispose();
    this.selMat.dispose();
  }
}
