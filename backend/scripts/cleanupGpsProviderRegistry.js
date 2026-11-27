const path=require('path');
require('dotenv').config({path:path.join(__dirname,'..','.env')});
const mongoose=require('mongoose');
const M=require('../models');

function providerFilter(value){
 const escaped=value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
 return new RegExp(`^${escaped}$`,'i');
}

function providerMention(value){
 const escaped=value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
 return new RegExp(escaped,'i');
}

async function main(){
 const args=process.argv.slice(2);
 const providerIndex=args.indexOf('--provider');
 const target=providerIndex>=0?String(args[providerIndex+1]||'').trim():'';
 const apply=args.includes('--apply');
 if(!target||target.toLowerCase()==='wheelseye'){
  throw new Error('Provide a non-WheelsEye provider with --provider');
 }
 const uri=process.env.MONGO_URI||process.env.MONGODB_URI;
 if(!uri)throw new Error('MONGO_URI or MONGODB_URI must be configured');
 await mongoose.connect(uri,{dbName:process.env.MONGODB_DB_NAME});

 const filter={provider:providerFilter(target)};
 const settings=M.GpsSetting.collection;
 const statuses=M.GpsProviderStatus.collection;
 const syncStatuses=M.SyncStatus.collection;
 const [settingCount,statusCount,syncStatus]=await Promise.all([
  settings.countDocuments(filter),
  statuses.countDocuments(filter),
  syncStatuses.findOne({key:'gps-sync'})
 ]);
 const syncStatusContainsTarget=providerMention(target).test(String(syncStatus?.lastError||''));

 if(apply){
  const session=await mongoose.startSession();
  try{
   await session.withTransaction(async()=>{
    await settings.updateMany(filter,{$set:{
     enabled:false,lastSyncStatus:'Disabled',lastSyncError:''
    }},{session});
    await statuses.updateMany(filter,{$set:{
     status:'Disconnected',lastErrorMessage:'',lastErrorCode:null,lastErrorTime:null,
     vehiclesNotResponding:0,vehiclesReceived:0
    }},{session});
    const update={$unset:{providerResults:''}};
    if(syncStatus?.lastSyncStatus==='Partial'||syncStatusContainsTarget){
     update.$set={
      ...(syncStatus?.lastSyncStatus==='Partial'?{lastSyncStatus:'Failed'}:{}),
      ...(syncStatusContainsTarget?{lastError:''}:{})
     };
    }
    if(Object.keys(update.$set||{}).length===0)delete update.$set;
    await syncStatuses.updateOne({key:'gps-sync'},update,{session});
   });
  }finally{
   await session.endSession();
  }
 }

 console.log(JSON.stringify({
  mode:apply?'applied':'dry-run',
  provider:target,
  settingsFound:settingCount,
  providerStatusesFound:statusCount,
  syncStatusFound:Boolean(syncStatus),
  syncStatusWasPartial:syncStatus?.lastSyncStatus==='Partial',
  syncStatusErrorContainedProvider:syncStatusContainsTarget,
  historicalSyncLogsChanged:false,
  vehicleAndHistoryDataChanged:false
 }));
}

main().catch(async error=>{
 console.error(`GPS provider registry migration failed: ${error.name}`);
 process.exitCode=1;
}).finally(async()=>{
 await mongoose.disconnect().catch(()=>{});
});
