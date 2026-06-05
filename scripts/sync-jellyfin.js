#!/usr/bin/env node

const dotenv = require('dotenv');
const sharp = require('sharp');

dotenv.config({ quiet: true });

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const configured = String(process.env.LOG_LEVEL || 'info').toLowerCase();
const minLevel = LEVELS[configured] || LEVELS.info;

function ts() {
  return new Date().toISOString().replace('T', ' ').replace('Z', '');
}

function format(level, message, meta) {
  const base = `${ts()} ${level.toUpperCase()} - ${message}`;
  if (meta === undefined || meta === null) return base;
  try {
    return `${base} ${typeof meta === 'string' ? meta : JSON.stringify(meta)}`;
  } catch (_err) {
    return `${base} ${String(meta)}`;
  }
}

const logger = {
  debug: (m, meta) => { if (minLevel <= LEVELS.debug) console.debug(format('debug', m, meta)); },
  info: (m, meta) => { if (minLevel <= LEVELS.info) console.log(format('info', m, meta)); },
  warn: (m, meta) => { if (minLevel <= LEVELS.warn) console.warn(format('warn', m, meta)); },
  error: (m, meta) => { if (minLevel <= LEVELS.error) console.error(format('error', m, meta)); },
};

function trimSlash(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

function toBool(value, fallback = false) {
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  const normalized = String(value).toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'y';
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

function errorMessage(error) {
  return error && error.message ? error.message : String(error);
}

function isRetryableError(error) {
  const status = Number(error && error.status);
  if (!status) return true;
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

function recordFirstError(counters, scope, item, error) {
  if (!counters || !Array.isArray(counters.firstErrors) || counters.firstErrors.length >= 10) return;
  counters.firstErrors.push({
    scope,
    id: item && item.Id,
    title: item && (normalizeTitle(item) || item.Name),
    error: errorMessage(error),
  });
}

async function withRetries(fn, attempts, retryDelayMs, context, options = {}) {
  let lastError;
  const maxAttempts = Math.max(1, attempts);
  for (let i = 0; i < maxAttempts; i += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      const canRetry = options.shouldRetry ? options.shouldRetry(error) : isRetryableError(error);
      const isLast = i === maxAttempts - 1;
      if (!canRetry) {
        logger.warn(`No retry for non-retryable failure (${context})`, errorMessage(error));
        break;
      }
      if (isLast) break;
      const waitMs = retryDelayMs * Math.pow(2, i);
      logger.warn(`Retry ${i + 1}/${maxAttempts - 1} after failure (${context})`, errorMessage(error));
      await sleep(waitMs);
    }
  }
  throw lastError;
}

class JellyfinClient {
  constructor({ baseUrl, apiKey, timeoutMs, authMode }) {
    this.baseUrl = trimSlash(baseUrl);
    this.apiKey = String(apiKey || '').trim();
    this.timeoutMs = timeoutMs;
    const firstMode = String(authMode || 'header').toLowerCase();
    const order = [firstMode, 'header', 'query'].filter((mode, idx, arr) => mode && arr.indexOf(mode) === idx);
    this.authModes = order;

    if (!this.baseUrl) throw new Error('Missing JELLYFIN_BASE_URL');
    if (!this.apiKey) throw new Error('Missing JELLYFIN_API_KEY');
  }

  buildUrl(pathname, query = {}, authMode = 'header') {
    const url = new URL(pathname, `${this.baseUrl}/`);
    Object.entries(query).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== '') {
        url.searchParams.set(key, String(value));
      }
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

      let response;
      try {
        response = await fetch(url, {
          method,
          headers: mergedHeaders,
          body,
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (error) {
        const wrapped = new Error(`Jellyfin request failed ${method} ${url.pathname}: ${errorMessage(error)}`);
        wrapped.cause = error;
        lastError = wrapped;
        throw wrapped;
      }

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        const message = `Jellyfin request failed ${method} ${url.pathname} (${response.status})`;
        const error = new Error(text ? `${message}: ${text}` : message);
        error.status = response.status;
        lastError = error;

        if (response.status === 401) {
          logger.warn('Authentication mode failed, trying fallback', { authMode, path: url.pathname });
          continue;
        }
        throw error;
      }

      if (responseType === 'buffer') {
        const arr = await response.arrayBuffer();
        return Buffer.from(arr);
      }
      if (responseType === 'text') {
        return response.text();
      }
      if (response.status === 204) return null;
      return response.json();
    }

    throw lastError || new Error(`Jellyfin request failed ${method} ${pathname}`);
  }

  async testConnection() {
    return this.request('/System/Info');
  }

  async getUsers() {
    return this.request('/Users');
  }

  async fetchItemsPage({ includeItemTypes, startIndex, limit, sortBy, sortOrder }) {
    return this.request('/Items', {
      query: {
        Recursive: 'true',
        IncludeItemTypes: includeItemTypes,
        StartIndex: startIndex,
        Limit: limit,
        Fields: 'Name,OriginalTitle,ProductionYear,CommunityRating,CriticRating,ImageTags,DateCreated,Tags,TagItems',
        SortBy: sortBy,
        SortOrder: sortOrder,
      },
    });
  }

  async fetchLatestItems({ userId, includeItemTypes, limit }) {
    return this.request('/Users/' + encodeURIComponent(userId) + '/Items/Latest', {
      query: {
        IncludeItemTypes: includeItemTypes,
        Limit: limit,
        Fields: 'Name,OriginalTitle,ProductionYear,CommunityRating,CriticRating,ImageTags,DateCreated,Tags,TagItems',
      },
    });
  }

  async updateItem(itemId, payload) {
    return this.request(`/Items/${itemId}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      responseType: 'text',
    });
  }

  async fetchItemDetailsForUser(userId, itemId) {
    return this.request(`/Users/${userId}/Items/${itemId}`);
  }

  async downloadPrimaryImage(itemId) {
    return this.request(`/Items/${itemId}/Images/Primary`, { responseType: 'buffer' });
  }

  async uploadPrimaryImage(itemId, imageBuffer, format = 'jpeg') {
    if (!itemId) throw new Error('uploadPrimaryImage requires an itemId');
    if (!Buffer.isBuffer(imageBuffer) || imageBuffer.length === 0) {
      throw new Error('uploadPrimaryImage received empty image payload');
    }

    const mimeType = format === 'jpg' ? 'image/jpeg' : `image/${format}`;
    const base64Buffer = Buffer.from(imageBuffer.toString('base64'), 'utf8');
    return this.httpUpload(`/Items/${encodeURIComponent(itemId)}/Images/Primary`, base64Buffer, mimeType);
  }

  async httpUpload(pathname, bodyBuffer, contentType) {
    let lastError;

    for (const authMode of this.authModes) {
      const url = this.buildUrl(pathname, {}, authMode);
      const isHttps = url.protocol === 'https:';
      const transport = isHttps ? require('https') : require('http');
      const headers = {
        'Content-Type': contentType,
        'Content-Length': bodyBuffer.length,
      };

      if (authMode === 'header') {
        headers.Authorization = `MediaBrowser Token="${this.apiKey}"`;
        headers['X-Emby-Token'] = this.apiKey;
      }

      try {
        return await new Promise((resolve, reject) => {
          const req = transport.request(
            {
              hostname: url.hostname,
              port: url.port || (isHttps ? 443 : 80),
              path: `${url.pathname}${url.search}`,
              method: 'POST',
              headers,
            },
            (res) => {
              let data = '';
              res.on('data', (chunk) => { data += chunk; });
              res.on('end', () => {
                if (res.statusCode >= 200 && res.statusCode < 300) {
                  resolve(data || null);
                  return;
                }

                const error = new Error(`Jellyfin request failed POST ${url.pathname} (${res.statusCode})${data ? `: ${data.slice(0, 500)}` : ''}`);
                error.status = res.statusCode;
                reject(error);
              });
            }
          );

          req.setTimeout(this.timeoutMs, () => {
            req.destroy(new Error(`Request timed out after ${this.timeoutMs} ms`));
          });
          req.on('error', reject);
          req.write(bodyBuffer);
          req.end();
        });
      } catch (error) {
        lastError = error;
        if (error && error.status === 401) {
          logger.warn('Authentication mode failed, trying fallback', { authMode, path: url.pathname });
          continue;
        }
        throw error;
      }
    }

    throw lastError || new Error(`Jellyfin request failed POST ${pathname}`);
  }
}

class FilmAffinityApiClient {
  constructor({ baseUrl, timeoutMs }) {
    this.baseUrl = trimSlash(baseUrl);
    this.timeoutMs = timeoutMs;
    if (!this.baseUrl) throw new Error('Missing FILMAFFINITY_API_BASE_URL');
  }

  async batchRatings(items) {
    const endpoint = `${this.baseUrl}/ratings/batch`;
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ items }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      const message = payload && payload.error ? payload.error : `HTTP ${response.status}`;
      throw new Error(`FilmAffinity API request failed: ${message}`);
    }

    if (!payload || !Array.isArray(payload.results)) {
      throw new Error('FilmAffinity API contract error: missing results[]');
    }

    if (payload.results.length !== items.length) {
      throw new Error(`FilmAffinity API contract error: expected ${items.length} results, got ${payload.results.length}`);
    }

    return payload.results;
  }

  async singleRating(title, year) {
    const endpoint = new URL('/rating', `${this.baseUrl}/`);
    endpoint.searchParams.set('title', title);
    if (year !== undefined && year !== null && String(year).trim() !== '') {
      endpoint.searchParams.set('year', String(year));
    }

    const response = await fetch(endpoint, {
      method: 'GET',
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    const payload = await response.json().catch(() => null);
    if (response.status === 404 || response.status === 400) {
      return null;
    }
    if (!response.ok) {
      const message = payload && payload.error ? payload.error : `HTTP ${response.status}`;
      throw new Error(`FilmAffinity single rating request failed: ${message}`);
    }

    if (!payload || typeof payload.rating !== 'number') {
      return null;
    }

    return payload;
  }
}

function normalizeTitle(item) {
  const candidates = [item.OriginalTitle, item.Name];
  for (const candidate of candidates) {
    if (candidate && String(candidate).trim()) return String(candidate).trim();
  }
  return '';
}

function parseIncludeTypes() {
  return (process.env.SYNC_JELLYFIN_INCLUDE_ITEM_TYPES || 'Movie,Series')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)
    .join(',');
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

  if (!payload.Name) {
    payload.Name = baseItem && baseItem.Name ? baseItem.Name : updates.Name;
  }

  if (!payload.Id && baseItem && baseItem.Id) {
    payload.Id = baseItem.Id;
  }

  return payload;
}

function normalizePosition(position) {
  const normalized = String(position || 'top-left').toLowerCase();
  const allowed = new Set(['top-right', 'top-left', 'bottom-right', 'bottom-left']);
  return allowed.has(normalized) ? normalized : 'top-left';
}

function normalizeRating(rating) {
  const n = Number(rating);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(10, Math.round(n * 10) / 10));
}

function getFilmAffinityMarkerTag() {
  return String(process.env.SYNC_JELLYFIN_MARKER_TAG || 'FilmAffinity').trim() || 'FilmAffinity';
}

function normalizeTag(value) {
  return String(value || '').trim().toLowerCase();
}

function hasFilmAffinityMarker(item, markerTag = getFilmAffinityMarkerTag()) {
  if (!item) return false;
  const target = normalizeTag(markerTag);
  const tags = [];

  if (Array.isArray(item.Tags)) tags.push(...item.Tags);
  if (Array.isArray(item.TagItems)) {
    for (const tagItem of item.TagItems) {
      if (tagItem && tagItem.Name) tags.push(tagItem.Name);
    }
  }

  return tags.some((tag) => normalizeTag(tag) === target);
}

function addFilmAffinityMarker(payload, markerTag = getFilmAffinityMarkerTag()) {
  if (!Array.isArray(payload.Tags)) payload.Tags = [];
  if (!payload.Tags.some((tag) => normalizeTag(tag) === normalizeTag(markerTag))) {
    payload.Tags.push(markerTag);
  }
  return payload;
}

function getBadgeColor(rating) {
  if (rating >= 7) return '#1f9d55';
  if (rating >= 5) return '#d97706';
  return '#dc2626';
}

function generateBadgeSvg(rating, options = {}) {
  const width = Math.max(120, Math.round(Number(options.width) || 180));
  const height = Math.max(48, Math.round(Number(options.height) || 72));
  const displayRating = normalizeRating(rating);
  if (displayRating === null) throw new Error('generateBadgeSvg requires a numeric rating');

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

function getOverlayGravity(position) {
  const map = {
    'top-right': 'northeast',
    'top-left': 'northwest',
    'bottom-right': 'southeast',
    'bottom-left': 'southwest',
  };
  return map[normalizePosition(position)] || 'northwest';
}

async function applyPosterBadge(sourceBuffer, rating, position, sizeFactor, marginRatio = 0.03) {
  if (!Buffer.isBuffer(sourceBuffer) || sourceBuffer.length === 0) {
    throw new Error('applyPosterBadge requires sourceBuffer');
  }

  const img = sharp(sourceBuffer);
  const meta = await img.metadata();
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

  return img
    .composite([{
      input: badge,
      gravity: getOverlayGravity(position),
      top: margin,
      left: margin,
    }])
    .jpeg({ quality: 90, mozjpeg: true })
    .toBuffer();
}

async function processItemsBatch({ jellyfin, filmAffinityApi, items, opts, counters }) {
  const lookup = items.map((item) => ({ title: normalizeTitle(item), year: item.ProductionYear || undefined }));
  let ratingsResults;

  try {
    ratingsResults = await withRetries(
      () => filmAffinityApi.batchRatings(lookup),
      opts.ratingBatchRetries,
      opts.retryDelayMs,
      'ratings batch'
    );
  } catch (batchError) {
    counters.ratingBatchFailed += 1;
    recordFirstError(counters, 'ratings batch', null, batchError);
    logger.error('Batch de ratings falló, usando fallback por item', errorMessage(batchError));
    ratingsResults = [];
    for (const itemLookup of lookup) {
      try {
        const single = await withRetries(
          () => filmAffinityApi.singleRating(itemLookup.title, itemLookup.year),
          opts.ratingSingleRetries,
          opts.retryDelayMs,
          `single rating ${itemLookup.title}`
        );

        if (single) {
          ratingsResults.push({ ok: true, status: 200, data: single });
        } else {
          ratingsResults.push({ ok: false, status: 404, error: 'Not found' });
        }
      } catch (singleError) {
        counters.ratingSingleFailed += 1;
        recordFirstError(counters, 'single rating', null, singleError);
        ratingsResults.push({ ok: false, status: 500, error: errorMessage(singleError) });
      }
    }
  }

  for (let i = 0; i < items.length; i += 1) {
    try {
      const item = items[i];
      const current = ratingsResults[i];
      const title = lookup[i].title || item.Name || item.Id;

      counters.processed += 1;
      logger.info('Item procesado', { id: item.Id, title, type: item.Type });

      if (!current || !current.ok || !current.data || typeof current.data.rating !== 'number') {
        counters.skipped += 1;
        logger.info('Rating no encontrado', { id: item.Id, title, reason: current && (current.error || current.message || current.status) });
        continue;
      }

      const faRating = Number(current.data.rating);
      logger.info('Rating encontrado', { id: item.Id, title, rating: faRating });

      const listedCommunity = Number(item.CommunityRating || 0);
      const listedCritic = Number(item.CriticRating || 0);
      const targetCritic = Math.round(faRating * 10);
      const listedCommunityChanged = Math.abs(listedCommunity - faRating) > 0.001;
      const listedCriticChanged = opts.setCritic && Math.abs(listedCritic - targetCritic) > 0.001;
      const listedMetadataNeedsUpdate = opts.force || listedCommunityChanged || listedCriticChanged;
      let metadataUpdatedThisItem = false;

      if (listedMetadataNeedsUpdate) {
        if (opts.dryRun) {
          counters.dryRun += 1;
          logger.info('DRY_RUN metadata', {
            id: item.Id,
            title,
            fromCommunity: listedCommunity,
            toCommunity: faRating,
            fromCritic: listedCritic,
            toCritic: opts.setCritic ? targetCritic : listedCritic,
          });
        } else {
          let itemDetails;
          try {
            itemDetails = await withRetries(
              () => jellyfin.fetchItemDetailsForUser(opts.jellyfinUserId, item.Id),
              opts.retries,
              opts.retryDelayMs,
              `fetch item details ${item.Id}`
            );
          } catch (detailError) {
            counters.metadataFailed += 1;
            recordFirstError(counters, 'metadata detail', item, detailError);
            logger.error('No se pudo leer detalle del item para update', {
              id: item.Id,
              title,
              error: errorMessage(detailError),
            });
            continue;
          }

          const detailCommunity = Number(itemDetails.CommunityRating || 0);
          const detailCritic = Number(itemDetails.CriticRating || 0);
          const detailCommunityChanged = Math.abs(detailCommunity - faRating) > 0.001;
          const detailCriticChanged = opts.setCritic && Math.abs(detailCritic - targetCritic) > 0.001;
          const detailMarkerMissing = opts.skipExistingRatings && !hasFilmAffinityMarker(itemDetails, opts.markerTag);
          const detailMetadataNeedsUpdate = opts.force || detailCommunityChanged || detailCriticChanged || detailMarkerMissing;

          if (!detailMetadataNeedsUpdate) {
            counters.noChange += 1;
            logger.info('Metadata ya estaba actualizada en detalle; se omite poster para evitar re-badge', {
              id: item.Id,
              title,
              communityRating: detailCommunity,
              criticRating: opts.setCritic ? detailCritic : undefined,
            });
          } else {
            const payload = addFilmAffinityMarker(normalizeItemPayloadForUpdate(itemDetails, {
              Id: item.Id,
              Name: item.Name || itemDetails.Name,
              CommunityRating: faRating,
              CriticRating: opts.setCritic ? targetCritic : itemDetails.CriticRating,
            }), opts.markerTag);

            try {
              await withRetries(
                () => jellyfin.updateItem(item.Id, payload),
                opts.retries,
                opts.retryDelayMs,
                `metadata update ${item.Id}`
              );

              counters.metadataUpdated += 1;
              metadataUpdatedThisItem = true;
              logger.info('Metadata actualizada', { id: item.Id, title, communityRating: faRating, criticRating: opts.setCritic ? targetCritic : undefined });
            } catch (error) {
              counters.metadataFailed += 1;
              recordFirstError(counters, 'metadata update', item, error);
              logger.error('Error actualizando metadata', {
                id: item.Id,
                title,
                error: errorMessage(error),
              });
              continue;
            }
          }
        }
      } else {
        counters.noChange += 1;
        logger.debug('Sin cambios de metadata', { id: item.Id, title });
      }

      const shouldTryPoster = opts.enablePosterBadges && (opts.force || metadataUpdatedThisItem || (opts.dryRun && listedMetadataNeedsUpdate));
      if (!shouldTryPoster) {
        counters.posterSkipped += 1;
        continue;
      }

      if (opts.dryRun) {
        counters.posterDryRun += 1;
        logger.info('DRY_RUN poster', { id: item.Id, title, badgePosition: opts.posterBadgePosition, badgeSize: opts.posterBadgeSize });
        continue;
      }

      try {
        const original = await withRetries(
          () => jellyfin.downloadPrimaryImage(item.Id),
          opts.posterRetries,
          opts.retryDelayMs,
          `download poster ${item.Id}`
        );

        const withBadge = await applyPosterBadge(original, faRating, opts.posterBadgePosition, opts.posterBadgeSize);

        await withRetries(
          () => jellyfin.uploadPrimaryImage(item.Id, withBadge, 'jpeg'),
          opts.posterRetries,
          opts.retryDelayMs,
          `upload poster ${item.Id}`
        );

        counters.posterUpdated += 1;
        logger.info('Poster actualizado', { id: item.Id, title, uploadMode: 'base64-image/jpeg-content-length' });
      } catch (error) {
        counters.posterFailed += 1;
        recordFirstError(counters, 'poster update', item, error);
        logger.error('Error actualizando poster; se mantiene metadata y continúa sync', { id: item.Id, title, error: errorMessage(error) });
      }

      if (opts.delayMs > 0) {
        await sleep(opts.delayMs);
      }
    } catch (itemError) {
      counters.failed += 1;
      recordFirstError(counters, 'item', null, itemError);
      logger.error('Error procesando item', errorMessage(itemError));
    }
  }
}

async function fetchAllItems(jellyfin, opts) {
  const all = [];
  let startIndex = 0;

  while (true) {
    const page = await withRetries(
      () => jellyfin.fetchItemsPage({
        includeItemTypes: opts.includeItemTypes,
        startIndex,
        limit: opts.pageSize,
        sortBy: opts.sortBy,
        sortOrder: opts.sortOrder,
      }),
      opts.retries,
      opts.retryDelayMs,
      `fetch items page startIndex=${startIndex}`
    );

    const items = Array.isArray(page.Items) ? page.Items : [];
    if (items.length === 0) break;

    for (const item of items) {
      if (opts.limit > 0 && all.length >= opts.limit) break;
      all.push(item);
    }

    if ((opts.limit > 0 && all.length >= opts.limit) || items.length < opts.pageSize) {
      break;
    }

    startIndex += items.length;
  }

  return all;
}

function createCounters() {
  return {
    processed: 0,
    skipped: 0,
    noChange: 0,
    metadataUpdated: 0,
    metadataFailed: 0,
    failed: 0,
    fatalFailed: 0,
    dryRun: 0,
    posterUpdated: 0,
    posterDryRun: 0,
    posterSkipped: 0,
    posterFailed: 0,
    ratingBatchFailed: 0,
    ratingSingleFailed: 0,
    existingRatingSkipped: 0,
    firstErrors: [],
  };
}

function buildOptions() {
  const opts = {
    dryRun: toBool(process.env.SYNC_JELLYFIN_DRY_RUN, false),
    limit: toInt(process.env.SYNC_JELLYFIN_LIMIT, 0),
    batchSize: Math.max(1, toInt(process.env.SYNC_JELLYFIN_BATCH_SIZE, 5)),
    delayMs: Math.max(0, toInt(process.env.SYNC_JELLYFIN_DELAY_MS, 1000)),
    retries: Math.max(1, toInt(process.env.SYNC_JELLYFIN_RETRIES, 3)),
    retryDelayMs: Math.max(0, toInt(process.env.SYNC_JELLYFIN_RETRY_DELAY, 1000)),
    setCritic: toBool(process.env.SYNC_JELLYFIN_SET_CRITIC, false),
    force: toBool(process.env.SYNC_JELLYFIN_FORCE, false),
    pageSize: Math.max(1, toInt(process.env.SYNC_JELLYFIN_PAGE_SIZE, 100)),
    sortBy: process.env.SYNC_JELLYFIN_SORT_BY || 'SortName',
    sortOrder: process.env.SYNC_JELLYFIN_SORT_ORDER || 'Ascending',
    skipExistingRatings: toBool(process.env.SYNC_JELLYFIN_SKIP_EXISTING_RATINGS, false),
    useLatestEndpoint: toBool(process.env.SYNC_JELLYFIN_USE_LATEST, false),
    markerTag: getFilmAffinityMarkerTag(),
    includeItemTypes: parseIncludeTypes(),
    timeoutMs: Math.max(1000, toInt(process.env.JELLYFIN_TIMEOUT, 30000)),
    filmAffinityTimeoutMs: Math.max(1000, toInt(
      process.env.FILMAFFINITY_API_TIMEOUT_MS || process.env.FILMAFFINITY_API_TIMEOUT,
      Math.min(Math.max(1000, toInt(process.env.JELLYFIN_TIMEOUT, 30000)), 15000)
    )),
    enablePosterBadges: toBool(process.env.ENABLE_POSTER_BADGES, true),
    posterBadgePosition: process.env.POSTER_BADGE_POSITION || 'top-left',
    posterBadgeSize: toFloat(process.env.POSTER_BADGE_SIZE, 0.3),
    jellyfinUserId: process.env.JELLYFIN_USER_ID || '',
  };

  opts.ratingBatchRetries = Math.max(1, toInt(process.env.SYNC_JELLYFIN_RATING_BATCH_RETRIES, Math.min(opts.retries, 2)));
  opts.ratingSingleRetries = Math.max(1, toInt(process.env.SYNC_JELLYFIN_RATING_SINGLE_RETRIES, Math.min(opts.retries, 2)));
  opts.posterRetries = Math.max(1, toInt(process.env.SYNC_JELLYFIN_POSTER_RETRIES, Math.min(opts.retries, 2)));
  return opts;
}

async function runSync(opts, counters) {
  const jellyfin = new JellyfinClient({
    baseUrl: process.env.JELLYFIN_BASE_URL,
    apiKey: process.env.JELLYFIN_API_KEY,
    timeoutMs: opts.timeoutMs,
    authMode: process.env.JELLYFIN_AUTH_MODE || 'header',
  });

  const filmAffinityApi = new FilmAffinityApiClient({
    baseUrl: process.env.FILMAFFINITY_API_BASE_URL,
    timeoutMs: opts.filmAffinityTimeoutMs,
  });

  logger.info('Conectando con Jellyfin', {
    baseUrl: trimSlash(process.env.JELLYFIN_BASE_URL),
    includeItemTypes: opts.includeItemTypes,
    pageSize: opts.pageSize,
    limit: opts.limit,
    sortBy: opts.sortBy,
    sortOrder: opts.sortOrder,
    skipExistingRatings: opts.skipExistingRatings,
    useLatestEndpoint: opts.useLatestEndpoint,
    markerTag: opts.markerTag,
    dryRun: opts.dryRun,
    force: opts.force,
    enablePosterBadges: opts.enablePosterBadges,
    retries: opts.retries,
    ratingBatchRetries: opts.ratingBatchRetries,
    ratingSingleRetries: opts.ratingSingleRetries,
    posterRetries: opts.posterRetries,
    filmAffinityTimeoutMs: opts.filmAffinityTimeoutMs,
  });

  const systemInfo = await withRetries(
    () => jellyfin.testConnection(),
    opts.retries,
    opts.retryDelayMs,
    'jellyfin connection test'
  );

  logger.info('Conexión Jellyfin OK', {
    serverName: systemInfo && systemInfo.ServerName,
    version: systemInfo && systemInfo.Version,
  });

  if (!opts.jellyfinUserId) {
    const users = await withRetries(
      () => jellyfin.getUsers(),
      opts.retries,
      opts.retryDelayMs,
      'get jellyfin users'
    );
    const resolvedUser = Array.isArray(users)
      ? (users.find((u) => u && u.Policy && u.Policy.IsAdministrator) || users[0])
      : null;
    if (!resolvedUser || !resolvedUser.Id) {
      throw new Error('No Jellyfin user available for item detail requests');
    }
    opts.jellyfinUserId = resolvedUser.Id;
  }

  logger.info('Usuario Jellyfin para detalles', { userId: opts.jellyfinUserId });

  const fetchedItems = opts.useLatestEndpoint
    ? await withRetries(
      () => jellyfin.fetchLatestItems({
        userId: opts.jellyfinUserId,
        includeItemTypes: opts.includeItemTypes,
        limit: opts.limit > 0 ? opts.limit : opts.pageSize,
      }),
      opts.retries,
      opts.retryDelayMs,
      'fetch latest items'
    )
    : await fetchAllItems(jellyfin, opts);
  logger.info('Items encontrados', { total: fetchedItems.length, source: opts.useLatestEndpoint ? 'latest' : 'items' });

  const allItems = opts.skipExistingRatings
    ? fetchedItems.filter((item) => !hasFilmAffinityMarker(item, opts.markerTag))
    : fetchedItems;
  counters.existingRatingSkipped += fetchedItems.length - allItems.length;

  if (opts.skipExistingRatings) {
    logger.info('Items sin nota para procesar', {
      total: allItems.length,
      skippedWithFilmAffinityMarker: counters.existingRatingSkipped,
    });
  }

  for (let i = 0; i < allItems.length; i += opts.batchSize) {
    const batch = allItems.slice(i, i + opts.batchSize);
    await processItemsBatch({
      jellyfin,
      filmAffinityApi,
      items: batch,
      opts,
      counters,
    });
  }
}

async function main() {
  const counters = createCounters();

  try {
    const opts = buildOptions();
    await runSync(opts, counters);
  } catch (error) {
    counters.fatalFailed += 1;
    recordFirstError(counters, 'fatal', null, error);
    logger.error('Sync terminó con error global controlado', errorMessage(error));
  } finally {
    logger.info('Sync finalizado', counters);
  }
}

if (require.main === module) {
  main().catch((error) => {
    logger.error('Sync falló fuera del cierre controlado', errorMessage(error));
    process.exit(1);
  });
}

module.exports = { main };
