const test=require('node:test');
const assert=require('node:assert/strict');
const {persistMatchedRecords,aggregateSyncOutcome}=require('../services/gpsSyncOutcome');

async function syncRecords(recordsByProvider,registry){
 const saved=new Map([['WHEELS-1','old-wheelseye'],['FLEETX-1','old-fleetx']]);
 const providerResults={};
 for(const [provider,records] of Object.entries(recordsByProvider)){
  const outcome=await persistMatchedRecords({
   records,vehiclesByNumber:registry,providerName:provider,
   isLinked:(vehicle,name)=>vehicle.provider===name,
   persistRecord:async(record)=>saved.set(record.vehicleNumber,record.value)
  });
  providerResults[provider]={enabled:true,ok:records.length>0&&outcome.savedNumbers.size>0};
 }
 return {saved,aggregate:aggregateSyncOutcome(providerResults)};
}

const registry=new Map([
 ['WHEELS-1',{provider:'Wheelseye'}],
 ['FLEETX-1',{provider:'Fleetx'}]
]);

test('one provider failure is Partial and retains successful provider data',async()=>{
 const {saved,aggregate}=await syncRecords({
  Wheelseye:[{vehicleNumber:'WHEELS-1',value:'new-wheelseye'}],
  Fleetx:[]
 },registry);
 assert.equal(aggregate.status,'Partial');
 assert.equal(saved.get('WHEELS-1'),'new-wheelseye');
 assert.equal(saved.get('FLEETX-1'),'old-fleetx');
});

test('all provider failures are Failed and preserve last good data',async()=>{
 const {saved,aggregate}=await syncRecords({Wheelseye:[],Fleetx:[]},registry);
 assert.equal(aggregate.status,'Failed');
 assert.equal(saved.get('WHEELS-1'),'old-wheelseye');
 assert.equal(saved.get('FLEETX-1'),'old-fleetx');
});

test('all enabled providers succeeding is Successful',async()=>{
 const {saved,aggregate}=await syncRecords({
  Wheelseye:[{vehicleNumber:'WHEELS-1',value:'new-wheelseye'}],
  Fleetx:[{vehicleNumber:'FLEETX-1',value:'new-fleetx'}]
 },registry);
 assert.equal(aggregate.status,'Successful');
 assert.equal(saved.get('WHEELS-1'),'new-wheelseye');
 assert.equal(saved.get('FLEETX-1'),'new-fleetx');
});
