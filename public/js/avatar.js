// Stilisierte Figur aus Grundkörpern – leicht, schattenwerfend, animierbar.
import * as THREE from 'three';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { agentColor, skinTone, hairTone, hash, STATUS, STATIONS, agentName } from './config.js';

const capsule = (r, len) => new THREE.CapsuleGeometry(r, len, 6, 12);
const GEO = {
  leg: capsule(0.1, 0.42),
  arm: capsule(0.068, 0.4),
  torso: capsule(0.23, 0.32),
  head: new THREE.SphereGeometry(0.2, 24, 18),
  hair: new THREE.SphereGeometry(0.212, 24, 12, 0, Math.PI * 2, 0, Math.PI * 0.55),
  eye: new THREE.SphereGeometry(0.026, 8, 6),
  hand: new THREE.SphereGeometry(0.075, 10, 8),
  shoe: new THREE.BoxGeometry(0.17, 0.08, 0.26),
  ring: new THREE.RingGeometry(0.42, 0.5, 40),
  disc: new THREE.CircleGeometry(0.42, 32),
  gem: new THREE.OctahedronGeometry(0.13, 0),
  badge: new THREE.CylinderGeometry(0.07, 0.07, 0.02, 16),
};

const mat = (color, extra = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.72, metalness: 0.02, ...extra });

const WALK_SPEED = 2.1;

export class Avatar {
  constructor(agent, { onLabelClick } = {}) {
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
    this.buildLabel(agent, onLabelClick);
  }

  m(color, extra) { const x = mat(color, extra); this.materials.push(x); return x; }

  build(a) {
    const shirt = new THREE.Color(agentColor(a));
    const pants = shirt.clone().lerp(new THREE.Color('#2a2f3a'), a.kind === 'main' ? 0.78 : 0.7);
    const skin = this.m(skinTone(a.id));
    const hair = this.m(hairTone(a.id));
    const shirtM = this.m(shirt);
    const pantsM = this.m(pants);
    const shoeM = this.m('#2a2c33');
    const eyeM = this.m('#1b1d22', { roughness: 0.3 });

    const body = new THREE.Group();
    this.body = body;
    this.group.add(body);

    // Beine mit Drehpunkt an der Hüfte
    const mkLeg = (x) => {
      const pivot = new THREE.Group();
      pivot.position.set(x, 0.72, 0);
      const leg = new THREE.Mesh(GEO.leg, pantsM);
      leg.position.y = -0.31;
      const shoe = new THREE.Mesh(GEO.shoe, shoeM);
      shoe.position.set(0, -0.68, 0.04);
      pivot.add(leg, shoe);
      body.add(pivot);
      return pivot;
    };
    this.legL = mkLeg(-0.12);
    this.legR = mkLeg(0.12);

    const torso = new THREE.Mesh(GEO.torso, shirtM);
    torso.position.y = 1.02;
    torso.scale.set(1, 1, 0.78);
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
    this.armL = mkArm(-0.31);
    this.armR = mkArm(0.31);

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

    // Abzeichen auf der Brust: Hauptagent orange Raute, Subagent Typfarbe
    if (a.kind === 'main') {
      const gem = new THREE.Mesh(GEO.gem, this.m('#d97757', { emissive: '#d97757', emissiveIntensity: 0.55, roughness: 0.35, metalness: 0.2 }));
      gem.position.y = 2.12;
      this.group.add(gem);
      this.gem = gem;
    } else {
      const badge = new THREE.Mesh(GEO.badge, this.m('#ffffff', { emissive: '#ffffff', emissiveIntensity: 0.25 }));
      badge.rotation.x = Math.PI / 2;
      badge.position.set(0.1, 1.12, 0.185);
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

  buildLabel(a, onClick) {
    const el = document.createElement('div');
    el.className = `tag ${a.kind}`;
    el.innerHTML = `<div class="bubble"></div><div class="tag-name"><i></i><span></span></div>`;
    el.addEventListener('pointerdown', (e) => { e.stopPropagation(); onClick?.(this.key); });
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

  leave(door) {
    if (this.leaving) return;
    this.leaving = true;
    this.walkTo([door]);
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

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
