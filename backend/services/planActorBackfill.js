const mongoose=require('mongoose');
const {normalizeVehicleNumber}=require('./vehicleIdentity');

const AUDIT_MATCH_WINDOW_MS=30000;

function validActorId(value){
 const id=String(value||'');
 return mongoose.Types.ObjectId.isValid(id)?id:null;
}

function findAuditActor(logs,action,plan,timestamp){
 const targetTime=new Date(timestamp).getTime();
 const vehicle=normalizeVehicleNumber(plan.vehicle);
 if(!Number.isFinite(targetTime)||!vehicle)return null;
 const matches=logs.filter(log=>{
  if(log.action!==action||normalizeVehicleNumber(log.details?.vehicle)!==vehicle)return false;
  if(plan.plant&&log.details?.plant&&String(plan.plant)!==String(log.details.plant))return false;
  const loggedAt=new Date(log.createdAt).getTime();
  return validActorId(log.user)&&Number.isFinite(loggedAt)&&
   Math.abs(loggedAt-targetTime)<=AUDIT_MATCH_WINDOW_MS;
 });
 return matches.length===1?String(matches[0].user):null;
}

async function backfillPlanActors(models){
 const plans=await models.VehiclePlan.find({
  $or:[
   {createdByUserId:{$exists:false}},
   {createdByName:{$exists:false}},
   {updatedByUserId:{$exists:false}},
   {updatedByName:{$exists:false}}
  ]
 }).lean();
 const pending=[];

 for(const plan of plans){
  let creatorId=validActorId(plan.createdByUserId)||validActorId(plan.createdBy);
  let updaterId=validActorId(plan.updatedByUserId);
  const createdAt=new Date(plan.createdAt);
  const updatedAt=new Date(plan.updatedAt);
  const hasValidCreationTime=Number.isFinite(createdAt.getTime());
  const wasEdited=Number.isFinite(updatedAt.getTime())&&hasValidCreationTime&&
   updatedAt.getTime()-createdAt.getTime()>1000;

  if((!creatorId&&hasValidCreationTime)||(!updaterId&&wasEdited)){
   const timestamps=[hasValidCreationTime?createdAt.getTime():null,wasEdited?updatedAt.getTime():null].filter(Number.isFinite);
   const from=new Date(Math.min(...timestamps)-AUDIT_MATCH_WINDOW_MS);
   const to=new Date(Math.max(...timestamps)+AUDIT_MATCH_WINDOW_MS);
   const logs=await models.AuditLog.find({
    action:{$in:['create_plan','edit_plan']},
    'details.vehicle':plan.vehicle,
    createdAt:{$gte:from,$lte:to}
   }).select('action user details createdAt').lean();
   if(!creatorId&&hasValidCreationTime)creatorId=findAuditActor(logs,'create_plan',plan,createdAt);
   if(!updaterId&&wasEdited)updaterId=findAuditActor(logs,'edit_plan',plan,updatedAt);
  }
  pending.push({plan,creatorId,updaterId});
 }

 const actorIds=[...new Set(pending.flatMap(entry=>[entry.creatorId,entry.updaterId]).filter(Boolean))];
 const users=actorIds.length
  ?await models.User.find({_id:{$in:actorIds}}).select('_id fullName').lean()
  :[];
 const fullNames=new Map(users.map(user=>[String(user._id),user.fullName]));
 let updatedCount=0;

 for(const {plan,creatorId,updaterId} of pending){
  const updates={};
  if(!plan.createdByUserId&&creatorId)updates.createdByUserId=new mongoose.Types.ObjectId(creatorId);
  if(!plan.createdByName&&creatorId&&fullNames.has(creatorId))updates.createdByName=fullNames.get(creatorId);
  if(!plan.updatedByUserId&&updaterId)updates.updatedByUserId=new mongoose.Types.ObjectId(updaterId);
  if(!plan.updatedByName&&updaterId&&fullNames.has(updaterId))updates.updatedByName=fullNames.get(updaterId);
  if(!Object.keys(updates).length)continue;

  const filter={_id:plan._id};
  for(const key of Object.keys(updates))filter[key]={$in:[null,'']};
  const result=await models.VehiclePlan.collection.updateOne(filter,{$set:updates});
  if(result.modifiedCount)updatedCount++;
 }
 return updatedCount;
}

module.exports={backfillPlanActors,findAuditActor};
