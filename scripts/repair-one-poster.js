#!/usr/bin/env node

const http = require('http');
const https = require('https');
const dotenv = require('dotenv');
const sharp = require('sharp');

dotenv.config({ quiet: true });

const target = {
  id: process.env.REPAIR_POSTER_ID || '1fc49d22bedee305e16ff09c8c22dcbd',
  title: process.env.REPAIR_POSTER_TITLE || 'Maximum Pleasure Guaranteed',
  rating: Number(process.env.REPAIR_POSTER_RATING || 5.5),
};

function ts() { return new Date().toISOString().replace('T', ' ').replace('Z', ''); }
function log(level, message, meta) { console[level === 'error' ? 'error' : 'log'](`${ts()} ${level.toUpperCase()} - ${message}${meta ? ` ${JSON.stringify(meta)}` : ''}`); }
function trimSlash(value) { return String(value || '').trim().replace(/\/+$/, ''); }
function toInt(value, fallback) { const n = Number(value); return Number.isFinite(n) ? Math.trunc(n) : fallback; }
function toFloat(value, fallback) { const n = Number(value); return Number.isFinite(n) ? n : fallback; }
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function normalizeRating(rating) { const n = Number(rating); return Number.isFinite(n) ? Math.max(0, Math.min(10, Math.round(n * 10) / 10)) : null; }
function getBadgeColor(rating) { if (rating >= 7) return '#1f9d55'; if (rating >= 5) return '#d97706'; return '#dc2626'; }
function generateBadgeSvg(rating, width, height) {
  const displayRating = normalizeRating(rating);
  const color = getBadgeColor(displayRating);
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
async function applyBadge(sourceBuffer, rating) {
  const image = sharp(sourceBuffer).rotate();
  const meta = await image.metadata();
  const width = meta.width || 1000;
  const factor = Math.min(0.35, Math.max(0.12, toFloat(process.env.POSTER_BADGE_SIZE, 0.3)));
  const badgeWidth = Math.max(120, Math.round(width * factor));
  const badgeHeight = Math.max(48, Math.round(badgeWidth * 0.42));
  const margin = Math.round(Math.min(meta.width || 1000, meta.height || 1500) * 0.03);
  const badge = generateBadgeSvg(rating, badgeWidth, badgeHeight);
  return image
    .resize({ width: Math.min(width, 1200), withoutEnlargement: true })
    .composite([{ input: badge, gravity: 'northwest', top: margin, left: margin }])
    .jpeg({ quality: 86, progressive: true, mozjpeg: true })
    .toBuffer();
}
class JellyfinClient {
  constructor() {
    this.baseUrl = trimSlash(process.env.JELLYFIN_BASE_URL);
    this.apiKey = String(process.env.JELLYFIN_API_KEY || '').trim();
    this.timeoutMs = Math.max(1000, toInt(process.env.JELLYFIN_TIMEOUT, 30000));
  }
  url(pathname, query = {}) {
    const url = new URL(pathname, `${this.baseUrl}/`);
    Object.entries(query).forEach(([k, v]) => { if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v)); });
    return url;
  }
  headers(extra = {}) { return { Authorization: `MediaBrowser Token="${this.apiKey}"`, 'X-Emby-Token': this.apiKey, ...extra }; }
  async request(pathname, { method = 'GET', query, headers, body, responseType = 'text' } = {}) {
    const url = this.url(pathname, query);
    const res = await fetch(url, { method, headers: this.headers(headers), body, signal: AbortSignal.timeout(this.timeoutMs) });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text().catch(() => '')}`);
    if (responseType === 'buffer') return Buffer.from(await res.arrayBuffer());
    return res.text();
  }
  download(id) { return this.request(`/Items/${id}/Images/Primary`, { query: { Quality: 100, tag: Date.now() }, responseType: 'buffer' }); }
  refresh(id) { return this.request(`/Items/${id}/Refresh`, { method: 'POST', query: { MetadataRefreshMode: 'Default', ImageRefreshMode: 'FullRefresh', ReplaceAllImages: 'true', Recursive: 'false' } }); }
  upload(id, buffer) {
    const body = Buffer.from(buffer.toString('base64'), 'utf8');
    const url = this.url(`/Items/${encodeURIComponent(id)}/Images/Primary`);
    const isHttps = url.protocol === 'https:';
    const transport = isHttps ? https : http;
    const headers = this.headers({ 'Content-Type': 'image/jpeg', 'Content-Length': body.length });
    return new Promise((resolve, reject) => {
      const req = transport.request({ hostname: url.hostname, port: url.port || (isHttps ? 443 : 80), path: `${url.pathname}${url.search}`, method: 'POST', headers }, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => res.statusCode >= 200 && res.statusCode < 300 ? resolve(data) : reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 500)}`)));
      });
      req.setTimeout(this.timeoutMs, () => req.destroy(new Error(`Request timed out after ${this.timeoutMs} ms`)));
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }
}
async function main() {
  const jellyfin = new JellyfinClient();
  log('info', 'Refrescando item', target);
  await jellyfin.refresh(target.id).catch((error) => log('error', 'Refresh falló; se probará con imagen actual', { error: error.message }));
  await sleep(8000);
  const clean = await jellyfin.download(target.id);
  log('info', 'Imagen base descargada', { bytes: clean.length });
  const repaired = await applyBadge(clean, target.rating);
  log('info', 'Imagen reparada generada', { bytes: repaired.length });
  await jellyfin.upload(target.id, repaired);
  log('info', 'Poster reparado y subido', target);
}
main().catch((error) => { log('error', 'Reparación individual falló', { error: error.message }); process.exit(1); });
