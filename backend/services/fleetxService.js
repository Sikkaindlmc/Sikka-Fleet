const axios=require('axios');
const FormData=require('form-data');
const {normalizeVehicleNumber}=require('./vehicleIdentity');

const DEFAULT_LOGIN_URL='https://api.fleetx.io/api/v1/login';
const DEFAULT_LIVE_URL='https://api.fleetx.io/api/v1/analytics/live';
const DEFAULT_LIVE_BY_NUMBER_URL='https://api.fleetx.io/api/v1/analytics/live/byNumber';
let tokenCache=null;
let loginPromise=null;

function apiOrigin(){
 return new URL(process.env.FLEETX_API_URL||DEFAULT_LIVE_URL).origin;
}

function authorizationValue(){
 const value=String(process.env.FLEETX_BASIC_AUTH||'').trim();
 if(!value)throw new Error('FLEETX_BASIC_AUTH is not configured');
 return /^Basic\s/i.test(value)?value:`Basic ${value}`;
}

function findToken(payload){
 const sources=[payload,payload?.data,payload?.result,payload?.response,payload?.tokens,payload?.data?.tokens];
 for(const source of sources){
  const token=source?.access_token||source?.accessToken||source?.bearer_token||source?.bearerToken||source?.token;
  if(typeof token==='string'&&token.trim())return token.trim();
 }
 return null;
}

function findExpiry(payload,token,now){
 const sources=[payload,payload?.data,payload?.result,payload?.response,payload?.tokens,payload?.data?.tokens];
 for(const source of sources){
  for(const key of ['expires_at','expiresAt','expiry','exp']){
   const value=source?.[key];
   if(typeof value==='string'&&!/^\d+(?:\.\d+)?$/.test(value)){
    const parsed=Date.parse(value);
    if(Number.isFinite(parsed))return parsed;
   }
   const numeric=Number(value);
   if(Number.isFinite(numeric)&&numeric>0){
    if(key==='exp')return numeric*1000;
    return numeric>1e12?numeric:numeric>1e9?numeric*1000:now+numeric*1000;
   }
  }
  for(const key of ['expires_in','expiresIn','expires_in_seconds']){
   const seconds=Number(source?.[key]);
   if(Number.isFinite(seconds)&&seconds>0)return now+seconds*1000;
  }
 }
 const jwtPayload=token.split('.')[1];
 if(jwtPayload){
  try{
   const exp=Number(JSON.parse(Buffer.from(jwtPayload,'base64url').toString('utf8')).exp);
   if(Number.isFinite(exp)&&exp>0)return exp*1000;
  }catch{}
 }
 return now+30*60*1000;
}

function wrapError(operation,error){
 const status=error.response?.status||error.statusCode||0;
 const body=error.response?.data;
 const message=body?.message||body?.error||error.message||'Request failed';
 const wrapped=new Error(`${operation}${status?` (HTTP ${status})`:''}: ${String(message).slice(0,300)}`);
 wrapped.statusCode=status;
 if(status)wrapped.response={status,data:{message:String(message).slice(0,300)}};
 return wrapped;
}

async function submitLogin(){
 const username=process.env.FLEETX_USERNAME;
 const password=process.env.FLEETX_PASSWORD;
 if(!username||!password)throw new Error('FLEETX_USERNAME and FLEETX_PASSWORD are required');
 const url=process.env.FLEETX_LOGIN_URL||DEFAULT_LOGIN_URL;
 const authorization=authorizationValue();
 const grantType=process.env.FLEETX_GRANT_TYPE||'password';
 const form=new FormData();
 form.append('username',username);
 form.append('password',password);
 form.append('grant_type',grantType);
 try{
  return await axios.post(url,form,{
   headers:{...form.getHeaders(),Authorization:authorization,Accept:'application/json'},
   timeout:20000
  });
 }catch(error){
  if(![400,415,422].includes(error.response?.status))throw wrapError('FleetX login',error);
  const body=new URLSearchParams({username,password,grant_type:grantType});
  try{
   return await axios.post(url,body,{
    headers:{Authorization:authorization,Accept:'application/json','Content-Type':'application/x-www-form-urlencoded'},
    timeout:20000
   });
  }catch(fallbackError){throw wrapError('FleetX login',fallbackError)}
 }
}

async function login(){
 let response;
 try{response=await submitLogin()}
 catch(error){throw error.statusCode!==undefined?error:wrapError('FleetX login',error)}
 const token=findToken(response.data);
 if(!token)throw new Error('FleetX login (HTTP 502): response did not contain an access token');
 const now=Date.now();
 const expiresAt=findExpiry(response.data,token,now);
 const refreshMargin=Math.min(60000,Math.max(1000,(expiresAt-now)*0.1));
 tokenCache={value:token,expiresAt:expiresAt-refreshMargin};
 return token;
}

async function getAccessToken(){
 if(tokenCache&&Date.now()<tokenCache.expiresAt)return tokenCache.value;
 if(!loginPromise)loginPromise=login().finally(()=>{loginPromise=null});
 return loginPromise;
}

async function refreshAfter401(rejectedToken){
 if(tokenCache&&tokenCache.value!==rejectedToken&&Date.now()<tokenCache.expiresAt)return tokenCache.value;
 tokenCache=null;
 return getAccessToken();
}

async function request(url,config={},retried=false){
 let token;
 try{token=await getAccessToken()}
 catch(error){throw error.statusCode!==undefined?error:wrapError('FleetX login',error)}
 try{
  return await axios.get(url,{
   ...config,
   timeout:config.timeout||25000,
   headers:{Accept:'application/json',Authorization:`Bearer ${token}`,clientid:'fleetxweb',...(config.headers||{})}
  });
 }catch(error){
  if(error.response?.status===401&&!retried){
   await refreshAfter401(token);
   return request(url,config,true);
  }
  throw wrapError('FleetX request',error);
 }
}

function findRows(value,depth=0){
 if(Array.isArray(value))return value;
 if(!value||typeof value!=='object'||depth>5)return null;
 for(const key of ['data','vehicles','items','results','response','result','list','records','content','vehicleList','vehicleDetails']){
  const rows=findRows(value[key],depth+1);
  if(rows)return rows;
 }
 return null;
}

function firstValue(...values){
 return values.find(value=>value!==undefined&&value!==null&&value!=='');
}

function toDate(value){
 if(value==null||value==='')return null;
 const numeric=Number(value);
 const date=Number.isFinite(numeric)
  ?new Date(numeric>0&&numeric<1e11?numeric*1000:numeric)
  :new Date(value);
 return Number.isFinite(date.getTime())?date:null;
}

function normalizeIgnition(value){
 if(value==null||value==='')return 'N/A';
 if(value===true||value===1)return 'ON';
 if(value===false||value===0)return 'OFF';
 const status=String(value).trim().toLowerCase();
 if(/^(on|true|1|running)$/.test(status))return 'ON';
 if(/^(off|false|0|stopped)$/.test(status))return 'OFF';
 return 'N/A';
}

function normalizeRunningStatus(value,speed,ignition){
 const status=String(value||'').toLowerCase();
 if(status.includes('moving')||status.includes('running'))return 'Moving';
 if(status.includes('idle'))return 'Idle';
 if(status.includes('stopped')||status==='stop')return 'Stopped';
 const numericSpeed=Number(speed);
 if(Number.isFinite(numericSpeed)&&numericSpeed>0)return 'Moving';
 if(Number.isFinite(numericSpeed)&&numericSpeed===0)return ignition==='ON'?'Idle':'Stopped';
 return 'Unknown';
}

function mapLiveRecords(payload,vehicleNumberHint=''){
 const rows=findRows(payload)||[payload].filter(Boolean);
 return rows.map(record=>{
  const rawAddress=firstValue(record.readableLocation,record.formattedAddress,record.fullAddress,record.address,record.currentAddress,record.ADDRESS,record.location?.address);
  const address=typeof rawAddress==='string'?rawAddress:'';
  const parts=record.address&&typeof record.address==='object'?record.address:{};
  const speed=firstValue(record.speed,record.vehicleSpeed,record.currentSpeed,record.speedKph,record.SPEED);
  const ignition=normalizeIgnition(firstValue(record.ignition,record.ignitionStatus,record.engineStatus,record.engine_status,record.IGNITION,record.IGNITION_STATUS,record.ignition_status));
  const time=firstValue(record.gpsTime,record.timestamp,record.time,record.locationTime,record.lastSeen,record.updatedAt,record.lastUpdate,record.deviceTime,record.TIMESTAMP,record.TIME,record.CREATE_DATE,record.gps_time,record.dttimeInEpoch,record.dttime,record.createdDate,record.createdDateReadable);
  const status=firstValue(record.runningStatus,record.running_status,record.movementStatus,record.MOVEMENT_STATUS);
  return {
   vehicleNumber:normalizeVehicleNumber(firstValue(record.vehicleNumber,record.vehicleNo,record.registrationNo,record.registration_number,record.vehicle_number,record.vehicle,record.rcNumber,record.name,record.VEHICLE_NUMBER,record.VEHICLE_NAME,record.vehicle_name,vehicleNumberHint)),
   lat:Number(firstValue(record.latitude,record.lat,record.LATITUDE,record.location?.lat,record.location?.latitude,record.gpsLocation?.lat,record.currentLocation?.lat)),
   lng:Number(firstValue(record.longitude,record.lng,record.lon,record.LONGITUDE,record.location?.lng,record.location?.longitude,record.gpsLocation?.lng,record.currentLocation?.lng)),
   speed:speed==null?'N/A':String(speed),
   ignition:ignition==null?'N/A':String(ignition),
   gpsTime:toDate(time),
   provider:'FleetX',
   heading:Number(firstValue(record.heading,record.course,record.bearing,record.COURSE))||0,
   providerAddress:address,
   providerFields:{
    locality:record.locality||record.LOCALITY||parts.locality||parts.suburb||'',
    city:record.city||record.CITY||parts.city||'',
    district:record.district||record.DISTRICT||parts.district||'',
    state:record.state||record.STATE||parts.state||'',
    pincode:record.pincode||record.pinCode||record.postalCode||record.POSTCODE||'',
    country:record.country||record.COUNTRY||parts.country||''
   },
   providerVehicleId:firstValue(record.vehicleId,record.VEHICLE_ID,record.DEVICE_ID,record.vehicle_id,record.id),
   driverName:firstValue(record.driverName,record.DRIVER_NAME,record.driver_name),
   vehicleStatus:firstValue(record.vehicleStatus,record.STATUS,record.status),
   runningStatus:normalizeRunningStatus(status,speed,ignition)
  };
 }).filter(record=>record.vehicleNumber&&Number.isFinite(record.lat)&&record.lat>=-90&&record.lat<=90&&Number.isFinite(record.lng)&&record.lng>=-180&&record.lng<=180&&record.gpsTime instanceof Date);
}

function fetchLive(){
 return request(process.env.FLEETX_API_URL||DEFAULT_LIVE_URL);
}

function fetchLiveByNumber(vehicleNumber){
 const normalized=normalizeVehicleNumber(vehicleNumber);
 if(!normalized)throw new Error('A valid vehicle number is required for FleetX live lookup');
 const base=process.env.FLEETX_LIVE_BY_NUMBER_URL||DEFAULT_LIVE_BY_NUMBER_URL;
 return request(`${base.replace(/\/+$/,'')}/${encodeURIComponent(normalized)}`);
}

function fetchHistory({vehicleId,from,to,skipOBD=true}){
 const fields='COURSE,TYPE,LATITUDE,LONGITUDE,CREATE_DATE,DEVICE_ID,TIMESTAMP,STATUS,SPEED,VEHICLE_ID,VEHICLE_NAME,VEHICLE_NUMBER,DRIVER_NAME,DURATION_ENGINE_ON,TOTAL_ODOMETER,CURRENT_ODOMETER';
 return request(`${apiOrigin()}/api/v2/trips/merged`,{params:{from,to,vehicleId,skipOBD:String(skipOBD),fields}});
}

module.exports={fetchLive,fetchLiveByNumber,fetchHistory,getAccessToken,mapLiveRecords,normalizeVehicleNumber};
