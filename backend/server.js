require('dotenv').config({path:require('path').join(__dirname,'.env')});
const express=require('express');
const mongoose=require('mongoose');
const bcrypt=require('bcryptjs');
const jwt=require('jsonwebtoken');
const cookieParser=require('cookie-parser');
const cors=require('cors');
const helmet=require('helmet');
const rateLimit=require('express-rate-limit');
const {body,validationResult}=require('express-validator');
const axios=require('axios');
const cron=require('node-cron');
const multer=require('multer');
const crypto=require('crypto');
const {waitUntil}=require('@vercel/functions');
const path=require('path');
const fs=require('fs');
const M=require('./models');
const {normalizePermissions,hasPermission}=require('./permissions');
const reverseGeocoding=require('./services/reverseGeocodingService');
const wheelseyeService=require('./services/wheelseyeService');
const {mapProviderPayload}=require('./services/gpsProviderData');
const {
 persistMatchedRecords,partitionProviderRecords,aggregateSyncOutcome
}=require('./services/gpsSyncOutcome');
const fleetSnapshotService=require('./services/fleetSnapshotService');
const sikkaAiService=require('./services/sikkaAiService');
const {aiChatRequestValidators,getAiChatValidationError}=require('./services/aiChatValidation');
const historyRetention=require('./jobs/historyRetention');
const {backfillPlanActors}=require('./services/planActorBackfill');
const {getActivePlanExpiryFilter,setPlanExpiryAfterPlantExit}=require('./services/planExpiry');
const {
 GPS_SYNC_INTERVAL_MS,GPS_SYNC_RETRY_MS,GPS_SYNC_HEARTBEAT_MS,
 isGpsSchedulerHealthy,isGpsSchedulerSecretValid,
 getNextAutoSyncAt,getNextScheduledSyncAt,getNextGpsExecutionAt,
 isGpsSyncDue,isGpsSyncStale,getGpsRetryAt
}=require('./services/gpsSyncSchedule');
const {
 normalizeVehicleNumber:normalizeNumber,groupByVehicleNumber,vehicleNumberRegex
}=require('./services/vehicleIdentity');

const app=express();
app.set('trust proxy',1);
app.use(helmet({crossOriginResourcePolicy:false}));

const allowedOrigins=[
 'https://fleet.sikkaind.com',
 'https://sikka-fleet.vercel.app',
 'http://localhost:5173',
 'http://localhost:5000',
 ...(process.env.ALLOWED_ORIGINS?process.env.ALLOWED_ORIGINS.split(',').map(s=>s.trim()).filter(origin=>origin&&origin!=='*'):[])
];
app.use(cors({
 origin:(origin,callback)=>{
  if(!origin)return callback(null,true);
  if(allowedOrigins.includes(origin)||/^https:\/\/sikka-fleet(?:-[a-z0-9-]+)?\.vercel\.app$/.test(origin)){
   return callback(null,true);
  }
  return callback(null,false);
 },
 credentials:true
}));

app.use(express.json({limit:'1mb'}));
app.use(cookieParser());
app.get('/',(_req,res)=>res.json({ok:true,service:'Sikka Fleet API'}));
app.get('/api/health',(_req,res)=>res.json({ok:true}));
const cronSyncHandler=async(req,res,next)=>{
 const configuredSecret=String(process.env.CRON_SECRET||'');
 if(!configuredSecret)return res.status(500).json({error:'CRON_SECRET is not configured on the server'});
 const match=String(req.get('authorization')||'').match(/^Bearer\s+(.+)$/i);
 const candidate=match?.[1]||req.get('x-cron-secret')||'';
 if(!isGpsSchedulerSecretValid(candidate,configuredSecret)){
  return res.status(401).json({error:'Unauthorized'});
 }
 try{
  await ensureInitialized();
  const heartbeatAt=new Date();
  const configBefore=await M.GpsSyncConfiguration.findOne({key:GPS_SYNC_CONFIG_KEY}).lean();
  const lastAutoSync=configBefore?.nextExecutionAt?null:await M.SyncLog.findOne({
   type:'auto',finishedAt:{$exists:true}
  }).sort({finishedAt:-1}).lean();
  await M.GpsSyncConfiguration.updateOne({key:GPS_SYNC_CONFIG_KEY},{$set:{
   enabled:true,intervalMinutes:30,schedulerMode:'external',
   schedulerStatus:'running',schedulerHeartbeatAt:heartbeatAt,
   ...(configBefore?.nextExecutionAt?{}:{nextExecutionAt:heartbeatAt})
  }},{upsert:true});
  const config={...configBefore,schedulerMode:'external',schedulerHeartbeatAt:heartbeatAt,
   nextExecutionAt:configBefore?.nextExecutionAt||heartbeatAt};
  if(!isGpsSyncDue(heartbeatAt,config,lastAutoSync)){
   return res.status(200).json({
    ok:true,skipped:'not due',nextExecutionAt:getNextGpsExecutionAt(heartbeatAt,config,lastAutoSync)
   });
  }
  const result=await runSync('AUTO');
  if(!result.started)return res.status(200).json({ok:true,skipped:'already running'});
  return res.status(200).json({
   ok:Boolean(result.success),startedAt:result.startedAt,finishedAt:result.finishedAt,
   vehiclesSynced:result.totalVehiclesSynced||0,message:result.message||'',
   warnings:result.warnings||[]
  });
 }catch(error){
  const nextRetryAt=getGpsRetryAt();
  await M.GpsSyncConfiguration.updateOne({key:GPS_SYNC_CONFIG_KEY},{$set:{
   nextRetryAt,schedulerStatus:'running',schedulerMode:'external',
   schedulerHeartbeatAt:new Date()
  }},{upsert:true}).catch(scheduleError=>console.error('[gps-sync] Could not save cron retry time',{
   message:scheduleError.message,stack:scheduleError.stack
  }));
  console.error('[gps-sync] Cron request failed',{
   message:error.message,stack:error.stack
  });
  return res.status(500).json({
   ok:false,startedAt:null,finishedAt:new Date(),vehiclesSynced:0,
   error:error.message||String(error),nextRetryAt
  });
 }
};
app.get('/api/sync/cron',cronSyncHandler);
app.post('/api/sync/cron',cronSyncHandler);
app.use('/uploads',express.static(path.join(__dirname,'uploads')));

const isCoordinateText=value=>typeof value==='string'&&/^\s*-?\d+(?:\.\d+)?\s*,\s*-?\d+(?:\.\d+)?\s*$/.test(value);
const readableAddress=record=>{
 if(record?.addressIsCurrent===false)return null;
 const value=record?.readableLocation||record?.address;
 return typeof value==='string'&&value.trim()&&!isCoordinateText(value)&&
  !/^(?:address|location)\s+unavailable$/i.test(value.trim())&&
  !/\b(?:undefined|null)\b/i.test(value)?value.trim():null;
};
const coordinatesText=record=>reverseGeocoding.validCoordinates(record?.lat,record?.lng)
 ?`${Number(record.lat).toFixed(6)}, ${Number(record.lng).toFixed(6)}`:null;
const displayLocation=record=>readableAddress(record)||coordinatesText(record)||'Location unavailable';
const addressFields=location=>location?{
 readableLocation:location.readableLocation,address:location.readableLocation,
 street:location.street||'',plotNumber:location.plotNumber||location.houseNumber||'',
 houseNumber:location.houseNumber||location.plotNumber||'',galiNumber:location.galiNumber||'',
 road:location.road||'',building:location.building||'',sector:location.sector||'',
 nearby:location.nearby||'',nearestLocation:location.nearestLocation||'',
 nearestLocationCategory:location.nearestLocationCategory||'',
 nearestLocationDistanceMeters:location.nearestLocationDistanceMeters??null,
 nearbyProvider:location.nearbyProvider||'',locality:location.locality||'',city:location.city||'',
 cityOrVillage:location.cityOrVillage||location.city||'',
 district:location.district||'',division:location.division||'',state:location.state||'',pincode:location.pincode||'',
 country:location.country||'',geocodedAt:location.geocodedAt||null,
 addressDistanceKm:location.addressDistanceKm??null,
 geocodingProvider:location.provider||'Provider',
 addressLat:location.addressLat??null,addressLng:location.addressLng??null,
 addressIsCurrent:location.addressIsCurrent!==false
}:{
 readableLocation:null,address:null,street:'',plotNumber:'',houseNumber:'',galiNumber:'',road:'',
 building:'',sector:'',nearby:'',nearestLocation:'',nearestLocationCategory:'',
 nearestLocationDistanceMeters:null,nearbyProvider:'',locality:'',city:'',cityOrVillage:'',
 district:'',division:'',state:'',pincode:'',country:'',
 geocodedAt:null,addressDistanceKm:null,geocodingProvider:null,addressLat:null,addressLng:null,
 addressIsCurrent:false
};
function queueVehicleAddressLookup(row){
 reverseGeocoding.enqueue(row.lat,row.lng).then(async location=>{
  const resolved=location?{
   ...location,addressLat:location.addressLat??row.lat,addressLng:location.addressLng??row.lng,
   addressIsCurrent:location.addressIsCurrent!==false
  }:null;
  const fields=addressFields(resolved);
  await Promise.all([
   M.VehicleLiveStatus.updateOne({
    vehicleNumber:row.vehicleNumber,lat:row.lat,lng:row.lng,gpsTime:row.gpsTime
   },{$set:fields}),
   M.VehicleLocationHistory.updateOne({
    vehicleNumber:row.vehicleNumber,gpsTime:row.gpsTime,provider:'Wheelseye'
   },{$set:fields})
  ]);
 }).catch(error=>console.warn(`Reverse geocoding failed for ${row.vehicleNumber}: ${error.message}`));
}
async function resolveStoredVehicleAddress(record){
  if(!record||!reverseGeocoding.validCoordinates(record.lat,record.lng))return record;
  let location;
  try{location=await reverseGeocoding.resolve(record.lat,record.lng,{previous:record})}
  catch(error){
   console.warn(`Reverse geocoding failed for ${record.vehicleNumber}: ${error.message}`);
   return record;
  }
  if(!location){
   const fields=addressFields(null);
   await Promise.all([
    M.VehicleLiveStatus.updateOne({
     vehicleNumber:record.vehicleNumber,provider:'Wheelseye',lat:record.lat,lng:record.lng,gpsTime:record.gpsTime
    },{$set:fields}),
    M.VehicleLocationHistory.updateOne({
     vehicleNumber:record.vehicleNumber,provider:'Wheelseye',gpsTime:record.gpsTime
    },{$set:fields})
   ]);
   return {...record,...fields,addressEnrichmentPending:false};
  }
  const fields=addressFields({
   ...location,addressLat:location.addressLat??record.lat,addressLng:location.addressLng??record.lng,
   addressIsCurrent:location.addressIsCurrent!==false
  });
  await Promise.all([
   M.VehicleLiveStatus.updateOne({
    vehicleNumber:record.vehicleNumber,provider:'Wheelseye',lat:record.lat,lng:record.lng,gpsTime:record.gpsTime
   },{$set:fields}),
   M.VehicleLocationHistory.updateOne({
    vehicleNumber:record.vehicleNumber,provider:'Wheelseye',gpsTime:record.gpsTime
   },{$set:fields})
  ]);
  return {
   ...record,...fields,
   addressEnrichmentPending:Boolean(location.addressEnrichmentPending)
  };
}
const haversine=(a,b)=>{const R=6371000,toRad=x=>x*Math.PI/180;const dLat=toRad(b.lat-a.lat),dLng=toRad(b.lng-a.lng);const x=Math.sin(dLat/2)**2+Math.cos(toRad(a.lat))*Math.cos(toRad(b.lat))*Math.sin(dLng/2)**2;return R*2*Math.atan2(Math.sqrt(x),Math.sqrt(1-x));};
function vehicleLocationPayload(record){
 if(!record)return null;
 const hasCoordinates=reverseGeocoding.validCoordinates(record.lat,record.lng);
 return {
  location:displayLocation(record),
  addressIsCurrent:Boolean(record.addressIsCurrent&&readableAddress(record)),
  street:record.street||'',plotNumber:record.plotNumber||record.houseNumber||'',
  houseNumber:record.houseNumber||record.plotNumber||'',galiNumber:record.galiNumber||'',
  road:record.road||'',building:record.building||'',sector:record.sector||'',
  nearby:record.nearby||'',nearestLocation:record.nearestLocation||'',
  nearestLocationCategory:record.nearestLocationCategory||'',
  nearestLocationDistanceMeters:record.nearestLocationDistanceMeters??null,
  nearbyProvider:record.nearbyProvider||'',geocodingProvider:record.geocodingProvider||null,
  city:record.city||'',
  cityOrVillage:record.cityOrVillage||record.city||'',
  district:record.district||'',division:record.division||'',state:record.state||'',pincode:record.pincode||'',
  addressDistanceKm:record.addressDistanceKm??null,
  addressEnrichmentPending:Boolean(record.addressEnrichmentPending),
  street:record.street||'',plotNumber:record.plotNumber||record.houseNumber||'',
  houseNumber:record.houseNumber||record.plotNumber||'',sector:record.sector||'',
  nearestLocation:record.nearestLocation||'',
  nearestLocationCategory:record.nearestLocationCategory||'',
  nearestLocationDistanceMeters:record.nearestLocationDistanceMeters??null,
  nearbyProvider:record.nearbyProvider||'',
  division:record.division||'',pincode:record.pincode||'',country:record.country||'',
  geocodingProvider:record.geocodingProvider||null,
  lat:hasCoordinates?Number(record.lat):null,
  lng:hasCoordinates?Number(record.lng):null,
  map:hasCoordinates?`https://www.google.com/maps?q=${record.lat},${record.lng}`:null
 };
}
const GPS_SYNC_LOCK_KEY='gps-sync';
const GPS_SYNC_CONFIG_KEY='global';
const GPS_SYNC_LOCK_TTL_MS=90000;
const GPS_SYNC_LOCK_RENEW_MS=20000;
const SYNC_STATUS_KEY='gps-sync';
const GPS_PROVIDER_DEFAULTS={
 Wheelseye:{url:'https://api.wheelseye.com/currentLoc',environmentVariable:'WHEELSEYE_API_URL',credentialsReference:'WHEELSEYE_API_TOKEN'}
};
let syncing=false,syncScheduler=null;

const ADMIN_USERNAME=String(process.env.ADMIN_USERNAME||'').trim().toLowerCase();
function isAdminAccount(user){return Boolean(user?.isAdmin||user?.username?.toLowerCase()===ADMIN_USERNAME);}
function signAccess(user,sessionId){const isAdmin=isAdminAccount(user);return jwt.sign({sub:user._id,perms:normalizePermissions(user.permissions,isAdmin),isAdmin,sid:sessionId},process.env.JWT_SECRET,{expiresIn:'15m'});}
function signRefresh(user,sessionId){return jwt.sign({sub:user._id,tokenVersion:1,sid:sessionId},process.env.JWT_SECRET,{expiresIn:'30d'});}
function cookieOpts(){return {httpOnly:true,secure:process.env.NODE_ENV==='production',sameSite:process.env.NODE_ENV==='production'?'none':'lax',path:'/'};}
async function audit(action,user,details={},req){await M.AuditLog.create({action,user,details,ip:req?.ip}).catch(()=>{});}
function auth(req,res,next){
 const authHeader=req.headers.authorization;
 const bearerToken=authHeader&&authHeader.startsWith('Bearer ')?authHeader.slice(7).trim():null;
 const token=req.cookies.accessToken||bearerToken;
 if(!token)return res.status(401).json({error:'Unauthorized'});
 try{
  const claims=jwt.verify(token,process.env.JWT_SECRET);
  Promise.all([
   M.Session.findOne({sessionId:claims.sid,revoked:false,expiresAt:{$gt:new Date()}}),
   M.User.findById(claims.sub).select('fullName username active isAdmin permissions')
  ]).then(([session,user])=>{
   if(!session||!user||!user.active)return res.status(401).json({error:'Unauthorized'});
   const isAdmin=isAdminAccount(user);
   req.user={...claims,fullName:user.fullName,username:user.username,isAdmin,perms:normalizePermissions(user.permissions,isAdmin)};
   next();
  }).catch(next);
 }catch{return res.status(401).json({error:'Unauthorized'});}
}
function permission(name,level='view'){return (req,res,next)=>{
 const accessLevel=String(level).toLowerCase();
 if(hasPermission(req.user.perms,name,accessLevel,req.user.isAdmin))return next();
 return res.status(403).json({error:name==='Sikka AI'?'Aapko Sikka AI ka access nahi hai.':'No access'});
};}
function requireAdmin(req,res,next){
 if(!isAdminAccount(req.user))return res.status(403).json({error:'Admin access required'});
 next();
}

function vehicleHasProvider(vehicle,provider){
 const normalizeProvider=value=>String(value||'').trim().toUpperCase();
 const target=normalizeProvider(provider);
 return normalizeProvider(vehicle.gpsLink)===target||
  (vehicle.gpsProviders||[]).some(link=>normalizeProvider(link.name)===target);
}

function uniqueRegistryVehicles(records){
 return [...groupByVehicleNumber(Array.isArray(records)?records:[]).values()].map(group=>
  group.sort((a,b)=>
   Number(b.status==='Active')-Number(a.status==='Active')||
   new Date(b.updatedAt||0)-new Date(a.updatedAt||0)||
   new Date(a.createdAt||0)-new Date(b.createdAt||0)
  )[0]
 );
}

function defaultProviderUrl(provider){
 const settings=GPS_PROVIDER_DEFAULTS[provider];
 const url=new URL(process.env[settings.environmentVariable]||settings.url);
 url.username='';
 url.password='';
 for(const key of [...url.searchParams.keys()])if(/token|secret|password|authorization|api.?key/i.test(key))url.searchParams.delete(key);
 return url.toString();
}

async function seedGpsSettings(){
 for(const [provider,defaults] of Object.entries(GPS_PROVIDER_DEFAULTS)){
  await M.GpsSetting.findOneAndUpdate({provider},{$setOnInsert:{
   provider,enabled:true,baseUrl:defaultProviderUrl(provider),
   credentialsReference:defaults.credentialsReference,
   lastSyncStatus:'Disconnected',lastSyncError:''
  }},{upsert:true,returnDocument:'after'});
 }
}

function validateProviderUrl(provider,value){
 let url;
 try{url=new URL(String(value||''))}
 catch{return null}
 if(url.protocol!=='https:'||url.username||url.password)return null;
 const settings=GPS_PROVIDER_DEFAULTS[provider];
 const configuredOrigin=new URL(process.env[settings.environmentVariable]||settings.url).origin;
 const defaultOrigin=new URL(settings.url).origin;
 if(url.origin!==configuredOrigin&&url.origin!==defaultOrigin)return null;
 if([...url.searchParams.keys()].some(key=>/token|secret|password|authorization|api.?key/i.test(key)))return null;
 return url.toString();
}

function getProviderVehicleId(vehicle,provider){
 return (vehicle.gpsProviders||[]).find(link=>link.name===provider)?.vehicleId||
  (vehicle.gpsLink===provider?vehicle.providerVehicleId:null);
}

async function seedAdmin(){
 const adminUser=String(process.env.ADMIN_USERNAME||'').trim();
 if(!adminUser||!process.env.ADMIN_PASSWORD)return;
 const username=adminUser.toLowerCase();
 const existing=await M.User.findOne({username});
 if(!existing){
  await M.User.create({fullName:'Administrator',username:adminUser,passwordHash:await bcrypt.hash(process.env.ADMIN_PASSWORD,12),isAdmin:true,active:true,permissions:normalizePermissions({},true)});
 }else{
  existing.isAdmin=true;existing.active=true;
  existing.permissions=normalizePermissions({},true);
  await existing.save();
 }
}

let initPromise=null;
async function ensureInitialized(){
 if(mongoose.connection.readyState===1)return;
 if(!initPromise){
  initPromise=(async()=>{
   const mongoUri=process.env.MONGO_URI||process.env.MONGODB_URI;
   if(!mongoUri){
    console.warn('[DB] Warning: MONGO_URI or MONGODB_URI is not set');
    return;
   }
   await mongoose.connect(mongoUri,{dbName:process.env.MONGODB_DB_NAME});
   console.log('MongoDB Atlas connected successfully');
   await M.SikkaAiChat.createIndexes().catch(()=>{});
   await M.GpsSyncLock.createIndexes().catch(()=>{});
   await M.SyncStatus.createIndexes();
   await M.SyncStatus.updateOne({key:SYNC_STATUS_KEY},{$setOnInsert:{isSyncing:false,lastError:''}},{upsert:true});
   await M.GeocodeRequestSlot.createIndexes();
   await M.GpsSyncConfiguration.createIndexes();
   await M.VehiclePlan.createIndexes();
   await seedGpsSettings().catch(()=>{});
   await seedAdmin().catch(()=>{});
   try{
    const updatedPlans=await backfillPlanActors(M);
    if(updatedPlans)console.info(`[plans] Backfilled creator/updater details for ${updatedPlans} plan(s)`);
   }catch(error){
    console.error('[plans] Creator/updater backfill failed',error);
   }
  })().catch(err=>{
   initPromise=null;
   throw err;
  });
 }
 return initPromise;
}

app.use(async(req,res,next)=>{
 try{
  await ensureInitialized();
 }catch(err){
  console.error('[DB init error]',err.message);
  if(req.path.startsWith('/api/')||req.path.startsWith('/uploads/')||req.path.startsWith('/share/')){
   return res.status(503).json({error:'Database temporarily unavailable'});
  }
 }
 next();
});

function isRetryableProviderError(error){
 const status=Number(error.response?.status||error.statusCode||0);
 return [408,425,429].includes(status)||status>=500||
  ['ECONNABORTED','ETIMEDOUT','ECONNRESET','EAI_AGAIN','ENOTFOUND','ECONNREFUSED'].includes(error.code);
}

function wait(milliseconds){
 return new Promise(resolve=>setTimeout(resolve,milliseconds));
}

async function retryProviderRequest(provider,request){
 for(let attempt=1;attempt<=3;attempt++){
  try{return await request()}
  catch(error){
   if(attempt===3||!isRetryableProviderError(error))throw error;
   const delay=500*2**(attempt-1);
   console.warn(`[GPS sync] ${provider} request failed; retry ${attempt+1}/3 in ${delay}ms`,{
    code:error.response?.status||error.statusCode||error.code||'unknown'
   });
   await wait(delay);
  }
 }
 throw new Error(`${provider} request failed after retries`);
}

async function getGpsSyncStatus(now=new Date()){
 const [lastCycle,lastSuccessfulSync,lastSuccessfulAutoSync,lastManualSync,lastAutoSync,activeLock,gpsData,syncConfig,persistedStatus]=await Promise.all([
  M.SyncLog.findOne({finishedAt:{$exists:true}}).sort({finishedAt:-1}).lean(),
  M.SyncLog.findOne({success:true,finishedAt:{$exists:true}}).sort({finishedAt:-1}).lean(),
  M.SyncLog.findOne({type:'auto',success:true}).sort({finishedAt:-1}).lean(),
  M.SyncLog.findOne({type:'manual'}).sort({finishedAt:-1}).lean(),
  M.SyncLog.findOne({type:'auto',finishedAt:{$exists:true}}).sort({finishedAt:-1}).lean(),
  M.GpsSyncLock.findOne({key:GPS_SYNC_LOCK_KEY,lockUntil:{$gt:now}}).lean(),
  M.VehicleLiveStatus.findOne({provider:'Wheelseye',syncedAt:{$exists:true}}).sort({syncedAt:-1}).select('syncedAt').lean(),
  M.GpsSyncConfiguration.findOne({key:GPS_SYNC_CONFIG_KEY}).lean(),
  M.SyncStatus.findOne({key:SYNC_STATUS_KEY}).lean()
 ]);
 const startedAt=new Date(persistedStatus?.syncStartedAt||0).getTime();
 const staleSync=isGpsSyncStale(persistedStatus?.syncStartedAt,now);
 const active=!staleSync&&(
  Boolean(persistedStatus?.isSyncing&&startedAt<=now.getTime())||Boolean(activeLock)
 );
 const schedulerHealthy=isGpsSchedulerHealthy(now,syncConfig);
 const autoSyncActive=schedulerHealthy;
 const wheelseyeCycle=lastCycle?.result?.Wheelseye;
 const lastCycleErrors=Array.isArray(wheelseyeCycle?.errors)
  ?wheelseyeCycle.errors.map(error=>({provider:'Wheelseye',...error}))
  :[];
 const failureMessage=persistedStatus?.lastError||lastCycle?.result?.message||
  lastCycle?.result?.error||wheelseyeCycle?.message||'';
 const status=active?'Sync In Progress':lastCycle?.status==='Skipped'?'Sync Skipped':lastCycle
  ?lastCycle.success?'Sync Successful':'Sync Failed'
  :autoSyncActive?'Scheduler Active':'Scheduler Inactive';
 const persistedLastSyncStatus=['Successful','Failed'].includes(persistedStatus?.lastSyncStatus)
  ?persistedStatus.lastSyncStatus:null;
 return {
  serverTime:now,
  autoSyncActive,isSyncing:active,status,
  schedulerStatus:syncConfig?.enabled===false?'disabled':schedulerHealthy?'running':'inactive',
  schedulerMode:syncConfig?.schedulerMode||null,
  schedulerHeartbeatAt:syncConfig?.schedulerHeartbeatAt||null,
  lastAutoExecutionAt:syncConfig?.lastExecutionAt||lastAutoSync?.finishedAt||null,
  syncIntervalMinutes:syncConfig?.intervalMinutes||30,
  nextAutoSyncAt:schedulerHealthy?getNextGpsExecutionAt(now,syncConfig,lastAutoSync):null,
  lastSuccessfulSyncAt:lastSuccessfulSync?.finishedAt||null,
  lastSuccessfulAutoSyncAt:syncConfig?.lastSuccessfulAt||lastSuccessfulAutoSync?.finishedAt||null,
  lastManualSyncAt:lastManualSync?.finishedAt||lastManualSync?.startedAt||null,
  lastSyncAt:persistedStatus?.lastSyncAt||lastCycle?.finishedAt||lastCycle?.startedAt||null,
  lastSyncType:persistedStatus?.lastSyncType||lastCycle?.type?.toUpperCase()||null,
  lastSyncStatus:persistedLastSyncStatus||
   (lastCycle&&lastCycle.status!=='Skipped'
    ?lastCycle.success?'Successful':'Failed'
    :null),
  lastSyncSuccess:typeof lastCycle?.success==='boolean'?lastCycle.success:null,
  lastSyncStartedAt:lastCycle?.startedAt||null,
  lastSyncFinishedAt:lastCycle?.finishedAt||null,
  lastSyncTotalVehicles:lastCycle?.totalRegisteredVehicles||0,
  lastSyncSuccessfulVehicles:lastCycle?.successfulVehicles||0,
  lastSyncFailedVehicles:lastCycle?.failedVehicles||0,
  lastError:lastCycle?.status==='Skipped'?'':failureMessage,
  totalVehiclesSynced:lastCycle?.result?.totalVehiclesSynced||0,
  failedVehicleCount:lastCycle?.result?.failedVehicleCount||0,
  lastSyncSummary:lastCycle?.result?.syncSummary||null,
  gpsDataLastUpdated:gpsData?.syncedAt||null,
  lastCycleErrors:lastCycleErrors.slice(0,20),
  lastCycleGeofenceError:lastCycle?.result?.geofenceError||null,
  lastCycleSuccess:lastCycle?.success??null,
  lastCycleType:lastCycle?.type||null
 };
}

async function acquireGpsSyncLock(owner,now,type){
 try{
  const lock=await M.GpsSyncLock.findOneAndUpdate({
   key:GPS_SYNC_LOCK_KEY,
   $or:[{lockUntil:{$lte:now}},{lockUntil:{$exists:false}}]
  },{$set:{owner,type,acquiredAt:now,lockUntil:new Date(now.getTime()+GPS_SYNC_LOCK_TTL_MS)}},
  {upsert:true,returnDocument:'after'});
  return lock?.owner===owner;
 }catch(error){
  if(error.code===11000)return false;
  throw error;
 }
}

async function logSkippedSync(type,reason,at=new Date()){
 const finishedAt=new Date();
 await M.SyncLog.create({
  type,startedAt:at,finishedAt,result:{reason},success:false,status:'Skipped',
  errorDetails:[{message:reason}]
 });
 return {started:false,reason,finishedAt};
}

async function runSync(type='manual',options={}){
 const attemptedAt=new Date();
 const normalizedType=String(type).toLowerCase()==='auto'?'auto':'manual';
 const statusType=normalizedType.toUpperCase();
 const isRetry=options.retry===true;
 if(syncing){
  const activeStatus=await M.SyncStatus.findOne({key:SYNC_STATUS_KEY}).lean();
  if(activeStatus?.isSyncing&&isGpsSyncStale(activeStatus.syncStartedAt,attemptedAt)){
   syncing=false;
  }
 }
 if(syncing)return logSkippedSync(normalizedType,'Sync already running',attemptedAt);
 syncing=true;
 const owner=crypto.randomUUID();
 let lockAcquired=false,statusAcquired=false,lockLost=false,heartbeat=null;
 let cycleStartedAt=attemptedAt,cycleFinishedAt=null,cycleSucceeded=false;
 let cycleFailureMessage='';
 let finalProviderResults={};
 let gpsPersistence=null;
 let registeredVehicleCount=0,synchronizedVehicleCount=0,failedVehicleCountForLog=0;
 const activeRegistryNumbers=new Set();
 const reportedActiveNumbers=new Set();
 const inactiveVehicleNumbersSkipped=new Set();
 const unregisteredGpsNumbersIgnored=new Set();
 let unidentifiedGpsRecordsIgnored=0;
 let actualSyncErrorCount=0;
 try{
  const existingStatus=await M.SyncStatus.findOne({key:SYNC_STATUS_KEY}).lean();
  if(existingStatus?.isSyncing&&isGpsSyncStale(existingStatus.syncStartedAt,attemptedAt)){
   const staleMessage='Previous GPS synchronization exceeded the maximum run time';
   await M.SyncStatus.updateOne({
    key:SYNC_STATUS_KEY,isSyncing:true,syncStartedAt:existingStatus.syncStartedAt
   },{$set:{
    isSyncing:false,lastSyncAt:attemptedAt,lastSyncStatus:'Failed',lastError:staleMessage
   }});
   await M.GpsSyncLock.deleteOne({
    key:GPS_SYNC_LOCK_KEY,
    $or:[
     {lockUntil:{$lte:attemptedAt}},
     {acquiredAt:{$lte:new Date(attemptedAt.getTime()-10*60*1000)}}
    ]
   });
   console.error('[gps-sync] Stale sync lock cleared',{startedAt:existingStatus.syncStartedAt});
  }
  const statusLock=await M.SyncStatus.findOneAndUpdate({
   key:SYNC_STATUS_KEY,
   $or:[
    {isSyncing:{$ne:true}},
    {syncStartedAt:{$lte:new Date(attemptedAt.getTime()-10*60*1000)}}
   ]
  },{$set:{isSyncing:true,syncStartedAt:attemptedAt,lastSyncType:statusType,lastError:''}},
  {returnDocument:'after'});
  if(!statusLock)return await logSkippedSync(normalizedType,'Sync already running',attemptedAt);
  statusAcquired=true;
  lockAcquired=await acquireGpsSyncLock(owner,attemptedAt,normalizedType);
  if(!lockAcquired){
   await M.SyncStatus.updateOne({key:SYNC_STATUS_KEY,syncStartedAt:attemptedAt},{$set:{isSyncing:false}});
   statusAcquired=false;
   return await logSkippedSync(normalizedType,'Another backend instance is running GPS sync',attemptedAt);
  }
  heartbeat=setInterval(async()=>{
   try{
    const update=await M.GpsSyncLock.updateOne({key:GPS_SYNC_LOCK_KEY,owner},{
     $set:{lockUntil:new Date(Date.now()+GPS_SYNC_LOCK_TTL_MS)}
    });
    if(update.matchedCount===0){
     lockLost=true;
     clearInterval(heartbeat);
     console.error('[GPS sync] Distributed lock lease was lost',{owner,type:normalizedType});
    }
   }catch(error){
    console.error('[GPS sync] Could not renew distributed lock lease',{
     owner,type:normalizedType,message:error.message,stack:error.stack
    });
   }
  },GPS_SYNC_LOCK_RENEW_MS);
  heartbeat.unref?.();
  const startedAt=new Date();
  cycleStartedAt=startedAt;
  if(normalizedType==='auto'){
   const schedulerUpdate={
    lastExecutionAt:startedAt,schedulerStatus:'running',schedulerHeartbeatAt:startedAt,
    ...(isRetry?{nextRetryAt:null}:{nextExecutionAt:getNextScheduledSyncAt(startedAt),nextRetryAt:null,retryAttempts:0})
   };
   await M.GpsSyncConfiguration.updateOne({key:GPS_SYNC_CONFIG_KEY},{$set:schedulerUpdate},{upsert:true});
  }
  let registryRows=await M.Vehicle.find({})
   .select('vehicleNumber normalizedVehicleNumber gpsLink gpsProviders status updatedAt createdAt').lean();
  let registryVehicles=uniqueRegistryVehicles(registryRows);
  let activeVehicles=registryVehicles.filter(vehicle=>vehicle.status==='Active');
  registeredVehicleCount=activeVehicles.length;
  const savedProviderSettings=await M.GpsSetting.find({provider:'Wheelseye'}).lean();
  const providerSettingsByName=new Map(savedProviderSettings.map(setting=>[setting.provider,setting]));
  const synchronizedRegisteredNumbers=new Set();
  const result={};
  const providers=[
   {name:'Wheelseye',fetch:baseUrl=>wheelseyeService.fetchLive({baseUrl})}
  ];
  const eligibleRegistryNumbers=new Set();
  console.error('[gps-sync] request started',{type:normalizedType,provider:'Wheelseye'});
  const providerResponsesByName=new Map(await Promise.all(providers.map(async provider=>{
   const settings=providerSettingsByName.get(provider.name);
   if(settings?.enabled===false)return [provider.name,{skipped:true}];
   try{
    const response=await retryProviderRequest(provider.name,()=>provider.fetch(settings?.baseUrl));
    return [provider.name,{response}];
   }catch(error){
    return [provider.name,{error}];
   }
  })));
  registryRows=await M.Vehicle.find({})
   .select('vehicleNumber normalizedVehicleNumber gpsLink gpsProviders status updatedAt createdAt').lean();
  registryVehicles=uniqueRegistryVehicles(registryRows);
  activeVehicles=registryVehicles.filter(vehicle=>vehicle.status==='Active');
  activeRegistryNumbers.clear();
  for(const vehicle of activeVehicles){
   const number=normalizeNumber(vehicle.vehicleNumber);
   if(number)activeRegistryNumbers.add(number);
  }
  registeredVehicleCount=activeRegistryNumbers.size;
  for(const p of providers){
   if(lockLost)throw new Error('GPS sync stopped after losing the distributed lock');
   const providerSettings=providerSettingsByName.get(p.name);
   const registered=activeVehicles.filter(vehicle=>vehicleHasProvider(vehicle,p.name));
   const vehiclesByNumber=new Map(registered.map(vehicle=>[normalizeNumber(vehicle.vehicleNumber),vehicle]));
   const registeredNumbers=registered.map(vehicle=>normalizeNumber(vehicle.vehicleNumber));
   const providerActiveNumbers=new Set(registeredNumbers);
   for(const number of registeredNumbers)eligibleRegistryNumbers.add(number);
   const errorDetails=[];
   let receivedActiveCount=0,syncedActiveCount=0,unavailableActiveCount=registered.length;
   let inactiveSkippedCount=0,unregisteredIgnoredCount=0;
   const providerResult={enabled:providerSettings?.enabled!==false,ok:false,status:'failed',
    returnedVehicles:0,validRecords:0,rejected:{},reason:'',actualErrorCount:0};
   if(providerSettings?.enabled===false){
    const disabledAt=new Date();
    await M.GpsProviderStatus.findOneAndUpdate({provider:p.name},{$set:{
     status:'Disconnected',lastAttemptTime:disabledAt,vehicleCount:registered.length,
     vehiclesReceived:0,vehiclesNotResponding:registered.length,syncErrors:0,
     inactiveVehiclesSkipped:0,unregisteredRecordsIgnored:0,
     lastErrorMessage:'',lastErrorCode:null,lastErrorTime:null
    }},{upsert:true});
    await M.GpsSetting.updateOne({provider:p.name},{$set:{
     lastSyncStatus:'Disabled',lastSyncError:'',lastSyncedAt:disabledAt
    }});
    providerResult.ok=true;
    providerResult.status='disabled';
    providerResult.reason='provider disabled';
    providerResult.syncSummary={
     activeRegisteredVehicles:registered.length,successfullySyncedVehicles:0,
     activeVehiclesWithoutGpsData:registered.length,inactiveVehiclesSkipped:0,
     unregisteredGpsRecordsIgnored:0,actualErrors:0
    };
    result[p.name]={
     status:'Disabled',count:0,syncedCount:0,failedCount:registered.length,
     actualErrorCount:0,syncSummary:providerResult.syncSummary,message:'Provider is disabled'
    };
    finalProviderResults[p.name]=providerResult;
    continue;
   }
   try{
    const fetched=providerResponsesByName.get(p.name);
    if(fetched?.error)throw fetched.error;
    const response=fetched?.response;
    const mapped=mapProviderPayload(response.data,p.name,{now:startedAt});
    if(!mapped.validResponse)throw new Error(`${p.name} response did not contain a vehicle records list`);
    const rows=mapped.records;
    providerResult.ok=true;
    providerResult.returnedVehicles=mapped.received;
    providerResult.validRecords=rows.length;
    providerResult.rejected=mapped.rejected;
    console.error('[gps-sync] records received',{
     provider:p.name,received:mapped.received,valid:rows.length,rejected:mapped.rejected
    });
    const currentRows=rows.filter(row=>{
     const gpsTime=new Date(row.gpsTime);
     return Number.isFinite(gpsTime.getTime())&&gpsTime<=startedAt;
    });
    const partition=partitionProviderRecords({
     records:currentRows,vehicles:registryVehicles,providerName:p.name,
     isLinked:vehicle=>vehicleHasProvider(vehicle,p.name)
    });
    for(const number of partition.inactiveVehicleNumbers)inactiveVehicleNumbersSkipped.add(number);
    for(const number of partition.unregisteredVehicleNumbers)unregisteredGpsNumbersIgnored.add(number);
    for(const number of partition.eligibleRecords.map(row=>row.vehicleNumber))reportedActiveNumbers.add(number);
    unidentifiedGpsRecordsIgnored+=partition.unidentifiedRecordCount;
    const providerNotLinkedNumbers=new Set(partition.providerNotLinkedVehicleNumbers);
    if(partition.inactiveVehicleNumbers.size||partition.unregisteredVehicleNumbers.size||
     partition.providerNotLinkedVehicleNumbers.size||partition.duplicateRecordCount||
     partition.unidentifiedRecordCount){
     console.warn('[gps-sync] ignored provider GPS records',{
      provider:p.name,
      inactiveVehiclesSkipped:partition.inactiveVehicleNumbers.size,
      unregisteredRecordsIgnored:partition.unregisteredVehicleNumbers.size,
      providerNotLinkedRecords:partition.providerNotLinkedVehicleNumbers.size,
      duplicateRecordsIgnored:partition.duplicateRecordCount,
      unidentifiedRecordsIgnored:partition.unidentifiedRecordCount,
      unregisteredVehicleNumbers:[...partition.unregisteredVehicleNumbers].slice(0,10)
     });
    }
    const saved=await persistMatchedRecords({
     records:partition.eligibleRecords,vehiclesByNumber,providerName:p.name,
     isLinked:vehicle=>vehicleHasProvider(vehicle,p.name),
     persistRecord:async(row,vehicle)=>{
      if(lockLost)throw new Error('GPS sync stopped after losing the distributed lock');
     const existing=await M.VehicleLiveStatus.findOne({
      vehicleNumber:vehicleNumberRegex(row.vehicleNumber)
     }).select('_id').lean();
     const previous=existing?await M.VehicleLiveStatus.findOne({
      _id:existing._id,provider:'Wheelseye'
     }).lean():null;
     const current=await M.Vehicle.findById(vehicle._id)
      .select('vehicleNumber status gpsLink gpsProviders').lean();
     const currentNumber=normalizeNumber(current?.vehicleNumber);
     if(!current){
      providerActiveNumbers.delete(row.vehicleNumber);
      activeRegistryNumbers.delete(row.vehicleNumber);
      eligibleRegistryNumbers.delete(row.vehicleNumber);
      unregisteredGpsNumbersIgnored.add(row.vehicleNumber);
      reportedActiveNumbers.delete(row.vehicleNumber);
      registeredVehicleCount=activeRegistryNumbers.size;
      return false;
     }
     if(current.status!=='Active'){
      providerActiveNumbers.delete(row.vehicleNumber);
      activeRegistryNumbers.delete(row.vehicleNumber);
      eligibleRegistryNumbers.delete(row.vehicleNumber);
      inactiveVehicleNumbersSkipped.add(row.vehicleNumber);
      reportedActiveNumbers.delete(row.vehicleNumber);
      registeredVehicleCount=activeRegistryNumbers.size;
      return false;
     }
     if(currentNumber!==row.vehicleNumber){
      providerActiveNumbers.delete(row.vehicleNumber);
      activeRegistryNumbers.delete(row.vehicleNumber);
      eligibleRegistryNumbers.delete(row.vehicleNumber);
      if(vehicleHasProvider(current,p.name)){
       providerActiveNumbers.add(currentNumber);
       eligibleRegistryNumbers.add(currentNumber);
      }
      activeRegistryNumbers.add(currentNumber);
      unregisteredGpsNumbersIgnored.add(row.vehicleNumber);
      reportedActiveNumbers.delete(row.vehicleNumber);
      registeredVehicleCount=activeRegistryNumbers.size;
      return false;
     }
     if(!vehicleHasProvider(current,p.name)){
      providerActiveNumbers.delete(row.vehicleNumber);
      eligibleRegistryNumbers.delete(row.vehicleNumber);
      providerNotLinkedNumbers.add(row.vehicleNumber);
      reportedActiveNumbers.delete(row.vehicleNumber);
      return false;
     }
     const previousGpsTime=previous?.gpsTime?new Date(previous.gpsTime):null;
     if(previousGpsTime&&previousGpsTime>row.gpsTime){
      errorDetails.push({message:'Newer stored GPS data was kept'});
      throw new Error('Newer stored GPS data was kept');
     }
     const syncedAt=new Date();
     const providerLocation={
      ...(row.providerFields||{}),
      readableLocation:row.providerAddress||null,
      provider:'Provider',addressLat:row.lat,addressLng:row.lng,
      addressIsCurrent:Boolean(row.providerAddress)
     };
     const doc={...row,...addressFields(providerLocation),
      normalizedVehicleNumber:row.vehicleNumber,unregistered:false,stale:false,
      lastGoodTime:row.gpsTime,syncedAt};
     delete doc.providerAddress;
     delete doc.providerFields;
     await M.VehicleLiveStatus.findOneAndUpdate(
      existing?{_id:existing._id}:{normalizedVehicleNumber:row.vehicleNumber},
      {$set:doc},{upsert:!existing,returnDocument:'after'}
     );
     await M.VehicleLocationHistory.updateOne(
      {vehicleNumber:row.vehicleNumber,gpsTime:row.gpsTime,provider:row.provider},
      {$setOnInsert:{vehicle:row.vehicleNumber,vehicleNumber:row.vehicleNumber,lat:row.lat,lng:row.lng,
       ...addressFields(providerLocation),providerVehicleId:row.providerVehicleId?String(row.providerVehicleId):undefined,
       driverName:row.driverName,vehicleStatus:row.vehicleStatus,
       speed:row.speed,ignition:row.ignition,ignitionStatus:row.ignitionStatus,
       gpsTime:row.gpsTime,provider:row.provider,syncedAt}},
      {upsert:true}
     );
     queueVehicleAddressLookup(row);
     synchronizedRegisteredNumbers.add(row.vehicleNumber);
     synchronizedVehicleCount=synchronizedRegisteredNumbers.size;
     }
    });
    gpsPersistence=saved;
    errorDetails.push(...saved.errors);
    console.error('[gps-sync] matched records',{
     provider:p.name,matched:saved.receivedNumbers.size,mismatches:saved.vehicleNumberMismatches
    });
    console.error('[gps-sync] saved records',{
     provider:p.name,saved:saved.savedNumbers.size,errors:saved.saveErrors
    });
    if(lockLost)throw new Error('GPS sync stopped after losing the distributed lock');
    if(saved.vehicleNumberMismatches){
     providerResult.rejected['vehicle number mismatch']=saved.vehicleNumberMismatches;
    }
    for(const number of saved.skippedNumbers){
     if(!reportedActiveNumbers.has(number))continue;
     reportedActiveNumbers.delete(number);
    }
    const syncedNumbers=saved.savedNumbers;
    const receivedRegistered=saved.receivedNumbers;
    const receivedAssignedNumbers=registeredNumbers.filter(number=>receivedRegistered.has(number));
    receivedActiveCount=receivedAssignedNumbers.length;
    syncedActiveCount=syncedNumbers.size;
    unavailableActiveCount=Math.max(
     0,[...providerActiveNumbers].filter(number=>!receivedRegistered.has(number)).length
    );
    inactiveSkippedCount=inactiveVehicleNumbersSkipped.size;
    unregisteredIgnoredCount=unregisteredGpsNumbersIgnored.size;
    for(const number of receivedAssignedNumbers)reportedActiveNumbers.add(number);
    const updatedNumbers=[...syncedNumbers];
    if(updatedNumbers.length){
     await M.VehicleLiveStatus.updateMany({vehicleNumber:{$in:updatedNumbers}},{$set:{stale:false}});
    }
    const completedAt=new Date();
    const failedCount=unavailableActiveCount;
    providerResult.ok=true;
    providerResult.status=saved.saveErrors?'partial':'ok';
    providerResult.actualErrorCount=saved.saveErrors;
    providerResult.reason=saved.saveErrors
     ?`${saved.saveErrors} GPS record(s) could not be saved`:'';
    providerResult.syncSummary={
     activeRegisteredVehicles:providerActiveNumbers.size,
     successfullySyncedVehicles:syncedNumbers.size,
     activeVehiclesWithoutGpsData:unavailableActiveCount,
     inactiveVehiclesSkipped:inactiveSkippedCount,
     unregisteredGpsRecordsIgnored:unregisteredIgnoredCount,
     providerNotLinkedRecordsIgnored:providerNotLinkedNumbers.size,
     duplicateProviderRecordsIgnored:partition.duplicateRecordCount,
     actualErrors:saved.saveErrors
    };
    await M.GpsProviderStatus.findOneAndUpdate({provider:p.name},{$set:{
     status:'Connected',lastAttemptTime:completedAt,lastSuccessTime:completedAt,
     lastErrorMessage:'',lastErrorCode:null,lastErrorTime:null,vehicleCount:providerActiveNumbers.size,
     vehiclesReceived:receivedAssignedNumbers.length,vehiclesNotResponding:failedCount,
     syncErrors:saved.saveErrors,inactiveVehiclesSkipped:inactiveSkippedCount,
     unregisteredRecordsIgnored:unregisteredIgnoredCount,
     apiResponseStatus:response.status||200
    }}, {upsert:true});
    await M.GpsSetting.updateOne({provider:p.name},{$set:{
     lastSyncStatus:'Connected',lastSyncError:'',lastSyncedAt:completedAt
    }});
    result[p.name]={
     status:'Connected',count:syncedNumbers.size,syncedCount:syncedNumbers.size,
     failedCount,vehiclesReceived:receivedAssignedNumbers.length,
     inactiveVehiclesSkipped:inactiveSkippedCount,
     unregisteredRecordsIgnored:unregisteredIgnoredCount,
     actualErrorCount:saved.saveErrors,syncSummary:providerResult.syncSummary,
     message:providerResult.reason,errors:errorDetails.slice(0,30)
    };
   }catch(e){
    const code=Number(e.response?.status||e.statusCode||0);
    const reason=e.message||e.reason||String(e);
    const message=reason;
    providerResult.ok=false;
    providerResult.status='failed';
    providerResult.reason=reason;
    providerResult.message=message;
    providerResult.actualErrorCount=(providerResult.actualErrorCount||0)+1;
    providerResult.syncSummary={
     activeRegisteredVehicles:providerActiveNumbers.size,
     successfullySyncedVehicles:syncedActiveCount,
     activeVehiclesWithoutGpsData:unavailableActiveCount,
     inactiveVehiclesSkipped:inactiveSkippedCount,
     unregisteredGpsRecordsIgnored:unregisteredIgnoredCount,
     actualErrors:providerResult.actualErrorCount
    };
    try{
     await M.GpsProviderStatus.findOneAndUpdate({provider:p.name},{$set:{
      status:'Error',lastAttemptTime:new Date(),lastErrorMessage:message,
      lastErrorCode:code,lastErrorTime:new Date(),vehicleCount:providerActiveNumbers.size,
      vehiclesReceived:receivedActiveCount,vehiclesNotResponding:unavailableActiveCount,
      syncErrors:providerResult.actualErrorCount,
      inactiveVehiclesSkipped:inactiveSkippedCount,
      unregisteredRecordsIgnored:unregisteredIgnoredCount
     }},{upsert:true});
     await M.GpsSetting.updateOne({provider:p.name},{$set:{
      lastSyncStatus:'Error',lastSyncError:message,lastSyncedAt:new Date()
     }});
    }catch(statusError){
     console.error(`[GPS sync] Could not persist ${p.name} failure status`,{
      message:statusError.message,stack:statusError.stack
     });
    }
    result[p.name]={
     status:'Error',count:syncedActiveCount,syncedCount:syncedActiveCount,
     failedCount:unavailableActiveCount,vehiclesReceived:receivedActiveCount,
     actualErrorCount:providerResult.actualErrorCount,
     inactiveVehiclesSkipped:inactiveSkippedCount,
     unregisteredRecordsIgnored:unregisteredIgnoredCount,
     syncSummary:providerResult.syncSummary,
     message,code,errors:[...errorDetails,{provider:p.name,message,code}].slice(0,30)
    };
   }finally{
    finalProviderResults[p.name]=providerResult;
   }
  }
  const failedVehicleNumbers=[...eligibleRegistryNumbers].filter(number=>!synchronizedRegisteredNumbers.has(number));
  if(failedVehicleNumbers.length){
   await M.VehicleLiveStatus.updateMany(
   {provider:'Wheelseye',$or:[
    {normalizedVehicleNumber:{$in:failedVehicleNumbers}},
    {vehicleNumber:{$in:failedVehicleNumbers.map(vehicleNumberRegex)}}
   ]},{$set:{stale:true}}
   );
  }
  const finishedAt=new Date();
  const totalVehiclesSynced=synchronizedRegisteredNumbers.size;
  actualSyncErrorCount=Object.values(finalProviderResults).reduce((total,providerResult)=>
   total+(Number(providerResult?.actualErrorCount)||0),0
  );
  const failedVehicleCount=actualSyncErrorCount;
  const activeVehiclesWithoutGpsData=[...activeRegistryNumbers]
   .filter(number=>!reportedActiveNumbers.has(number)).length;
  const syncSummary={
   activeRegisteredVehicles:activeRegistryNumbers.size,
   successfullySyncedVehicles:totalVehiclesSynced,
   activeVehiclesWithoutGpsData,
   inactiveVehiclesSkipped:inactiveVehicleNumbersSkipped.size,
   unregisteredGpsRecordsIgnored:unregisteredGpsNumbersIgnored.size+unidentifiedGpsRecordsIgnored,
   actualErrors:actualSyncErrorCount
  };
  const outcome=aggregateSyncOutcome(finalProviderResults.Wheelseye,{persistence:gpsPersistence});
  const success=outcome.success;
  cycleFailureMessage=outcome.error||outcome.warnings.join('; ');
  cycleFinishedAt=finishedAt;
  cycleSucceeded=success;
  synchronizedVehicleCount=totalVehiclesSynced;
  failedVehicleCountForLog=failedVehicleCount;
  const summary={
   ...result,totalVehiclesSynced,failedVehicleCount,syncSummary,geofenceError:null,
   status:outcome.status,message:outcome.message,warnings:outcome.warnings
  };
  const errorDetails=Object.entries(result).flatMap(([provider,providerResult])=>
   (Array.isArray(providerResult?.errors)?providerResult.errors:[])
    .map(error=>({provider,...error}))
  );
  const syncLog=await M.SyncLog.create({
   type:normalizedType,startedAt,finishedAt,result:summary,success,
   totalRegisteredVehicles:registeredVehicleCount,
   successfulVehicles:totalVehiclesSynced,failedVehicles:failedVehicleCount,
   status:outcome.status==='Successful'?'Success':outcome.status,
   errorDetails
  });
  const recalculateGeofence=async()=>{
   console.error('[gps-sync] geofence recalculation started',{type:normalizedType});
   let geofenceError=null;
   try{
    await updateGeofence();
   }catch(error){
    geofenceError=error.message||String(error);
    console.error('[gps-sync] geofence recalculation failed',{
     message:geofenceError,stack:error.stack
    });
   }
   const finalOutcome=aggregateSyncOutcome(finalProviderResults.Wheelseye,{
    geofenceError,persistence:gpsPersistence
   });
   await M.SyncLog.updateOne({_id:syncLog._id},{$set:{
    'result.geofenceError':geofenceError,
    'result.message':finalOutcome.message,
    'result.warnings':finalOutcome.warnings,
    'result.status':finalOutcome.status
   }});
   if(geofenceError){
    await M.SyncStatus.updateOne({
     key:SYNC_STATUS_KEY,lastSyncAt:finishedAt
    },{$set:{lastError:finalOutcome.message}});
   }
   console.error('[gps-sync] geofence recalculation finished',{
    warning:Boolean(geofenceError),message:finalOutcome.message
   });
  };
  if(process.env.VERCEL){
   const task=recalculateGeofence().catch(error=>{
    console.error('[gps-sync] deferred geofence task failed',{
     message:error.message,stack:error.stack
    });
   });
   try{waitUntil(task)}
   catch(error){
    console.error('[gps-sync] could not defer geofence recalculation; waiting for completion',{
     message:error.message
    });
    await task;
   }
  }else{
   await recalculateGeofence();
  }
  console.error('[gps-sync] finish',{
   type:normalizedType,success,totalVehiclesSynced,failedVehicleCount,
   message:outcome.message,warnings:outcome.warnings
  });
  return {
   started:true,startedAt,finishedAt,result:summary,success,
   totalVehiclesSynced,failedVehicleCount,nextAutoSyncAt:success
    ?getNextScheduledSyncAt(finishedAt):getGpsRetryAt(finishedAt),
   message:outcome.message,warnings:outcome.warnings,error:outcome.error
  };
 }catch(error){
  const finishedAt=new Date();
  cycleFinishedAt=finishedAt;
  cycleFailureMessage=error.message||String(error);
  console.error('[gps-sync] synchronization cycle failed',{
   type:normalizedType,owner,message:error.message,stack:error.stack
  });
  try{
   await M.SyncLog.create({
    type:normalizedType,startedAt:attemptedAt,finishedAt,
    result:{error:cycleFailureMessage,message:cycleFailureMessage,warnings:[]},success:false,
    totalRegisteredVehicles:registeredVehicleCount,
    successfulVehicles:synchronizedVehicleCount,
    failedVehicles:Math.max(1,failedVehicleCountForLog),
    status:'Failed',
    errorDetails:[{message:cycleFailureMessage}]
   });
  }catch(logError){
   console.error('[gps-sync] Could not save failed synchronization log',{
    type,message:logError.message,stack:logError.stack
   });
  }
  throw error;
 }finally{
  if(heartbeat)clearInterval(heartbeat);
 if(normalizedType==='auto'&&lockAcquired){
  try{
   const finishedAt=cycleFinishedAt||new Date();
   const config=await M.GpsSyncConfiguration.findOne({key:GPS_SYNC_CONFIG_KEY}).select('nextExecutionAt retryAttempts').lean();
   const retriesUsed=isRetry?Number(config?.retryAttempts)||0:0;
   const retriesAfterCycle=cycleSucceeded?0:retriesUsed+1;
   const nextRetryAt=cycleSucceeded?null:getGpsRetryAt(finishedAt);
   await M.GpsSyncConfiguration.updateOne({key:GPS_SYNC_CONFIG_KEY},{$set:{
    lastExecutionAt:cycleStartedAt,
    nextExecutionAt:getNextScheduledSyncAt(finishedAt),
    nextRetryAt,
    retryAttempts:nextRetryAt?retriesAfterCycle:0,
    schedulerStatus:'running',schedulerHeartbeatAt:new Date(),
    ...(cycleSucceeded?{lastSuccessfulAt:finishedAt}:{})
   }},{upsert:true});
  }catch(error){
   console.error('[GPS sync] Could not persist scheduler state',{
    message:error.message,stack:error.stack
   });
  }
 }
  if(statusAcquired){
   try{
    const finishedAt=cycleFinishedAt||new Date();
    const finalStatus=cycleSucceeded?'Successful':'Failed';
    await M.SyncStatus.updateOne({key:SYNC_STATUS_KEY},{$set:{
     isSyncing:false,lastSyncAt:finishedAt,lastSyncType:statusType,lastSyncStatus:finalStatus,
     lastError:cycleFailureMessage,
     ...(normalizedType==='auto'?{lastAutoSyncAt:finishedAt}:{})
    }});
    await M.SyncStatus.collection.updateOne(
     {key:SYNC_STATUS_KEY},{$unset:{providerResults:''}}
    );
   }catch(error){
    console.error('[GPS sync] Could not persist final sync status',{
     type:normalizedType,message:error.message,stack:error.stack
    });
   }
  }
  if(lockAcquired){
   try{
    const released=await M.GpsSyncLock.deleteOne({key:GPS_SYNC_LOCK_KEY,owner});
    if(released.deletedCount!==1)console.warn('[GPS sync] Lock was not owned at release time',{owner,type});
   }catch(error){
    console.error('[GPS sync] Could not release distributed lock',{
     owner,type,message:error.message,stack:error.stack
    });
   }
  }
  syncing=false;
 }
}

async function updateGeofence(){
 const [active,rawLive,plants,openStays]=await Promise.all([
  M.Vehicle.find({status:'Active'}).select('vehicleNumber gpsLink gpsProviders updatedAt createdAt').lean(),
  M.VehicleLiveStatus.find({provider:'Wheelseye',stale:{$ne:true}}).lean(),
  M.Plant.find({status:'Active'}).lean(),
  M.VehiclePlantStay.find({exitTime:null}).lean()
 ]);
 const registered=new Set(groupByVehicleNumber(active.filter(vehicle=>vehicleHasProvider(vehicle,'Wheelseye'))).keys());
 const livesByVehicle=groupByVehicleNumber(rawLive.filter(record=>record.unregistered!==true));
 const staysByVehicle=groupByVehicleNumber(openStays,stay=>stay.vehicle);
 for(const [vehicleNumber,records] of livesByVehicle){
  if(!registered.has(vehicleNumber))continue;
  records.sort((a,b)=>new Date(b.gpsTime||0)-new Date(a.gpsTime||0));
  const live=records[0];
  if(!reverseGeocoding.validCoordinates(live.lat,live.lng))continue;
  let nearest=null,nearestDistance=Infinity;
  for(const plant of plants){
   const distance=haversine({lat:live.lat,lng:live.lng},{lat:plant.lat,lng:plant.lng});
   if(distance<=plant.radius&&distance<nearestDistance){nearest=plant;nearestDistance=distance}
  }
  const stays=staysByVehicle.get(vehicleNumber)||[];
  const matching=nearest
   ?stays.filter(stay=>String(stay.plant)===String(nearest._id)).sort((a,b)=>new Date(a.entryTime)-new Date(b.entryTime))
   :[];
  const keep=matching[0]||null;
  const close=stays.filter(stay=>!keep||String(stay._id)!==String(keep._id));
  for(const stay of close){
   const gpsTime=new Date(live.gpsTime||Date.now());
   const closeAt=new Date(Math.max(gpsTime.getTime(),new Date(stay.entryTime).getTime()+1));
   await setPlanExpiryAfterPlantExit(M,{
    vehicle:stay.vehicle,plant:stay.plant,exitTime:closeAt
   });
   await M.VehiclePlantStay.updateOne({_id:stay._id,exitTime:null},{$set:{exitTime:closeAt}});
  }
  if(nearest&&!keep){
   await M.VehiclePlantStay.create({
    vehicle:vehicleNumber,normalizedVehicleNumber:vehicleNumber,
    plant:nearest._id,entryTime:live.gpsTime||new Date()
   });
  }
 }
}

const {ipKeyGenerator}=rateLimit;
const loginLimiter=rateLimit({
 windowMs:15*60*1000,max:5,standardHeaders:true,legacyHeaders:false,
 keyGenerator:(req)=>`${ipKeyGenerator(req.ip)}:${String(req.body?.username||'')}`,
 handler:(_req,res)=>res.status(429).json({error:'Too many login attempts. Please wait 15 minutes before trying again.'})
});
const aiChatLimiter=rateLimit({
 windowMs:60*1000,max:20,standardHeaders:true,legacyHeaders:false,
 keyGenerator:req=>String(req.user.sub),
 handler:(req,res)=>res.status(429).json({error:'Aap ek minute mein 20 sawal pooch sakte hain. Thodi der baad dobara koshish karein.'})
});
const aiReadLimiter=rateLimit({windowMs:60*1000,max:60,standardHeaders:true,legacyHeaders:false,keyGenerator:req=>String(req.user.sub)});

app.post('/api/auth/login',loginLimiter,[body('username').trim().notEmpty(),body('password').isLength({min:1})],async(req,res)=>{
 const errors=validationResult(req);if(!errors.isEmpty())return res.status(400).json({error:'Invalid username or password'});
 const user=await M.User.findOne({username:req.body.username.toLowerCase()}).select('+passwordHash');
 if(!user||!user.active||user.lockedUntil&&user.lockedUntil>Date.now())return res.status(401).json({error:'Invalid username or password'});
 if(!await bcrypt.compare(req.body.password,user.passwordHash)){
  user.failedAttempts=(user.failedAttempts||0)+1;if(user.failedAttempts>=5){user.lockedUntil=new Date(Date.now()+30*60*1000);}await user.save();return res.status(401).json({error:'Invalid username or password'});
 }
 user.failedAttempts=0;user.lockedUntil=undefined;user.lastLogin=new Date();await user.save();
 const sessionId=crypto.randomBytes(32).toString('hex');
 await M.Session.create({sessionId,user:user._id,expiresAt:new Date(Date.now()+30*24*60*60*1000),lastSeenAt:new Date(),userAgent:req.get('user-agent')||'',ip:req.ip});
 res.cookie('accessToken',signAccess(user,sessionId),{...cookieOpts(),maxAge:30*24*60*60*1000});
 res.cookie('refreshToken',signRefresh(user,sessionId),{...cookieOpts(),maxAge:30*24*60*60*1000});
 await audit('login',user.username,{},req);
 const isAdmin=isAdminAccount(user);
 res.json({user:{fullName:user.fullName,username:user.username,isAdmin,permissions:normalizePermissions(user.permissions,isAdmin)}});
});
app.post('/api/auth/logout',auth,async(req,res)=>{
 await M.Session.updateOne({sessionId:req.user.sid},{$set:{revoked:true}});
 res.clearCookie('accessToken',cookieOpts());res.clearCookie('refreshToken',cookieOpts());
 await audit('logout',req.user.sub,{},req);res.json({ok:true});
});
app.post('/api/auth/refresh',async(req,res)=>{
 try{
  const p=jwt.verify(req.cookies.refreshToken,process.env.JWT_SECRET);
  const session=await M.Session.findOne({sessionId:p.sid,revoked:false,expiresAt:{$gt:new Date()}});
  if(!session)return res.status(401).json({error:'Unauthorized'});
  const u=await M.User.findById(p.sub);
  if(!u||!u.active)return res.status(401).json({error:'Unauthorized'});
  session.lastSeenAt=new Date();await session.save();
  res.cookie('accessToken',signAccess(u,p.sid),{...cookieOpts(),maxAge:30*24*60*60*1000});
  res.json({ok:true});
 }catch{res.status(401).json({error:'Unauthorized'});}
});
app.get('/api/auth/me',auth,async(req,res)=>{
 const u=await M.User.findById(req.user.sub);
 if(!u||!u.active)return res.status(401).json({error:'Unauthorized'});
 const isAdmin=isAdminAccount(u);
 res.json({user:{fullName:u.fullName,username:u.username,isAdmin,permissions:normalizePermissions(u.permissions,isAdmin)}});
});

app.get('/api/dashboard',auth,permission('Dashboard','view'),async(req,res)=>{
 const [snapshot,syncStatus]=await Promise.all([
  fleetSnapshotService.getOperationalSnapshot(M),
  getGpsSyncStatus().catch(error=>{
   console.error('[dashboard] GPS sync status unavailable',{
    message:error.message,stack:error.stack
   });
   return null;
  })
 ]);
 res.json({
  plants:snapshot.plants,transit:snapshot.transit,
  lastSync:syncStatus?.lastSyncAt||null,
  nextSyncAt:syncStatus?.nextAutoSyncAt||null,syncStatus,
  providers:snapshot.providers
 });
});
function allowedNumber(n){return /^[A-Z0-9]+$/.test(n)}
function _nameSafe(p){return p.name}

function syncPermission(req,res,next){
 if(hasPermission(req.user.perms,'Dashboard','edit',req.user.isAdmin)||
  hasPermission(req.user.perms,'GPS Track','edit',req.user.isAdmin))return next();
 return res.status(403).json({error:'GPS Sync permission required'});
}
app.post('/api/sync',auth,syncPermission,async(req,res)=>{
 try{
  const result=await runSync('MANUAL');
  return res.status(result.started?200:409).json(result);
 }catch(error){
  const referenceCode=`GPS-${crypto.randomInt(1000,10000)}`;
  console.error('[gps-sync] manual request failed',{
   referenceCode,message:error.message||String(error),stack:error.stack||'No stack available'
  });
  return res.status(500).json({
   error:'GPS synchronization could not be completed. Please try again.',
   referenceCode
  });
 }
});
app.get('/api/sync/status',auth,permission('Dashboard','view'),async(_req,res)=>{
 const now=new Date();
 const [status,config,lastCycle]=await Promise.all([
  M.SyncStatus.findOne({key:SYNC_STATUS_KEY}).lean(),
  M.GpsSyncConfiguration.findOne({key:GPS_SYNC_CONFIG_KEY}).lean(),
  M.SyncLog.findOne({finishedAt:{$exists:true}}).sort({finishedAt:-1}).lean()
 ]);
 const syncStartedAt=new Date(status?.syncStartedAt||0).getTime();
 const isSyncing=Boolean(status?.isSyncing&&syncStartedAt<=now.getTime()&&
  !isGpsSyncStale(status?.syncStartedAt,now));
 const schedulerActive=isGpsSchedulerHealthy(now,config);
 const lastSyncStatus=['Successful','Failed'].includes(status?.lastSyncStatus)
  ?status.lastSyncStatus:null;
 res.json({
  lastSyncAt:status?.lastSyncAt||null,lastSyncType:status?.lastSyncType||null,
  lastSyncStatus,lastError:status?.lastError||'',
  lastSyncSummary:lastCycle?.result?.syncSummary||null,
  lastAutoSyncAt:status?.lastAutoSyncAt||null,
  nextSyncAt:schedulerActive?getNextGpsExecutionAt(now,config||{},null):null,
  isSyncing,syncStartedAt:status?.syncStartedAt||null,
  schedulerStatus:schedulerActive?'Active':'Inactive',serverTime:now
 });
});

app.get('/api/vehicles',auth,permission('Vehicle Registry','view'),async(req,res)=>{
 const q={};
 if(req.query.search){
  const search=normalizeNumber(req.query.search);
  if(search)q.vehicleNumber={$regex:search,$options:'i'};
 }
 if(req.query.status)q.status=req.query.status;
 if(req.query.fleetType)q.fleetType=req.query.fleetType;
 if(req.query.provider){
  if(req.query.provider!=='Wheelseye')return res.status(400).json({error:'Invalid GPS provider'});
  q.$or=[{gpsLink:'Wheelseye'},{gpsProviders:{$elemMatch:{name:'Wheelseye'}}}];
 }
 const page=Math.max(1,+req.query.page||1),limit=Math.max(1,Math.min(100,+req.query.limit||20));
 const found=await M.Vehicle.find(q).sort({vehicleNumber:1,status:1,updatedAt:-1,createdAt:1}).lean();
 const unique=[...groupByVehicleNumber(found).values()].map(records=>records[0]);
 const total=unique.length,items=unique.slice((page-1)*limit,page*limit);
 const live=await M.VehicleLiveStatus.find({provider:'Wheelseye'}).select('vehicleNumber gpsTime').lean();
 const liveByNumber=new Map();
 for(const [vehicleNumber,records] of groupByVehicleNumber(live).entries()){
  records.sort((a,b)=>new Date(b.gpsTime||0)-new Date(a.gpsTime||0));
  liveByNumber.set(vehicleNumber,records[0]);
 }
 res.json({items:items.map(vehicle=>({
  ...vehicle,
  gpsProviderDisplay:vehicleHasProvider(vehicle,'Wheelseye')?'Wheelseye':'No GPS provider',
  lastGps:liveByNumber.get(normalizeNumber(vehicle.vehicleNumber))?.gpsTime||null
 })),total,page,pages:Math.ceil(total/limit)});
});
app.post('/api/vehicles',auth,permission('Vehicle Registry','edit'),[body('vehicleNumber').trim().notEmpty(),body('fleetType').isIn(['Own Fleet','Contract Fleet']),body('gpsLink').equals('Wheelseye'),body('status').isIn(['Active','Inactive'])],async(req,res)=>{
 if(!validationResult(req).isEmpty())return res.status(400).json({error:'Invalid vehicle details'});
 const vehicleNumber=normalizeNumber(req.body.vehicleNumber);
 const match=vehicleNumberRegex(vehicleNumber);
 if(!vehicleNumber)return res.status(400).json({error:'Enter a valid vehicle number'});
 if(await M.Vehicle.exists({vehicleNumber:match}))return res.status(409).json({error:'Duplicate vehicle number'});
 try{
  const v=await M.Vehicle.create({
   vehicleNumber,normalizedVehicleNumber:vehicleNumber,
   fleetType:req.body.fleetType,gpsLink:req.body.gpsLink,status:req.body.status,
   driver:String(req.body.driver||'').trim(),mobile:String(req.body.mobile||'').trim(),
   plant:String(req.body.plant||'').trim(),createdBy:req.user.sub,updatedBy:req.user.sub
  });
  await M.VehicleLiveStatus.updateMany({vehicleNumber:match},{$set:{unregistered:false}});
  await audit('create_vehicle',req.user.sub,{vehicleNumber},req);
  res.status(201).json(v);
 }catch(error){
  if(error.code===11000)return res.status(409).json({error:'Duplicate vehicle number'});
  throw error;
 }
});
app.put('/api/vehicles/:id',auth,permission('Vehicle Registry','edit'),async(req,res)=>{
 const allowedFields=['vehicleNumber','fleetType','gpsLink','status','driver','mobile','plant'];
 const d=Object.fromEntries(allowedFields.filter(key=>Object.prototype.hasOwnProperty.call(req.body,key)).map(key=>[key,req.body[key]]));
 if(d.gpsLink!==undefined&&d.gpsLink!=='Wheelseye')return res.status(400).json({error:'Invalid GPS provider'});
 for(const key of ['driver','mobile','plant'])if(d[key]!==undefined)d[key]=String(d[key]||'').trim();
 d.updatedBy=req.user.sub;
 if(d.vehicleNumber!==undefined){
  d.vehicleNumber=normalizeNumber(d.vehicleNumber);
  d.normalizedVehicleNumber=d.vehicleNumber;
  if(!d.vehicleNumber)return res.status(400).json({error:'Enter a valid vehicle number'});
  const duplicate=await M.Vehicle.exists({
   vehicleNumber:vehicleNumberRegex(d.vehicleNumber),_id:{$ne:req.params.id}
  });
  if(duplicate)return res.status(409).json({error:'Duplicate vehicle number'});
 }
 try{
  const v=await M.Vehicle.findByIdAndUpdate(req.params.id,d,{returnDocument:'after',runValidators:true});
  if(!v)return res.status(404).json({error:'Vehicle not found'});
  await audit('edit_vehicle',req.user.sub,{vehicleNumber:v.vehicleNumber},req);
  res.json(v);
 }catch(error){
  if(error.code===11000)return res.status(409).json({error:'Duplicate vehicle number'});
  throw error;
 }
});
app.delete('/api/vehicles/:id',auth,permission('Vehicle Registry','edit'),async(req,res)=>{const v=await M.Vehicle.findByIdAndDelete(req.params.id);if(!v)return res.status(404).json({error:'Vehicle not found'});await audit('delete_vehicle',req.user.sub,{vehicleNumber:v.vehicleNumber},req);res.json({ok:true});});
app.post('/api/vehicles/:id/sync',auth,syncPermission,async(req,res)=>{
 const vehicle=await M.Vehicle.findById(req.params.id).select('vehicleNumber status');
 if(!vehicle)return res.status(404).json({error:'Vehicle not found'});
 if(vehicle.status!=='Active')return res.status(409).json({error:'Inactive vehicles are not synchronized'});
 const result=await runSync('manual');
 return res.status(result.started?200:409).json(result);
});
app.get('/api/unregistered',auth,permission('Vehicle Registry','view'),async(req,res)=>{
 const [vehicles,records]=await Promise.all([
  M.Vehicle.find({}).select('vehicleNumber').lean(),
  M.VehicleLiveStatus.find({unregistered:true,provider:'Wheelseye'}).sort({vehicleNumber:1,gpsTime:-1}).lean()
 ]);
 const registered=new Set(groupByVehicleNumber(vehicles).keys());
 const unique=[...groupByVehicleNumber(records).entries()]
  .filter(([vehicleNumber])=>!registered.has(vehicleNumber))
  .map(([,duplicates])=>duplicates[0]).slice(0,500);
 res.json(unique);
});

app.get('/api/plants',auth,permission('Plant','view'),async(req,res)=>{
 const [plants,snapshot]=await Promise.all([
  M.Plant.find().sort({name:1}),
  fleetSnapshotService.getOperationalSnapshot(M)
 ]);
 const availability=new Map(snapshot.plants.map(plant=>[String(plant._id),plant.rows]));
 res.json(plants.map(plant=>({...plant.toObject(),vehicles:availability.get(String(plant._id))||[]})));
});
const validatePlant=()=>[
 body('plantId').trim().notEmpty().withMessage('Plant ID is required'),
 body('name').trim().notEmpty().withMessage('Plant Name is required'),
 body('address').trim().notEmpty().withMessage('Address is required'),
 body('lng').isFloat({min:-180,max:180}).withMessage('Longitude must be between -180 and 180'),
 body('lat').isFloat({min:-90,max:90}).withMessage('Latitude must be between -90 and 90'),
 body('radius').isFloat().custom(value=>Number(value)>0).withMessage('Radius must be a positive number')
];
function plantValidationError(req,res){
 const result=validationResult(req);
 if(result.isEmpty())return false;
 res.status(400).json({error:result.array()[0].msg});
 return true;
}
app.post('/api/plants',auth,permission('Plant','edit'),validatePlant(),async(req,res)=>{
 if(plantValidationError(req,res))return;
 const plantId=req.body.plantId.trim();
 if(await M.Plant.exists({plantId}))return res.status(409).json({error:'Plant ID already exists'});
 const data={plantId,name:req.body.name.trim(),address:req.body.address.trim(),lng:Number(req.body.lng),lat:Number(req.body.lat),radius:Number(req.body.radius)};
 try{
  const plant=await M.Plant.create(data);
  await audit('create_plant',req.user.sub,{plantId:plant.plantId,name:plant.name},req);
  res.status(201).json(plant);
 }catch(error){
  if(error.code===11000)return res.status(409).json({error:'Plant ID already exists'});
  throw error;
 }
});
app.put('/api/plants/:id',auth,permission('Plant','edit'),validatePlant(),async(req,res)=>{
 if(plantValidationError(req,res))return;
 const plantId=req.body.plantId.trim();
 if(await M.Plant.exists({plantId,_id:{$ne:req.params.id}}))return res.status(409).json({error:'Plant ID already exists'});
 const data={plantId,name:req.body.name.trim(),address:req.body.address.trim(),lng:Number(req.body.lng),lat:Number(req.body.lat),radius:Number(req.body.radius)};
 try{
  const plant=await M.Plant.findByIdAndUpdate(req.params.id,{$set:data},{returnDocument:'after',runValidators:true});
  if(!plant)return res.status(404).json({error:'Plant not found'});
  await audit('edit_plant',req.user.sub,{plantId:plant.plantId,name:plant.name},req);
  res.json(plant);
 }catch(error){
  if(error.code===11000)return res.status(409).json({error:'Plant ID already exists'});
  throw error;
 }
});
app.delete('/api/plants/:id',auth,permission('Plant','edit'),async(req,res)=>{
 if(req.body.confirmation!=='DELETE')return res.status(400).json({error:'Type DELETE to confirm plant deletion'});
 const inUse=await M.VehiclePlantStay.exists({plant:req.params.id});
 const planned=await M.VehiclePlan.exists({plant:req.params.id});
 if(inUse||planned)return res.status(409).json({error:'Plant cannot be deleted because it has historical stays or plans'});
 const p=await M.Plant.findByIdAndDelete(req.params.id);if(!p)return res.status(404).json({error:'Plant not found'});await audit('delete_plant',req.user.sub,{plantId:p.plantId,name:p.name},req);res.json({ok:true});
});

app.get('/api/tracking',auth,permission('GPS Track','view'),async(req,res)=>{
 const [snapshot,syncStatus]=await Promise.all([
  fleetSnapshotService.getOperationalSnapshot(M),getGpsSyncStatus()
 ]);
 res.json({
  live:snapshot.live,registeredVehicles:snapshot.registeredVehicles,
  registeredCount:snapshot.registeredCount,summary:snapshot.summary,
  providers:snapshot.providers,lastSync:snapshot.lastSync,syncStatus
 });
});
app.get('/api/tracking/vehicles/:vehicleId',auth,permission('GPS Track','view'),async(req,res)=>{
 if(!mongoose.Types.ObjectId.isValid(req.params.vehicleId))return res.status(400).json({error:'Invalid vehicle ID'});
 const vehicle=await M.Vehicle.findById(req.params.vehicleId).select('vehicleNumber status gpsLink gpsProviders').lean();
 if(!vehicle||vehicle.status!=='Active')return res.status(404).json({error:'Registered vehicle not found'});
 if(!vehicleHasProvider(vehicle,'Wheelseye'))return res.status(404).json({error:'No GPS provider is configured for this vehicle'});
 const matcher=vehicleNumberRegex(vehicle.vehicleNumber);
 const [records,syncStatus]=await Promise.all([
  M.VehicleLiveStatus.find({vehicleNumber:matcher,provider:'Wheelseye'}).sort({gpsTime:-1,syncedAt:-1}).lean(),
  getGpsSyncStatus()
 ]);
 const now=new Date();
 let record=records.find(item=>{
  const timestamp=new Date(item.gpsTime||NaN).getTime();
  return reverseGeocoding.validCoordinates(item.lat,item.lng)&&Number.isFinite(timestamp)&&timestamp<=now.getTime();
 })||records[0]||null;
 if(record){
  try{record=await resolveStoredVehicleAddress(record)}
  catch(error){console.warn(`Reverse geocoding failed for ${record.vehicleNumber}: ${error.message}`)}
 }
 const gpsTime=record?.gpsTime?new Date(record.gpsTime):null;
 const hasCoordinates=Boolean(record&&reverseGeocoding.validCoordinates(record.lat,record.lng)&&gpsTime&&
  Number.isFinite(gpsTime.getTime())&&gpsTime<=now);
 const isFresh=Boolean(hasCoordinates&&!record.stale&&gpsTime&&Number.isFinite(gpsTime.getTime())&&
  gpsTime<=now&&now.getTime()-gpsTime.getTime()<=GPS_SYNC_INTERVAL_MS*2);
 res.json({
  vehicle:{id:String(vehicle._id),vehicleNumber:vehicle.vehicleNumber},
  gps:record?{
   lat:hasCoordinates?Number(record.lat):null,
   lng:hasCoordinates?Number(record.lng):null,
   location:displayLocation(record),
   addressIsCurrent:Boolean(record.addressIsCurrent),
   street:record.street||'',plotNumber:record.plotNumber||record.houseNumber||'',
   houseNumber:record.houseNumber||record.plotNumber||'',galiNumber:record.galiNumber||'',
   road:record.road||'',building:record.building||'',sector:record.sector||'',
   nearby:record.nearby||'',nearestLocation:record.nearestLocation||'',
   nearestLocationCategory:record.nearestLocationCategory||'',
   nearestLocationDistanceMeters:record.nearestLocationDistanceMeters??null,
   nearbyProvider:record.nearbyProvider||'',geocodingProvider:record.geocodingProvider||null,
   city:record.city||'',
   cityOrVillage:record.cityOrVillage||record.city||'',district:record.district||'',
   division:record.division||'',state:record.state||'',pincode:record.pincode||'',
   country:record.country||'',
   addressDistanceKm:record.addressDistanceKm??null,
   addressEnrichmentPending:Boolean(record.addressEnrichmentPending),
   speed:record.speed??null,ignition:record.ignition??null,
   ignitionStatus:record.ignitionStatus||'UNKNOWN',
   runningStatus:record.runningStatus||'Unknown',
   gpsTime:record.gpsTime||null,
   heading:record.heading==null||record.heading===''||!Number.isFinite(Number(record.heading))?null:Number(record.heading),
   provider:record.provider||null,stale:!isFresh
  }:null,
  syncStatus:{
   status:syncStatus.status,isSyncing:syncStatus.isSyncing,
   autoSyncActive:syncStatus.autoSyncActive,nextAutoSyncAt:syncStatus.nextAutoSyncAt,
   lastSuccessfulSyncAt:syncStatus.lastSuccessfulSyncAt,serverTime:syncStatus.serverTime
  }
 });
});
app.post('/api/locations/vehicles/batch',auth,async(req,res)=>{
 if(!hasPermission(req.user.perms,'Dashboard','view',req.user.isAdmin)&&
  !hasPermission(req.user.perms,'GPS Track','view',req.user.isAdmin)){
  return res.status(403).json({error:'No access'});
 }
 const ids=req.body?.vehicleIds;
 if(!Array.isArray(ids)||ids.length>25||
  ids.some(id=>typeof id!=='string'||!mongoose.Types.ObjectId.isValid(id))){
  return res.status(400).json({error:'Invalid vehicle list'});
 }
 if(!ids.length)return res.json({items:[]});
 const vehicles=await M.Vehicle.find({
  _id:{$in:[...new Set(ids)]},status:'Active'
 }).select('_id vehicleNumber gpsLink gpsProviders').lean();
 const eligible=vehicles.filter(vehicle=>vehicleHasProvider(vehicle,'Wheelseye'));
 if(!eligible.length)return res.json({items:[]});
 const numbers=eligible.map(vehicle=>vehicleNumberRegex(vehicle.vehicleNumber));
 const liveRecords=await M.VehicleLiveStatus.find({
  vehicleNumber:{$in:numbers},provider:'Wheelseye'
 }).sort({gpsTime:-1,syncedAt:-1}).lean();
 const liveByNumber=new Map();
 for(const record of liveRecords){
  const number=normalizeNumber(record.vehicleNumber);
  if(!liveByNumber.has(number))liveByNumber.set(number,record);
 }
 const items=await Promise.all(eligible.map(async vehicle=>{
  let record=liveByNumber.get(normalizeNumber(vehicle.vehicleNumber));
  if(record&&reverseGeocoding.validCoordinates(record.lat,record.lng)){
   try{record=await resolveStoredVehicleAddress(record)}
   catch(error){
    console.warn('[Geocoding] Batched location resolution failed',{
     code:error.code||'request failed'
    });
   }
  }
  return {vehicleId:String(vehicle._id),...vehicleLocationPayload(record)};
 }));
 res.json({items});
});
app.get('/api/locations/vehicles/:vehicleId',auth,async(req,res)=>{
 if(!hasPermission(req.user.perms,'Dashboard','view',req.user.isAdmin)&&
  !hasPermission(req.user.perms,'GPS Track','view',req.user.isAdmin)){
  return res.status(403).json({error:'No access'});
 }
 if(!mongoose.Types.ObjectId.isValid(req.params.vehicleId))return res.status(400).json({error:'Invalid vehicle ID'});
 const vehicle=await M.Vehicle.findById(req.params.vehicleId).select('vehicleNumber status gpsLink gpsProviders').lean();
 if(!vehicle||vehicle.status!=='Active')return res.status(404).json({error:'Registered vehicle not found'});
 if(!vehicleHasProvider(vehicle,'Wheelseye'))return res.status(404).json({error:'No GPS provider is configured for this vehicle'});
 const matcher=vehicleNumberRegex(vehicle.vehicleNumber);
 let record=await M.VehicleLiveStatus.findOne({vehicleNumber:matcher,provider:'Wheelseye'})
  .sort({gpsTime:-1,syncedAt:-1}).lean();
 if(record){
  try{record=await resolveStoredVehicleAddress(record)}
  catch(error){console.warn(`Reverse geocoding failed for ${record.vehicleNumber}: ${error.message}`)}
 }
 res.json(vehicleLocationPayload(record));
});
app.get('/api/history/search',auth,permission('GPS Track','view'),async(req,res)=>{
 const vehicleNumber=normalizeNumber(req.query.vehicleNumber);
 const provider=String(req.query.provider||'');
 const from=new Date(String(req.query.from||''));
 const to=new Date(String(req.query.to||''));
 if(!vehicleNumber||provider!=='Wheelseye'||!Number.isFinite(from.getTime())||!Number.isFinite(to.getTime())||from>to||to>Date.now()){
  return res.status(400).json({error:'Select a valid provider, vehicle and past date range'});
 }
 const matcher=vehicleNumberRegex(vehicleNumber);
 const vehicle=await M.Vehicle.findOne({vehicleNumber:matcher,status:'Active'});
 const live=await M.VehicleLiveStatus.findOne({vehicleNumber:matcher,provider}).sort({gpsTime:-1}).lean();
 if(!vehicle||!vehicleHasProvider(vehicle,provider))return res.status(404).json({error:'Registered vehicle not found for the selected provider'});
 const rows=await M.VehicleLocationHistory.find({
  provider,gpsTime:{$gte:from,$lte:to},
  $or:[{vehicleNumber:matcher},{vehicle:matcher}]
 }).sort({gpsTime:1}).lean();
 res.json(rows.map(row=>({...row,location:displayLocation(row)})));
});
app.get('/api/history/:vehicle',auth,permission('GPS Track','view'),async(req,res)=>{
 const vehicle=normalizeNumber(req.params.vehicle);const limit=Math.min(500,+req.query.limit||200);
 const matcher=vehicleNumberRegex(vehicle);
 const rows=await M.VehicleLocationHistory.find({provider:'Wheelseye',$or:[{vehicleNumber:matcher},{vehicle:matcher}]})
  .sort({gpsTime:-1}).limit(limit).lean();
 res.json(rows.map(r=>({...r,location:displayLocation(r)})));
});

app.post('/api/plans',auth,permission('Dashboard','edit'),[body('vehicle').trim().notEmpty(),body('planType').isIn(['Loading','Unloading','Maintenance','Waiting','Other']),body('expectedDeparture').optional({checkFalsy:true}).isISO8601()],async(req,res)=>{if(!validationResult(req).isEmpty())return res.status(400).json({error:'Invalid plan'});const plan=await M.VehiclePlan.create({vehicle:req.body.vehicle,plant:req.body.plant,planType:req.body.planType,remarks:req.body.remarks,expectedDeparture:req.body.expectedDeparture,createdBy:req.user.sub,createdByUserId:req.user.sub,createdByName:req.user.fullName});await audit('create_plan',req.user.sub,{vehicle:plan.vehicle,plant:plan.plant},req);res.status(201).json(plan)});
app.put('/api/plans/:id',auth,permission('Dashboard','edit'),[
 body('planType').optional().isIn(['Loading','Unloading','Maintenance','Waiting','Other']),
 body('remarks').optional({nullable:true}).isString(),
 body('expectedDeparture').optional({checkFalsy:true}).isISO8601()
],async(req,res)=>{
 if(!mongoose.Types.ObjectId.isValid(req.params.id))return res.status(404).json({error:'Plan not found'});
 if(!validationResult(req).isEmpty())return res.status(400).json({error:'Invalid plan'});
 const updates={};
 for(const key of ['planType','remarks','expectedDeparture']){
  if(Object.prototype.hasOwnProperty.call(req.body,key))updates[key]=req.body[key];
 }
 if(!Object.keys(updates).length)return res.status(400).json({error:'No plan changes provided'});
 updates.updatedByUserId=req.user.sub;
 updates.updatedByName=req.user.fullName;
 const plan=await M.VehiclePlan.findByIdAndUpdate(req.params.id,{$set:updates},{returnDocument:'after',runValidators:true});
 if(!plan)return res.status(404).json({error:'Plan not found'});
 await audit('edit_plan',req.user.sub,{vehicle:plan.vehicle,plant:plan.plant},req);
 res.json(plan);
});
app.get('/api/plans/:vehicle',auth,permission('Dashboard','view'),async(req,res)=>{
 const filter={
  vehicle:normalizeNumber(req.params.vehicle),
  $and:[getActivePlanExpiryFilter()]
 };
 if(req.query.plant){
  if(!mongoose.Types.ObjectId.isValid(req.query.plant))return res.status(400).json({error:'Invalid plant'});
  filter.plant=req.query.plant;
 }
 const plans=await M.VehiclePlan.find(filter).sort({updatedAt:-1,createdAt:-1,_id:-1}).limit(20).lean();
 const profileIds=[...new Set(plans.flatMap(plan=>[
  plan.createdByUserId,plan.createdBy,plan.updatedByUserId
 ]).map(id=>String(id||'')).filter(id=>mongoose.Types.ObjectId.isValid(id)))];
 const profiles=profileIds.length?await M.User.find({_id:{$in:profileIds}}).select('_id fullName').lean():[];
 const profileNames=new Map(profiles.map(profile=>[String(profile._id),profile.fullName]));
 res.json(plans.map(plan=>{
  const creatorId=String(plan.createdByUserId||plan.createdBy||'');
  const updaterId=String(plan.updatedByUserId||'');
  const createdByName=plan.createdByName||profileNames.get(creatorId)||null;
  const updatedByName=plan.updatedByName||profileNames.get(updaterId)||null;
  const hasBeenUpdated=Boolean(plan.updatedByUserId||plan.updatedByName)||
   new Date(plan.updatedAt||0).getTime()>new Date(plan.createdAt||0).getTime();
  return {
   ...plan,createdByName,updatedByName,
   createdByDisplayName:hasBeenUpdated?updatedByName:createdByName
  };
 }));
});

app.get('/api/users',auth,permission('Users','view'),async(req,res)=>{
 const users=await M.User.find().sort({fullName:1}).select('-passwordHash');
 res.json(users.map(user=>({...user.toObject(),isAdmin:isAdminAccount(user),permissions:normalizePermissions(user.permissions,isAdminAccount(user))})));
});
app.post('/api/users',auth,permission('Users','edit'),[body('fullName').trim().notEmpty(),body('username').trim().notEmpty(),body('password').isLength({min:8}).matches(/[!@#$%^&*(),.?":{}|<>]/)],async(req,res)=>{if(!validationResult(req).isEmpty())return res.status(400).json({error:'Password must have 8 characters and a special character'});if(await M.User.exists({username:req.body.username.toLowerCase()}))return res.status(409).json({error:'Username already exists'});if(req.body.permissions!=null&&(typeof req.body.permissions!=='object'||Array.isArray(req.body.permissions)))return res.status(400).json({error:'Invalid permissions'});const u=await M.User.create({fullName:req.body.fullName,username:req.body.username.toLowerCase(),passwordHash:await bcrypt.hash(req.body.password,12),permissions:normalizePermissions(req.body.permissions)});await audit('create_user',req.user.sub,{username:u.username},req);res.status(201).json(u)});
app.put('/api/users/:id',auth,permission('Users','edit'),async(req,res)=>{
 const u=await M.User.findById(req.params.id);if(!u)return res.status(404).json({error:'User not found'});
 const changesPermissions=Object.prototype.hasOwnProperty.call(req.body,'permissions');
 if(changesPermissions&&(typeof req.body.permissions!=='object'||req.body.permissions===null||Array.isArray(req.body.permissions)))return res.status(400).json({error:'Invalid permissions'});
 if(changesPermissions&&String(u._id)===String(req.user.sub))return res.status(403).json({error:'You cannot change your own permissions'});
 const targetIsAdmin=isAdminAccount(u);
 if(changesPermissions&&targetIsAdmin)return res.status(403).json({error:'Administrator permissions are locked'});
 if(targetIsAdmin&&req.body.active===false)return res.status(400).json({error:'Admin cannot be deactivated'});
 if(String(u._id)===String(req.user.sub)&&req.body.active===false)return res.status(400).json({error:'You cannot deactivate your own account'});
 if(req.body.fullName)u.fullName=req.body.fullName;
 if(changesPermissions)u.permissions=normalizePermissions(req.body.permissions);
 if(typeof req.body.active==='boolean'&&!u.isAdmin)u.active=req.body.active;
 if(req.body.password&&req.body.password.length>=8)u.passwordHash=await bcrypt.hash(req.body.password,12);
 await u.save();await audit('edit_user',req.user.sub,{username:u.username},req);
 res.json({...u.toObject(),isAdmin:isAdminAccount(u),permissions:normalizePermissions(u.permissions,isAdminAccount(u))});
});
app.delete('/api/users/:id',auth,permission('Users','edit'),async(req,res)=>{
 const u=await M.User.findById(req.params.id);
 if(!u)return res.status(404).json({error:'User not found'});
 if(isAdminAccount(u))return res.status(400).json({error:'Admin cannot be deleted'});
 if(String(u._id)===String(req.user.sub))return res.status(400).json({error:'You cannot delete your own account'});
 if(req.body.confirmText!=='Delete')return res.status(400).json({error:'Type Delete to confirm user deletion'});
 await u.deleteOne();
 await M.AuditLog.create({action:'delete_user',user:req.user.sub,details:{username:u.username},ip:req.ip});
 res.json({ok:true});
});

const uploadDirectory=path.join(__dirname,'uploads');
if(process.env.VERCEL!=='1')fs.mkdirSync(uploadDirectory,{recursive:true});
const uploadStorage=process.env.VERCEL==='1'
 ?multer.memoryStorage()
 :multer.diskStorage({destination:(q,f,c)=>c(null,uploadDirectory),filename:(q,f,c)=>c(null,Date.now()+'-'+f.originalname.replace(/[^a-z0-9._-]/gi,'_'))});
const upload=multer({storage:uploadStorage,limits:{fileSize:1024*1024},fileFilter:(q,f,c)=>['image/png','image/svg+xml','image/webp'].includes(f.mimetype)?c(null,true):c(new Error('Invalid icon type'))});
app.get('/api/gps/settings',auth,permission('GPS Track','view'),async(req,res)=>{
 const [saved,providerStatuses]=await Promise.all([
  M.GpsSetting.find({provider:'Wheelseye'}).lean(),M.GpsProviderStatus.find({provider:'Wheelseye'}).lean()
 ]);
 const settingsByProvider=new Map(saved.map(setting=>[setting.provider,setting]));
 const statusesByProvider=new Map(providerStatuses.map(status=>[status.provider,status]));
 res.json(Object.entries(GPS_PROVIDER_DEFAULTS).map(([provider,defaults])=>{
  const setting=settingsByProvider.get(provider);
  const status=statusesByProvider.get(provider);
  return {
   provider,enabled:setting?.enabled!==false,
   baseUrl:setting?.baseUrl||defaultProviderUrl(provider),
   credentialsReference:defaults.credentialsReference,
   lastSyncStatus:setting?.lastSyncStatus||status?.status||'Disconnected',
   lastSyncError:setting?.lastSyncError||status?.lastErrorMessage||'',
   lastSyncedAt:setting?.lastSyncedAt||status?.lastSuccessTime||null
  };
 }));
});
app.put('/api/gps/settings/:provider',auth,permission('GPS Track','edit'),async(req,res)=>{
 const provider=req.params.provider;
 if(!Object.prototype.hasOwnProperty.call(GPS_PROVIDER_DEFAULTS,provider))return res.status(404).json({error:'GPS provider not found'});
 if(typeof req.body.enabled!=='boolean')return res.status(400).json({error:'Provider enabled must be true or false'});
 const baseUrl=validateProviderUrl(provider,req.body.baseUrl);
 if(!baseUrl)return res.status(400).json({error:'Enter a valid HTTPS URL for this GPS provider without credentials or secret query parameters'});
 const setting=await M.GpsSetting.findOneAndUpdate({provider},{$set:{
  enabled:req.body.enabled,baseUrl,credentialsReference:GPS_PROVIDER_DEFAULTS[provider].credentialsReference
 }},{upsert:true,returnDocument:'after',runValidators:true});
 await audit('edit_gps_provider_settings',req.user.sub,{provider,enabled:setting.enabled},req);
 res.json({
  provider:setting.provider,enabled:setting.enabled,baseUrl:setting.baseUrl,
  credentialsReference:setting.credentialsReference,lastSyncStatus:setting.lastSyncStatus,
  lastSyncError:setting.lastSyncError,lastSyncedAt:setting.lastSyncedAt
 });
});
app.post('/api/settings/icons',auth,permission('GPS Track','edit'),upload.fields([{name:'running',maxCount:1},{name:'stopped',maxCount:1}]),async(req,res)=>{
 for(const key of ['running','stopped'])if(req.files[key]){
  const file=req.files[key][0];
  const value=file.buffer
   ?`data:${file.mimetype};base64,${file.buffer.toString('base64')}`
   :'/uploads/'+file.filename;
  await M.AppSetting.findOneAndUpdate({key:`${key}Icon`},{$set:{value}}, {upsert:true});
 }
 await audit('edit_icons',req.user.sub,{},req);res.json(await M.AppSetting.find({key:/Icon$/}));
});
app.get('/api/settings',auth,permission('GPS Track','view'),(req,res)=>M.AppSetting.find().then(x=>res.json(Object.fromEntries(x.map(v=>[v.key,v.value])))));

async function createLocationShare(vehicleNumber,userId){
 const token=crypto.randomBytes(24).toString('hex');
 const link=await M.ShareLink.create({
  vehicleNumber,token,expiresAt:new Date(Date.now()+24*60*60*1000),createdBy:userId
 });
 return {url:`/share/${link.token}`,token,expiresAt:link.expiresAt};
}
app.post('/api/share',auth,permission('GPS Track','edit'),async(req,res)=>{
 const vehicleNumber=normalizeNumber(req.body.vehicleNumber);
 if(!await M.VehicleLiveStatus.exists({vehicleNumber,provider:'Wheelseye'}))return res.status(404).json({error:'Vehicle not found'});
 res.status(201).json(await createLocationShare(vehicleNumber,req.user.sub));
});
app.post('/api/tracking/vehicles/:vehicleId/share',auth,permission('GPS Track','edit'),async(req,res)=>{
 if(!mongoose.Types.ObjectId.isValid(req.params.vehicleId))return res.status(400).json({error:'Invalid vehicle ID'});
 const vehicle=await M.Vehicle.findById(req.params.vehicleId).select('vehicleNumber status').lean();
 if(!vehicle||vehicle.status!=='Active')return res.status(404).json({error:'Registered vehicle not found'});
 const vehicleMatcher=vehicleNumberRegex(vehicle.vehicleNumber);
 const records=await M.VehicleLiveStatus.find({vehicleNumber:vehicleMatcher,provider:'Wheelseye'}).sort({gpsTime:-1,syncedAt:-1}).select('lat lng').lean();
 if(!records.some(record=>reverseGeocoding.validCoordinates(record.lat,record.lng)))return res.status(404).json({error:'GPS coordinates are unavailable'});
 res.status(201).json(await createLocationShare(vehicle.vehicleNumber,req.user.sub));
});
app.post('/api/share/:token/revoke',auth,permission('GPS Track','edit'),async(req,res)=>{await M.ShareLink.findOneAndUpdate({token:req.params.token},{$set:{revoked:true}});res.json({ok:true})});
app.get('/share/:token',async(req,res)=>{const l=await M.ShareLink.findOne({token:req.params.token,revoked:false,expiresAt:{$gt:new Date()}});if(!l)return res.status(404).send('This location link is invalid or expired');const live=await M.VehicleLiveStatus.findOne({vehicleNumber:l.vehicleNumber,provider:'Wheelseye'});const speed=live?.speed==null?'N/A':String(live.speed);const location=live?displayLocation(live):'No data';const map=live&&reverseGeocoding.validCoordinates(live.lat,live.lng)?`<a href="https://www.google.com/maps?q=${live.lat},${live.lng}" target="_blank" rel="noreferrer">Open map</a>`:'';res.type('html').send(`<!doctype html><html><head><meta name="viewport" content="width=device-width"><title>${l.vehicleNumber} - Sikka Fleet</title></head><body style="margin:0;font-family:Arial;background:#eef2ff"><h2 style="padding:16px;margin:0">${l.vehicleNumber}</h2><div style="padding:16px"><b>Location:</b> ${location} ${map}<br><b>GPS time:</b> ${live?.gpsTime?.toLocaleString('en-IN')||'No data'}<br><b>Speed:</b> ${speed}<br><b>IGN:</b> ${live?.ignition==null?'N/A':String(live.ignition)}${live?.stale?'<br><b>GPS data:</b> Stale':''}</div></body></html>`)});

function escapeRegex(value){return value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');}
app.post('/api/ai/chat',auth,permission('Sikka AI','view'),aiChatLimiter,
 ...aiChatRequestValidators,
 async(req,res)=>{
  const validationError=getAiChatValidationError(req);
  if(validationError)return res.status(400).json({error:validationError});
  const question=sikkaAiService.cleanChatQuestion(req.body.message);
  if(!question.trim())return res.status(400).json({error:'Sawal khaali nahi ho sakta.'});
  const containsSensitiveInput=sikkaAiService.containsSensitiveInput(question);
  const savedQuestion=containsSensitiveInput?'[Sensitive content omitted]':question;
  const sessionId=String(req.body.sessionId||'').trim()||crypto.randomUUID();
  const askedAt=new Date();
  let answer;
  let queryFailed=false;
  let referenceCode=null;
  let responseLanguage=sikkaAiService.detectLanguage(question);
  try{
   const previousChat=await M.SikkaAiChat.findOne({
    userId:req.user.sub,sessionId,expireAt:{$gt:askedAt}
   }).sort({askedAt:-1}).select('language').lean();
   const authorizedPages={
    dashboard:hasPermission(req.user.perms,'Dashboard','view',req.user.isAdmin),
    plant:hasPermission(req.user.perms,'Plant','view',req.user.isAdmin),
    vehicleRegistry:hasPermission(req.user.perms,'Vehicle Registry','view',req.user.isAdmin),
    gpsTrack:hasPermission(req.user.perms,'GPS Track','view',req.user.isAdmin)
   };
   const language=sikkaAiService.detectLanguage(question,previousChat?.language);
   responseLanguage=language;
   answer=containsSensitiveInput
    ?{type:'text',language,text:language==='hi'
     ?'कृपया पासवर्ड, टोकन या API key चैट में साझा न करें। संवेदनशील टेक्स्ट हिस्ट्री में सेव नहीं किया गया।'
     :'Please do not share passwords, tokens, or API keys in chat. Sensitive text was not saved to chat history.'}
    :await sikkaAiService.answerQuestion(question,{
     models:M,now:askedAt,previousLanguage:previousChat?.language,permissions:authorizedPages,
     resolveLocation:async record=>{
      try{return await resolveStoredVehicleAddress(record)}
      catch(error){
       console.warn(`Reverse geocoding failed for ${record.vehicleNumber}: ${error.message}`);
       return record;
      }
     }
    });
  }
  catch(error){
    queryFailed=true;
    referenceCode=`SAI-${crypto.randomInt(1000,10000)}`;
    console.error('[Sikka AI] answer generation failed', {
     referenceCode,userId:String(req.user.sub),message:error?.message||String(error),stack:error?.stack||'No stack available'
    });
    answer={type:'text',language:responseLanguage,text:responseLanguage==='hi'
     ?`कुछ गड़बड़ हुई। Reference: ${referenceCode}. Sikka AI अभी डेटाबेस से डेटा नहीं पढ़ पा रहा; कृपया थोड़ी देर बाद कोशिश करें।`
     :`Something went wrong. Reference: ${referenceCode}. Sikka AI could not read fleet data right now; please try again shortly.`};
  }
  if(!answer||typeof answer.text!=='string'||!answer.text.trim()){
    queryFailed=true;
    referenceCode=referenceCode||`SAI-${crypto.randomInt(1000,10000)}`;
    console.error('[Sikka AI] answer generation returned an empty reply', {referenceCode,userId:String(req.user.sub)});
    answer={type:'text',language:responseLanguage,text:responseLanguage==='hi'
     ?`कुछ गड़बड़ हुई। Reference: ${referenceCode}. Sikka AI को वैध जवाब नहीं मिला; कृपया फिर कोशिश करें।`
     :`Something went wrong. Reference: ${referenceCode}. Sikka AI could not prepare a valid answer; please try again.`};
  }
  const answeredAt=new Date();
  const responseData={
   ...answer,userFullName:req.user.fullName,sessionId,askedAt,answeredAt,
   ...(referenceCode?{referenceCode}:{}),historySaved:true
  };
  try{
   await M.SikkaAiChat.create({
    userId:req.user.sub,username:req.user.username,userFullName:req.user.fullName,fullName:req.user.fullName,
    role:isAdminAccount(req.user)?'admin':'user',sessionId,question:savedQuestion,answer,
    askedAt,answeredAt,language:answer.language||'en',createdAt:askedAt,
    expireAt:sikkaAiService.getChatExpiry(askedAt)
   });
    return res.status(queryFailed?503:200).json(responseData);
  }catch(error){
    const historyReferenceCode=`SAI-${crypto.randomInt(1000,10000)}`;
    console.error('[Sikka AI] chat history save failed', {
     referenceCode:historyReferenceCode,userId:String(req.user.sub),
     message:error?.message||String(error),stack:error?.stack||'No stack available'
    });
    return res.status(queryFailed?503:200).json({
     ...responseData,historySaved:false,
     historyError:`Chat history save nahi hui. Reference: ${historyReferenceCode}.`
    });
  }
 });

app.get('/api/ai/latest',auth,permission('Sikka AI','view'),async(req,res)=>{
 const now=new Date();
 const filter={userId:req.user.sub,expireAt:{$gt:now},createdAt:{$gte:new Date(now.getTime()-7*24*60*60*1000),$lte:now}};
 const latest=await M.SikkaAiChat.findOne(filter).sort({createdAt:-1}).select('sessionId').lean();
 if(!latest)return res.json({sessionId:null,items:[]});
 const items=await M.SikkaAiChat.find({...filter,sessionId:latest.sessionId})
  .select('username userFullName fullName role sessionId question answer askedAt answeredAt language createdAt')
  .sort({askedAt:1,createdAt:1}).limit(100).lean();
 res.json({sessionId:latest.sessionId,items});
});

app.get('/api/ai/history',auth,permission('Sikka AI','view'),async(req,res)=>{
 const now=new Date(),limit=Math.max(1,Math.min(50,Number(req.query.limit)||20));
 const page=Math.max(1,Number(req.query.page)||1);
 const search=String(req.query.search||'').trim().slice(0,100);
 const filter={userId:req.user.sub,expireAt:{$gt:now},createdAt:{$gte:new Date(now.getTime()-7*24*60*60*1000),$lte:now}};
 if(search){
  const regex=new RegExp(escapeRegex(search),'i');
  filter.$or=[{question:regex},{'answer.text':regex}];
 }
 const [items,total]=await Promise.all([
  M.SikkaAiChat.find(filter).select('username userFullName fullName role sessionId question answer askedAt answeredAt language createdAt').sort({createdAt:-1}).skip((page-1)*limit).limit(limit).lean(),
  M.SikkaAiChat.countDocuments(filter)
 ]);
 res.json({items,total,page,limit,pages:Math.ceil(total/limit)});
});

app.get('/api/ai/history/records',auth,permission('Sikka AI','view'),permission('GPS Track','view'),aiReadLimiter,async(req,res)=>{
 const vehicleNumber=normalizeNumber(req.query.vehicleNumber);
 const allVehicles=req.query.allVehicles==='true';
 const from=new Date(String(req.query.from||''));
 const to=new Date(String(req.query.to||''));
 const now=new Date();
 const offset=Number(req.query.offset??0);
 const limit=Math.max(1,Math.min(20,Number(req.query.limit)||20));
 if((!allVehicles&&vehicleNumber.length<7)||!Number.isFinite(from.getTime())||!Number.isFinite(to.getTime())||
  !Number.isInteger(offset)||offset<0||offset>50000||from>to){
  return res.status(400).json({error:'Invalid history range'});
 }
 if(to>now)return res.status(400).json({error:sikkaAiService.FUTURE_HISTORY_REPLY});
 const cutoff=sikkaAiService.getHistoryCutoff(now);
 if(from<cutoff)return res.status(400).json({error:sikkaAiService.HISTORY_LIMIT_REPLY});
 let filter;
 if(allVehicles){
  const registered=await M.Vehicle.find({status:'Active'})
   .select('vehicleNumber gpsLink gpsProviders').lean();
  const vehicleNumbers=[...new Set(registered
   .filter(sikkaAiService.hasGpsConfiguration)
   .map(vehicle=>normalizeNumber(vehicle.vehicleNumber))
   .filter(Boolean))];
  if(!vehicleNumbers.length)return res.json({rows:[],total:0,offset,limit});
  filter={
   $or:[{vehicleNumber:{$in:vehicleNumbers}},{vehicle:{$in:vehicleNumbers}}],
   provider:'Wheelseye',
   gpsTime:{$gte:from,$lte:to}
  };
 }else{
  const matcher=vehicleNumberRegex(vehicleNumber);
  if(!await M.Vehicle.exists({vehicleNumber:matcher,status:'Active'})){
   return res.status(404).json({error:'Vehicle number was not found in the active registry.'});
  }
  filter={$or:[{vehicleNumber:matcher},{vehicle:matcher}],provider:'Wheelseye',gpsTime:{$gte:from,$lte:to}};
 }
 const [records,total]=await Promise.all([
  M.VehicleLocationHistory.find(filter).sort({gpsTime:1}).skip(offset).limit(limit).lean(),
  M.VehicleLocationHistory.countDocuments(filter)
 ]);
 res.json({rows:records.map(sikkaAiService.mapHistoryRecord),total,offset,limit});
});

app.get('/api/ai/admin/chats',auth,permission('Sikka AI','view'),requireAdmin,async(req,res)=>{
 const now=new Date(),sevenDaysAgo=new Date(now.getTime()-7*24*60*60*1000);
 const limit=Math.max(1,Math.min(50,Number(req.query.limit)||20));
 const page=Math.max(1,Number(req.query.page)||1);
 const filter={expireAt:{$gt:now},createdAt:{$gte:sevenDaysAgo,$lte:now}};
 const username=String(req.query.username||'').trim().slice(0,100);
 const search=String(req.query.search||'').trim().slice(0,100);
 const from=String(req.query.from||'').trim();
 const to=String(req.query.to||'').trim();
 if(username)filter.username=username;
 if(from){
  const start=sikkaAiService.parseAdminDate(from);
  if(!start||start>now)return res.status(400).json({error:'Invalid or future start date'});
  filter.createdAt.$gte=new Date(Math.max(filter.createdAt.$gte.getTime(),start.getTime()));
 }
 if(to){
  const end=sikkaAiService.parseAdminDate(to,true);
  if(!end)return res.status(400).json({error:'Invalid end date'});
  filter.createdAt.$lte=new Date(Math.min(filter.createdAt.$lte.getTime(),end.getTime(),now.getTime()));
 }
 if(filter.createdAt.$gte>filter.createdAt.$lte)return res.status(400).json({error:'Start date must be on or before end date'});
 if(search){
  const regex=new RegExp(escapeRegex(search),'i');
  filter.$or=[{question:regex},{'answer.text':regex},{username:regex},{fullName:regex},{userFullName:regex}];
 }
 const [items,total,usernames]=await Promise.all([
  M.SikkaAiChat.find(filter).select('username userFullName fullName role sessionId question answer askedAt answeredAt language createdAt').sort({createdAt:-1}).skip((page-1)*limit).limit(limit).lean(),
  M.SikkaAiChat.countDocuments(filter),
  M.SikkaAiChat.distinct('username',{expireAt:{$gt:now},createdAt:{$gte:sevenDaysAgo,$lte:now}})
 ]);
 res.json({items,total,page,limit,pages:Math.ceil(total/limit),usernames:usernames.sort((a,b)=>a.localeCompare(b))});
});

function startDailyJobs(){
 cron.schedule('0 0 * * *',async()=>{
  try{
   const result=await M.SikkaAiChat.deleteMany({expireAt:{$lte:new Date()}});
   if(result.deletedCount)console.info(`Sikka AI daily cleanup removed ${result.deletedCount} expired chat(s).`);
  }catch(error){console.error('Sikka AI daily chat cleanup failed:',error)}
 },{timezone:'Asia/Kolkata'});
 cron.schedule('0 2 * * *',()=>historyRetention.cleanupHistory(M),{timezone:'Asia/Kolkata'});
}

app.post('/api/internal/gps-sync',async(req,res,next)=>{
 const configuredSecret=String(process.env.GPS_SYNC_SCHEDULER_SECRET||'');
 if(configuredSecret.length<32){
  return res.status(503).json({error:'GPS scheduler authentication is not configured'});
 }
 const authorization=String(req.get('authorization')||'');
 const match=authorization.match(/^Bearer\s+(.+)$/i);
 if(!match||!isGpsSchedulerSecretValid(match[1],configuredSecret)){
  return res.status(401).json({error:'Unauthorized'});
 }
 try{
  const result=await executeExternalGpsSync();
  return res.json({ok:true,...result});
 }catch(error){
  return next(error);
 }
});

app.use('/api',(req,res)=>res.status(404).json({error:'API endpoint not found'}));
app.use('/api',(error,req,res,next)=>{
 const isSikkaAi=req.originalUrl.startsWith('/api/ai/');
 const referenceCode=isSikkaAi?`SAI-${crypto.randomInt(1000,10000)}`:null;
 console.error(`[${isSikkaAi?'Sikka AI':'API'}] request failed`,{
  method:req.method,path:req.path,...(referenceCode?{referenceCode}:{}),
  message:error?.message||String(error),stack:error?.stack||'No stack available'
 });
 if(res.headersSent)return next(error);
 const status=Number(error.statusCode||error.status)||500;
 const language=isSikkaAi?sikkaAiService.detectLanguage(req.body?.message):'en';
 const message=isSikkaAi
  ?language==='hi'
   ?`कुछ गड़बड़ हुई। Reference: ${referenceCode}. Sikka AI अनुरोध अभी पूरा नहीं हो सका।`
   :`Something went wrong. Reference: ${referenceCode}. The Sikka AI request could not be completed.`
  :'Request complete nahi ho saki.';
 return res.status(status>=400?status:500).json({error:message,...(referenceCode?{referenceCode}:{})});
});

function scheduleGpsSyncWake(at){
 if(!syncScheduler?.enabled)return;
 clearTimeout(syncScheduler.wakeTimer);
 const waitMs=Math.max(0,new Date(at).getTime()-Date.now());
 syncScheduler.wakeTimer=setTimeout(()=>{
  syncScheduler.wakeTimer=null;
  executeDueGpsSync();
 },waitMs);
 syncScheduler.wakeTimer.unref?.();
}

async function executeExternalGpsSync(){
 const now=new Date();
 let config=await M.GpsSyncConfiguration.findOneAndUpdate(
  {key:GPS_SYNC_CONFIG_KEY},
  {$setOnInsert:{enabled:true,intervalMinutes:30,schedulerStatus:'starting'}},
  {upsert:true,returnDocument:'after'}
 ).lean();
 if(config.enabled===false){
  await M.GpsSyncConfiguration.updateOne({key:GPS_SYNC_CONFIG_KEY},{$set:{
   schedulerStatus:'disabled',schedulerHeartbeatAt:null
  }});
  return {executed:false,schedulerStatus:'disabled',nextAutoSyncAt:null};
 }
 if(config.schedulerMode!=='external'&&isGpsSchedulerHealthy(now,config)){
  return {
   executed:false,schedulerMode:config.schedulerMode||'persistent',
   reason:'A healthy persistent scheduler already owns automatic GPS synchronization'
  };
 }
 const latestAutoSync=config.nextExecutionAt?null:await M.SyncLog.findOne({
  type:'auto',finishedAt:{$exists:true}
 }).sort({finishedAt:-1}).lean();
 const scheduledAt=config.nextExecutionAt||getNextAutoSyncAt(now,latestAutoSync);
 await M.GpsSyncConfiguration.updateOne({key:GPS_SYNC_CONFIG_KEY},{$set:{
  intervalMinutes:30,nextExecutionAt:scheduledAt,
  schedulerStatus:'running',schedulerMode:'external',schedulerHeartbeatAt:now
 }},{upsert:true});
 config={...config,nextExecutionAt:scheduledAt,schedulerStatus:'running',schedulerMode:'external',schedulerHeartbeatAt:now};
 const nextAt=getNextGpsExecutionAt(now,config,latestAutoSync);
 if(nextAt.getTime()>now.getTime()){
  return {executed:false,schedulerMode:'external',nextAutoSyncAt:nextAt};
 }
 const retryTime=config.nextRetryAt?new Date(config.nextRetryAt).getTime():NaN;
 const scheduledTime=config.nextExecutionAt?new Date(config.nextExecutionAt).getTime():NaN;
 const isRetry=Number.isFinite(retryTime)&&retryTime<=now.getTime()&&
  (!Number.isFinite(scheduledTime)||scheduledTime>now.getTime()&&retryTime<scheduledTime);
 const result=await runSync('auto',{retry:isRetry});
 if(!result.started){
  const activeLock=await M.GpsSyncLock.findOne({
   key:GPS_SYNC_LOCK_KEY,lockUntil:{$gt:new Date()}
  }).lean();
  if(activeLock?.type!=='auto'){
   await M.GpsSyncConfiguration.updateOne({key:GPS_SYNC_CONFIG_KEY},{$set:{
    nextRetryAt:new Date(Date.now()+GPS_SYNC_RETRY_MS),retryAttempts:0,
    schedulerStatus:'running',schedulerMode:'external',schedulerHeartbeatAt:new Date()
   }});
  }
 }
 return {
  executed:result.started,schedulerMode:'external',
  ...result
 };
}

async function executeDueGpsSync(){
 if(!syncScheduler?.enabled)return;
 try{
  const config=await M.GpsSyncConfiguration.findOne({key:GPS_SYNC_CONFIG_KEY}).lean();
  if(config?.enabled===false){
   syncScheduler.enabled=false;
   syncScheduler.cronTask?.stop();
   clearInterval(syncScheduler.heartbeat);
   clearTimeout(syncScheduler.wakeTimer);
   await M.GpsSyncConfiguration.updateOne({key:GPS_SYNC_CONFIG_KEY},{$set:{
    schedulerStatus:'disabled',schedulerHeartbeatAt:null
   }});
   return;
  }
  const now=new Date();
  const nextAt=getNextGpsExecutionAt(now,config||{});
  syncScheduler.nextAt=nextAt;
  if(nextAt.getTime()>now.getTime()){
   if(config?.nextRetryAt&&new Date(config.nextRetryAt).getTime()<=nextAt.getTime()){
    scheduleGpsSyncWake(config.nextRetryAt);
   }else{
    scheduleGpsSyncWake(nextAt);
   }
   return;
  }
  const retryTime=config?.nextRetryAt?new Date(config.nextRetryAt).getTime():NaN;
  const scheduledTime=config?.nextExecutionAt?new Date(config.nextExecutionAt).getTime():NaN;
  const isRetry=Number.isFinite(retryTime)&&retryTime<=now.getTime()&&
   (!Number.isFinite(scheduledTime)||scheduledTime>now.getTime()&&retryTime<scheduledTime);
  const result=await runSync('auto',{retry:isRetry});
  console.info('[GPS sync] Automatic cycle finished',{
   started:result.started,success:result.success,
   totalVehiclesSynced:result.totalVehiclesSynced,failedVehicleCount:result.failedVehicleCount,
  });
  if(!result.started){
   const retryAt=new Date(Date.now()+GPS_SYNC_RETRY_MS);
   const activeLock=await M.GpsSyncLock.findOne({
    key:GPS_SYNC_LOCK_KEY,lockUntil:{$gt:new Date()}
   }).lean();
   if(activeLock?.type!=='auto'){
    await M.GpsSyncConfiguration.updateOne({key:GPS_SYNC_CONFIG_KEY},{$set:{
     nextExecutionAt:getNextScheduledSyncAt(retryAt),nextRetryAt:retryAt,
     retryAttempts:0,schedulerStatus:'running',schedulerHeartbeatAt:new Date()
    }},{upsert:true});
   }
   scheduleGpsSyncWake(retryAt);
   return;
  }
  const updatedConfig=await M.GpsSyncConfiguration.findOne({key:GPS_SYNC_CONFIG_KEY}).lean();
  syncScheduler.nextAt=getNextGpsExecutionAt(new Date(),updatedConfig);
  if(updatedConfig?.nextRetryAt)scheduleGpsSyncWake(updatedConfig.nextRetryAt);
  else{
   scheduleGpsSyncWake(syncScheduler.nextAt);
  }
 }catch(error){
  console.error('[GPS sync] Automatic cycle failed',{
   message:error.message,stack:error.stack
  });
  const retryAt=new Date(Date.now()+GPS_SYNC_RETRY_MS);
  try{
   const config=await M.GpsSyncConfiguration.findOne({key:GPS_SYNC_CONFIG_KEY}).lean();
   const nextRetryAt=config?.nextRetryAt||retryAt;
   await M.GpsSyncConfiguration.updateOne({key:GPS_SYNC_CONFIG_KEY},{$set:{
    nextExecutionAt:config?.nextExecutionAt||getNextScheduledSyncAt(nextRetryAt),
    nextRetryAt,schedulerStatus:'running',schedulerHeartbeatAt:new Date()
   }},{upsert:true});
   scheduleGpsSyncWake(nextRetryAt);
  }catch(stateError){
   console.error('[GPS sync] Could not persist retry schedule',{
    message:stateError.message,stack:stateError.stack
   });
   scheduleGpsSyncWake(retryAt);
  }
 }
}

async function startGpsSyncScheduler(){
 if(syncScheduler)return;
 const config=await M.GpsSyncConfiguration.findOneAndUpdate(
  {key:GPS_SYNC_CONFIG_KEY},
  {$setOnInsert:{enabled:true,intervalMinutes:30,schedulerStatus:'starting'}},
  {upsert:true,returnDocument:'after'}
 ).lean();
 if(config.enabled===false){
  syncScheduler={timer:null,nextAt:null,enabled:false,heartbeat:null};
  await M.GpsSyncConfiguration.updateOne({key:GPS_SYNC_CONFIG_KEY},{$set:{
   schedulerStatus:'disabled',schedulerHeartbeatAt:null
  }});
  console.info('[GPS sync] Backend scheduler is disabled by persistent configuration');
  return;
 }
 const latestAutoSync=await M.SyncLog.findOne({
  type:'auto',finishedAt:{$exists:true}
 }).sort({finishedAt:-1}).lean();
 const now=new Date();
 const scheduledAt=config.nextExecutionAt||getNextAutoSyncAt(now,latestAutoSync);
 const nextSyncAt=getNextGpsExecutionAt(now,{...config,nextExecutionAt:scheduledAt},latestAutoSync);
 syncScheduler={wakeTimer:null,nextAt:nextSyncAt,enabled:true,heartbeat:null,cronTask:null};
 await M.GpsSyncConfiguration.updateOne({key:GPS_SYNC_CONFIG_KEY},{$set:{
  intervalMinutes:30,nextExecutionAt:scheduledAt,
  schedulerStatus:'running',schedulerMode:'persistent',schedulerHeartbeatAt:now
 }});
 syncScheduler.cronTask=cron.schedule('*/30 * * * *',executeDueGpsSync,{timezone:'UTC'});
 syncScheduler.heartbeat=setInterval(async()=>{
  try{
   let cronStatus=syncScheduler.cronTask?.getStatus();
   if(cronStatus==='stopped'){
    console.error('[GPS sync] Scheduler cron task stopped unexpectedly; restarting it');
    await syncScheduler.cronTask.start();
    cronStatus=syncScheduler.cronTask.getStatus();
   }else if(cronStatus==='destroyed'||!syncScheduler.cronTask){
    console.error('[GPS sync] Scheduler cron task is unavailable; recreating it');
    syncScheduler.cronTask=cron.schedule('*/30 * * * *',executeDueGpsSync,{timezone:'UTC'});
    cronStatus=syncScheduler.cronTask.getStatus();
   }
   if(!['idle','running'].includes(cronStatus)){
    throw new Error(`Scheduler cron task is unhealthy (${cronStatus||'unknown'} state)`);
   }
   await M.GpsSyncConfiguration.updateOne({key:GPS_SYNC_CONFIG_KEY},{$set:{
    schedulerStatus:'running',schedulerHeartbeatAt:new Date()
   }});
  }catch(error){
   console.error('[GPS sync] Scheduler heartbeat update failed',{
    message:error.message,stack:error.stack
   });
   try{
    await M.GpsSyncConfiguration.updateOne({key:GPS_SYNC_CONFIG_KEY},{$set:{
     schedulerStatus:'error',schedulerHeartbeatAt:null
    }});
   }catch(stateError){
    console.error('[GPS sync] Could not persist unhealthy scheduler state',{
     message:stateError.message,stack:stateError.stack
    });
   }
  }
 },GPS_SYNC_HEARTBEAT_MS);
 syncScheduler.heartbeat.unref?.();
 scheduleGpsSyncWake(nextSyncAt);
 console.info('[GPS sync] Backend scheduler active; next cycle at',syncScheduler.nextAt.toISOString());
}

async function start(){
 const missing=[];
 if(!String(process.env.MONGO_URI||process.env.MONGODB_URI||'').trim())missing.push('MONGO_URI or MONGODB_URI');
 for(const name of ['JWT_SECRET','ADMIN_USERNAME','ADMIN_PASSWORD']){
  if(!String(process.env[name]||'').trim())missing.push(name);
 }
 if(missing.length){
  console.warn(`[startup] Missing environment variables: ${missing.join(', ')}`);
 }
 try{
  await ensureInitialized();
  if(!process.env.VERCEL){
   startDailyJobs();
   await startGpsSyncScheduler();
  }
  const dist=path.join(__dirname,'../frontend/dist');
  if(process.env.NODE_ENV==='production'&&fs.existsSync(dist)){
   app.use(express.static(dist));
   app.use((req,res,next)=>{if(req.method==='GET'&&!req.path.startsWith('/api/')&&!req.path.startsWith('/share/'))return res.sendFile(path.join(dist,'index.html'));return next();});
  }
  const port=Number(process.env.PORT)||5000;
  app.listen(port,'0.0.0.0',()=>console.log(`SIKKA FLEET API running on 0.0.0.0:${port}`));
 }catch(e){console.error('Failed to start:',e.message);}
}

if(require.main===module){
 start();
}

module.exports=app;
