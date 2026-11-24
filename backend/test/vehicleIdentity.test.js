const test=require('node:test');
const assert=require('node:assert/strict');
const {normalizeVehicleNumber,groupByVehicleNumber,vehicleNumberRegex}=require('../services/vehicleIdentity');
const models=require('../models');

test('normalizes vehicle identity consistently across case and separators',()=>{
 assert.equal(normalizeVehicleNumber(' up 14-gt.0100 '),'UP14GT0100');
 assert.equal(normalizeVehicleNumber('ＵＰ１４ＧＴ０１００'),'UP14GT0100');
});

test('groups provider records by normalized vehicle identity',()=>{
 const groups=groupByVehicleNumber([
  {vehicleNumber:'UP 14 GT 0100',provider:'Wheelseye'},
  {vehicleNumber:'up14-gt.0100',provider:'Wheelseye'},
  {vehicleNumber:'DL01AA1234',provider:'Wheelseye'}
 ]);

 assert.equal(groups.get('UP14GT0100').length,2);
 assert.equal(groups.get('DL01AA1234').length,1);
});

test('builds a database matcher that accepts registration separators',()=>{
 const matcher=vehicleNumberRegex('UP14GT0100');
 assert.equal(matcher.test('up 14-gt.0100'),true);
 assert.equal(matcher.test('UP14GT0101'),false);
});

test('vehicle records canonicalize numbers and schemas enforce normalized uniqueness',async()=>{
 const vehicle=new models.Vehicle({
  vehicleNumber:' up 14-gt.0100 ',fleetType:'Own Fleet',gpsLink:'Wheelseye',status:'Active'
 });
 await vehicle.validate();
 assert.equal(vehicle.vehicleNumber,'UP14GT0100');
 assert.equal(vehicle.normalizedVehicleNumber,'UP14GT0100');

 for(const model of [models.Vehicle,models.VehicleLiveStatus]){
  assert.ok(model.schema.indexes().some(([keys,options])=>
   keys.normalizedVehicleNumber===1&&options.unique&&options.partialFilterExpression
  ));
 }
 assert.ok(models.VehiclePlantStay.schema.indexes().some(([keys,options])=>
  keys.normalizedVehicleNumber===1&&options.unique&&options.partialFilterExpression?.exitTime===null
 ));
});
