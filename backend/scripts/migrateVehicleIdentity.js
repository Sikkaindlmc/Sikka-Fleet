require('dotenv').config({path:require('path').join(__dirname,'..','.env')});
const mongoose=require('mongoose');
const M=require('../models');
const {normalizeVehicleNumber,groupByVehicleNumber}=require('../services/vehicleIdentity');
const fleetSnapshotService=require('../services/fleetSnapshotService');

const apply=process.argv.includes('--apply');
const now=new Date();
const LIVE_FIELDS=[
 'address','readableLocation','locality','city','district','state','pincode','country',
 'geocodedAt','addressLat','addressLng','addressIsCurrent','geocodingProvider',
 'providerVehicleId','driverName','vehicleStatus'
];

function newestFirst(records){
 return [...records].sort((a,b)=>
  new Date(b.updatedAt||b.gpsTime||b.entryTime||0)-new Date(a.updatedAt||a.gpsTime||a.entryTime||0)||
  String(a._id||'').localeCompare(String(b._id||''))
 );
}

function masterProviderLinks(records){
 const providers=new Map();
 for(const vehicle of records){
  const links=[...(vehicle.gpsProviders||[])];
  if(vehicle.gpsLink)links.push({name:vehicle.gpsLink,vehicleId:vehicle.providerVehicleId});
  for(const link of links){
   if(!link.name)continue;
   const current=providers.get(link.name)||new Set();
   if(link.vehicleId)current.add(String(link.vehicleId));
   providers.set(link.name,current);
  }
 }
 return providers;
}

function inspectMasterDuplicates(groups){
 const conflicts=[];
 for(const [vehicleNumber,records] of groups){
  if(records.length<2)continue;
  for(const field of ['fleetType']){
   const values=[...new Set(records.map(record=>record[field]).filter(Boolean))];
   if(values.length>1)conflicts.push({vehicleNumber,field,values});
  }
  for(const [provider,ids] of masterProviderLinks(records)){
   if(ids.size>1)conflicts.push({vehicleNumber,field:`${provider} vehicle ID`,values:[...ids]});
  }
 }
 return conflicts;
}

function chooseVehicle(records){
 return newestFirst(records).sort((a,b)=>
  Number(b.status==='Active')-Number(a.status==='Active')||
  new Date(b.updatedAt||0)-new Date(a.updatedAt||0)||
  new Date(a.createdAt||0)-new Date(b.createdAt||0)
 )[0];
}

function chooseLive(records,vehicle){
 return [...records].sort((a,b)=>{
  const linked=provider=>provider===vehicle?.gpsLink||
   (vehicle?.gpsProviders||[]).some(item=>item.name===provider);
  const providerDifference=Number(linked(b.provider))-Number(linked(a.provider));
  if(providerDifference)return providerDifference;
  const gpsDifference=new Date(b.gpsTime||0)-new Date(a.gpsTime||0);
  if(gpsDifference)return gpsDifference;
  return new Date(b.syncedAt||b.updatedAt||0)-new Date(a.syncedAt||a.updatedAt||0);
 })[0];
}

function validGps(record){
 return Number.isFinite(Number(record?.lat))&&Number(record.lat)>=-90&&Number(record.lat)<=90&&
  Number.isFinite(Number(record?.lng))&&Number(record.lng)>=-180&&Number(record.lng)<=180;
}

function distanceMeters(a,b){
 const radians=value=>value*Math.PI/180;
 const dLat=radians(Number(b.lat)-Number(a.lat)),dLng=radians(Number(b.lng)-Number(a.lng));
 const value=Math.sin(dLat/2)**2+Math.cos(radians(Number(a.lat)))*Math.cos(radians(Number(b.lat)))*Math.sin(dLng/2)**2;
 return 6371000*2*Math.atan2(Math.sqrt(value),Math.sqrt(1-value));
}

function nearestPlant(live,plants){
 if(!validGps(live))return null;
 let nearest=null,best=Infinity;
 for(const plant of plants){
  const distance=distanceMeters(live,plant);
  if(distance<=Number(plant.radius)&&distance<best){nearest=plant;best=distance}
 }
 return nearest;
}

async function updateMasterVehicles(groups){
 for(const [vehicleNumber,records] of groups){
  const winner=chooseVehicle(records);
  const providerLinks=[...masterProviderLinks(records)].map(([name,ids])=>({
   name,vehicleId:[...ids][0]||undefined
  }));
  const primary=providerLinks.find(link=>link.name===winner.gpsLink);
  const $set={
   vehicleNumber,normalizedVehicleNumber:vehicleNumber,
   fleetType:winner.fleetType,gpsLink:winner.gpsLink,
   status:records.some(record=>record.status==='Active')?'Active':'Inactive',
   gpsProviders:providerLinks,
   ...(winner.createdAt?{createdAt:records.reduce((oldest,record)=>record.createdAt&&record.createdAt<oldest?record.createdAt:oldest,winner.createdAt)}:{})
  };
  const updatedAt=records.map(record=>record.updatedAt).filter(Boolean).sort((a,b)=>b-a)[0];
  if(updatedAt)$set.updatedAt=updatedAt;
  if(primary?.vehicleId)$set.providerVehicleId=primary.vehicleId;
  else if(winner.providerVehicleId)$set.providerVehicleId=winner.providerVehicleId;
  const extras=records.filter(record=>String(record._id)!==String(winner._id));
  if(extras.length)await M.Vehicle.deleteMany({_id:{$in:extras.map(record=>record._id)}});
  await M.Vehicle.collection.updateOne({_id:winner._id},{$set});
 }
}

async function updateLiveRecords(groups,vehicleByNumber){
 for(const [vehicleNumber,records] of groups){
  const vehicle=vehicleByNumber.get(vehicleNumber);
  const winner=chooseLive(records,vehicle);
  const merged={...winner,vehicleNumber,normalizedVehicleNumber:vehicleNumber,unregistered:!vehicle};
  for(const field of LIVE_FIELDS){
   if(merged[field]!=null&&merged[field]!=='')continue;
   const source=records.find(record=>
    (record.lat===winner.lat&&record.lng===winner.lng)&&record[field]!=null&&record[field]!==''
   );
   if(source)merged[field]=source[field];
  }
  const extras=records.filter(record=>String(record._id)!==String(winner._id));
  if(extras.length)await M.VehicleLiveStatus.deleteMany({_id:{$in:extras.map(record=>record._id)}});
  delete merged._id;
  await M.VehicleLiveStatus.collection.updateOne({_id:winner._id},{$set:merged});
 }
}

async function updateVehicleReferences(collection,records,field='vehicle',setNormalized=false){
 for(const record of records){
  const vehicleNumber=normalizeVehicleNumber(record[field]);
  if(vehicleNumber&&(vehicleNumber!==record[field]||setNormalized&&record.normalizedVehicleNumber!==vehicleNumber)){
   const update={[field]:vehicleNumber};
   if(setNormalized)update.normalizedVehicleNumber=vehicleNumber;
   await collection.updateOne({_id:record._id},{$set:update});
  }
 }
}

async function updateOpenStays(groups,liveByNumber,plants){
 for(const [vehicleNumber,records] of groups){
  const open=records.filter(record=>record.exitTime==null);
  if(!open.length)continue;
  const live=liveByNumber.get(vehicleNumber);
  const nearest=live&&!live.stale?nearestPlant(live,plants):null;
  let winner=null;
  if(nearest){
   winner=open.filter(record=>String(record.plant?._id||record.plant)===String(nearest._id))
    .sort((a,b)=>new Date(a.entryTime)-new Date(b.entryTime))[0]||null;
  }else if(!live||!validGps(live)||live.stale){
   winner=newestFirst(open)[0];
  }
  const close=open.filter(record=>!winner||String(record._id)!==String(winner._id));
  for(const record of close){
   const time=Date.now();
   const exitTime=new Date(Math.max(time,new Date(record.entryTime).getTime()+1));
   await M.VehiclePlantStay.updateOne({_id:record._id},{$set:{vehicle:vehicleNumber,normalizedVehicleNumber:vehicleNumber,exitTime}});
  }
  if(winner){
   await M.VehiclePlantStay.updateOne({_id:winner._id},{$set:{vehicle:vehicleNumber,normalizedVehicleNumber:vehicleNumber}});
  }else if(nearest&&live){
   const entryTime=new Date(live.gpsTime||Date.now());
   await M.VehiclePlantStay.create({vehicle:vehicleNumber,normalizedVehicleNumber:vehicleNumber,plant:nearest._id,entryTime});
  }
 }
}

async function main(){
 await mongoose.connect(process.env.MONGO_URI||process.env.MONGODB_URI,{dbName:process.env.MONGODB_DB_NAME});
 const [vehicles,live,stays,plans,shares,plants,historyRecords,vehicleIndexes,liveIndexes,stayIndexes]=await Promise.all([
  M.Vehicle.find({}).lean(),M.VehicleLiveStatus.find({}).lean(),
  M.VehiclePlantStay.find({}).lean(),M.VehiclePlan.find({}).lean(),M.ShareLink.find({}).lean(),
  M.Plant.find({status:'Active'}).lean(),
  M.VehicleLocationHistory.countDocuments({}),
  M.Vehicle.collection.indexes(),M.VehicleLiveStatus.collection.indexes(),
  M.VehiclePlantStay.collection.indexes()
 ]);
 const vehicleGroups=groupByVehicleNumber(vehicles);
 const liveGroups=groupByVehicleNumber(live);
 const stayGroups=groupByVehicleNumber(stays,record=>record.vehicle);
 const conflicts=inspectMasterDuplicates(vehicleGroups);
 const snapshot=await fleetSnapshotService.getOperationalSnapshot(M,new Date(),{includeMetadata:false});
 const report={
  mode:apply?'apply':'audit only',
  vehicleRecords:vehicles.length,
  invalidVehicleNumbers:vehicles.filter(record=>!normalizeVehicleNumber(record.vehicleNumber)).length,
  vehicleNormalizationMissing:vehicles.filter(record=>record.normalizedVehicleNumber!==normalizeVehicleNumber(record.vehicleNumber)).length,
  duplicateVehicleGroups:[...vehicleGroups.entries()].filter(([,group])=>group.length>1)
   .map(([vehicleNumber,group])=>({vehicleNumber,records:group.length,providers:[...new Set(group.map(record=>record.gpsLink))]})),
  liveRecords:live.length,
  liveNormalizationMissing:live.filter(record=>record.normalizedVehicleNumber!==normalizeVehicleNumber(record.vehicleNumber)).length,
  duplicateLiveGroups:[...liveGroups.entries()].filter(([,group])=>group.length>1)
   .map(([vehicleNumber,group])=>({vehicleNumber,records:group.length,providers:[...new Set(group.map(record=>record.provider))]})),
  openStayDuplicateGroups:[...stayGroups.entries()]
   .filter(([,group])=>group.filter(record=>record.exitTime==null).length>1)
   .map(([vehicleNumber,group])=>({vehicleNumber,records:group.filter(record=>record.exitTime==null).length})),
  stayNormalizationMissing:stays.filter(record=>record.normalizedVehicleNumber!==normalizeVehicleNumber(record.vehicle)).length,
  gpsHistoryRecords:historyRecords,
  normalizedUniqueIndexes:{
   vehicles:vehicleIndexes.some(index=>index.key.normalizedVehicleNumber===1&&index.unique),
   live:liveIndexes.some(index=>index.key.normalizedVehicleNumber===1&&index.unique),
   openStays:stayIndexes.some(index=>index.key.normalizedVehicleNumber===1&&index.unique&&index.partialFilterExpression?.exitTime===null)
  },
  dashboardGpsParity:{
   registeredVehicleCount:snapshot.registeredCount,
   uniqueGpsTrackVehicleCount:snapshot.live.length,
   plants:snapshot.plants.map(plant=>({name:plant.plant,count:plant.count})),
   outsideVehicleCount:snapshot.transit.count,
   placedLiveVehicleCount:snapshot.plants.reduce((total,plant)=>total+plant.count,0)+snapshot.transit.count
  },
  vehicleMasterConflicts:conflicts
 };
 console.info('[vehicle identity migration]',JSON.stringify(report,null,2));
 if(!apply)return;
 if(report.invalidVehicleNumbers)throw new Error('Resolve vehicle records with empty normalized registration numbers before applying.');
 if(conflicts.length)throw new Error('Resolve conflicting fleet types or provider vehicle IDs before applying the migration.');

 await updateMasterVehicles(vehicleGroups);
 const migratedVehicles=await M.Vehicle.find({}).lean();
 const vehicleByNumber=new Map([...groupByVehicleNumber(migratedVehicles).entries()].map(([number,records])=>[number,chooseVehicle(records)]));
 await updateLiveRecords(liveGroups,vehicleByNumber);
 const liveByNumber=new Map([...liveGroups.entries()].map(([number,records])=>[number,chooseLive(records,vehicleByNumber.get(number))]));
 await updateVehicleReferences(M.VehiclePlan.collection,plans);
 await updateVehicleReferences(M.ShareLink.collection,shares,'vehicleNumber');
 const currentLiveByNumber=new Map([...liveByNumber.entries()]);
 await updateOpenStays(stayGroups,currentLiveByNumber,plants);
 const allStays=await M.VehiclePlantStay.find({}).lean();
 await updateVehicleReferences(M.VehiclePlantStay.collection,allStays,'vehicle',true);

 await Promise.all([
  M.Vehicle.collection.createIndex({normalizedVehicleNumber:1},{unique:true,partialFilterExpression:{normalizedVehicleNumber:{$type:'string'}}}),
  M.VehicleLiveStatus.collection.createIndex({normalizedVehicleNumber:1},{unique:true,partialFilterExpression:{normalizedVehicleNumber:{$type:'string'}}}),
  M.VehiclePlantStay.collection.createIndex(
   {normalizedVehicleNumber:1},
   {unique:true,partialFilterExpression:{exitTime:null,normalizedVehicleNumber:{$type:'string'}}}
  )
 ]);
 console.info('[vehicle identity migration] Normalized indexes are active; GPS history was not modified or deleted.');
}

main().catch(error=>{
 console.error('[vehicle identity migration] failed:',error.message);
 process.exitCode=1;
}).finally(async()=>mongoose.disconnect());
