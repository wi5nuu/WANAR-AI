/**
 * src/location/geocode.js
 *
 * Reverse geocoding and nearby-POI lookup via OpenStreetMap services:
 *   - Nominatim (https://nominatim.org)  — "where is this?" → address / area / category
 *   - Overpass API (https://overpass-api.de) — "what is around here?" → POIs (SPBU, minimarket…)
 *
 * Both are free and need no API key, which matches this project's rule of not
 * adding paid dependencies before checking cost. They are also third parties:
 * every call sends a coordinate off the machine, so both are switchable off
 * (LOCATION_GEOCODE=off, or settings.geocode.enabled=false) and every answer is
 * cached in SQLite so the same street corner is never asked twice. Usage policy
 * of Nominatim: maximum ~1 request/second and a truthful User-Agent — enforced
 * here, not merely documented.
 *
 * If the service is unreachable the answer is `null` and the caller must show
 * "lokasi belum teridentifikasi" — never a guessed place name.
 *
 * @author Wisnu Alfian Nur Ashar
 */

const NOMINATIM = process.env.LOCATION_NOMINATIM_URL || 'https://nominatim.openstreetmap.org';
const OVERPASS = process.env.LOCATION_OVERPASS_URL || 'https://overpass-api.de/api/interpreter';

/** Round a coordinate to ~11 m: enough for caching, never used as the displayed position. */
export const cacheKey = (lat, lon) => `${Number(lat).toFixed(4)},${Number(lon).toFixed(4)}`;

export function defaultUserAgent(env = process.env) {
  const contact = String(env.LOCATION_GEOCODE_CONTACT || '').trim();
  return `WanarAI/1.0 (personal assistant; ${contact || 'self-hosted, no contact configured'})`;
}

/**
 * OSM tags → the place kinds this system classifies.
 * Returned in priority order: the first matching rule wins.
 */
export const POI_RULES = [
  { kind: 'fuel', test: (t) => t.amenity === 'fuel' || t.shop === 'gas' },
  { kind: 'minimarket', test: (t) => t.shop === 'convenience' || t.shop === 'supermarket' || t.shop === 'greengrocer' },
  { kind: 'mall', test: (t) => t.shop === 'mall' || t.shop === 'department_store' || t.amenity === 'marketplace' },
  { kind: 'food', test: (t) => ['restaurant', 'cafe', 'fast_food', 'food_court', 'warung', 'ice_cream'].includes(t.amenity) || t.shop === 'bakery' || t.amenity === 'bar' },
  { kind: 'workshop', test: (t) => ['motorcycle_repair', 'car_repair', 'bicycle_repair'].includes(t.shop) || t.shop === 'tyres' || t.amenity === 'workshop' },
  { kind: 'campus', test: (t) => ['university', 'college', 'school', 'kindergarten'].includes(t.amenity) },
  { kind: 'office', test: (t) => t.office || t.building === 'office' },
  { kind: 'parking', test: (t) => t.amenity === 'parking' },
  { kind: 'pharmacy', test: (t) => t.amenity === 'pharmacy' || t.shop === 'chemist' },
  { kind: 'bank', test: (t) => t.amenity === 'bank' || t.amenity === 'atm' },
  { kind: 'clinic', test: (t) => ['hospital', 'clinic', 'doctors', 'dentist'].includes(t.amenity) },
  { kind: 'worship', test: (t) => t.amenity === 'place_of_worship' },
  { kind: 'laundry', test: (t) => t.shop === 'laundry' || t.shop === 'dry_cleaning' },
];

/** Brand names that make a minimarket identifiable even without OSM tags. */
const BRANDS = [
  { re: /\balfamart\b/i, name: 'Alfamart', kind: 'minimarket' },
  { re: /\bindomaret\b/i, name: 'Indomaret', kind: 'minimarket' },
  { re: /\balfamidi\b/i, name: 'Alfamidi', kind: 'minimarket' },
  { re: /\blawson\b/i, name: 'Lawson', kind: 'minimarket' },
  { re: /\b(pertamina|shell|bp|total|vivo|spbu)\b/i, name: null, kind: 'fuel' },
  { re: /\b(apotek|pharmacy|kimia farma|k24)\b/i, name: null, kind: 'pharmacy' },
  { re: /\b(ahass|bengkel|workshop|service)\b/i, name: null, kind: 'workshop' },
];

/** Extracts a kind from OSM tags (amenity/shop/office/leisure…). @returns {string|null} */
export function kindFromTags(tags = {}) {
  if (!tags || typeof tags !== 'object') return null;
  for (const rule of POI_RULES) {
    try { if (rule.test(tags)) return rule.kind; } catch { /* a broken rule must not break a lookup */ }
  }
  if (tags.highway) return 'road';
  if (tags.landuse === 'construction' || tags.landuse === 'vacant') return 'vacant';
  if (tags.landuse === 'residential' || tags.building === 'house' || tags.building === 'residential') return 'home';
  return null;
}

/** Recognises known Indonesian brands in a free-text name. @returns {{name:string|null, kind:string}|null} */
export function kindFromName(name) {
  const s = String(name || '');
  for (const b of BRANDS) if (b.re.test(s)) return { name: b.name, kind: b.kind };
  return null;
}

/** Human label from a Nominatim address object: road, neighbourhood, city, state. */
export function labelFromAddress(address = {}, fallback = null) {
  const parts = [];
  const road = address.road || address.pedestrian || address.footway || address.path;
  if (road) parts.push(address.house_number ? `${road} No.${address.house_number}` : road);
  const area = address.neighbourhood || address.hamlet || address.village || address.suburb || address.quarter;
  if (area && area !== road) parts.push(area);
  const city = address.city || address.town || address.county || address.municipality;
  if (city) parts.push(city);
  if (!parts.length && address.state) parts.push(address.state);
  return parts.length ? parts.join(', ') : (fallback || null);
}

/**
 * Builds the geocoder. All network access is injected (`fetchImpl`) and every
 * call is cached; the module itself keeps no timers.
 *
 * @param {object} deps
 * @param {object} deps.store        location store (geocode cache table)
 * @param {Function} [deps.settings] () => settings object
 * @param {Function} [deps.fetchImpl]
 * @param {Function} [deps.now]
 * @param {object} [deps.env]
 */
export function createGeocoder({ store, settings = () => ({ geocode: {} }), fetchImpl = globalThis.fetch, now = () => Date.now(), env = process.env, log = () => {} } = {}) {
  let lastCallAt = 0;
  let queue = Promise.resolve();
  const disabledByEnv = String(env.LOCATION_GEOCODE || '').toLowerCase() === 'off';

  const cfg = () => {
    const s = settings() || {};
    const g = s.geocode || {};
    return {
      enabled: !disabledByEnv && g.enabled !== false,
      poiSearch: !disabledByEnv && g.poiSearch !== false,
      minIntervalMs: Math.max(1000, Number(g.minIntervalMs || 3000)),
      cacheDays: Math.max(1, Number(g.cacheDays || 30)),
      timeoutMs: Math.max(1500, Number(g.timeoutMs || 6000)),
    };
  };

  /** Serialises outgoing calls so the 1 req/s policy holds even under bursts. */
  function throttle(fn) {
    const run = queue.then(async () => {
      const gap = cfg().minIntervalMs - (now() - lastCallAt);
      if (gap > 0 && lastCallAt > 0) await new Promise((r) => setTimeout(r, gap));
      lastCallAt = now();
      return fn();
    });
    // The chain must survive a failed call, otherwise one timeout blocks every later lookup.
    queue = run.then(() => undefined, () => undefined);
    return run;
  }

  async function fetchJson(url, { method = 'GET', body = null } = {}) {
    const c = cfg();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), c.timeoutMs);
    try {
      const res = await fetchImpl(url, {
        method,
        body,
        signal: ctrl.signal,
        headers: {
          'User-Agent': defaultUserAgent(env),
          'Accept': 'application/json',
          ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
        },
      });
      if (!res || !res.ok) return { ok: false, status: res?.status || 0 };
      return { ok: true, json: await res.json() };
    } catch (e) {
      return { ok: false, error: e?.name === 'AbortError' ? 'timeout' : (e?.message || 'network') };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Reverse geocode one point. Never throws.
   * @returns {Promise<null|{label:string|null, kind:string|null, category:string|null, type:string|null, displayName:string|null, osmId:string|null, cached:boolean, provider:'nominatim'}>}
   */
  async function reverse(lat, lon) {
    const c = cfg();
    if (!c.enabled) return null;
    const key = `rev:${cacheKey(lat, lon)}`;
    const hit = store.geocodeCache.get(key);
    if (hit?.payload) return { ...hit.payload, cached: true };
    const url = `${NOMINATIM}/reverse?format=jsonv2&lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}&zoom=18&addressdetails=1&accept-language=id`;
    const out = await throttle(async () => fetchJson(url));
    if (!out.ok) {
      log(`[GEOCODE] reverse gagal (${out.error || out.status}) — lokasi dibiarkan belum teridentifikasi`);
      return null;
    }
    const j = out.json || {};
    if (!j || j.error) return null;
    const tags = j.extratags || {};
    const payload = {
      label: labelFromAddress(j.address || {}, j.display_name || null),
      kind: kindFromTags({ ...tags, category: j.category, type: j.type }) || kindFromTags({ [j.category || 'x']: j.type }),
      category: j.category || null,
      type: j.type || null,
      displayName: j.display_name ? String(j.display_name).slice(0, 300) : null,
      osmId: j.osm_id ? `${j.osm_type || 'node'}/${j.osm_id}` : null,
      address: j.address || null,
      provider: 'nominatim',
    };
    store.geocodeCache.put(key, 'nominatim', lat, lon, payload, c.cacheDays * 86_400_000);
    return { ...payload, cached: false };
  }

  /**
   * Nearby POIs from Overpass within `radiusM`. Cached per ~11 m cell for 7 days —
   * shops do not move, and this is the heaviest external call.
   * @returns {Promise<Array<{name:string, kind:string, distanceM:number, lat:number, lon:number, brand:string|null}>>}
   */
  async function nearbyPoi(lat, lon, radiusM = 200) {
    const c = cfg();
    if (!c.poiSearch) return [];
    const key = `poi:${cacheKey(lat, lon)}:${Math.round(radiusM)}`;
    const hit = store.geocodeCache.get(key);
    if (hit?.payload) return hit.payload;
    const around = `around:${Math.round(radiusM)},${Number(lat).toFixed(6)},${Number(lon).toFixed(6)}`;
    const q = `[out:json][timeout:20];(
      nwr[amenity~"^(fuel|restaurant|cafe|fast_food|food_court|marketplace|parking|university|college|school|pharmacy|bank|atm|hospital|clinic|doctors)$"](${around});
      nwr[shop~"^(convenience|supermarket|mall|department_store|bakery|motorcycle_repair|car_repair|tyres|laundry|chemist)$"](${around});
      nwr[office](${around});
      nwr[building=office](${around});
    );out center tags 60;`;
    const out = await throttle(async () => fetchJson(OVERPASS, { method: 'POST', body: `data=${encodeURIComponent(q)}` }));
    if (!out.ok) {
      log(`[GEOCODE] Overpass gagal (${out.error || out.status}) — klasifikasi hanya memakai geofence & riwayat`);
      return [];
    }
    const els = Array.isArray(out.json?.elements) ? out.json.elements : [];
    const pois = [];
    for (const el of els) {
      const plat = el.lat ?? el.center?.lat;
      const plon = el.lon ?? el.center?.lon;
      if (!Number.isFinite(plat) || !Number.isFinite(plon)) continue;
      const tags = el.tags || {};
      const kind = kindFromTags(tags);
      const name = tags.name || tags.brand || null;
      if (!kind && !name) continue;
      const brand = name ? kindFromName(name) : null;
      const dLat = (plat - lat) * 111_320;
      const dLon = (plon - lon) * 111_320 * Math.cos((lat * Math.PI) / 180);
      pois.push({
        name: name || null,
        kind: brand?.kind || kind || null,
        brand: brand?.name || tags.brand || null,
        distanceM: Math.round(Math.hypot(dLat, dLon)),
        lat: plat,
        lon: plon,
        tags: { amenity: tags.amenity || null, shop: tags.shop || null, office: tags.office || null },
      });
    }
    pois.sort((a, b) => a.distanceM - b.distanceM);
    const trimmed = pois.slice(0, 30);
    store.geocodeCache.put(key, 'overpass', lat, lon, trimmed, 7 * 86_400_000);
    return trimmed;
  }

  return {
    reverse,
    nearbyPoi,
    enabled: () => cfg().enabled,
    poiEnabled: () => cfg().poiSearch,
    provider: NOMINATIM,
    overpass: OVERPASS,
    /** Test hook: forget the throttle state. */
    _reset: () => { lastCallAt = 0; queue = Promise.resolve(); },
  };
}
