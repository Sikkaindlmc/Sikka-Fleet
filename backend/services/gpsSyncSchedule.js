const GPS_SYNC_INTERVAL_MS=30*60*1000;
const GPS_SYNC_RETRY_MS=5*60*1000;
const GPS_SYNC_HEARTBEAT_MS=30*1000;

function isGpsSchedulerHealthy(now,config){
 if(config?.enabled===false||config?.schedulerStatus!=='running')return false;
 const heartbeatAt=new Date(config.schedulerHeartbeatAt).getTime();
 const currentTime=new Date(now).getTime();
 return Number.isFinite(heartbeatAt)&&heartbeatAt<=currentTime&&
  currentTime-heartbeatAt<=GPS_SYNC_HEARTBEAT_MS*3;
}

function getNextScheduledSyncAt(after=new Date()){
 const timestamp=new Date(after).getTime();
 return new Date((Math.floor(timestamp/GPS_SYNC_INTERVAL_MS)+1)*GPS_SYNC_INTERVAL_MS);
}

function getNextAutoSyncAt(now=new Date(),latestSync=null,configuredNextAt=null){
 const currentTime=new Date(now).getTime();
 const configuredTime=configuredNextAt?new Date(configuredNextAt).getTime():NaN;
 if(Number.isFinite(configuredTime)){
  return configuredTime<=currentTime?new Date(currentTime):new Date(configuredTime);
 }
 if(latestSync?.finishedAt){
  const nextAfterLastSync=getNextScheduledSyncAt(latestSync.finishedAt);
  return nextAfterLastSync.getTime()<=currentTime?new Date(currentTime):nextAfterLastSync;
 }
 return getNextScheduledSyncAt(now);
}

function getNextGpsExecutionAt(now,config,lastAutoSync){
 const scheduledAt=config?.nextExecutionAt
  ?getNextAutoSyncAt(now,null,config.nextExecutionAt)
  :getNextAutoSyncAt(now,lastAutoSync);
 const retryTime=config?.nextRetryAt?new Date(config.nextRetryAt).getTime():NaN;
 if(!Number.isFinite(retryTime))return scheduledAt;
 const currentTime=new Date(now).getTime();
 const retryAt=retryTime<=currentTime?new Date(currentTime):new Date(retryTime);
 return retryAt<scheduledAt?retryAt:scheduledAt;
}

module.exports={
 GPS_SYNC_INTERVAL_MS,GPS_SYNC_RETRY_MS,GPS_SYNC_HEARTBEAT_MS,
 isGpsSchedulerHealthy,getNextScheduledSyncAt,getNextAutoSyncAt,getNextGpsExecutionAt
};
