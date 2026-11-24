const test=require('node:test');
const assert=require('node:assert/strict');
const {
 GPS_SYNC_INTERVAL_MS,GPS_SYNC_RETRY_MS,
 getNextScheduledSyncAt,getNextAutoSyncAt,getNextGpsExecutionAt
}=require('../services/gpsSyncSchedule');

test('automatic syncs stay aligned to fixed UTC half-hour slots',()=>{
 const finishedAt=new Date('2026-11-24T05:07:00.000Z');
 assert.equal(GPS_SYNC_INTERVAL_MS,1800000);
 assert.equal(
  getNextScheduledSyncAt(finishedAt).toISOString(),
  '2026-11-24T05:30:00.000Z'
 );
});

test('startup catches up once when a fixed slot was missed',()=>{
 const now=new Date('2026-11-24T06:00:00.000Z');
 const lastSync={finishedAt:new Date('2026-11-24T05:00:00.000Z')};
 assert.equal(GPS_SYNC_RETRY_MS,300000);
 assert.equal(
  getNextAutoSyncAt(now,lastSync).toISOString(),
  now.toISOString()
 );
});

test('initial schedule uses the next UTC half-hour boundary and persisted times survive refreshes',()=>{
 const now=new Date('2026-11-24T05:01:00.000Z');
 assert.equal(
  getNextAutoSyncAt(now).toISOString(),
  '2026-11-24T05:30:00.000Z'
 );
 assert.equal(
  getNextAutoSyncAt(now,null,new Date('2026-11-24T06:00:00.000Z')).toISOString(),
  '2026-11-24T06:00:00.000Z'
 );
});

test('next slot after an exact boundary is the following half-hour',()=>{
 assert.equal(
  getNextScheduledSyncAt(new Date('2026-11-24T05:30:00.000Z')).toISOString(),
  '2026-11-24T06:00:00.000Z'
 );
});

test('a UTC day contains 48 fixed scheduled sync slots',()=>{
 let cursor=new Date('2026-11-23T23:30:00.000Z');
 const slots=[];
 for(let cycle=0;cycle<48;cycle++){
  cursor=getNextScheduledSyncAt(cursor);
  slots.push(cursor.toISOString());
 }
 assert.equal(slots.length,48);
 assert.equal(slots[0],'2026-11-24T00:00:00.000Z');
 assert.equal(slots[47],'2026-11-24T23:30:00.000Z');
 assert.equal(
  getNextScheduledSyncAt(cursor).toISOString(),
  '2026-11-25T00:00:00.000Z'
 );
});

test('a controlled retry is earlier than the fixed schedule without shifting it',()=>{
 const now=new Date('2026-11-24T05:10:00.000Z');
 const scheduledAt=new Date('2026-11-24T05:30:00.000Z');
 const retryAt=new Date('2026-11-24T05:15:00.000Z');
 assert.equal(
  getNextGpsExecutionAt(now,{nextExecutionAt:scheduledAt,nextRetryAt:retryAt}).toISOString(),
  retryAt.toISOString()
 );
 assert.equal(
  getNextGpsExecutionAt(now,{nextExecutionAt:scheduledAt}).toISOString(),
  scheduledAt.toISOString()
 );
});

test('a missed scheduled cycle takes priority as one catch-up execution',()=>{
 const now=new Date('2026-11-24T05:35:00.000Z');
 assert.equal(
  getNextGpsExecutionAt(now,{
   nextExecutionAt:new Date('2026-11-24T05:30:00.000Z'),
   nextRetryAt:new Date('2026-11-24T05:40:00.000Z')
  }).toISOString(),
  now.toISOString()
 );
});
