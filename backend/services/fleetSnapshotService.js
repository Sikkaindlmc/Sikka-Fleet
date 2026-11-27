const {
 normalizeVehicleNumber,groupByVehicleNumber,vehicleNumberRegex
}=require('./vehicleIdentity');
const vehicleNumberKey=normalizeVehicleNumber;

function readableAddress(record){
 const value=record?.readableLocation||record?.address;
 return typeof value==='string'&&value.trim()&&!/^\s*-?\d+(?:\.\d+)?\s*,\s*-?\d+(?:\.\d+)?\s*$/.test(value)
  ?value.trim():null;
}

function elapsedStay(entryTime,now){
 if(!entryTime||!Number.isFinite(new Date(entryTime).getTime()))return {stayHours:null,stayMinutes:null,stay:'N/A'};
 const minutes=Math.max(0,Math.floor((now.getTime()-new Date(entryTime).getTime())/60000));
 return {stayHours:Math.floor(minutes/60),stayMinutes:minutes%60,stay:`${Math.floor(minutes/60)} h ${minutes%60} m`};
}

function validGps(record){
 return Number.isFinite(Number(record?.lat))&&Number(record.lat)>=-90&&Number(record.lat)<=90&&
  Number.isFinite(Number(record?.lng))&&Number(record.lng)>=-180&&Number(record.lng)<=180;
}

function haversine(a,b){
 const toRad=value=>value*Math.PI/180;
 const dLat=toRad(b.lat-a.lat),dLng=toRad(b.lng-a.lng);
 const value=Math.sin(dLat/2)**2+Math.cos(toRad(a.lat))*Math.cos(toRad(b.lat))*Math.sin(dLng/2)**2;
 return 6371000*2*Math.atan2(Math.sqrt(value),Math.sqrt(1-value));
}

function nearestPlant(record,plants){
 if(!validGps(record))return null;
 let nearest=null,distance=Infinity;
 for(const plant of plants){
  const next=haversine({lat:Number(record.lat),lng:Number(record.lng)},{lat:Number(plant.lat),lng:Number(plant.lng)});
  if(next<=Number(plant.radius)&&next<distance){nearest=plant;distance=next}
 }
 return nearest;
}

function preferredVehicle(records){
 return [...records].sort((a,b)=>
  new Date(b.updatedAt||0)-new Date(a.updatedAt||0)||
  new Date(a.createdAt||0)-new Date(b.createdAt||0)||
  String(a._id||'').localeCompare(String(b._id||''))
 )[0];
}

function preferredLive(records,vehicle){
 return [...records].sort((a,b)=>{
  const providerLinked=provider=>{
   const normalized=String(provider||'').toUpperCase();
   return normalized===String(vehicle?.gpsLink||'').toUpperCase()||
    (vehicle?.gpsProviders||[]).some(link=>String(link.name||'').toUpperCase()===normalized);
  };
  const providerDifference=Number(providerLinked(b.provider))-Number(providerLinked(a.provider));
  if(providerDifference)return providerDifference;
  const validDifference=Number(validGps(b))-Number(validGps(a));
  if(validDifference)return validDifference;
  return new Date(b.gpsTime||0)-new Date(a.gpsTime||0)||
   new Date(b.syncedAt||b.updatedAt||0)-new Date(a.syncedAt||a.updatedAt||0);
 })[0];
}

function selectCurrentStays(records,liveByNumber,plants,registeredNumbers){
 const selected=new Map();
 const stayGroups=groupByVehicleNumber(records,stay=>stay.vehicle);
 for(const vehicleNumber of registeredNumbers){
  const stays=stayGroups.get(vehicleNumber)||[];
  const live=liveByNumber.get(vehicleNumber);
  if(live&&!live.stale&&validGps(live)){
   const nearest=nearestPlant(live,plants);
   if(!nearest)continue;
   const eligible=stays
    .filter(stay=>String(stay.plant?._id||stay.plant)===String(nearest._id))
    .sort((a,b)=>new Date(a.entryTime||0)-new Date(b.entryTime||0));
   selected.set(vehicleNumber,eligible.length
    ?{...eligible[0],vehicle:vehicleNumber}
    :{vehicle:vehicleNumber,plant:nearest,entryTime:null,inferredFromGps:true});
   continue;
  }
  const latestStay=[...stays].sort((a,b)=>new Date(b.entryTime||0)-new Date(a.entryTime||0))[0];
  if(latestStay){
   const samePlant=stays.filter(stay=>String(stay.plant?._id||stay.plant)===String(latestStay.plant?._id||latestStay.plant))
    .sort((a,b)=>new Date(a.entryTime||0)-new Date(b.entryTime||0));
   selected.set(vehicleNumber,{...samePlant[0],vehicle:vehicleNumber});
  }
 }
 return selected;
}

async function getActivePlantRecords(models){
 return models.Plant.find({status:'Active'}).lean();
}

async function getPlantAvailability(models,plant,now=new Date()){
 const snapshot=await getOperationalSnapshot(models,now,{includeMetadata:false});
 const record=snapshot.plants.find(item=>String(item._id||item.plantId||item.plant)===String(plant._id)||item.plant===plant.name);
 const rows=(record?.rows||[]).map(stay=>({
  vehicleNumber:stay.vehicleNumber,entryTime:stay.entryTime,...elapsedStay(stay.entryTime,now)
 }));
 return {plant:plant.name,count:rows.length,rows};
}

async function getActiveVehicle(models,vehicleNumber){
 const normalized=normalizeVehicleNumber(vehicleNumber);
 const exact=await models.Vehicle.findOne({vehicleNumber:normalized,status:'Active'})
  .select('vehicleNumber normalizedVehicleNumber status fleetType gpsLink providerVehicleId gpsProviders driver mobile plant createdAt updatedAt').lean();
 if(exact)return {...exact,vehicleNumber:normalized};
 const matches=await models.Vehicle.find({status:'Active'})
  .select('vehicleNumber normalizedVehicleNumber status fleetType gpsLink providerVehicleId gpsProviders driver mobile plant createdAt updatedAt').lean();
 const record=preferredVehicle(matches.filter(vehicle=>normalizeVehicleNumber(vehicle.vehicleNumber)===normalized));
 return record?{...record,vehicleNumber:normalized}:null;
}

async function getCurrentVehicle(models,vehicleNumber,{includeInactive=false}={}){
 let vehicle=await getActiveVehicle(models,vehicleNumber);
 if(!vehicle&&includeInactive){
  const normalized=normalizeVehicleNumber(vehicleNumber);
  const exact=await models.Vehicle.findOne({vehicleNumber:normalized})
   .select('vehicleNumber normalizedVehicleNumber status fleetType gpsLink providerVehicleId gpsProviders driver mobile plant createdAt updatedAt').lean();
  if(exact)vehicle={...exact,vehicleNumber:normalized};
  else{
   const matches=await models.Vehicle.find({})
    .select('vehicleNumber normalizedVehicleNumber status fleetType gpsLink providerVehicleId gpsProviders driver mobile plant createdAt updatedAt').lean();
   const record=preferredVehicle(matches.filter(item=>normalizeVehicleNumber(item.vehicleNumber)===normalized));
   vehicle=record?{...record,vehicleNumber:normalized}:null;
  }
 }
 if(!vehicle)return {vehicle:null,live:null,stay:null};
 const storedNumber=normalizeVehicleNumber(vehicle.vehicleNumber);
 const matcher=vehicleNumberRegex(storedNumber);
 const [allLive,allStays,plants]=await Promise.all([
  models.VehicleLiveStatus.find({vehicleNumber:matcher}).lean(),
  models.VehiclePlantStay.find({vehicle:matcher,exitTime:null}).populate('plant').lean(),
  models.Plant.find({status:'Active'}).lean()
 ]);
 const live=preferredLive(allLive.filter(item=>normalizeVehicleNumber(item.vehicleNumber)===storedNumber),vehicle)||null;
 const stayRecords=allStays.filter(item=>normalizeVehicleNumber(item.vehicle)===storedNumber);
 const stays=selectCurrentStays(stayRecords,new Map([[storedNumber,live]]),plants,new Set([storedNumber]));
 const stay=stays.get(storedNumber)||null;
 return {vehicle,live,stay};
}

async function getOperationalSnapshot(models,now=new Date(),{includeMetadata=true}={}){
 const [plants,rawVehicles,rawStays,providers,lastSync]=await Promise.all([
  models.Plant.find({status:'Active'}).lean(),
  models.Vehicle.find({status:'Active'}).select('vehicleNumber fleetType gpsLink providerVehicleId gpsProviders driver mobile plant createdAt updatedAt').lean(),
  models.VehiclePlantStay.find({exitTime:null}).populate('plant').lean(),
  includeMetadata?models.GpsProviderStatus.find().lean():Promise.resolve([]),
  includeMetadata?models.SyncLog.findOne().sort({startedAt:-1}).lean():Promise.resolve(null)
 ]);
 const vehicles=[...groupByVehicleNumber(rawVehicles).entries()].map(([vehicleNumber,records])=>({
  ...preferredVehicle(records),vehicleNumber,normalizedVehicleNumber:vehicleNumber
 }));
 const vehicleByNumber=new Map(vehicles.map(vehicle=>[vehicleNumberKey(vehicle.vehicleNumber),vehicle]));
 const registeredNumbers=new Set(vehicleByNumber.keys());
 const rawLive=await models.VehicleLiveStatus.find({}).lean();
 const liveByNumber=new Map();
 for(const [vehicleNumber,records] of groupByVehicleNumber(rawLive).entries()){
  const vehicle=vehicleByNumber.get(vehicleNumber);
  if(!vehicle)continue;
  const selected=preferredLive(records,vehicle);
  if(selected)liveByNumber.set(vehicleNumber,{...selected,vehicleNumber,normalizedVehicleNumber:vehicleNumber});
 }
 const live=[...liveByNumber.values()].sort((a,b)=>a.vehicleNumber.localeCompare(b.vehicleNumber));
 const currentStays=selectCurrentStays(rawStays,liveByNumber,plants,registeredNumbers);
 const groups=plants.map(plant=>{
  const rows=[...currentStays.values()].filter(stay=>stay.plant&&String(stay.plant._id)===String(plant._id)).map(stay=>{
   const gps=liveByNumber.get(vehicleNumberKey(stay.vehicle));
   return {
    vehicleNumber:stay.vehicle,entryTime:stay.entryTime,...elapsedStay(stay.entryTime,now),
    location:readableAddress(gps),addressIsCurrent:Boolean(gps?.addressIsCurrent),
    lat:gps?.lat??null,lng:gps?.lng??null,gpsTime:gps?.gpsTime??null,
    speed:gps?.speed??'N/A',ignition:gps?.ignition??'N/A',
    provider:gps?.provider||null,hasGps:Boolean(gps),stale:Boolean(gps?.stale)
   };
  });
  return {
   _id:plant._id,plant:plant.name,plantCode:plant.code||'',plantId:plant.plantId||'',
   address:plant.address||'',updatedAt:plant.updatedAt,count:rows.length,rows
  };
 });
 const inPlants=new Set(currentStays.keys());
 const transitLive=live.filter(record=>!inPlants.has(vehicleNumberKey(record.vehicleNumber)));
 const transitNumbers=transitLive.map(record=>record.vehicleNumber);
 const lastStays=transitNumbers.length
  ?await models.VehiclePlantStay.find({vehicle:{$in:transitNumbers}})
   .sort({vehicle:1,exitTime:-1,entryTime:-1}).populate('plant').lean()
  :[];
 const lastStayByVehicle=new Map();
 for(const stay of lastStays){
  if(!lastStayByVehicle.has(stay.vehicle))lastStayByVehicle.set(stay.vehicle,stay);
 }
 const transitRows=transitLive.map(record=>({
  vehicleId:String(vehicleByNumber.get(vehicleNumberKey(record.vehicleNumber))?._id||''),
  vehicleNumber:record.vehicleNumber,
  leftPlant:lastStayByVehicle.get(record.vehicleNumber)?.plant?.name||'Not recorded',
  location:readableAddress(record),addressIsCurrent:Boolean(record.addressIsCurrent),
  latitude:record.lat,longitude:record.lng,lastGpsUpdatedAt:record.gpsTime,
  speed:record.speed,ignition:record.ignition,provider:record.provider,stale:Boolean(record.stale)
 }));
 const trackingRows=vehicles.map(vehicle=>{
  const record=liveByNumber.get(vehicleNumberKey(vehicle.vehicleNumber));
  return record?{
   ...record,location:readableAddress(record),fleetType:vehicle.fleetType,
   driver:vehicle.driver||'',driverName:record.driverName||vehicle.driver||'',
   mobile:vehicle.mobile||'',plant:vehicle.plant||''
  }:{
   vehicleNumber:vehicle.vehicleNumber,normalizedVehicleNumber:vehicleNumberKey(vehicle.vehicleNumber),
   provider:vehicle.gpsLink,fleetType:vehicle.fleetType,driver:vehicle.driver||'',
   mobile:vehicle.mobile||'',plant:vehicle.plant||'',speed:'N/A',ignition:'N/A',
   runningStatus:'Unknown',location:null,stale:false,noGpsData:true
  };
 }).sort((a,b)=>a.vehicleNumber.localeCompare(b.vehicleNumber));
 const freshRows=trackingRows.filter(record=>!record.stale&&!record.noGpsData);
 return {
  plants:groups,
  plantRecords:plants,
  openStays:[...currentStays.values()],
  transit:{count:transitRows.length,rows:transitRows},
  live:trackingRows,
  liveRecords:live,
  registeredVehicles:vehicles.map(vehicle=>({
   vehicleNumber:vehicle.vehicleNumber,
   provider:vehicle.gpsLink||liveByNumber.get(vehicle.vehicleNumber)?.provider,
   providerVehicleId:vehicle.providerVehicleId||liveByNumber.get(vehicle.vehicleNumber)?.providerVehicleId
  })),
  registeredCount:vehicles.length,
  summary:{
   moving:freshRows.filter(record=>record.runningStatus==='Moving').length,
   stopped:freshRows.filter(record=>record.runningStatus==='Stopped').length,
   ignitionOn:freshRows.filter(record=>record.ignition==='ON').length,
   ignitionOff:freshRows.filter(record=>record.ignition==='OFF').length,
   notResponding:Math.max(0,vehicles.length-new Set(freshRows.map(record=>record.vehicleNumber)).size),
   apiErrors:providers.filter(provider=>provider.status==='Error').length
  },
  providers,lastSync
 };
}

module.exports={
 getActivePlantRecords,getActiveVehicle,getCurrentVehicle,getOperationalSnapshot,getPlantAvailability,
 normalizeVehicleNumber,readableAddress
};
