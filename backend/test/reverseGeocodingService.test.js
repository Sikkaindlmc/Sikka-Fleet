const test=require('node:test');
const assert=require('node:assert/strict');
const M=require('../models');
const axios=require('axios');
const reverseGeocoding=require('../services/reverseGeocodingService');

test('Nominatim JSONv2 responses are mapped to readable OpenStreetMap addresses',()=>{
 const result=reverseGeocoding.parseNominatim({
  display_name:'Example Road, Example Area, Ghaziabad, Uttar Pradesh, India',
  address:{road:'Example Road',suburb:'Example Area',city:'Ghaziabad',state:'Uttar Pradesh',postcode:'201009',country:'India'}
 });
 assert.equal(result.readableLocation,'Example Area, Example Road, Ghaziabad, Uttar Pradesh, 201009, India');
 assert.equal(result.provider,'OpenStreetMap');
});

test('public Nominatim hosts are rejected while local self-hosted development is supported',()=>{
 assert.throws(
  ()=>reverseGeocoding.getNominatimEndpoint('https://nominatim.openstreetmap.org/reverse'),
  /Public Nominatim endpoints are disabled/
 );
 assert.equal(
  reverseGeocoding.getNominatimEndpoint('http://localhost:8080/reverse'),
  'http://localhost:8080/reverse'
 );
 const originalNodeEnv=process.env.NODE_ENV;
 process.env.NODE_ENV='production';
 try{
  assert.throws(
   ()=>reverseGeocoding.getNominatimEndpoint('http://localhost:8080/reverse'),
   /must use HTTPS/
  );
 }finally{
  if(originalNodeEnv===undefined)delete process.env.NODE_ENV;
  else process.env.NODE_ENV=originalNodeEnv;
 }
});

test('address lookup stays disabled without a configured self-hosted endpoint',async()=>{
 const originalUrl=process.env.NOMINATIM_URL;
 const originalFindOne=M.GeocodeCache.findOne;
 const originalGet=axios.get;
 let requestCount=0;
 process.env.NOMINATIM_URL='';
 M.GeocodeCache.findOne=()=>({lean:async()=>null});
 axios.get=async()=>{requestCount++;throw new Error('Unexpected geocoding request')};
 try{
  assert.equal(await reverseGeocoding.resolve(28.6692,77.4538),null);
  assert.equal(requestCount,0);
 }finally{
  if(originalUrl===undefined)delete process.env.NOMINATIM_URL;
  else process.env.NOMINATIM_URL=originalUrl;
  M.GeocodeCache.findOne=originalFindOne;
  axios.get=originalGet;
 }
});

test('configured self-hosted Nominatim is queried and subsequent lookups use cache',async()=>{
 const originalUrl=process.env.NOMINATIM_URL;
 const originalFindOne=M.GeocodeCache.findOne;
 const originalUpdateOne=M.GeocodeCache.updateOne;
 const originalGet=axios.get;
 let cached=null,requestCount=0,requestUrl='',requestParams=null;
 process.env.NOMINATIM_URL='http://localhost:8080/reverse';
 M.GeocodeCache.findOne=()=>({lean:async()=>cached});
 M.GeocodeCache.updateOne=async(_filter,update)=>{cached=update.$set};
 axios.get=async(url,options)=>{
  requestCount++;requestUrl=url;requestParams=options.params;
  return {data:{display_name:'Example Road, Ghaziabad, India',address:{road:'Example Road',city:'Ghaziabad',country:'India'}}};
 };
 try{
  const first=await reverseGeocoding.resolve(28.6692,77.4538);
  const second=await reverseGeocoding.resolve(28.6692,77.4538);
  assert.equal(first.readableLocation,'Example Road, Ghaziabad, India');
  assert.equal(second.readableLocation,first.readableLocation);
  assert.equal(requestCount,1);
  assert.equal(requestUrl,'http://localhost:8080/reverse');
  assert.equal(requestParams.format,'jsonv2');
 }finally{
  if(originalUrl===undefined)delete process.env.NOMINATIM_URL;
  else process.env.NOMINATIM_URL=originalUrl;
  M.GeocodeCache.findOne=originalFindOne;
  M.GeocodeCache.updateOne=originalUpdateOne;
  axios.get=originalGet;
 }
});
