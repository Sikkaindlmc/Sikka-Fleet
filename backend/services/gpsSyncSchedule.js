const GPS_SYNC_INTERVAL_MS=30*60*1000;
const GPS_SYNC_RETRY_MS=5*60*1000;

function getNextAutoSyncAt(now=new Date(),latestSync=null){
 const completedAt=latestSync?.finishedAt?new Date(latestSync.finishedAt):now;
 const delay=latestSync?(latestSync.success?GPS_SYNC_INTERVAL_MS:GPS_SYNC_RETRY_MS):0;
 return new Date(completedAt.getTime()+delay);
}

module.exports={GPS_SYNC_INTERVAL_MS,GPS_SYNC_RETRY_MS,getNextAutoSyncAt};
