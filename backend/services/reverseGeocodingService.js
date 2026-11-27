const M=require('../models');
const axios=require('axios');
const geoNames=require('./geoNamesService');

const ADDRESS_CACHE_TTL_MS=30*24*60*60*1000;
const FAILURE_CACHE_TTL_MS=5*60*1000;
const ADDRESS_REFRESH_DISTANCE_METERS=100;
const REQUEST_TIMEOUT_MS=5000;
const MAX_PROVIDER_RETRIES=2;
const RETRY_BACKOFF_MS=[500,1500];
const inFlight=new Map();
const DAILY_REQUEST_LIMITS={locationiq:4500,geoapify:2500};
const DEFAULT_ENDPOINTS={
 locationiq:'https://us1.locationiq.com/v1/reverse',
 geoapify:'https://api.geoapify.com/v1/geocode/reverse'
};
const GENERIC_PLACE_NAMES=new Set([
 'amenity','building','fuel','place of worship','place_of_worship','school','shop',
 'tourism','restaurant','supermarket','hospital','hotel','bank','pharmacy'
]);
let localNextRequestAt=0;

function validCoordinates(lat,lng){
 return lat!==null&&lat!==undefined&&String(lat).trim()!==''&&
  lng!==null&&lng!==undefined&&String(lng).trim()!==''&&
  Number.isFinite(Number(lat))&&Number(lat)>=-90&&Number(lat)<=90&&
  Number.isFinite(Number(lng))&&Number(lng)>=-180&&Number(lng)<=180;
}

function coordinateKey(lat,lng){
 return `${Number(lat).toFixed(5)},${Number(lng).toFixed(5)}`;
}

function isCoordinateText(value){
 return typeof value==='string'&&/^\s*-?\d+(?:\.\d+)?\s*,\s*-?\d+(?:\.\d+)?\s*$/.test(value);
}

function isAddressText(value){
 return typeof value==='string'&&Boolean(value.trim())&&!isCoordinateText(value)&&
  !/\b(?:undefined|null)\b/i.test(value);
}

function canonicalProvider(value){
 return ['GeoNames','LocationIQ','Geoapify','Provider','Coordinate'].includes(value)
  ?value:'Provider';
}

function text(value){
 if(typeof value==='string')return value.trim();
 if(typeof value==='number'&&Number.isFinite(value))return String(value);
 return '';
}

function joinAddress(parts){
 const included=[];
 for(const part of parts){
  const value=text(part);
  if(value&&!included.some(item=>item.toLowerCase()===value.toLowerCase()))included.push(value);
 }
 return included.join(', ');
}

function isNamedPlace(value){
 const normalized=text(value).toLowerCase();
 return Boolean(normalized&&!GENERIC_PLACE_NAMES.has(normalized));
}

function isPoiType(value){
 return /amenity|shop|tourism|leisure|historic|building|place.of.worship|fuel|school/i.test(text(value));
}

function formatAddress(fields){
 const nearby=text(fields.nearby);
 const cityOrVillage=text(fields.cityOrVillage);
 return joinAddress([
  fields.street,fields.galiNumber,fields.road,
  nearby?(nearby.startsWith('About ')?nearby:`Near ${nearby}`):'',
  cityOrVillage&&cityOrVillage.toLowerCase()!==nearby.toLowerCase()?cityOrVillage:'',
  fields.district,fields.state,fields.pincode
 ]);
}

function parseLocationIq(payload){
 if(!payload||typeof payload!=='object')return null;
 const address=payload.address||{};
 const poiName=payload.namedetails?.['name:en']||payload.namedetails?.name||
  payload.name||address.amenity||address.shop||address.tourism||
  address.leisure||address.historic||address.building||address.fuel;
 const category=[payload.category,payload.class,payload.type].join(' ');
 const nearby=isPoiType(category)&&isNamedPlace(poiName)
  ?text(poiName):text(address.neighbourhood||address.suburb);
 const fields={
  street:text(address.house_number||address.plot||address.plot_number||address.building),
  galiNumber:text(address.gali||address.gali_number),
  road:text(address.road||address.pedestrian||address.residential||address.street||address.footway||address.highway),
  nearby,
  locality:text(address.suburb||address.neighbourhood),
  cityOrVillage:text(address.village||address.hamlet||address.town||address.city||address.municipality),
  district:text(address.state_district||address.district||address.county||address.city_district),
  state:text(address.state||address.region),pincode:text(address.postcode),
  country:text(address.country)
 };
 return formatAddress(fields)?fields:null;
}

function parseSelfHostedNominatim(payload){
 if(!payload||typeof payload!=='object'||!payload.address)return null;
 const address=payload.address;
 const namedPlace=payload.namedetails?.['name:en']||payload.namedetails?.name||
  payload.name||address.amenity||address.shop||address.tourism||
  address.leisure||address.historic||address.building||address.fuel;
 const nearby=isPoiType([payload.category,payload.class,payload.type].join(' '))&&isNamedPlace(namedPlace)
  ?text(namedPlace):text(address.neighbourhood||address.suburb);
 const fields={
  street:text(address.house_number||address.plot||address.plot_number||address.building),
  galiNumber:text(address.gali||address.gali_number),
  road:text(address.road||address.pedestrian||address.residential||address.street||address.footway||address.highway),
  nearby,locality:text(address.suburb||address.neighbourhood),
  cityOrVillage:text(address.village||address.hamlet||address.town||address.city||address.municipality),
  district:text(address.state_district||address.district||address.county||address.city_district),
  state:text(address.state||address.region),pincode:text(address.postcode),
  country:text(address.country)
 };
 return formatAddress(fields)?fields:null;
}

function parseGeoapify(payload){
 const properties=payload?.features?.[0]?.properties;
 if(!properties||typeof properties!=='object')return null;
 const category=Array.isArray(properties.categories)?properties.categories.join(' '):
  text(properties.category);
 const nearby=isPoiType(category)&&isNamedPlace(properties.name)
  ?text(properties.name):text(properties.neighbourhood||properties.suburb);
 const fields={
  street:text(properties.housenumber||properties.house_number||properties.building),
  galiNumber:text(properties.gali||properties.gali_number),
  road:text(properties.street||properties.road),
  nearby,locality:text(properties.suburb||properties.neighbourhood||properties.district),
  cityOrVillage:text(properties.village||properties.hamlet||properties.town||properties.city||properties.municipality),
  district:text(properties.state_district||properties.county||properties.district),
  state:text(properties.state||properties.region),pincode:text(properties.postcode||properties.postal_code),
  country:text(properties.country)
 };
 return formatAddress(fields)?fields:null;
}

function distanceMeters(first,second){
 const toRadians=value=>value*Math.PI/180;
 const latDelta=toRadians(Number(second.lat)-Number(first.lat));
 const lngDelta=toRadians(Number(second.lng)-Number(first.lng));
 const value=Math.sin(latDelta/2)**2+
  Math.cos(toRadians(Number(first.lat)))*Math.cos(toRadians(Number(second.lat)))*
  Math.sin(lngDelta/2)**2;
 return 6371000*2*Math.atan2(Math.sqrt(value),Math.sqrt(1-value));
}

function previousLocation(previous,lat,lng){
 const value=previous?.readableLocation||previous?.address;
 if(!isAddressText(value)||previous.addressIsCurrent===false||
  !validCoordinates(previous.addressLat,previous.addressLng))return null;
 const distance=distanceMeters(
  {lat:previous.addressLat,lng:previous.addressLng},
  {lat:Number(lat),lng:Number(lng)}
 );
 if(distance>ADDRESS_REFRESH_DISTANCE_METERS)return null;
 return {
  ...previous,readableLocation:value,
  cityOrVillage:previous.cityOrVillage||previous.city||'',
  provider:canonicalProvider(previous.geocodingProvider),
  addressIsCurrent:true
 };
}

function addressFromPlace(place){
 const placeName=text(place.placeName);
 const distanceKm=Number(place.distanceKm);
 const fields={
  street:'',galiNumber:'',road:'',nearby:placeName,
  locality:'',cityOrVillage:distanceKm<=10?placeName:'',district:text(place.district),
  state:text(place.state),pincode:text(place.postalCode),country:'India',
  addressDistanceKm:distanceKm
 };
 const readableLocation=geoNames.formatLayerOne({
  placeName,district:fields.district,state:fields.state,
  postalCode:fields.pincode,distanceKm
 });
 return readableLocation?{
  ...fields,readableLocation,baseReadableLocation:readableLocation,
  basePlaceName:text(place.placeName),provider:'GeoNames',
  addressDistanceKm:Number(place.distanceKm)
 }:null;
}

function cacheAddress(cached,lat,lng){
 const readableLocation=cached.readableLocation||cached.baseReadableLocation;
 if(!isAddressText(readableLocation))return null;
 return {
  readableLocation,street:cached.street||'',galiNumber:cached.galiNumber||'',
  road:cached.road||'',nearby:cached.nearby||'',locality:cached.locality||'',
  city:cached.cityOrVillage||cached.city||'',
  cityOrVillage:cached.cityOrVillage||cached.city||'',
  district:cached.district||'',state:cached.state||'',pincode:cached.pincode||'',
  country:cached.country||'',provider:canonicalProvider(cached.layer2Provider||cached.provider),
  geocodedAt:cached.layer2GeocodedAt||cached.geocodedAt||null,
  addressDistanceKm:Number(cached.addressDistanceKm||0),
  addressLat:Number(lat),addressLng:Number(lng),addressIsCurrent:true,
  layer2Provider:cached.layer2Provider||''
 };
}

async function saveBaseCache(key,lat,lng,base){
 await M.GeocodeCache.updateOne({key},{
  $set:{
   key,lat:Number(Number(lat).toFixed(5)),lng:Number(Number(lng).toFixed(5)),
   readableLocation:base.readableLocation,baseReadableLocation:base.readableLocation,
   basePlaceName:base.basePlaceName,street:'',galiNumber:'',road:'',
   nearby:base.nearby||'',locality:'',city:base.cityOrVillage||'',
   cityOrVillage:base.cityOrVillage||'',
   district:base.district||'',state:base.state||'',pincode:base.pincode||'',
   country:base.country||'',addressDistanceKm:base.addressDistanceKm,
   provider:'GeoNames',geocodedAt:new Date(),
   expiresAt:new Date(Date.now()+ADDRESS_CACHE_TTL_MS)
  },
  $unset:{failureUntil:'',layer2Provider:'',layer2GeocodedAt:'',layer2FailureUntil:''}
 },{upsert:true});
}

async function saveFailure(key,lat,lng){
 const failureUntil=new Date(Date.now()+FAILURE_CACHE_TTL_MS);
 await M.GeocodeCache.updateOne({key},{
  $set:{
   key,lat:Number(Number(lat).toFixed(5)),lng:Number(Number(lng).toFixed(5)),
   failureUntil,expiresAt:failureUntil
  }
 },{upsert:true});
}

function configuredProvider(){
 const provider=text(process.env.GEOCODER_PROVIDER).toLowerCase();
 if(provider==='nominatim'){
  const configured=text(process.env.NOMINATIM_REVERSE_URL);
  if(!configured)return null;
  try{
   const url=new URL(configured);
   const host=url.hostname.toLowerCase();
   if(url.protocol!=='https:'||host==='nominatim.openstreetmap.org'||
    host.endsWith('.nominatim.openstreetmap.org'))return null;
   return {
    provider,url:url.toString(),
    userAgent:text(process.env.GEOCODER_USER_AGENT)||'SikkaFleet/1.0'
   };
  }catch(_error){return null}
 }
 const apiKey=text(process.env.GEOCODER_API_KEY);
 if(!DAILY_REQUEST_LIMITS[provider]||!apiKey)return null;
 const endpointName=provider==='locationiq'?'LOCATIONIQ_REVERSE_URL':'GEOAPIFY_REVERSE_URL';
 const configured=text(process.env[endpointName])||DEFAULT_ENDPOINTS[provider];
 try{
  const url=new URL(configured);
  if(url.protocol!=='https:')return null;
  return {provider,apiKey,url:url.toString()};
 }catch(_error){return null}
}

function addressEnrichmentFields(base,details,provider){
 const fields={
  street:details.street||base.street||'',
  galiNumber:details.galiNumber||base.galiNumber||'',
  road:details.road||base.road||'',
  nearby:details.nearby||base.nearby||'',
  locality:details.locality||base.locality||'',
  cityOrVillage:details.cityOrVillage||base.cityOrVillage||'',
  district:details.district||base.district||'',
  state:details.state||base.state||'',
  pincode:details.pincode||base.pincode||'',
  country:details.country||base.country||''
 };
 const nearby=details.nearby||base.nearby||'';
 const distanceKm=Number(base.addressDistanceKm||0);
 const readableLocation=details.nearby
 ?formatAddress(fields)||base.readableLocation
 :distanceKm>10&&nearby
  ?joinAddress([
   fields.street,fields.galiNumber,fields.road,
   `About ${Math.round(distanceKm)} km from ${nearby}`,
   fields.cityOrVillage.toLowerCase()===nearby.toLowerCase()?'':fields.cityOrVillage,
   fields.district,fields.state,fields.pincode
  ])
  :formatAddress(fields)||base.readableLocation;
 return {
  ...fields,city:fields.cityOrVillage,readableLocation,
  baseReadableLocation:base.baseReadableLocation||base.readableLocation,
  basePlaceName:base.basePlaceName||base.nearby||'',
  addressDistanceKm:base.addressDistanceKm,
  provider:'GeoNames',layer2Provider:provider
 };
}

async function takeDailyQuota(provider){
 if(provider==='nominatim')return true;
 const day=new Date().toISOString().slice(0,10);
 const key=`${provider}:${day}`;
 const expiresAt=new Date(`${day}T23:59:59.999Z`);
 try{
  await M.GeocoderQuota.findOneAndUpdate(
   {key,count:{$lt:DAILY_REQUEST_LIMITS[provider]}},
   {$inc:{count:1},$setOnInsert:{expiresAt}},
   {returnDocument:'after',upsert:true}
  );
  return true;
 }catch(error){
  if(error.code===11000)return false;
  return false;
 }
}

async function waitForRequestSlot(){
 while(true){
  const waitLocal=Math.max(0,localNextRequestAt-Date.now());
  if(waitLocal)await new Promise(resolve=>setTimeout(resolve,waitLocal));
  const now=new Date();
  try{
   const slot=await M.GeocodeRequestSlot.findOneAndUpdate({
    key:'reverse-geocoder',
    $or:[{nextAllowedAt:{$lte:now}},{nextAllowedAt:{$exists:false}}]
   },{$set:{nextAllowedAt:new Date(now.getTime()+1000)}},{returnDocument:'after',upsert:true}).lean();
   if(slot){
    localNextRequestAt=Date.now()+1000;
    return true;
   }
  }catch(error){
   if(error.code!==11000)return false;
  }
  try{
   const current=await M.GeocodeRequestSlot.findOne({key:'reverse-geocoder'})
    .select('nextAllowedAt').lean();
   const nextAt=new Date(current?.nextAllowedAt||Date.now()+1000).getTime();
   await new Promise(resolve=>setTimeout(resolve,Math.max(50,Math.min(1000,nextAt-Date.now()))));
  }catch(_error){return false}
 }
}

function backoff(attempt){
 return new Promise(resolve=>setTimeout(resolve,RETRY_BACKOFF_MS[attempt]));
}

function requestDetails(config,lat,lng){
 let params,headers={'Accept-Language':'en'};
 if(config.provider==='nominatim'){
  params={lat,lon:lng,format:'jsonv2',addressdetails:1,namedetails:1,zoom:18};
  headers['User-Agent']=config.userAgent;
 }else if(config.provider==='locationiq'){
  params={key:config.apiKey,lat,lon:lng,format:'json',addressdetails:1,zoom:18};
 }else{
  params={apiKey:config.apiKey,lat,lon:lng,format:'json'};
 }
 return axios.get(config.url,{params,timeout:REQUEST_TIMEOUT_MS,headers});
}

async function enrichCache(key,lat,lng,base){
 const config=configuredProvider();
 if(!config)return;
 for(let attempt=0;attempt<=MAX_PROVIDER_RETRIES;attempt++){
  if(!await takeDailyQuota(config.provider)){
   await M.GeocodeCache.updateOne({key},{
    $set:{layer2FailureUntil:new Date(Date.now()+FAILURE_CACHE_TTL_MS)}
   }).catch(()=>{});
   return;
  }
  if(!await waitForRequestSlot()){
   await M.GeocodeCache.updateOne({key},{
    $set:{layer2FailureUntil:new Date(Date.now()+FAILURE_CACHE_TTL_MS)}
   }).catch(()=>{});
   return;
  }
  try{
   const response=await requestDetails(config,lat,lng);
   const parse=config.provider==='nominatim'?parseSelfHostedNominatim:
    config.provider==='locationiq'?parseLocationIq:parseGeoapify;
   const details=parse(response.data);
   if(!details)throw new Error('No address details');
   const providerName=config.provider==='nominatim'?'Nominatim':
    config.provider==='locationiq'?'LocationIQ':'Geoapify';
   const merged=addressEnrichmentFields(base,details,providerName);
   await M.GeocodeCache.updateOne({key},{
    $set:{
     ...merged,readableLocation:merged.readableLocation,
     layer2GeocodedAt:new Date(),
     expiresAt:new Date(Date.now()+ADDRESS_CACHE_TTL_MS)
    },
    $unset:{layer2FailureUntil:'',failureUntil:''}
   });
   return;
  }catch(_error){
   if(attempt<MAX_PROVIDER_RETRIES)await backoff(attempt);
  }
 }
 await M.GeocodeCache.updateOne({key},{
  $set:{layer2FailureUntil:new Date(Date.now()+FAILURE_CACHE_TTL_MS)}
 }).catch(()=>{});
}

function scheduleEnrichment(key,lat,lng,base){
 const config=configuredProvider();
 if(!config)return false;
 if(inFlight.has(key))return true;
 const pending=Promise.resolve().then(()=>enrichCache(key,lat,lng,base))
  .catch(()=>{}).finally(()=>inFlight.delete(key));
 inFlight.set(key,pending);
 return true;
}

async function resolve(lat,lng,{providerAddress,providerFields:fields={},previous}={}){
 if(!validCoordinates(lat,lng))return null;
 const latitude=Number(lat),longitude=Number(lng),key=coordinateKey(lat,lng);
 if(isAddressText(providerAddress)){
  const readableLocation=providerAddress.trim();
  return {
   readableLocation,...fields,provider:'Provider',addressLat:latitude,
   addressLng:longitude,addressIsCurrent:true
  };
 }

 let cached=null;
 try{cached=await M.GeocodeCache.findOne({key}).lean()}
 catch(_error){cached=null}
 if(cached&&new Date(cached.expiresAt)>new Date()){
  const resolved=cacheAddress(cached,latitude,longitude);
  if(resolved){
   const layer2Failed=cached.layer2FailureUntil&&new Date(cached.layer2FailureUntil)>new Date();
   let enrichmentPending=false;
   if(!cached.layer2Provider&&!layer2Failed){
    const base=addressFromPlace({
     placeName:cached.basePlaceName||cached.nearby,
     district:cached.district,state:cached.state,postalCode:cached.pincode,
     distanceKm:cached.addressDistanceKm
    });
    if(base)enrichmentPending=scheduleEnrichment(key,latitude,longitude,base);
   }
   return {...resolved,addressEnrichmentPending:enrichmentPending};
  }
  if(cached.failureUntil&&new Date(cached.failureUntil)>new Date())return null;
 }

 const reused=previousLocation(previous,latitude,longitude);
 if(reused)return reused;
 let place;
 try{place=await geoNames.lookup(latitude,longitude)}
 catch(_error){place=null}
 const base=place&&addressFromPlace(place);
 if(!base){
  await saveFailure(key,latitude,longitude).catch(()=>{});
  return null;
 }
 await saveBaseCache(key,latitude,longitude,base).catch(()=>{});
 const addressEnrichmentPending=scheduleEnrichment(key,latitude,longitude,base);
 return {
  ...base,addressLat:latitude,addressLng:longitude,addressIsCurrent:true,
  addressEnrichmentPending
 };
}

function enqueue(lat,lng,options){
 return resolve(lat,lng,options);
}

module.exports={
 resolve,enqueue,validCoordinates,coordinateKey,isCoordinateText,parseLocationIq,
 parseGeoapify,parseSelfHostedNominatim,previousLocation,distanceMeters,isAddressText,formatAddress,
 addressFromPlace,
 ADDRESS_CACHE_TTL_MS,FAILURE_CACHE_TTL_MS,ADDRESS_REFRESH_DISTANCE_METERS,
 REQUEST_TIMEOUT_MS,MAX_PROVIDER_RETRIES,DAILY_REQUEST_LIMITS
};
