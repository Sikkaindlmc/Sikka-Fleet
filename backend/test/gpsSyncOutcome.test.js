const test=require('node:test');
const assert=require('node:assert/strict');
const {
 persistMatchedRecords,partitionProviderRecords,aggregateSyncOutcome
}=require('../services/gpsSyncOutcome');

async function syncRecords(records,apiSucceeded,registry){
 const saved=new Map([['WHEELS-1','last-good-location']]);
 const persisted=await persistMatchedRecords({
  records,vehiclesByNumber:registry,providerName:'Wheelseye',
  isLinked:(vehicle,name)=>vehicle.provider===name,
  persistRecord:async(record)=>saved.set(record.vehicleNumber,record.value)
 });
 return {
  saved,
  outcome:aggregateSyncOutcome({
   ok:apiSucceeded
  })
 };
}

const registry=new Map([['WHEELS-1',{status:'Active',provider:'Wheelseye'}]]);

test('empty WheelsEye response is successful with no GPS data and preserves the last good record',async()=>{
 const {saved,outcome}=await syncRecords([],true,registry);
 assert.equal(outcome.status,'Successful');
 assert.equal(saved.get('WHEELS-1'),'last-good-location');
});

test('failed WheelsEye request is Failed and preserves the last good record',async()=>{
 const {saved,outcome}=await syncRecords([],false,registry);
 assert.equal(outcome.status,'Failed');
 assert.equal(saved.get('WHEELS-1'),'last-good-location');
});

test('a saved WheelsEye record is Successful and updates only that vehicle',async()=>{
 const {saved,outcome}=await syncRecords([
  {vehicleNumber:'WHEELS-1',value:'new-location'}
 ],true,registry);
 assert.equal(outcome.status,'Successful');
 assert.equal(saved.get('WHEELS-1'),'new-location');
});

test('provider failures keep the real error message',()=>{
 const outcome=aggregateSyncOutcome({
  ok:false,reason:'WheelsEye returned HTTP 401 (access token is invalid or expired)'
 });
 assert.equal(outcome.status,'Failed');
 assert.match(outcome.message,/HTTP 401/);
});

test('persistence failures report the first actual save error',async()=>{
 const persisted=await persistMatchedRecords({
  records:[{vehicleNumber:'WHEELS-1'}],vehiclesByNumber:registry,
  providerName:'Wheelseye',isLinked:vehicle=>vehicle.provider==='Wheelseye',
  persistRecord:async()=>{throw new Error('Validation failed for speed')}
 });
 const outcome=aggregateSyncOutcome({
  ok:false,reason:'matched GPS records could not be saved'
 },{persistence:persisted});
 assert.match(outcome.message,/Validation failed for speed/);
});

test('geofence failures remain warnings after GPS records are saved',async()=>{
 const persisted=await persistMatchedRecords({
  records:[{vehicleNumber:'WHEELS-1'}],vehiclesByNumber:registry,
  providerName:'Wheelseye',isLinked:vehicle=>vehicle.provider==='Wheelseye',
  persistRecord:async()=>{}
 });
 const outcome=aggregateSyncOutcome({ok:true},{
  geofenceError:'Plant lookup unavailable',persistence:persisted
 });
 assert.equal(outcome.status,'Successful');
 assert.deepEqual(outcome.warnings,['Plant/geofence update failed: Plant lookup unavailable']);
});

test('provider records match only active linked registry vehicles and normalize formatting',()=>{
 const vehicles=[
  {vehicleNumber:'UP14FT9150',status:'Active',provider:'Wheelseye'},
  {vehicleNumber:'UP14GT0001',status:'Inactive',provider:'Wheelseye'},
  {vehicleNumber:'UP14GT0002',status:'Active',provider:'FleetX'}
 ];
 const partition=partitionProviderRecords({
  vehicles,providerName:'Wheelseye',
  isLinked:(vehicle,provider)=>vehicle.provider===provider,
  records:[
   {vehicleNumber:' up 14-ft 9150 ',gpsTime:new Date('2026-01-01T00:00:00Z'),id:'old'},
   {vehicleNumber:'UP14FT9150',gpsTime:new Date('2026-01-01T00:01:00Z'),id:'new'},
   {vehicleNumber:'UP14-GT-0001'},
   {vehicleNumber:'UP14GT0002'},
   {vehicleNumber:'UP14ZZ9999'}
  ]
 });
 assert.deepEqual(partition.eligibleRecords.map(record=>record.vehicleNumber),['UP14FT9150']);
 assert.equal(partition.eligibleRecords[0].id,'new');
 assert.deepEqual([...partition.inactiveVehicleNumbers],['UP14GT0001']);
 assert.deepEqual([...partition.providerNotLinkedVehicleNumbers],['UP14GT0002']);
 assert.deepEqual([...partition.unregisteredVehicleNumbers],['UP14ZZ9999']);
 assert.equal(partition.duplicateRecordCount,1);
});

test('inactive and unregistered provider records do not become sync failures',async()=>{
 const partition=partitionProviderRecords({
  vehicles:[{vehicleNumber:'UP14FT9150',status:'Inactive',provider:'Wheelseye'}],
  providerName:'Wheelseye',
  records:[{vehicleNumber:'UP14FT9150'},{vehicleNumber:'UP14ZZ9999'}]
 });
 const persisted=await persistMatchedRecords({
  records:partition.eligibleRecords,vehiclesByNumber:new Map(),
  providerName:'Wheelseye',isLinked:()=>true,persistRecord:async()=>{}
 });
 const outcome=aggregateSyncOutcome({ok:true,syncSummary:{
  inactiveVehiclesSkipped:partition.inactiveVehicleNumbers.size,
  unregisteredGpsRecordsIgnored:partition.unregisteredVehicleNumbers.size
 }},{persistence:persisted});
 assert.equal(outcome.status,'Successful');
 assert.deepEqual(outcome.warnings,[]);
 assert.equal(outcome.stats.inactiveVehiclesSkipped,1);
 assert.equal(outcome.stats.unregisteredGpsRecordsIgnored,1);
});

test('vehicles changed to inactive are excluded and can rejoin after reactivation',()=>{
 const vehicle={vehicleNumber:'UP14FT9150',status:'Active',provider:'Wheelseye'};
 const records=[{vehicleNumber:'UP14-FT-9150'}];
 const partition=()=>partitionProviderRecords({
  records,vehicles:[vehicle],providerName:'Wheelseye',
  isLinked:(item,provider)=>item.provider===provider
 });
 assert.equal(partition().eligibleRecords.length,1);
 vehicle.status='Inactive';
 assert.equal(partition().eligibleRecords.length,0);
 assert.deepEqual([...partition().inactiveVehicleNumbers],['UP14FT9150']);
 vehicle.status='Active';
 assert.equal(partition().eligibleRecords.length,1);
});

test('a vehicle deactivated after lookup is skipped without a persistence error',async()=>{
 const persisted=await persistMatchedRecords({
  records:[{vehicleNumber:'WHEELS-1'}],vehiclesByNumber:registry,
  providerName:'Wheelseye',isLinked:vehicle=>vehicle.provider==='Wheelseye',
  persistRecord:async()=>false
 });
 assert.equal(persisted.skippedNumbers.has('WHEELS-1'),true);
 assert.equal(persisted.saveErrors,0);
 assert.equal(persisted.savedNumbers.size,0);
 assert.equal(aggregateSyncOutcome({ok:true},{persistence:persisted}).status,'Successful');
});
