/**
 * MATERIA — game engine
 * ---------------------------------------------------------------
 * One codebase, two modes:
 *
 *   ar   — real WebXR immersive-ar session. Hit-testing places collision
 *          proxies on real surfaces. Tagged proxies double as depth-only
 *          occluders, so spirits genuinely disappear behind your furniture.
 *
 *   sim  — a procedural 3D room using the identical physics and material
 *          system, so the same link works on iPhone and desktop where
 *          Safari still does not expose immersive-ar.
 *
 * Core mechanic: a thrown orb only harms a shielded spirit if it has been
 * CHARGED by ricocheting off a rigid surface (hard / glass / metal).
 * Soft surfaces absorb and discharge it. Knowing your room's materials
 * is therefore the skill the game tests.
 */

import * as THREE from 'three';
import { MATERIALS, MATERIAL_ORDER, getMaterial, materialFromSemanticLabel } from './materials.js';
import { PhysicsWorld, BoxCollider, PlaneCollider, v3, segPointDist2 } from './physics.js';

const MAX_TAGGED = 26;

/* ================================================================== *
 * DOM
 * ================================================================== */
const $ = (id) => document.getElementById(id);

const el = {
  canvas: $('gl'),
  start: $('startLayer'),
  over: $('overLayer'),
  hud: $('hud'),
  cross: $('cross'),
  toast: $('toast'),
  flash: $('flash'),
  banner: $('banner'),
  matbar: $('matbar'),
  btnAR: $('btnAR'),
  btnSim: $('btnSim'),
  btnPlay: $('btnPlay'),
  btnExit: $('btnExit'),
  btnRetry: $('btnRetry'),
  btnHome: $('btnHome'),
  arNote: $('arNote'),
  statScore: $('statScore'),
  statWave: $('statWave'),
  statShield: $('statShield'),
  statTags: $('statTags'),
  phaseChip: $('phaseChip'),
  finalScore: $('finalScore'),
  finalWave: $('finalWave'),
  finalBest: $('finalBest')
};

/* ================================================================== *
 * Renderer / scene
 * ================================================================== */
const renderer = new THREE.WebGLRenderer({
  canvas: el.canvas,
  antialias: true,
  alpha: true,
  powerPreference: 'high-performance'
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.xr.enabled = true;

const scene = new THREE.Scene();

const camera = new THREE.PerspectiveCamera(
  70, window.innerWidth / window.innerHeight, 0.01, 60
);
camera.position.set(0, 1.6, 0);

scene.add(new THREE.HemisphereLight(0xbcd0ff, 0x2a2340, 1.05));
const keyLight = new THREE.DirectionalLight(0xffffff, 0.85);
keyLight.position.set(2.5, 5, 2);
scene.add(keyLight);

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

/* ================================================================== *
 * Audio — tiny synth so each material sounds different
 * ================================================================== */
let actx = null;
function audio() {
  if (!actx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (AC) actx = new AC();
  }
  if (actx && actx.state === 'suspended') actx.resume();
  return actx;
}

function playThud(mat, intensity = 1) {
  const ac = audio();
  if (!ac || !mat.thud) return;
  const { freq, dur, type, gain } = mat.thud;
  const o = ac.createOscillator();
  const g = ac.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, ac.currentTime);
  o.frequency.exponentialRampToValueAtTime(
    Math.max(40, freq * (mat.charges ? 0.55 : 0.32)), ac.currentTime + dur
  );
  const peak = Math.min(0.4, gain * Math.min(1.6, intensity));
  g.gain.setValueAtTime(0.0001, ac.currentTime);
  g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), ac.currentTime + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + dur);
  o.connect(g).connect(ac.destination);
  o.start();
  o.stop(ac.currentTime + dur + 0.02);
}

function playTone(freq, dur = 0.16, type = 'sine', vol = 0.22) {
  const ac = audio();
  if (!ac) return;
  const o = ac.createOscillator();
  const g = ac.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, ac.currentTime);
  g.gain.setValueAtTime(0.0001, ac.currentTime);
  g.gain.exponentialRampToValueAtTime(vol, ac.currentTime + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + dur);
  o.connect(g).connect(ac.destination);
  o.start();
  o.stop(ac.currentTime + dur + 0.02);
}

/* ================================================================== *
 * Game state
 * ================================================================== */
const physics = new PhysicsWorld();

const state = {
  mode: null,            // 'ar' | 'sim'
  phase: 'idle',         // 'tag' | 'play' | 'over'
  activeMaterial: 'soft',
  score: 0,
  wave: 0,
  shield: 3,
  combo: 0,
  comboTimer: 0,
  best: Number(localStorage.getItem('materia.best') || 0),
  floorY: 0,
  spawnTimer: 0,
  running: false
};

const tagged = [];    // { collider, group, occluder, materialId }
const spirits = [];
const orbMeshes = new Map();   // Orb -> { mesh, halo }
const bursts = [];

/* ================================================================== *
 * Visual helpers
 * ================================================================== */
function haloTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const rg = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  rg.addColorStop(0, 'rgba(255,255,255,1)');
  rg.addColorStop(0.35, 'rgba(255,255,255,0.55)');
  rg.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = rg;
  g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
const HALO = haloTexture();

/* -------------------------------------------- tagged object visuals */
function makeTaggedVisual(materialId, half) {
  const mat = getMaterial(materialId);
  const group = new THREE.Group();

  const geo = new THREE.BoxGeometry(half.x * 2, half.y * 2, half.z * 2);

  if (state.mode === 'sim') {
    // Simulator: draw real furniture.
    const solid = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
      color: mat.color,
      roughness: mat.absorb > 0.4 ? 0.95 : 0.25,
      metalness: materialId === 'metal' ? 0.85 : 0.05,
      transparent: materialId === 'glass',
      opacity: materialId === 'glass' ? 0.4 : 1
    }));
    group.add(solid);
  } else {
    // AR: a depth-only shell gives true occlusion of spirits behind
    // real furniture, while the player still sees the real world.
    const occl = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ colorWrite: false }));
    occl.renderOrder = -1;
    group.add(occl);
  }

  // Glowing edges so the player can see what they tagged in both modes.
  const edges = new THREE.LineSegments(
    new THREE.EdgesGeometry(geo),
    new THREE.LineBasicMaterial({ color: mat.color, transparent: true, opacity: 0.95 })
  );
  group.add(edges);

  // Soft things get a shield dome — that is the visual language of cover.
  if (mat.nest) {
    const dome = new THREE.Mesh(
      new THREE.SphereGeometry(Math.max(half.x, half.z) + 0.55, 18, 12),
      new THREE.MeshBasicMaterial({
        color: mat.color, transparent: true, opacity: 0.07,
        side: THREE.BackSide, depthWrite: false
      })
    );
    dome.position.y = half.y * 0.4;
    group.add(dome);
    group.userData.dome = dome;
  }

  group.userData.edges = edges;
  group.userData.materialId = materialId;
  return group;
}

function addTagged(position, half, materialId, yaw = 0) {
  if (tagged.length >= MAX_TAGGED) return null;

  const collider = new BoxCollider({
    center: v3(position.x, position.y, position.z),
    half: v3(half.x, half.y, half.z),
    yaw,
    material: materialId,
    id: 't' + tagged.length
  });
  physics.addCollider(collider);

  const group = makeTaggedVisual(materialId, half);
  group.position.set(position.x, position.y, position.z);
  group.rotation.y = yaw;
  scene.add(group);

  const rec = { collider, group, materialId };
  tagged.push(rec);
  updateHud();
  return rec;
}

/* -------------------------------------------------------- particles */
function burst(pos, color, count = 22, speed = 2.2, life = 0.7) {
  const g = new THREE.BufferGeometry();
  const p = new Float32Array(count * 3);
  const vel = [];
  for (let i = 0; i < count; i++) {
    p[i * 3] = pos.x; p[i * 3 + 1] = pos.y; p[i * 3 + 2] = pos.z;
    const th = Math.random() * Math.PI * 2;
    const ph = Math.acos(2 * Math.random() - 1);
    const s = speed * (0.35 + Math.random() * 0.75);
    vel.push(new THREE.Vector3(
      Math.sin(ph) * Math.cos(th) * s,
      Math.cos(ph) * s * 0.9 + 0.6,
      Math.sin(ph) * Math.sin(th) * s
    ));
  }
  g.setAttribute('position', new THREE.BufferAttribute(p, 3));
  const m = new THREE.PointsMaterial({
    color, size: 0.045, transparent: true, opacity: 1,
    blending: THREE.AdditiveBlending, depthWrite: false,
    map: HALO, sizeAttenuation: true
  });
  const pts = new THREE.Points(g, m);
  scene.add(pts);
  bursts.push({ pts, vel, life, max: life });
}

function ripple(pos, normal, color) {
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.03, 0.06, 26),
    new THREE.MeshBasicMaterial({
      color, transparent: true, opacity: 0.9,
      side: THREE.DoubleSide, depthWrite: false,
      blending: THREE.AdditiveBlending
    })
  );
  ring.position.set(pos.x, pos.y, pos.z);
  ring.lookAt(pos.x + normal.x, pos.y + normal.y, pos.z + normal.z);
  scene.add(ring);
  bursts.push({ ring, life: 0.45, max: 0.45 });
}

function updateFx(dt) {
  for (let i = bursts.length - 1; i >= 0; i--) {
    const b = bursts[i];
    b.life -= dt;
    const k = Math.max(0, b.life / b.max);

    if (b.pts) {
      const arr = b.pts.geometry.attributes.position.array;
      for (let j = 0; j < b.vel.length; j++) {
        b.vel[j].y -= 5.2 * dt;
        arr[j * 3] += b.vel[j].x * dt;
        arr[j * 3 + 1] += b.vel[j].y * dt;
        arr[j * 3 + 2] += b.vel[j].z * dt;
      }
      b.pts.geometry.attributes.position.needsUpdate = true;
      b.pts.material.opacity = k;
    }

    if (b.ring) {
      const s = 1 + (1 - k) * 7;
      b.ring.scale.setScalar(s);
      b.ring.material.opacity = k * 0.9;
    }

    if (b.life <= 0) {
      if (b.pts) { scene.remove(b.pts); b.pts.geometry.dispose(); b.pts.material.dispose(); }
      if (b.ring) { scene.remove(b.ring); b.ring.geometry.dispose(); b.ring.material.dispose(); }
      bursts.splice(i, 1);
    }
  }
}

/* ================================================================== *
 * Spirits
 * ================================================================== */
function makeSpirit(pos) {
  const group = new THREE.Group();

  const core = new THREE.Mesh(
    new THREE.IcosahedronGeometry(0.11, 1),
    new THREE.MeshStandardMaterial({
      color: 0xff7ad9, emissive: 0xff4fc0,
      emissiveIntensity: 1.5, roughness: 0.35, flatShading: true
    })
  );
  group.add(core);

  const halo = new THREE.Sprite(new THREE.SpriteMaterial({
    map: HALO, color: 0xff86dd, transparent: true,
    blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0.75
  }));
  halo.scale.setScalar(0.6);
  group.add(halo);

  const shield = new THREE.Mesh(
    new THREE.SphereGeometry(0.2, 16, 12),
    new THREE.MeshBasicMaterial({
      color: 0xa98bff, transparent: true, opacity: 0.3,
      wireframe: true, depthWrite: false
    })
  );
  shield.visible = false;
  group.add(shield);

  group.position.set(pos.x, pos.y, pos.z);
  scene.add(group);

  spirits.push({
    group, core, halo, shield,
    pos: new THREE.Vector3(pos.x, pos.y, pos.z),
    vel: new THREE.Vector3(0, 0, 0),
    hp: 2,
    shielded: false,
    phase: Math.random() * Math.PI * 2,
    speed: 0.32 + Math.random() * 0.22,
    alive: true
  });
}

function killSpirit(s, charged) {
  s.alive = false;
  scene.remove(s.group);
  burst(s.pos, charged ? 0x6fe3ff : 0xff7ad9, charged ? 34 : 20, charged ? 3.1 : 2.0, 0.8);
  playTone(charged ? 880 : 560, 0.22, 'triangle', 0.24);

  state.combo++;
  state.comboTimer = 2.6;
  const gain = (charged ? 250 : 100) * Math.max(1, state.combo);
  state.score += gain;

  toast(charged
    ? `ارتداد مشحون! +${gain}${state.combo > 1 ? ` ×${state.combo}` : ''}`
    : `إصابة +${gain}${state.combo > 1 ? ` ×${state.combo}` : ''}`);

  flash(charged ? 0.5 : 0.25);
  updateHud();
}

/** A spirit near any soft/carpet collider is shielded: only charged orbs hurt it. */
function updateSpiritShields() {
  const nests = tagged.filter((t) => getMaterial(t.materialId).nest);
  for (const s of spirits) {
    if (!s.alive) continue;
    let shielded = false;
    for (const n of nests) {
      const c = n.collider.center;
      const r = Math.max(n.collider.half.x, n.collider.half.z) + 0.62;
      const dx = s.pos.x - c.x, dy = s.pos.y - c.y, dz = s.pos.z - c.z;
      if (dx * dx + dy * dy + dz * dz < r * r) { shielded = true; break; }
    }
    s.shielded = shielded;
    s.shield.visible = shielded;
    s.core.material.emissive.setHex(shielded ? 0xa98bff : 0xff4fc0);
  }
}

function updateSpirits(dt, playerPos) {
  const nests = tagged.filter((t) => getMaterial(t.materialId).nest);

  for (const s of spirits) {
    if (!s.alive) continue;
    s.phase += dt * 2.4;

    // Steer toward the nearest soft object if one exists, otherwise the player.
    let target = playerPos;
    if (nests.length) {
      let bestD = Infinity, bestC = null;
      for (const n of nests) {
        const c = n.collider.center;
        const d = (s.pos.x - c.x) ** 2 + (s.pos.z - c.z) ** 2;
        if (d < bestD) { bestD = d; bestC = c; }
      }
      // Once nested, drift lazily around the player instead of stacking up.
      target = bestD > 0.7 ? new THREE.Vector3(bestC.x, bestC.y + 0.35, bestC.z) : playerPos;
    }

    const dir = new THREE.Vector3().subVectors(target, s.pos);
    const dist = dir.length();
    if (dist > 0.001) dir.divideScalar(dist);

    s.vel.lerp(dir.multiplyScalar(s.speed), 1 - Math.pow(0.001, dt));
    s.pos.addScaledVector(s.vel, dt);
    s.pos.y += Math.sin(s.phase) * 0.16 * dt;
    s.pos.y = Math.max(state.floorY + 0.25, Math.min(state.floorY + 2.1, s.pos.y));

    s.group.position.copy(s.pos);
    s.core.rotation.x += dt * 1.1;
    s.core.rotation.y += dt * 1.5;
    const pulse = 1 + Math.sin(s.phase * 1.6) * 0.12;
    s.halo.scale.setScalar(0.6 * pulse);
    s.shield.rotation.y += dt * 1.8;

    // Reaching the player costs a shield point.
    if (s.pos.distanceTo(playerPos) < 0.55) {
      s.alive = false;
      scene.remove(s.group);
      burst(s.pos, 0xff5f5f, 26, 2.4, 0.6);
      state.shield--;
      state.combo = 0;
      flash(0.7, '#ff5555');
      playTone(150, 0.3, 'sawtooth', 0.28);
      toast(state.shield > 0 ? `تسللت روح! دروعك ${state.shield}` : 'انتهت دروعك');
      updateHud();
      if (state.shield <= 0) gameOver();
    }
  }

  for (let i = spirits.length - 1; i >= 0; i--) if (!spirits[i].alive) spirits.splice(i, 1);
}

/* ================================================================== *
 * Orbs
 * ================================================================== */
function launchOrb(origin, dir, power = 9.6) {
  audio();
  // Only a slight upward bias — a flat shot makes the crosshair trustworthy.
  const orb = physics.spawnOrb(
    v3(origin.x, origin.y, origin.z),
    v3(dir.x * power, dir.y * power + 0.35, dir.z * power),
    0.05
  );

  const mesh = new THREE.Mesh(
    new THREE.SphereGeometry(0.05, 16, 12),
    new THREE.MeshStandardMaterial({
      color: 0xffffff, emissive: 0x8fd8ff,
      emissiveIntensity: 1.4, roughness: 0.2
    })
  );
  const halo = new THREE.Sprite(new THREE.SpriteMaterial({
    map: HALO, color: 0x8fd8ff, transparent: true,
    blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0.85
  }));
  halo.scale.setScalar(0.3);
  mesh.add(halo);
  scene.add(mesh);
  orbMeshes.set(orb, { mesh, halo });

  playTone(430, 0.09, 'sine', 0.14);
  return orb;
}

function syncOrbs() {
  for (const [orb, vis] of orbMeshes) {
    if (!orb.alive) {
      scene.remove(vis.mesh);
      vis.mesh.geometry.dispose();
      vis.mesh.material.dispose();
      orbMeshes.delete(orb);
      continue;
    }
    vis.mesh.position.set(orb.pos.x, orb.pos.y, orb.pos.z);
    // Charged orbs read cyan-hot; discharged ones dim to violet.
    const c = orb.charged ? 0x6fe3ff : 0xb69bff;
    vis.mesh.material.emissive.setHex(c);
    vis.mesh.material.emissiveIntensity = orb.charged ? 2.6 : 1.1;
    vis.halo.material.color.setHex(c);
    vis.halo.scale.setScalar(orb.charged ? 0.5 : 0.3);
  }
}

/** Orb vs spirit — the rule that makes material knowledge matter. */
function checkOrbHits() {
  for (const orb of physics.orbs) {
    if (!orb.alive) continue;
    for (const s of spirits) {
      if (!s.alive) continue;
      // Swept test along this frame's travel, not a single point sample.
      const rr = (orb.radius + 0.19) ** 2;
      if (segPointDist2(orb.framePrev, orb.pos, s.pos) > rr) continue;

      if (s.shielded && !orb.charged) {
        // Bounces off harmlessly and teaches the mechanic.
        orb.vel = v3(-orb.vel.x * 0.5, Math.abs(orb.vel.y) * 0.4 + 1.2, -orb.vel.z * 0.5);
        ripple(orb.pos, v3(0, 1, 0), 0xa98bff);
        playTone(240, 0.1, 'square', 0.12);
        toast('محمية! ارتدّ عن سطح صلب أولاً');
        continue;
      }

      s.hp -= orb.charged ? 2 : 1;
      burst(s.pos, orb.charged ? 0x6fe3ff : 0xffffff, 12, 1.6, 0.5);
      orb.alive = false;
      if (s.hp <= 0) killSpirit(s, orb.charged);
      else playTone(700, 0.08, 'sine', 0.16);
      break;
    }
  }
}

/* ================================================================== *
 * Impact feedback — the moment the player feels the material
 * ================================================================== */
physics.onImpact = ({ point, normal, material, speed }) => {
  if (speed < 0.5) return;
  playThud(material, speed / 3);

  if (material.absorb > 0.4) {
    // Soft: a small muffled puff, no ring — visibly swallowed.
    burst(point, material.color, 9, 0.7, 0.5);
  } else {
    ripple(point, normal, material.color);
    burst(point, material.color, material.id === 'glass' ? 16 : 11, 1.9, 0.45);
  }
};

/* ================================================================== *
 * HUD
 * ================================================================== */
function buildMatBar() {
  el.matbar.innerHTML = '';
  MATERIAL_ORDER.forEach((id) => {
    const m = MATERIALS[id];
    const b = document.createElement('button');
    b.className = 'chip' + (id === state.activeMaterial ? ' on' : '');
    b.style.color = m.accent;
    b.innerHTML = `<span class="sw" style="background:${m.accent}"></span>${m.label}`;
    b.addEventListener('click', (ev) => {
      ev.stopPropagation();
      state.activeMaterial = id;
      [...el.matbar.children].forEach((c) => c.classList.remove('on'));
      b.classList.add('on');
      toast(`${m.label} — ارتداد ${m.restitution.toFixed(2)}`);
    });
    el.matbar.appendChild(b);
  });
}

function updateHud() {
  el.statScore.textContent = state.score.toLocaleString('en-US');
  el.statWave.textContent = state.wave || '—';
  el.statShield.textContent = '◆'.repeat(Math.max(0, state.shield)) || '—';
  el.statTags.textContent = tagged.length;

  const tagging = state.phase === 'tag';
  el.matbar.style.display = tagging ? 'flex' : 'none';
  el.phaseChip.textContent = tagging ? 'وضع الوسم' : 'وضع اللعب';

  const soft = tagged.some((t) => getMaterial(t.materialId).nest);
  const rigid = tagged.some((t) => getMaterial(t.materialId).charges);
  el.btnPlay.disabled = !(soft && rigid);
  el.btnPlay.style.display = tagging ? 'inline-flex' : 'none';
}

let toastTimer = null;
function toast(msg) {
  el.toast.textContent = msg;
  el.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.toast.classList.remove('show'), 1700);
}

let bannerTimer = null;
function banner(msg, ms = 2600) {
  el.banner.textContent = msg;
  el.banner.classList.remove('hide');
  clearTimeout(bannerTimer);
  if (ms) bannerTimer = setTimeout(() => el.banner.classList.add('hide'), ms);
}

function flash(strength = 0.4, color = null) {
  if (color) {
    el.flash.style.background =
      `radial-gradient(ellipse at center, ${color}, transparent 70%)`;
  } else {
    el.flash.style.background =
      'radial-gradient(ellipse at center, rgba(255,255,255,.5), transparent 70%)';
  }
  el.flash.style.opacity = String(strength);
  setTimeout(() => { el.flash.style.opacity = '0'; }, 110);
}

/* ================================================================== *
 * Waves
 * ================================================================== */
function startWave() {
  state.wave++;
  const count = Math.min(3 + state.wave, 11);
  const player = getPlayerPosition();
  const px = player.x, pz = player.z;

  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2 + Math.random();
    const r = 1.7 + Math.random() * 1.6;
    let x = px + Math.cos(a) * r;
    let z = pz + Math.sin(a) * r;

    // Keep spawns inside the simulator's walls.
    if (state.mode === 'sim') {
      x = Math.max(-2.4, Math.min(2.4, x));
      z = Math.max(-2.4, Math.min(2.4, z));
    }

    makeSpirit({ x, y: state.floorY + 0.7 + Math.random() * 0.9, z });
  }

  banner(`الموجة ${state.wave} — ${count} أرواح`);
  playTone(320, 0.3, 'triangle', 0.2);
  updateHud();
}

function beginPlay() {
  state.phase = 'play';
  state.wave = 0;
  state.shield = 3;
  state.score = 0;
  state.combo = 0;
  updateHud();
  banner('اضغط على الشاشة لرمي كرة — ارتدّ عن الصلب لتشحنها', 4200);
  startWave();
}

function gameOver() {
  state.phase = 'over';
  state.running = false;

  if (state.score > state.best) {
    state.best = state.score;
    localStorage.setItem('materia.best', String(state.best));
  }

  el.finalScore.textContent = state.score.toLocaleString('en-US');
  el.finalWave.textContent = String(state.wave);
  el.finalBest.textContent = state.best.toLocaleString('en-US');

  el.hud.hidden = true;
  el.cross.hidden = true;
  el.over.hidden = false;

  if (state.mode === 'ar' && renderer.xr.getSession()) {
    renderer.xr.getSession().end().catch(() => {});
  }
}

/* ================================================================== *
 * Player position (mode-aware)
 * ================================================================== */
const _pp = new THREE.Vector3();
const _pd = new THREE.Vector3();

function getPlayerPosition() {
  if (state.mode === 'ar' && renderer.xr.isPresenting) {
    renderer.xr.getCamera().getWorldPosition(_pp);
  } else {
    camera.getWorldPosition(_pp);
  }
  return _pp;
}

function getPlayerDirection() {
  if (state.mode === 'ar' && renderer.xr.isPresenting) {
    renderer.xr.getCamera().getWorldDirection(_pd);
  } else {
    camera.getWorldDirection(_pd);
  }
  return _pd;
}

function shoot() {
  const p = getPlayerPosition().clone();
  const d = getPlayerDirection().clone().normalize();
  p.addScaledVector(d, 0.22);
  launchOrb(p, d);
}

/* ================================================================== *
 * SIMULATOR MODE
 * ================================================================== */
let simYaw = 0, simPitch = 0;

function buildSimRoom() {
  state.floorY = 0;

  const RW = 6, RD = 6, RH = 2.8;

  // Floor
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(RW, RD),
    new THREE.MeshStandardMaterial({ color: 0x2b2f3d, roughness: 0.9 })
  );
  floor.rotation.x = -Math.PI / 2;
  scene.add(floor);
  physics.addCollider(new PlaneCollider({
    point: v3(0, 0, 0), normal: v3(0, 1, 0), material: 'floor', id: 'floor'
  }));

  // Ceiling + four walls as physics planes (only walls get geometry).
  physics.addCollider(new PlaneCollider({
    point: v3(0, RH, 0), normal: v3(0, -1, 0), material: 'hard', id: 'ceil'
  }));

  const wallMat = new THREE.MeshStandardMaterial({
    color: 0x343a4d, roughness: 0.95, side: THREE.DoubleSide
  });
  const walls = [
    { p: [0, RH / 2, -RD / 2], r: [0, 0, 0],            n: v3(0, 0, 1),  w: RW },
    { p: [0, RH / 2, RD / 2],  r: [0, Math.PI, 0],      n: v3(0, 0, -1), w: RW },
    { p: [-RW / 2, RH / 2, 0], r: [0, Math.PI / 2, 0],  n: v3(1, 0, 0),  w: RD },
    { p: [RW / 2, RH / 2, 0],  r: [0, -Math.PI / 2, 0], n: v3(-1, 0, 0), w: RD }
  ];
  walls.forEach((w, i) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w.w, RH), wallMat);
    m.position.set(...w.p);
    m.rotation.set(...w.r);
    scene.add(m);
    physics.addCollider(new PlaneCollider({
      point: v3(...w.p), normal: w.n, material: 'hard', id: 'wall' + i
    }));
  });

  // Pre-furnished room — deliberately mixes soft cover with rigid ricochet faces.
  const furniture = [
    { pos: [-1.9, 0.42, -2.0], half: [0.95, 0.42, 0.42], mat: 'soft',   yaw: 0 },
    { pos: [-2.3, 0.92, -2.0], half: [0.32, 0.14, 0.20], mat: 'soft',   yaw: 0.3 },
    { pos: [-1.5, 0.92, -2.0], half: [0.32, 0.14, 0.20], mat: 'soft',   yaw: -0.2 },
    { pos: [ 1.9, 0.36, -1.6], half: [0.72, 0.36, 0.45], mat: 'hard',   yaw: 0.25 },
    { pos: [ 2.6, 1.05, 1.2],  half: [0.05, 0.75, 0.95], mat: 'glass',  yaw: 0 },
    { pos: [-2.6, 0.85, 1.8],  half: [0.22, 0.85, 0.55], mat: 'metal',  yaw: 0 },
    { pos: [ 0.4, 0.02, 1.5],  half: [1.25, 0.02, 0.90], mat: 'carpet', yaw: 0.1 },
    { pos: [ 1.2, 0.30, 2.4],  half: [0.55, 0.30, 0.30], mat: 'hard',   yaw: -0.4 }
  ];

  furniture.forEach((f) => {
    addTagged(
      { x: f.pos[0], y: f.pos[1], z: f.pos[2] },
      { x: f.half[0], y: f.half[1], z: f.half[2] },
      f.mat, f.yaw
    );
  });

  // Face the furnished half of the room (-Z), not the bare wall behind.
  camera.position.set(0, 1.6, 2.1);
  simYaw = 0;
  simPitch = -0.05;
  applySimLook();
}

function applySimLook() {
  simPitch = Math.max(-1.3, Math.min(1.3, simPitch));
  camera.rotation.set(0, 0, 0);
  camera.rotateY(simYaw);
  camera.rotateX(simPitch);
}

function bindSimControls() {
  let dragging = false, moved = 0, lastX = 0, lastY = 0, downT = 0;

  const down = (x, y) => {
    dragging = true; moved = 0; lastX = x; lastY = y; downT = performance.now();
  };
  const move = (x, y) => {
    if (!dragging) return;
    const dx = x - lastX, dy = y - lastY;
    lastX = x; lastY = y;
    moved += Math.abs(dx) + Math.abs(dy);
    simYaw -= dx * 0.005;
    simPitch -= dy * 0.005;
    applySimLook();
  };
  const up = () => {
    if (!dragging) return;
    dragging = false;
    // A short, low-movement press is a shot, not a look.
    if (moved < 12 && performance.now() - downT < 420 && state.phase === 'play') shoot();
  };

  el.canvas.addEventListener('pointerdown', (e) => down(e.clientX, e.clientY));
  el.canvas.addEventListener('pointermove', (e) => move(e.clientX, e.clientY));
  el.canvas.addEventListener('pointerup', up);
  el.canvas.addEventListener('pointercancel', () => { dragging = false; });

  window.addEventListener('keydown', (e) => {
    if (e.code === 'Space' && state.phase === 'play') { e.preventDefault(); shoot(); }
  });
}

/* ================================================================== *
 * AR MODE
 * ================================================================== */
let hitTestSource = null;
let localSpace = null;
let reticle = null;
let arFloorSet = false;
let lastUiTouch = 0;

function makeReticle() {
  const g = new THREE.RingGeometry(0.07, 0.09, 34).rotateX(-Math.PI / 2);
  const m = new THREE.MeshBasicMaterial({
    color: 0x6fe3ff, transparent: true, opacity: 0.95, side: THREE.DoubleSide
  });
  reticle = new THREE.Mesh(g, m);
  reticle.matrixAutoUpdate = false;
  reticle.visible = false;
  scene.add(reticle);

  const inner = new THREE.Mesh(
    new THREE.CircleGeometry(0.014, 20).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: 0xffffff })
  );
  reticle.add(inner);
}

async function startAR() {
  if (!navigator.xr) { toast('هذا المتصفح لا يدعم WebXR'); return; }

  let session = null;

  // Attempt 1: everything we want. Attempt 2: bare minimum, so a device that
  // rejects one optional/required feature still gets into AR rather than
  // failing silently.
  const attempts = [
    {
      requiredFeatures: ['hit-test', 'local'],
      optionalFeatures: ['dom-overlay', 'plane-detection', 'anchors', 'light-estimation'],
      domOverlay: { root: document.body }
    },
    {
      requiredFeatures: ['local'],
      optionalFeatures: ['hit-test', 'dom-overlay'],
      domOverlay: { root: document.body }
    }
  ];

  for (const opts of attempts) {
    try {
      session = await navigator.xr.requestSession('immersive-ar', opts);
      break;
    } catch (err) {
      diag.sessionError = (err && (err.name + ': ' + err.message)) || String(err);
      console.error('requestSession failed', opts, err);
    }
  }

  if (!session) {
    el.arNote.innerHTML =
      '<b style="color:#ff8f8f">فشل بدء جلسة الواقع المعزّز.</b><br>' +
      'الجهاز أبلغ أنه يدعمها لكنه رفض بدءها. أعد تحميل الصفحة وتأكد من ' +
      'السماح بصلاحية الكاميرا، وأن ARCore محدّث.' + diagLine();
    el.arNote.scrollIntoView({ behavior: 'smooth', block: 'center' });
    toast('تعذّر بدء الجلسة — اقرأ التفاصيل بالأسفل');
    return;
  }

  state.mode = 'ar';
  state.phase = 'tag';
  // Passthrough requires a fully transparent clear — a leftover background
  // colour from a previous simulator run would hide the real world.
  scene.background = null;
  renderer.setClearAlpha(0);
  clearWorld();

  await renderer.xr.setSession(session);

  localSpace = await session.requestReferenceSpace('local');

  // Hit-testing may be unavailable (attempt 2 above). Degrade gracefully
  // instead of throwing: tags then get placed a fixed distance ahead.
  try {
    const viewerSpace = await session.requestReferenceSpace('viewer');
    if (session.requestHitTestSource) {
      hitTestSource = await session.requestHitTestSource({ space: viewerSpace });
    }
  } catch (err) {
    hitTestSource = null;
    console.warn('hit-test unavailable, using fixed-distance placement', err);
  }

  makeReticle();

  session.addEventListener('select', () => {
    // Ignore the select that accompanies a HUD button press.
    if (performance.now() - lastUiTouch < 350) return;
    if (state.phase === 'tag') placeTagFromReticle();
    else if (state.phase === 'play') shoot();
  });

  session.addEventListener('end', () => {
    hitTestSource = null;
    if (state.phase !== 'over') resetToMenu();
  });

  el.start.hidden = true;
  el.hud.hidden = false;
  el.cross.hidden = true;
  buildMatBar();
  updateHud();
  banner('وجّه جوالك على سطح ثم اضغط لوسمه — تحتاج سطحاً طرياً وسطحاً صلباً', 5200);
  state.running = true;
  renderer.setAnimationLoop(loop);
}

function placeTagFromReticle() {
  const p = new THREE.Vector3();
  const q = new THREE.Quaternion();
  const s = new THREE.Vector3();

  if (reticle && reticle.visible) {
    reticle.matrix.decompose(p, q, s);
  } else if (!hitTestSource) {
    // No hit-testing on this device: drop the tag 1.2 m ahead of the camera.
    p.copy(getPlayerPosition()).addScaledVector(getPlayerDirection(), 1.2);
    q.identity();
  } else {
    toast('وجّه على سطح مستوٍ أولاً');
    return;
  }

  if (!arFloorSet) {
    state.floorY = p.y;
    physics.addCollider(new PlaneCollider({
      point: v3(0, p.y - 0.02, 0), normal: v3(0, 1, 0), material: 'floor', id: 'arfloor'
    }));
    arFloorSet = true;
  }

  const mid = state.activeMaterial;
  // Sensible default footprints per material class.
  const presets = {
    soft:   { x: 0.34, y: 0.13, z: 0.26 },
    carpet: { x: 0.60, y: 0.02, z: 0.45 },
    hard:   { x: 0.32, y: 0.20, z: 0.32 },
    glass:  { x: 0.30, y: 0.30, z: 0.03 },
    metal:  { x: 0.22, y: 0.30, z: 0.22 },
    floor:  { x: 0.60, y: 0.02, z: 0.60 }
  };
  const half = presets[mid] || presets.hard;

  const yaw = new THREE.Euler().setFromQuaternion(q, 'YXZ').y;
  addTagged({ x: p.x, y: p.y + half.y, z: p.z }, half, mid, yaw);

  const m = getMaterial(mid);
  ripple(v3(p.x, p.y + 0.01, p.z), v3(0, 1, 0), m.color);
  playThud(m, 1.1);
  toast(`تم وسم: ${m.label}`);
}

function updateHitTest(frame) {
  if (!hitTestSource || !localSpace || !reticle) return;
  if (state.phase !== 'tag') { reticle.visible = false; return; }

  const results = frame.getHitTestResults(hitTestSource);
  if (results.length) {
    const pose = results[0].getPose(localSpace);
    if (pose) {
      reticle.visible = true;
      reticle.matrix.fromArray(pose.transform.matrix);
      const m = getMaterial(state.activeMaterial);
      reticle.material.color.setHex(m.color);
    }
  } else {
    reticle.visible = false;
  }
}

/**
 * Auto-tagging from WebXR semantic labels when the runtime provides them.
 * This is the zero-tap path: on hardware that labels planes as "couch" or
 * "table" we map straight into a material bucket with no player input.
 */
const seenPlanes = new WeakSet();
function harvestPlanes(frame) {
  if (!frame.detectedPlanes || state.phase !== 'tag') return;
  frame.detectedPlanes.forEach((plane) => {
    if (seenPlanes.has(plane)) return;
    seenPlanes.add(plane);

    const label = plane.semanticLabel || plane.semanticType;
    const matId = materialFromSemanticLabel(label);
    if (!matId) return;

    const pose = frame.getPose(plane.planeSpace, localSpace);
    if (!pose) return;

    // Approximate the polygon extent with an axis-aligned footprint.
    let ex = 0.3, ez = 0.3;
    if (plane.polygon && plane.polygon.length) {
      let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
      for (const pt of plane.polygon) {
        minX = Math.min(minX, pt.x); maxX = Math.max(maxX, pt.x);
        minZ = Math.min(minZ, pt.z); maxZ = Math.max(maxZ, pt.z);
      }
      ex = Math.max(0.12, Math.min(1.6, (maxX - minX) / 2));
      ez = Math.max(0.12, Math.min(1.6, (maxZ - minZ) / 2));
    }

    const t = pose.transform.position;
    const yaw = new THREE.Euler().setFromQuaternion(
      new THREE.Quaternion(
        pose.transform.orientation.x, pose.transform.orientation.y,
        pose.transform.orientation.z, pose.transform.orientation.w
      ), 'YXZ'
    ).y;

    addTagged({ x: t.x, y: t.y + 0.06, z: t.z }, { x: ex, y: 0.06, z: ez }, matId, yaw);
    toast(`تعرّف تلقائي: ${getMaterial(matId).label}`);
  });
}

/* ================================================================== *
 * Main loop
 * ================================================================== */
let lastT = performance.now();

function loop(time, frame) {
  const now = time || performance.now();
  const dt = Math.min((now - lastT) / 1000, 1 / 20);
  lastT = now;

  if (frame) {
    updateHitTest(frame);
    harvestPlanes(frame);
  }

  if (state.running) {
    physics.step(dt);
    syncOrbs();

    if (state.phase === 'play') {
      updateSpiritShields();
      updateSpirits(dt, getPlayerPosition());

      // updateSpirits can end the run; never queue another wave after that.
      if (state.phase === 'play') {
        checkOrbHits();

        state.comboTimer -= dt;
        if (state.comboTimer <= 0 && state.combo) { state.combo = 0; updateHud(); }

        if (!spirits.length) {
          state.spawnTimer -= dt;
          if (state.spawnTimer <= 0) { startWave(); state.spawnTimer = 2.2; }
        } else {
          state.spawnTimer = 2.2;
        }
      }
    }

    // Gentle idle animation on tagged edges so the scene never feels frozen.
    const pulse = 0.72 + Math.sin(now * 0.0022) * 0.24;
    for (const t of tagged) {
      if (t.group.userData.edges) t.group.userData.edges.material.opacity = pulse;
      if (t.group.userData.dome) {
        t.group.userData.dome.material.opacity = 0.05 + Math.sin(now * 0.0016) * 0.03;
      }
    }
  }

  updateFx(dt);
  renderer.render(scene, camera);
}

/* ================================================================== *
 * Menu / lifecycle
 * ================================================================== */
function clearWorld() {
  physics.clearColliders();
  physics.orbs.length = 0;

  for (const [, vis] of orbMeshes) scene.remove(vis.mesh);
  orbMeshes.clear();

  for (const s of spirits) scene.remove(s.group);
  spirits.length = 0;

  for (const t of tagged) scene.remove(t.group);
  tagged.length = 0;

  for (const b of bursts) {
    if (b.pts) scene.remove(b.pts);
    if (b.ring) scene.remove(b.ring);
  }
  bursts.length = 0;

  // Remove simulator geometry (anything left that is a plain Mesh at root).
  for (let i = scene.children.length - 1; i >= 0; i--) {
    const c = scene.children[i];
    if (c.isMesh || c.isGroup) scene.remove(c);
  }

  reticle = null;
  arFloorSet = false;
  state.score = 0;
  state.wave = 0;
  state.shield = 3;
  state.combo = 0;
}

function resetToMenu() {
  state.running = false;
  state.phase = 'idle';
  state.mode = null;
  renderer.setAnimationLoop(null);
  clearWorld();
  el.hud.hidden = true;
  el.cross.hidden = true;
  el.over.hidden = true;
  el.start.hidden = false;
  renderer.setClearAlpha(1);
  scene.background = new THREE.Color(0x0a0a14);
  // Keep rendering so the menu backdrop is not a frozen frame.
  renderer.setAnimationLoop(() => renderer.render(scene, camera));
}

function startSim() {
  state.mode = 'sim';
  state.phase = 'tag';
  renderer.setClearAlpha(1);
  scene.background = new THREE.Color(0x0a0a14);

  clearWorld();
  buildSimRoom();

  el.start.hidden = true;
  el.hud.hidden = false;
  el.cross.hidden = false;
  buildMatBar();

  state.running = true;
  lastT = performance.now();
  renderer.setAnimationLoop(loop);

  // The simulator arrives pre-tagged, so it goes straight into play.
  beginPlay();
  banner('اسحب للنظر · اضغط ضغطة قصيرة للرمي · ارتدّ عن الصلب لتشحن الكرة', 5000);
}

/* ---------------------------------------------------- button wiring */
['pointerdown', 'touchstart'].forEach((evt) => {
  el.hud.addEventListener(evt, () => { lastUiTouch = performance.now(); }, { capture: true });
});

bindSimControls();

el.btnAR.addEventListener('click', () => {
  audio();
  if (!diag.supported) { showArHelp(); return; }
  startAR();
});
el.btnSim.addEventListener('click', () => { audio(); startSim(); });
el.btnPlay.addEventListener('click', (e) => { e.stopPropagation(); beginPlay(); });
el.btnExit.addEventListener('click', (e) => {
  e.stopPropagation();
  const s = renderer.xr.getSession();
  if (s) s.end().catch(() => {});
  else resetToMenu();
});
el.btnRetry.addEventListener('click', () => {
  el.over.hidden = true;
  if (state.mode === 'sim') startSim();
  else resetToMenu();
});
el.btnHome.addEventListener('click', () => { window.location.href = 'index.html'; });

/* ================================================================== *
 * Capability detection + self-diagnosis
 * ------------------------------------------------------------------
 * A disabled button that does nothing when tapped tells the player
 * nothing. So the AR button stays tappable always, and explains the
 * exact failing condition instead of silently ignoring the tap.
 * ================================================================== */
const diag = {
  secure: false,
  hasXR: false,
  supported: false,
  checkError: null,
  sessionError: null,
  ua: navigator.userAgent
};

function isIOS() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) ||
         (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

function isAndroid() { return /Android/i.test(navigator.userAgent); }

/** Human-readable reason AR is unavailable, plus the concrete fix. */
function arHelpHtml() {
  if (!diag.secure) {
    return '<b>السبب: الصفحة ليست على HTTPS.</b><br>' +
           'الواقع المعزّز يتطلب اتصالاً آمناً. افتح الموقع عبر رابط https.';
  }
  if (!diag.hasXR) {
    if (isIOS()) {
      return '<b>السبب: هذا جهاز Apple.</b><br>' +
             'متصفح Safari لا يوفّر <code>WebXR</code> للواقع المعزّز حتى الآن، ' +
             'ولا يمكن لأي متصفح على iOS تجاوز ذلك. استخدم وضع المحاكاة.';
    }
    return '<b>السبب: هذا المتصفح لا يدعم WebXR إطلاقاً.</b><br>' +
           'على أندرويد استخدم <b>Google Chrome</b> (مو متصفح سامسونج أو براوزر آخر). ' +
           'على نظارة Quest استخدم متصفح Meta.';
  }
  if (!diag.supported) {
    if (isAndroid()) {
      return '<b>السبب: جهازك يدعم WebXR لكن ليس جلسة الواقع المعزّز.</b><br><br>' +
             'على أندرويد هذا يعني غالباً أن تطبيق <b>«خدمات Google Play للواقع المعزّز»</b> ' +
             '(ARCore) غير مثبّت أو غير محدّث. ثبّته من متجر Play ثم أعد تحميل الصفحة:<br>' +
             '<a href="https://play.google.com/store/apps/details?id=com.google.ar.core" ' +
             'target="_blank" rel="noopener" style="color:#6fe3ff">تثبيت ARCore من متجر Play</a>' +
             '<br><br>إذا كان مثبّتاً فعلاً، فجهازك قد لا يكون من الأجهزة المعتمدة لـ ARCore، ' +
             'وفي هذي الحالة الواقع المعزّز لن يعمل عليه نهائياً.' +
             (diag.checkError ? `<br><br><small>رسالة الفحص: ${diag.checkError}</small>` : '');
    }
    return '<b>السبب: المتصفح يدعم WebXR لكنه لا يوفّر جلسة واقع معزّز.</b><br>' +
           'أنت على كمبيوتر على الأغلب — الواقع المعزّز يحتاج جوال أندرويد أو نظارة.' +
           (diag.checkError ? `<br><br><small>رسالة الفحص: ${diag.checkError}</small>` : '');
  }
  return '<b>مدعوم.</b>';
}

/** Compact technical readout the player can screenshot and send. */
function diagLine() {
  return `<small style="opacity:.75;display:block;margin-top:12px;direction:ltr;text-align:left;font-family:ui-monospace,monospace">` +
         `secure=${diag.secure} · xr=${diag.hasXR} · ar=${diag.supported}` +
         (diag.sessionError ? ` · err=${diag.sessionError}` : '') +
         `</small>`;
}

function showArHelp() {
  el.arNote.innerHTML = arHelpHtml() + diagLine();
  el.arNote.scrollIntoView({ behavior: 'smooth', block: 'center' });
  toast('الواقع المعزّز غير متاح — اقرأ السبب بالأسفل');
}

(async function detect() {
  diag.secure = window.isSecureContext;
  diag.hasXR = !!(navigator.xr && navigator.xr.isSessionSupported);

  if (diag.hasXR) {
    try {
      diag.supported = await navigator.xr.isSessionSupported('immersive-ar');
    } catch (e) {
      diag.supported = false;
      diag.checkError = (e && (e.name + ': ' + e.message)) || String(e);
    }
  }

  if (diag.supported) {
    el.btnAR.classList.add('rec');
    el.arNote.innerHTML = '✓ جهازك يدعم الواقع المعزّز الكامل — اضغط الزر لتدخل غرفتك.' + diagLine();
  } else {
    // Deliberately NOT disabled: tapping must explain itself.
    el.btnAR.classList.add('dim');
    el.btnSim.classList.add('rec');
    el.arNote.innerHTML =
      '<b style="color:#f0a95a">الواقع المعزّز غير متاح على هذا الجهاز.</b> ' +
      'اضغط الزر لمعرفة السبب بالتفصيل، أو استخدم وضع المحاكاة.' + diagLine();
  }

  // Idle render so the menu is not a black void.
  renderer.setAnimationLoop(() => renderer.render(scene, camera));
})();
