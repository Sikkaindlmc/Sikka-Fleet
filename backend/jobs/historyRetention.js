const RETENTION_DAYS=60;
const DAY_MS=24*60*60*1000;

function getHistoryCutoff(now=new Date()){
 return new Date(now.getTime()-RETENTION_DAYS*DAY_MS);
}

async function cleanupHistory(models,now=new Date(),logger=console){
 const executedAt=new Date(now);
 const cutoff=getHistoryCutoff(executedAt);
 const summary={
  executedAt:executedAt.toISOString(),
  cutoff:cutoff.toISOString(),
  vehicleLocationHistoryDeleted:0,
  vehiclePlantStayDeleted:0,
  errors:[]
 };
 const tasks=[
  ['VehicleLocationHistory','vehicleLocationHistoryDeleted',()=>models.VehicleLocationHistory.deleteMany({gpsTime:{$lt:cutoff}})],
  ['VehiclePlantStay','vehiclePlantStayDeleted',()=>models.VehiclePlantStay.deleteMany({exitTime:{$lt:cutoff}})]
 ];
 for(const [collection,resultKey,remove] of tasks){
  try{
   const result=await remove();
   summary[resultKey]=result.deletedCount||0;
  }catch(error){
   summary.errors.push({collection,message:error?.message||String(error)});
   logger.error(`[History retention] ${collection} cleanup failed`,{
    executedAt:summary.executedAt,cutoff:summary.cutoff,
    message:error?.message||String(error),stack:error?.stack||'No stack available'
   });
  }
 }
 logger.info('[History retention] Daily cleanup completed',summary);
 return summary;
}

module.exports={DAY_MS,RETENTION_DAYS,cleanupHistory,getHistoryCutoff};
