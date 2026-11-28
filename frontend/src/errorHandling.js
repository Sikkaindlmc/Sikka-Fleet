const DEFAULT_ERROR_MESSAGE='Something went wrong. Please try again.';

function isRecord(value){
 return value!==null&&typeof value==='object'&&!Array.isArray(value);
}

function objectRows(value){
 return Array.isArray(value)?value.filter(isRecord):[];
}

function collectMessages(value,messages=[],seen=new Set()){
 if(typeof value==='string'||typeof value==='number'){
  const message=String(value).trim();
  if(message&&!/^\s*<(?:!doctype|html|head|body)\b/i.test(message))messages.push(message);
  return messages;
 }
 if(!value||typeof value!=='object'||seen.has(value))return messages;
 seen.add(value);
 if(Array.isArray(value)){
  for(const item of value)collectMessages(item,messages,seen);
  return messages;
 }
 const message=value.message||value.msg||value.error||value.reason||value.detail;
 if(typeof message==='string'&&message.trim()){
  const vehicleNumber=typeof value.vehicleNumber==='string'?value.vehicleNumber.trim():'';
  messages.push(vehicleNumber?`${vehicleNumber}: ${message.trim()}`:message.trim());
  return messages;
 }
 for(const item of Object.values(value))collectMessages(item,messages,seen);
 return messages;
}

function statusMessage(status){
 if(status===400)return 'The request could not be processed.';
 if(status===401)return 'Your session has expired. Please sign in again.';
 if(status===403)return 'You do not have permission to complete this request.';
 if(status===404)return 'The requested resource could not be found.';
 if(status===422)return 'Please check the submitted information and try again.';
 if(status===429)return 'Too many requests. Please wait and try again.';
 if(Number(status)>=500)return 'The server is temporarily unavailable. Please try again.';
 return '';
}

export function getErrorMessage(error,fallback=DEFAULT_ERROR_MESSAGE){
 const responseData=error?.response?.data;
 const responseIsRecord=isRecord(responseData);
 const responseMessages=collectMessages(responseIsRecord
  ?[
   responseData.message,responseData.error,responseData.reason,responseData.errors,
   isRecord(responseData.result)?responseData.result.message:null
  ]
  :responseData
 );
 if(responseMessages.length)return responseMessages.join('; ');
 const statusFallback=statusMessage(error?.response?.status);
 if(statusFallback)return statusFallback;
 if(error?.isApiResponseError&&typeof error.message==='string'&&error.message.trim()){
  return error.message.trim();
 }
 if(!error?.response&&error?.request)return 'Unable to reach the server. Please try again.';
 const messages=collectMessages([
  error?.message,error?.error,error?.reason,
  isRecord(error?.result)?error.result.message:null,error?.errors
 ]);
 if(messages.length)return messages.join('; ');
 return fallback||DEFAULT_ERROR_MESSAGE;
}

export function isGpsSyncSuccessful(response){
 return response?.success===true&&response?.started!==false&&isRecord(response.result)&&
  Object.values(response.result).some(isRecord);
}

export function getGpsSyncErrorDetails(response){
 const providerResults=isRecord(response?.result)?Object.values(response.result):[];
 const details=[];
 for(const providerResult of providerResults){
  if(!isRecord(providerResult))continue;
  details.push(...collectMessages(providerResult.errors));
 }
 return details;
}

export function isRecordResponse(value){
 return isRecord(value);
}

export function normalizeDashboardData(value){
 const validResponse=isRecord(value);
 const response=validResponse?value:{};
 const validTransit=isRecord(response.transit);
 const transit=validTransit?response.transit:{};
 const count=value=>{
  const number=Number(value);
  return Number.isFinite(number)&&number>=0?number:0;
 };
 return {
  ...response,
  plantsAvailable:validResponse&&Array.isArray(response.plants),
  transitAvailable:validResponse&&validTransit&&Array.isArray(transit.rows),
  plants:objectRows(response.plants).map(plant=>({
   ...plant,count:count(plant.count),rows:objectRows(plant.rows)
  })),
  transit:{...transit,count:count(transit.count),rows:objectRows(transit.rows)}
 };
}
