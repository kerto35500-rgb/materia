/**
 * MATERIA — optional cloud recognition proxy
 * =========================================================================
 * Deploy this on Cloudflare Workers (free tier is plenty). Its only job is to
 * hold your API key server-side, because a key placed in the website itself
 * would be readable by anyone who views the page source.
 *
 * The game calls it like this:
 *
 *   POST /            { "image": "data:image/jpeg;base64,..." }
 *   200               { "label": "تلفاز", "material": "glass", "score": 0.94 }
 *
 * `material` must be one of: soft | carpet | hard | glass | metal | floor
 * If you omit it, the game guesses the material from the label text.
 *
 * -------------------------------------------------------------------------
 * SETUP
 * -------------------------------------------------------------------------
 * 1. Create a Worker at dash.cloudflare.com  →  Workers & Pages  →  Create
 * 2. Paste this file as the Worker code.
 * 3. Settings → Variables → add a SECRET named  API_KEY  with your own key.
 *    Use a Secret, not a plain variable, so it is not shown after saving.
 * 4. Deploy, copy the Worker URL.
 * 5. Open the game once with the URL appended:
 *
 *      https://kerto35500-rgb.github.io/materia/game.html?api=https://YOUR.workers.dev
 *
 *    It is remembered from then on. Switch engines from the "المحرك" row.
 *
 * -------------------------------------------------------------------------
 * Below is an Anthropic (Claude) implementation. Swap the fetch block for
 * Google Cloud Vision, OpenAI or anything else — only the response shape
 * matters to the game.
 * -------------------------------------------------------------------------
 */

const ALLOWED_ORIGIN = 'https://kerto35500-rgb.github.io';

const MATERIALS = ['soft', 'carpet', 'hard', 'glass', 'metal', 'floor'];

const PROMPT = `أنت تحدد الأجسام المنزلية. سأعطيك صورة مقتطعة من كاميرا.
أجب بـ JSON فقط بهذا الشكل، بلا أي نص آخر:
{"label":"اسم الجسم بالعربية","material":"one of soft|carpet|hard|glass|metal|floor","score":0.0}

قواعد المادة:
- soft: مخدة، كنبة، سرير، بطانية، ستارة، ملابس
- carpet: سجادة، موكيت، دعاسة
- hard: طاولة، خشب، خزانة، جدار، باب، كتاب
- glass: تلفاز، شاشة، نافذة، مرآة، زجاج، زهرية
- metal: ثلاجة، فرن، حديد، أنابيب
- floor: بلاط، أرضية

اجعل label قصيراً ومحدداً (مثال: "تلفاز" أو "سجادة حمراء").`;

function cors(extra = {}) {
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json; charset=utf-8',
    ...extra
  };
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors() });
    }
    if (request.method !== 'POST') {
      return new Response(JSON.stringify({ error: 'POST only' }), {
        status: 405, headers: cors()
      });
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return new Response(JSON.stringify({ error: 'bad json' }), {
        status: 400, headers: cors()
      });
    }

    const dataUrl = body && body.image;
    if (!dataUrl || !dataUrl.startsWith('data:image/')) {
      return new Response(JSON.stringify({ error: 'missing image' }), {
        status: 400, headers: cors()
      });
    }

    // Split "data:image/jpeg;base64,XXXX" into media type and payload.
    const comma = dataUrl.indexOf(',');
    const mediaType = dataUrl.slice(5, dataUrl.indexOf(';'));
    const base64 = dataUrl.slice(comma + 1);

    try {
      const upstream = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': env.API_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-sonnet-5',
          max_tokens: 200,
          messages: [{
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
              { type: 'text', text: PROMPT }
            ]
          }]
        })
      });

      if (!upstream.ok) {
        const t = await upstream.text();
        return new Response(JSON.stringify({ error: 'upstream ' + upstream.status, detail: t.slice(0, 300) }), {
          status: 502, headers: cors()
        });
      }

      const j = await upstream.json();
      const text = (j.content && j.content[0] && j.content[0].text) || '';

      // Be forgiving: pull the first JSON object out of the reply.
      const m = text.match(/\{[\s\S]*\}/);
      if (!m) throw new Error('no json in reply');
      const parsed = JSON.parse(m[0]);

      const out = {
        label: String(parsed.label || 'مجهول').slice(0, 60),
        material: MATERIALS.includes(parsed.material) ? parsed.material : undefined,
        score: typeof parsed.score === 'number' ? Math.max(0, Math.min(1, parsed.score)) : 0.9
      };

      return new Response(JSON.stringify(out), { status: 200, headers: cors() });
    } catch (e) {
      return new Response(JSON.stringify({ error: String((e && e.message) || e) }), {
        status: 500, headers: cors()
      });
    }
  }
};
