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
const path=require('path');
const fs=require('fs');
const M=require('./models');
const {normalizePermissions,hasPermission}=require('./permissions');
const reverseGeocoding=require('./services/reverseGeocodingService');
const wheelseyeService=require('./services/wheelseyeService');
const fleetxService=require('./services/fleetxService');
const fleetSnapshotService=require('./services/fleetSnapshotService');
const sikkaAiService=require('./services/sikkaAiService');
const historyRetention=require('./jobs/historyRetention');
const {
 normalizeVehicleNumber:normalizeNumber,groupByVehicleNumber,vehicleNumberRegex
}=require('./services/vehicleIdentity');

const app=express();
app.set('trust proxy',1);
app.use(helmet({crossOriginResourcePolicy:false}));
app.use(cors({origin:['https://fleet.sikkaind.com','http://localhost:5173'],credentials:true}));
app.use(express.json({limit:'1mb'}));
app.use(cookieParser());
app.get('/api/health',(_req,res)=>res.json({ok:true}));
app.use('/uploads',express.static(path.join(__dirname,'uploads')));

const isCoordinateText=value=>typeof value==='string'&&/^\s*-?\d+(?:\.\d+)?\s*,\s*-?\d+(?:\.\d+)?\s*$/.test(value);
const readableAddress=record=>{
 const value=record?.readableLocation||record?.address;
 return typeof value==='string'&&value.trim()&&!isCoordinateText(value)?value.trim():null;
};
const haversine=(a,b)=>{const R=6371000,toRad=x=>x*Math.PI/180;const dLat=toRad(b.lat-a.lat),dLng=toRad(b.lng-a.lng);const x=Math.sin(dLat/2)**2+Math.cos(toRad(a.lat))*Math.cos(toRad(b.lat))*Math.sin(dLng/2)**2;return R*2*Math.atan2(Math.sqrt(x),Math.sqrt(1-x));};
const GPS_SYNC_LOCK_KEY='gps-sync';
const GPS_SYNC_LOCK_TTL_MS=90000;
const GPS_SYNC_LOCK_RENEW_MS=20000;
let syncing=false,syncScheduler=null;

const ADMIN_USERNAME=String(process.env.ADMIN_USERNAME||'').trim().toLowerCase();
function isAdminAccount(user){return Boolean(user?.isAdmin||user?.username?.toLowerCase()===ADMIN_USERNAME);}
function signAccess(user,sessionId){const isAdmin=isAdminAccount(user);return jwt.sign({sub:user._id,perms:normalizePermissions(user.permissions,isAdmin),isAdmin,sid:sessionId},process.env.JWT_SECRET,{expiresIn:'15m'});}
function signRefresh(user,sessionId){return jwt.sign({sub:user._id,tokenVersion:1,sid:sessionId},process.env.JWT_SECRET,{expiresIn:'30d'});}
function cookieOpts(){return {httpOnly:true,secure:process.env.NODE_ENV==='production',sameSite:'strict',path:'/'};}
async function audit(action,user,details={},req){await M.AuditLog.create({action,user,details,ip:req?.ip}).catch(()=>{});}
function auth(req,res,next){
 const token=req.cookies.accessToken;if(!token)return res.status(401).json({error:'Unauthorized'});
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
 return vehicle.gpsLink===provider||(vehicle.gpsProviders||[]).some(link=>link.name===provider);
}

function getProviderVehicleId(vehicle,provider){
 return (vehicle.gpsProviders||[]).find(link=>link.name===provider)?.vehicleId||
  (vehicle.gpsLink===provider?vehicle.providerVehicleId:null);
}

async function seedAdmin(){
 const username=process.env.ADMIN_USERNAME.trim().toLowerCase();
 const existing=await M.User.findOne({username});
 if(!existing){
  await M.User.create({fullName:'Administrator',username:process.env.ADMIN_USERNAME,passwordHash:await bcrypt.hash(process.env.ADMIN_PASSWORD,12),isAdmin:true,active:true,permissions:normalizePermissions({},true)});
 }else{
  existing.isAdmin=true;existing.active=true;
  existing.permissions=normalizePermissions({},true);
  await existing.save();
 }
}

function flattenProvider(payload,provider){
 const findRows=(value,depth=0)=>{
  if(Array.isArray(value))return value;
  if(!value||typeof value!=='object'||depth>3)return null;
  for(const key of ['data','vehicles','items','results','response','list','records','content','vehicleList','vehicleDetails']){
   const rows=findRows(value[key],depth+1);if(rows)return rows;
  }
  return null;
 };
 const arr=findRows(payload)||[payload].filter(Boolean);
 return arr.map(r=>{
  const number=r.vehicleNumber||r.vehicleNo||r.registrationNo||r.registration_number||r.vehicle_number||r.vehicle||r.rcNumber||r.name||r.VEHICLE_NUMBER||r.VEHICLE_NAME||r.vehicle_name;
  const lat=r.latitude??r.lat??r.LATITUDE??r.location?.lat??r.location?.latitude??r.gpsLocation?.lat??r.currentLocation?.lat;
  const lng=r.longitude??r.lng??r.lon??r.LONGITUDE??r.location?.lng??r.location?.longitude??r.gpsLocation?.lng??r.currentLocation?.lng;
  const speed=r.speed??r.vehicleSpeed??r.currentSpeed??r.speedKph??r.SPEED;
  const rawIgnition=r.ignition??r.ignitionStatus??r.engineStatus??r.engine_status??r.IGNITION??r.IGNITION_STATUS??r.ignition_status;
  const ignition=normalizeIgnitionStatus(rawIgnition);
  const time=r.gpsTime||r.timestamp||r.time||r.locationTime||r.lastSeen||r.updatedAt||r.lastUpdate||r.deviceTime||
   r.TIMESTAMP||r.TIME||r.CREATE_DATE||r.gps_time||r.dttimeInEpoch||r.dttime||r.createdDate||r.createdDateReadable;
  const numericTime=Number(time);
  const dateValue=Number.isFinite(numericTime)&&numericTime>0
   ?new Date(numericTime<100000000000?numericTime*1000:numericTime)
   :new Date(time||NaN);
  const heading=r.heading||r.course||r.bearing||r.COURSE;
  const providerAddress=typeof r.readableLocation==='string'?r.readableLocation:
   typeof r.formattedAddress==='string'?r.formattedAddress:
   typeof r.fullAddress==='string'?r.fullAddress:
   typeof r.address==='string'?r.address:
   typeof r.currentAddress==='string'?r.currentAddress:
   typeof r.ADDRESS==='string'?r.ADDRESS:
   typeof r.location?.address==='string'?r.location.address:
   typeof r.address?.formattedAddress==='string'?r.address.formattedAddress:
   typeof r.address?.formatted_address==='string'?r.address.formatted_address:
   typeof r.address?.fullAddress==='string'?r.address.fullAddress:'';
  const addressParts=typeof r.address==='object'&&r.address?r.address:{};
  const providerFields={
   locality:r.locality||r.LOCALITY||addressParts.locality||addressParts.suburb||'',
   city:r.city||r.CITY||addressParts.city||'',
   district:r.district||r.DISTRICT||addressParts.district||'',
   state:r.state||r.STATE||addressParts.state||'',
   pincode:r.pincode||r.pinCode||r.postalCode||r.POSTCODE||'',
   country:r.country||r.COUNTRY||addressParts.country||''
  };
  const numericSpeed=Number(speed);
  const providerRunningStatus=r.runningStatus||r.running_status||r.movementStatus||r.MOVEMENT_STATUS;
  const runningStatus=normalizeRunningStatus(providerRunningStatus,numericSpeed,ignition);
  return {vehicleNumber:normalizeNumber(number),lat:Number(lat),lng:Number(lng),speed:speed==null?'N/A':String(speed),ignition,runningStatus,gpsTime:dateValue,provider,heading:Number(heading)||0,providerAddress,providerFields,providerVehicleId:r.vehicleId??r.VEHICLE_ID??r.vehicle_id??r.id,driverName:r.driverName??r.DRIVER_NAME??r.driver_name,vehicleStatus:r.vehicleStatus??r.STATUS??r.status};
 }).filter(x=>x.vehicleNumber&&reverseGeocoding.validCoordinates(x.lat,x.lng)&&Number.isFinite(x.gpsTime.getTime()));
}

function getNextAutoSyncAt(now=new Date()){
 const interval=30*60*1000;
 return new Date((Math.floor(now.getTime()/interval)+1)*interval);
}

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

function normalizeIgnitionStatus(value){
 if(value==null||value==='')return 'N/A';
 if(value===true||value===1)return 'ON';
 if(value===false||value===0)return 'OFF';
 const status=String(value).trim().toLowerCase();
 if(/^(on|true|1|running)$/.test(status)||/ignition.*on/.test(status))return 'ON';
 if(/^(off|false|0|stopped)$/.test(status)||/ignition.*off/.test(status))return 'OFF';
 return 'N/A';
}

function normalizeRunningStatus(value,speed,ignition){
 const status=String(value||'').trim().toLowerCase();
 if(status.includes('moving')||status.includes('running'))return 'Moving';
 if(status.includes('idle'))return 'Idle';
 if(status.includes('stopped')||status==='stop')return 'Stopped';
 const numericSpeed=Number(speed);
 if(Number.isFinite(numericSpeed)&&numericSpeed>0)return 'Moving';
 if(Number.isFinite(numericSpeed)&&numericSpeed===0)return ignition==='ON'?'Idle':'Stopped';
 return ignition==='ON'?'Idle':'Unknown';
}

async function acquireGpsSyncLock(owner,now){
 try{
  const lock=await M.GpsSyncLock.findOneAndUpdate({
   key:GPS_SYNC_LOCK_KEY,
   $or:[{lockUntil:{$lte:now}},{lockUntil:{$exists:false}}]
  },{$set:{owner,acquiredAt:now,lockUntil:new Date(now.getTime()+GPS_SYNC_LOCK_TTL_MS)}},
  {upsert:true,new:true});
  return lock?.owner===owner;
 }catch(error){
  if(error.code===11000)return false;
  throw error;
 }
}

async function logSkippedSync(type,reason,at=new Date()){
 await M.SyncLog.create({
  type,startedAt:at,finishedAt:new Date(),
  result:{reason,skipped:true},success:false
 });
 return {started:false,reason};
}

async function runSync(type='manual'){
 const attemptedAt=new Date();
 if(syncing)return logSkippedSync(type,'Sync already running',attemptedAt);
 syncing=true;
 const owner=crypto.randomUUID();
 let lockAcquired=false,lockLost=false,heartbeat=null;
 try{
  lockAcquired=await acquireGpsSyncLock(owner,attemptedAt);
  if(!lockAcquired)return await logSkippedSync(type,'Another backend instance is running GPS sync',attemptedAt);
  heartbeat=setInterval(async()=>{
   try{
    const update=await M.GpsSyncLock.updateOne({key:GPS_SYNC_LOCK_KEY,owner},{
     $set:{lockUntil:new Date(Date.now()+GPS_SYNC_LOCK_TTL_MS)}
    });
    if(update.matchedCount===0){
     lockLost=true;
     clearInterval(heartbeat);
     console.error('[GPS sync] Distributed lock lease was lost',{owner,type});
    }
   }catch(error){
    console.error('[GPS sync] Could not renew distributed lock lease',{
     owner,type,message:error.message,stack:error.stack
    });
   }
  },GPS_SYNC_LOCK_RENEW_MS);
  heartbeat.unref?.();
  const startedAt=new Date();
  const activeVehicleRows=await M.Vehicle.find({status:'Active'})
   .select('vehicleNumber gpsLink providerVehicleId gpsProviders updatedAt createdAt').lean();
  const activeVehicles=[...groupByVehicleNumber(activeVehicleRows).values()].map(records=>
   records.sort((a,b)=>new Date(b.updatedAt||0)-new Date(a.updatedAt||0))[0]
  );
  const vehiclesByNumber=new Map(activeVehicles.map(vehicle=>[normalizeNumber(vehicle.vehicleNumber),vehicle]));
  const registeredNumbers=[...vehiclesByNumber.keys()];
  const synchronizedRegisteredNumbers=new Set();
  const result={};
  const providers=[
   {name:'Wheelseye',fetch:wheelseyeService.fetchLive},
   {name:'FleetX',fetch:fleetxService.fetchLive,map:fleetxService.mapLiveRecords}
  ];
  for(const p of providers){
   if(lockLost)throw new Error('GPS sync stopped after losing the distributed lock');
   const registered=activeVehicles.filter(vehicle=>vehicleHasProvider(vehicle,p.name));
   const registeredNumbers=registered.map(vehicle=>normalizeNumber(vehicle.vehicleNumber));
   const errorDetails=[];
   try{
    const response=await retryProviderRequest(p.name,p.fetch);
    let rows=p.map?p.map(response.data):flattenProvider(response.data,p.name);
    if(p.name==='FleetX'){
     const received=new Set(rows.map(row=>normalizeNumber(row.vehicleNumber)));
     for(const vehicle of registered){
      if(lockLost)throw new Error('GPS sync stopped after losing the distributed lock');
      const vehicleNumber=normalizeNumber(vehicle.vehicleNumber);
      if(received.has(vehicleNumber))continue;
      try{
       const fallback=await retryProviderRequest(p.name,()=>fleetxService.fetchLiveByNumber(vehicleNumber));
       const fallbackRows=fleetxService.mapLiveRecords(fallback.data,vehicleNumber);
       const row=fallbackRows.find(item=>item.vehicleNumber===vehicleNumber);
       if(row){rows.push(row);received.add(row.vehicleNumber)}
       else errorDetails.push({vehicleNumber,message:'No valid live GPS record was returned'});
      }catch(error){
       const code=error.response?.status||error.statusCode||0;
       errorDetails.push({vehicleNumber,code,message:error.message});
       console.warn(`[GPS sync] FleetX live lookup failed for ${vehicleNumber}`,{code,message:error.message});
      }
     }
    }
    const newestByNumber=new Map();
    for(const row of rows){
     const vehicleNumber=normalizeNumber(row.vehicleNumber);
     const gpsTime=new Date(row.gpsTime);
     if(!vehicleNumber||!Number.isFinite(gpsTime.getTime())||gpsTime>startedAt)continue;
     const current=newestByNumber.get(vehicleNumber);
     if(!current||gpsTime>new Date(current.gpsTime))newestByNumber.set(vehicleNumber,{...row,vehicleNumber,gpsTime});
    }
    const syncedNumbers=new Set(),receivedRegistered=new Set();
    for(const row of newestByNumber.values()){
     if(lockLost)throw new Error('GPS sync stopped after losing the distributed lock');
     const vehicle=vehiclesByNumber.get(row.vehicleNumber)||null;
     if(vehicle)receivedRegistered.add(row.vehicleNumber);
     const previousRecords=await M.VehicleLiveStatus.find({vehicleNumber:vehicleNumberRegex(row.vehicleNumber)})
      .sort({gpsTime:-1,syncedAt:-1}).lean();
     const previous=previousRecords[0]||null;
     const previousGpsTime=previous?.gpsTime?new Date(previous.gpsTime):null;
     if(previousGpsTime&&previousGpsTime>row.gpsTime){
      errorDetails.push({vehicleNumber:row.vehicleNumber,message:'Provider returned an older GPS timestamp; newer stored record was kept'});
      continue;
     }
     const syncedAt=new Date();
     let location=null;
     try{
      location=await reverseGeocoding.resolve(row.lat,row.lng,{
       providerAddress:row.providerAddress,
       providerFields:row.providerFields,
       previous:previous?{
        readableLocation:previous.readableLocation||previous.address,
        locality:previous.locality,city:previous.city,district:previous.district,state:previous.state,
        pincode:previous.pincode,country:previous.country,geocodedAt:previous.geocodedAt,
        geocodingProvider:previous.geocodingProvider,addressLat:previous.addressLat,addressLng:previous.addressLng
       }:null
      });
     }catch(error){console.warn(`Reverse geocoding failed for ${row.vehicleNumber}: ${error.message}`);}
     const address=location?.readableLocation||readableAddress(previous)||null;
     const addressIsCurrent=Boolean(location&&location.isCurrent!==false);
     const addressFields=location?{
      readableLocation:location.readableLocation,address:location.readableLocation,
      locality:location.locality||'',city:location.city||'',district:location.district||'',
      state:location.state||'',pincode:location.pincode||'',country:location.country||'',
      geocodedAt:location.geocodedAt||null,geocodingProvider:location.provider||'Provider',
      ...(addressIsCurrent?{addressLat:row.lat,addressLng:row.lng}:{})
     }:{};
     const doc={...row,...addressFields,address,normalizedVehicleNumber:row.vehicleNumber,
      addressIsCurrent,unregistered:!vehicle,stale:false,lastGoodTime:row.gpsTime,syncedAt};
     delete doc.providerAddress;
     await M.VehicleLiveStatus.findOneAndUpdate(
      previous?{_id:previous._id}:{normalizedVehicleNumber:row.vehicleNumber},
      {$set:doc},{upsert:!previous,new:true}
     );
     if(vehicle){
      synchronizedRegisteredNumbers.add(row.vehicleNumber);
      const links=new Map((vehicle.gpsProviders||[]).map(link=>[link.name,{name:link.name,vehicleId:link.vehicleId}]));
      if(!links.has(vehicle.gpsLink))links.set(vehicle.gpsLink,{name:vehicle.gpsLink,vehicleId:vehicle.providerVehicleId});
      const currentLink=links.get(p.name)||{name:p.name};
      if(row.providerVehicleId)currentLink.vehicleId=String(row.providerVehicleId);
      links.set(p.name,currentLink);
      const vehicleUpdate={gpsProviders:[...links.values()]};
      if(row.providerVehicleId&&p.name===vehicle.gpsLink)vehicleUpdate.providerVehicleId=String(row.providerVehicleId);
      await M.Vehicle.updateOne({_id:vehicle._id},{$set:vehicleUpdate});
      vehicle.gpsProviders=vehicleUpdate.gpsProviders;
      if(vehicleUpdate.providerVehicleId)vehicle.providerVehicleId=vehicleUpdate.providerVehicleId;
     }
     await M.VehicleLocationHistory.updateOne(
      {vehicleNumber:row.vehicleNumber,gpsTime:row.gpsTime,provider:row.provider},
      {$setOnInsert:{vehicle:row.vehicleNumber,vehicleNumber:row.vehicleNumber,lat:row.lat,lng:row.lng,address,
       readableLocation:location?.readableLocation||address,locality:location?.locality||'',city:location?.city||'',
       district:location?.district||'',state:location?.state||'',pincode:location?.pincode||'',country:location?.country||'',
       geocodedAt:location?.geocodedAt||null,geocodingProvider:location?.provider||'Provider',
       addressLat:addressIsCurrent?row.lat:previous?.addressLat,addressLng:addressIsCurrent?row.lng:previous?.addressLng,
       addressIsCurrent,providerVehicleId:row.providerVehicleId?String(row.providerVehicleId):undefined,
       driverName:row.driverName,vehicleStatus:row.vehicleStatus,
       speed:row.speed,ignition:row.ignition,gpsTime:row.gpsTime,provider:row.provider,syncedAt}},
      {upsert:true}
     );
     syncedNumbers.add(row.vehicleNumber);
    }
    const receivedAssignedNumbers=registeredNumbers.filter(number=>receivedRegistered.has(number));
    const missingNumbers=registeredNumbers.filter(number=>!receivedRegistered.has(number));
    for(const vehicleNumber of missingNumbers){
     errorDetails.push({vehicleNumber,message:'Provider returned no valid GPS record'});
    }
    const updatedNumbers=[...syncedNumbers];
    if(updatedNumbers.length){
     await M.VehicleLiveStatus.updateMany({vehicleNumber:{$in:updatedNumbers}},{$set:{stale:false}});
    }
    const completedAt=new Date();
    const assignedNumbers=new Set(registeredNumbers);
    const failedCount=registered.length-[...syncedNumbers].filter(number=>assignedNumbers.has(number)).length;
    await M.GpsProviderStatus.findOneAndUpdate({provider:p.name},{$set:{
     status:'Connected',lastAttemptTime:completedAt,lastSuccessTime:completedAt,
     lastErrorMessage:'',lastErrorCode:null,lastErrorTime:null,vehicleCount:registered.length,
     vehiclesReceived:receivedAssignedNumbers.length,vehiclesNotResponding:failedCount,
     apiResponseStatus:response.status||200
    }}, {upsert:true});
    result[p.name]={
     status:'Connected',count:syncedNumbers.size,syncedCount:syncedNumbers.size,
     failedCount,vehiclesReceived:receivedAssignedNumbers.length,
     errors:errorDetails.slice(0,30)
    };
   }catch(e){
    const code=e.response?.status||e.statusCode||0;
    const message=e.response?.data?.message||e.message||'Provider request failed';
    try{
     await M.GpsProviderStatus.findOneAndUpdate({provider:p.name},{$set:{
      status:'Error',lastAttemptTime:new Date(),lastErrorMessage:message,
      lastErrorCode:code,lastErrorTime:new Date(),vehicleCount:registered.length,
      vehiclesNotResponding:registered.length
     }},{upsert:true});
    }catch(statusError){
     console.error(`[GPS sync] Could not persist ${p.name} failure status`,{
      message:statusError.message,stack:statusError.stack
     });
    }
    result[p.name]={
     status:'Error',count:0,syncedCount:0,failedCount:registered.length,
     message,code,errors:[...errorDetails,{provider:p.name,message,code}].slice(0,30)
    };
   }
  }
  let geofenceError=null;
  const failedVehicleNumbers=registeredNumbers.filter(number=>!synchronizedRegisteredNumbers.has(number));
  if(failedVehicleNumbers.length){
   await M.VehicleLiveStatus.updateMany(
    {$or:[
     {normalizedVehicleNumber:{$in:failedVehicleNumbers}},
     {vehicleNumber:{$in:failedVehicleNumbers.map(vehicleNumberRegex)}}
    ]},{$set:{stale:true}}
   );
  }
  try{await updateGeofence()}
  catch(error){
   geofenceError=error.message||String(error);
   console.error('[GPS sync] Plant geofence update failed',{message:geofenceError,stack:error.stack});
  }
  const finishedAt=new Date();
  const successfulProviders=Object.values(result).filter(provider=>provider.status==='Connected').length;
  const allProvidersSucceeded=successfulProviders===providers.length;
  const failedProviderCount=providers.length-successfulProviders;
  const totalVehiclesSynced=synchronizedRegisteredNumbers.size;
  const failedVehicleCount=failedVehicleNumbers.length;
  const success=allProvidersSucceeded&&failedVehicleCount===0&&!geofenceError;
  const summary={
   ...result,totalVehiclesSynced,failedVehicleCount,failedProviderCount,
   geofenceError,partialSuccess:successfulProviders>0&&!success
  };
  await M.SyncLog.create({type,startedAt,finishedAt,result:summary,success});
  return {
   started:true,startedAt,finishedAt,result:summary,success,
   partialSuccess:summary.partialSuccess,totalVehiclesSynced,failedVehicleCount,
   failedProviderCount,nextAutoSyncAt:getNextAutoSyncAt(finishedAt)
  };
 }catch(error){
  const finishedAt=new Date();
  console.error('[GPS sync] Synchronization cycle failed',{
   type,owner,message:error.message,stack:error.stack
  });
  try{
   await M.SyncLog.create({
    type,startedAt:attemptedAt,finishedAt,
    result:{error:error.message||String(error)},success:false
   });
  }catch(logError){
   console.error('[GPS sync] Could not save failed synchronization log',{
    type,message:logError.message,stack:logError.stack
   });
  }
  throw error;
 }finally{
  if(heartbeat)clearInterval(heartbeat);
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
  M.Vehicle.find({status:'Active'}).select('vehicleNumber updatedAt createdAt').lean(),
  M.VehicleLiveStatus.find({stale:{$ne:true}}).lean(),
  M.Plant.find({status:'Active'}).lean(),
  M.VehiclePlantStay.find({exitTime:null}).lean()
 ]);
 const registered=new Set(groupByVehicleNumber(active).keys());
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
 const snapshot=await fleetSnapshotService.getOperationalSnapshot(M);
 res.json({plants:snapshot.plants,transit:snapshot.transit,lastSync:snapshot.lastSync?.finishedAt||snapshot.lastSync?.startedAt||null,nextSyncAt:getNextAutoSyncAt(),providers:snapshot.providers});
});
function allowedNumber(n){return /^[A-Z0-9]+$/.test(n)}
function _nameSafe(p){return p.name}

function syncPermission(req,res,next){
 if(hasPermission(req.user.perms,'Dashboard','edit',req.user.isAdmin)||
  hasPermission(req.user.perms,'GPS Track','edit',req.user.isAdmin))return next();
 return res.status(403).json({error:'GPS Sync permission required'});
}
app.post('/api/sync',auth,syncPermission,async(req,res)=>{
 const result=await runSync('manual');
 return res.status(result.started?200:409).json(result);
});

app.get('/api/vehicles',auth,permission('Vehicle Registry','view'),async(req,res)=>{
 const q={};
 if(req.query.search){
  const search=normalizeNumber(req.query.search);
  if(search)q.vehicleNumber={$regex:search,$options:'i'};
 }
 if(req.query.status)q.status=req.query.status;if(req.query.fleetType)q.fleetType=req.query.fleetType;if(req.query.provider)q.gpsLink=req.query.provider;
 const page=Math.max(1,+req.query.page||1),limit=Math.max(1,Math.min(100,+req.query.limit||20));
 const found=await M.Vehicle.find(q).sort({vehicleNumber:1,status:1,updatedAt:-1,createdAt:1}).lean();
 const unique=[...groupByVehicleNumber(found).values()].map(records=>records[0]);
 const total=unique.length,items=unique.slice((page-1)*limit,page*limit);
 const live=await M.VehicleLiveStatus.find({}).select('vehicleNumber gpsTime').lean();
 const liveByNumber=new Map();
 for(const [vehicleNumber,records] of groupByVehicleNumber(live).entries()){
  records.sort((a,b)=>new Date(b.gpsTime||0)-new Date(a.gpsTime||0));
  liveByNumber.set(vehicleNumber,records[0]);
 }
 res.json({items:items.map(vehicle=>({...vehicle,lastGps:liveByNumber.get(normalizeNumber(vehicle.vehicleNumber))?.gpsTime||null})),total,page,pages:Math.ceil(total/limit)});
});
app.post('/api/vehicles',auth,permission('Vehicle Registry','edit'),[body('vehicleNumber').trim().notEmpty(),body('fleetType').isIn(['Own Fleet','Contract Fleet']),body('gpsLink').isIn(['Wheelseye','FleetX']),body('status').isIn(['Active','Inactive'])],async(req,res)=>{
 if(!validationResult(req).isEmpty())return res.status(400).json({error:'Invalid vehicle details'});
 const vehicleNumber=normalizeNumber(req.body.vehicleNumber);
 const match=vehicleNumberRegex(vehicleNumber);
 if(!vehicleNumber)return res.status(400).json({error:'Enter a valid vehicle number'});
 if(await M.Vehicle.exists({vehicleNumber:match}))return res.status(409).json({error:'Duplicate vehicle number'});
 try{
  const v=await M.Vehicle.create({vehicleNumber,normalizedVehicleNumber:vehicleNumber,fleetType:req.body.fleetType,gpsLink:req.body.gpsLink,status:req.body.status});
  await M.VehicleLiveStatus.updateMany({vehicleNumber:match},{$set:{unregistered:false}});
  await audit('create_vehicle',req.user.sub,{vehicleNumber},req);
  res.status(201).json(v);
 }catch(error){
  if(error.code===11000)return res.status(409).json({error:'Duplicate vehicle number'});
  throw error;
 }
});
app.put('/api/vehicles/:id',auth,permission('Vehicle Registry','edit'),async(req,res)=>{
 const d={...req.body};
 delete d.normalizedVehicleNumber;
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
  const v=await M.Vehicle.findByIdAndUpdate(req.params.id,d,{new:true,runValidators:true});
  if(!v)return res.status(404).json({error:'Vehicle not found'});
  await audit('edit_vehicle',req.user.sub,{vehicleNumber:v.vehicleNumber},req);
  res.json(v);
 }catch(error){
  if(error.code===11000)return res.status(409).json({error:'Duplicate vehicle number'});
  throw error;
 }
});
app.delete('/api/vehicles/:id',auth,permission('Vehicle Registry','edit'),async(req,res)=>{const v=await M.Vehicle.findByIdAndDelete(req.params.id);if(!v)return res.status(404).json({error:'Vehicle not found'});await audit('delete_vehicle',req.user.sub,{vehicleNumber:v.vehicleNumber},req);res.json({ok:true});});
app.get('/api/unregistered',auth,permission('Vehicle Registry','view'),async(req,res)=>{
 const [vehicles,records]=await Promise.all([
  M.Vehicle.find({}).select('vehicleNumber').lean(),
  M.VehicleLiveStatus.find({unregistered:true}).sort({vehicleNumber:1,gpsTime:-1}).lean()
 ]);
 const registered=new Set(groupByVehicleNumber(vehicles).keys());
 const unique=[...groupByVehicleNumber(records).entries()]
  .filter(([vehicleNumber])=>!registered.has(vehicleNumber))
  .map(([,duplicates])=>duplicates[0]).slice(0,500);
 res.json(unique);
});

app.get('/api/plants',auth,permission('Plant','view'),async(req,res)=>res.json(await M.Plant.find().sort({name:1})));
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
  const plant=await M.Plant.findByIdAndUpdate(req.params.id,{$set:data},{new:true,runValidators:true});
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
 const [snapshot,lastSuccessfulSync,lastManualSync,lastCycle,gpsData]=await Promise.all([
  fleetSnapshotService.getOperationalSnapshot(M),
  M.SyncLog.findOne({success:true}).sort({finishedAt:-1}).lean(),
  M.SyncLog.findOne({type:'manual'}).sort({startedAt:-1}).lean(),
  M.SyncLog.findOne({'result.totalVehiclesSynced':{$exists:true}}).sort({startedAt:-1}).lean(),
  M.VehicleLiveStatus.findOne({syncedAt:{$exists:true}}).sort({syncedAt:-1}).select('syncedAt').lean()
 ]);
 const lastCycleErrors=lastCycle?.result
  ?Object.entries(lastCycle.result).flatMap(([provider,result])=>
    Array.isArray(result?.errors)?result.errors.map(error=>({provider,...error})):[])
  :[];
 res.json({
  live:snapshot.live,registeredVehicles:snapshot.registeredVehicles,
  registeredCount:snapshot.registeredCount,summary:snapshot.summary,
  providers:snapshot.providers,lastSync:snapshot.lastSync,
  syncStatus:{
   autoSyncActive:Boolean(syncScheduler),nextAutoSyncAt:getNextAutoSyncAt(),
   lastSuccessfulSyncAt:lastSuccessfulSync?.finishedAt||null,
   lastManualSyncAt:lastManualSync?.finishedAt||lastManualSync?.startedAt||null,
   totalVehiclesSynced:lastCycle?.result?.totalVehiclesSynced||0,
   failedVehicleCount:lastCycle?.result?.failedVehicleCount||0,
   failedProviderCount:lastCycle?.result?.failedProviderCount||0,
   gpsDataLastUpdated:gpsData?.syncedAt||null,
   lastCycleErrors:lastCycleErrors.slice(0,20),
   lastCycleGeofenceError:lastCycle?.result?.geofenceError||null,
   lastCycleSuccess:lastCycle?.success??null,
   lastCycleType:lastCycle?.type||null
  }
 });
});
app.get('/api/history/search',auth,permission('GPS Track','view'),async(req,res)=>{
 const vehicleNumber=normalizeNumber(req.query.vehicleNumber);
 const provider=String(req.query.provider||'');
 const from=new Date(String(req.query.from||''));
 const to=new Date(String(req.query.to||''));
 if(!vehicleNumber||!['Wheelseye','FleetX'].includes(provider)||!Number.isFinite(from.getTime())||!Number.isFinite(to.getTime())||from>to||to>Date.now()){
  return res.status(400).json({error:'Select a valid provider, vehicle and past date range'});
 }
 const matcher=vehicleNumberRegex(vehicleNumber);
 const vehicle=await M.Vehicle.findOne({vehicleNumber:matcher,status:'Active'});
 const live=await M.VehicleLiveStatus.findOne({vehicleNumber:matcher,provider}).sort({gpsTime:-1}).lean();
 if(!vehicle||!vehicleHasProvider(vehicle,provider))return res.status(404).json({error:'Registered vehicle not found for the selected provider'});
 if(provider==='FleetX'){
  const providerVehicleId=getProviderVehicleId(vehicle,'FleetX')||live?.providerVehicleId;
  if(!providerVehicleId)return res.status(409).json({error:'FleetX vehicle ID has not been received yet'});
  try{
   const response=await fleetxService.fetchHistory({vehicleId:providerVehicleId,from:from.getTime(),to:to.getTime()});
   const records=flattenProvider(response.data,'FleetX').filter(row=>row.vehicleNumber===vehicleNumber&&row.gpsTime>=from&&row.gpsTime<=to);
   for(const row of records){
    let location=null;
    try{location=await reverseGeocoding.resolve(row.lat,row.lng,{providerAddress:row.providerAddress,providerFields:row.providerFields});}
    catch(error){console.warn(`History reverse geocoding failed for ${vehicleNumber}: ${error.message}`);}
    const address=location?.readableLocation||null;
    await M.VehicleLocationHistory.updateOne(
     {vehicleNumber,gpsTime:row.gpsTime,provider:'FleetX'},
     {$setOnInsert:{vehicle:vehicleNumber,vehicleNumber,lat:row.lat,lng:row.lng,address,readableLocation:address,
      locality:location?.locality||'',city:location?.city||'',district:location?.district||'',
      state:location?.state||'',pincode:location?.pincode||'',country:location?.country||'',
      geocodedAt:location?.geocodedAt||null,addressLat:location?row.lat:undefined,addressLng:location?row.lng:undefined,
      addressIsCurrent:Boolean(location),geocodingProvider:location?.provider||'Provider',
      providerVehicleId:String(providerVehicleId),driverName:row.driverName,vehicleStatus:row.vehicleStatus,
      speed:row.speed,ignition:row.ignition,gpsTime:row.gpsTime,provider:'FleetX',syncedAt:new Date()}},
     {upsert:true}
    );
   }
  }catch(error){
   const code=error.response?.status||502;
   return res.status(code===401?502:code).json({error:`FleetX history request failed (${code})`});
  }
 }
 const rows=await M.VehicleLocationHistory.find({
  provider,gpsTime:{$gte:from,$lte:to},
  $or:[{vehicleNumber:matcher},{vehicle:matcher}]
 }).sort({gpsTime:1}).lean();
 res.json(rows.map(row=>({...row,location:readableAddress(row)||'Address unavailable'})));
});
app.get('/api/history/:vehicle',auth,permission('GPS Track','view'),async(req,res)=>{
 const vehicle=normalizeNumber(req.params.vehicle);const limit=Math.min(500,+req.query.limit||200);
 const matcher=vehicleNumberRegex(vehicle);
 const rows=await M.VehicleLocationHistory.find({$or:[{vehicleNumber:matcher},{vehicle:matcher}]})
  .sort({gpsTime:-1}).limit(limit).lean();
 res.json(rows.map(r=>({...r,location:readableAddress(r)})));
});

app.post('/api/plans',auth,permission('Dashboard','edit'),[body('vehicle').trim().notEmpty(),body('planType').isIn(['Loading','Unloading','Maintenance','Waiting','Other']),body('expectedDeparture').optional({checkFalsy:true}).isISO8601()],async(req,res)=>{if(!validationResult(req).isEmpty())return res.status(400).json({error:'Invalid plan'});const plan=await M.VehiclePlan.create(req.body);await audit('create_plan',req.user.sub,{vehicle:plan.vehicle},req);res.status(201).json(plan)});
app.get('/api/plans/:vehicle',auth,permission('Dashboard','view'),async(req,res)=>res.json(await M.VehiclePlan.find({vehicle:normalizeNumber(req.params.vehicle)}).sort({createdAt:-1}).limit(20)));

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
fs.mkdirSync(uploadDirectory,{recursive:true});
const upload=multer({storage:multer.diskStorage({destination:(q,f,c)=>c(null,uploadDirectory),filename:(q,f,c)=>c(null,Date.now()+'-'+f.originalname.replace(/[^a-z0-9._-]/gi,'_'))}),limits:{fileSize:1024*1024},fileFilter:(q,f,c)=>['image/png','image/svg+xml','image/webp'].includes(f.mimetype)?c(null,true):c(new Error('Invalid icon type'))});
app.post('/api/settings/icons',auth,permission('GPS Track','edit'),upload.fields([{name:'running',maxCount:1},{name:'stopped',maxCount:1}]),async(req,res)=>{
 for(const key of ['running','stopped'])if(req.files[key])await M.AppSetting.findOneAndUpdate({key:`${key}Icon`},{$set:{value:'/uploads/'+req.files[key][0].filename}}, {upsert:true});
 await audit('edit_icons',req.user.sub,{},req);res.json(await M.AppSetting.find({key:/Icon$/}));
});
app.get('/api/settings',auth,permission('GPS Track','view'),(req,res)=>M.AppSetting.find().then(x=>res.json(Object.fromEntries(x.map(v=>[v.key,v.value])))));

app.post('/api/share',auth,permission('GPS Track','edit'),async(req,res)=>{const vehicleNumber=normalizeNumber(req.body.vehicleNumber);if(!await M.VehicleLiveStatus.exists({vehicleNumber}))return res.status(404).json({error:'Vehicle not found'});const token=crypto.randomBytes(24).toString('hex');const link=await M.ShareLink.create({vehicleNumber,token,expiresAt:new Date(Date.now()+24*60*60*1000),createdBy:req.user.sub});res.status(201).json({url:`/share/${link.token}`,token,expiresAt:link.expiresAt})});
app.post('/api/share/:token/revoke',auth,permission('GPS Track','edit'),async(req,res)=>{await M.ShareLink.findOneAndUpdate({token:req.params.token},{$set:{revoked:true}});res.json({ok:true})});
app.get('/share/:token',async(req,res)=>{const l=await M.ShareLink.findOne({token:req.params.token,revoked:false,expiresAt:{$gt:new Date()}});if(!l)return res.status(404).send('This location link is invalid or expired');const live=await M.VehicleLiveStatus.findOne({vehicleNumber:l.vehicleNumber});const speed=live?.speed==='N/A'||live?.speed==null?'N/A':live.provider==='FleetX'?live.speed:`${live.speed} km/h`;res.type('html').send(`<!doctype html><html><head><meta name="viewport" content="width=device-width"><title>${l.vehicleNumber} - Sikka Fleet</title></head><body style="margin:0;font-family:Arial;background:#eef2ff"><h2 style="padding:16px;margin:0">${l.vehicleNumber}</h2><div style="padding:16px"><b>Location:</b> ${live?.address||'No data'}<br><b>GPS time:</b> ${live?.gpsTime?.toLocaleString('en-IN')||'No data'}<br><b>Speed:</b> ${speed}<br><b>IGN:</b> ${live?.ignition||'N/A'}${live?.stale?'<br><b>GPS data:</b> Stale':''}</div></body></html>`)});

function cleanChatQuestion(value){
 return String(value||'').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g,' ').replace(/<[^>]*>/g,'').trim();
}
function escapeRegex(value){return value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');}
app.post('/api/ai/chat',auth,permission('Sikka AI','view'),aiChatLimiter,
 body('message').isString().trim().isLength({min:1,max:500}),
 body('sessionId').optional().isString().trim().isLength({min:1,max:100}),
 async(req,res)=>{
  if(!validationResult(req).isEmpty())return res.status(400).json({error:'Sawal 1 se 500 characters ka hona chahiye.'});
  const question=cleanChatQuestion(req.body.message);
  if(!question)return res.status(400).json({error:'Sawal khaali nahi ho sakta.'});
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
     models:M,now:askedAt,previousLanguage:previousChat?.language,permissions:authorizedPages
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
   ...answer,userFullName:req.user.fullName,askedAt,answeredAt,
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
 const from=new Date(String(req.query.from||''));
 const to=new Date(String(req.query.to||''));
 const now=new Date();
 const offset=Number(req.query.offset??0);
 const limit=Math.max(1,Math.min(20,Number(req.query.limit)||20));
 if(vehicleNumber.length<7||!Number.isFinite(from.getTime())||!Number.isFinite(to.getTime())||
  !Number.isInteger(offset)||offset<0||offset>50000||from>to||to>now){
  return res.status(400).json({error:'Invalid or future history range'});
 }
 const matcher=vehicleNumberRegex(vehicleNumber);
 if(!await M.Vehicle.exists({vehicleNumber:matcher,status:'Active'})){
  return res.status(404).json({error:'Vehicle number was not found in the active registry.'});
 }
 const filter={$or:[{vehicleNumber:matcher},{vehicle:matcher}],gpsTime:{$gte:from,$lte:to}};
 const cutoff=sikkaAiService.getHistoryCutoff(now);
 if(from<cutoff)return res.status(400).json({error:sikkaAiService.HISTORY_LIMIT_REPLY});
 filter.gpsTime.$gte=new Date(Math.max(from.getTime(),cutoff.getTime()));
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

cron.schedule('0 0 * * *',async()=>{
 try{
  const result=await M.SikkaAiChat.deleteMany({expireAt:{$lte:new Date()}});
  if(result.deletedCount)console.info(`Sikka AI daily cleanup removed ${result.deletedCount} expired chat(s).`);
 }catch(error){console.error('Sikka AI daily chat cleanup failed:',error)}
},{timezone:'Asia/Kolkata'});
cron.schedule('0 2 * * *',()=>historyRetention.cleanupHistory(M),{timezone:'Asia/Kolkata'});

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

function startGpsSyncScheduler(){
 if(syncScheduler)return;
 syncScheduler=cron.schedule('*/30 * * * *',async()=>{
  const scheduledAt=new Date();
  console.info('[GPS sync] Automatic cycle scheduled',{scheduledAt:scheduledAt.toISOString()});
  try{
   const result=await runSync('auto');
   console.info('[GPS sync] Automatic cycle finished',{
    started:result.started,success:result.success,partialSuccess:result.partialSuccess,
    totalVehiclesSynced:result.totalVehiclesSynced,failedVehicleCount:result.failedVehicleCount,
    failedProviderCount:result.failedProviderCount
   });
  }catch(error){
   console.error('[GPS sync] Automatic cycle failed',{
    message:error.message,stack:error.stack
   });
  }
 },{timezone:'Asia/Kolkata'});
 console.info('[GPS sync] Backend scheduler active; cycles run every 30 minutes (Asia/Kolkata).');
}

async function start(){
 const missing=[];
 if(!String(process.env.MONGO_URI||process.env.MONGODB_URI||'').trim())missing.push('MONGO_URI or MONGODB_URI');
 for(const name of ['JWT_SECRET','ADMIN_USERNAME','ADMIN_PASSWORD']){
  if(!String(process.env[name]||'').trim())missing.push(name);
 }
 if(missing.length){
  console.error(`[startup] Missing required environment variables: ${missing.join(', ')}`);
  process.exit(1);
 }
 try{
  await mongoose.connect(process.env.MONGO_URI||process.env.MONGODB_URI,{dbName:process.env.MONGODB_DB_NAME});
  console.log('MongoDB Atlas connected successfully');
  await M.SikkaAiChat.createIndexes();
  await M.GpsSyncLock.createIndexes();
  await seedAdmin();
  startGpsSyncScheduler();
  const dist=path.join(__dirname,'../frontend/dist');
  if(process.env.NODE_ENV==='production'&&fs.existsSync(dist)){app.use(express.static(dist));app.use((req,res,next)=>{if(req.method==='GET'&&!req.path.startsWith('/api/')&&!req.path.startsWith('/share/'))return res.sendFile(path.join(dist,'index.html'));return next();});}
  const port=Number(process.env.PORT)||5000;
  app.listen(port,'0.0.0.0',()=>console.log(`SIKKA FLEET API running on 0.0.0.0:${port}`));
 }catch(e){console.error('Failed to start:',e.message);process.exit(1);}
}
start();
