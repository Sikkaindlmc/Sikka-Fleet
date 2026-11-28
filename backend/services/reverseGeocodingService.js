'use strict';

/**
 * Reverse geocoding - OpenStreetMap only (NO API key, NO Google).
 *   Nominatim : address  (plot/house, street, building, sector, area, city/village,
 *                         tehsil, district, state, PIN, country)
 *   Overpass  : nearest named place within 100 metres
 * Results are cached in MongoDB (GeocodeCache) for 30 days.
 */

const M = require('../models');
const axios = require('axios');

const ADDRESS_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const FAILURE_CACHE_TTL_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 8000;
const NEARBY_TIMEOUT_MS = 5000;
const NEARBY_RADIUS_M = 100;
const NOMINATIM_REQUEST_INTERVAL_MS = 1000;

const NOMINATIM_REVERSE_URL = 'https://nominatim.openstreetmap.org/reverse';
const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';

const inFlight = new Map();
let localNextNominatimRequestAt = 0;

/* --------------------------------
   BASIC HELPERS
--------------------------------- */

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function validCoordinates(lat, lng) {
  if (
    lat === null || lat === undefined || String(lat).trim() === '' ||
    lng === null || lng === undefined || String(lng).trim() === ''
  ) {
    return false;
  }

  const latitude = Number(lat);
  const longitude = Number(lng);

  return (
    Number.isFinite(latitude) &&
    Number.isFinite(longitude) &&
    latitude >= -90 &&
    latitude <= 90 &&
    longitude >= -180 &&
    longitude <= 180
  );
}

function coordinateKey(lat, lng) {
  return `${Number(lat).toFixed(5)},${Number(lng).toFixed(5)}`;
}

function isCoordinateText(value) {
  return (
    typeof value === 'string' &&
    /^\s*-?\d+(?:\.\d+)?\s*,\s*-?\d+(?:\.\d+)?\s*$/.test(value)
  );
}

function isAddressText(value) {
  return (
    typeof value === 'string' &&
    Boolean(value.trim()) &&
    !isCoordinateText(value) &&
    !/\b(?:undefined|null)\b/i.test(value)
  );
}

function joinAddress(parts) {
  const included = [];

  for (const part of parts) {
    const value = text(part);

    if (
      value &&
      !included.some(item => item.toLowerCase() === value.toLowerCase())
    ) {
      included.push(value);
    }
  }

  return included.join(', ');
}

function haversineMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const rad = Math.PI / 180;
  const a =
    Math.sin(((lat2 - lat1) * rad) / 2) ** 2 +
    Math.cos(lat1 * rad) *
      Math.cos(lat2 * rad) *
      Math.sin(((lng2 - lng1) * rad) / 2) ** 2;

  return 2 * R * Math.asin(Math.sqrt(a));
}

/**
 * One readable line, in this order:
 * plot/khasra/house no, gali, street/road, building/apartment, sector,
 * area, nearest place (<100 m), city/village, tehsil, district, state, PIN, country
 */
function formatAddress(fields = {}) {
  const nearby = text(fields.nearby) ? `Near ${text(fields.nearby)}` : '';

  return joinAddress([
    fields.street,
    fields.galiNumber,
    fields.road,
    fields.building,
    fields.sector,
    fields.locality,
    nearby,
    fields.cityOrVillage,
    fields.subDistrict,
    fields.district,
    fields.state,
    fields.pincode,
    fields.country
  ]);
}

/* --------------------------------
   OPENSTREETMAP RESPONSE PARSER
--------------------------------- */

const AREA_KEYS = [
  'neighbourhood', 'suburb', 'quarter', 'residential',
  'industrial', 'city_district', 'hamlet'
];

function parseNominatim(payload) {
  if (!payload || typeof payload !== 'object' || payload.error) {
    return null;
  }

  const a = payload.address || {};
  const first = (...keys) => keys.map(k => text(a[k])).find(Boolean) || '';
  const areas = AREA_KEYS.map(k => text(a[k])).filter(Boolean);

  // Plot / khasra / house number (OSM rarely has khasra - also look inside names)
  let plot = first('house_number', 'house_name');

  if (!plot) {
    plot =
      [text(payload.name), ...areas].find(v =>
        /(khasra|khasara|khewat|plot)/i.test(v)
      ) || '';
  }

  const road = first('road', 'pedestrian', 'residential', 'footway', 'path');

  const galiNumber =
    [road, ...areas].find(v => /gali/i.test(v)) || '';

  // Apartment / building / premises name
  const building =
    text(a.building) && text(a.building).toLowerCase() !== 'yes'
      ? text(a.building)
      : payload.addresstype &&
        !['road', 'house', 'place', 'neighbourhood', 'suburb', 'village', 'city', 'town']
          .includes(payload.addresstype) &&
        text(payload.name)
        ? text(payload.name)
        : '';

  const sector =
    areas.find(v =>
      /(sector|phase|block|colony|nagar|vihar|extension)/i.test(v)
    ) || '';

  const locality = areas.find(v => v !== sector) || '';

  const district = first('state_district', 'district', 'county');
  const subDistrict =
    first('state_district', 'district') && text(a.county) ? text(a.county) : '';

  const fields = {
    street: plot,
    galiNumber,
    road,
    building,
    sector,
    locality,
    nearby: '', // filled from Overpass (nearest place within 100 m)

    cityOrVillage: first('city', 'town', 'village', 'municipality', 'hamlet'),
    subDistrict,
    district,
    state: first('state', 'region'),
    pincode: first('postcode'),
    country: first('country')
  };

  const readableLocation =
    formatAddress(fields) || text(payload.display_name);

  if (!isAddressText(readableLocation)) {
    return null;
  }

  return { ...fields, readableLocation };
}

/* --------------------------------
   CACHE RESPONSE FORMAT
--------------------------------- */

function cachedAddress(cached, lat, lng) {
  if (
    !cached ||
    cached.provider !== 'Nominatim' ||
    !isAddressText(cached.readableLocation)
  ) {
    return null;
  }

  return {
    readableLocation: cached.readableLocation,

    street: cached.street || '',
    galiNumber: cached.galiNumber || '',
    road: cached.road || '',
    building: cached.building || '',
    sector: cached.sector || '',
    locality: cached.locality || '',
    nearby: cached.nearby || '',

    city: cached.cityOrVillage || cached.city || '',
    cityOrVillage: cached.cityOrVillage || cached.city || '',

    subDistrict: cached.subDistrict || '',
    district: cached.district || '',
    state: cached.state || '',
    pincode: cached.pincode || '',
    country: cached.country || '',

    provider: cached.provider,
    geocodedAt: cached.geocodedAt || null,

    addressLat: Number(lat),
    addressLng: Number(lng),
    addressIsCurrent: true
  };
}

/* --------------------------------
   SAVE SUCCESSFUL ADDRESS
--------------------------------- */

async function saveAddress(key, lat, lng, address, provider) {
  const now = new Date();

  await M.GeocodeCache.updateOne(
    { key },
    {
      $set: {
        key,

        lat: Number(Number(lat).toFixed(5)),
        lng: Number(Number(lng).toFixed(5)),

        ...address,

        provider,
        geocodedAt: now,

        expiresAt: new Date(now.getTime() + ADDRESS_CACHE_TTL_MS)
      },

      $unset: {
        failureUntil: '',
        baseReadableLocation: '',
        basePlaceName: '',
        layer2Provider: '',
        layer2GeocodedAt: '',
        layer2FailureUntil: ''
      }
    },
    { upsert: true }
  );
}

/* --------------------------------
   SAVE FAILED LOOKUP
--------------------------------- */

async function saveFailure(key, lat, lng) {
  const failureUntil = new Date(Date.now() + FAILURE_CACHE_TTL_MS);

  await M.GeocodeCache.updateOne(
    { key },
    {
      $set: {
        key,

        lat: Number(Number(lat).toFixed(5)),
        lng: Number(Number(lng).toFixed(5)),

        failureUntil,
        expiresAt: failureUntil
      },

      $unset: {
        readableLocation: '',
        baseReadableLocation: '',
        basePlaceName: '',
        street: '',
        galiNumber: '',
        road: '',
        building: '',
        sector: '',
        nearby: '',
        locality: '',
        city: '',
        cityOrVillage: '',
        subDistrict: '',
        district: '',
        state: '',
        pincode: '',
        country: '',
        provider: '',
        geocodedAt: ''
      }
    },
    { upsert: true }
  );
}

/* --------------------------------
   NOMINATIM RATE LIMITER (1 request / second)

   Uses MongoDB distributed locking when
   GeocodeRequestSlot exists; local throttle
   is the fallback.
--------------------------------- */

async function waitForLocalSlot() {
  while (true) {
    const wait = Math.max(0, localNextNominatimRequestAt - Date.now());

    if (wait > 0) {
      await new Promise(resolve => setTimeout(resolve, wait));
    }

    const now = Date.now();

    if (now >= localNextNominatimRequestAt) {
      localNextNominatimRequestAt = now + NOMINATIM_REQUEST_INTERVAL_MS;

      return true;
    }
  }
}

async function waitForNominatimSlot() {
  const Slot = M.GeocodeRequestSlot;

  if (!Slot) {
    console.warn(
      '[Geocoding] MongoDB request-slot model unavailable; using local rate limit'
    );

    return waitForLocalSlot();
  }

  try {
    await Slot.updateOne(
      { key: 'nominatim-reverse' },
      {
        $setOnInsert: {
          key: 'nominatim-reverse',
          nextAllowedAt: new Date(0)
        }
      },
      { upsert: true }
    );

    while (true) {
      const current = await Slot.findOne({
        key: 'nominatim-reverse'
      }).select('nextAllowedAt').lean();

      if (!current) {
        return waitForLocalSlot();
      }

      const now = new Date();
      const nextAt = new Date(current.nextAllowedAt || 0);

      if (nextAt > now) {
        await new Promise(resolve =>
          setTimeout(
            resolve,
            Math.max(50, Math.min(1000, nextAt.getTime() - Date.now()))
          )
        );

        continue;
      }

      // Atomic compare-and-set: two backend instances cannot take the same slot.
      const reserved = await Slot.findOneAndUpdate(
        {
          key: 'nominatim-reverse',
          nextAllowedAt: current.nextAllowedAt
        },
        {
          $set: {
            nextAllowedAt: new Date(
              Date.now() + NOMINATIM_REQUEST_INTERVAL_MS
            )
          }
        },
        { new: true }
      );

      if (reserved) {
        return true;
      }
    }
  } catch (error) {
    console.warn(
      '[Geocoding] MongoDB rate limiter unavailable; using local rate limit'
    );

    return waitForLocalSlot();
  }
}

/* --------------------------------
   OPENSTREETMAP: ADDRESS (Nominatim)
--------------------------------- */

function userAgent() {
  return (
    text(process.env.GEOCODER_USER_AGENT) ||
    'SikkaFleet/1.0 (contact: admin@sikkaind.com)'
  );
}

async function nominatimLookup(lat, lng) {
  if (!(await waitForNominatimSlot())) {
    return null;
  }

  try {
    const response = await axios.get(NOMINATIM_REVERSE_URL, {
      params: {
        lat: Number(lat),
        lon: Number(lng),
        format: 'jsonv2',
        addressdetails: 1,
        zoom: 18
      },

      timeout: REQUEST_TIMEOUT_MS,

      headers: {
        'Accept-Language': 'en',
        'User-Agent': userAgent()
      }
    });

    return parseNominatim(response.data);
  } catch (error) {
    console.warn(
      `[Geocoding] Nominatim request failed: ${error.response?.status || error.code || 'ERROR'}`
    );

    return null;
  }
}

/* --------------------------------
   OPENSTREETMAP: NEAREST PLACE <= 100 m (Overpass)
   Optional - failure never blocks the address.
--------------------------------- */

async function nearbyLookup(lat, lng) {
  try {
    const query =
      `[out:json][timeout:4];` +
      `nwr(around:${NEARBY_RADIUS_M},${Number(lat)},${Number(lng)})[name];` +
      `out center tags 40;`;

    const response = await axios.post(
      OVERPASS_URL,
      `data=${encodeURIComponent(query)}`,
      {
        timeout: NEARBY_TIMEOUT_MS,
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': userAgent()
        }
      }
    );

    const found = [];

    for (const el of response.data?.elements || []) {
      const t = el.tags || {};

      // roads, boundaries and areas are not "nearby places"
      if (t.highway || t.boundary || t.admin_level || t.place || t.waterway) {
        continue;
      }

      const elLat = el.lat ?? el.center?.lat;
      const elLng = el.lon ?? el.center?.lon;

      if (elLat === undefined || elLng === undefined) continue;

      const distance = Math.round(
        haversineMeters(Number(lat), Number(lng), elLat, elLng)
      );

      if (distance > NEARBY_RADIUS_M) continue;

      const kind = text(
        t.amenity || t.shop || t.tourism || t.office ||
        t.industrial || t.man_made || t.railway || ''
      ).replace(/_/g, ' ');

      found.push({
        name: text(t.name),
        kind,
        distance
      });
    }

    found.sort((x, y) => x.distance - y.distance);

    const best = found[0];

    return best
      ? `${best.name}${best.kind ? ` (${best.kind})` : ''} - ${best.distance} m`
      : '';
  } catch (error) {
    console.warn(
      `[Geocoding] Overpass nearby lookup failed: ${error.response?.status || error.code || 'ERROR'}`
    );

    return '';
  }
}

/* --------------------------------
   LOOKUP + CACHE (OpenStreetMap only)
--------------------------------- */

async function lookupAndCache(key, lat, lng) {
  // Address and nearest place are fetched in parallel (keeps serverless time low).
  const [address, nearby] = await Promise.all([
    nominatimLookup(lat, lng),
    nearbyLookup(lat, lng)
  ]);

  if (!address) {
    try {
      await saveFailure(key, lat, lng);
    } catch (error) {
      console.warn('[Geocoding] Could not cache failed lookup');
    }

    return null;
  }

  address.nearby = nearby;
  address.readableLocation =
    formatAddress(address) || address.readableLocation;

  const provider = 'Nominatim';

  try {
    await saveAddress(key, lat, lng, address, provider);
  } catch (error) {
    console.warn('[Geocoding] Could not cache resolved address');
  }

  return {
    ...address,

    city: address.cityOrVillage || '',
    provider,

    addressLat: Number(lat),
    addressLng: Number(lng),
    addressIsCurrent: true
  };
}

/* --------------------------------
   MAIN RESOLVE FUNCTION
--------------------------------- */

async function resolve(lat, lng) {
  if (!validCoordinates(lat, lng)) {
    return null;
  }

  const latitude = Number(lat);
  const longitude = Number(lng);

  const key = coordinateKey(latitude, longitude);

  // 1. MongoDB cache
  try {
    const cached = await M.GeocodeCache.findOne({ key }).lean();

    if (
      cached &&
      cached.expiresAt &&
      new Date(cached.expiresAt) > new Date()
    ) {
      const address = cachedAddress(cached, latitude, longitude);

      if (address) {
        return address;
      }

      if (cached.failureUntil && new Date(cached.failureUntil) > new Date()) {
        return null;
      }
    }
  } catch (error) {
    console.warn('[Geocoding] MongoDB cache read failed');
  }

  // 2. Same coordinates already being fetched
  if (inFlight.has(key)) {
    return inFlight.get(key);
  }

  // 3. OpenStreetMap lookup
  const pending = lookupAndCache(key, latitude, longitude)
    .catch(error => {
      console.warn('[Geocoding] Unexpected reverse geocoding error');

      return null;
    })
    .finally(() => {
      inFlight.delete(key);
    });

  inFlight.set(key, pending);

  return pending;
}

function enqueue(lat, lng) {
  return resolve(lat, lng);
}

/* --------------------------------
   EXPORTS
--------------------------------- */

module.exports = {
  resolve,
  enqueue,

  validCoordinates,
  coordinateKey,

  isCoordinateText,
  isAddressText,

  parseNominatim,
  formatAddress,

  ADDRESS_CACHE_TTL_MS,
  FAILURE_CACHE_TTL_MS,
  REQUEST_TIMEOUT_MS
};
