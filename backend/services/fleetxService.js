const axios=require('axios');
const FormData=require('form-data');
const jwt=require('jsonwebtoken');
const M=require('../models');

const TOKEN_KEY='live-location';
const REQUEST_TIMEOUT_MS=25000;
let memoryToken=null;

function baseUrl(value){
 return String(value||process.env.FLEETX_BASE_URL||'https://api.fleetx.io').replace(/\/+$/,'');
}

function tokenExpiry(loginResponse,token){
 const payload=jwt.decode(token);
 if(Number.isFinite(payload?.exp))return new Date(payload.exp*1000);
 for(const field of ['expires_at','expiresAt','expiry']){
  const value=loginResponse?.[field];
  if(typeof value==='number'&&value>100000000000)return new Date(value);
  if(typeof value==='string'&&Number.isFinite(Date.parse(value)))return new Date(value);
 }
 for(const field of ['expires_in','expiresIn']){
  const seconds=Number(loginResponse?.[field]);
  if(Number.isFinite(seconds)&&seconds>0)return new Date(Date.now()+seconds*1000);
 }
 return null;
}

function validToken(entry){
 return Boolean(entry?.token&&(!entry.expiresAt||new Date(entry.expiresAt).getTime()>Date.now()));
}

async function login({url,force=false}){
 if(!String(process.env.FLEETX_BASIC_AUTH||'').trim()||
  !String(process.env.FLEETX_USERNAME||'').trim()||
  !String(process.env.FLEETX_PASSWORD||'').trim()){
  const error=new Error('Fleetx credentials are not configured');
  error.reason='credentials not configured';
  throw error;
 }
 if(!force&&validToken(memoryToken))return memoryToken;
 if(!force){
  const saved=await M.FleetxToken.findOne({key:TOKEN_KEY}).select('+token').lean();
  if(validToken(saved)){
   memoryToken={token:saved.token,expiresAt:saved.expiresAt||null};
   return memoryToken;
  }
 }

 const form=new FormData();
 form.append('username',process.env.FLEETX_USERNAME);
 form.append('password',process.env.FLEETX_PASSWORD);
 form.append('grant_type','password');
 let response;
 try{
  response=await axios.post(`${url}/api/v1/login`,form,{
   timeout:REQUEST_TIMEOUT_MS,
   headers:{...form.getHeaders(),Authorization:process.env.FLEETX_BASIC_AUTH,Accept:'application/json'}
  });
 }catch(error){
  const safe=new Error(error.code==='ECONNABORTED'?'Fleetx login timed out':
   error.response?.status===401||error.response?.status===403?'Fleetx authentication failed':'Fleetx login request failed');
  safe.statusCode=error.response?.status;
  safe.code=error.code;
  safe.reason=error.code==='ECONNABORTED'?'timeout':
   error.response?.status===401||error.response?.status===403?'auth failed':'login request failed';
  throw safe;
 }
 const value=response.data?.access_token;
 if(typeof value!=='string'||!value.trim()){
  const error=new Error('Fleetx login response did not contain an access token');
  error.reason='missing access token';
  throw error;
 }
 const token=value.trim();
 const entry={
  token:/^Bearer\s+/i.test(token)?token:`Bearer ${token}`,
  expiresAt:tokenExpiry(response.data,token)
 };
 await M.FleetxToken.findOneAndUpdate({key:TOKEN_KEY},{
  $set:{token:entry.token,expiresAt:entry.expiresAt}
 },{upsert:true,new:true});
 memoryToken=entry;
 return entry;
}

async function fetchLive({baseUrl:configuredBaseUrl}={}){
 const url=baseUrl(configuredBaseUrl);
 for(let attempt=0;attempt<2;attempt++){
  const cached=await login({url,force:attempt===1});
  try{
   return await axios.get(`${url}/api/v1/analytics/live`,{
    timeout:REQUEST_TIMEOUT_MS,
    headers:{authorization:cached.token,clientid:'fleetxweb',accept:'application/json'}
   });
  }catch(error){
   if(error.response?.status===401&&attempt===0){
    memoryToken=null;
    await M.FleetxToken.deleteOne({key:TOKEN_KEY});
    continue;
   }
   const safe=new Error(error.code==='ECONNABORTED'?'Fleetx live request timed out':
    error.response?.status===401?'Fleetx authentication failed':'Fleetx live request failed');
   safe.statusCode=error.response?.status;
   safe.code=error.code;
   safe.reason=error.code==='ECONNABORTED'?'timeout':
    error.response?.status===401?'auth failed':'live request failed';
   throw safe;
  }
 }
 const error=new Error('Fleetx authentication failed after refresh');
 error.reason='auth failed';
 error.statusCode=401;
 throw error;
}

module.exports={fetchLive,REQUEST_TIMEOUT_MS};
