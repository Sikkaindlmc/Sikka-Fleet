const test=require('node:test');
const assert=require('node:assert/strict');
const M=require('../models');
const axios=require('axios');
const geoNames=require('../services/geoNamesService');
const reverseGeocoding=require('../services/reverseGeocodingService');

function restoreEnvironment(name,value){
 if(value===undefined)delete process.env[name];
 else process.env[name]=value;
}

test('GeoNames lookup returns nearest place fields and computes distance',async()=>{
 const original=M.GeoPlace.findOne;
 let query;
 M.GeoPlace.findOne=filter=>{
  query=filter;
  return {lean:async()=>({
   placeName:'Dasna',district:'Ghaziabad',state:'Uttar Pradesh',postalCode:'201015',
   location:{type:'Point',coordinates:[77.45381,28.66921]}
  })};
 };
 try{
  const result=await geoNames.lookup(28.66921,77.45381);
  assert.deepEqual(query.location.$nearSphere.$geometry,{
   type:'Point',coordinates:[77.45381,28.66921]
  });
  assert.equal(result.placeName,'Dasna');
  assert.equal(result.distanceKm,0);
  assert.equal(result.readableLocation,'Near Dasna, Ghaziabad, Uttar Pradesh, 201015');
 }finally{M.GeoPlace.findOne=original}
});

test('offline address includes distance when the nearest postal place is over ten kilometres away',()=>{
 const place=reverseGeocoding.addressFromPlace({
  placeName:'Village',district:'District',state:'State',postalCode:'123456',distanceKm:12.4
 });
 assert.equal(
  place.readableLocation,
  'About 12 km from Village, District, State, 123456'
 );
});

test('LocationIQ and Geoapify map only supplied address fields',()=>{
 const locationIq=reverseGeocoding.parseLocationIq({
  category:'amenity',name:'Shiv Mandir',
  address:{
   house_number:'12',road:'NH-9',village:'Dasna',state_district:'Ghaziabad',
   state:'Uttar Pradesh',postcode:'201015'
  }
 });
 assert.deepEqual(locationIq,{
  street:'12',galiNumber:'',road:'NH-9',nearby:'Shiv Mandir',locality:'',
  cityOrVillage:'Dasna',district:'Ghaziabad',state:'Uttar Pradesh',
  pincode:'201015',country:''
 });
 const geoapify=reverseGeocoding.parseGeoapify({
  features:[{properties:{
   name:'Market',categories:['building'],street:'Market Road',
   city:'Dasna',state:'Uttar Pradesh'
  }}]
 });
 assert.equal(geoapify.road,'Market Road');
 assert.equal(geoapify.nearby,'Market');
 assert.equal(geoapify.cityOrVillage,'Dasna');
 assert.equal(geoapify.district,'');
 assert.doesNotMatch(reverseGeocoding.formatAddress(geoapify),/undefined|null/);
});

test('self-hosted Nominatim maps partial address fields without using display_name',()=>{
 const result=reverseGeocoding.parseSelfHostedNominatim({
  display_name:'Ignored full address',
  address:{
   house_number:'12',road:'NH-9',neighbourhood:'Sector 5',village:'Dasna',
   state_district:'Ghaziabad',state:'Uttar Pradesh',postcode:'201015'
  }
 });
 assert.equal(result.street,'12');
 assert.equal(result.road,'NH-9');
 assert.equal(result.nearby,'Sector 5');
 assert.equal(result.cityOrVillage,'Dasna');
 assert.equal(
  reverseGeocoding.formatAddress(result),
  '12, NH-9, Near Sector 5, Dasna, Ghaziabad, Uttar Pradesh, 201015'
 );
 assert.doesNotMatch(reverseGeocoding.formatAddress(result),/Ignored|undefined|null/);
});

test('GeoNames result is cached at five decimals and returned without a geocoder key',async()=>{
 const originals={
  provider:process.env.GEOCODER_PROVIDER,key:process.env.GEOCODER_API_KEY,
  findCache:M.GeocodeCache.findOne,updateCache:M.GeocodeCache.updateOne,
  findPlace:M.GeoPlace.findOne,request:axios.get
 };
 let cached=null,placeLookups=0,requestCount=0;
 delete process.env.GEOCODER_PROVIDER;
 delete process.env.GEOCODER_API_KEY;
 M.GeocodeCache.findOne=()=>({lean:async()=>cached});
 M.GeocodeCache.updateOne=async(_filter,update)=>{cached={...cached,...update.$set}};
 M.GeoPlace.findOne=()=>({
  lean:async()=>{
   placeLookups++;
   return {
    placeName:'Dasna',district:'Ghaziabad',state:'Uttar Pradesh',postalCode:'201015',
    location:{type:'Point',coordinates:[77.45381,28.66921]}
   };
  }
 });
 axios.get=async()=>{requestCount++;throw new Error('Unexpected online call')};
 try{
  const first=await reverseGeocoding.resolve(28.66921,77.45381);
  const second=await reverseGeocoding.resolve(28.669214,77.453814);
  assert.equal(first.readableLocation,'Near Dasna, Ghaziabad, Uttar Pradesh, 201015');
  assert.equal(first.cityOrVillage,'Dasna');
  assert.equal(first.addressEnrichmentPending,false);
  assert.equal(second.readableLocation,first.readableLocation);
  assert.equal(second.addressLat,28.669214);
  assert.equal(second.addressLng,77.453814);
  assert.equal(cached.key,'28.66921,77.45381');
  assert.equal(placeLookups,1);
  assert.equal(requestCount,0);
 }finally{
  restoreEnvironment('GEOCODER_PROVIDER',originals.provider);
  restoreEnvironment('GEOCODER_API_KEY',originals.key);
  M.GeocodeCache.findOne=originals.findCache;
  M.GeocodeCache.updateOne=originals.updateCache;
  M.GeoPlace.findOne=originals.findPlace;
  axios.get=originals.request;
 }
});

test('layer two enrichment runs in the background and keeps the GeoNames address available',async()=>{
 const originals={
  provider:process.env.GEOCODER_PROVIDER,key:process.env.GEOCODER_API_KEY,
  findCache:M.GeocodeCache.findOne,updateCache:M.GeocodeCache.updateOne,
  findPlace:M.GeoPlace.findOne,quota:M.GeocoderQuota.findOneAndUpdate,
  slot:M.GeocodeRequestSlot.findOneAndUpdate,request:axios.get
 };
 let cached=null,requestOptions=null;
 process.env.GEOCODER_PROVIDER='locationiq';
 process.env.GEOCODER_API_KEY='test-key';
 M.GeocodeCache.findOne=()=>({lean:async()=>cached});
 M.GeocodeCache.updateOne=async(_filter,update)=>{
  cached={...cached,...update.$set};
  for(const field of Object.keys(update.$unset||{}))delete cached[field];
 };
 M.GeoPlace.findOne=()=>({lean:async()=>({
  placeName:'Dasna',district:'Ghaziabad',state:'Uttar Pradesh',postalCode:'201015',
  location:{type:'Point',coordinates:[77.45381,28.66921]}
 })});
 M.GeocoderQuota.findOneAndUpdate=async()=>({count:1});
 M.GeocodeRequestSlot.findOneAndUpdate=()=>({lean:async()=>({key:'reverse-geocoder'})});
 axios.get=async(_url,options)=>{
  requestOptions=options;
  return {data:{category:'amenity',name:'Shiv Mandir',address:{
   house_number:'12',road:'NH-9',village:'Dasna',state_district:'Ghaziabad',
   state:'Uttar Pradesh',postcode:'201015'
  }}};
 };
 try{
  const result=await reverseGeocoding.resolve(28.66921,77.45381);
  assert.equal(result.readableLocation,'Near Dasna, Ghaziabad, Uttar Pradesh, 201015');
  assert.equal(result.addressEnrichmentPending,true);
  await new Promise(resolve=>setTimeout(resolve,1500));
  assert.equal(requestOptions.timeout,5000);
  assert.equal(requestOptions.params.key,process.env.GEOCODER_API_KEY);
  assert.equal(cached.street,'12');
  assert.equal(cached.road,'NH-9');
  assert.equal(cached.readableLocation,'12, NH-9, Near Shiv Mandir, Dasna, Ghaziabad, Uttar Pradesh, 201015');
 }finally{
  restoreEnvironment('GEOCODER_PROVIDER',originals.provider);
  restoreEnvironment('GEOCODER_API_KEY',originals.key);
  M.GeocodeCache.findOne=originals.findCache;
  M.GeocodeCache.updateOne=originals.updateCache;
  M.GeoPlace.findOne=originals.findPlace;
  M.GeocoderQuota.findOneAndUpdate=originals.quota;
  M.GeocodeRequestSlot.findOneAndUpdate=originals.slot;
  axios.get=originals.request;
 }
});

test('self-hosted Nominatim enriches offline addresses and public Nominatim is rejected',async()=>{
 const originals={
  provider:process.env.GEOCODER_PROVIDER,key:process.env.GEOCODER_API_KEY,
  userAgent:process.env.GEOCODER_USER_AGENT,nominatimUrl:process.env.NOMINATIM_REVERSE_URL,
  findCache:M.GeocodeCache.findOne,updateCache:M.GeocodeCache.updateOne,
  findPlace:M.GeoPlace.findOne,slot:M.GeocodeRequestSlot.findOneAndUpdate,
  request:axios.get
 };
 let cached=null,requestOptions=null,requestUrl='',requestCount=0;
 process.env.GEOCODER_PROVIDER='nominatim';
 process.env.NOMINATIM_REVERSE_URL='https://geo.example.test/reverse';
 process.env.GEOCODER_USER_AGENT='SikkaFleet/1.0 (contact: fleet@example.com)';
 delete process.env.GEOCODER_API_KEY;
 M.GeocodeCache.findOne=()=>({lean:async()=>cached});
 M.GeocodeCache.updateOne=async(_filter,update)=>{
  cached={...cached,...update.$set};
  for(const field of Object.keys(update.$unset||{}))delete cached[field];
 };
 M.GeoPlace.findOne=()=>({lean:async()=>({
  placeName:'Dasna',district:'Ghaziabad',state:'Uttar Pradesh',postalCode:'201015',
  location:{type:'Point',coordinates:[77.45381,28.66921]}
 })});
 M.GeocodeRequestSlot.findOneAndUpdate=()=>({lean:async()=>({key:'reverse-geocoder'})});
 axios.get=async(url,options)=>{
  requestCount++;
  requestUrl=url;
  requestOptions=options;
  return {data:{category:'amenity',name:'Shiv Mandir',address:{
   house_number:'12',road:'NH-9',village:'Dasna',state_district:'Ghaziabad',
   state:'Uttar Pradesh',postcode:'201015'
  }}};
 };
 try{
  const result=await reverseGeocoding.resolve(28.66921,77.45381);
  assert.equal(result.readableLocation,'Near Dasna, Ghaziabad, Uttar Pradesh, 201015');
  assert.equal(result.addressEnrichmentPending,true);
  await new Promise(resolve=>setTimeout(resolve,1500));
  assert.equal(requestCount,1);
  assert.equal(requestUrl,'https://geo.example.test/reverse');
  assert.equal(requestOptions.timeout,5000);
  assert.equal(requestOptions.params.zoom,18);
  assert.equal(requestOptions.params.addressdetails,1);
  assert.equal(requestOptions.params.namedetails,1);
  assert.equal(requestOptions.headers['User-Agent'],process.env.GEOCODER_USER_AGENT);
  assert.equal(cached.layer2Provider,'Nominatim');
  assert.equal(cached.readableLocation,'12, NH-9, Near Shiv Mandir, Dasna, Ghaziabad, Uttar Pradesh, 201015');

  cached=null;
  process.env.NOMINATIM_REVERSE_URL='https://nominatim.openstreetmap.org/reverse';
  const fallback=await reverseGeocoding.resolve(28.67,77.454);
  assert.equal(fallback.readableLocation,'Near Dasna, Ghaziabad, Uttar Pradesh, 201015');
  assert.equal(fallback.addressEnrichmentPending,false);
  await new Promise(resolve=>setTimeout(resolve,20));
  assert.equal(requestCount,1);
 }finally{
  restoreEnvironment('GEOCODER_PROVIDER',originals.provider);
  restoreEnvironment('GEOCODER_API_KEY',originals.key);
  restoreEnvironment('GEOCODER_USER_AGENT',originals.userAgent);
  restoreEnvironment('NOMINATIM_REVERSE_URL',originals.nominatimUrl);
  M.GeocodeCache.findOne=originals.findCache;
  M.GeocodeCache.updateOne=originals.updateCache;
  M.GeoPlace.findOne=originals.findPlace;
  M.GeocodeRequestSlot.findOneAndUpdate=originals.slot;
  axios.get=originals.request;
 }
});

test('vehicles at the same point share one optional provider request',async()=>{
 const originals={
  provider:process.env.GEOCODER_PROVIDER,key:process.env.GEOCODER_API_KEY,
  findCache:M.GeocodeCache.findOne,updateCache:M.GeocodeCache.updateOne,
  findPlace:M.GeoPlace.findOne,quota:M.GeocoderQuota.findOneAndUpdate,
  slot:M.GeocodeRequestSlot.findOneAndUpdate,request:axios.get
 };
 let requestCount=0;
 process.env.GEOCODER_PROVIDER='locationiq';
 process.env.GEOCODER_API_KEY='test-key';
 M.GeocodeCache.findOne=()=>({lean:async()=>null});
 M.GeocodeCache.updateOne=async()=>{};
 M.GeoPlace.findOne=()=>({lean:async()=>({
  placeName:'Dasna',district:'Ghaziabad',state:'Uttar Pradesh',postalCode:'201015',
  location:{type:'Point',coordinates:[77.45381,28.66921]}
 })});
 M.GeocoderQuota.findOneAndUpdate=async()=>({count:1});
 M.GeocodeRequestSlot.findOneAndUpdate=()=>({lean:async()=>({key:'reverse-geocoder'})});
 axios.get=async()=>{requestCount++;return {data:{address:{road:'NH-9'}}}};
 try{
  await Promise.all([
   reverseGeocoding.resolve(28.66921,77.45381),
   reverseGeocoding.resolve(28.66921,77.45381)
  ]);
  await new Promise(resolve=>setTimeout(resolve,1500));
  assert.equal(requestCount,1);
 }finally{
  restoreEnvironment('GEOCODER_PROVIDER',originals.provider);
  restoreEnvironment('GEOCODER_API_KEY',originals.key);
  M.GeocodeCache.findOne=originals.findCache;
  M.GeocodeCache.updateOne=originals.updateCache;
  M.GeoPlace.findOne=originals.findPlace;
  M.GeocoderQuota.findOneAndUpdate=originals.quota;
  M.GeocodeRequestSlot.findOneAndUpdate=originals.slot;
  axios.get=originals.request;
 }
});

test('different coordinates respect the shared one-request-per-second limit',async()=>{
 const originals={
  provider:process.env.GEOCODER_PROVIDER,key:process.env.GEOCODER_API_KEY,
  findCache:M.GeocodeCache.findOne,updateCache:M.GeocodeCache.updateOne,
  findPlace:M.GeoPlace.findOne,quota:M.GeocoderQuota.findOneAndUpdate,
  slot:M.GeocodeRequestSlot.findOneAndUpdate,slotFind:M.GeocodeRequestSlot.findOne,
  request:axios.get
 };
 let nextAllowedAt=0;
 const requestTimes=[];
 process.env.GEOCODER_PROVIDER='geoapify';
 process.env.GEOCODER_API_KEY='test-key';
 M.GeocodeCache.findOne=()=>({lean:async()=>null});
 M.GeocodeCache.updateOne=async()=>{};
 M.GeoPlace.findOne=()=>({lean:async()=>({
  placeName:'Dasna',district:'Ghaziabad',state:'Uttar Pradesh',postalCode:'201015',
  location:{type:'Point',coordinates:[77.45381,28.66921]}
 })});
 M.GeocoderQuota.findOneAndUpdate=async()=>({count:1});
 M.GeocodeRequestSlot.findOneAndUpdate=()=>({
  lean:async()=>{
   if(Date.now()<nextAllowedAt)return null;
   nextAllowedAt=Date.now()+1000;
   return {key:'reverse-geocoder'};
  }
 });
 M.GeocodeRequestSlot.findOne=()=>({select:()=>({lean:async()=>({nextAllowedAt:new Date(nextAllowedAt)})})});
 axios.get=async()=>{requestTimes.push(Date.now());return {data:{features:[{properties:{street:'NH-9'}}]}}};
 try{
  await Promise.all([
   reverseGeocoding.resolve(28.66921,77.45381),
   reverseGeocoding.resolve(28.67,77.454)
  ]);
  await new Promise(resolve=>setTimeout(resolve,3500));
  assert.equal(requestTimes.length,2);
  assert.ok(requestTimes[1]-requestTimes[0]>=950);
 }finally{
  restoreEnvironment('GEOCODER_PROVIDER',originals.provider);
  restoreEnvironment('GEOCODER_API_KEY',originals.key);
  M.GeocodeCache.findOne=originals.findCache;
  M.GeocodeCache.updateOne=originals.updateCache;
  M.GeoPlace.findOne=originals.findPlace;
  M.GeocoderQuota.findOneAndUpdate=originals.quota;
  M.GeocodeRequestSlot.findOneAndUpdate=originals.slot;
  M.GeocodeRequestSlot.findOne=originals.slotFind;
  axios.get=originals.request;
 }
});

test('failed or disabled optional geocoding leaves Layer 1 intact and is retryable',async()=>{
 const originals={
  provider:process.env.GEOCODER_PROVIDER,key:process.env.GEOCODER_API_KEY,
  findCache:M.GeocodeCache.findOne,updateCache:M.GeocodeCache.updateOne,
  findPlace:M.GeoPlace.findOne,quota:M.GeocoderQuota.findOneAndUpdate,
  slot:M.GeocodeRequestSlot.findOneAndUpdate,slotFind:M.GeocodeRequestSlot.findOne,
  request:axios.get
 };
 let cached=null,requestCount=0,nextAllowedAt=0;
 process.env.GEOCODER_PROVIDER='geoapify';
 process.env.GEOCODER_API_KEY='test-key';
 M.GeocodeCache.findOne=()=>({lean:async()=>cached});
 M.GeocodeCache.updateOne=async(_filter,update)=>{cached={...cached,...update.$set}};
 M.GeoPlace.findOne=()=>({lean:async()=>({
  placeName:'Dasna',district:'Ghaziabad',state:'Uttar Pradesh',postalCode:'201015',
  location:{type:'Point',coordinates:[77.45381,28.66921]}
 })});
 M.GeocoderQuota.findOneAndUpdate=async()=>({count:1});
 M.GeocodeRequestSlot.findOneAndUpdate=()=>({
  lean:async()=>{
   if(Date.now()<nextAllowedAt)return null;
   nextAllowedAt=Date.now()+1000;
   return {key:'reverse-geocoder'};
  }
 });
 M.GeocodeRequestSlot.findOne=()=>({select:()=>({lean:async()=>({nextAllowedAt:new Date(nextAllowedAt)})})});
 axios.get=async()=>{requestCount++;throw Object.assign(new Error('blocked'),{response:{status:403}})};
 try{
  const result=await reverseGeocoding.resolve(28.66921,77.45381);
  assert.equal(result.readableLocation,'Near Dasna, Ghaziabad, Uttar Pradesh, 201015');
  await new Promise(resolve=>setTimeout(resolve,4500));
  assert.equal(requestCount,3);
  assert.equal(cached.readableLocation,'Near Dasna, Ghaziabad, Uttar Pradesh, 201015');
  assert.ok(new Date(cached.layer2FailureUntil).getTime()>Date.now());
 }finally{
  restoreEnvironment('GEOCODER_PROVIDER',originals.provider);
  restoreEnvironment('GEOCODER_API_KEY',originals.key);
  M.GeocodeCache.findOne=originals.findCache;
  M.GeocodeCache.updateOne=originals.updateCache;
  M.GeoPlace.findOne=originals.findPlace;
  M.GeocoderQuota.findOneAndUpdate=originals.quota;
  M.GeocodeRequestSlot.findOneAndUpdate=originals.slot;
  M.GeocodeRequestSlot.findOne=originals.slotFind;
  axios.get=originals.request;
 }
});

test('previous vehicle address is reused within one hundred metres only',()=>{
 const previous={
  readableLocation:'Near Dasna, Ghaziabad',addressLat:28.6692,addressLng:77.4538,
  geocodingProvider:'GeoNames',addressIsCurrent:true
 };
 assert.equal(reverseGeocoding.previousLocation(previous,28.6692,77.4542).readableLocation,
  previous.readableLocation);
 assert.equal(reverseGeocoding.previousLocation(previous,28.671,77.4538),null);
 assert.equal(reverseGeocoding.validCoordinates(null,0),false);
 assert.equal(reverseGeocoding.validCoordinates('',77),false);
});
