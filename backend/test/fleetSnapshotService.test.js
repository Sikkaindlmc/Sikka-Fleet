const test=require('node:test');
const assert=require('node:assert/strict');
const {getOperationalSnapshot,readableAddress}=require('../services/fleetSnapshotService');

const now=new Date('2026-11-22T10:00:00.000Z');
const chain=rows=>({
 select(){return this},
 sort(){return this},
 populate(){return this},
 lean(){return Promise.resolve(rows)}
});

test('snapshot address falls back to coordinates instead of an unavailable sentinel',()=>{
 assert.equal(readableAddress({
  lat:28.6692,lng:77.4538,readableLocation:'Address unavailable'
 }),'28.6692, 77.4538');
});

test('snapshot counts one registered vehicle once across provider/live/stay duplicates',async()=>{
 const plantA={_id:'plant-a',name:'Salt Plant',lat:28,lng:77,radius:1000,status:'Active'};
 const plantB={_id:'plant-b',name:'Tea Plant',lat:29,lng:78,radius:1000,status:'Active'};
 const models={
  Plant:{find:()=>chain([plantA,plantB])},
  Vehicle:{find:()=>chain([
   {vehicleNumber:'UP 14-GT-0100',fleetType:'Own Fleet',gpsLink:'Wheelseye',
    gpsProviders:[{name:'Wheelseye'}],updatedAt:new Date('2026-11-21T00:00:00Z')},
   {vehicleNumber:'UP14GT0100',fleetType:'Own Fleet',gpsLink:'Wheelseye',
    gpsProviders:[{name:'Wheelseye'}],updatedAt:new Date('2026-11-22T00:00:00Z')},
   {_id:'vehicle-dl-1',vehicleNumber:'DL01AA1234',fleetType:'Contract Fleet',gpsLink:'Wheelseye'},
   {vehicleNumber:'MH02BB9876',fleetType:'Own Fleet',gpsLink:'Wheelseye'},
   {vehicleNumber:'KA03CC4567',fleetType:'Contract Fleet',gpsLink:'Wheelseye'}
  ])},
  VehiclePlantStay:{find:()=>chain([
   {vehicle:'UP14GT0100',plant:plantA,entryTime:new Date('2026-11-22T07:00:00Z')},
   {vehicle:'UP 14-GT-0100',plant:plantA,entryTime:new Date('2026-11-22T08:00:00Z')},
   {vehicle:'UP14GT0100',plant:plantB,entryTime:new Date('2026-11-22T09:00:00Z')},
   {vehicle:'DL01AA1234',plant:plantA,entryTime:new Date('2026-11-22T09:00:00Z')}
  ])},
  VehicleLiveStatus:{find:()=>chain([
   {vehicleNumber:'UP14GT0100',provider:'Wheelseye',gpsTime:new Date('2026-11-22T08:00:00Z'),lat:28,lng:77,stale:false},
   {vehicleNumber:'UP 14-GT-0100',provider:'Wheelseye',gpsTime:new Date('2026-11-22T09:00:00Z'),lat:28,lng:77,stale:false},
   {vehicleNumber:'DL01AA1234',provider:'Wheelseye',gpsTime:new Date('2026-11-22T09:30:00Z'),lat:28.2,lng:77.2,ignition:false,stale:false},
   {vehicleNumber:'MH02BB9876',provider:'Wheelseye',gpsTime:new Date('2026-11-22T09:45:00Z'),lat:28.0002,lng:77.0002,ignition:true,stale:false}
  ])},
  GpsProviderStatus:{find:()=>chain([])},
  SyncLog:{findOne:()=>chain(null)}
 };

 const snapshot=await getOperationalSnapshot(models,now);
 assert.equal(snapshot.registeredCount,4);
 assert.equal(snapshot.live.length,4);
 assert.equal(snapshot.live.find(record=>record.vehicleNumber==='KA03CC4567').noGpsData,true);
 assert.equal(snapshot.summary.notResponding,1);
 assert.equal(snapshot.summary.ignitionOn,1);
 assert.equal(snapshot.summary.ignitionOff,1);
 assert.equal(snapshot.summary.ignitionUnknown,2);
 const truck=snapshot.live.find(record=>record.vehicleNumber==='UP14GT0100');
 assert.equal(truck.provider,'Wheelseye');
 assert.deepEqual(snapshot.plants.map(plant=>plant.count),[2,0]);
 assert.equal(snapshot.plants[0].rows.find(row=>row.vehicleNumber==='UP14GT0100').entryTime.toISOString(),'2026-11-22T07:00:00.000Z');
 assert.equal(snapshot.plants[0].rows.find(row=>row.vehicleNumber==='MH02BB9876').entryTime,null);
 assert.equal(snapshot.transit.count,1);
 assert.equal(snapshot.transit.rows[0].vehicleNumber,'DL01AA1234');
 assert.equal(snapshot.transit.rows[0].vehicleId,'vehicle-dl-1');
});
