import test from 'node:test';
import assert from 'node:assert/strict';
import {
 getErrorMessage,getGpsSyncErrorDetails,isGpsSyncSuccessful,isRecordResponse,normalizeDashboardData
} from './errorHandling.js';

test('GPS sync error details ignore null, primitive, and missing provider results',()=>{
 assert.deepEqual(getGpsSyncErrorDetails(null),[]);
 assert.deepEqual(getGpsSyncErrorDetails({result:null}),[]);
 assert.deepEqual(getGpsSyncErrorDetails({
  result:{Wheelseye:null,FleetX:'failed',Other:{}}
 }),[]);
});

test('GPS sync error details accept array and object validation errors',()=>{
 assert.deepEqual(getGpsSyncErrorDetails({
  result:{
   Wheelseye:{errors:[{vehicleNumber:'AB123',message:'GPS record was rejected'},'Provider timeout']},
   FleetX:{errors:{vehicleNumber:['Vehicle number is required'],date:'Invalid date'}}
  }
 }),[
  'AB123: GPS record was rejected',
  'Provider timeout',
  'Vehicle number is required',
  'Invalid date'
 ]);
});

test('error messages safely cover null, strings, arrays, objects, and missing response errors',()=>{
 assert.equal(getErrorMessage(null,'Sync failed'),'Sync failed');
 assert.equal(getErrorMessage({response:{data:null,status:500}}),'The server is temporarily unavailable. Please try again.');
 assert.equal(getErrorMessage({response:{data:'Service unavailable',status:503}}),'Service unavailable');
 assert.equal(getErrorMessage({response:{data:{errors:[{msg:'Invalid vehicle'}]},status:422}}),'Invalid vehicle');
 assert.equal(getErrorMessage({response:{data:{error:{vehicle:['Unknown vehicle']}},status:400}}),'Unknown vehicle');
 assert.equal(getErrorMessage({request:{},message:'Network Error'}),'Unable to reach the server. Please try again.');
 assert.equal(getErrorMessage({response:{data:'<html>Unavailable</html>',status:502}}),'The server is temporarily unavailable. Please try again.');
});

test('HTTP failures without response messages have safe status-specific fallbacks',()=>{
 const expected=new Map([
  [400,'The request could not be processed.'],
  [401,'Your session has expired. Please sign in again.'],
  [403,'You do not have permission to complete this request.'],
  [404,'The requested resource could not be found.'],
  [422,'Please check the submitted information and try again.'],
  [429,'Too many requests. Please wait and try again.'],
  [500,'The server is temporarily unavailable. Please try again.']
 ]);
 for(const [status,message] of expected){
  assert.equal(getErrorMessage({response:{data:null,status}}),message);
 }
});

test('only plain object API responses are treated as structured result bodies',()=>{
 assert.equal(isRecordResponse({success:true}),true);
 assert.equal(isRecordResponse(null),false);
 assert.equal(isRecordResponse([]),false);
 assert.equal(isRecordResponse('invalid'),false);
});

test('GPS sync success requires an explicit success and provider result',()=>{
 assert.equal(isGpsSyncSuccessful({
  success:true,started:true,result:{Wheelseye:{status:'Connected'}}
 }),true);
 assert.equal(isGpsSyncSuccessful(null),false);
 assert.equal(isGpsSyncSuccessful({success:true,result:null}),false);
 assert.equal(isGpsSyncSuccessful({success:true,result:{Wheelseye:null}}),false);
 assert.equal(isGpsSyncSuccessful({success:false,result:{Wheelseye:{status:'Error'}}}),false);
});

test('dashboard null and incomplete payloads mark only unavailable widget data',()=>{
 const unavailable=normalizeDashboardData(null);
 assert.equal(unavailable.plantsAvailable,false);
 assert.equal(unavailable.transitAvailable,false);
 assert.deepEqual(unavailable.plants,[]);
 assert.deepEqual(unavailable.transit.rows,[]);

 const partial=normalizeDashboardData({
  plants:[{plant:'Tea Plant',count:'3',rows:[null,{vehicleNumber:'AB123'}]}],
  transit:null
 });
 assert.equal(partial.plantsAvailable,true);
 assert.equal(partial.plants[0].count,3);
 assert.deepEqual(partial.plants[0].rows,[{vehicleNumber:'AB123'}]);
 assert.equal(partial.transitAvailable,false);
});

test('valid empty dashboard arrays are available data, not a failed widget response',()=>{
 const dashboard=normalizeDashboardData({plants:[],transit:{count:0,rows:[]}});
 assert.equal(dashboard.plantsAvailable,true);
 assert.equal(dashboard.transitAvailable,true);
 assert.deepEqual(dashboard.plants,[]);
 assert.equal(dashboard.transit.count,0);
});
