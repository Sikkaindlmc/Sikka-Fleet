const {normalizeVehicleNumber}=require('./vehicleIdentity');

const WHEELSEYE_ROW_KEYS=[
 'data','vehicles','items','results','response','list','records','content','vehicleList','vehicleDetails'
];

function findRows(value,depth=0){
 if(Array.isArray(value))return value;
 if(!value||typeof value!=='object'||depth>3)return null;
 for(const key of WHEELSEYE_ROW_KEYS){
  const rows=findRows(value[key],depth+1);
  if(rows)return rows;
 }
 return null;
}

function firstValue(record,keys){
 for(const key of keys){
  const value=key.split('.').reduce((current,part)=>current?.[part],record);
  if(value!==undefined&&value!==null&&value!=='')return value;
 }
 return null;
}

function parseGpsTime(value){
 if(value===null||value===undefined||value==='')return null;
 const numeric=Number(value);
 const date=Number.isFinite(numeric)&&numeric>0
  ?new Date(numeric<100000000000?numeric*1000:numeric)
  :new Date(value);
 return Number.isFinite(date.getTime())?date:null;
}

function coordinate(value,min,max){
 if(value===null||value===undefined||String(value).trim()==='')return null;
 const numeric=Number(value);
 return Number.isFinite(numeric)&&numeric>=min&&numeric<=max?numeric:null;
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

function providerFields(record){
 const addressParts=typeof record.address==='object'&&record.address?record.address:{};
 return {
  locality:record.locality||record.LOCALITY||addressParts.locality||addressParts.suburb||'',
  city:record.city||record.CITY||addressParts.city||'',
  district:record.district||record.DISTRICT||addressParts.district||'',
  state:record.state||record.STATE||addressParts.state||'',
  pincode:record.pincode||record.pinCode||record.postalCode||record.POSTCODE||'',
  country:record.country||record.COUNTRY||addressParts.country||''
 };
}

function mapRecord(record,provider,startedAt){
 const fleetx=provider==='Fleetx';
 const rawNumber=firstValue(record,fleetx?['vehicleNumber']:[
  'vehicleNumber','vehicleNo','registrationNo','registration_number','vehicle_number','vehicle',
  'rcNumber','name','VEHICLE_NUMBER','VEHICLE_NAME','vehicle_name'
 ]);
 const rawLatitude=firstValue(record,fleetx?['latitude']: [
  'latitude','lat','LATITUDE','location.lat','location.latitude','gpsLocation.lat','currentLocation.lat'
 ]);
 const rawLongitude=firstValue(record,fleetx?['longitude']: [
  'longitude','lng','lon','LONGITUDE','location.lng','location.longitude','gpsLocation.lng','currentLocation.lng'
 ]);
 const rawSpeed=firstValue(record,fleetx?['speed']:['speed','vehicleSpeed','currentSpeed','speedKph','SPEED']);
 const rawIgnition=firstValue(record,fleetx?['otherAttributes.ignition','ignition']: [
  'ignition','ignitionStatus','engineStatus','engine_status','IGNITION','IGNITION_STATUS','ignition_status'
 ]);
 const rawTime=firstValue(record,fleetx?['lastUpdatedAt']: [
  'gpsTime','timestamp','time','locationTime','lastSeen','updatedAt','lastUpdate','deviceTime',
  'TIMESTAMP','TIME','CREATE_DATE','gps_time','dttimeInEpoch','dttime','createdDate','createdDateReadable'
 ]);
 const number=normalizeVehicleNumber(rawNumber);
 const lat=coordinate(rawLatitude,-90,90);
 const lng=coordinate(rawLongitude,-180,180);
 const gpsTime=parseGpsTime(rawTime);
 let reason='';
 if(!number)reason='missing vehicle number';
 else if(lat===null)reason=rawLatitude===null?'missing latitude':'invalid latitude';
 else if(lng===null)reason=rawLongitude===null?'missing longitude':'invalid longitude';
 else if(!gpsTime)reason='invalid timestamp';
 else if(gpsTime>startedAt)reason='future timestamp';
 if(reason)return {reason};

 const rawHeading=firstValue(record,fleetx?['otherAttributes.course']:['heading','course','bearing','COURSE']);
 const numericHeading=rawHeading===null?null:Number(rawHeading);
 const heading=Number.isFinite(numericHeading)?((numericHeading%360)+360)%360:null;
 const ignitionForStatus=normalizeIgnitionStatus(rawIgnition);
 const runningStatus=normalizeRunningStatus(
  firstValue(record,fleetx?['currentStatus','status']:['runningStatus','running_status','movementStatus','MOVEMENT_STATUS']),
  rawSpeed,ignitionForStatus
 );
 return {
  vehicleNumber:number,lat,lng,speed:rawSpeed,ignition:rawIgnition,gpsTime,
  provider:fleetx?'FLEETX':'Wheelseye',heading,
  providerAddress:firstValue(record,fleetx?['address']: [
   'readableLocation','formattedAddress','fullAddress','address','currentAddress','ADDRESS',
   'location.address','address.formattedAddress','address.formatted_address','address.fullAddress'
  ])||'',
  providerFields:providerFields(record),runningStatus,
  providerVehicleId:fleetx?record.vehicleId:
   record.vehicleId??record.VEHICLE_ID??record.vehicle_id??record.id,
  driverName:fleetx?record.driverName:
   record.driverName??record.DRIVER_NAME??record.driver_name,
  vehicleStatus:fleetx?record.currentStatus??record.status:
   record.vehicleStatus??record.STATUS??record.status
 };
}

function mapProviderPayload(payload,provider,{now=new Date()}={}){
 const sourceRows=findRows(payload)||[];
 const result={records:[],received:sourceRows.length,rejected:{}};
 for(const source of sourceRows){
  const mapped=mapRecord(source,provider,now);
  if(mapped.reason){
   result.rejected[mapped.reason]=(result.rejected[mapped.reason]||0)+1;
  }else{
   result.records.push(mapped);
  }
 }
 return result;
}

module.exports={mapProviderPayload,parseGpsTime};
