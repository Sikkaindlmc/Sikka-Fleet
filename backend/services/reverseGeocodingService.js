const M=require('../models');
const axios=require('axios');
const inFlight=new Map();
let nominatimQueue=Promise.resolve();
let lastNominatimRequest=0;

function validCoordinates(lat,lng){
 return Number.isFinite(Number(lat))&&Number.isFinite(Number(lng))&&
  Number(lat)>=-90&&Number(lat)<=90&&Number(lng)>=-180&&Number(lng)<=180;
}

function coordinateKey(lat,lng){
 return `${Number(lat).toFixed(4)},${Number(lng).toFixed(4)}`;
}
function isCoordinateText(value){
 return typeof value==='string'&&/^\s*-?\d+(?:\.\d+)?\s*,\s*-?\d+(?:\.\d+)?\s*$/.test(value);
}

function getNominatimEndpoint(value=process.env.NOMINATIM_URL){
 if(!String(value||'').trim())return null;
 const endpoint=new URL(String(value).trim());
 const localHosts=['localhost','127.0.0.1','[::1]'];
 const localDevelopment=process.env.NODE_ENV!=='production'&&endpoint.protocol==='http:'&&localHosts.includes(endpoint.hostname);
 if(endpoint.protocol!=='https:'&&!localDevelopment){
  throw new Error('NOMINATIM_URL must use HTTPS, except for a local development server');
 }
 if(/(^|\.)openstreetmap\.(org|de)$/i.test(endpoint.hostname)){
  throw new Error('Public Nominatim endpoints are disabled; configure a self-hosted instance');
 }
 return endpoint.toString();
}

function joinAddress(parts){
 return parts.filter((value,index,array)=>value&&array.findIndex(v=>v===value)===index).join(', ');
}

function parseNominatim(payload){
 if(!payload?.display_name)return null;
 const address=payload.address||{};
 const locality=address.suburb||address.neighbourhood||address.hamlet||address.village||address.town||address.city_district||'';
 const city=address.city||address.town||address.village||address.municipality||address.county||'';
 const district=address.district||address.county||'';
 const state=address.state||address.region||'';
 const pincode=address.postcode||'';
 const country=address.country||'';
 return {
  readableLocation:joinAddress([locality,address.road||address.pedestrian||address.residential||'',city,district,state,pincode,country])||payload.display_name,
  locality,city,district,state,pincode,country,provider:'OpenStreetMap'
 };
}

async function nominatimReverse(lat,lng){
 const endpoint=getNominatimEndpoint();
 if(!endpoint)return null;
 const execute=async()=>{
  const wait=Math.max(0,1000-(Date.now()-lastNominatimRequest));
  if(wait)await new Promise(resolve=>setTimeout(resolve,wait));
  lastNominatimRequest=Date.now();
  const response=await axios.get(endpoint,{
   params:{lat,lon:lng,format:'jsonv2',addressdetails:1,'accept-language':'en'},
   timeout:10000,
   headers:{'User-Agent':process.env.NOMINATIM_USER_AGENT||'SikkaFleet/1.0','Accept-Language':'en'}
  });
  return parseNominatim(response.data);
 };
 const pending=nominatimQueue.then(execute,execute);
 nominatimQueue=pending.then(()=>undefined,()=>undefined);
 return pending;
}

async function saveCache(key,lat,lng,resolved){
 await M.GeocodeCache.updateOne(
  {key},
  {$set:{key,lat:Number(Number(lat).toFixed(4)),lng:Number(Number(lng).toFixed(4)),
   readableLocation:resolved.readableLocation,locality:resolved.locality||'',city:resolved.city||'',
   district:resolved.district||'',state:resolved.state||'',pincode:resolved.pincode||'',country:resolved.country||'',
   provider:resolved.provider,geocodedAt:resolved.geocodedAt||null,expiresAt:new Date(Date.now()+30*24*60*60*1000)}},
  {upsert:true}
 ).catch(error=>console.warn(`Geocoding cache write failed: ${error.message}`));
}

async function resolve(lat,lng,{providerAddress,providerFields={},previous}={}){
 if(!validCoordinates(lat,lng))return null;
 const key=coordinateKey(lat,lng);
 if(providerAddress&&typeof providerAddress==='string'&&providerAddress.trim()&&!isCoordinateText(providerAddress)){
  const resolved={
   readableLocation:providerAddress.trim(),locality:providerFields.locality||'',
   city:providerFields.city||'',district:providerFields.district||'',
   state:providerFields.state||'',pincode:providerFields.pincode||'',
   country:providerFields.country||'',provider:'Provider',geocodedAt:null
  };
  await saveCache(key,lat,lng,resolved);
  return resolved;
 }
 if(previous?.readableLocation&&!isCoordinateText(previous.readableLocation)&&validCoordinates(previous.addressLat,previous.addressLng)&&coordinateKey(previous.addressLat,previous.addressLng)===key){
  return {...previous,provider:previous.geocodingProvider||previous.provider||'Provider'};
 }
 const cached=await M.GeocodeCache.findOne({key,expiresAt:{$gt:new Date()}}).lean().catch(error=>{
  console.warn(`Geocoding cache lookup failed: ${error.message}`);
  return null;
 });
 if(cached?.readableLocation){
  return {...cached,provider:cached.provider||undefined,geocodedAt:cached.geocodedAt||null};
 }

 const pending=inFlight.get(key);
 if(pending)return pending;
 const resolving=(async()=>{
  const resolved=await nominatimReverse(Number(lat),Number(lng));
  if(!resolved&&previous?.readableLocation&&!isCoordinateText(previous.readableLocation)){
   return {...previous,provider:previous.geocodingProvider||previous.provider||'Provider',isCurrent:false};
  }
  if(!resolved)return null;
  resolved.geocodedAt=new Date();
  await saveCache(key,lat,lng,resolved);
  return resolved;
 })();
 inFlight.set(key,resolving);
 try{return await resolving}
 finally{inFlight.delete(key)}
}

module.exports={resolve,validCoordinates,coordinateKey,isCoordinateText,getNominatimEndpoint,parseNominatim};
