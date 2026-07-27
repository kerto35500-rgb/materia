/**
 * MATERIA — Material system
 * ---------------------------------------------------------------
 * The core idea of the whole project lives in this file.
 *
 * Existing AR room meshes are "dumb": every surface is a rigid wall with
 * identical friction. Here each recognised surface is mapped into a small
 * set of PHYSICAL material buckets, and those buckets drive real physics
 * (restitution / friction / absorption) plus feedback (colour, sound, FX).
 *
 * Six buckets is deliberately few: a game needs to know a pillow is SOFT,
 * not that it is memory foam. Small vocabulary = fast, offline, robust.
 */

export const MATERIALS = {
  soft: {
    id: 'soft',
    label: 'طري',
    en: 'Soft',
    hint: 'مخدة، كنب، سرير، بطانية',
    // Physics
    restitution: 0.10,   // barely bounces
    friction: 0.88,      // grabs the orb
    absorb: 0.70,        // fraction of orb energy eaten on contact
    // Gameplay
    charges: false,      // cannot charge an orb
    nest: true,          // spirits hide here — safe cover
    // Presentation
    color: 0x8b6fd6,
    accent: '#a98bff',
    fx: 'puff',
    thud: { freq: 90, dur: 0.18, type: 'sine', gain: 0.30 }
  },

  carpet: {
    id: 'carpet',
    label: 'سجاد',
    en: 'Carpet',
    hint: 'سجادة، موكيت، عشب صناعي',
    restitution: 0.06,
    friction: 0.96,
    absorb: 0.78,
    charges: false,
    // A flat rug on the floor absorbs, but it must NOT grant cover — a large
    // low shield zone reads as invisible and confusing during play.
    nest: false,
    color: 0x6d8f5a,
    accent: '#8fbf72',
    fx: 'puff',
    thud: { freq: 70, dur: 0.22, type: 'sine', gain: 0.26 }
  },

  hard: {
    id: 'hard',
    label: 'صلب',
    en: 'Hard',
    hint: 'طاولة، خشب، جدار، باب',
    restitution: 0.70,
    friction: 0.38,
    absorb: 0.10,
    charges: true,       // ricochet here to charge the orb
    nest: false,
    color: 0xd08a3c,
    accent: '#f0a95a',
    fx: 'spark',
    thud: { freq: 320, dur: 0.09, type: 'triangle', gain: 0.26 }
  },

  glass: {
    id: 'glass',
    label: 'زجاج',
    en: 'Glass',
    hint: 'نافذة، مرآة، طاولة زجاج، شاشة',
    restitution: 0.90,
    friction: 0.12,
    absorb: 0.03,
    charges: true,
    nest: false,
    color: 0x4fc9e8,
    accent: '#6fe3ff',
    fx: 'shard',
    thud: { freq: 1400, dur: 0.14, type: 'sine', gain: 0.20 }
  },

  metal: {
    id: 'metal',
    label: 'معدن',
    en: 'Metal',
    hint: 'ثلاجة، أنبوب، رف حديد',
    restitution: 0.82,
    friction: 0.22,
    absorb: 0.05,
    charges: true,
    nest: false,
    color: 0x9fb3c8,
    accent: '#c3d6ea',
    fx: 'spark',
    thud: { freq: 760, dur: 0.30, type: 'square', gain: 0.16 }
  },

  floor: {
    id: 'floor',
    label: 'أرضية',
    en: 'Floor',
    hint: 'بلاط، أرضية الغرفة',
    restitution: 0.52,
    friction: 0.55,
    absorb: 0.18,
    charges: true,
    nest: false,
    color: 0x5a6478,
    accent: '#7d8aa3',
    fx: 'ring',
    thud: { freq: 210, dur: 0.12, type: 'triangle', gain: 0.22 }
  }
};

/** Stable order used by every UI that lists materials. */
export const MATERIAL_ORDER = ['soft', 'carpet', 'hard', 'glass', 'metal', 'floor'];

export function getMaterial(id) {
  return MATERIALS[id] || MATERIALS.hard;
}

/**
 * Maps a WebXR semantic label (from plane-detection / mesh-detection) onto a
 * material bucket. WebXR exposes labels like "wall", "floor", "table",
 * "couch", "window" on supported hardware — when present we can tag a surface
 * with zero taps from the player.
 */
const SEMANTIC_MAP = {
  floor: 'floor', ground: 'floor',
  ceiling: 'hard', wall: 'hard', 'wall face': 'hard', door: 'hard',
  table: 'hard', desk: 'hard', shelf: 'hard', cabinet: 'hard',
  storage: 'hard', 'wall art': 'hard', other: 'hard',
  couch: 'soft', sofa: 'soft', bed: 'soft', pillow: 'soft',
  cushion: 'soft', curtain: 'soft', 'window frame': 'glass',
  window: 'glass', mirror: 'glass', screen: 'glass',
  'door frame': 'hard', lamp: 'metal', plant: 'soft', rug: 'carpet'
};

export function materialFromSemanticLabel(label) {
  if (!label) return null;
  const key = String(label).toLowerCase().trim();
  if (SEMANTIC_MAP[key]) return SEMANTIC_MAP[key];
  // Loose contains-match for vendor-specific label spellings.
  for (const k of Object.keys(SEMANTIC_MAP)) {
    if (key.includes(k)) return SEMANTIC_MAP[k];
  }
  return null;
}

/**
 * Fallback heuristic when no semantic label exists: infer from orientation.
 * A horizontal plane near the ground is a floor; a vertical one is a wall.
 */
export function materialFromOrientation(normalY, heightFromFloor) {
  const up = Math.abs(normalY);
  if (up > 0.8) return heightFromFloor < 0.25 ? 'floor' : 'hard';
  return 'hard';
}
