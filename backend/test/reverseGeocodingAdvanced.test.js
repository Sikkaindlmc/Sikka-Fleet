'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../models');
const axios = require('axios');
const geoNames = require('../services/geoNamesService');
const geocoding = require('../services/reverseGeocodingService');

process.env.NODE_ENV = 'test';

function googleResponse(components) {
 return {
  status: 'OK',
  results: [{
   formatted_address: '25 Industrial Road, Sector 5, Dasna, Ghaziabad, India',
   address_components: components
  }]
 };
}

function component(longName, ...types) {
 return { long_name: longName, short_name: longName, types };
}

function installMocks({ get, post, geoNamesResult = null } = {}) {
 const originals = {
  apiKey: process.env.GOOGLE_GEOCODING_API_KEY,
  key: process.env.GEOCODER_API_KEY,
  provider: process.env.GEOCODER_PROVIDER,
  findCache: M.GeocodeCache.findOne,
  updateCache: M.GeocodeCache.updateOne,
  findPlace: M.GeoPlace.findOne,
  httpGet: axios.get,
  httpPost: axios.post,
  offlineLookup: geoNames.lookup
 };
 process.env.GOOGLE_GEOCODING_API_KEY = 'test-google-key';
 delete process.env.GEOCODER_API_KEY;
 process.env.GEOCODER_PROVIDER = '';
 const cache = new Map();
 let cached = null;
 const updates = [];
 M.GeocodeCache.findOne = filter => ({ lean: async () => cache.get(filter.key) || null });
 M.GeocodeCache.updateOne = async (filter, update) => {
  updates.push({ filter, update });
  cached = { ...(cache.get(filter.key) || {}), ...update.$set };
  for (const field of Object.keys(update.$unset || {})) delete cached[field];
  cache.set(filter.key, cached);
 };
 M.GeoPlace.findOne = () => ({ lean: async () => null });
 axios.get = get || (async () => ({ data: googleResponse([
  component('25', 'street_number'),
  component('Industrial Road', 'route'),
  component('Sector 5', 'sublocality_level_1'),
  component('Dasna', 'locality'),
  component('Ghaziabad', 'administrative_area_level_2'),
  component('Meerut Division', 'administrative_area_level_3'),
  component('Uttar Pradesh', 'administrative_area_level_1'),
  component('201009', 'postal_code'),
  component('India', 'country')
 ]) }));
 axios.post = post || (async () => ({ data: { elements: [] } }));
 geoNames.lookup = async () => geoNamesResult;
 return {
  updates,
  getCached: () => cached,
  restore() {
   for (const [name, value] of [
    ['GOOGLE_GEOCODING_API_KEY', originals.apiKey],
    ['GEOCODER_API_KEY', originals.key],
    ['GEOCODER_PROVIDER', originals.provider]
   ]) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
   }
   M.GeocodeCache.findOne = originals.findCache;
   M.GeocodeCache.updateOne = originals.updateCache;
   M.GeoPlace.findOne = originals.findPlace;
   axios.get = originals.httpGet;
   axios.post = originals.httpPost;
   geoNames.lookup = originals.offlineLookup;
  }
 };
}

test('Google address components include PIN and division fields', () => {
 const result = geocoding.parseGoogle(googleResponse([
  component('25', 'street_number'),
  component('Industrial Road', 'route'),
  component('Sector 5', 'sublocality_level_1'),
  component('Dasna', 'locality'),
  component('Ghaziabad', 'administrative_area_level_2'),
  component('Meerut Division', 'administrative_area_level_3'),
  component('201009', 'postal_code'),
  component('Uttar Pradesh', 'administrative_area_level_1'),
  component('India', 'country')
 ]));
 assert.equal(result.plotNumber, '25');
 assert.equal(result.street, 'Industrial Road');
 assert.equal(result.sector, 'Sector 5');
 assert.equal(result.cityOrVillage, 'Dasna');
 assert.equal(result.district, 'Ghaziabad');
 assert.equal(result.division, 'Meerut Division');
 assert.equal(result.pincode, '201009');
 assert.match(result.readableLocation, /PIN 201009/);
});

test('Google is the primary address provider and successful results skip Nominatim', async () => {
 const requestedUrls = [];
 const mock = installMocks({
  get: async (url, options) => {
   requestedUrls.push({ url, options });
   return { data: googleResponse([
    component('Industrial Road', 'route'),
    component('Dasna', 'locality'),
    component('201009', 'postal_code'),
    component('India', 'country')
   ]) };
  }
 });
 try {
  const result = await geocoding.resolve(28.67101, 77.45501);
  assert.equal(result.provider, 'Google');
  assert.equal(requestedUrls.length, 1);
  assert.match(requestedUrls[0].url, /maps\.googleapis\.com/);
  assert.equal(requestedUrls[0].options.params.key, 'test-google-key');
  assert.equal(result.pincode, '201009');
 } finally {
  mock.restore();
 }
});

test('Google failure falls back to Nominatim and Overpass selects the closest valid feature', async () => {
 let googleCalls = 0;
 let nominatimCalls = 0;
 let overpassCalls = 0;
 let overpassOptions;
 let overpassQuery;
 const latitude = 28.66921;
 const longitude = 77.45381;
 const mock = installMocks({
  get: async url => {
   if (url.includes('googleapis')) {
    googleCalls++;
    return { data: { status: 'ZERO_RESULTS', results: [] } };
   }
   nominatimCalls++;
   return { data: {
    display_name: 'Dasna, Ghaziabad, India',
    address: {
     house_number: '25', road: 'Industrial Road', neighbourhood: 'Sector 5',
     village: 'Dasna', state_district: 'Ghaziabad', region: 'Meerut Division',
     postcode: '201009', state: 'Uttar Pradesh', country: 'India'
    }
   } };
  },
  post: async (url, body, options) => {
   overpassCalls++;
   overpassOptions = options;
   overpassQuery = decodeURIComponent(body.slice('data='.length));
   return { data: { elements: [
    { type: 'node', lat: latitude + 20 / 111320, lon: longitude, tags: { name: 'Sikka Factory', industrial: 'factory' } },
    { type: 'node', lat: latitude + 45 / 111320, lon: longitude, tags: { name: 'Market', shop: 'mall' } },
    { type: 'node', lat: latitude + 120 / 111320, lon: longitude, tags: { name: 'Distant Hospital', amenity: 'hospital' } }
   ] } };
  }
 });
 try {
  const result = await geocoding.resolve(latitude, longitude);
  assert.equal(googleCalls, 1);
  assert.equal(nominatimCalls, 1);
  assert.equal(overpassCalls, 1);
  assert.equal(result.provider, 'Nominatim');
  assert.equal(result.nearestLocation, 'Sikka Factory');
  assert.equal(result.nearestLocationCategory, 'factory');
  assert.equal(result.nearestLocationDistanceMeters, 20);
  assert.equal(result.nearbyProvider, 'Overpass');
  assert.match(result.readableLocation, /Sikka Factory \(20 m\)/);
  assert.doesNotMatch(result.readableLocation, /Distant Hospital/);
  assert.equal(overpassOptions.timeout, geocoding.OVERPASS_TIMEOUT_MS);
  assert.match(overpassQuery, /around:100,/);
  assert.match(overpassQuery, /\[building\]/);
  assert.match(overpassQuery, /\[healthcare\]/);
  assert.ok(mock.getCached().nearestLocation);
  const cachedResult = await geocoding.resolve(latitude, longitude);
  assert.equal(cachedResult.nearestLocation, 'Sikka Factory');
  assert.equal(googleCalls, 1);
  assert.equal(nominatimCalls, 1);
  assert.equal(overpassCalls, 1);
 } finally {
  mock.restore();
 }
});

test('Overpass timeout and temporary errors retry at two fallback endpoints only', async () => {
 const endpoints = [];
 const mock = installMocks({
  post: async (url, _body, options) => {
   endpoints.push({ url, options });
   if (endpoints.length === 1) throw Object.assign(new Error('timeout'), { code: 'ECONNABORTED' });
   if (endpoints.length === 2) throw Object.assign(new Error('unavailable'), { response: { status: 503 } });
   return { data: { elements: [] } };
  }
 });
 try {
  const result = await geocoding.nearbyLookup(28.7, 77.4);
  assert.equal(result.failed, false);
  assert.equal(endpoints.length, geocoding.MAX_OVERPASS_RETRIES + 1);
  assert.deepEqual(endpoints.map(item => item.url), [
   'https://overpass-api.de/api/interpreter',
   'https://overpass.kumi.systems/api/interpreter',
   'https://overpass.private.coffee/api/interpreter'
  ]);
  assert.ok(endpoints.every(item => item.options.timeout === 18000));
 } finally {
  mock.restore();
 }
});

test('Overpass retries the documented temporary HTTP statuses, but not client errors', () => {
 for (const status of [429, 500, 502, 503, 504]) {
  assert.equal(geocoding.shouldRetryOverpass({ response: { status } }), true);
 }
 assert.equal(geocoding.shouldRetryOverpass({ code: 'ECONNABORTED' }), true);
 assert.equal(geocoding.shouldRetryOverpass({ code: 'ETIMEDOUT' }), true);
 assert.equal(geocoding.shouldRetryOverpass({ response: { status: 400 } }), false);
 assert.equal(geocoding.shouldRetryOverpass({ response: { status: 404 } }), false);
});

test('Google and Nominatim failures preserve GPS coordinates and do not fail resolution', async () => {
 let googleCalls = 0;
 let nominatimCalls = 0;
 let overpassCalls = 0;
 const mock = installMocks({
  get: async url => {
   if (url.includes('googleapis')) {
    googleCalls++;
    throw Object.assign(new Error('Google unavailable'), { code: 'ECONNABORTED' });
   }
   nominatimCalls++;
   throw Object.assign(new Error('Nominatim unavailable'), { response: { status: 503 } });
  },
  post: async () => {
   overpassCalls++;
   throw Object.assign(new Error('Overpass unavailable'), { code: 'ECONNABORTED' });
  },
  geoNamesResult: null
 });
 try {
  const result = await geocoding.resolve(28.70123, 77.40123);
  assert.equal(googleCalls, 1);
  assert.equal(nominatimCalls, 1);
  assert.equal(overpassCalls, 3);
  assert.equal(result.provider, 'Coordinate');
  assert.equal(result.addressIsCurrent, true);
  assert.equal(result.readableLocation, '28.701230, 77.401230');
  assert.equal(mock.getCached().provider, 'Coordinate');
  assert.ok(mock.getCached().failureUntil);
 } finally {
  mock.restore();
 }
});

test('an address lookup uses the saved coordinate key and reruns after meaningful movement', async () => {
 let googleCalls = 0;
 let overpassCalls = 0;
 const mock = installMocks({
  get: async () => {
   googleCalls++;
   return { data: googleResponse([
    component('Dasna', 'locality'), component('India', 'country')
   ]) };
  },
  post: async () => {
   overpassCalls++;
   return { data: { elements: [] } };
  }
 });

 try {
  const first = await geocoding.resolve(28.7, 77.4);
  const cached = await geocoding.resolve(28.700001, 77.400001);
  const moved = await geocoding.resolve(28.7002, 77.4002);
  assert.equal(first.readableLocation, cached.readableLocation);
  assert.equal(googleCalls, 2);
  assert.equal(overpassCalls, 2);
  assert.equal(moved.addressLat, 28.7002);
  assert.equal(mock.updates.length, 2);
 } finally {
  mock.restore();
 }
});

test('Mongoose accepts the supported returnDocument option for updated documents', () => {
 const query = M.GeocodeRequestSlot.findOneAndUpdate(
  { key: 'test-rate-limit-slot' },
  { $set: { nextAllowedAt: new Date() } },
  { returnDocument: 'after' }
 );
 assert.equal(query.getOptions().returnDocument, 'after');
});
