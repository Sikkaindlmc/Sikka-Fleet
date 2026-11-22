const test=require('node:test');
const assert=require('node:assert/strict');
const fleetxService=require('../services/fleetxService');

test('FleetX records preserve API speed and ignition while normalizing vehicle numbers',()=>{
 const [record]=fleetxService.mapLiveRecords({data:{vehicles:[{
  VEHICLE_NUMBER:' ab 12 cd 3456 ',
  LATITUDE:28.6139,
  LONGITUDE:77.209,
  SPEED:'0.0',
  IGNITION_STATUS:'OFF',
  TIME:'2025-01-02T03:04:05Z'
 }]}});

 assert.equal(record.vehicleNumber,'AB12CD3456');
 assert.equal(record.speed,'0.0');
 assert.equal(record.ignition,'OFF');
 assert.equal(record.gpsTime.toISOString(),'2025-01-02T03:04:05.000Z');
});

test('FleetX by-number mapping uses the requested vehicle number when the response omits it',()=>{
 const [record]=fleetxService.mapLiveRecords({
  latitude:19.076,
  longitude:72.8777,
  speed:12,
  ignition:true,
  time:'2025-02-03T04:05:06Z'
 },'mh 01 ab 1234');

 assert.equal(record.vehicleNumber,'MH01AB1234');
 assert.equal(record.speed,'12');
 assert.equal(record.ignition,'ON');
 assert.equal(record.runningStatus,'Moving');
});

test('FleetX ignition and motion states are normalized for GPS Track status counts',()=>{
 const [record]=fleetxService.mapLiveRecords({
  vehicleNumber:'MH01AB1234',latitude:19.076,longitude:72.8777,
  speed:0,ignition:true,time:'2025-02-03T04:05:06Z'
 });
 assert.equal(record.ignition,'ON');
 assert.equal(record.runningStatus,'Idle');
});
