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
import {
  CameraReader, Recognizer, labelToMaterial,
  adoptEndpointFromUrl, getCloudEndpoint
} from './vision.js';

const MAX_TAGGED = 26;

/** Bumped on every deploy so the running build is identifiable on-screen. */
const BUILD = 12;

/** Picks up ?api=… once and remembers it for the cloud engine. */
const cloudEndpoint = adoptEndpointFromUrl();

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
  arStatus: $('arStatus'),
  btnTestVision: $('btnTestVision'),
  btnCollect: $('btnCollect'),
  btnCards: $('btnCards'),
  cardsLayer: $('cardsLayer'),
  cardsGrid: $('cardsGrid'),
  btnCardsClose: $('btnCardsClose'),
  finalScore: $('finalScore'),
  finalWave: $('finalWave'),
  finalBest: $('finalBest')
};

/* ================================================================== *
 * Renderer / scene
 * ================================================================== */
/**
 * The GL context is created explicitly with `xrCompatible: true`.
 * Otherwise three.js has to call gl.makeXRCompatible() inside setSession(),
 * which rejects on a number of Android devices — and that rejection is what
 * silently killed AR startup after the session had already been created.
 */
const glAttribs = {
  alpha: true,
  antialias: true,
  depth: true,
  stencil: false,
  xrCompatible: true,
  powerPreference: 'high-performance'
};
const glCtx = el.canvas.getContext('webgl2', glAttribs) ||
              el.canvas.getContext('webgl', glAttribs);

const renderer = new THREE.WebGLRenderer({
  canvas: el.canvas,
  context: glCtx || undefined,
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

    // Minted card: blooms to full size, rises, then fades away.
    if (b.card) {
      const t = 1 - k;
      const grow = Math.min(1, t * 3.2);
      b.card.scale.setScalar(0.2 + grow * 1.5);
      b.card.position.y = b.from.y + t * 0.45;
      b.card.rotation.z = Math.sin(t * 7) * 0.12;
      b.card.material.opacity = k < 0.35 ? k / 0.35 : 1;
      b.card.material.transparent = true;
      b.card.lookAt(getPlayerPosition());
    }

    if (b.life <= 0) {
      if (b.pts) { scene.remove(b.pts); b.pts.geometry.dispose(); b.pts.material.dispose(); }
      if (b.ring) { scene.remove(b.ring); b.ring.geometry.dispose(); b.ring.material.dispose(); }
      if (b.card) { scene.remove(b.card); b.card.geometry.dispose(); b.card.material.dispose(); }
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
 * IN-WORLD 3D UI
 * ------------------------------------------------------------------
 * The Meta Quest browser does not implement `dom-overlay`, so the entire
 * HTML HUD is invisible inside a headset — every control existed but could
 * not be seen or pressed. This panel is real geometry in the scene, aimed at
 * with the controller/hand ray, so it works wherever WebXR works.
 *
 * It is one textured plane rather than many button meshes: the ray gives a
 * UV, the UV gives a canvas row, the row is the button. Far less code and
 * nothing to keep in sync.
 * ================================================================== */
const UI_W = 520, UI_H = 878;      // canvas pixels
const UI_TOP = 238;                // status block height
const UI_ROW = 68;                 // row height
const UI_ROWS = 9;

const ui3d = {
  root: null,
  mesh: null,
  canvas: null,
  ctx: null,
  tex: null,
  hover: -1,
  active: false,
  cursor: null,
  rayLine: null,
  cardsOpen: false,
  cardsGroup: null,
  msg: 'وجّه على سطح واضغط لوسمه'
};

/**
 * Every action is an explicit row. Relying on the pinch gesture alone was a
 * mistake: the panel swallows any pinch whose ray crosses it, so gestures
 * silently disappeared. Buttons cannot be swallowed.
 */
const UI_ACTIONS = [
  { id: 'material' },
  { id: 'tag' },
  { id: 'card' },
  { id: 'test' },
  { id: 'engine' },
  { id: 'cards' },
  { id: 'play' },
  { id: 'recenter' },
  { id: 'exit' }
];

function uiRowLabel(i) {
  switch (UI_ACTIONS[i].id) {
    case 'material': return `المادة:  ${getMaterial(state.activeMaterial).label}`;
    case 'tag':      return 'وسم السطح المستهدف  ◈';
    case 'card':     return heldCard ? 'ارمِ البطاقة  ➤' : 'استدعِ بطاقة  ✦';
    case 'test':     return 'اختبر التعرف  ◎';
    case 'engine':   return recognizer.engine === 'cloud'
                       ? 'المحرك:  سحابي ☁'
                       : 'المحرك:  محلي CLIP';
    case 'cards':    return `بطاقاتي (${collection.length})  ▤`;
    case 'play':     return 'ابدأ الموجات  ▸';
    case 'recenter': return 'أعد تمركز اللوحة  ↺';
    case 'exit':     return 'خروج  ✕';
  }
  return '';
}

function uiRowEnabled(i) {
  const id = UI_ACTIONS[i].id;
  if (id === 'test') return cameraReader.available;
  if (id === 'engine') return !!getCloudEndpoint();
  if (id === 'tag') return vision.surface || !hitTestSource;
  if (id === 'cards') return collection.length > 0;
  if (id === 'play') {
    return tagged.some((t) => getMaterial(t.materialId).nest) &&
           tagged.some((t) => getMaterial(t.materialId).charges);
  }
  return true;
}

function drawUI3D() {
  const c = ui3d.ctx;
  if (!c) return;

  c.clearRect(0, 0, UI_W, UI_H);
  roundRect(c, 4, 4, UI_W - 8, UI_H - 8, 26);
  c.fillStyle = 'rgba(10,10,20,.93)';
  c.fill();
  c.lineWidth = 3;
  c.strokeStyle = 'rgba(169,139,255,.55)';
  c.stroke();

  /* ---- status block ---- */
  c.textAlign = 'right';
  c.textBaseline = 'middle';
  c.font = '800 30px Cairo, system-ui, sans-serif';
  c.fillStyle = '#ffffff';
  c.fillText('MATERIA', UI_W - 26, 42);

  c.font = '600 21px Cairo, system-ui, sans-serif';
  const lines = [
    ['سطح', vision.surface ? '✓ مكتشف' : '✗ غير موجود', vision.surface ? '#7de08a' : '#ff9d9d'],
    ['كاميرا', cameraReader.available ? '✓ متاحة' : '✗ غير متاحة',
      cameraReader.available ? '#7de08a' : '#ff9d9d'],
    ['نموذج',
      vision.model === 'ready' ? `✓ جاهز · ${recognizer.engine === 'cloud' ? 'سحابي' : 'CLIP'}` :
      vision.model === 'loading' ? `⏳ ${vision.pct}%` :
      vision.model === 'error' ? '✗ فشل' : '— لم يبدأ',
      vision.model === 'ready' ? '#7de08a' : vision.model === 'error' ? '#ff9d9d' : '#f0a95a'],
    ['تعرّف',
      vision.lastLabel ? `${vision.lastLabel} ${Math.round(vision.lastScore * 100)}%` : '— لا شيء',
      vision.lastLabel ? '#6fe3ff' : '#9b97b8']
  ];
  lines.forEach((ln, i) => {
    const y = 88 + i * 30;
    c.fillStyle = '#9b97b8';
    c.fillText(ln[0], UI_W - 26, y);
    c.fillStyle = ln[2];
    c.fillText(ln[1], UI_W - 130, y);
  });

  // Say plainly what a pinch will do right now — the gesture was ambiguous.
  c.font = '700 20px Cairo, system-ui, sans-serif';
  c.fillStyle = '#6fe3ff';
  const pinch = ui3d.hover >= 0
    ? `القرصة: اضغط «${uiRowLabel(ui3d.hover).split('  ')[0]}»`
    : heldCard ? 'القرصة: ارمِ البطاقة'
    : state.phase === 'play' ? 'القرصة: ارمِ كرة'
    : 'القرصة: وسم السطح المستهدف';
  c.fillText(pinch, UI_W - 26, 220);

  // Toasts and banners are DOM elements and therefore invisible in a headset,
  // so the latest message is mirrored here.
  if (ui3d.msg) {
    c.font = '600 19px Cairo, system-ui, sans-serif';
    c.fillStyle = '#f0a95a';
    let msg = ui3d.msg;
    while (msg.length > 4 && c.measureText(msg).width > UI_W - 60) msg = msg.slice(0, -2);
    if (msg !== ui3d.msg) msg += '…';
    c.fillText(msg, UI_W - 26, 196);
  }

  c.strokeStyle = 'rgba(255,255,255,.14)';
  c.lineWidth = 2;
  c.beginPath(); c.moveTo(20, UI_TOP - 8); c.lineTo(UI_W - 20, UI_TOP - 8); c.stroke();

  /* ---- buttons ---- */
  c.font = '700 25px Cairo, system-ui, sans-serif';
  for (let i = 0; i < UI_ROWS; i++) {
    const y = UI_TOP + i * UI_ROW;
    const on = uiRowEnabled(i);
    const hot = ui3d.hover === i;

    roundRect(c, 18, y + 5, UI_W - 36, UI_ROW - 10, 14);
    c.fillStyle = hot ? 'rgba(169,139,255,.30)' : 'rgba(255,255,255,.055)';
    c.fill();
    c.lineWidth = hot ? 3 : 1.5;
    c.strokeStyle = hot ? '#a98bff' : 'rgba(255,255,255,.13)';
    c.stroke();

    c.fillStyle = on ? (hot ? '#ffffff' : '#e8e4ff') : 'rgba(255,255,255,.32)';
    c.fillText(uiRowLabel(i), UI_W - 40, y + UI_ROW / 2);
  }

  if (ui3d.tex) ui3d.tex.needsUpdate = true;
}

function buildUI3D() {
  if (ui3d.root) return;

  ui3d.canvas = document.createElement('canvas');
  ui3d.canvas.width = UI_W;
  ui3d.canvas.height = UI_H;
  ui3d.ctx = ui3d.canvas.getContext('2d');

  ui3d.tex = new THREE.CanvasTexture(ui3d.canvas);
  ui3d.tex.colorSpace = THREE.SRGBColorSpace;

  const aspect = UI_H / UI_W;
  const w = 0.46;
  ui3d.mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(w, w * aspect),
    new THREE.MeshBasicMaterial({ map: ui3d.tex, transparent: true })
  );

  ui3d.root = new THREE.Group();
  ui3d.root.add(ui3d.mesh);
  scene.add(ui3d.root);

  // Ray + cursor so the player can see where they are pointing.
  const lineGeo = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -2.2)
  ]);
  ui3d.rayLine = new THREE.Line(lineGeo, new THREE.LineBasicMaterial({
    color: 0x6fe3ff, transparent: true, opacity: 0.5
  }));

  ui3d.cursor = new THREE.Mesh(
    new THREE.SphereGeometry(0.008, 12, 8),
    new THREE.MeshBasicMaterial({ color: 0x6fe3ff })
  );
  ui3d.cursor.visible = false;
  scene.add(ui3d.cursor);

  ui3d.active = true;
  recenterUI3D();
  drawUI3D();
}

/** Parks the panel in front of the player, slightly left and below centre. */
function recenterUI3D() {
  if (!ui3d.root) return;
  const p = getPlayerPosition().clone();
  const d = getPlayerDirection().clone();
  d.y = 0;
  if (d.lengthSq() < 1e-6) d.set(0, 0, -1);
  d.normalize();

  const right = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), d).normalize();
  const pos = p.clone().addScaledVector(d, 0.95).addScaledVector(right, 0.34);
  pos.y = p.y - 0.22;

  ui3d.root.position.copy(pos);
  ui3d.root.lookAt(p.x, p.y - 0.1, p.z);
}

const _ray = new THREE.Raycaster();
const _m4 = new THREE.Matrix4();

/**
 * XR controllers double as hand target-rays, so one path covers both.
 *
 * They MUST be added to the scene: three.js writes the pose into
 * controller.matrix, but matrixWorld is only recomputed for objects that are
 * part of the scene graph. Without this the ray silently fired from the world
 * origin instead of the player's hand.
 */
const pointers = [];
function setupPointers() {
  pointers.length = 0;
  for (let i = 0; i < 2; i++) {
    const c = renderer.xr.getController(i);
    c.userData.connected = false;
    c.addEventListener('connected', () => { c.userData.connected = true; });
    c.addEventListener('disconnected', () => { c.userData.connected = false; });
    scene.add(c);
    pointers.push(c);
  }
}

function getPointers() {
  if (!renderer.xr.isPresenting) return [];
  return pointers.filter((c) => c.userData.connected);
}

function updateUI3D() {
  if (!ui3d.active || !ui3d.mesh) return;

  let bestRow = -1;
  let bestPoint = null;

  for (const ptr of getPointers()) {
    _m4.identity().extractRotation(ptr.matrixWorld);
    const origin = new THREE.Vector3().setFromMatrixPosition(ptr.matrixWorld);
    const dir = new THREE.Vector3(0, 0, -1).applyMatrix4(_m4).normalize();
    _ray.set(origin, dir);

    const hits = _ray.intersectObject(ui3d.mesh, false);
    if (hits.length && hits[0].uv) {
      const py = (1 - hits[0].uv.y) * UI_H;
      if (py >= UI_TOP) {
        const row = Math.floor((py - UI_TOP) / UI_ROW);
        if (row >= 0 && row < UI_ROWS) { bestRow = row; bestPoint = hits[0].point; }
      }
      if (!bestPoint) bestPoint = hits[0].point;
    }

    // Attach the visible ray to whichever pointer exists.
    if (ui3d.rayLine.parent !== ptr) ptr.add(ui3d.rayLine);
  }

  if (bestPoint) {
    ui3d.cursor.position.copy(bestPoint);
    ui3d.cursor.visible = true;
  } else {
    ui3d.cursor.visible = false;
  }

  if (bestRow !== ui3d.hover) {
    ui3d.hover = bestRow;
    drawUI3D();
  }
}

/** @returns true when the select was consumed by the panel. */
function pressUI3D() {
  if (!ui3d.active || ui3d.hover < 0) return false;
  const row = ui3d.hover;
  if (!uiRowEnabled(row)) { toast('غير متاح الآن'); return true; }

  switch (UI_ACTIONS[row].id) {
    case 'material': {
      const i = MATERIAL_ORDER.indexOf(state.activeMaterial);
      state.activeMaterial = MATERIAL_ORDER[(i + 1) % MATERIAL_ORDER.length];
      toast(`المادة: ${getMaterial(state.activeMaterial).label}`);
      break;
    }
    case 'tag': placeTagFromReticle(); break;
    case 'card':
      // Summoning works in any phase — no hidden mode to discover first.
      if (heldCard) throwHeldCard();
      else summonCard();
      break;
    case 'test': testVision(); break;
    case 'engine':
      recognizer.engine = recognizer.engine === 'cloud' ? 'clip' : 'cloud';
      toast(recognizer.engine === 'cloud' ? 'المحرك: سحابي' : 'المحرك: محلي');
      break;
    case 'cards': toggleCards3D(); break;
    case 'play': beginPlay(); break;
    case 'recenter': recenterUI3D(); toast('تم تمركز اللوحة'); break;
    case 'exit': {
      const s = renderer.xr.getSession();
      if (s) s.end().catch(() => {});
      break;
    }
  }
  drawUI3D();
  return true;
}

/** Floating 3D gallery of minted cards, for headsets with no DOM. */
function toggleCards3D() {
  if (ui3d.cardsOpen) {
    if (ui3d.cardsGroup) { scene.remove(ui3d.cardsGroup); ui3d.cardsGroup = null; }
    ui3d.cardsOpen = false;
    return;
  }
  if (!collection.length) { toast('لا بطاقات بعد'); return; }

  const g = new THREE.Group();
  const p = getPlayerPosition().clone();
  const d = getPlayerDirection().clone(); d.y = 0; d.normalize();
  const right = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), d).normalize();

  const show = collection.slice(-8);
  show.forEach((data, i) => {
    const col = i % 4, rowN = Math.floor(i / 4);
    const m = makeCardMesh(data);
    m.scale.setScalar(1.5);
    const pos = p.clone()
      .addScaledVector(d, 1.15)
      .addScaledVector(right, (col - 1.5) * -0.26);
    pos.y = p.y + 0.16 - rowN * 0.34;
    m.position.copy(pos);
    m.lookAt(p);
    g.add(m);
  });

  scene.add(g);
  ui3d.cardsGroup = g;
  ui3d.cardsOpen = true;
  toast('اضغط «بطاقاتي» مرة ثانية للإغلاق');
}

/* ================================================================== *
 * CARDS
 * ------------------------------------------------------------------
 * A recognised real object becomes a collectible card. The loop:
 *   pinch/tap  -> summon a blank card into your hand
 *   pinch/tap  -> throw it
 *   it hits a recognised object -> capture animation -> card is minted
 *     carrying that object's name, material stats and camera snapshot.
 *
 * Throwing reuses the orb physics body; only the payload and visuals differ,
 * so collisions are already reported through physics.onImpact.
 * ================================================================== */
const collection = [];           // minted cards
let heldCard = null;             // { mesh } floating in front of the player

function roundRect(c, x, y, w, h, r) {
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}

/** Draws a real trading-card face onto a canvas. */
function makeCardCanvas(data) {
  const W = 340, H = 480;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const c = cv.getContext('2d');

  const mat = data.materialId ? getMaterial(data.materialId) : null;
  const accent = mat ? mat.accent : '#a98bff';

  const g = c.createLinearGradient(0, 0, W, H);
  g.addColorStop(0, '#161327');
  g.addColorStop(1, '#0a0913');
  roundRect(c, 6, 6, W - 12, H - 12, 26);
  c.fillStyle = g; c.fill();
  c.lineWidth = 4; c.strokeStyle = accent; c.stroke();

  // artwork
  roundRect(c, 26, 26, W - 52, 240, 16);
  c.save(); c.clip();
  if (data.thumb) {
    c.drawImage(data.thumb, 26, 26, W - 52, 240);
  } else {
    c.fillStyle = '#201d33'; c.fillRect(26, 26, W - 52, 240);
  }
  c.restore();
  c.lineWidth = 2; c.strokeStyle = accent + '99'; c.stroke();

  c.textAlign = 'center';
  c.fillStyle = '#ffffff';
  c.font = '700 30px Cairo, system-ui, sans-serif';
  c.fillText(data.name || 'مجهول', W / 2, 316);

  if (mat) {
    c.fillStyle = accent;
    c.font = '700 22px Cairo, system-ui, sans-serif';
    c.fillText(mat.label, W / 2, 352);
  }

  // stats
  c.font = '600 18px ui-monospace, monospace';
  c.textAlign = 'left';
  c.fillStyle = '#b9b4d8';
  if (mat) {
    c.fillText(`ارتداد   ${mat.restitution.toFixed(2)}`, 40, 396);
    c.fillText(`احتكاك  ${mat.friction.toFixed(2)}`, 40, 424);
    c.fillText(`امتصاص ${mat.absorb.toFixed(2)}`, 40, 452);
  }
  if (data.score) {
    c.textAlign = 'right';
    c.fillStyle = accent;
    c.fillText(`${Math.round(data.score * 100)}%`, W - 40, 396);
  }

  return cv;
}

function makeCardMesh(data) {
  const tex = new THREE.CanvasTexture(makeCardCanvas(data));
  tex.colorSpace = THREE.SRGBColorSpace;
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(0.15, 0.212),
    new THREE.MeshBasicMaterial({ map: tex, transparent: true, side: THREE.DoubleSide })
  );
  const glow = new THREE.Sprite(new THREE.SpriteMaterial({
    map: HALO,
    color: data.materialId ? getMaterial(data.materialId).color : 0xa98bff,
    transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0.5
  }));
  glow.scale.setScalar(0.34);
  mesh.add(glow);
  return mesh;
}

/** Blank card that has not captured anything yet. */
function summonCard() {
  if (heldCard) return;
  const mesh = makeCardMesh({ name: 'بطاقة فارغة', materialId: null, score: 0 });
  scene.add(mesh);
  heldCard = { mesh, born: performance.now() };
  playTone(660, 0.14, 'triangle', 0.18);
  toast('بطاقة في يدك — اضغط مرة ثانية لرميها');
}

/** Keeps the held card floating just below the line of sight. */
function updateHeldCard(dt) {
  if (!heldCard) return;
  const p = getPlayerPosition().clone();
  const d = getPlayerDirection().clone().normalize();
  const target = p.addScaledVector(d, 0.42);
  target.y -= 0.13;

  heldCard.mesh.position.lerp(target, 1 - Math.pow(0.0001, dt));
  heldCard.mesh.lookAt(getPlayerPosition());
  const t = (performance.now() - heldCard.born) / 1000;
  heldCard.mesh.rotateZ(Math.sin(t * 2) * 0.06);
}

function throwHeldCard() {
  if (!heldCard) return;
  const p = heldCard.mesh.position.clone();
  const d = getPlayerDirection().clone().normalize();

  scene.remove(heldCard.mesh);
  heldCard = null;

  const orb = physics.spawnOrb(v3(p.x, p.y, p.z),
    v3(d.x * 8.5, d.y * 8.5 + 0.5, d.z * 8.5), 0.06);
  orb.payload = { kind: 'card' };

  const mesh = makeCardMesh({ name: 'بطاقة', materialId: null, score: 0 });
  scene.add(mesh);
  orbMeshes.set(orb, { mesh, halo: null, isCard: true, spin: Math.random() * 6 + 6 });

  playTone(520, 0.1, 'sawtooth', 0.16);
}

/** Mints a card from a recognised object and plays the capture flourish. */
function mintCard(rec, atPos) {
  const data = {
    name: rec.name || getMaterial(rec.materialId).label,
    materialId: rec.materialId,
    score: rec.score || 0,
    thumb: rec.thumb || null,
    id: 'c' + (collection.length + 1) + '-' + Date.now()
  };
  collection.push(data);

  // Flourish: the card blooms out of the object and fades upward.
  const mesh = makeCardMesh(data);
  mesh.position.set(atPos.x, atPos.y, atPos.z);
  mesh.lookAt(getPlayerPosition());
  mesh.scale.setScalar(0.2);
  scene.add(mesh);
  bursts.push({ card: mesh, life: 1.5, max: 1.5, from: mesh.position.clone() });

  burst(atPos, getMaterial(rec.materialId).color, 30, 2.6, 0.9);
  flash(0.55);
  playTone(880, 0.16, 'triangle', 0.22);
  setTimeout(() => playTone(1320, 0.22, 'triangle', 0.18), 130);

  toast(`✦ بطاقة جديدة: ${data.name}`);
  updateCardCount();
}

function updateCardCount() {
  if (el.btnCards) {
    el.btnCards.textContent = `بطاقاتي (${collection.length}) ▤`;
    el.btnCards.style.display = 'inline-flex';
  }
}

function openCollection() {
  if (!el.cardsLayer) return;
  el.cardsGrid.innerHTML = '';
  if (!collection.length) {
    el.cardsGrid.innerHTML =
      '<p style="color:var(--muted);font-size:14.5px">لا بطاقات بعد. وسّم جسماً ليتعرّف عليه، ثم ارمِ بطاقة عليه.</p>';
  } else {
    for (const d of collection) {
      const img = document.createElement('img');
      img.src = makeCardCanvas(d).toDataURL('image/png');
      img.className = 'cardimg';
      img.alt = d.name;
      el.cardsGrid.appendChild(img);
    }
  }
  el.cardsLayer.hidden = false;
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

    // Thrown cards tumble instead of glowing.
    if (vis.isCard) {
      vis.mesh.rotation.x += 0.06 * vis.spin;
      vis.mesh.rotation.y += 0.04 * vis.spin;
      continue;
    }

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
physics.onImpact = ({ point, normal, material, speed, colliderId, orb }) => {
  // A thrown card landing on a recognised object mints that object's card.
  if (orb && orb.payload && orb.payload.kind === 'card' && colliderId) {
    const rec = tagged.find((t) => t.collider.id === colliderId);
    if (rec && !orb.payload.done) {
      orb.payload.done = true;
      orb.alive = false;
      mintCard(rec, point);
      return;
    }
  }

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
  // Keep the in-world panel in step with every state change.
  if (ui3d.active) drawUI3D();

  el.statScore.textContent = state.score.toLocaleString('en-US');
  el.statWave.textContent = state.wave || '—';
  el.statShield.textContent = '◆'.repeat(Math.max(0, state.shield)) || '—';
  el.statTags.textContent = tagged.length;

  const tagging = state.phase === 'tag';
  el.matbar.style.display = tagging ? 'flex' : 'none';
  el.phaseChip.textContent =
    state.phase === 'tag' ? 'وضع الوسم' :
    state.phase === 'collect' ? 'وضع البطاقات' : 'وضع اللعب';

  const soft = tagged.some((t) => getMaterial(t.materialId).nest);
  const rigid = tagged.some((t) => getMaterial(t.materialId).charges);
  el.btnPlay.disabled = !(soft && rigid);
  el.btnPlay.style.display = tagging ? 'inline-flex' : 'none';
  if (el.btnCollect) {
    el.btnCollect.style.display = tagging ? 'inline-flex' : 'none';
    el.btnCollect.disabled = !tagged.length;
  }
}

let toastTimer = null;
function toast(msg) {
  if (ui3d.active) { ui3d.msg = msg; drawUI3D(); }
  el.toast.textContent = msg;
  el.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.toast.classList.remove('show'), 1700);
}

let bannerTimer = null;
function banner(msg, ms = 2600) {
  if (ui3d.active) { ui3d.msg = msg; drawUI3D(); }
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

/**
 * One gesture, three meanings by phase. In card mode the first pinch summons
 * and the second throws — the same gesture works for a phone tap and a Quest
 * hand pinch, so no separate control scheme is needed.
 */
function onSelect() {
  // The in-world panel gets first refusal on every select.
  if (pressUI3D()) return;

  // Holding a card always means "throw it", whatever the phase.
  if (heldCard) { throwHeldCard(); return; }

  if (state.phase === 'tag') placeTagFromReticle();
  else if (state.phase === 'collect') summonCard();
  else if (state.phase === 'play') shoot();
}

function beginCollect() {
  const named = tagged.filter((t) => t.name).length;
  if (!tagged.length) { banner('وسّم جسماً واحداً على الأقل أولاً', 3200); return; }

  state.phase = 'collect';
  updateHud();
  banner(named
    ? 'اضغط لاستدعاء بطاقة، واضغط مرة ثانية لرميها على جسم تعرّف عليه'
    : 'لم يتعرّف على أي جسم بعد — البطاقة تُصنع فقط من جسم معروف الاسم', 5200);
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
    if (moved < 12 && performance.now() - downT < 420 &&
        (state.phase === 'play' || state.phase === 'collect')) onSelect();
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

/* ---------------------------------------------- object recognition */
const cameraReader = new CameraReader(renderer.getContext());

/**
 * Recognition status is kept in state and rendered into a permanent panel.
 * Toasts vanish in two seconds, which made it impossible to tell whether
 * recognition was working at all.
 */
const vision = {
  model: 'idle',        // idle | loading | ready | error
  pct: 0,
  lastLabel: null,
  lastScore: 0,
  lastMaterial: null,
  lastError: null,
  surface: false,
  noSurfaceSince: 0
};

const recognizer = new Recognizer((msg) => {
  const m = /(\d+)%/.exec(msg);
  if (m) { vision.model = 'loading'; vision.pct = Number(m[1]); }
  else if (msg.includes('جاهز')) vision.model = 'ready';
  else if (msg.includes('فشل')) vision.model = 'error';
  else if (msg.includes('تحميل')) vision.model = 'loading';
  renderArStatus();
});

// If a proxy is configured, prefer it — that is why the user set it.
if (cloudEndpoint) recognizer.engine = 'cloud';

const ST = (cls, txt) => `<span class="val ${cls}">${txt}</span>`;

function modelStatusHtml() {
  switch (vision.model) {
    case 'ready':   return ST('st-ok', '✓ جاهز' + (recognizer.device ? ` (${recognizer.device})` : ''));
    case 'loading': return ST('st-wait', `⏳ تحميل ${vision.pct}%`);
    case 'error':   return ST('st-bad', '✗ ' + (recognizer.error || 'فشل'));
    default:        return ST('st-wait', '— لم يبدأ');
  }
}

let lastStatusHtml = '';
function renderArStatus() {
  if (ui3d.active) drawUI3D();          // headset path
  if (!el.arStatus || state.mode !== 'ar') return;

  const camOk = cameraReader.available;
  const rows = [
    `<div class="row"><span class="lbl">سطح</span>${
      vision.surface ? ST('st-ok', '✓ مكتشف — اضغط للوسم')
                     : ST('st-bad', '✗ غير موجود')}</div>`,
    `<div class="row"><span class="lbl">كاميرا</span>${
      camOk ? ST('st-ok', '✓ متاحة')
            : ST('st-bad', '✗ ' + (cameraReader.lastError || 'غير متاحة'))}</div>`,
    `<div class="row"><span class="lbl">نموذج</span>${modelStatusHtml()}</div>`,
    `<div class="row"><span class="lbl">تعرّف</span>${
      vision.lastLabel
        ? ST('st-ok', `${vision.lastLabel} ${Math.round(vision.lastScore * 100)}%` +
            (vision.lastMaterial ? ` → ${getMaterial(vision.lastMaterial).label}` : ' (لا مادة)'))
        : vision.lastError
          ? ST('st-bad', vision.lastError)
          : ST('st-wait', '— لم يجرِ بعد')}</div>`
  ];

  if (!vision.surface) {
    rows.push('<div class="hint">حرّك الجوال ببطء يميناً ويساراً وأنت موجّه على سطح فيه تفاصيل (طاولة، سجادة، أرضية). الأسطح الملساء أو المعتمة لا تُكتشف.</div>');
  } else if (!camOk) {
    rows.push('<div class="hint">التعرف التلقائي غير متاح على هذا الجهاز — الوسم يدوي من الشرائط بالأسفل.</div>');
  }

  const html = rows.join('');
  if (html !== lastStatusHtml) {
    el.arStatus.innerHTML = html;
    lastStatusHtml = html;
  }
}

/** Runs recognition on the current view without placing anything. */
async function testVision() {
  if (state.mode !== 'ar') { toast('متاح داخل الواقع المعزّز فقط'); return; }
  if (!cameraReader.available) {
    vision.lastError = cameraReader.lastError || 'الكاميرا غير متاحة';
    renderArStatus();
    toast('الكاميرا غير متاحة على هذا الجهاز');
    return;
  }

  toast('يلتقط ويصنّف…');
  const crop = await requestCapture();
  if (!crop) {
    vision.lastError = 'التقاط: ' + (cameraReader.lastError || 'فشل');
    renderArStatus();
    return;
  }

  if (!recognizer.ready) {
    const ok = await recognizer.load();
    if (!ok) { vision.lastError = recognizer.error || 'فشل النموذج'; renderArStatus(); return; }
  }

  const res = await recognizer.classify(crop);
  if (!res) {
    vision.lastError = 'التصنيف فشل';
  } else {
    vision.lastLabel = res.label;
    vision.lastScore = res.score;
    vision.lastMaterial = res.material;
    vision.lastError = null;
    toast(`${res.label} ${Math.round(res.score * 100)}%`);
  }
  renderArStatus();
}

/**
 * The camera texture only exists inside the XR frame callback, so a tag tap
 * queues a request here and the next frame fulfils it.
 */
let captureRequest = null;   // { resolve }

function requestCapture() {
  return new Promise((resolve) => {
    captureRequest = { resolve };
    // Never hang the caller if no frame delivers a camera image.
    setTimeout(() => {
      if (captureRequest && captureRequest.resolve === resolve) {
        captureRequest = null;
        resolve(null);
      }
    }, 1200);
  });
}

function serviceCapture(frame) {
  if (!captureRequest || !localSpace) return;
  const req = captureRequest;
  captureRequest = null;
  const shot = cameraReader.capture(frame, localSpace);
  req.resolve(shot ? cameraReader.cropCentre(shot) : null);
}

/**
 * Places a provisional tag immediately (so the game stays responsive), then
 * upgrades its material once recognition finishes. Recognition is best-effort:
 * any failure just leaves the manually chosen material in place.
 */
async function recogniseAndRetag(rec) {
  if (!cameraReader.available) return;

  const crop = await requestCapture();
  if (!crop) {
    toast('تعذّر قراءة الكاميرا: ' + (cameraReader.lastError || 'غير معروف'));
    return;
  }

  if (!recognizer.ready) {
    const ok = await recognizer.load();
    if (!ok) { toast('فشل النموذج: ' + (recognizer.error || '')); return; }
  }

  const res = await recognizer.classify(crop);
  if (!res) {
    vision.lastError = 'التصنيف فشل';
    renderArStatus();
    toast('لم يتعرّف على الجسم');
    return;
  }

  vision.lastLabel = res.label;
  vision.lastScore = res.score;
  vision.lastMaterial = res.material;
  vision.lastError = null;
  renderArStatus();

  const pct = Math.round(res.score * 100);
  if (!tagged.includes(rec)) return;   // player already cleared the room

  // Remember the identity on the tag itself — this is what a card is minted
  // from later, and what the floating name label shows.
  rec.name = res.label;
  rec.score = res.score;
  rec.thumb = crop;

  if (res.material) retagMaterial(rec, res.material);
  attachNameLabel(rec);

  toast(res.material
    ? `${res.label} (${pct}%) → ${getMaterial(res.material).label}`
    : `${res.label} (${pct}%) — لا مادة مطابقة`);
}

/**
 * Floating name above a recognised object. Toasts disappear after two
 * seconds, which is why the name sometimes seemed missing — the label is
 * permanent and travels with the object.
 */
function attachNameLabel(rec) {
  if (!rec.name) return;
  if (rec.label) { rec.group.remove(rec.label); rec.label = null; }

  const mat = getMaterial(rec.materialId);
  const pad = 16, fs = 34;
  const probe = document.createElement('canvas').getContext('2d');
  probe.font = `700 ${fs}px Cairo, system-ui, sans-serif`;
  const txt = rec.name + (rec.score ? `  ${Math.round(rec.score * 100)}%` : '');
  const tw = Math.ceil(probe.measureText(txt).width);

  const cv = document.createElement('canvas');
  cv.width = tw + pad * 2;
  cv.height = fs + pad * 2;
  const c = cv.getContext('2d');

  roundRect(c, 0, 0, cv.width, cv.height, 16);
  c.fillStyle = 'rgba(8,8,16,.82)'; c.fill();
  c.lineWidth = 3; c.strokeStyle = mat.accent; c.stroke();

  c.fillStyle = '#ffffff';
  c.font = `700 ${fs}px Cairo, system-ui, sans-serif`;
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  c.fillText(txt, cv.width / 2, cv.height / 2 + 2);

  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({
    map: tex, transparent: true, depthWrite: false
  }));
  const h = 0.075;
  sp.scale.set(h * (cv.width / cv.height), h, 1);
  sp.position.y = rec.collider.half.y + 0.14;
  rec.group.add(sp);
  rec.label = sp;
}

/** Swaps a placed tag's material in both the physics body and the visuals. */
function retagMaterial(rec, materialId) {
  if (rec.materialId === materialId) return;
  rec.materialId = materialId;
  rec.collider.material = materialId;

  const half = rec.collider.half;
  scene.remove(rec.group);
  rec.group = makeTaggedVisual(materialId, half);
  rec.group.position.set(rec.collider.center.x, rec.collider.center.y, rec.collider.center.z);
  rec.group.rotation.y = rec.collider.yaw;
  scene.add(rec.group);
  rec.label = null;            // rebuilt by attachNameLabel with new colours

  updateHud();
}

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

/** Guards against a second tap while a request is still in flight. */
let arStarting = false;

function showArFailure(step) {
  el.arNote.innerHTML =
    '<b style="color:#ff8f8f">فشل بدء جلسة الواقع المعزّز.</b><br>' +
    `توقّف عند الخطوة: <code>${step}</code><br>` +
    'أعد تحميل الصفحة ثم اضغط الزر مرة واحدة فقط، وتأكد من السماح بصلاحية الكاميرا.' +
    diagLine();
  el.arNote.scrollIntoView({ behavior: 'smooth', block: 'center' });
  toast('تعذّر بدء الجلسة — اقرأ التفاصيل بالأسفل');
}

/**
 * Every step after requestSession is inside the try block on purpose.
 * A throw there used to escape as an unhandled rejection, leaving a live
 * XRSession with no UI attached — the session was running but nothing was
 * drawn, and the next tap then failed with InvalidStateError. Now any
 * failure is named, reported, and the session is always torn down.
 */
async function startAR() {
  if (arStarting) return;
  arStarting = true;

  let session = null;
  let step = 'init';

  try {
    if (!navigator.xr) throw new Error('WebXR غير مدعوم');

    // Kill any leftover session from a previous failed attempt.
    step = 'cleanup';
    const zombie = renderer.xr.getSession();
    if (zombie) {
      try { await zombie.end(); } catch { /* already dead */ }
      await new Promise((r) => setTimeout(r, 250));
    }

    // Attempt 1: everything we want. Attempt 2: bare minimum, so a device
    // that rejects one feature still gets in. Only retried while no session
    // exists — retrying after one was created is what caused InvalidStateError.
    step = 'requestSession';
    const attempts = [
      {
        requiredFeatures: ['hit-test', 'local'],
        optionalFeatures: [
          'dom-overlay', 'plane-detection', 'anchors',
          'light-estimation', 'camera-access'
        ],
        domOverlay: { root: document.body }
      },
      {
        requiredFeatures: ['hit-test', 'local'],
        optionalFeatures: ['dom-overlay', 'camera-access'],
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
    if (!session) throw new Error('رفض الجهاز بدء الجلسة');

    // From here on a session exists: any failure must end it.
    state.mode = 'ar';
    state.phase = 'tag';
    scene.background = null;      // passthrough needs a transparent clear
    renderer.setClearAlpha(0);
    // Stereo AR renders the scene twice, so a device pixel ratio of 2 on a
    // phone was a large part of the sluggish feel. 1.25 is plenty here.
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.25));
    clearWorld();

    /**
     * three.js defaults its reference space to 'local-floor', and many
     * handheld AR devices reject that type outright — setSession() then
     * throws NotSupportedError from requestReferenceSpace. 'local' and
     * 'viewer' are the types guaranteed for immersive sessions, and 'local'
     * is what we asked for in requiredFeatures, so try those in order.
     */
    step = 'setSession';
    let attached = false;
    for (const rs of ['local', 'viewer']) {
      try {
        renderer.xr.setReferenceSpaceType(rs);
        await renderer.xr.setSession(session);
        diag.refSpace = rs;
        attached = true;
        break;
      } catch (err) {
        diag.sessionError = `[setSession/${rs}] ` +
          ((err && (err.name + ': ' + err.message)) || String(err));
        console.error('setSession failed with reference space', rs, err);
      }
    }
    if (!attached) throw new Error('لا يدعم الجهاز أي نظام إحداثيات مناسب');

    // Use the same space type that actually attached.
    step = 'referenceSpace';
    localSpace = await session.requestReferenceSpace(diag.refSpace || 'local');

    // Hit-testing is optional: degrade to fixed-distance placement.
    step = 'hitTest';
    try {
      const viewerSpace = await session.requestReferenceSpace('viewer');
      if (session.requestHitTestSource) {
        hitTestSource = await session.requestHitTestSource({ space: viewerSpace });
      }
    } catch (err) {
      hitTestSource = null;
      console.warn('hit-test unavailable, using fixed-distance placement', err);
    }

    step = 'camera';
    // Recognition is a bonus, never a requirement: if camera-access was not
    // granted the game still runs with manual tagging.
    cameraReader.attach(session);
    diag.camera = cameraReader.available;
    // Warm the model up in the background so the first tag is not slow.
    if (cameraReader.available) recognizer.load();
    else vision.model = 'idle';

    step = 'scene';
    makeReticle();
    setupPointers();

    session.addEventListener('select', () => {
      // Ignore the select that accompanies a HUD button press.
      if (performance.now() - lastUiTouch < 350) return;
      onSelect();
    });

    session.addEventListener('end', () => {
      hitTestSource = null;
      if (state.phase !== 'over') resetToMenu();
    });

    step = 'ui';
    /**
     * `domOverlayState` is null when the runtime refused dom-overlay — that is
     * the Quest browser. In that case the HTML HUD is invisible, so the
     * in-world 3D panel becomes the only interface.
     */
    diag.domOverlay = !!session.domOverlayState;

    el.start.hidden = true;
    el.cross.hidden = true;

    if (diag.domOverlay) {
      el.hud.hidden = false;
      if (el.arStatus) el.arStatus.hidden = false;
      if (el.btnTestVision) el.btnTestVision.style.display = 'inline-flex';
      buildMatBar();
      renderArStatus();
      banner('وجّه على سطح ثم اضغط لوسمه — تحتاج سطحاً طرياً وسطحاً صلباً', 5200);
    } else {
      el.hud.hidden = true;              // would be invisible anyway
      buildUI3D();
    }

    updateHud();
    state.running = true;
    renderer.setAnimationLoop(loop);
  } catch (err) {
    diag.sessionError = `[${step}] ` +
      ((err && (err.name + ': ' + err.message)) || String(err));
    console.error('startAR failed at', step, err);

    // Never leave a live session behind with no UI attached.
    try {
      const s = renderer.xr.getSession() || session;
      if (s) await s.end();
    } catch { /* ignore */ }

    renderer.setAnimationLoop(null);
    state.running = false;
    state.mode = null;
    state.phase = 'idle';
    renderer.setClearAlpha(1);
    scene.background = new THREE.Color(0x0a0a14);
    el.start.hidden = false;
    el.hud.hidden = true;
    renderer.setAnimationLoop(() => renderer.render(scene, camera));

    showArFailure(step);
  } finally {
    arStarting = false;
  }
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
    // Actionable guidance instead of a vague instruction.
    banner('لا يوجد سطح مكتشف — حرّك الجوال ببطء يميناً ويساراً على سطح فيه تفاصيل', 4200);
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
  const rec = addTagged({ x: p.x, y: p.y + half.y, z: p.z }, half, mid, yaw);

  const m = getMaterial(mid);
  ripple(v3(p.x, p.y + 0.01, p.z), v3(0, 1, 0), m.color);
  playThud(m, 1.1);

  if (rec && cameraReader.available) {
    toast('يتعرّف على الجسم…');
    recogniseAndRetag(rec);      // fire and forget; upgrades the tag when done
  } else {
    toast(`تم وسم: ${m.label}`);
  }
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

  // Feed the status panel so the player can see surface detection live.
  if (vision.surface !== reticle.visible) {
    vision.surface = reticle.visible;
    renderArStatus();
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
    // Camera pixels must be read inside the frame callback.
    serviceCapture(frame);
    updateHitTest(frame);
    harvestPlanes(frame);
  }

  if (state.running) {
    physics.step(dt);
    syncOrbs();
    updateHeldCard(dt);
    updateUI3D();

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

  if (heldCard) { scene.remove(heldCard.mesh); heldCard = null; }

  if (ui3d.root) { scene.remove(ui3d.root); ui3d.root = null; ui3d.mesh = null; }
  if (ui3d.cursor) { scene.remove(ui3d.cursor); ui3d.cursor = null; }
  if (ui3d.cardsGroup) { scene.remove(ui3d.cardsGroup); ui3d.cardsGroup = null; }
  ui3d.active = false;
  ui3d.hover = -1;
  ui3d.cardsOpen = false;

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
  if (el.arStatus) el.arStatus.hidden = true;
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
if (el.btnTestVision) {
  el.btnTestVision.style.display = 'none';   // AR only
  el.btnTestVision.addEventListener('click', (e) => { e.stopPropagation(); testVision(); });
}
if (el.btnCollect) {
  el.btnCollect.addEventListener('click', (e) => { e.stopPropagation(); beginCollect(); });
}
if (el.btnCards) {
  el.btnCards.addEventListener('click', (e) => { e.stopPropagation(); openCollection(); });
}
if (el.btnCardsClose) {
  el.btnCardsClose.addEventListener('click', () => { el.cardsLayer.hidden = true; });
}
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
  refSpace: null,
  camera: null,
  domOverlay: null,
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
         `build=${BUILD} · secure=${diag.secure} · xr=${diag.hasXR} · ar=${diag.supported}` +
         (diag.refSpace ? ` · space=${diag.refSpace}` : '') +
         (diag.camera !== null ? ` · cam=${diag.camera}` : '') +
         (diag.domOverlay !== null ? ` · dom=${diag.domOverlay}` : '') +
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

  // Always tappable, whatever the outcome.
  el.btnAR.disabled = false;

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
