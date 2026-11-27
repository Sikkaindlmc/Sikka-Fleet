const test=require('node:test');
const assert=require('node:assert/strict');
const {mapProviderPayload}=require('../services/gpsProviderData');

test('WheelsEye mapping keeps API speed, ignition, and address values unchanged',()=>{
 const now=new Date('2024-01-01T00:01:00Z');
 const address='Road 4, Example City';
 const mapped=mapProviderPayload({data:[{
  vehicleNumber:' ab-123 ',latitude:12.5,longitude:77.6,speed:'0.0',
  ignition:false,address,lastUpdatedAt:1704067200000
 }]},'Wheelseye',{now});
 assert.equal(mapped.received,1);
 assert.equal(mapped.records.length,1);
 assert.equal(mapped.records[0].vehicleNumber,'AB123');
 assert.equal(mapped.records[0].speed,'0.0');
 assert.equal(mapped.records[0].ignition,false);
 assert.equal(mapped.records[0].ignitionStatus,'OFF');
 assert.equal(mapped.records[0].provider,'Wheelseye');
 assert.equal(mapped.records[0].providerAddress,address);
 assert.equal(mapped.records[0].gpsTime.toISOString(),'2024-01-01T00:00:00.000Z');
});

test('WheelsEye structured address fields use the returned formatted address',()=>{
 const mapped=mapProviderPayload({data:[{
  vehicleNumber:'AB123',latitude:12.5,longitude:77.6,speed:25,ignition:'ON',
  address:{formattedAddress:'Road 4, Example City'},lastUpdatedAt:1704067200000
 }]},'Wheelseye',{now:new Date('2024-01-01T00:01:00Z')});
 assert.equal(mapped.records[0].providerAddress,'Road 4, Example City');
 assert.equal(mapped.records[0].speed,25);
 assert.equal(mapped.records[0].ignition,'ON');
 assert.equal(mapped.records[0].ignitionStatus,'ON');
});

test('WheelsEye ignition status accepts only explicit ON/OFF values',()=>{
 const values=[
  [true,'ON'],[1,'ON'],['1','ON'],['ON','ON'],['TRUE','ON'],
  [false,'OFF'],[0,'OFF'],['0','OFF'],['OFF','OFF'],['FALSE','OFF'],
  [null,'UNKNOWN'],['running','UNKNOWN'],['stopped','UNKNOWN'],['yes','UNKNOWN']
 ];
 for(const [ignition,expected] of values){
  const mapped=mapProviderPayload({data:[{
   vehicleNumber:'AB123',latitude:12.5,longitude:77.6,speed:0,ignition,
   lastUpdatedAt:1704067200000
  }]},'Wheelseye',{now:new Date('2024-01-01T00:01:00Z')});
  assert.equal(mapped.records[0].ignitionStatus,expected);
  assert.equal(mapped.records[0].ignition,ignition);
 }
});

test('WheelsEye records without real coordinates or timestamps are rejected',()=>{
 const mapped=mapProviderPayload({data:[
  {vehicleNumber:'AB123',latitude:null,longitude:77.6,speed:0,lastUpdatedAt:1704067200000},
  {vehicleNumber:'CD456',latitude:12.5,longitude:77.6,speed:0}
 ]},'Wheelseye',{now:new Date('2024-01-01T00:01:00Z')});
 assert.equal(mapped.records.length,0);
 assert.deepEqual(mapped.rejected,{'missing latitude':1,'invalid timestamp':1});
});

test('unsupported GPS provider payloads are rejected',()=>{
 assert.throws(()=>mapProviderPayload({data:[]},'Other'),/Unsupported GPS provider/);
});
