const test=require('node:test');
const assert=require('node:assert/strict');
const {VehiclePlan}=require('../models');
const {
 PLAN_EXPIRY_GRACE_PERIOD_MS,getActivePlanExpiryFilter,setPlanExpiryAfterPlantExit
}=require('../services/planExpiry');

test('vehicle plans have a MongoDB TTL index on their expiry timestamp',()=>{
 const expiresAtIndex=VehiclePlan.schema.indexes().find(([fields])=>fields.expiresAt===1);
 assert.ok(expiresAtIndex);
 assert.equal(expiresAtIndex[1].expireAfterSeconds,0);
});

test('expires plans one hour after the vehicle exits the associated plant',async()=>{
 const exitTime=new Date('2026-11-24T11:00:00.000Z');
 let filter,update;
 const models={VehiclePlan:{updateMany:async(query,changes)=>{
  filter=query;
  update=changes;
  return {modifiedCount:1};
 }}};

 await setPlanExpiryAfterPlantExit(models,{
  vehicle:'UP14FT9150',plant:'plant-1',exitTime
 });

 assert.equal(filter.vehicle.test('UP 14-FT-9150'),true);
 assert.equal(filter.plant,'plant-1');
 assert.deepEqual(filter.createdAt,{$lte:exitTime});
 assert.equal(
  update.$set.expiresAt.toISOString(),
  '2026-11-24T12:00:00.000Z'
 );
 assert.equal(PLAN_EXPIRY_GRACE_PERIOD_MS,60*60*1000);
});

test('does not expire plans created after the recorded plant exit',async()=>{
 const exitTime=new Date('2026-11-24T11:00:00.000Z');
 let filter;
 const models={VehiclePlan:{updateMany:async(query)=>{
  filter=query;
  return {modifiedCount:0};
 }}};

 await setPlanExpiryAfterPlantExit(models,{
  vehicle:'UP14FT9150',plant:'plant-1',exitTime
 });

 assert.deepEqual(filter.createdAt,{$lte:exitTime});
});

test('rejects invalid plant exit details instead of silently skipping expiry',async()=>{
 const models={VehiclePlan:{updateMany:async()=>assert.fail('Must not update plans')}};
 await assert.rejects(
  setPlanExpiryAfterPlantExit(models,{vehicle:'',plant:'plant-1',exitTime:new Date()}),
  {name:'TypeError'}
 );
});

test('active plan filter excludes plans as soon as their expiry time is reached',()=>{
 const now=new Date('2026-11-24T12:00:00.000Z');
 assert.deepEqual(getActivePlanExpiryFilter(now),{
  $or:[{expiresAt:null},{expiresAt:{$gt:now}}]
 });
});
