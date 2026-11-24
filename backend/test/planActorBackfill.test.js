const test=require('node:test');
const assert=require('node:assert/strict');
const mongoose=require('mongoose');
const {backfillPlanActors,findAuditActor}=require('../services/planActorBackfill');

const creatorId='64b000000000000000000001';
const updaterId='64b000000000000000000002';
const plantId='64b000000000000000000003';

test('matches plan audit records only when the creator is unambiguous',()=>{
 const createdAt=new Date('2026-11-24T07:27:00.000Z');
 const plan={vehicle:'UP14GT0100',plant:plantId};
 const audit={action:'create_plan',user:creatorId,details:{vehicle:'UP 14 GT 0100',plant:plantId},createdAt:new Date(createdAt.getTime()+100)};

 assert.equal(findAuditActor([audit],'create_plan',plan,createdAt),creatorId);
 assert.equal(findAuditActor([audit,{...audit,user:updaterId}],'create_plan',plan,createdAt),null);
 assert.equal(findAuditActor([{...audit,details:{...audit.details,plant:'64b000000000000000000099'}}],'create_plan',plan,createdAt),null);
});

test('backfills plan creator and latest editor from audit records and user profiles',async()=>{
 const createdAt=new Date('2026-11-24T07:27:00.000Z');
 const updatedAt=new Date(createdAt.getTime()+5000);
 const plan={
  _id:new mongoose.Types.ObjectId(),vehicle:'UP14GT0100',plant:plantId,
  createdAt,updatedAt,planType:'Loading',remarks:'Existing remarks'
 };
 const auditRows=[
  {action:'create_plan',user:creatorId,details:{vehicle:plan.vehicle,plant:plantId},createdAt:new Date(createdAt.getTime()+100)},
  {action:'edit_plan',user:updaterId,details:{vehicle:plan.vehicle,plant:plantId},createdAt:new Date(updatedAt.getTime()+100)}
 ];
 let writtenFilter;
 let writtenUpdate;
 const models={
  VehiclePlan:{
   find:()=>({lean:async()=>[plan]}),
   collection:{updateOne:async(filter,update)=>{writtenFilter=filter;writtenUpdate=update;return {modifiedCount:1}}}
  },
  AuditLog:{find:()=>({select(){return this},lean:async()=>auditRows})},
  User:{find:()=>({select(){return this},lean:async()=>[
   {_id:new mongoose.Types.ObjectId(creatorId),fullName:'Plan Creator'},
   {_id:new mongoose.Types.ObjectId(updaterId),fullName:'Plan Editor'}
  ]})}
 };

 assert.equal(await backfillPlanActors(models),1);
 assert.equal(String(writtenUpdate.$set.createdByUserId),creatorId);
 assert.equal(writtenUpdate.$set.createdByName,'Plan Creator');
 assert.equal(String(writtenUpdate.$set.updatedByUserId),updaterId);
 assert.equal(writtenUpdate.$set.updatedByName,'Plan Editor');
 assert.equal(writtenUpdate.$set.updatedAt,undefined);
 assert.equal(writtenFilter._id,plan._id);
});
