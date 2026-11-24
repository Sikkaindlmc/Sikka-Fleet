const test=require('node:test');
const assert=require('node:assert/strict');
const {
 GPS_SYNC_INTERVAL_MS,GPS_SYNC_RETRY_MS,getNextAutoSyncAt
}=require('../services/gpsSyncSchedule');

test('successful sync schedules the next automatic sync exactly 30 minutes later',()=>{
 const finishedAt=new Date('2026-11-24T05:00:00.000Z');
 assert.equal(GPS_SYNC_INTERVAL_MS,1800000);
 assert.equal(
  getNextAutoSyncAt(new Date('2026-11-24T05:01:00.000Z'),{finishedAt,success:true}).toISOString(),
  '2026-11-24T05:30:00.000Z'
 );
});

test('failed sync uses a five-minute retry and an initial sync is due immediately',()=>{
 const now=new Date('2026-11-24T05:00:00.000Z');
 assert.equal(GPS_SYNC_RETRY_MS,300000);
 assert.equal(
  getNextAutoSyncAt(now,{finishedAt:now,success:false}).toISOString(),
  '2026-11-24T05:05:00.000Z'
 );
 assert.equal(getNextAutoSyncAt(now).toISOString(),now.toISOString());
});
