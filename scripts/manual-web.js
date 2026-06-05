#!/usr/bin/env node

const http = require('http');
const https = require('https');
const dotenv = require('dotenv');
const sharp = require('sharp');

dotenv.config({ quiet: true });

function trimSlash(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

function toInt(value, fallback) {
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  const parsed = Number(value);
  return Number.isNaN(parsed) ? fallback : Math.trunc(parsed);
}

function toFloat(value, fallback) {
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  const parsed = Number(value);
  return Number.isNaN(parsed) ? fallback : parsed;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeRating(rating) {
  const n = Number(String(rating).replace(',', '.'));
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(10, Math.round(n * 10) / 10));
}

function getBadgeColor(rating) {
  if (rating >= 7) return '#1f9d55';
  if (rating >= 5) return '#d97706';
  return '#dc2626';
}

function normalizePosition(position) {
  const normalized = String(position || 'top-left').toLowerCase();
  const allowed = new Set(['top-right', 'top-left', 'bottom-right', 'bottom-left']);
  return allowed.has(normalized) ? normalized : 'top-left';
}

function getOverlayGravity(position) {
  const map = {
    'top-right': 'northeast',
    'top-left': 'northwest',
    'bottom-right': 'southeast',
    'bottom-left': 'southwest',
  };
  return map[normalizePosition(position)] || 'northwest';
}

function generateBadgeSvg(rating, options = {}) {
  const width = Math.max(120, Math.round(Number(options.width) || 180));
  const height = Math.max(48, Math.round(Number(options.height) || 72));
  const displayRating = normalizeRating(rating);
  if (displayRating === null) throw new Error('La nota debe ser numerica');

  const color = options.color || getBadgeColor(displayRating);
  const fontSize = Math.round(height * 0.52);
  const faSize = Math.round(height * 0.2);

  return Buffer.from([
    `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">`,
    `  <rect x="0" y="0" width="${width}" height="${height}" rx="${Math.round(height * 0.16)}" fill="#000000" fill-opacity="0.45"/>`,
    `  <rect x="0" y="0" width="${Math.round(width * 0.16)}" height="${height}" rx="${Math.round(height * 0.16)}" fill="${color}" fill-opacity="0.92"/>`,
    `  <text x="58%" y="58%" text-anchor="middle" font-family="DejaVu Sans, Arial, sans-serif" font-size="${fontSize}" font-weight="700" fill="#ffffff">${displayRating.toFixed(1)}</text>`,
    `  <text x="50%" y="88%" text-anchor="middle" font-family="DejaVu Sans, Arial, sans-serif" font-size="${faSize}" fill="#ffffff" fill-opacity="0.90" letter-spacing="1">FA</text>`,
    '</svg>',
  ].join('\n'));
}

async function applyPosterBadge(sourceBuffer, rating, position, sizeFactor, marginRatio = 0.03) {
  if (!Buffer.isBuffer(sourceBuffer) || sourceBuffer.length === 0) {
    throw new Error('No se pudo leer la caratula actual');
  }

  const image = sharp(sourceBuffer).rotate();
  const meta = await image.metadata();
  if (!meta.width || !meta.height) throw new Error('La caratula no parece una imagen valida');

  const factor = Math.min(0.35, Math.max(0.12, sizeFactor));
  const margin = Math.round(Math.min(meta.width, meta.height) * Math.min(0.08, Math.max(0.01, marginRatio)));
  const badgeWidth = Math.max(120, Math.round(meta.width * factor));
  const badgeHeight = Math.max(48, Math.round(badgeWidth * 0.42));
  const badge = generateBadgeSvg(rating, {
    width: badgeWidth,
    height: badgeHeight,
    color: getBadgeColor(Number(rating)),
  });

  return image
    .composite([{ input: badge, gravity: getOverlayGravity(position), top: margin, left: margin }])
    .jpeg({ quality: 90, mozjpeg: true })
    .toBuffer();
}

class JellyfinClient {
  constructor({ baseUrl, apiKey, timeoutMs, authMode }) {
    this.baseUrl = trimSlash(baseUrl);
    this.apiKey = String(apiKey || '').trim();
    this.timeoutMs = timeoutMs;
    const firstMode = String(authMode || 'header').toLowerCase();
    this.authModes = [firstMode, 'header', 'query'].filter((mode, idx, arr) => mode && arr.indexOf(mode) === idx);
    if (!this.baseUrl) throw new Error('Falta JELLYFIN_BASE_URL en .env');
    if (!this.apiKey) throw new Error('Falta JELLYFIN_API_KEY en .env');
  }

  buildUrl(pathname, query = {}, authMode = 'header') {
    const url = new URL(pathname, `${this.baseUrl}/`);
    Object.entries(query).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
    });
    if (authMode === 'query') {
      url.searchParams.set('api_key', this.apiKey);
      url.searchParams.set('ApiKey', this.apiKey);
    }
    return url;
  }

  async request(pathname, { method = 'GET', query, headers, body, responseType = 'json' } = {}) {
    let lastError;
    for (const authMode of this.authModes) {
      const url = this.buildUrl(pathname, query, authMode);
      const mergedHeaders = { ...(headers || {}) };
      if (authMode === 'header') {
        mergedHeaders.Authorization = `MediaBrowser Token="${this.apiKey}"`;
        mergedHeaders['X-Emby-Token'] = this.apiKey;
      }

      const response = await fetch(url, {
        method,
        headers: mergedHeaders,
        body,
        signal: AbortSignal.timeout(this.timeoutMs),
      });

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        const error = new Error(`Jellyfin ${method} ${url.pathname} fallo (${response.status})${text ? `: ${text.slice(0, 300)}` : ''}`);
        error.status = response.status;
        lastError = error;
        if (response.status === 401) continue;
        throw error;
      }

      if (responseType === 'buffer') return Buffer.from(await response.arrayBuffer());
      if (responseType === 'text') return response.text();
      if (response.status === 204) return null;
      return response.json();
    }
    throw lastError || new Error(`Jellyfin ${method} ${pathname} fallo`);
  }

  searchItems(searchTerm) {
    return this.request('/Items', {
      query: {
        Recursive: 'true',
        SearchTerm: searchTerm,
        IncludeItemTypes: process.env.MANUAL_WEB_INCLUDE_ITEM_TYPES || process.env.SYNC_JELLYFIN_INCLUDE_ITEM_TYPES || 'Movie,Series',
        Fields: 'Name,OriginalTitle,ProductionYear,ImageTags,CommunityRating',
        Limit: 20,
      },
    });
  }

  async getUsers() {
    return this.request('/Users');
  }

  async fetchItemDetailsForUser(userId, itemId) {
    return this.request('/Users/' + encodeURIComponent(userId) + '/Items/' + encodeURIComponent(itemId));
  }

  async updateItem(itemId, payload) {
    return this.request('/Items/' + encodeURIComponent(itemId), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      responseType: 'text',
    });
  }

  downloadPrimaryImage(itemId) {
    return this.request(`/Items/${itemId}/Images/Primary`, {
      query: { Quality: 100, tag: Date.now() },
      responseType: 'buffer',
    });
  }

  refreshImages(itemId) {
    return this.request(`/Items/${itemId}/Refresh`, {
      method: 'POST',
      query: {
        MetadataRefreshMode: 'Default',
        ImageRefreshMode: 'FullRefresh',
        ReplaceAllImages: 'true',
        Recursive: 'false',
      },
      responseType: 'text',
    });
  }

  uploadPrimaryImage(itemId, imageBuffer, format = 'jpeg') {
    const mimeType = format === 'jpg' ? 'image/jpeg' : `image/${format}`;
    const base64Buffer = Buffer.from(imageBuffer.toString('base64'), 'utf8');
    return this.httpUpload(`/Items/${encodeURIComponent(itemId)}/Images/Primary`, base64Buffer, mimeType);
  }

  async httpUpload(pathname, bodyBuffer, contentType) {
    let lastError;
    for (const authMode of this.authModes) {
      const url = this.buildUrl(pathname, {}, authMode);
      const isHttps = url.protocol === 'https:';
      const transport = isHttps ? https : http;
      const headers = { 'Content-Type': contentType, 'Content-Length': bodyBuffer.length };
      if (authMode === 'header') {
        headers.Authorization = `MediaBrowser Token="${this.apiKey}"`;
        headers['X-Emby-Token'] = this.apiKey;
      }

      try {
        return await new Promise((resolve, reject) => {
          const req = transport.request({
            hostname: url.hostname,
            port: url.port || (isHttps ? 443 : 80),
            path: `${url.pathname}${url.search}`,
            method: 'POST',
            headers,
          }, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
              if (res.statusCode >= 200 && res.statusCode < 300) return resolve(data || null);
              const error = new Error(`Jellyfin POST ${url.pathname} fallo (${res.statusCode})${data ? `: ${data.slice(0, 300)}` : ''}`);
              error.status = res.statusCode;
              reject(error);
            });
          });
          req.setTimeout(this.timeoutMs, () => req.destroy(new Error(`Request timed out after ${this.timeoutMs} ms`)));
          req.on('error', reject);
          req.write(bodyBuffer);
          req.end();
        });
      } catch (error) {
        lastError = error;
        if (error && error.status === 401) continue;
        throw error;
      }
    }
    throw lastError || new Error(`Jellyfin POST ${pathname} fallo`);
  }
}

function assertFilmAffinityUrl(value) {
  const url = new URL(String(value || '').trim());
  const hostname = url.hostname.replace(/^www\./, '').toLowerCase();
  if (!hostname.endsWith('filmaffinity.com') && !hostname.endsWith('filmaffinity.es')) {
    throw new Error('La URL debe ser de FilmAffinity');
  }
  return url;
}

function decodeHtmlEntities(value) {
  return String(value || '')
    .replace(/&quot;/g, '"')
    .replace(/&#34;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function stripTags(value) {
  return decodeHtmlEntities(String(value || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
}

function extractRatingFromHtml(html) {
  const patterns = [
    /"aggregateRating"\s*:\s*\{[\s\S]{0,1200}?"ratingValue"\s*:\s*"?([0-9]+(?:[,.][0-9]+)?)/i,
    /itemprop=["']ratingValue["'][^>]*content=["']([0-9]+(?:[,.][0-9]+)?)/i,
    /content=["']([0-9]+(?:[,.][0-9]+)?)["'][^>]*itemprop=["']ratingValue["']/i,
    /id=["']movie-rat-avg["'][^>]*>([\s\S]{0,120}?)([0-9]+(?:[,.][0-9]+)?)/i,
    /class=["'][^"']*movie-rat-avg[^"']*["'][^>]*>([\s\S]{0,120}?)([0-9]+(?:[,.][0-9]+)?)/i,
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern);
    const raw = match && (match[2] || match[1]);
    const rating = normalizeRating(raw);
    if (rating !== null) return rating;
  }

  return null;
}

function extractTitleFromHtml(html) {
  const candidates = [
    html.match(/<meta\s+property=["']og:title["']\s+content=["']([^"']+)/i),
    html.match(/<title[^>]*>([\s\S]{1,200}?)<\/title>/i),
    html.match(/<h1[^>]*>([\s\S]{1,200}?)<\/h1>/i),
  ];
  for (const match of candidates) {
    if (!match) continue;
    const title = stripTags(match[1]).replace(/\s*\|.*$/, '').replace(/\s*-\s*FilmAffinity.*$/i, '').trim();
    if (title) return title;
  }
  return '';
}

async function fetchFilmAffinityRating(pageUrl, timeoutMs) {
  const url = assertFilmAffinityUrl(pageUrl);
  const response = await fetch(url, {
    headers: {
      Accept: 'text/html,application/xhtml+xml',
      'Accept-Language': 'es-ES,es;q=0.9,en;q=0.6',
      'User-Agent': process.env.FILMAFFINITY_USER_AGENT || 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/125 Safari/537.36',
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const html = await response.text();
  if (!response.ok) throw new Error(`FilmAffinity respondio ${response.status}`);

  const rating = extractRatingFromHtml(html);
  if (rating === null) throw new Error('No pude encontrar la nota en esa pagina');
  return { rating, title: extractTitleFromHtml(html), url: url.toString() };
}

function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
  });
  res.end(body);
}

function sendText(res, status, text, contentType = 'text/plain; charset=utf-8') {
  const body = Buffer.from(text);
  res.writeHead(status, { 'Content-Type': contentType, 'Content-Length': body.length });
  res.end(body);
}

async function readJson(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > 1024 * 1024) throw new Error('Payload demasiado grande');
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function createJellyfin() {
  return new JellyfinClient({
    baseUrl: process.env.JELLYFIN_BASE_URL,
    apiKey: process.env.JELLYFIN_API_KEY,
    timeoutMs: Math.max(1000, toInt(process.env.JELLYFIN_TIMEOUT, 30000)),
    authMode: process.env.JELLYFIN_AUTH_MODE || 'header',
  });
}

function itemToView(item) {
  return {
    id: item.Id,
    name: item.Name || item.OriginalTitle || item.Id,
    originalTitle: item.OriginalTitle || '',
    year: item.ProductionYear || '',
    type: item.Type || '',
    communityRating: item.CommunityRating || null,
    hasPoster: Boolean(item.ImageTags && item.ImageTags.Primary),
  };
}

function getFilmAffinityMarkerTag() {
  return String(process.env.SYNC_JELLYFIN_MARKER_TAG || 'FilmAffinity').trim() || 'FilmAffinity';
}

function normalizeTag(value) {
  return String(value || '').trim().toLowerCase();
}

function addFilmAffinityMarker(payload, markerTag = getFilmAffinityMarkerTag()) {
  if (!Array.isArray(payload.Tags)) payload.Tags = [];
  if (!payload.Tags.some((tag) => normalizeTag(tag) === normalizeTag(markerTag))) {
    payload.Tags.push(markerTag);
  }
  return payload;
}

function normalizeItemPayloadForUpdate(baseItem, updates) {
  const payload = { ...baseItem, ...updates };
  const arrayFields = [
    'Genres',
    'GenreItems',
    'Studios',
    'Tags',
    'TagItems',
    'People',
    'ProviderIds',
    'RemoteTrailers',
    'BackdropImageTags',
    'ParentBackdropImageTags',
    'LockedFields',
  ];

  for (const field of arrayFields) {
    if (payload[field] === null || payload[field] === undefined) {
      payload[field] = field === 'ProviderIds' ? {} : [];
    }
  }

  if (!payload.Name) payload.Name = baseItem && baseItem.Name ? baseItem.Name : updates.Name;
  if (!payload.Id && baseItem && baseItem.Id) payload.Id = baseItem.Id;
  return payload;
}

async function resolveJellyfinUserId(jellyfin) {
  if (process.env.JELLYFIN_USER_ID) return process.env.JELLYFIN_USER_ID;
  const users = await jellyfin.getUsers();
  const resolved = Array.isArray(users)
    ? (users.find((user) => user && user.Policy && user.Policy.IsAdministrator) || users[0])
    : null;
  if (!resolved || !resolved.Id) throw new Error('No Jellyfin user available for metadata update');
  return resolved.Id;
}

async function updateItemRating(jellyfin, itemId, rating) {
  const userId = await resolveJellyfinUserId(jellyfin);
  const details = await jellyfin.fetchItemDetailsForUser(userId, itemId);
  const payload = addFilmAffinityMarker(normalizeItemPayloadForUpdate(details, {
    Id: itemId,
    Name: details.Name,
    CommunityRating: rating,
  }));
  await jellyfin.updateItem(itemId, payload);
}

async function handleApi(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/api/items') {
    const query = String(url.searchParams.get('q') || '').trim();
    if (query.length < 2) return sendJson(res, 200, { items: [] });
    const payload = await createJellyfin().searchItems(query);
    const items = Array.isArray(payload.Items) ? payload.Items.map(itemToView) : [];
    return sendJson(res, 200, { items });
  }

  if (req.method === 'POST' && url.pathname === '/api/extract-rating') {
    const body = await readJson(req);
    const result = await fetchFilmAffinityRating(body.url, Math.max(1000, toInt(process.env.FILMAFFINITY_TIMEOUT_MS, 15000)));
    return sendJson(res, 200, result);
  }

  if (req.method === 'POST' && url.pathname === '/api/apply-badge') {
    const body = await readJson(req);
    const itemId = String(body.itemId || '').trim();
    const rating = normalizeRating(body.rating);
    if (!itemId) throw new Error('Elige un item de Jellyfin');
    if (rating === null) throw new Error('La nota debe estar entre 0 y 10');

    const jellyfin = createJellyfin();
    if (body.refreshPoster) {
      await jellyfin.refreshImages(itemId);
      await sleep(Math.max(0, toInt(process.env.MANUAL_WEB_REFRESH_WAIT_MS, 6000)));
    }

    const original = await jellyfin.downloadPrimaryImage(itemId);
    const withBadge = await applyPosterBadge(
      original,
      rating,
      body.position || process.env.POSTER_BADGE_POSITION || 'top-left',
      toFloat(body.size || process.env.POSTER_BADGE_SIZE, 0.3)
    );
    await jellyfin.uploadPrimaryImage(itemId, withBadge, 'jpeg');
    await updateItemRating(jellyfin, itemId, rating);
    return sendJson(res, 200, { ok: true, itemId, rating, metadataUpdated: true, bytes: withBadge.length });
  }

  const posterMatch = req.method === 'GET' && url.pathname.match(/^\/api\/poster\/([^/]+)$/);
  if (posterMatch) {
    const poster = await createJellyfin().downloadPrimaryImage(decodeURIComponent(posterMatch[1]));
    res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': poster.length });
    return res.end(poster);
  }

  return null;
}

function pageHtml() {
  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>FilmAffinity badge manual</title>
  <style>
    :root { color-scheme: light; --bg: #f6f7f4; --panel: #ffffff; --ink: #171a1c; --muted: #647077; --line: #d9ded8; --accent: #0f766e; --accent-dark: #0b5f59; --error: #b91c1c; --ok: #15803d; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; background: var(--bg); color: var(--ink); font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; letter-spacing: 0; }
    main { width: min(1120px, calc(100vw - 32px)); margin: 0 auto; padding: 28px 0 36px; }
    header { display: flex; justify-content: space-between; align-items: end; gap: 18px; padding-bottom: 18px; border-bottom: 1px solid var(--line); }
    h1 { margin: 0; font-size: 28px; line-height: 1.1; font-weight: 760; }
    .status { min-height: 24px; color: var(--muted); font-size: 14px; text-align: right; }
    .status.ok { color: var(--ok); } .status.error { color: var(--error); }
    .layout { display: grid; grid-template-columns: minmax(0, 1fr) 310px; gap: 24px; align-items: start; padding-top: 24px; }
    section { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 18px; }
    .stack { display: grid; gap: 16px; }
    label { display: grid; gap: 7px; color: var(--muted); font-size: 13px; font-weight: 650; }
    input, select { width: 100%; border: 1px solid var(--line); border-radius: 6px; background: #fff; color: var(--ink); font: inherit; padding: 11px 12px; min-height: 42px; }
    input:focus, select:focus { outline: 2px solid rgba(15, 118, 110, 0.18); border-color: var(--accent); }
    .row { display: grid; grid-template-columns: 1fr auto; gap: 10px; align-items: end; }
    .controls { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 12px; }
    button { border: 0; border-radius: 6px; background: var(--accent); color: white; font: inherit; font-weight: 720; min-height: 42px; padding: 10px 14px; cursor: pointer; white-space: nowrap; }
    button:hover { background: var(--accent-dark); } button:disabled { cursor: not-allowed; background: #9aa7a3; }
    .secondary { background: #e7ece9; color: var(--ink); } .secondary:hover { background: #d9e1dd; }
    .check { display: flex; align-items: center; gap: 10px; color: var(--ink); font-size: 14px; font-weight: 600; }
    .check input { width: 18px; min-height: 18px; height: 18px; accent-color: var(--accent); }
    .results { display: grid; gap: 8px; max-height: 312px; overflow: auto; padding-right: 4px; }
    .item { display: grid; grid-template-columns: 44px 1fr auto; gap: 12px; align-items: center; width: 100%; text-align: left; border: 1px solid var(--line); background: #fff; color: var(--ink); border-radius: 8px; padding: 8px; min-height: 62px; }
    .item:hover, .item.selected { border-color: var(--accent); background: #eef7f4; }
    .thumb { width: 44px; aspect-ratio: 2 / 3; border-radius: 4px; object-fit: cover; background: #d9ded8; }
    .meta { min-width: 0; display: grid; gap: 2px; } .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 750; } .sub { color: var(--muted); font-size: 12px; }
    .rating-pill { border-radius: 999px; background: #edf1ee; color: var(--muted); padding: 5px 8px; font-size: 12px; font-weight: 760; }
    .poster { width: 100%; aspect-ratio: 2 / 3; border-radius: 8px; background: #dfe4e1; object-fit: cover; display: block; }
    .poster-empty { display: grid; place-items: center; color: var(--muted); min-height: 420px; border: 1px dashed var(--line); border-radius: 8px; background: #fbfcfb; text-align: center; padding: 18px; }
    .rating-box { display: grid; grid-template-columns: 1fr 112px; gap: 12px; align-items: end; }
    .big-rating { display: grid; place-items: center; min-height: 68px; border-radius: 8px; background: #101415; color: #fff; font-size: 30px; font-weight: 800; }
    @media (max-width: 820px) { main { width: min(100vw - 20px, 640px); padding-top: 16px; } header { display: grid; align-items: start; } .status { text-align: left; } .layout { grid-template-columns: 1fr; } .controls { grid-template-columns: 1fr; } .row { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <main>
    <header><h1>FilmAffinity badge manual</h1><div id="status" class="status">Listo</div></header>
    <div class="layout">
      <div class="stack">
        <section class="stack">
          <div class="row"><label>Buscar en Jellyfin<input id="search" autocomplete="off" placeholder="Titulo de la pelicula o serie"></label><button id="searchBtn" class="secondary">Buscar</button></div>
          <div id="results" class="results"></div>
        </section>
        <section class="stack">
          <div class="row"><label>URL de FilmAffinity<input id="faUrl" placeholder="https://www.filmaffinity.com/es/film...html"></label><button id="extractBtn" class="secondary">Extraer nota</button></div>
          <div class="rating-box"><label>Nota<input id="rating" inputmode="decimal" placeholder="0.0"></label><div id="ratingBox" class="big-rating">--</div></div>
          <div class="controls"><label>Posicion<select id="position"><option value="top-left">Arriba izquierda</option><option value="top-right">Arriba derecha</option><option value="bottom-left">Abajo izquierda</option><option value="bottom-right">Abajo derecha</option></select></label><label>Tamano<select id="size"><option value="0.24">Normal</option><option value="0.30" selected>Grande</option><option value="0.35">Muy grande</option></select></label><label class="check"><input id="refreshPoster" type="checkbox">Refrescar antes</label></div>
          <button id="applyBtn" disabled>Aplicar badge</button>
        </section>
      </div>
      <aside class="stack"><section class="stack"><div id="posterSlot" class="poster-empty">Selecciona un item para ver la caratula actual</div></section></aside>
    </div>
  </main>
<script>
const els={status:document.getElementById('status'),search:document.getElementById('search'),searchBtn:document.getElementById('searchBtn'),results:document.getElementById('results'),faUrl:document.getElementById('faUrl'),extractBtn:document.getElementById('extractBtn'),rating:document.getElementById('rating'),ratingBox:document.getElementById('ratingBox'),position:document.getElementById('position'),size:document.getElementById('size'),refreshPoster:document.getElementById('refreshPoster'),applyBtn:document.getElementById('applyBtn'),posterSlot:document.getElementById('posterSlot')};
let selected=null;
function setStatus(text,kind=''){els.status.textContent=text;els.status.className='status '+kind;}
function ratingValue(){const n=Number(String(els.rating.value).replace(',','.'));return Number.isFinite(n)&&n>=0&&n<=10?Math.round(n*10)/10:null;}
function updateApplyState(){const rating=ratingValue();els.ratingBox.textContent=rating===null?'--':rating.toFixed(1);els.applyBtn.disabled=!selected||rating===null;}
async function api(path,options={}){const response=await fetch(path,{...options,headers:{'content-type':'application/json',...(options.headers||{})}});const payload=await response.json().catch(()=>({}));if(!response.ok)throw new Error(payload.error||'Error HTTP '+response.status);return payload;}
function renderItems(items){els.results.innerHTML='';if(!items.length){els.results.innerHTML='<div class="sub">Sin resultados</div>';return;}for(const item of items){const button=document.createElement('button');button.className='item'+(selected&&selected.id===item.id?' selected':'');button.type='button';button.innerHTML='<img class="thumb" src="/api/poster/'+encodeURIComponent(item.id)+'" alt=""><span class="meta"><span class="name"></span><span class="sub"></span></span><span class="rating-pill"></span>';button.querySelector('.name').textContent=item.name;button.querySelector('.sub').textContent=[item.type,item.year].filter(Boolean).join(' · ');button.querySelector('.rating-pill').textContent=item.communityRating?Number(item.communityRating).toFixed(1):'sin nota';button.addEventListener('click',()=>{selected=item;els.posterSlot.innerHTML='<img class="poster" src="/api/poster/'+encodeURIComponent(item.id)+'?t='+Date.now()+'" alt="">';renderItems(items);updateApplyState();setStatus('Seleccionado: '+item.name);});els.results.appendChild(button);}}
async function search(){const q=els.search.value.trim();if(q.length<2)return;setStatus('Buscando...');els.searchBtn.disabled=true;try{const payload=await api('/api/items?q='+encodeURIComponent(q),{headers:{}});renderItems(payload.items||[]);setStatus('Resultados: '+(payload.items||[]).length,'ok');}catch(error){setStatus(error.message,'error');}finally{els.searchBtn.disabled=false;}}
async function extractRating(){setStatus('Leyendo FilmAffinity...');els.extractBtn.disabled=true;try{const payload=await api('/api/extract-rating',{method:'POST',body:JSON.stringify({url:els.faUrl.value})});els.rating.value=Number(payload.rating).toFixed(1);updateApplyState();setStatus(payload.title?'Nota extraida: '+payload.title:'Nota extraida','ok');}catch(error){setStatus(error.message,'error');}finally{els.extractBtn.disabled=false;}}
async function applyBadge(){const rating=ratingValue();if(!selected||rating===null)return;setStatus('Aplicando badge...');els.applyBtn.disabled=true;try{await api('/api/apply-badge',{method:'POST',body:JSON.stringify({itemId:selected.id,rating,position:els.position.value,size:els.size.value,refreshPoster:els.refreshPoster.checked})});els.posterSlot.innerHTML='<img class="poster" src="/api/poster/'+encodeURIComponent(selected.id)+'?t='+Date.now()+'" alt="">';setStatus('Badge aplicado a '+selected.name,'ok');}catch(error){setStatus(error.message,'error');}finally{updateApplyState();}}
els.searchBtn.addEventListener('click',search);els.extractBtn.addEventListener('click',extractRating);els.applyBtn.addEventListener('click',applyBadge);els.rating.addEventListener('input',updateApplyState);els.search.addEventListener('keydown',(event)=>{if(event.key==='Enter')search();});els.faUrl.addEventListener('keydown',(event)=>{if(event.key==='Enter')extractRating();});
</script>
</body>
</html>`;
}

async function route(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    const apiResult = await handleApi(req, res, url);
    if (apiResult !== null) return;
    if (req.method === 'GET' && url.pathname === '/') return sendText(res, 200, pageHtml(), 'text/html; charset=utf-8');
    sendJson(res, 404, { error: 'No encontrado' });
  } catch (error) {
    sendJson(res, 500, { error: error && error.message ? error.message : String(error) });
  }
}

const port = Math.max(1, toInt(process.env.MANUAL_WEB_PORT, 8097));
const host = process.env.MANUAL_WEB_HOST || '0.0.0.0';

http.createServer(route).listen(port, host, () => {
  console.log(`Manual FilmAffinity badge web listening on http://${host}:${port}`);
});
