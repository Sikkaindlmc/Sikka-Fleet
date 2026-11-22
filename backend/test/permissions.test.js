const test=require('node:test');
const assert=require('node:assert/strict');
const {normalizePermissions,hasPermission}=require('../permissions');

test('converts legacy levels and always grants Dashboard view',()=>{
 const permissions=normalizePermissions({
  Dashboard:'None',
  'Vehicle Registry':'Edit',
  Plant:'View',
  'GPS Track':'None',
  Users:'None',
  'Sikka AI':'View'
 });
 assert.deepEqual(permissions,{
  dashboard:{view:true,edit:false},
  vehicleRegistry:{view:true,edit:true},
  plant:{view:true,edit:false},
  gpsTrack:{view:false,edit:false},
  users:{view:false,edit:false},
  sikkaAi:{view:true,edit:false}
 });
});

test('Edit implies View and Sikka AI never grants write access',()=>{
 const permissions=normalizePermissions({
  vehicleRegistry:{view:false,edit:true},
  sikkaAi:{view:true,edit:true}
 });
 assert.equal(permissions.vehicleRegistry.view,true);
 assert.equal(hasPermission(permissions,'vehicleRegistry','edit'),true);
 assert.equal(hasPermission(permissions,'sikkaAi','edit'),false);
 assert.equal(hasPermission(permissions,'sikkaAi','view'),true);
});

test('administrators receive every permission level',()=>{
 const permissions=normalizePermissions({},true);
 for(const key of Object.keys(permissions)){
  assert.deepEqual(permissions[key],{view:true,edit:true});
  assert.equal(hasPermission(permissions,key,'view',true),true);
  assert.equal(hasPermission(permissions,key,'edit',true),key!=='sikkaAi');
 }
});
