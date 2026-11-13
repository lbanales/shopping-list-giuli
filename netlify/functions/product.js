
const allowed = ['zara.com', 'stradivarius.com', 'pullandbear.com', 'bershka.com'];

const json = (statusCode, data) => ({
  statusCode,
  headers: {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  },
  body: JSON.stringify(data)
});

const clean = s => String(s ?? '')
  .replace(/&amp;/g, '&')
  .replace(/&quot;/g, '"')
  .replace(/&#39;/g, "'")
  .replace(/&euro;/g, '€')
  .trim();

function meta(html, key) {
  for (const tag of html.match(/<meta\b[^>]*>/gi) || []) {
    if (tag.includes(key)) {
      return clean(
        (tag.match(/content\s*=\s*["']([^"']*)["']/i) || [])[1] || ''
      );
    }
  }
  return '';
}

function htmlData(html) {
  const name = meta(html, 'og:title');
  const image = meta(html, 'og:image');
  const price =
    meta(html, 'product:price:amount') ||
    (html.match(/"price"\s*:\s*"?([\d.,]+)/) || [])[1] ||
    '';

  return { name, image, price };
}

function markdownData(body) {
  const name =
    (body.match(/^Title:\s*(.+)$/mi) ||
     body.match(/^#\s+(.+)$/m) || [])[1] || '';

  const images = [...body.matchAll(
    /!\[[^\]]*\]\((https?:\/\/[^\s)]+)(?:\s+[^)]*)?\)/g
  )].map(m => m[1]);

  const image = images.find(x =>
    /static|image|media|cdn|zara|bershka|stradivarius|pullandbear/i.test(x)
  ) || images[0] || '';

  const price =
    (body.match(/(?:Precio|Price)\s*[:\-]?\s*(?:€\s*)?(\d{1,5}(?:[.,]\d{2})?)\s*€?/i) ||
     body.match(/€\s*(\d{1,5}(?:[.,]\d{2})?)/) ||
     body.match(/(\d{1,5}(?:[.,]\d{2})?)\s*€/) || [])[1] || '';

  return { name: clean(name), image, price };
}

async function get(url, headers = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 9500);

  try {
    return await fetch(url, {
      headers,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }
}

exports.handler = async event => {
  const raw = event.queryStringParameters?.url;

  if (!raw) {
    return json(400, { error: 'Falta URL' });
  }

  let u;
  try {
    u = new URL(raw);
  } catch {
    return json(400, { error: 'URL inválida' });
  }

  if (
    u.protocol !== 'https:' ||
    !allowed.some(d =>
      u.hostname === d || u.hostname.endsWith('.' + d)
    ) ||
    u.username ||
    u.password
  ) {
    return json(400, { error: 'Tienda no permitida' });
  }

  let direct = {};
  let reason = '';

  try {
    const r = await get(u.toString(), {
      'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Version/17.5 Mobile/15E148 Safari/604.1',
      'Accept': 'text/html,application/xhtml+xml',
      'Accept-Language': 'es-ES,es;q=0.9'
    });

    if (r.ok) {
      direct = htmlData((await r.text()).slice(0, 2500000));
    } else {
      reason = 'La tienda devolvió HTTP ' + r.status;
    }
  } catch (e) {
    reason = e.name === 'AbortError'
      ? 'La tienda tardó demasiado'
      : 'No se pudo consultar la tienda';
  }

  if (direct.image && direct.price) {
    return json(200, {
      ...direct,
      found: true,
      source: 'direct'
    });
  }

  let fallback = {};

  try {
    const r = await get(
      'https://r.jina.ai/' + u.toString(),
      {
        'Accept': 'text/plain',
        'X-Return-Format': 'markdown'
      }
    );

    if (r.ok) {
      fallback = markdownData(
        (await r.text()).slice(0, 400000)
      );
    } else {
      reason += '; alternativa HTTP ' + r.status;
    }
  } catch {
    reason += '; alternativa no disponible';
  }

  const result = {
    name: direct.name || fallback.name,
    image: direct.image || fallback.image,
    price: direct.price || fallback.price
  };

  return json(200, {
    ...result,
    found: !!(result.name || result.image || result.price),
    source: 'direct+free-fallback',
    message: (!result.image || !result.price)
      ? 'No se pudieron obtener todos los datos automáticamente. ' + reason
      : undefined
  });
};
