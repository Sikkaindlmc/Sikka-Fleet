const test=require('node:test');
const assert=require('node:assert/strict');
const {mapProviderPayload}=require('../services/gpsProviderData');

test('Fleetx mapping preserves provider speed and ignition and reads epoch milliseconds',()=>{
 const now=new Date('2024-01-01T00:01:00Z');
 const mapped=mapProviderPayload({data:[{
  vehicleNumber:' ab-123 ',latitude:12.5,longitude:77.6,speed:0,
  otherAttributes:{ignition:false},lastUpdatedAt:1704067200000
 }]},'Fleetx',{now});
 assert.equal(mapped.received,1);
 assert.equal(mapped.records.length,1);
 assert.equal(mapped.records[0].vehicleNumber,'AB123');
 assert.equal(mapped.records[0].speed,0);
 assert.equal(mapped.records[0].ignition,false);
 assert.equal(mapped.records[0].provider,'FLEETX');
 assert.equal(mapped.records[0].gpsTime.toISOString(),'2024-01-01T00:00:00.000Z');
});

test('Fleetx records without real coordinates or timestamps are rejected',()=>{
 const mapped=mapProviderPayload({data:[
  {vehicleNumber:'AB123',latitude:null,longitude:77.6,speed:0,lastUpdatedAt:1704067200000},
  {vehicleNumber:'CD456',latitude:12.5,longitude:77.6,speed:0}
 ]},'Fleetx',{now:new Date('2024-01-01T00:01:00Z')});
 assert.equal(mapped.records.length,0);
 assert.deepEqual(mapped.rejected,{'missing latitude':1,'invalid timestamp':1});
});
