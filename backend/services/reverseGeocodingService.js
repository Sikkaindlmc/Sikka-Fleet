'use strict';

const M = require('../models');
const axios = require('axios');
const geoNames = require('./geoNamesService');

const ADDRESS_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const FAILURE_CACHE_TTL_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 12000;
const OVERPASS_TIMEOUT_MS = 18000;
const NEARBY_RADIUS_M = 100;
const PROVIDER_REQUEST_INTERVAL_MS = 1000;
const MAX_OVERPASS_RETRIES = 2;
const OVERPASS_RETRY_DELAY_MS = 500;
const NOMINATIM_REVERSE_URL = 'https://nominatim.openstreetmap.org/reverse';
const GOOGLE_REVERSE_URL = 'https://maps.googleapis.com/maps/api/geocode/json';
const DEFAULT_OVERPASS_ENDPOINTS = [
 'https://overpass-api.de/api/interpreter',
 'https://overpass.kumi.systems/api/interpreter',
 'https://overpass.private.coffee/api/interpreter'
];

const inFlight = new Map();
const localNextRequestAt = new Map();

function text(value) {
 return typeof value === 'string' ? value.trim() : '';
}

function validCoordinates(lat, lng) {
 if (lat === null || lat === undefined || String(lat).trim() === '' ||
  lng === null || lng === undefined || String(lng).trim() === '') return false;
 const latitude = Number(lat);
 const longitude = Number(lng);
 return Number.isFinite(latitude) && Number.isFinite(longitude) &&
  latitude >= -90 && latitude <= 90 && longitude >= -180 && longitude <= 180;
}

function coordinateKey(lat, lng) {
 return `${Number(lat).toFixed(5)},${Number(lng).toFixed(5)}`;
}

function isCoordinateText(value) {
 return typeof value === 'string' &&
  /^\s*-?\d+(?:\.\d+)?\s*,\s*-?\d+(?:\.\d+)?\s*$/.test(value);
}

function isAddressText(value) {
 return typeof value === 'string' && Boolean(value.trim()) &&
  !isCoordinateText(value) &&
  !/^(?:address|location)\s+unavailable$/i.test(value.trim()) &&
  !/\b(?:undefined|null)\b/i.test(value);
}

function joinAddress(parts) {
 const included = [];
 for (const part of parts) {
  const value = text(part);
  if (value && !included.some(item => item.toLowerCase() === value.toLowerCase())) {
   included.push(value);
  }
 }
 return included.join(', ');
}

function haversineMeters(lat1, lng1, lat2, lng2) {
 const radians = Math.PI / 180;
 const dLat = (lat2 - lat1) * radians;
 const dLng = (lng2 - lng1) * radians;
 const a = Math.sin(dLat / 2) ** 2 +
  Math.cos(lat1 * radians) * Math.cos(lat2 * radians) * Math.sin(dLng / 2) ** 2;
 return 6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function formatAddress(fields = {}) {
 const nearby = text(fields.nearby) ? `Near ${text(fields.nearby)}` : '';
 const pin = text(fields.pincode) ? `PIN ${text(fields.pincode)}` : '';
 const addressParts = [
  fields.locality,
  fields.building,
  fields.plotNumber,
  fields.galiNumber,
  fields.street || fields.road,
  fields.sector,
  fields.cityOrVillage || fields.city,
  fields.district,
  fields.division
 ];
 const hasLocationComponent = addressParts.some(value => text(value));
 const address = hasLocationComponent
  ? joinAddress([...addressParts, pin, fields.state, fields.country])
  : joinAddress([fields.formattedAddress, fields.readableLocation, pin, fields.state, fields.country]);
 return joinAddress([address, nearby]);
}

function firstComponent(components, types) {
 const component = components.find(item =>
  Array.isArray(item.types) && types.some(type => item.types.includes(type))
 );
 return component ? text(component.long_name) : '';
}

function parseGoogle(payload) {
 if (!payload || payload.status !== 'OK' || !Array.isArray(payload.results) ||
  !payload.results.length) return null;
 const result = payload.results[0];
 const components = Array.isArray(result.address_components) ? result.address_components : [];
 const fields = {
  street: firstComponent(components, ['route']),
  road: firstComponent(components, ['route']),
  plotNumber: firstComponent(components, ['street_number']),
  houseNumber: firstComponent(components, ['street_number']),
  building: firstComponent(components, ['premise', 'subpremise']),
  galiNumber: '',
  sector: '',
  locality: '',
  nearby: '',
  cityOrVillage: firstComponent(components, ['locality', 'postal_town', 'administrative_area_level_4']),
  city: firstComponent(components, ['locality', 'postal_town', 'administrative_area_level_4']),
  district: firstComponent(components, ['administrative_area_level_2']),
  division: firstComponent(components, ['administrative_area_level_3']),
  pincode: firstComponent(components, ['postal_code']),
  state: firstComponent(components, ['administrative_area_level_1']),
  country: firstComponent(components, ['country']),
  formattedAddress: text(result.formatted_address)
 };
 const sublocality = firstComponent(components, ['sublocality_level_1', 'sublocality']);
 fields.sector = /^(?:sector|phase|block)\b/i.test(sublocality) ? sublocality : '';
 fields.locality = firstComponent(components, ['neighborhood', 'sublocality_level_2']) ||
  (sublocality && sublocality !== fields.sector ? sublocality : '');
 const readableLocation = formatAddress(fields) || fields.formattedAddress;
 return isAddressText(readableLocation) ? { ...fields, readableLocation } : null;
}

function parseNominatim(payload) {
 if (!payload || typeof payload !== 'object' || Array.isArray(payload) || payload.error) return null;
 const address = payload.address && typeof payload.address === 'object' ? payload.address : {};
 const first = (...keys) => keys.map(key => text(address[key])).find(Boolean) || '';
 const areas = [
  first('neighbourhood'), first('suburb'), first('quarter'),
  first('residential'), first('industrial'), first('city_district')
 ].filter(Boolean);
 const road = first('road', 'pedestrian', 'residential', 'footway', 'path');
 const sublocality = areas[0] || '';
 const sector = areas.find(value => /^(?:sector|phase|block)\b/i.test(value)) || '';
 const fields = {
  street: road,
  road,
  plotNumber: first('house_number', 'house_name', 'plot_number', 'plot', 'khasra'),
  houseNumber: first('house_number', 'house_name', 'plot_number', 'plot', 'khasra'),
  building: first('building') === 'yes' ? '' : first('building'),
  galiNumber: /gali/i.test(road) ? road : '',
  sector,
  locality: areas.find(value => value !== sector) || '',
  nearby: '',
  cityOrVillage: first('city', 'town', 'village', 'municipality', 'hamlet'),
  city: first('city', 'town', 'village', 'municipality', 'hamlet'),
  district: first('state_district', 'district', 'county'),
  division: first('division', 'region'),
  pincode: first('postcode'),
  state: first('state'),
  country: first('country'),
  formattedAddress: text(payload.display_name)
 };
 if (!fields.building && text(payload.name) &&
  !['road', 'house', 'place', 'neighbourhood', 'suburb', 'village', 'city', 'town'].includes(payload.addresstype)) {
  fields.building = text(payload.name);
 }
 const readableLocation = formatAddress(fields) || fields.formattedAddress;
 return isAddressText(readableLocation) ? { ...fields, readableLocation } : null;
}

function categoryFor(tags) {
 const keys = [
  'amenity', 'healthcare', 'shop', 'tourism', 'office', 'industrial',
  'building', 'place', 'railway', 'public_transport', 'leisure', 'historic',
  'man_made', 'craft', 'emergency', 'landuse', 'natural', 'club', 'sport', 'religion', 'highway'
 ];
 for (const key of keys) {
  const value = text(tags[key]);
  if (value && value !== 'yes') return value.replace(/_/g, ' ');
 }
 return '';
}

function parseNearbyElements(elements, lat, lng) {
 if (!Array.isArray(elements)) return [];
 const places = [];
 for (const element of elements) {
  if (!element || typeof element !== 'object') continue;
  const tags = element.tags && typeof element.tags === 'object' ? element.tags : {};
  if (tags.boundary === 'administrative' || tags.admin_level) continue;
  const elementLat = Number(element.lat ?? element.center?.lat);
  const elementLng = Number(element.lon ?? element.center?.lon);
  if (!Number.isFinite(elementLat) || !Number.isFinite(elementLng)) continue;
  const distanceMeters = haversineMeters(Number(lat), Number(lng), elementLat, elementLng);
  if (distanceMeters > NEARBY_RADIUS_M) continue;
  const category = categoryFor(tags);
  const addressNumber = text(tags['addr:housenumber']);
  const name = text(tags.name) ||
   (addressNumber ? `House ${addressNumber}` : category ? category[0].toUpperCase() + category.slice(1) : '');
  if (!name) continue;
  places.push({
   name,
   category,
   distanceMeters: Math.round(distanceMeters),
   provider: 'Overpass'
  });
 }
 return places.sort((first, second) =>
  first.distanceMeters - second.distanceMeters || first.name.localeCompare(second.name)
 );
}

function cachedAddress(cached, lat, lng) {
 if (!cached || !isAddressText(cached.readableLocation)) return null;
 return {
  readableLocation: cached.readableLocation,
  street: cached.street || '',
  plotNumber: cached.plotNumber || cached.houseNumber || '',
  houseNumber: cached.houseNumber || cached.plotNumber || '',
  galiNumber: cached.galiNumber || '',
  road: cached.road || '',
  building: cached.building || '',
  sector: cached.sector || '',
  locality: cached.locality || '',
  nearby: cached.nearby || '',
  nearestLocation: cached.nearestLocation || '',
  nearestLocationCategory: cached.nearestLocationCategory || '',
  nearestLocationDistanceMeters: cached.nearestLocationDistanceMeters ?? null,
  nearbyProvider: cached.nearbyProvider || '',
  city: cached.cityOrVillage || cached.city || '',
  cityOrVillage: cached.cityOrVillage || cached.city || '',
  district: cached.district || '',
  division: cached.division || '',
  pincode: cached.pincode || '',
  state: cached.state || '',
  country: cached.country || '',
  provider: cached.provider || 'Coordinate',
  geocodedAt: cached.geocodedAt || null,
  addressLat: Number(lat),
  addressLng: Number(lng),
  addressIsCurrent: true,
  addressEnrichmentPending: !cached.nearbyFetchedAt &&
   !(cached.nearbyFailureUntil && new Date(cached.nearbyFailureUntil) > new Date())
 };
}

function googleApiKey() {
 return text(process.env.GOOGLE_GEOCODING_API_KEY || process.env.GOOGLE_MAPS_API_KEY) ||
  (String(process.env.GEOCODER_PROVIDER || '').toLowerCase() === 'google'
   ? text(process.env.GEOCODER_API_KEY) : '');
}

async function googleLookup(lat, lng) {
 const key = googleApiKey();
 if (!key) return null;
 try {
  const response = await axios.get(GOOGLE_REVERSE_URL, {
   params: { latlng: `${Number(lat)},${Number(lng)}`, key, language: 'en' },
   timeout: REQUEST_TIMEOUT_MS,
   headers: { Accept: 'application/json' }
  });
  return parseGoogle(response.data);
 } catch (error) {
  console.warn(`[Geocoding] Google reverse lookup failed: ${error.response?.status || error.code || 'ERROR'}`);
  return null;
 }
}

function userAgent() {
 return text(process.env.GEOCODER_USER_AGENT) ||
  'SikkaFleet/1.0 (contact: admin@sikkaind.com)';
}

async function localRateLimit(key) {
 while (true) {
  const wait = Math.max(0, (localNextRequestAt.get(key) || 0) - Date.now());
  if (wait) await new Promise(resolve => setTimeout(resolve, wait));
  const now = Date.now();
  if (now >= (localNextRequestAt.get(key) || 0)) {
   localNextRequestAt.set(key, now + PROVIDER_REQUEST_INTERVAL_MS);
   return;
  }
 }
}

async function waitForProviderSlot(key) {
 if (process.env.NODE_ENV === 'test') return;
 const Slot = M.GeocodeRequestSlot;
 if (!Slot) return localRateLimit(key);
 try {
  await Slot.updateOne(
   { key },
   { $setOnInsert: { key, nextAllowedAt: new Date(0) } },
   { upsert: true }
  );
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
   const current = await Slot.findOne({ key }).select('nextAllowedAt').lean();
   if (!current) break;
   const nextAllowedAt = new Date(current.nextAllowedAt || 0);
   const now = new Date();
   if (nextAllowedAt > now) {
    await new Promise(resolve => setTimeout(resolve, Math.min(1000, nextAllowedAt.getTime() - now.getTime())));
    continue;
   }
   const reserved = await Slot.findOneAndUpdate(
    { key, nextAllowedAt: current.nextAllowedAt },
    { $set: { nextAllowedAt: new Date(Date.now() + PROVIDER_REQUEST_INTERVAL_MS) } },
    { returnDocument: 'after' }
   );
   if (reserved) return;
  }
  console.warn(`[Geocoding] ${key} rate-limit slot unavailable; using local limiter`);
 } catch (error) {
  console.warn(`[Geocoding] ${key} MongoDB rate limiter unavailable; using local limiter`);
 }
 await localRateLimit(key);
}

async function nominatimLookup(lat, lng) {
 await waitForProviderSlot('nominatim-reverse');
 try {
  const response = await axios.get(
   text(process.env.NOMINATIM_REVERSE_URL) || NOMINATIM_REVERSE_URL,
   {
    params: {
     lat: Number(lat), lon: Number(lng), format: 'jsonv2',
     addressdetails: 1, namedetails: 1, zoom: 18
    },
    timeout: REQUEST_TIMEOUT_MS,
    headers: { 'Accept-Language': 'en', 'User-Agent': userAgent() }
   }
  );
  return parseNominatim(response.data);
 } catch (error) {
  console.warn(`[Geocoding] Nominatim reverse lookup failed: ${error.response?.status || error.code || 'ERROR'}`);
  return null;
 }
}

function overpassEndpoints() {
 const configured = [
  process.env.OVERPASS_API_URL,
  process.env.OVERPASS_FALLBACK_URL,
  ...DEFAULT_OVERPASS_ENDPOINTS
 ].map(text).filter(Boolean).filter((value, index, list) => list.indexOf(value) === index);
 return configured;
}

function overpassQuery(lat, lng) {
 const around = `around:${NEARBY_RADIUS_M},${Number(lat)},${Number(lng)}`;
 return `[out:json][timeout:15];(` +
  `nwr(${around})[name];` +
  `nwr(${around})[~"^addr:"~"."];` +
  `nwr(${around})[building];` +
  `nwr(${around})[amenity];` +
  `nwr(${around})[shop];` +
  `nwr(${around})[tourism];` +
  `nwr(${around})[office];` +
  `nwr(${around})[industrial];` +
  `nwr(${around})[man_made];` +
  `nwr(${around})[place];` +
  `nwr(${around})[railway];` +
  `nwr(${around})[public_transport];` +
  `nwr(${around})[leisure];` +
  `nwr(${around})[historic];` +
  `nwr(${around})[healthcare];` +
  `nwr(${around})[emergency];` +
  `nwr(${around})[craft];` +
  `nwr(${around})[sport];` +
  `nwr(${around})[religion];` +
  `);out center tags;`;
}

function shouldRetryOverpass(error) {
 const status = Number(error?.response?.status);
 return error?.code === 'ECONNABORTED' || error?.code === 'ETIMEDOUT' ||
  !error?.response || [429, 500, 502, 503, 504].includes(status);
}

async function nearbyLookup(lat, lng) {
 const endpoints = overpassEndpoints();
 const query = overpassQuery(lat, lng);
 for (let attempt = 0; attempt <= MAX_OVERPASS_RETRIES; attempt++) {
  const endpoint = endpoints[attempt % endpoints.length];
  await waitForProviderSlot('overpass-nearby');
  try {
   const response = await axios.post(
    endpoint,
    `data=${encodeURIComponent(query)}`,
    {
     timeout: OVERPASS_TIMEOUT_MS,
     headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': userAgent()
     }
    }
   );
   if (!Array.isArray(response.data?.elements)) {
    throw new Error('Overpass returned an invalid response');
   }
   const places = parseNearbyElements(response.data.elements, lat, lng);
   return { place: places[0] || null, fetchedAt: new Date(), failed: false };
  } catch (error) {
   const code = error.response?.status || error.code || 'ERROR';
   console.warn(`[Geocoding] Overpass nearby lookup failed (${attempt + 1}/${MAX_OVERPASS_RETRIES + 1}): ${code}`);
   if (attempt === MAX_OVERPASS_RETRIES || !shouldRetryOverpass(error)) break;
   await new Promise(resolve => setTimeout(resolve, OVERPASS_RETRY_DELAY_MS * (2 ** attempt)));
  }
 }
 return { place: null, fetchedAt: null, failed: true };
}

async function reverseAddress(lat, lng) {
 const google = await googleLookup(lat, lng);
 if (google) return { address: google, provider: 'Google' };
 const nominatim = await nominatimLookup(lat, lng);
 if (nominatim) return { address: nominatim, provider: 'Nominatim' };
 try {
  const offline = await geoNames.lookup(Number(lat), Number(lng));
  if (offline && isAddressText(offline.readableLocation)) {
   return {
    address: {
     readableLocation: offline.readableLocation,
     cityOrVillage: text(offline.placeName),
     city: text(offline.placeName),
     district: text(offline.district),
     state: text(offline.state),
     pincode: text(offline.postalCode),
     country: 'India',
     addressDistanceKm: Number.isFinite(Number(offline.distanceKm)) ? Number(offline.distanceKm) : null
    },
    provider: 'GeoNames'
   };
  }
 } catch (error) {
  console.warn('[Geocoding] Offline GeoNames lookup failed');
 }
 const coordinate = `${Number(lat).toFixed(6)}, ${Number(lng).toFixed(6)}`;
 return {
  address: {
   readableLocation: coordinate,
   street: '', plotNumber: '', houseNumber: '', galiNumber: '', road: '',
   building: '', sector: '', locality: '', nearby: '', city: '', cityOrVillage: '',
   district: '', division: '', pincode: '', state: '', country: ''
  },
  provider: 'Coordinate'
 };
}

function applyNearby(address, place) {
 const updated = { ...address };
 if (place) {
  updated.nearby = `${place.name} (${place.distanceMeters} m)`;
  updated.nearestLocation = place.name;
  updated.nearestLocationCategory = place.category;
  updated.nearestLocationDistanceMeters = place.distanceMeters;
  updated.nearbyProvider = place.provider;
  updated.readableLocation = formatAddress(updated) || updated.readableLocation;
 }
 return updated;
}

async function saveAddress(key, lat, lng, address, provider, nearbyResult) {
 const now = new Date();
 const completeAddress = applyNearby(address, nearbyResult.place);
 const nearbyFields = nearbyResult.failed
  ? { nearbyFailureUntil: new Date(now.getTime() + FAILURE_CACHE_TTL_MS) }
  : { nearbyFetchedAt: nearbyResult.fetchedAt || now };
 const unsetFields = {};
 if (!nearbyResult.failed) unsetFields.nearbyFailureUntil = '';
 if (provider !== 'Coordinate') unsetFields.failureUntil = '';
 await M.GeocodeCache.updateOne(
  { key },
  {
   $set: {
    key, lat: Number(Number(lat).toFixed(5)), lng: Number(Number(lng).toFixed(5)),
    ...completeAddress, provider, nearbyProvider: completeAddress.nearbyProvider || '',
    ...nearbyFields,
    ...(provider === 'Coordinate'
     ? { failureUntil: new Date(now.getTime() + FAILURE_CACHE_TTL_MS) }
     : {}),
    geocodedAt: now, expiresAt: new Date(now.getTime() + ADDRESS_CACHE_TTL_MS)
   },
   $unset: unsetFields
  },
  { upsert: true }
 );
 return completeAddress;
}

function cachedAddressIsFresh(cached) {
 return Boolean(cached?.expiresAt && new Date(cached.expiresAt) > new Date());
}

function nearbyCacheIsFresh(cached) {
 if (cached?.nearbyFetchedAt) return true;
 return Boolean(cached?.nearbyFailureUntil && new Date(cached.nearbyFailureUntil) > new Date());
}

async function lookupAndCache(key, lat, lng, cached = null) {
 const needAddress = !cached || !isAddressText(cached.readableLocation) ||
  cached.provider === 'Coordinate';
 const needNearby = !nearbyCacheIsFresh(cached);
 const [resolved, nearbyResult] = await Promise.all([
  needAddress ? reverseAddress(lat, lng) : Promise.resolve({
   address: cached,
   provider: cached.provider
  }),
  needNearby
   ? nearbyLookup(lat, lng)
   : Promise.resolve({
    place: cached?.nearestLocation ? {
     name: cached.nearestLocation,
     category: cached.nearestLocationCategory || '',
     distanceMeters: cached.nearestLocationDistanceMeters,
     provider: cached.nearbyProvider || 'Overpass'
    } : null,
    fetchedAt: cached?.nearbyFetchedAt || null,
    failed: Boolean(cached?.nearbyFailureUntil && new Date(cached.nearbyFailureUntil) > new Date())
   })
 ]);
 const address = { ...resolved.address };
 if (nearbyResult.failed) {
  address.nearby = cached?.nearby || '';
  address.nearestLocation = cached?.nearestLocation || '';
  address.nearestLocationCategory = cached?.nearestLocationCategory || '';
  address.nearestLocationDistanceMeters = cached?.nearestLocationDistanceMeters ?? null;
  address.nearbyProvider = cached?.nearbyProvider || '';
 } else if (!nearbyResult.place) {
  address.nearby = '';
  address.nearestLocation = '';
  address.nearestLocationCategory = '';
  address.nearestLocationDistanceMeters = null;
  address.nearbyProvider = '';
 }
 const complete = applyNearby(address, nearbyResult.place);
 try {
  await saveAddress(key, lat, lng, complete, resolved.provider, nearbyResult);
 } catch (error) {
  console.warn('[Geocoding] Could not cache resolved address');
 }
 return {
  ...complete,
  provider: resolved.provider,
  geocodedAt: new Date(),
  addressLat: Number(lat),
  addressLng: Number(lng),
  addressIsCurrent: true,
  addressEnrichmentPending: nearbyResult.failed
 };
}

async function resolve(lat, lng) {
 if (!validCoordinates(lat, lng)) return null;
 const latitude = Number(lat);
 const longitude = Number(lng);
 const key = coordinateKey(latitude, longitude);
 if (inFlight.has(key)) return inFlight.get(key);
 const pending = (async () => {
  let cached = null;
  try {
   cached = await M.GeocodeCache.findOne({ key }).lean();
  } catch (error) {
   console.warn('[Geocoding] MongoDB cache read failed');
  }
  if (cachedAddressIsFresh(cached)) {
   const address = cachedAddress(cached, latitude, longitude);
   if (address && nearbyCacheIsFresh(cached)) return address;
   if (address) return lookupAndCache(key, latitude, longitude, cached);
   if (cached.failureUntil && new Date(cached.failureUntil) > new Date()) {
    return {
     readableLocation: cached.readableLocation,
     provider: cached.provider || 'Coordinate',
     addressLat: latitude,
     addressLng: longitude,
     addressIsCurrent: false,
     addressEnrichmentPending: false
    };
   }
  }
  return lookupAndCache(key, latitude, longitude, cached);
 })().finally(() => inFlight.delete(key));
 inFlight.set(key, pending);
 return pending;
}

function enqueue(lat, lng) {
 return resolve(lat, lng);
}

module.exports = {
 resolve,
 enqueue,
 validCoordinates,
 coordinateKey,
 isCoordinateText,
 isAddressText,
 formatAddress,
 parseGoogle,
 parseNominatim,
 parseNearbyElements,
 nearbyLookup,
 overpassQuery,
 ADDRESS_CACHE_TTL_MS,
 FAILURE_CACHE_TTL_MS,
 REQUEST_TIMEOUT_MS,
 OVERPASS_TIMEOUT_MS,
 NEARBY_RADIUS_M,
 MAX_OVERPASS_RETRIES,
 shouldRetryOverpass
};
