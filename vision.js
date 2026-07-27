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
 * Label -> material bucket
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
  capture(frame, refSpace) {
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

      const pixels = new Uint8Array(w * h * 4);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, pixels);

      this.canvas.width = w;
      this.canvas.height = h;
      const img = this.ctx.createImageData(w, h);

      // GL origin is bottom-left, canvas is top-left: flip vertically.
      const rowBytes = w * 4;
      for (let y = 0; y < h; y++) {
        const src = (h - 1 - y) * rowBytes;
        img.data.set(pixels.subarray(src, src + rowBytes), y * rowBytes);
      }
      this.ctx.putImageData(img, 0, 0);

      this.lastError = null;
      return { canvas: this.canvas, w, h };
    } catch (e) {
      this.lastError = 'readPixels: ' + ((e && e.message) || e);
      return null;
    } finally {
      gl.bindFramebuffer(gl.FRAMEBUFFER, prevFb);
    }
  }

  /**
   * Crops the central square of a capture — the hit-test ray runs through
   * the middle of the view, so the tagged object is centred.
   */
  cropCentre(src, size = 224, zoom = 0.55) {
    const out = document.createElement('canvas');
    out.width = out.height = size;
    const side = Math.floor(Math.min(src.w, src.h) * zoom);
    const sx = Math.floor((src.w - side) / 2);
    const sy = Math.floor((src.h - side) / 2);
    out.getContext('2d').drawImage(src.canvas, sx, sy, side, side, 0, 0, size, size);
    return out;
  }
}

/* ------------------------------------------------------------------ *
 * Classifier (transformers.js, in-browser)
 * ------------------------------------------------------------------ */
const MODEL = 'Xenova/mobilevit-small';   // ~10 MB, ImageNet-1k, mobile-friendly
const CDN = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.3.1';

export class Recognizer {
  constructor(onStatus) {
    this.pipe = null;
    this.loading = false;
    this.ready = false;
    this.error = null;
    this.onStatus = onStatus || (() => {});
  }

  async load() {
    if (this.ready || this.loading) return this.ready;
    this.loading = true;
    this.onStatus('تحميل نموذج التعرف…');

    try {
      const mod = await import(/* @vite-ignore */ CDN);
      const { pipeline, env } = mod;

      env.allowLocalModels = false;
      env.useBrowserCache = true;

      // WebGPU when present, otherwise WASM. Both run fully on-device.
      let device = 'wasm';
      try { if (navigator.gpu && await navigator.gpu.requestAdapter()) device = 'webgpu'; }
      catch { /* stay on wasm */ }

      this.pipe = await pipeline('image-classification', MODEL, {
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

  /** @returns {{label:string, score:number, material:string|null, all:Array}|null} */
  async classify(canvas) {
    if (!this.ready) return null;
    try {
      const out = await this.pipe(canvas.toDataURL('image/jpeg', 0.9), { top_k: 5 });
      if (!out || !out.length) return null;

      // Prefer the highest-scoring label we can actually map to a material.
      let chosen = null;
      for (const c of out) {
        const m = labelToMaterial(c.label);
        if (m) { chosen = { ...c, material: m }; break; }
      }
      const best = chosen || { ...out[0], material: null };
      return { label: best.label, score: best.score, material: best.material, all: out };
    } catch (e) {
      this.error = (e && e.message) || String(e);
      console.error('classify failed', e);
      return null;
    }
  }
}
