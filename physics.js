/**
 * MATERIA — Compact deterministic physics
 * ---------------------------------------------------------------
 * Deliberately hand-rolled instead of pulling a WASM engine from a CDN:
 * the only shapes we need are spheres (orbs) against oriented boxes
 * (tagged real-world objects) and infinite planes (floor / walls).
 * That is ~200 lines, has zero download cost, and cannot fail to boot.
 *
 * Units: metres, seconds. Right-handed, Y up — same as WebXR and three.js.
 */

import { getMaterial } from './materials.js';

const GRAVITY = -9.81;

/* ------------------------------------------------------------------ *
 * Minimal vector helpers (plain objects, no allocation-heavy classes)
 * ------------------------------------------------------------------ */
const v3 = (x = 0, y = 0, z = 0) => ({ x, y, z });
const add = (a, b) => v3(a.x + b.x, a.y + b.y, a.z + b.z);
const sub = (a, b) => v3(a.x - b.x, a.y - b.y, a.z - b.z);
const scale = (a, s) => v3(a.x * s, a.y * s, a.z * s);
const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
const len = (a) => Math.hypot(a.x, a.y, a.z);
const norm = (a) => {
  const l = len(a) || 1;
  return v3(a.x / l, a.y / l, a.z / l);
};

export { v3, add, sub, scale, dot, len, norm };

/**
 * Squared distance from point p to the segment a->b.
 * Used for swept hit tests: a fast-moving orb is a segment, not a point.
 */
export function segPointDist2(a, b, p) {
  const abx = b.x - a.x, aby = b.y - a.y, abz = b.z - a.z;
  const apx = p.x - a.x, apy = p.y - a.y, apz = p.z - a.z;
  const ab2 = abx * abx + aby * aby + abz * abz;
  let t = ab2 > 1e-9 ? (apx * abx + apy * aby + apz * abz) / ab2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const dx = apx - abx * t, dy = apy - aby * t, dz = apz - abz * t;
  return dx * dx + dy * dy + dz * dz;
}

/* ------------------------------------------------------------------ *
 * Colliders
 * ------------------------------------------------------------------ */

/** Infinite plane: points with dot(normal, p - point) >= 0 are outside. */
export class PlaneCollider {
  constructor({ point, normal, material = 'floor', id = null }) {
    this.kind = 'plane';
    this.point = point;
    this.normal = norm(normal);
    this.material = material;
    this.id = id;
    this.enabled = true;
  }
}

/**
 * Oriented box. Rotation is stored as a yaw angle only — real furniture is
 * effectively axis-aligned around the vertical, and yaw-only keeps the
 * closest-point test cheap and numerically stable.
 */
export class BoxCollider {
  constructor({ center, half, yaw = 0, material = 'hard', id = null }) {
    this.kind = 'box';
    this.center = center;
    this.half = half;              // {x,y,z} half-extents
    this.yaw = yaw;
    this.material = material;
    this.id = id;
    this.enabled = true;
    this._cos = Math.cos(-yaw);
    this._sin = Math.sin(-yaw);
  }

  setYaw(yaw) {
    this.yaw = yaw;
    this._cos = Math.cos(-yaw);
    this._sin = Math.sin(-yaw);
  }

  /** World point -> box local space. */
  toLocal(p) {
    const d = sub(p, this.center);
    return v3(d.x * this._cos - d.z * this._sin, d.y, d.x * this._sin + d.z * this._cos);
  }

  /** Box local vector -> world space. */
  toWorldDir(l) {
    const c = Math.cos(this.yaw), s = Math.sin(this.yaw);
    return v3(l.x * c - l.z * s, l.y, l.x * s + l.z * c);
  }

  containsPoint(p, pad = 0) {
    const l = this.toLocal(p);
    return Math.abs(l.x) <= this.half.x + pad &&
           Math.abs(l.y) <= this.half.y + pad &&
           Math.abs(l.z) <= this.half.z + pad;
  }
}

/* ------------------------------------------------------------------ *
 * Dynamic bodies
 * ------------------------------------------------------------------ */
export class Orb {
  constructor({ pos, vel, radius = 0.045 }) {
    this.pos = pos;
    this.vel = vel;
    this.radius = radius;
    // Position at the start of the current frame. Gameplay hit tests sweep
    // framePrev -> pos so a fast orb cannot tunnel through a target.
    this.framePrev = v3(pos.x, pos.y, pos.z);
    this.alive = true;
    this.charged = false;   // gained by ricocheting off a hard/glass/metal face
    this.bounces = 0;
    this.age = 0;
    this.energy = 1;        // drained by soft contacts; orb dies at ~0
    this.trail = [];
  }
}

/* ------------------------------------------------------------------ *
 * World
 * ------------------------------------------------------------------ */
export class PhysicsWorld {
  constructor() {
    this.colliders = [];
    this.orbs = [];
    this.onImpact = null;   // ({ point, normal, material, speed, orb }) => void
    this.substeps = 3;
    this.maxOrbs = 40;
  }

  addCollider(c) { this.colliders.push(c); return c; }

  removeCollider(c) {
    const i = this.colliders.indexOf(c);
    if (i >= 0) this.colliders.splice(i, 1);
  }

  clearColliders() { this.colliders.length = 0; }

  spawnOrb(pos, vel, radius) {
    if (this.orbs.length >= this.maxOrbs) this.orbs.shift();
    const orb = new Orb({ pos, vel, radius });
    this.orbs.push(orb);
    return orb;
  }

  step(dt) {
    // Clamp dt so a backgrounded tab cannot tunnel every orb through a wall.
    dt = Math.min(dt, 1 / 30);

    for (const o of this.orbs) {
      o.framePrev.x = o.pos.x; o.framePrev.y = o.pos.y; o.framePrev.z = o.pos.z;
    }

    const h = dt / this.substeps;
    for (let s = 0; s < this.substeps; s++) this._substep(h);
    this.orbs = this.orbs.filter((o) => o.alive);
  }

  _substep(h) {
    for (const orb of this.orbs) {
      if (!orb.alive) continue;

      orb.age += h;
      orb.vel.y += GRAVITY * h;

      // Mild air drag keeps long ricochet chains from feeling floaty.
      const drag = 1 - 0.06 * h;
      orb.vel = scale(orb.vel, drag);

      orb.pos = add(orb.pos, scale(orb.vel, h));

      for (const c of this.colliders) {
        if (!c.enabled) continue;
        if (c.kind === 'plane') this._resolvePlane(orb, c);
        else this._resolveBox(orb, c);
        if (!orb.alive) break;
      }

      if (orb.age > 8 || orb.energy <= 0.05) orb.alive = false;
      // Escaped the play space entirely.
      if (orb.pos.y < -6 || Math.abs(orb.pos.x) > 40 || Math.abs(orb.pos.z) > 40) {
        orb.alive = false;
      }
    }
  }

  _resolvePlane(orb, plane) {
    const dist = dot(sub(orb.pos, plane.point), plane.normal);
    if (dist > orb.radius) return;
    const pen = orb.radius - dist;
    orb.pos = add(orb.pos, scale(plane.normal, pen));
    this._bounce(orb, plane.normal, plane.material, plane.id);
  }

  _resolveBox(orb, box) {
    const l = box.toLocal(orb.pos);
    const h = box.half;

    // Closest point on the box to the sphere centre, in local space.
    const cx = Math.max(-h.x, Math.min(h.x, l.x));
    const cy = Math.max(-h.y, Math.min(h.y, l.y));
    const cz = Math.max(-h.z, Math.min(h.z, l.z));

    const dx = l.x - cx, dy = l.y - cy, dz = l.z - cz;
    const d2 = dx * dx + dy * dy + dz * dz;

    let nLocal, pen;

    if (d2 > 1e-9) {
      // Sphere centre is outside the box.
      const d = Math.sqrt(d2);
      if (d > orb.radius) return;
      nLocal = v3(dx / d, dy / d, dz / d);
      pen = orb.radius - d;
    } else {
      // Centre is inside: push out along the axis of least penetration.
      const ox = h.x - Math.abs(l.x);
      const oy = h.y - Math.abs(l.y);
      const oz = h.z - Math.abs(l.z);
      if (ox <= oy && ox <= oz) {
        nLocal = v3(Math.sign(l.x) || 1, 0, 0); pen = ox + orb.radius;
      } else if (oy <= oz) {
        nLocal = v3(0, Math.sign(l.y) || 1, 0); pen = oy + orb.radius;
      } else {
        nLocal = v3(0, 0, Math.sign(l.z) || 1); pen = oz + orb.radius;
      }
    }

    const nWorld = norm(box.toWorldDir(nLocal));
    orb.pos = add(orb.pos, scale(nWorld, pen));
    this._bounce(orb, nWorld, box.material, box.id);
  }

  /**
   * Shared response: split velocity into normal + tangent, apply the
   * material's restitution to the normal part and friction to the tangent.
   * This is where "the pillow eats the ball and the table ricochets it"
   * actually happens.
   */
  _bounce(orb, n, materialId, colliderId) {
    const vn = dot(orb.vel, n);
    if (vn > 0) return;                 // already separating

    const mat = getMaterial(materialId);
    const speed = Math.abs(vn);

    const normalV = scale(n, vn);
    const tangentV = sub(orb.vel, normalV);

    const reflected = scale(n, -vn * mat.restitution);
    const slowedTangent = scale(tangentV, 1 - mat.friction * 0.5);

    orb.vel = add(reflected, slowedTangent);
    orb.bounces++;
    orb.energy = Math.max(0, orb.energy - mat.absorb * Math.min(1, speed / 4 + 0.25));

    // Ricocheting off a rigid face charges the orb; soft contact discharges it.
    if (mat.charges && speed > 1.1) orb.charged = true;
    else if (!mat.charges) orb.charged = false;

    // Kill orbs that have effectively stopped, so spent orbs never litter
    // the room: instantly when swallowed by a soft surface, and after a
    // couple of bounces once they no longer carry useful speed.
    if (len(orb.vel) < 0.35 && !mat.charges) orb.alive = false;
    else if (len(orb.vel) < 0.45 && orb.bounces > 2) orb.alive = false;

    if (this.onImpact) {
      this.onImpact({
        point: v3(orb.pos.x, orb.pos.y, orb.pos.z),
        normal: n,
        material: mat,
        materialId,
        colliderId,
        speed,
        orb
      });
    }
  }
}
