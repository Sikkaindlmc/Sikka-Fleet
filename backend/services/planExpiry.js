const {vehicleNumberRegex}=require('./vehicleIdentity');

const PLAN_EXPIRY_GRACE_PERIOD_MS=60*60*1000;

function getActivePlanExpiryFilter(now=new Date()){
 return {$or:[{expiresAt:null},{expiresAt:{$gt:now}}]};
}

async function setPlanExpiryAfterPlantExit(models,{vehicle,plant,exitTime}){
 const exitedAt=new Date(exitTime);
 const vehicleMatcher=vehicleNumberRegex(vehicle);
 if(!Number.isFinite(exitedAt.getTime())||!vehicleMatcher||!plant){
  throw new TypeError('A valid vehicle, plant, and exit time are required to schedule plan expiry');
 }
 return models.VehiclePlan.updateMany({
  vehicle:vehicleMatcher,plant,createdAt:{$lte:exitedAt}
 },{$set:{expiresAt:new Date(exitedAt.getTime()+PLAN_EXPIRY_GRACE_PERIOD_MS)}});
}

module.exports={PLAN_EXPIRY_GRACE_PERIOD_MS,getActivePlanExpiryFilter,setPlanExpiryAfterPlantExit};
