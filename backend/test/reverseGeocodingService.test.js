'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../models');
const geoNames = require('../services/geoNamesService');
const reverseGeocoding = require('../services/reverseGeocodingService');

test('GeoNames lookup returns nearest postal-area fields and computes distance', async () => {
 const original = M.GeoPlace.findOne;
 let query;
 M.GeoPlace.findOne = filter => {
  query = filter;
  return { lean: async () => ({
   placeName: 'Dasna', district: 'Ghaziabad', state: 'Uttar Pradesh', postalCode: '201015',
   location: { type: 'Point', coordinates: [77.45381, 28.66921] }
  }) };
 };
 try {
  const result = await geoNames.lookup(28.66921, 77.45381);
  assert.deepEqual(query.location.$nearSphere.$geometry, {
   type: 'Point', coordinates: [77.45381, 28.66921]
  });
  assert.equal(result.placeName, 'Dasna');
  assert.equal(result.distanceKm, 0);
  assert.equal(result.readableLocation, 'Near Dasna, Ghaziabad, Uttar Pradesh, 201015');
 } finally {
  M.GeoPlace.findOne = original;
 }
});

test('Nominatim maps available address components without inventing fields', () => {
 const result = reverseGeocoding.parseNominatim({
  display_name: '12, NH-9, Sector 5, Dasna, Ghaziabad, India',
  address: {
   house_number: '12', road: 'NH-9', neighbourhood: 'Sector 5',
   village: 'Dasna', state_district: 'Ghaziabad', state: 'Uttar Pradesh',
   postcode: '201015', country: 'India'
  }
 });
 assert.equal(result.plotNumber, '12');
 assert.equal(result.street, 'NH-9');
 assert.equal(result.sector, 'Sector 5');
 assert.equal(result.cityOrVillage, 'Dasna');
 assert.equal(result.district, 'Ghaziabad');
 assert.equal(result.division, '');
 assert.equal(result.pincode, '201015');
 assert.match(result.readableLocation, /PIN 201015/);
 assert.doesNotMatch(result.readableLocation, /undefined|null|PAN/);
});

test('nearby mapping includes residential and commercial features and excludes results beyond 100 metres', () => {
 const latitude = 28.66921;
 const longitude = 77.45381;
 const results = reverseGeocoding.parseNearbyElements([
  {
   type: 'node', lat: latitude + 60 / 111320, lon: longitude,
   tags: { building: 'house', 'addr:housenumber': '25' }
  },
  {
   type: 'node', lat: latitude + 35 / 111320, lon: longitude,
   tags: { name: 'Community Market', shop: 'mall' }
  },
  {
   type: 'node', lat: latitude + 150 / 111320, lon: longitude,
   tags: { name: 'Distant Hospital', amenity: 'hospital' }
  }
 ], latitude, longitude);
 assert.deepEqual(results.map(place => place.name), ['Community Market', 'House 25']);
 assert.equal(results[0].category, 'mall');
 assert.equal(results[0].distanceMeters, 35);
 assert.equal(results[1].distanceMeters, 60);
 assert.ok(results.every(place => place.distanceMeters <= 100));
});

test('address format preserves fallback address and labels PIN as a postal code', () => {
 assert.equal(
  reverseGeocoding.formatAddress({
   formattedAddress: 'Village Road, Ghaziabad',
   nearby: 'Local Hospital (45 m)',
   pincode: '201015'
  }),
  'Village Road, Ghaziabad, PIN 201015, Near Local Hospital (45 m)'
 );
});

test('coordinate cache precision is bounded and coordinates are validated', () => {
 assert.equal(reverseGeocoding.coordinateKey(28.669214, 77.453814), '28.66921,77.45381');
 assert.equal(reverseGeocoding.validCoordinates(28.6, 77.4), true);
 assert.equal(reverseGeocoding.validCoordinates(null, 77.4), false);
 assert.equal(reverseGeocoding.validCoordinates('', 77.4), false);
 assert.equal(reverseGeocoding.validCoordinates(91, 77.4), false);
});
