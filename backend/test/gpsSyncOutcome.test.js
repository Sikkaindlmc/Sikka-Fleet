const test=require('node:test');
const assert=require('node:assert/strict');
const {persistMatchedRecords,aggregateSyncOutcome}=require('../services/gpsSyncOutcome');

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
   ok:apiSucceeded&&persisted.savedNumbers.size>0
  })
 };
}

const registry=new Map([['WHEELS-1',{provider:'Wheelseye'}]]);

test('empty WheelsEye response is Failed and preserves the last good record',async()=>{
 const {saved,outcome}=await syncRecords([],true,registry);
 assert.equal(outcome.status,'Failed');
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
