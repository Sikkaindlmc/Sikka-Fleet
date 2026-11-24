const M=require('../models');
const fleetSnapshotService=require('./fleetSnapshotService');
const {
 normalizeVehicleNumber,groupByVehicleNumber,vehicleNumberRegex
}=require('./vehicleIdentity');
const {GPS_SYNC_INTERVAL_MS}=require('./gpsSyncSchedule');

const DAY_MS=24*60*60*1000;
const CHAT_TTL_MS=7*DAY_MS;
const HISTORY_ACCESS_DAYS=45;
const HISTORY_LIMIT_REPLY='Requested date is outside the permitted 45-day GPS history period.';
const FUTURE_HISTORY_REPLY='Future GPS history is not available. Sikka AI can only provide current GPS information and actual historical records from the last 45 days.';
const TIME_ZONE='Asia/Kolkata';
const GPS_PROVIDER='Wheelseye';
const UNKNOWN_REPLY='I could not match that question to available fleet records.';
const SENSITIVE_INPUT=/\b(password|passwd|passcode|secret|api[\s_-]?key|token|authorization|bearer|jwt)\b/i;
const MONTHS=['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
const MONTH_PATTERN='january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec';
const HINDI_WORDS=[
 [/गाड़ियों|गाड़ियां|गाड़ियाँ|गाड़ी|गाड़ी|गाड़ियां/gu,' gaadi '],
 [/वाहनों|वाहन/gu,' vehicle '],
 [/प्लांट|संयंत्र|कारखाना/gu,' plant '],
 [/आज/gu,' aaj '],
 [/परसों|परसो/gu,' parso '],
 [/कल/gu,' kal '],
 [/बाहर/gu,' bahar '],
 [/गईं|गई|गए|गया|निकली|निकले/gu,' left '],
 [/कितनी/gu,' kitni '],
 [/कितने/gu,' kitne '],
 [/कौन/gu,' kaun '],
 [/कहाँ|कहां/gu,' kahan '],
 [/अभी/gu,' abhi '],
 [/उपलब्ध/gu,' available '],
 [/सूची/gu,' list '],
 [/इतिहास/gu,' history '],
 [/स्थान|लोकेशन/gu,' location '],
 [/पिछले|पिछली/gu,' pichle '],
 [/सभी|सब/gu,' sabhi '],
 [/से/gu,' se '],
 [/तक/gu,' tak '],
 [/हैं|है/gu,' hai '],
 [/थी|था|थे/gu,' tha '],
 [/आजतक/gu,' today ']
];

function normalizeText(value){
 let text=String(value||'');
 for(const [pattern,replacement] of HINDI_WORDS)text=text.replace(pattern,replacement);
 return text.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
}

function detectLanguage(value,previousLanguage){
 const text=String(value||'');
 if(/[\u0900-\u097f]/u.test(text))return 'hi';
 const query=normalizeText(text);
 if(/\b(aaj|kal|parso|gadi|gaadi|kahan|kitni|kitne|kaun|hai|mein|bahar|gaya|gayi|gaye|pichle|pichhli|tha|thi|sabhi|se|tak)\b/.test(query))return 'hi';
 if(/\b(how|what|where|when|who|vehicles?|available|availability|location|history|outside|today|yesterday|show|list|count|plant)\b/.test(query))return 'en';
 return previousLanguage==='hi'?'hi':'en';
}

function isOlderThanAccessLimit(date,now){
 return date instanceof Date&&date.getTime()<getHistoryCutoff(now).getTime();
}

function localized(language,english,hindi){
 return language==='hi'?hindi:english;
}

function hasPageAccess(permissions,page){
 return !permissions||permissions[page]===true;
}

function containsSensitiveInput(value){
 return SENSITIVE_INPUT.test(String(value||''));
}

function getChatExpiry(createdAt){
 return new Date(new Date(createdAt).getTime()+CHAT_TTL_MS);
}

function istParts(date){
 const parts=new Intl.DateTimeFormat('en-CA',{
  timeZone:TIME_ZONE,year:'numeric',month:'2-digit',day:'2-digit'
 }).formatToParts(date);
 return Object.fromEntries(parts.filter(part=>part.type!=='literal').map(part=>[part.type,Number(part.value)]));
}

function istDateKey(date){
 const {year,month,day}=istParts(date);
 return `${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
}

function fromIstParts(year,month,day,hour=0,minute=0,second=0,millisecond=0){
 const date=new Date(Date.UTC(year,month-1,day,hour,minute,second,millisecond)-330*60*1000);
 const parts=istParts(date);
 if(parts.year!==year||parts.month!==month||parts.day!==day)return null;
 return date;
}

function parseDateValue(match){
 let year,month,day;
 if(match[4]){
  year=Number(match[4]);month=Number(match[5]);day=Number(match[6]);
 }else{
  day=Number(match[1]);month=Number(match[2]);year=Number(match[3]);
 }
 const start=fromIstParts(year,month,day);
 return start?{year,month,day,start}:null;
}

function parseClock(text){
 const twelveHour=/\b(?:at\s*)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i.exec(text);
 if(twelveHour){
  let hour=Number(twelveHour[1]);
  const minute=Number(twelveHour[2]||0);
  if(hour<1||hour>12||minute>59)return null;
  const suffix=twelveHour[3].toLowerCase();
  if(suffix==='pm'&&hour<12)hour+=12;
  if(suffix==='am'&&hour===12)hour=0;
  return {hour,minute};
 }
 const twentyFourHour=/\b(?:at\s*)?([01]?\d|2[0-3]):([0-5]\d)\b/i.exec(text);
 return twentyFourHour?{hour:Number(twentyFourHour[1]),minute:Number(twentyFourHour[2])}:null;
}

function parseDateRequest(text,now=new Date()){
 const query=normalizeText(text);
 const explicit=[];
 const datePattern=/\b(\d{1,2})[-/](\d{1,2})[-/](\d{4})\b|\b(\d{4})-(\d{2})-(\d{2})\b/g;
 for(const match of text.matchAll(datePattern)){
  const parsed=parseDateValue(match);
  if(parsed&&!explicit.some(item=>item.start.getTime()===parsed.start.getTime()))explicit.push(parsed);
 }
 const {year:currentYear}=istParts(now);
 const monthNumber=value=>{
  const month=value.toLowerCase().slice(0,3);
  return month==='sep'?9:MONTHS.indexOf(month)+1;
 };
 const addMonthDate=(dayValue,monthValue,yearValue)=>{
  const year=Number(yearValue)||currentYear;
  const month=monthNumber(monthValue);
  const day=Number(dayValue);
  const start=fromIstParts(year,month,day);
  if(start&&!explicit.some(item=>item.start.getTime()===start.getTime()))explicit.push({year,month,day,start});
 };
 for(const match of text.matchAll(new RegExp(`\\b(\\d{1,2})\\s+(${MONTH_PATTERN})(?:\\s+(\\d{4}))?\\b`,'gi'))){
  addMonthDate(match[1],match[2],match[3]);
 }
 for(const match of text.matchAll(new RegExp(`\\b(${MONTH_PATTERN})\\s+(\\d{1,2})(?:,?\\s+(\\d{4}))?\\b`,'gi'))){
  addMonthDate(match[2],match[1],match[3]);
 }
 const historyContext=/\b(history|route|past|back|yesterday|kal|pichle|pichhli|tha|thi|the|se|tak)\b/.test(query);
 let relativeOffset=null;
 let relativeFuture=false;
 if(/\b(day before yesterday|parso)\b/.test(query)&&historyContext){
  relativeOffset=-2;
 }else if(/\b(yesterday|yesterday ki|kal)\b/.test(query)&&historyContext){
  relativeOffset=-1;
 }else if(/\b(today|aaj)\b/.test(query)){
  relativeOffset=0;
 }else if(/\b(day after tomorrow|after tomorrow|parso)\b/.test(query)){
  relativeOffset=historyContext?-2:2;
  relativeFuture=!historyContext;
 }else if(/\b(tomorrow|kal)\b/.test(query)){
  relativeOffset=1;
  relativeFuture=true;
 }
 if(!explicit.length&&relativeOffset===null)return {found:false,future:false};

 const clock=parseClock(text);
 const {year:todayYear,month:todayMonth,day:todayDay}=istParts(now);
 const todayStart=fromIstParts(todayYear,todayMonth,todayDay);
 const dates=explicit.length?explicit:[(()=>{
  const date=new Date(todayStart.getTime()+relativeOffset*DAY_MS);
  return {...istParts(date),start:date};
 })()];
 const first=dates[0];
 const last=dates.length>1?dates[dates.length-1]:first;
 const hasTime=Boolean(clock&&dates.length===1);
 const instant=hasTime?fromIstParts(first.year,first.month,first.day,clock.hour,clock.minute):null;
 const start=first.start;
 const end=fromIstParts(last.year,last.month,last.day,23,59,59,999);
 const todayKey=istDateKey(now);
 const future=relativeFuture||
  (istDateKey(last.start)>todayKey)||
  Boolean(instant&&instant>now);
 return {found:true,start,end,instant,hasTime,future,from:first.start,to:last.start};
}

function levenshtein(left,right){
 const previous=Array.from({length:right.length+1},(_,index)=>index);
 for(let i=1;i<=left.length;i++){
  let diagonal=previous[0];
  previous[0]=i;
  for(let j=1;j<=right.length;j++){
   const above=previous[j];
   previous[j]=Math.min(previous[j]+1,previous[j-1]+1,diagonal+(left[i-1]===right[j-1]?0:1));
   diagonal=above;
  }
 }
 return previous[right.length];
}

function matchPlant(query,plants){
 const normalizedQuery=normalizeText(query);
 const queryWords=normalizedQuery.split(' ');
 let best=null;
 let bestScore=0;
 let tied=false;
 for(const plant of plants){
  const names=[plant.name,plant.code,plant.plantId].filter(Boolean);
  let score=0;
  for(const name of names){
   const normalizedName=normalizeText(name);
   if(normalizedName.length>2&&normalizedQuery.includes(normalizedName)){
    score=Math.max(score,100+normalizedName.length);
    continue;
   }
   const words=normalizedName.split(' ').filter(word=>word!=='plant'&&word.length>2&&!/^\d+$/.test(word));
   if(!words.length)continue;
   const matches=words.map(word=>{
    const maxDistance=word.length>7?2:1;
    return queryWords.some(queryWord=>queryWord.length>2&&levenshtein(word,queryWord)<=maxDistance);
   });
   const ratio=matches.filter(Boolean).length/words.length;
   if(ratio>=0.5)score=Math.max(score,ratio*10+words.filter(Boolean).join('').length/100);
  }
  if(score>bestScore){best=plant;bestScore=score;tied=false}
  else if(score&&score===bestScore)tied=true;
 }
 return tied?null:best;
}

function extractVehicleNumber(text){
 const matches=String(text||'').toUpperCase().match(/[A-Z]{2}[\s.-]*\d{1,2}[\s.-]*[A-Z]{0,3}[\s.-]*\d{1,4}/g)||[];
 return matches.map(normalizeVehicleNumber).find(value=>value.length>=7)||null;
}

function durationAt(start,end){
 const milliseconds=Math.max(0,end.getTime()-new Date(start).getTime());
 return {hours:Math.floor(milliseconds/3600000),minutes:Math.floor(milliseconds%3600000/60000)};
}

function formatDuration(value){
 return `${value.hours} h ${value.minutes} m`;
}

function readableLocation(record){
 const value=record?.readableLocation||record?.address;
 return typeof value==='string'&&value.trim()&&!/^\s*-?\d+(?:\.\d+)?\s*,\s*-?\d+(?:\.\d+)?\s*$/.test(value)
  ?value.trim():'Readable location unavailable';
}

function validCoordinates(lat,lng){
 return lat!=null&&lng!=null&&Number.isFinite(Number(lat))&&Number.isFinite(Number(lng))&&
  Number(lat)>=-90&&Number(lat)<=90&&Number(lng)>=-180&&Number(lng)<=180;
}

function hasGpsConfiguration(vehicle){
 return vehicle?.gpsLink===GPS_PROVIDER||
  (vehicle?.gpsProviders||[]).some(provider=>provider?.name===GPS_PROVIDER);
}

function isSupportedGpsRecord(record){
 return !record?.provider||record.provider===GPS_PROVIDER;
}

function isCurrentGpsRecord(record,now){
 const gpsTime=new Date(record?.gpsTime).getTime();
 return Boolean(record&&!record.stale&&validCoordinates(record.lat,record.lng)&&
  Number.isFinite(gpsTime)&&gpsTime<=now.getTime()&&
  now.getTime()-gpsTime<=GPS_SYNC_INTERVAL_MS*2);
}

function latestGpsRecord(records,now){
 return [...records].filter(record=>{
  const gpsTime=new Date(record?.gpsTime).getTime();
  return Number.isFinite(gpsTime)&&gpsTime<=now.getTime();
 }).sort((a,b)=>
  Number(validCoordinates(b.lat,b.lng))-Number(validCoordinates(a.lat,a.lng))||
  new Date(b.gpsTime)-new Date(a.gpsTime)||
  new Date(b.syncedAt||b.updatedAt||0)-new Date(a.syncedAt||a.updatedAt||0)
 )[0]||null;
}

function distanceMeters(first,second){
 const radians=value=>value*Math.PI/180;
 const latDelta=radians(Number(second.lat)-Number(first.lat));
 const lngDelta=radians(Number(second.lng)-Number(first.lng));
 const value=Math.sin(latDelta/2)**2+
  Math.cos(radians(Number(first.lat)))*Math.cos(radians(Number(second.lat)))*Math.sin(lngDelta/2)**2;
 return 6371000*2*Math.atan2(Math.sqrt(value),Math.sqrt(1-value));
}

async function getAiGpsVehicleRows(models,now){
 const [registered,liveRecords,plants,openStays]=await Promise.all([
  models.Vehicle.find({status:'Active'})
   .select('vehicleNumber gpsLink gpsProviders status').lean(),
  models.VehicleLiveStatus.find({})
   .select('vehicleNumber lat lng address readableLocation gpsTime syncedAt updatedAt stale provider speed ignition runningStatus vehicleStatus').lean(),
  models.Plant.find({status:'Active'}).lean(),
  models.VehiclePlantStay.find({exitTime:null}).populate('plant').lean()
 ]);
 const registeredByNumber=groupByVehicleNumber(registered);
 const liveByNumber=groupByVehicleNumber(liveRecords,record=>record.vehicleNumber);
 const staysByNumber=groupByVehicleNumber(openStays,stay=>stay.vehicle);
 const cutoff=getHistoryCutoff(now);
 const rows=[];
 for(const [vehicleNumber,vehicles] of registeredByNumber){
  const vehicle=vehicles[0];
  const records=(liveByNumber.get(vehicleNumber)||[]).filter(isSupportedGpsRecord);
  const lastGps=latestGpsRecord(records,now);
  if(!hasGpsConfiguration(vehicle)&&!records.some(record=>record.provider||validCoordinates(record.lat,record.lng)))continue;
  const current=isCurrentGpsRecord(lastGps,now);
  const currentStays=staysByNumber.get(vehicleNumber)||[];
  const candidatePlants=[];
  let confirmedPlant=null;
  if(current){
   for(const plant of plants){
    if(!validCoordinates(plant.lat,plant.lng)||!Number.isFinite(Number(plant.radius)))continue;
    const insideGeofence=distanceMeters(lastGps,plant)<=Number(plant.radius);
    if(!insideGeofence)continue;
    const recordedStay=currentStays.find(stay=>String(stay.plant?._id||stay.plant)===String(plant._id));
    if(recordedStay){
     confirmedPlant=plant;
     candidatePlants.push({plant,stay:recordedStay,confirmed:true});
    }else candidatePlants.push({plant,stay:null,confirmed:false});
   }
  }
  for(const stay of currentStays){
   const plant=plants.find(item=>String(item._id)===String(stay.plant?._id||stay.plant));
   if(plant&&!candidatePlants.some(item=>String(item.plant._id)===String(plant._id))){
    candidatePlants.push({plant,stay,confirmed:false});
   }
  }
  const provider=lastGps?.provider||vehicle.gpsLink||
   (vehicle.gpsProviders||[]).find(item=>item?.name===GPS_PROVIDER)?.name||'N/A';
  const status=current
   ?lastGps.runningStatus||'GPS current'
   :lastGps?'Stale':'GPS data unavailable';
  const base={
   vehicleNumber,provider,lat:lastGps?.lat??null,lng:lastGps?.lng??null,
   location:lastGps?readableLocation(lastGps):null,
   gpsTime:lastGps?.gpsTime||null,lastUpdate:lastGps?.syncedAt||lastGps?.updatedAt||null,
   status,stale:Boolean(lastGps&&!current),currentGps:current,
   plantName:confirmedPlant?.name||null,
   availabilityStatus:confirmedPlant?'Available (confirmed)':candidatePlants.length?'Availability not confirmed':'Not confirmed at a plant'
  };
  rows.push({...base,candidatePlants:candidatePlants.map(item=>({
   plantName:item.plant.name,
   entryTime:item.stay&&new Date(item.stay.entryTime)>=cutoff?item.stay.entryTime:null,
   confirmed:item.confirmed
  }))});
 }
 return rows.sort((a,b)=>a.vehicleNumber.localeCompare(b.vehicleNumber));
}

function mapHistoryRecord(record){
 return {
  vehicleNumber:record.vehicleNumber||record.vehicle,
  time:record.gpsTime,
  lastUpdate:record.syncedAt||null,
  address:readableLocation(record),
  lat:record.lat??null,
  lng:record.lng??null,
  provider:record.provider||'N/A',
  status:record.vehicleStatus||'N/A',
  speed:record.speed??'N/A',
  ignition:record.ignition??'N/A',
  lat:record.lat,
  lng:record.lng,
  map:validCoordinates(record.lat,record.lng)
   ?`https://www.google.com/maps?q=${record.lat},${record.lng}`:null
 };
}

function isAvailabilityQuestion(text){
 return /\b(available|availability|vehicle|vehicles|list|gadi|gaadi|gaadiyan|kaun|how many|currently|now|plant mein|mein kaun|kitni|kitne|left)\b/.test(normalizeText(text));
}

function asksAllPlants(text){
 const query=normalizeText(text);
 return /\b(all|every|sabhi|sab|saare|har)\s+plants?\b/.test(query)||
  /\b(each|every|har)\s+plants?\b/.test(query)||
  /\bplantwise\b|\bplant wise\b/.test(query)||
  /\b(inside|within)\s+(?:a\s+)?plant geofence\b/.test(query);
}

function isHistoryQuestion(text){
 return /\b(history|route|past|back date|pichhli|pichle|kahan tha|kahan thi|location history)\b/.test(normalizeText(text));
}

function isLocationQuestion(text){
 const query=normalizeText(text);
 if(/\b(where|kahan|location|position|track)\b/.test(query))return true;
 return /\b(current|currently|now|live|abhi)\b/.test(query)&&
  /\b(vehicle|vehicles|gadi|gaadi|gaadiyan)\b/.test(query)&&
  !/\b(available|availability|plant|how many|list)\b/.test(query);
}

function isOutsideQuestion(text){
 return /\b(outside|transit|bahar)\b/.test(normalizeText(text));
}

function isGpsVehicleListQuestion(text){
 const query=normalizeText(text);
 return /\b(all|every|show|list|registered|give me|sabhi|sab|saare)\b/.test(query)&&
  /\b(vehicle|vehicles|gadi|gaadi|gps)\b/.test(query)&&
  !/\bplant\b/.test(query);
}

function isExitQuestion(text){
 return /\b(went|left|exit|exited|leaving|left|gaya|gayi|gaye|nikal|nikli|nikle)\b/.test(normalizeText(text));
}

function isPlantDetailsQuestion(text){
 return /\b(details?|address|coordinates|radius|plant info|plant location|pata|jaankari)\b/.test(normalizeText(text));
}

function answerText(text,type='text',extra={},language='en'){
 return {text:text||UNKNOWN_REPLY,type,language,...extra};
}

function vehicleSuggestions(numbers,language,history=false){
 return numbers.slice(0,4).map(number=>({
  label:number,
  question:language==='hi'
   ?history?`${number} की हाल की हिस्ट्री`:`${number} कहाँ है?`
   :history?`${number} vehicle history`:`Where is ${number}?`
 }));
}

function plantSuggestions(plants,language){
 return plants.map(plant=>({
  label:plant.name,
  question:language==='hi'?`${plant.name} में कौन-सी गाड़ियाँ उपलब्ध हैं?`:`Which vehicles are available at ${plant.name}?`
 }));
}

function buildClarificationSuggestions(query,language,plants=[],vehicles=[]){
 const normalized=normalizeText(query);
 const wantsPlant=/\b(plant|availability|outside|bahar|kitni|kitne)\b/.test(normalized);
 const wantsVehicle=/\b(vehicle|vehicles|gadi|gaadi|history|location|where|kahan|route)\b/.test(normalized);
 let suggestions=[];
 if(wantsPlant&&plants.length)suggestions=plantSuggestions(plants,language);
 if(wantsVehicle&&vehicles.length)suggestions=vehicleSuggestions(vehicles,language,isHistoryQuestion(query));
 if(!suggestions.length){
  if(plants.length)suggestions.push(...plantSuggestions(plants.slice(0,2),language));
  if(vehicles.length)suggestions.push(...vehicleSuggestions(vehicles.slice(0,2),language));
 }
 return suggestions.slice(0,4);
}

async function getClarificationSuggestions(models,permissions,query,language){
 const plantsAllowed=hasPageAccess(permissions,'dashboard');
 const gpsAllowed=hasPageAccess(permissions,'gpsTrack');
 const [plants,vehicles]=await Promise.all([
  plantsAllowed?fleetSnapshotService.getActivePlantRecords(models):Promise.resolve([]),
  gpsAllowed?models.Vehicle.find({status:'Active'}).select('vehicleNumber').lean():Promise.resolve([])
 ]);
 return buildClarificationSuggestions(
  query,language,plants,[...groupByVehicleNumber(vehicles).keys()]
 );
}

function getHistoryCutoff(now=new Date()){
 const {year,month,day}=istParts(now);
 return new Date(Date.UTC(year,month-1,day-HISTORY_ACCESS_DAYS)-330*60*1000);
}

function protectedStayFields(row,cutoff,language){
 if(!row.entryTime||new Date(row.entryTime)>=cutoff)return row;
 return {
  ...row,entryTime:null,stayHours:null,stayMinutes:null,
  stay:localized(language,'45+ days','45 दिनों से अधिक')
 };
}

function accessDenied(language,source){
 const labels={
  dashboard:localized(language,'Dashboard plant data','डैशबोर्ड प्लांट डेटा'),
  gpsTrack:localized(language,'GPS Track data','GPS Track डेटा'),
  plant:localized(language,'Plant data','प्लांट डेटा')
 };
 return answerText(
  localized(language,`You do not have permission to access ${labels[source]}.`,`आपको ${labels[source]} देखने की अनुमति नहीं है।`),
  'forbidden',{},language
 );
}

function cleanChatQuestion(value){
 return String(value||'').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g,' ');
}

async function answerQuestion(question,{models=M,now=new Date(),previousLanguage,permissions}={}){
 const query=String(question||'').trim();
 const language=detectLanguage(query,previousLanguage);
 if(!query.trim())return answerText(
  localized(language,'Please ask a question about a vehicle or plant.','कृपया किसी वाहन या प्लांट के बारे में सवाल पूछें।'),
  'clarification',{},language
 );
 const normalized=normalizeText(query);
 const dateRequest=parseDateRequest(query,now);
 if(dateRequest.future)return answerText(
  localized(language,FUTURE_HISTORY_REPLY,'भविष्य की GPS हिस्ट्री उपलब्ध नहीं है। Sikka AI केवल वर्तमान GPS जानकारी और पिछले 45 दिनों के वास्तविक ऐतिहासिक रिकॉर्ड दे सकता है।'),
  'future',{},language
 );
 const vehicleNumber=extractVehicleNumber(query);
 const historyQuestion=isHistoryQuestion(query);
 const availabilityQuestion=isAvailabilityQuestion(query);
 const hasPlantWord=/\bplant\b/.test(normalized);
 const allPlantsQuestion=asksAllPlants(query)||/\bplant availability now\b/.test(normalized);
 const outsideQuestion=isOutsideQuestion(query);
 const exitQuestion=outsideQuestion&&(isExitQuestion(query)||dateRequest.found);
 const historicalVehicle=Boolean(vehicleNumber&&(historyQuestion||dateRequest.found));
 const allFleetHistoryQuestion=Boolean(!vehicleNumber&&historyQuestion&&isGpsVehicleListQuestion(query));
 const historicalPlant=Boolean(dateRequest.found&&hasPlantWord&&!vehicleNumber&&
  (availabilityQuestion||historyQuestion||/\b(who|which|was|were|count)\b/.test(normalized)));
 const locationQuestion=!historicalVehicle&&!historicalPlant&&
  (Boolean(vehicleNumber)||isLocationQuestion(query));

 if((historicalVehicle||historicalPlant||exitQuestion||dateRequest.found&&historyQuestion)&&
  dateRequest.found&&isOlderThanAccessLimit(dateRequest.start,now)){
  return answerText(HISTORY_LIMIT_REPLY,'historyLimit',{},language);
 }

 const planQuestion=/\b(plan|schedule|planned)\b/.test(normalized);
 if(planQuestion){
  if(!hasPageAccess(permissions,'dashboard'))return accessDenied(language,'dashboard');
  const filter=vehicleNumber?{vehicle:vehicleNumber}:{};
  if(!vehicleNumber&&hasPlantWord){
   const plants=await fleetSnapshotService.getActivePlantRecords(models);
   const plant=matchPlant(query,plants);
   if(!plant)return answerText(
    localized(language,`Plant not found. Available plants: ${plants.map(item=>item.name).join(', ')}.`,`यह प्लांट नहीं मिला। उपलब्ध प्लांट: ${plants.map(item=>item.name).join(', ')}।`),
    'plantNotFound',{availablePlants:plants.map(item=>item.name),suggestions:plantSuggestions(plants,language)},language
   );
   filter.plant=plant._id;
  }
  const plans=await models.VehiclePlan.find(filter).sort({createdAt:-1}).limit(20).populate('plant').lean();
  return answerText(
   localized(language,`${plans.length} operational plan record(s) found.`,`${plans.length} ऑपरेशनल प्लान रिकॉर्ड मिले।`),
   'plans',{rows:plans.map(plan=>({vehicleNumber:plan.vehicle,planType:plan.planType,plantName:plan.plant?.name||'N/A',remarks:plan.remarks||'',expectedDeparture:plan.expectedDeparture||null}))},language
  );
 }

 if(/\b(sync|provider|gps status|connection|data status)\b/.test(normalized)){
  if(!hasPageAccess(permissions,'gpsTrack'))return accessDenied(language,'gpsTrack');
  const providers=await models.GpsProviderStatus.find()
   .select('provider status lastSuccessTime vehicleCount vehiclesReceived vehiclesNotResponding')
   .lean();
  return answerText(
   localized(language,`${providers.length} GPS provider status record(s) found.`,`${providers.length} GPS प्रदाता स्थिति रिकॉर्ड मिले।`),
   'providers',{rows:providers},language
  );
 }

 if(locationQuestion||historicalVehicle||!vehicleNumber&&historyQuestion){
  if(!hasPageAccess(permissions,'gpsTrack'))return accessDenied(language,'gpsTrack');
 }
 if(allPlantsQuestion||historicalPlant||outsideQuestion||availabilityQuestion&&hasPlantWord){
  if(!hasPageAccess(permissions,'dashboard'))return accessDenied(language,'dashboard');
 }
 if(isPlantDetailsQuestion(query)&&!hasPageAccess(permissions,'plant'))return accessDenied(language,'plant');

 if(!vehicleNumber&&!isGpsVehicleListQuestion(query)&&
  (isLocationQuestion(query)||historyQuestion&&!hasPlantWord&&!allFleetHistoryQuestion)){
  if(!hasPageAccess(permissions,'gpsTrack'))return accessDenied(language,'gpsTrack');
  const vehicles=await models.Vehicle.find({status:'Active'}).select('vehicleNumber').lean();
  const suggestions=vehicleSuggestions(vehicles.map(vehicle=>vehicle.vehicleNumber),language,historyQuestion);
  return answerText(
   historyQuestion
    ?localized(language,'Write a vehicle number to see its recent history.','हाल की हिस्ट्री देखने के लिए वाहन नंबर लिखें।')
    :localized(language,'Which vehicle? Please enter its vehicle number.','कौन-सी गाड़ी? कृपया वाहन नंबर लिखें।'),
   'vehiclePrompt',{suggestions},language
  );
 }

 if(!vehicleNumber&&isGpsVehicleListQuestion(query)&&!historyQuestion){
  if(!hasPageAccess(permissions,'gpsTrack'))return accessDenied(language,'gpsTrack');
  const rows=(await getAiGpsVehicleRows(models,now)).map(({candidatePlants,...vehicle})=>vehicle);
  return answerText(
   localized(language,`${rows.length} registered GPS vehicle(s) found.`,`${rows.length} पंजीकृत GPS वाहन मिले।`),
   'vehicleList',{rows,total:rows.length},language
  );
 }

 if(historicalVehicle){
  const start=dateRequest.hasTime?dateRequest.instant:
   dateRequest.found?dateRequest.start:new Date(now.getTime()-7*DAY_MS);
  const requestedEnd=dateRequest.hasTime
   ?new Date(dateRequest.instant.getTime()+60000-1)
   :dateRequest.found?dateRequest.end:now;
  const end=new Date(Math.min(requestedEnd.getTime(),now.getTime()));
  if(isOlderThanAccessLimit(start,now))return answerText(HISTORY_LIMIT_REPLY,'historyLimit',{},language);
  const registered=await fleetSnapshotService.getActiveVehicle(models,vehicleNumber);
  if(!registered)return answerText(
   localized(language,'This vehicle number was not found in the registry.','यह वाहन नंबर रजिस्ट्री में नहीं मिला।'),
   'vehicleNotFound',{vehicleNumber},language
  );
  const storedNumber=registered.vehicleNumber;
  const matcher=vehicleNumberRegex(storedNumber);
  const vehicleFilter={$or:[{vehicleNumber:matcher},{vehicle:matcher}],provider:{$in:[null,GPS_PROVIDER]}};
  const filter={...vehicleFilter,gpsTime:{$gte:start,$lte:end}};
  const [records,total]=await Promise.all([
   models.VehicleLocationHistory.find(filter).sort({gpsTime:1}).limit(20).lean(),
   models.VehicleLocationHistory.countDocuments(filter)
  ]);
  if(!hasGpsConfiguration(registered)&&!records.some(record=>record.provider||validCoordinates(record.lat,record.lng))){
   return answerText(
    localized(language,'This registered vehicle has no configured GPS integration or GPS history.','इस पंजीकृत वाहन के लिए GPS integration या GPS इतिहास उपलब्ध नहीं है।'),
    'vehicleUnavailable',{vehicleNumber},language
   );
  }
  if(!records.length)return answerText(
   localized(language,'No database history was found for this vehicle and date range.','इस वाहन और तारीख के लिए डेटाबेस में हिस्ट्री नहीं मिली।'),
   'history',{vehicleNumber,rows:[],total:0},language
  );
  return answerText(
   localized(language,`${total} location history record(s) for ${vehicleNumber}.`,`${vehicleNumber} के ${total} लोकेशन हिस्ट्री रिकॉर्ड मिले।`),
   'history',{vehicleNumber,rows:records.map(mapHistoryRecord),total,historyRange:{from:start.toISOString(),to:end.toISOString()}},language
  );
 }

 if(allFleetHistoryQuestion){
  if(!hasPageAccess(permissions,'gpsTrack'))return accessDenied(language,'gpsTrack');
  const start=dateRequest.hasTime?dateRequest.instant:
   dateRequest.found?dateRequest.start:new Date(now.getTime()-7*DAY_MS);
  const requestedEnd=dateRequest.hasTime
   ?new Date(dateRequest.instant.getTime()+60000-1)
   :dateRequest.found?dateRequest.end:now;
  const end=new Date(Math.min(requestedEnd.getTime(),now.getTime()));
  if(isOlderThanAccessLimit(start,now))return answerText(HISTORY_LIMIT_REPLY,'historyLimit',{},language);
  const gpsVehicles=await getAiGpsVehicleRows(models,now);
  const vehicleNumbers=gpsVehicles.map(vehicle=>vehicle.vehicleNumber);
  if(!vehicleNumbers.length)return answerText(
   localized(language,'No registered GPS vehicles were found.','कोई पंजीकृत GPS वाहन नहीं मिला।'),
   'history',{rows:[],total:0,historyRange:{from:start.toISOString(),to:end.toISOString()}},language
  );
  const filter={
   $or:[{vehicleNumber:{$in:vehicleNumbers}},{vehicle:{$in:vehicleNumbers}}],
   provider:{$in:[null,GPS_PROVIDER]},
   gpsTime:{$gte:start,$lte:end}
  };
  const [records,total]=await Promise.all([
   models.VehicleLocationHistory.find(filter).sort({gpsTime:1}).limit(20).lean(),
   models.VehicleLocationHistory.countDocuments(filter)
  ]);
  return answerText(
   localized(language,`${total} GPS history record(s) found for registered vehicles.`,`${total} GPS इतिहास रिकॉर्ड मिले।`),
   'history',{rows:records.map(mapHistoryRecord),total,historyRange:{from:start.toISOString(),to:end.toISOString()}},language
  );
 }

 if(exitQuestion){
  if(!hasPageAccess(permissions,'dashboard'))return accessDenied(language,'dashboard');
  const istToday=istParts(now);
  const start=dateRequest.found?dateRequest.start:fromIstParts(istToday.year,istToday.month,istToday.day);
  const end=dateRequest.found?new Date(Math.min(dateRequest.end.getTime(),now.getTime())):now;
  if(isOlderThanAccessLimit(start,now))return answerText(HISTORY_LIMIT_REPLY,'historyLimit',{},language);
  const gpsVehicles=await getAiGpsVehicleRows(models,now);
  const vehicleNumbers=gpsVehicles.map(vehicle=>vehicle.vehicleNumber);
  if(!vehicleNumbers.length)return answerText(
   localized(language,'No registered GPS vehicles were found.','कोई पंजीकृत GPS वाहन नहीं मिला।'),
   'outsideHistory',{rows:[],total:0},language
  );
  const records=await models.VehiclePlantStay.find({
   vehicle:{$in:vehicleNumbers},
   exitTime:{$gte:new Date(Math.max(start.getTime(),getHistoryCutoff(now).getTime())),$lte:end}
  }).populate('plant').sort({exitTime:1}).lean();
  const rows=records.map(record=>({vehicleNumber:record.vehicle,plantName:record.plant?.name||'N/A',exitTime:record.exitTime}));
  return answerText(
   localized(language,`${rows.length} vehicle(s) left a plant in the requested period.`,`${rows.length} गाड़ियाँ दिए गए समय में प्लांट से बाहर गईं।`),
   'outsideHistory',{rows,total:rows.length},language
  );
 }

 if(historicalPlant){
  if(!hasPageAccess(permissions,'dashboard'))return accessDenied(language,'dashboard');
  const plants=await fleetSnapshotService.getActivePlantRecords(models);
  const plant=matchPlant(query,plants);
  if(!plant){
   const activePlants=plants.filter(item=>item.status==='Active');
   const names=activePlants.map(item=>item.name);
   return answerText(
    names.length
     ?localized(language,`Plant not found. Available plants: ${names.join(', ')}.`,`यह प्लांट नहीं मिला। उपलब्ध प्लांट: ${names.join(', ')}।`)
     :localized(language,'No plant records were found.','प्लांट का रिकॉर्ड नहीं मिला।'),
    'plantNotFound',{availablePlants:names,suggestions:plantSuggestions(activePlants,language)},language
   );
  }
  const at=dateRequest.hasTime?dateRequest.instant:new Date(Math.min(dateRequest.end.getTime(),now.getTime()));
  const filter={plant:plant._id,entryTime:{$gte:getHistoryCutoff(now),$lte:at}};
  if(dateRequest.hasTime)filter.$or=[{exitTime:{$exists:false}},{exitTime:null},{exitTime:{$gt:at}}];
  else filter.$or=[{exitTime:{$exists:false}},{exitTime:null},{exitTime:{$gt:dateRequest.start}}];
  const gpsVehicles=await getAiGpsVehicleRows(models,now);
  const vehicleNumbers=gpsVehicles.map(vehicle=>vehicle.vehicleNumber);
  if(!vehicleNumbers.length)return answerText(
   localized(language,'No registered GPS vehicles were found.','कोई पंजीकृत GPS वाहन नहीं मिला।'),
   'plantVehicles',{plantName:plant.name,rows:[],total:0,historical:true},language
  );
  filter.vehicle={$in:vehicleNumbers};
  const stays=await models.VehiclePlantStay.find(filter).lean();
  const uniqueStays=[...groupByVehicleNumber(stays,stay=>stay.vehicle).values()]
   .map(records=>records.sort((a,b)=>new Date(a.entryTime)-new Date(b.entryTime))[0]);
  const rows=uniqueStays.map(stay=>{
   const duration=durationAt(stay.entryTime,at);
   return {vehicleNumber:stay.vehicle,entryTime:stay.entryTime,stayHours:duration.hours,stay:formatDuration(duration)};
  });
  return answerText(
   localized(language,`${rows.length} vehicle(s) were at ${plant.name} at the requested time.`,`${plant.name} पर दिए गए समय में ${rows.length} गाड़ियाँ थीं।`),
   'plantVehicles',{plantName:plant.name,rows,total:rows.length,historical:true},language
  );
 }

 if(outsideQuestion&&!exitQuestion){
  if(!hasPageAccess(permissions,'dashboard'))return accessDenied(language,'dashboard');
  const vehicles=await getAiGpsVehicleRows(models,now);
  const rows=vehicles.filter(vehicle=>vehicle.currentGps&&!vehicle.candidatePlants.length);
  const unknown=vehicles.filter(vehicle=>!vehicle.currentGps);
  return answerText(
   localized(language,`${rows.length} registered GPS vehicle(s) are outside plant geofences; ${unknown.length} cannot be confirmed from current GPS data.`,`${rows.length} पंजीकृत GPS वाहन प्लांट geofence से बाहर हैं; ${unknown.length} की वर्तमान GPS जानकारी से पुष्टि नहीं हो सकी।`),
   'outside',{count:rows.length,vehicles:rows.map(vehicle=>vehicle.vehicleNumber),unknown:unknown.map(vehicle=>vehicle.vehicleNumber)},language
  );
 }

 if(allPlantsQuestion&&availabilityQuestion){
  if(!hasPageAccess(permissions,'dashboard'))return accessDenied(language,'dashboard');
  if(!hasPageAccess(permissions,'gpsTrack'))return accessDenied(language,'gpsTrack');
  const [plants,vehicles]=await Promise.all([
   fleetSnapshotService.getActivePlantRecords(models),
   getAiGpsVehicleRows(models,now)
  ]);
  const groups=plants.map(plant=>{
   const candidates=vehicles.flatMap(vehicle=>
    vehicle.candidatePlants.filter(candidate=>candidate.plantName===plant.name).map(candidate=>({
     ...vehicle,entryTime:candidate.entryTime,
     availabilityStatus:candidate.confirmed?'Available (confirmed)':'Availability not confirmed'
    }))
   );
   const rows=candidates.filter(vehicle=>vehicle.availabilityStatus==='Available (confirmed)');
   return {
    plantName:plant.name,count:rows.length,rows,
    unconfirmedRows:candidates.filter(vehicle=>vehicle.availabilityStatus!=='Available (confirmed)')
   };
  });
  const transit=vehicles.filter(vehicle=>vehicle.currentGps&&!vehicle.candidatePlants.length);
  const unknown=vehicles.filter(vehicle=>!vehicle.currentGps);
  const total=groups.reduce((sum,item)=>sum+item.count,0);
  return answerText(
   localized(language,`${total} vehicle(s) have confirmed plant availability; ${transit.length} are outside plant geofences and ${unknown.length} cannot be confirmed from current GPS data.`,`प्लांट में ${total} गाड़ियों की उपलब्धता की पुष्टि हुई; ${transit.length} geofence से बाहर हैं और ${unknown.length} की वर्तमान GPS जानकारी से पुष्टि नहीं हो सकी।`),
   'plants',{plants:groups,transit:{count:transit.length,vehicles:transit.map(vehicle=>vehicle.vehicleNumber)},unknown:{count:unknown.length,vehicles:unknown.map(vehicle=>vehicle.vehicleNumber)}},language
  );
 }

 if(isPlantDetailsQuestion(query)){
  if(!hasPageAccess(permissions,'plant'))return accessDenied(language,'plant');
  const plants=await fleetSnapshotService.getActivePlantRecords(models);
  const plant=matchPlant(query,plants);
  if(!plant)return answerText(
   localized(language,`Plant not found. Available plants: ${plants.map(item=>item.name).join(', ')}.`,`यह प्लांट नहीं मिला। उपलब्ध प्लांट: ${plants.map(item=>item.name).join(', ')}।`),
   'plantNotFound',{availablePlants:plants.map(item=>item.name),suggestions:plantSuggestions(plants,language)},language
  );
  return answerText(
   localized(language,`${plant.name}: ${plant.address||'Address not recorded'}. Radius: ${plant.radius} m.`,`प्लांट: ${plant.name}। पता: ${plant.address||'दर्ज नहीं'}। रेडियस: ${plant.radius} मीटर।`),
   'plantDetails',{plantName:plant.name,address:plant.address||null,radius:plant.radius,lat:plant.lat,lng:plant.lng},language
  );
 }

 if(availabilityQuestion&&hasPlantWord||/\bplant availability now\b/.test(normalized)){
  if(!hasPageAccess(permissions,'dashboard'))return accessDenied(language,'dashboard');
  if(!hasPageAccess(permissions,'gpsTrack'))return accessDenied(language,'gpsTrack');
  const plants=await fleetSnapshotService.getActivePlantRecords(models);
  const plant=matchPlant(query,plants);
  if(!plant){
   const suggestions=plantSuggestions(plants,language);
   return answerText(
    plants.length
     ?localized(language,`Plant not found. Available plants: ${plants.map(item=>item.name).join(', ')}.`,`यह प्लांट नहीं मिला। उपलब्ध प्लांट: ${plants.map(item=>item.name).join(', ')}।`)
     :localized(language,'No active plant records were found.','कोई सक्रिय प्लांट रिकॉर्ड नहीं मिला।'),
    'plantNotFound',{availablePlants:plants.map(item=>item.name),suggestions},language
   );
  }
  const vehicles=await getAiGpsVehicleRows(models,now);
  const candidates=vehicles.flatMap(vehicle=>vehicle.candidatePlants
   .filter(candidate=>candidate.plantName===plant.name)
   .map(candidate=>({
    ...vehicle,entryTime:candidate.entryTime,
    availabilityStatus:candidate.confirmed?'Available (confirmed)':'Availability not confirmed'
   }))
  );
  const rows=candidates.filter(vehicle=>vehicle.availabilityStatus==='Available (confirmed)');
  const unconfirmedRows=candidates.filter(vehicle=>vehicle.availabilityStatus!=='Available (confirmed)');
  return answerText(
   localized(language,`${rows.length} vehicle(s) have confirmed availability at ${plant.name}; ${unconfirmedRows.length} vehicle(s) need GPS confirmation.`,`${plant.name} में ${rows.length} गाड़ियों की उपलब्धता की पुष्टि हुई; ${unconfirmedRows.length} गाड़ियों की GPS पुष्टि बाकी है।`),
   'plantVehicles',{plantName:plant.name,rows,unconfirmedRows,total:rows.length},language
  );
 }

 if(vehicleNumber){
  if(!hasPageAccess(permissions,'gpsTrack'))return accessDenied(language,'gpsTrack');
  const includeInactive=hasPageAccess(permissions,'vehicleRegistry');
  const {vehicle,live:rawLiveRecord,stay}=await fleetSnapshotService.getCurrentVehicle(models,vehicleNumber,{includeInactive});
  const liveRecord=isSupportedGpsRecord(rawLiveRecord)?rawLiveRecord:null;
  if(!vehicle){
   const text=includeInactive
    ?localized(language,'This vehicle number was not found in the registry.','यह वाहन नंबर रजिस्ट्री में नहीं मिला।')
    :localized(language,'No GPS record was found for this vehicle.','इस वाहन का GPS रिकॉर्ड नहीं मिला।');
   return answerText(text,includeInactive?'vehicleNotFound':'vehicleUnavailable',{vehicleNumber},language);
  }
  const cutoff=getHistoryCutoff(now);
  const liveTime=liveRecord?.gpsTime?new Date(liveRecord.gpsTime):null;
  const liveIsRecent=isCurrentGpsRecord(liveRecord,now)&&liveTime>=cutoff;
  const live=liveIsRecent?liveRecord:null;
  let lastKnown=liveRecord&&liveIsRecent?liveRecord:null;
  if(!lastKnown){
   const history=await models.VehicleLocationHistory.find({
    $and:[
     {$or:[
      {vehicleNumber:vehicleNumberRegex(vehicle.vehicleNumber)},
      {vehicle:vehicleNumberRegex(vehicle.vehicleNumber)}
     ]},
     {provider:{$in:[null,GPS_PROVIDER]}},
     {gpsTime:{$gte:cutoff,$lte:now}}
    ]
   }).sort({gpsTime:-1}).limit(1).lean();
   lastKnown=history[0]||null;
  }
  if(!live||live.stale){
   const record=lastKnown;
   if(!hasGpsConfiguration(vehicle)&&!liveRecord?.provider&&!validCoordinates(liveRecord?.lat,liveRecord?.lng)&&
    !record?.provider&&!validCoordinates(record?.lat,record?.lng)){
    return answerText(
     localized(language,'This registered vehicle has no configured GPS integration or GPS history.','इस पंजीकृत वाहन के लिए GPS integration या GPS इतिहास उपलब्ध नहीं है।'),
     'vehicleUnavailable',{vehicleNumber},language
    );
   }
   const location=record?readableLocation(record):null;
   const gpsTime=record?.gpsTime||null;
   const map=record&&validCoordinates(record.lat,record.lng)
    ?`https://www.google.com/maps?q=${record.lat},${record.lng}`:null;
   const text=record
    ?localized(language,`Live GPS data for ${vehicleNumber} is not available. Last known location: ${location}; last time: ${new Date(gpsTime).toLocaleString('en-IN',{timeZone:TIME_ZONE})}.`,`इस वाहन का लाइव GPS डेटा अभी नहीं मिला। पिछली ज्ञात लोकेशन: ${location}; समय: ${new Date(gpsTime).toLocaleString('en-IN',{timeZone:TIME_ZONE})}।`)
    :localized(language,'Live GPS data for this vehicle is not available, and no last-known record was found in the permitted 45-day range.','इस वाहन का लाइव GPS डेटा उपलब्ध नहीं है और अनुमत 45 दिनों में पिछला रिकॉर्ड नहीं मिला।');
   return answerText(text,'vehicleMissing',{
    vehicleNumber,location,speed:record?.speed??'N/A',ignition:record?.ignition??'N/A',
    gpsTime,provider:record?.provider||liveRecord?.provider||vehicle.gpsLink||'N/A',
    plantName:'Availability not confirmed',nearestPlantName:stay?.plant?.name||null,
    lastUpdate:record?.syncedAt||record?.updatedAt||null,
    lat:record?.lat??null,lng:record?.lng??null,map,stale:true
   },language);
  }
  const stayDate=stay?.entryTime?new Date(stay.entryTime):null;
  const stayAllowed=stayDate&&stayDate>=cutoff;
  const stayDuration=stayAllowed?durationAt(stay.entryTime,now):null;
  const location=readableLocation(live);
  const plantConfirmed=Boolean(stay&&!stay.inferredFromGps);
  const plantName=plantConfirmed?stay.plant.name:'Availability not confirmed';
  let nearestPlantName=stay?.plant?.name||null;
  if(/(?:\b(?:nearest|closest)\b|निकटतम|पास)/iu.test(query)&&validCoordinates(live.lat,live.lng)){
   const plants=await fleetSnapshotService.getActivePlantRecords(models);
   nearestPlantName=plants
    .filter(plant=>validCoordinates(plant.lat,plant.lng))
    .sort((a,b)=>distanceMeters(live,a)-distanceMeters(live,b))[0]?.name||null;
  }
  const speed=live.speed==null?'N/A':String(live.speed);
  const ignition=live.ignition==null?'N/A':String(live.ignition);
  const map=validCoordinates(live.lat,live.lng)?`https://www.google.com/maps?q=${live.lat},${live.lng}`:null;
  const text=language==='hi'
   ?`${vehicleNumber} की लोकेशन: ${location}। स्पीड: ${speed}; IGN: ${ignition}; GPS समय: ${live.gpsTime?new Date(live.gpsTime).toLocaleString('en-IN',{timeZone:TIME_ZONE}):'N/A'}; प्रदाता: ${live.provider||vehicle.gpsLink||'N/A'}; स्थिति: ${live.runningStatus||live.vehicleStatus||'Unknown'}; प्लांट: ${plantName}${!plantConfirmed&&nearestPlantName?`; निकटतम प्लांट: ${nearestPlantName}`:''}${stayAllowed?`; प्रवेश: ${new Date(stay.entryTime).toLocaleString('en-IN',{timeZone:TIME_ZONE})}; ठहराव: ${formatDuration(stayDuration)}`:stay?' प्लांट में 45 दिनों से अधिक समय से है':''}।`
   :`${vehicleNumber} location: ${location}. Speed: ${speed}; ignition: ${ignition}; GPS time: ${live.gpsTime?new Date(live.gpsTime).toLocaleString('en-IN',{timeZone:TIME_ZONE}):'N/A'}; provider: ${live.provider||vehicle.gpsLink||'N/A'}; status: ${live.runningStatus||live.vehicleStatus||'Unknown'}; plant: ${plantName}${!plantConfirmed&&nearestPlantName?`; nearest plant: ${nearestPlantName}`:''}${stayAllowed?`; entry: ${new Date(stay.entryTime).toLocaleString('en-IN',{timeZone:TIME_ZONE})}; stay: ${formatDuration(stayDuration)}`:stay?' in plant for more than 45 days':''}.`;
  return answerText(text,'vehicle',{
   vehicleNumber,location,speed,ignition,gpsTime:live.gpsTime||null,
   lastUpdate:live.syncedAt||live.updatedAt||null,provider:live.provider||vehicle.gpsLink||'N/A',
   plantName,nearestPlantName,plantConfirmed,status:live.runningStatus||live.vehicleStatus||'Unknown',
   entryTime:stayAllowed?stay.entryTime:null,
   stay:stayDuration?formatDuration(stayDuration):stay?'45+ days':null,
   stayHours:stayDuration?.hours??null,lat:live.lat,lng:live.lng,map,stale:Boolean(live.stale)
  },language);
 }

 if(isHistoryQuestion(query)||availabilityQuestion||hasPlantWord){
  const suggestions=await getClarificationSuggestions(models,permissions,query,language);
  const text=localized(
   language,
   'I could not match the question to a fleet record. Add a vehicle number, plant name, or date and try again.',
   'सवाल को किसी फ्लीट रिकॉर्ड से नहीं जोड़ पाया। कृपया वाहन नंबर, प्लांट का नाम या तारीख लिखें।'
  );
  return answerText(text,'clarification',{suggestions},language);
 }

 return answerText(
  localized(language,'I could not match that question to available fleet records. Include a vehicle number, plant name, or operational date.','सवाल को उपलब्ध फ्लीट रिकॉर्ड से नहीं जोड़ पाया। कृपया वाहन नंबर, प्लांट का नाम या तारीख लिखें।'),
  'clarification',{suggestions:await getClarificationSuggestions(models,permissions,query,language)},language
 );
}

function parseAdminDate(value,endOfDay=false){
 const match=/^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value||''));
 if(!match)return null;
 const start=fromIstParts(Number(match[1]),Number(match[2]),Number(match[3]));
 if(!start)return null;
 return endOfDay?fromIstParts(Number(match[1]),Number(match[2]),Number(match[3]),23,59,59,999):start;
}

module.exports={
 answerQuestion,cleanChatQuestion,containsSensitiveInput,detectLanguage,extractVehicleNumber,getChatExpiry,
 getHistoryCutoff,HISTORY_LIMIT_REPLY,FUTURE_HISTORY_REPLY,hasGpsConfiguration,mapHistoryRecord,matchPlant,parseAdminDate,
 parseDateRequest,UNKNOWN_REPLY
};
