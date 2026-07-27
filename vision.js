/**
 * MATERIA — object recognition
 * ---------------------------------------------------------------
 * Turns "the player tapped a surface" into "that surface is a television,
 * therefore it is glass".
 *
 * Pipeline:
 *   1. WebXR `camera-access` hands us the camera frame as a GL texture.
 *   2. We read its pixels into a canvas (only on demand — never per frame,
 *      readPixels is far too slow for that).
 *   3. A small image classifier runs entirely in the browser.
 *   4. The predicted label is mapped onto one of our material buckets.
 *
 * HARD LIMIT: `camera-access` is implemented in Chrome on Android via
 * ARCore. The Meta Quest browser does not expose it, so on Quest this whole
 * module reports unavailable and the game falls back to manual tagging.
 */

/* ------------------------------------------------------------------ *
 * Household vocabulary for zero-shot recognition
 * ------------------------------------------------------------------
 * ImageNet-1k spends most of its 1000 classes on dog breeds, fungi and fish,
 * and has very few household surfaces. A zero-shot CLIP model instead scores
 * the image against OUR list, so it cannot answer "mushroom" for a sofa.
 *
 * Each entry carries its material directly — no keyword guessing at all.
 */
export const OBJECTS = [
  // soft
  { ar: 'مخدة',        en: 'a pillow',                     m: 'soft' },
  { ar: 'كنبة',        en: 'a sofa or couch',              m: 'soft' },
  { ar: 'كرسي مريح',   en: 'an upholstered armchair',      m: 'soft' },
  { ar: 'سرير',        en: 'a bed',                        m: 'soft' },
  { ar: 'مرتبة',       en: 'a mattress',                   m: 'soft' },
  { ar: 'بطانية',      en: 'a blanket or duvet',           m: 'soft' },
  { ar: 'وسادة أرضية', en: 'a floor cushion',              m: 'soft' },
  { ar: 'ستارة',       en: 'a curtain',                    m: 'soft' },
  { ar: 'منشفة',       en: 'a towel',                      m: 'soft' },
  { ar: 'ملابس',       en: 'a pile of clothes',            m: 'soft' },
  { ar: 'دمية',        en: 'a plush stuffed toy',          m: 'soft' },
  { ar: 'حقيبة قماش',  en: 'a fabric bag or backpack',     m: 'soft' },

  // carpet
  { ar: 'سجادة',       en: 'a rug or carpet',              m: 'carpet' },
  { ar: 'سجادة صلاة',  en: 'a prayer mat',                 m: 'carpet' },
  { ar: 'موكيت',       en: 'wall to wall carpeting',       m: 'carpet' },
  { ar: 'دعاسة',       en: 'a doormat',                    m: 'carpet' },

  // hard
  { ar: 'طاولة',       en: 'a table',                      m: 'hard' },
  { ar: 'طاولة قهوة',  en: 'a coffee table',               m: 'hard' },
  { ar: 'مكتب',        en: 'a desk',                       m: 'hard' },
  { ar: 'كرسي خشب',    en: 'a wooden chair',               m: 'hard' },
  { ar: 'خزانة',       en: 'a wardrobe or cabinet',        m: 'hard' },
  { ar: 'رف كتب',      en: 'a bookshelf with books',       m: 'hard' },
  { ar: 'كتاب',        en: 'a book',                       m: 'hard' },
  { ar: 'درج',         en: 'a chest of drawers',           m: 'hard' },
  { ar: 'باب',         en: 'a door',                       m: 'hard' },
  { ar: 'جدار',        en: 'a plain wall',                 m: 'hard' },
  { ar: 'صندوق',       en: 'a cardboard box',              m: 'hard' },
  { ar: 'لوحة جدارية', en: 'a framed picture on a wall',   m: 'hard' },
  { ar: 'كرتون',       en: 'a wooden crate',               m: 'hard' },
  { ar: 'سلة',         en: 'a woven basket',               m: 'hard' },
  { ar: 'نبات',        en: 'a potted houseplant',          m: 'hard' },
  { ar: 'طبلية',       en: 'a nightstand',                 m: 'hard' },
  { ar: 'بيانو',       en: 'a piano',                      m: 'hard' },
  { ar: 'سلّم',        en: 'a ladder',                     m: 'hard' },

  // glass / screens
  { ar: 'تلفاز',       en: 'a television screen',          m: 'glass' },
  { ar: 'شاشة كمبيوتر', en: 'a computer monitor',          m: 'glass' },
  { ar: 'لابتوب',      en: 'a laptop computer',            m: 'glass' },
  { ar: 'جوال',        en: 'a smartphone',                 m: 'glass' },
  { ar: 'تابلت',       en: 'a tablet computer',            m: 'glass' },
  { ar: 'نافذة',       en: 'a window with glass',          m: 'glass' },
  { ar: 'مرآة',        en: 'a mirror',                     m: 'glass' },
  { ar: 'طاولة زجاج',  en: 'a glass top table',            m: 'glass' },
  { ar: 'كوب',         en: 'a drinking glass',             m: 'glass' },
  { ar: 'زهرية',       en: 'a vase',                       m: 'glass' },
  { ar: 'قارورة',      en: 'a bottle',                     m: 'glass' },
  { ar: 'أباجورة',     en: 'a table lamp',                 m: 'glass' },

  // metal
  { ar: 'ثلاجة',       en: 'a refrigerator',               m: 'metal' },
  { ar: 'فرن',         en: 'an oven or stove',             m: 'metal' },
  { ar: 'مايكروويف',   en: 'a microwave oven',             m: 'metal' },
  { ar: 'غسالة',       en: 'a washing machine',            m: 'metal' },
  { ar: 'مكيف',        en: 'an air conditioner unit',      m: 'metal' },
  { ar: 'مدفأة',       en: 'a radiator heater',            m: 'metal' },
  { ar: 'رف حديد',     en: 'a metal shelving rack',        m: 'metal' },
  { ar: 'قدر',         en: 'a metal cooking pot',          m: 'metal' },
  { ar: 'مغسلة',       en: 'a metal kitchen sink',         m: 'metal' },
  { ar: 'دراجة',       en: 'a bicycle',                    m: 'metal' },
  { ar: 'مقبض باب',    en: 'a door handle',                m: 'metal' },

  // floor
  { ar: 'أرضية بلاط',  en: 'a tiled floor',                m: 'floor' },
  { ar: 'أرضية خشب',   en: 'a wooden floor',               m: 'floor' },
  { ar: 'أرضية إسمنت', en: 'a concrete floor',             m: 'floor' },
  { ar: 'سقف',         en: 'a ceiling',                    m: 'hard' }
];

const EN_TO_OBJ = new Map(OBJECTS.map((o) => [o.en, o]));
export const CANDIDATES = OBJECTS.map((o) => o.en);

/* ------------------------------------------------------------------ *
 * Label -> material bucket (fallback for non zero-shot engines)
 * ------------------------------------------------------------------
 * The classifier returns ImageNet-1k style labels ("television",
 * "studio couch", "prayer rug"). Keyword matching is deliberately used
 * instead of an exact table: labels vary between models, and we only need
 * to land in the right physical bucket, not identify the exact product.
 */
const LABEL_RULES = [
  { m: 'soft',   re: /couch|sofa|pillow|cushion|quilt|comforter|blanket|bed|mattress|duvet|teddy|plush|towel|curtain|drape/i },
  { m: 'carpet', re: /rug|carpet|mat\b|doormat|matting|prayer mat|floor cloth/i },
  { m: 'glass',  re: /television|tv\b|screen|monitor|display|mirror|window|glass|vase|bottle|jar|aquarium|picture frame|laptop|tablet|cellular|phone/i },
  { m: 'metal',  re: /refrigerator|fridge|stove|oven|radiator|pipe|metal|steel|iron|kettle|pot\b|pan\b|can\b|toaster|microwave|washer|safe\b|lock/i },
  { m: 'hard',   re: /table|desk|chair|stool|bench|cabinet|bookcase|shelf|wardrobe|chest|drawer|door|wall|wood|box|crate|chiffonier|dresser|piano/i },
  { m: 'floor',  re: /tile|floor|parquet|linoleum|pavement/i }
];

/**
 * ImageNet labels arrive as comma-separated synonym lists
 * ("television, television system"). Keep the first, shortest useful name so
 * the UI always has a clean word to show.
 */
export function cleanLabel(label) {
  if (!label) return '';
  return String(label).split(',')[0].trim();
}

export function labelToMaterial(label) {
  if (!label) return null;
  for (const r of LABEL_RULES) if (r.re.test(label)) return r.m;
  return null;
}

/* ------------------------------------------------------------------ *
 * Camera frame capture
 * ------------------------------------------------------------------ */
export class CameraReader {
  constructor(gl) {
    this.gl = gl;
    this.binding = null;
    this.available = false;
    this.lastError = null;
    this.fb = null;
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
  }

  /** Must be called after the XR session is attached. */
  attach(session) {
    try {
      if (typeof XRWebGLBinding === 'undefined') {
        this.lastError = 'XRWebGLBinding غير موجود';
        return false;
      }
      this.binding = new XRWebGLBinding(session, this.gl);
      this.available = true;
      return true;
    } catch (e) {
      this.lastError = (e && (e.name + ': ' + e.message)) || String(e);
      this.available = false;
      return false;
    }
  }

  /**
   * Reads the camera image for this frame into an offscreen canvas.
   * MUST be called inside the XR frame callback — the texture is only
   * valid for the duration of that callback.
   *
   * @returns {{canvas: HTMLCanvasElement, w: number, h: number}|null}
   */
  capture(frame, refSpace, zoom = 0.55, outSize = 224) {
    const gl = this.gl;
    if (!this.binding) { this.lastError = 'لا يوجد ربط WebGL'; return null; }

    const pose = frame.getViewerPose(refSpace);
    if (!pose) { this.lastError = 'لا توجد وضعية للمشاهد'; return null; }

    // Find a view that actually carries a camera image.
    let view = null;
    for (const v of pose.views) if (v.camera) { view = v; break; }
    if (!view) {
      this.lastError = 'لم تُمنح صلاحية camera-access';
      return null;
    }

    let tex;
    try {
      tex = this.binding.getCameraImage(view.camera);
    } catch (e) {
      this.lastError = 'getCameraImage: ' + ((e && e.message) || e);
      return null;
    }
    if (!tex) { this.lastError = 'صورة الكاميرا فارغة'; return null; }

    const w = view.camera.width;
    const h = view.camera.height;

    // Preserve whatever framebuffer three.js/WebXR had bound, or rendering
    // for this frame breaks after we are done.
    const prevFb = gl.getParameter(gl.FRAMEBUFFER_BINDING);

    try {
      if (!this.fb) this.fb = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);

      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
        this.lastError = 'إطار غير مكتمل';
        return null;
      }

      /**
       * Read ONLY the central square, not the whole frame. A full 1920x1080
       * readPixels moves ~8 MB across the GL boundary every capture and was
       * the main source of the stutter; the centre crop is ~15x smaller.
       */
      const side = Math.max(32, Math.floor(Math.min(w, h) * zoom));
      const x0 = Math.floor((w - side) / 2);
      const y0 = Math.floor((h - side) / 2);

      const pixels = new Uint8Array(side * side * 4);
      gl.readPixels(x0, y0, side, side, gl.RGBA, gl.UNSIGNED_BYTE, pixels);

      // Stage at native crop size, flipping GL's bottom-left origin.
      this.canvas.width = side;
      this.canvas.height = side;
      const img = this.ctx.createImageData(side, side);
      const rowBytes = side * 4;
      for (let y = 0; y < side; y++) {
        const src = (side - 1 - y) * rowBytes;
        img.data.set(pixels.subarray(src, src + rowBytes), y * rowBytes);
      }
      this.ctx.putImageData(img, 0, 0);

      // Scale down to the classifier's input size in one draw.
      const out = document.createElement('canvas');
      out.width = out.height = outSize;
      out.getContext('2d').drawImage(this.canvas, 0, 0, side, side, 0, 0, outSize, outSize);

      this.lastError = null;
      return { canvas: out, w: outSize, h: outSize, side };
    } catch (e) {
      this.lastError = 'readPixels: ' + ((e && e.message) || e);
      return null;
    } finally {
      gl.bindFramebuffer(gl.FRAMEBUFFER, prevFb);
    }
  }

  /** Kept for compatibility — capture() already returns a centred crop. */
  cropCentre(src) {
    return src.canvas;
  }
}

/* ------------------------------------------------------------------ *
 * Classifier (transformers.js, in-browser)
 * ------------------------------------------------------------------ */
const CLIP_MODEL = 'Xenova/clip-vit-base-patch32';   // zero-shot, ~40 MB
const CDN = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.3.1';

/* ------------------------------------------------------------------ *
 * Optional cloud engine
 * ------------------------------------------------------------------
 * A key can never be hidden in a static site, so this never holds one.
 * Instead it posts to a proxy YOU deploy and control:
 *
 *   POST <endpoint>  { "image": "data:image/jpeg;base64,..." }
 *   200  { "label": "تلفاز سامسونج", "material": "glass", "score": 0.93 }
 *
 * `material` is optional; without it we fall back to keyword mapping.
 * Configure by opening the page once with ?api=https://your-worker.dev
 */
const API_KEY_STORE = 'materia.apiEndpoint';

export function getCloudEndpoint() {
  try { return localStorage.getItem(API_KEY_STORE) || null; } catch { return null; }
}
export function setCloudEndpoint(url) {
  try {
    if (url) localStorage.setItem(API_KEY_STORE, url);
    else localStorage.removeItem(API_KEY_STORE);
  } catch { /* private mode */ }
}

/** Reads ?api= once and remembers it. */
export function adoptEndpointFromUrl() {
  try {
    const u = new URLSearchParams(location.search).get('api');
    if (u) { setCloudEndpoint(u); return u; }
  } catch { /* ignore */ }
  return getCloudEndpoint();
}

export class Recognizer {
  constructor(onStatus) {
    this.pipe = null;
    this.loading = false;
    this.ready = false;
    this.error = null;
    this.engine = 'clip';          // 'clip' | 'cloud'
    this.onStatus = onStatus || (() => {});
  }

  get cloudAvailable() { return !!getCloudEndpoint(); }

  async load() {
    if (this.ready || this.loading) return this.ready;
    this.loading = true;
    this.onStatus('تحميل نموذج التعرف…');

    try {
      const mod = await import(/* @vite-ignore */ CDN);
      const { pipeline, env, RawImage } = mod;
      this.RawImage = RawImage;

      env.allowLocalModels = false;
      env.useBrowserCache = true;

      // WebGPU when present, otherwise WASM. Both run fully on-device.
      let device = 'wasm';
      try { if (navigator.gpu && await navigator.gpu.requestAdapter()) device = 'webgpu'; }
      catch { /* stay on wasm */ }

      this.pipe = await pipeline('zero-shot-image-classification', CLIP_MODEL, {
        device,
        progress_callback: (p) => {
          if (p && p.status === 'progress' && p.progress != null) {
            this.onStatus(`تحميل النموذج ${Math.round(p.progress)}%`);
          }
        }
      });

      this.ready = true;
      this.device = device;
      this.onStatus('جاهز للتعرف');
      return true;
    } catch (e) {
      this.error = (e && (e.name + ': ' + e.message)) || String(e);
      this.onStatus('فشل تحميل النموذج');
      console.error('Recognizer.load failed', e);
      return false;
    } finally {
      this.loading = false;
    }
  }

  /** Sends the crop to the user's own proxy. */
  async classifyCloud(canvas) {
    const url = getCloudEndpoint();
    if (!url) return null;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image: canvas.toDataURL('image/jpeg', 0.85) })
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const j = await res.json();
      if (!j || !j.label) throw new Error('رد غير صالح');
      return {
        label: String(j.label),
        rawLabel: String(j.label),
        score: typeof j.score === 'number' ? j.score : 0.9,
        material: j.material || labelToMaterial(j.label),
        engine: 'cloud',
        all: []
      };
    } catch (e) {
      this.error = 'سحابي: ' + ((e && e.message) || e);
      console.error('classifyCloud failed', e);
      return null;
    }
  }

  /** @returns {{label:string, score:number, material:string|null, all:Array}|null} */
  async classify(canvas) {
    // The cloud engine wins when the user has configured a proxy.
    if (this.engine === 'cloud' && this.cloudAvailable) {
      const cloud = await this.classifyCloud(canvas);
      if (cloud) return cloud;
      // fall through to the local model rather than failing outright
    }

    if (!this.ready) return null;
    try {
      // Feed pixels straight in. toDataURL() base64-encodes the whole image
      // on the main thread and was a needless stall on every capture.
      let input;
      if (this.RawImage && this.RawImage.fromCanvas) {
        input = this.RawImage.fromCanvas(canvas);
      } else {
        input = canvas.toDataURL('image/jpeg', 0.85);
      }

      const out = await this.pipe(input, CANDIDATES, {
        hypothesis_template: '{}'
      });
      if (!out || !out.length) return null;

      // Zero-shot returns our own prompts, so the mapping is exact.
      const best = out[0];
      const obj = EN_TO_OBJ.get(best.label);

      return {
        label: obj ? obj.ar : cleanLabel(best.label),
        rawLabel: best.label,
        score: best.score,
        material: obj ? obj.m : labelToMaterial(best.label),
        engine: 'clip',
        all: out.slice(0, 4).map((o) => ({
          label: (EN_TO_OBJ.get(o.label) || {}).ar || o.label,
          score: o.score
        }))
      };
    } catch (e) {
      this.error = (e && e.message) || String(e);
      console.error('classify failed', e);
      return null;
    }
  }
}
