#!/usr/bin/env node

const crypto = require('crypto');
const fs = require('fs/promises');
const http = require('http');
const https = require('https');
const path = require('path');
const dotenv = require('dotenv');
const sharp = require('sharp');

dotenv.config({ quiet: true });

const TARGETS = [
  { id: '40256919e3a2a5972b5336e9eb85c1a4', title: "Agatha Christie's Seven Dials", rating: 4.1 },
  { id: '7b390ee2806f246b9b0fbb5257e85853', title: 'Aída y vuelta', rating: 5.8 },
  { id: 'b66ca0e3e428665e023cffb7fc147563', title: 'The Brutalist', rating: 6.9 },
  { id: '7196d919e02f4d1a0b3ba6a3b22b688b', title: "The Handmaid's Tale", rating: 7.6 },
  { id: '8a4e9e1158ce1af66cf82807c6ea7a53', title: 'The Devil Wears Prada', rating: 5.7 },
  { id: 'a8163d13affac8ae9643dcfb933c5b9c', title: "Marvel's The Punisher", rating: 7.2 },
  { id: '3a19fe412e0de58bdae2b5470519417c', title: '僕のヒーローアカデミア', rating: 7.2 },
  { id: '0218d81ae564c3baeeaec5e5db094437', title: 'The Punisher: One Last Kill', rating: 5.5 },
  { id: '1fc49d22bedee305e16ff09c8c22dcbd', title: 'Maximum Pleasure Guaranteed', rating: 5.5 },
  { id: '632d4fa2fb1644670e519505fa273fc5', title: 'Spider-Noir', rating: 6.9 },
  { id: '621b0e8eb20b96e0f53cbcf45e0e6010', title: 'The Walking Dead: Dead City', rating: 5.8 },
  { id: '73a680c092c325b98a3ca09bbe37e824', title: 'The Walking Dead: The Ones Who Live', rating: 6.1 },
];

function ts() {
  return new Date().toISOString().replace('T', ' ').replace('Z', '');
}

const logger = {
  info: (message, meta) => console.log(`${ts()} INFO - ${message}${meta ? ` ${JSON.stringify(meta)}` : ''}`),
  warn: (message, meta) => console.warn(`${ts()} WARN - ${message}${meta ? ` ${JSON.stringify(meta)}` : ''}`),
  error: (message, meta) => console.error(`${ts()} ERROR - ${message}${meta ? ` ${JSON.stringify(meta)}` : ''}`),
};

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

function sha1(buffer) {
  return crypto.createHash('sha1').update(buffer).digest('hex');
}

function normalizeRating(rating) {
  const n = Number(rating);
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
  if (displayRating === null) throw new Error('generateBadgeSvg requires numeric rating');

  const color = options.color || getBadgeColor(displayRating);
  const fontSize = Math.round(height * 0.52);
  const faSize = Math.round(height * 0.2);
  const ratingText = displayRating.toFixed(1);

  return Buffer.from([
    `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">`,
    `  <rect x="0" y="0" width="${width}" height="${height}" rx="${Math.round(height * 0.16)}" fill="#000000" fill-opacity="0.45"/>`,
    `  <rect x="0" y="0" width="${Math.round(width * 0.16)}" height="${height}" rx="${Math.round(height * 0.16)}" fill="${color}" fill-opacity="0.92"/>`,
    `  <text x="58%" y="58%" text-anchor="middle" font-family="DejaVu Sans, Arial, sans-serif" font-size="${fontSize}" font-weight="700" fill="#ffffff">${ratingText}</text>`,
    `  <text x="50%" y="88%" text-anchor="middle" font-family="DejaVu Sans, Arial, sans-serif" font-size="${faSize}" fill="#ffffff" fill-opacity="0.90" letter-spacing="1">FA</text>`,
    '</svg>',
  ].join('\n'));
}

async function applyPosterBadge(sourceBuffer, rating, position, sizeFactor, marginRatio = 0.03) {
  const image = sharp(sourceBuffer);
  const meta = await image.metadata();
  if (!meta.width || !meta.height) throw new Error('Invalid image metadata');

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
    if (!this.baseUrl) throw new Error('Missing JELLYFIN_BASE_URL');
    if (!this.apiKey) throw new Error('Missing JELLYFIN_API_KEY');
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
        const error = new Error(`Jellyfin request failed ${method} ${url.pathname} (${response.status})${text ? `: ${text}` : ''}`);
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
    throw lastError || new Error(`Jellyfin request failed ${method} ${pathname}`);
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
              const error = new Error(`Jellyfin request failed POST ${url.pathname} (${res.statusCode})${data ? `: ${data.slice(0, 500)}` : ''}`);
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
    throw lastError || new Error(`Jellyfin request failed POST ${pathname}`);
  }
}

async function waitForDifferentImage(jellyfin, itemId, beforeHash) {
  for (let i = 0; i < 4; i += 1) {
    await sleep(i === 0 ? 3000 : 5000);
    const buffer = await jellyfin.downloadPrimaryImage(itemId);
    const currentHash = sha1(buffer);
    if (currentHash !== beforeHash) return { buffer, hash: currentHash, changed: true };
    logger.info('Esperando refresco de imagen', { itemId, attempt: i + 1, hash: currentHash });
  }
  const buffer = await jellyfin.downloadPrimaryImage(itemId);
  return { buffer, hash: sha1(buffer), changed: false };
}

async function main() {
  const jellyfin = new JellyfinClient({
    baseUrl: process.env.JELLYFIN_BASE_URL,
    apiKey: process.env.JELLYFIN_API_KEY,
    timeoutMs: Math.max(1000, toInt(process.env.JELLYFIN_TIMEOUT, 30000)),
    authMode: process.env.JELLYFIN_AUTH_MODE || 'header',
  });
  const opts = {
    position: process.env.POSTER_BADGE_POSITION || 'top-left',
    size: toFloat(process.env.POSTER_BADGE_SIZE, 0.3),
    originalsDir: process.env.POSTER_ORIGINALS_DIR || path.join(process.cwd(), 'data', 'poster-originals'),
  };
  const counters = { repaired: 0, skipped: 0, failed: 0, firstErrors: [] };

  await fs.mkdir(opts.originalsDir, { recursive: true });

  for (const target of TARGETS) {
    try {
      logger.info('Reparando poster', target);
      const before = await jellyfin.downloadPrimaryImage(target.id);
      const beforeHash = sha1(before);
      const rating = normalizeRating(target.rating);
      if (rating === null) {
        counters.skipped += 1;
        logger.warn('Sin CommunityRating usable; se omite', target);
        continue;
      }

      await jellyfin.refreshImages(target.id);
      const refreshed = await waitForDifferentImage(jellyfin, target.id, beforeHash);
      if (!refreshed.changed) {
        logger.warn('Jellyfin no cambió la imagen tras refrescar; se aplica el badge correcto sobre la imagen actual', { ...target, beforeHash });
      }

      const originalPath = path.join(opts.originalsDir, `${target.id}.jpg`);
      await fs.writeFile(originalPath, refreshed.buffer);
      const repaired = await applyPosterBadge(refreshed.buffer, rating, opts.position, opts.size);
      await jellyfin.uploadPrimaryImage(target.id, repaired, 'jpeg');
      counters.repaired += 1;
      logger.info('Poster reparado', { ...target, rating, originalHash: refreshed.hash, backup: originalPath });
    } catch (error) {
      counters.failed += 1;
      if (counters.firstErrors.length < 10) counters.firstErrors.push({ ...target, error: error && error.message ? error.message : String(error) });
      logger.error('Error reparando poster', { ...target, error: error && error.message ? error.message : String(error) });
    }
  }

  logger.info('Reparación finalizada', counters);
}

if (require.main === module) {
  main().catch((error) => {
    logger.error('Reparación falló', { error: error && error.message ? error.message : String(error) });
    process.exit(1);
  });
}
