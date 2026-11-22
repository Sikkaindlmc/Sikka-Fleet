const test=require('node:test');
const assert=require('node:assert/strict');
const {getOperationalSnapshot}=require('../services/fleetSnapshotService');

const now=new Date('2026-11-22T10:00:00.000Z');
const chain=rows=>({
 select(){return this},
 sort(){return this},
 populate(){return this},
 lean(){return Promise.resolve(rows)}
});

test('snapshot counts one registered vehicle once across provider/live/stay duplicates',async()=>{
 const plantA={_id:'plant-a',name:'Salt Plant',lat:28,lng:77,radius:1000,status:'Active'};
 const plantB={_id:'plant-b',name:'Tea Plant',lat:29,lng:78,radius:1000,status:'Active'};
 const models={
  Plant:{find:()=>chain([plantA,plantB])},
  Vehicle:{find:()=>chain([
   {vehicleNumber:'UP 14-GT-0100',fleetType:'Own Fleet',gpsLink:'Wheelseye',
    gpsProviders:[{name:'Wheelseye'},{name:'FleetX'}],updatedAt:new Date('2026-11-21T00:00:00Z')},
   {vehicleNumber:'UP14GT0100',fleetType:'Own Fleet',gpsLink:'Wheelseye',
    gpsProviders:[{name:'Wheelseye'},{name:'FleetX'}],updatedAt:new Date('2026-11-22T00:00:00Z')},
   {vehicleNumber:'DL01AA1234',fleetType:'Contract Fleet',gpsLink:'FleetX'},
   {vehicleNumber:'MH02BB9876',fleetType:'Own Fleet',gpsLink:'Wheelseye'}
  ])},
  VehiclePlantStay:{find:()=>chain([
   {vehicle:'UP14GT0100',plant:plantA,entryTime:new Date('2026-11-22T07:00:00Z')},
   {vehicle:'UP 14-GT-0100',plant:plantA,entryTime:new Date('2026-11-22T08:00:00Z')},
   {vehicle:'UP14GT0100',plant:plantB,entryTime:new Date('2026-11-22T09:00:00Z')},
   {vehicle:'DL01AA1234',plant:plantA,entryTime:new Date('2026-11-22T09:00:00Z')}
  ])},
  VehicleLiveStatus:{find:()=>chain([
   {vehicleNumber:'UP14GT0100',provider:'Wheelseye',gpsTime:new Date('2026-11-22T08:00:00Z'),lat:28,lng:77,stale:false},
   {vehicleNumber:'UP 14-GT-0100',provider:'FleetX',gpsTime:new Date('2026-11-22T09:00:00Z'),lat:28,lng:77,stale:false},
   {vehicleNumber:'DL01AA1234',provider:'FleetX',gpsTime:new Date('2026-11-22T09:30:00Z'),lat:28.2,lng:77.2,stale:false},
   {vehicleNumber:'MH02BB9876',provider:'Wheelseye',gpsTime:new Date('2026-11-22T09:45:00Z'),lat:28.0002,lng:77.0002,stale:false}
  ])},
  GpsProviderStatus:{find:()=>chain([])},
  SyncLog:{findOne:()=>chain(null)}
 };

 const snapshot=await getOperationalSnapshot(models,now);
 assert.equal(snapshot.registeredCount,3);
 assert.equal(snapshot.live.length,3);
 const truck=snapshot.live.find(record=>record.vehicleNumber==='UP14GT0100');
 assert.equal(truck.provider,'FleetX');
 assert.deepEqual(snapshot.plants.map(plant=>plant.count),[2,0]);
 assert.equal(snapshot.plants[0].rows.find(row=>row.vehicleNumber==='UP14GT0100').entryTime.toISOString(),'2026-11-22T07:00:00.000Z');
 assert.equal(snapshot.plants[0].rows.find(row=>row.vehicleNumber==='MH02BB9876').entryTime,null);
 assert.equal(snapshot.transit.count,1);
 assert.equal(snapshot.transit.rows[0].vehicleNumber,'DL01AA1234');
});
