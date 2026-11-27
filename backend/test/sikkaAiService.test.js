const test=require('node:test');
const assert=require('node:assert/strict');
const service=require('../services/sikkaAiService');
const models=require('../models');
const historyRetention=require('../jobs/historyRetention');

const now=new Date('2026-11-22T10:06:00.000Z');
const chain=rows=>({
 populate(){return this},
 select(){return this},
 sort(){return this},
 limit(){return this},
 lean(){return Promise.resolve(rows)}
});
const one=row=>({
 populate(){return this},
 select(){return this},
 lean(){return Promise.resolve(row)}
});
const makeModels=(overrides={})=>({
 Plant:{find:()=>chain([])},
 Vehicle:{find:()=>chain([]),findOne:()=>one(null)},
 VehiclePlantStay:{find:()=>chain([]),findOne:()=>one(null)},
 VehicleLiveStatus:{find:()=>chain([]),findOne:()=>one(null)},
 GpsProviderStatus:{find:()=>chain([])},
 SyncLog:{findOne:()=>chain(null)},
 ...overrides
});

test('parses Hindi yesterday in India time and rejects future dates and times',()=>{
 const yesterday=service.parseDateRequest('UP14GT0100 ki kal ki history',now);
 assert.equal(yesterday.start.toISOString(),'2026-11-20T18:30:00.000Z');
 assert.equal(yesterday.future,false);
 assert.equal(service.parseDateRequest('UP14GT0100 ki 23-11-2026 history',now).future,true);
 assert.equal(service.parseDateRequest('Salt Plant 22-11-2026 at 4 PM availability',now).future,true);
});

test('parses inclusive DD-MM-YYYY history ranges in Asia/Kolkata',()=>{
 const range=service.parseDateRequest('UP14GT0100 10-11-2026 se 15-11-2026 tak',now);
 assert.equal(range.start.toISOString(),'2026-11-09T18:30:00.000Z');
 assert.equal(range.end.toISOString(),'2026-11-15T18:29:59.999Z');
});

test('parses named English dates and local time in Asia/Kolkata',()=>{
 const named=service.parseDateRequest('UP14GT0100 GPS history on 20 November 2026 at 10:30 AM',now);
 assert.equal(named.start.toISOString(),'2026-11-19T18:30:00.000Z');
 assert.equal(named.instant.toISOString(),'2026-11-20T05:00:00.000Z');
 assert.equal(named.hasTime,true);
 const withoutYear=service.parseDateRequest('UP14GT0100 on 10 November history',now);
 assert.equal(withoutYear.start.toISOString(),'2026-11-09T18:30:00.000Z');
 assert.equal(service.parseDateRequest('UP14GT0100 history on November 25, 2026',now).future,true);
});

test('matches case-insensitive plant names with a minor spelling error',()=>{
 const plant={_id:'salt-id',name:'Salt Plant'};
 assert.equal(service.matchPlant('Slt plnt available vehicles',[plant]),plant);
});

test('normalizes lowercase, spaces, dashes and dots in vehicle-number questions',()=>{
 assert.equal(service.extractVehicleNumber('up.14-ft.9150 Location'),'UP14FT9150');
 assert.equal(service.extractVehicleNumber('UP 14 FT 9150 kahan hai'),'UP14FT9150');
});

test('detects credential-like prompts before history storage',()=>{
 assert.equal(service.containsSensitiveInput('password=do-not-save-this'),true);
 assert.equal(service.containsSensitiveInput('Authorization: Bearer abc123'),true);
 assert.equal(service.containsSensitiveInput('Salt Plant available vehicles'),false);
});

test('preserves long, multilingual, multiline and special-character questions',()=>{
 for(const question of [
  '1234567890',
  'x'.repeat(100),
  'x'.repeat(1000),
  'x'.repeat(5000),
  'आज मेरी गाड़ी कहाँ है?',
  'Where is my vehicle today?',
  'आज vehicle की location कहाँ है?',
  'Show my vehicle\nUP14FT9150\nlocation now?',
  'Use <these> symbols & punctuation!',
  '  Keep the original surrounding whitespace.  '
 ]){
  assert.equal(service.cleanChatQuestion(question),question);
 }
});

test('lists registered GPS vehicles and excludes registrations without GPS integration or data',async()=>{
 const answer=await service.answerQuestion('Show all registered GPS vehicles',{
  models:makeModels({
   Vehicle:{find:()=>chain([
    {vehicleNumber:'UP14GT0100',gpsLink:'Wheelseye'},
    {vehicleNumber:'DL01AA1234'}
   ])}
  }),now
 });
 assert.equal(answer.type,'vehicleList');
 assert.deepEqual(answer.rows.map(row=>row.vehicleNumber),['UP14GT0100']);
 assert.equal(answer.rows[0].status,'GPS data unavailable');
});

test('attempts answers for 10, 100, 1000 and 5000 character questions',async()=>{
 const prefix='Where is vehicle UP14FT9150 now?';
 const questions=[
  'UP14FT9150',
  `${prefix}${'.'.repeat(100-prefix.length)}`,
  `${prefix}${'.'.repeat(1000-prefix.length)}`,
  `${prefix}${'.'.repeat(5000-prefix.length)}`,
  'UP14FT9150 की location अभी कहाँ है?',
  'Where is UP14FT9150 right now?',
  'UP14FT9150 की current location बताओ please.',
  'Where is UP14FT9150?\nPlease show its latest location.'
 ];
 for(const question of questions){
  const prompt=service.cleanChatQuestion(question);
  const answer=await service.answerQuestion(prompt,{models:makeModels(),now});
  assert.ok(answer.text?.trim(),`Expected a response for: ${question.slice(0,60)}`);
 }
});

test('chat records expire exactly seven days after creation and have a Mongo TTL index',()=>{
 const createdAt=new Date('2026-11-22T10:06:00.000Z');
 assert.equal(service.getChatExpiry(createdAt).toISOString(),'2026-11-29T10:06:00.000Z');
 assert.equal(models.SikkaAiChat.collection.collectionName,'SikkaAiChat');
 assert.equal(models.SikkaAiChat.schema.path('question').options.maxlength,undefined);
 assert.ok(models.SikkaAiChat.schema.indexes().some(([index,options])=>index.expireAt===1&&options.expireAfterSeconds===0));
 for(const field of ['userFullName','question','answer','askedAt','answeredAt']){
  assert.ok(models.SikkaAiChat.schema.path(field),`${field} chat field should be persisted`);
 }
});

test('answers plant availability with actual stay rows and a non-empty text reply',async()=>{
 const plant={_id:'salt-id',name:'Salt Plant',lat:28.5,lng:77.4,radius:1000,status:'Active'};
 const testModels=makeModels({
  Plant:{find:()=>chain([plant])},
  Vehicle:{find:()=>chain([{vehicleNumber:'UP14GT0100',gpsLink:'Wheelseye'}]),findOne:()=>one({vehicleNumber:'UP14GT0100',status:'Active',gpsLink:'Wheelseye'})},
  VehicleLiveStatus:{find:()=>chain([{
   vehicleNumber:'UP14GT0100',provider:'Wheelseye',lat:28.5,lng:77.4,
   gpsTime:now,syncedAt:now,address:'Salt Plant gate'
  }])},
  VehiclePlantStay:{find:()=>chain([{vehicle:'UP14GT0100',plant,entryTime:new Date('2026-11-22T07:06:00.000Z')}])}
 });
 const answer=await service.answerQuestion('Salt Plant Available Vehicle List',{models:testModels,now});
 assert.equal(answer.type,'plantVehicles');
 assert.match(answer.text,/1 vehicle\(s\) have confirmed availability at Salt Plant/);
 assert.equal(answer.rows[0].vehicleNumber,'UP14GT0100');
 assert.equal(answer.rows[0].availabilityStatus,'Available (confirmed)');
 assert.equal(answer.rows[0].gpsTime.toISOString(),now.toISOString());
});

test('lists all configured GPS vehicles with their current status and coordinates',async()=>{
 const answer=await service.answerQuestion('Show all registered GPS vehicles',{
  models:makeModels({
   Vehicle:{find:()=>chain([
    {vehicleNumber:'UP14GT0100',gpsLink:'Wheelseye'},
    {vehicleNumber:'DL01AA1234'}
   ])},
   VehicleLiveStatus:{find:()=>chain([{
    vehicleNumber:'UP14GT0100',provider:'Wheelseye',lat:28.5,lng:77.4,
    address:'Dasna, Uttar Pradesh',gpsTime:now,syncedAt:now,runningStatus:'Moving'
   }])}
  }),now
 });
 assert.equal(answer.type,'vehicleList');
 assert.deepEqual(answer.rows.map(row=>row.vehicleNumber),['UP14GT0100']);
 assert.equal(answer.rows[0].provider,'Wheelseye');
 assert.equal(answer.rows[0].lat,28.5);
 assert.equal(answer.rows[0].status,'Moving');
});

test('answers all-plants availability with grouped stays and outside vehicles',async()=>{
 const salt={_id:'salt-id',name:'Salt Plant',lat:28.5,lng:77.4,radius:1000,status:'Active'};
 const tea={_id:'tea-id',name:'Tea Plant',lat:29,lng:78,radius:1000,status:'Active'};
 const testModels=makeModels({
  Plant:{find:()=>chain([salt,tea])},
  VehiclePlantStay:{find:()=>chain([
   {vehicle:'UP14GT0100',plant:salt,entryTime:new Date('2026-11-22T07:06:00.000Z')}
  ])},
  Vehicle:{find:()=>chain([
   {vehicleNumber:'UP14GT0100',gpsLink:'Wheelseye'},
   {vehicleNumber:'DL01AA1234',gpsLink:'Wheelseye'}
  ])},
  VehicleLiveStatus:{find:()=>chain([
   {vehicleNumber:'UP14GT0100',provider:'Wheelseye',lat:28.5,lng:77.4,gpsTime:now,syncedAt:now},
   {vehicleNumber:'DL01AA1234',provider:'Wheelseye',lat:27,lng:77,gpsTime:now,syncedAt:now}
  ])}
 });
 const answer=await service.answerQuestion('All plant available vehicles',{models:testModels,now});
 assert.equal(answer.type,'plants');
 assert.deepEqual(answer.plants.map(plant=>[plant.plantName,plant.count]),[['Salt Plant',1],['Tea Plant',0]]);
 assert.deepEqual(answer.transit,{count:1,vehicles:['DL01AA1234']});
});

test('returns a Google Maps link and plant for current vehicle location',async()=>{
 const plant={_id:'salt-id',name:'Salt Plant',lat:28.5,lng:77.4,radius:1000,status:'Active'};
 const testModels=makeModels({
  Plant:{find:()=>chain([plant])},
  Vehicle:{find:()=>chain([{vehicleNumber:'UP14GT0100',gpsLink:'Wheelseye'}]),findOne:()=>one({vehicleNumber:'UP14GT0100',gpsLink:'Wheelseye',status:'Active'})},
  VehicleLiveStatus:{find:()=>chain([{
   vehicleNumber:'UP14GT0100',provider:'Wheelseye',readableLocation:'Dasna, Uttar Pradesh',speed:'28',ignition:'ON',
   gpsTime:new Date('2026-11-22T09:30:00.000Z'),lat:28.5,lng:77.4
  }]),findOne:()=>one({
   vehicleNumber:'UP14GT0100',provider:'Wheelseye',readableLocation:'Dasna, Uttar Pradesh',speed:'28',ignition:'ON',
   gpsTime:new Date('2026-11-22T09:30:00.000Z'),lat:28.5,lng:77.4
  })},
  VehiclePlantStay:{find:()=>chain([{vehicle:'UP14GT0100',plant:{_id:'salt-id',name:'Salt Plant'},entryTime:new Date('2026-11-22T08:30:00.000Z')}])}
 });
 const answer=await service.answerQuestion('UP14GT0100 kahan hai',{models:testModels,now});
 assert.equal(answer.type,'vehicle');
 assert.equal(answer.location,'Dasna, Uttar Pradesh');
 assert.equal(answer.plantName,'Salt Plant');
 assert.equal(answer.map,'https://www.google.com/maps?q=28.5,77.4');
});

test('reports nearest plant separately from confirmed plant availability',async()=>{
 const plant={_id:'salt-id',name:'Salt Plant',lat:28.51,lng:77.41,radius:100,status:'Active'};
 const live={vehicleNumber:'UP14GT0100',provider:'Wheelseye',lat:28.5,lng:77.4,gpsTime:now,syncedAt:now};
 const answer=await service.answerQuestion('Which plant is UP14GT0100 nearest to?',{
  models:makeModels({
   Plant:{find:()=>chain([plant])},
   Vehicle:{find:()=>chain([{vehicleNumber:'UP14GT0100',gpsLink:'Wheelseye'}]),findOne:()=>one({vehicleNumber:'UP14GT0100',gpsLink:'Wheelseye',status:'Active'})},
   VehicleLiveStatus:{find:()=>chain([live]),findOne:()=>one(live)}
  }),now
 });
 assert.equal(answer.nearestPlantName,'Salt Plant');
 assert.equal(answer.plantName,'Availability not confirmed');
 assert.equal(answer.plantConfirmed,false);
});

test('answers the exact UP14FT9150 Location phrasing from GPS snapshot data',async()=>{
 const plant={_id:'salt-id',name:'Salt Plant',lat:28.5,lng:77.4,radius:1000,status:'Active'};
 const answer=await service.answerQuestion('UP14FT9150 Location',{
  models:makeModels({
   Plant:{find:()=>chain([plant])},
   Vehicle:{find:()=>chain([   {vehicleNumber:'UP14FT9150',gpsLink:'Wheelseye'}]),findOne:()=>one({vehicleNumber:'UP14FT9150',gpsLink:'Wheelseye',status:'Active'})},
   VehicleLiveStatus:{find:()=>chain([{
    vehicleNumber:'UP14FT9150',address:'Dasna, Uttar Pradesh',speed:'31',ignition:'ON',
    gpsTime:new Date('2026-11-22T09:30:00.000Z'),provider:'Wheelseye',lat:28.5,lng:77.4
   }]),findOne:()=>one({
    vehicleNumber:'UP14FT9150',address:'Dasna, Uttar Pradesh',speed:'31',ignition:'ON',
    gpsTime:new Date('2026-11-22T09:30:00.000Z'),provider:'Wheelseye',lat:28.5,lng:77.4
   })},
   VehiclePlantStay:{find:()=>chain([{vehicle:'UP14FT9150',plant,entryTime:new Date('2026-11-22T08:30:00.000Z')}])}
  }),now
 });
 assert.equal(answer.type,'vehicle');
 assert.equal(answer.vehicleNumber,'UP14FT9150');
 assert.equal(answer.location,'Dasna, Uttar Pradesh');
 assert.equal(answer.provider,'Wheelseye');
 assert.equal(answer.speed,'31');
 assert.equal(answer.ignition,'ON');
 assert.equal(answer.plantName,'Salt Plant');
 assert.equal(answer.map,'https://www.google.com/maps?q=28.5,77.4');
});

test('answers vehicle history with readable data and Google map links',async()=>{
 const record={gpsTime:new Date('2026-11-20T08:30:00.000Z'),address:'Dasna, UP',speed:'42',ignition:'ON',lat:28.5,lng:77.4};
 const testModels=makeModels({
  Plant:{find:()=>chain([])},
  Vehicle:{find:()=>chain([{vehicleNumber:'UP14GT0100'}]),findOne:()=>one({vehicleNumber:'UP14GT0100',status:'Active'})},
  VehicleLocationHistory:{
   find:()=>chain([record]),
   countDocuments:async()=>1
  }
 });
 const answer=await service.answerQuestion('UP14GT0100 10-11-2026 se 15-11-2026 tak',{models:testModels,now});
 assert.equal(answer.type,'history');
 assert.equal(answer.rows[0].address,'Dasna, UP');
 assert.equal(answer.rows[0].speed,'42');
 assert.equal(answer.rows[0].ignition,'ON');
 assert.equal(answer.rows[0].map,'https://www.google.com/maps?q=28.5,77.4');
 assert.ok(answer.historyRange);
});

test('returns paginated, chronological history for all registered GPS vehicles',async()=>{
 let filterUsed;
 const records=[
  {vehicleNumber:'UP14GT0100',gpsTime:new Date('2026-11-20T05:00:00.000Z'),lat:28.5,lng:77.4,provider:'Wheelseye'},
  {vehicleNumber:'UP14GT0100',gpsTime:new Date('2026-11-20T05:30:00.000Z'),lat:28.6,lng:77.5,provider:'Wheelseye'}
 ];
 const answer=await service.answerQuestion('Show full-day GPS history for all registered vehicles on 20-11-2026',{
  models:makeModels({
   Vehicle:{find:()=>chain([{vehicleNumber:'UP14GT0100',gpsLink:'Wheelseye'}])},
   VehicleLocationHistory:{
    find:filter=>{filterUsed=filter;return chain(records)},
    countDocuments:async()=>2
   }
  }),now
 });
 assert.equal(answer.type,'history');
 assert.equal(answer.total,2);
 assert.deepEqual(answer.rows.map(row=>row.time),records.map(row=>row.gpsTime));
 assert.equal(answer.rows[0].lat,28.5);
 assert.equal(filterUsed.gpsTime.$gte.toISOString(),'2026-11-19T18:30:00.000Z');
 assert.equal(filterUsed.gpsTime.$lte.toISOString(),'2026-11-20T18:29:59.999Z');
});

test('answers kal history using yesterday in India time and blocks future queries',async()=>{
 let filterUsed;
 const historyModels=makeModels({
  Vehicle:{find:()=>chain([{vehicleNumber:'UP14GT0100'}]),findOne:()=>one({vehicleNumber:'UP14GT0100',status:'Active'})},
  Plant:{find:()=>chain([])},
  VehicleLocationHistory:{
   find:filter=>{filterUsed=filter;return chain([{gpsTime:new Date('2026-11-21T08:30:00.000Z'),address:'Dasna',lat:28.5,lng:77.4}])},
   countDocuments:async()=>1
  }
 });
 const answer=await service.answerQuestion('UP14GT0100 ki kal ki history',{models:historyModels,now});
 assert.equal(filterUsed.gpsTime.$gte.toISOString(),'2026-11-20T18:30:00.000Z');
 assert.equal(filterUsed.gpsTime.$lte.toISOString(),'2026-11-21T18:29:59.999Z');
 assert.equal(answer.type,'history');

 let plantsRead=false;
 const future=await service.answerQuestion('UP14GT0100 ki 23-11-2026 history',{
  models:makeModels({Plant:{find:()=>{plantsRead=true;return chain([])}}}),now
 });
 assert.equal(future.text,service.FUTURE_HISTORY_REPLY);
 assert.equal(plantsRead,false);
});

test('returns a friendly fallback instead of an empty reply',async()=>{
 const answer=await service.answerQuestion('Can you do something?',{models:makeModels(),now});
 assert.match(answer.text,/I could not match that question to available fleet records/);
 assert.ok(answer.text.length>0);
});

test('asks for a vehicle number and offers registered vehicle suggestions',async()=>{
 const answer=await service.answerQuestion('Where is a vehicle now',{
  models:makeModels({Vehicle:{find:()=>chain([{vehicleNumber:'UP14GT0100'},{vehicleNumber:'DL01AA1234'}])}}),now
 });
 assert.equal(answer.type,'vehiclePrompt');
 assert.equal(answer.text,'Which vehicle? Please enter its vehicle number.');
 assert.deepEqual(answer.suggestions.map(item=>item.label),['UP14GT0100','DL01AA1234']);
});

test('distinguishes an unregistered vehicle from a registered vehicle with no live GPS',async()=>{
 const unknown=await service.answerQuestion('ZZ99ZZ9999 Location',{models:makeModels(),now});
 assert.equal(unknown.type,'vehicleNotFound');
 assert.equal(unknown.text,'This vehicle number was not found in the registry.');

 const lastRecord={
  vehicleNumber:'UP14FT9150',gpsTime:new Date('2026-11-22T09:00:00.000Z'),
  address:'Dasna, Uttar Pradesh',lat:28.5,lng:77.4,speed:'0',ignition:'OFF',provider:'Wheelseye'
 };
 const missingLiveModels=makeModels({
  Vehicle:{find:filter=>chain(filter.status?[ ]:[{vehicleNumber:'UP14FT9150',status:'Active'}]),findOne:filter=>one(filter.status?{vehicleNumber:'UP14FT9150',status:'Active'}:null)},
  VehicleLiveStatus:{find:()=>chain([]),findOne:()=>one(null)},
  VehicleLocationHistory:{find:()=>chain([lastRecord])}
 });
 const missingLive=await service.answerQuestion('up.14-ft.9150 Location',{models:missingLiveModels,now});
 assert.equal(missingLive.type,'vehicleMissing');
 assert.match(missingLive.text,/Live GPS data for UP14FT9150 is not available/);
 assert.match(missingLive.text,/Last known location: Dasna, Uttar Pradesh/);
 assert.equal(missingLive.map,'https://www.google.com/maps?q=28.5,77.4');
});

test('unknown plant questions list actual plants as clickable suggestions',async()=>{
 const answer=await service.answerQuestion('Which vehicles are available now in Plant 1',{
  models:makeModels({Plant:{find:()=>chain([{_id:'salt',name:'Salt Plant'},{_id:'tea',name:'Tea Plant'}])}}),now
 });
 assert.equal(answer.type,'plantNotFound');
 assert.match(answer.text,/Available plants: Salt Plant, Tea Plant/);
 assert.deepEqual(answer.suggestions.map(item=>item.question),[
  'Which vehicles are available at Salt Plant?','Which vehicles are available at Tea Plant?'
 ]);
});

test('does not confirm plant availability from an old open stay without current GPS',async()=>{
 const salt={_id:'salt',name:'Salt Plant',lat:28.5,lng:77.4,radius:1000,status:'Active'};
 const answer=await service.answerQuestion('Plant availability now',{
  models:makeModels({
   Plant:{find:()=>chain([salt])},
   Vehicle:{find:()=>chain([{vehicleNumber:'UP14GT0100',gpsLink:'Wheelseye'}])},
   VehiclePlantStay:{find:()=>chain([{vehicle:'UP14GT0100',plant:salt,entryTime:new Date('2026-11-22T07:06:00.000Z')}])},
   VehicleLiveStatus:{find:()=>chain([])}
  }),now
 });
 assert.equal(answer.type,'plants');
 assert.equal(answer.plants[0].count,0);
 assert.equal(answer.plants[0].unconfirmedRows[0].availabilityStatus,'Availability not confirmed');
});

test('does not treat proximity to a plant geofence alone as confirmed availability',async()=>{
 const salt={_id:'salt',name:'Salt Plant',lat:28.5,lng:77.4,radius:1000,status:'Active'};
 const answer=await service.answerQuestion('Salt Plant available vehicles',{
  models:makeModels({
   Plant:{find:()=>chain([salt])},
   Vehicle:{find:()=>chain([{vehicleNumber:'UP14GT0100',gpsLink:'Wheelseye'}])},
   VehicleLiveStatus:{find:()=>chain([{
    vehicleNumber:'UP14GT0100',provider:'Wheelseye',lat:28.5,lng:77.4,gpsTime:now,syncedAt:now
   }])}
  }),now
 });
 assert.equal(answer.rows.length,0);
 assert.equal(answer.unconfirmedRows[0].availabilityStatus,'Availability not confirmed');
});

test('answers Hindi and Hinglish plant-exit questions using actual stay history',async()=>{
 for(const question of [
  'आज कितनी गाड़ियां प्लांट से बाहर गई हैं?',
  'Aaj kitni gadi plant se bahar gayi hain?',
  'How many vehicles went outside the plant today?'
 ]){
  let filter;
  const answer=await service.answerQuestion(question,{
   models:makeModels({
    Vehicle:{find:()=>chain([{vehicleNumber:'UP14GT0100',gpsLink:'Wheelseye'}])},
    VehiclePlantStay:{find:value=>{filter=value;return chain([
     {vehicle:'UP14GT0100',plant:{name:'Salt Plant'},exitTime:new Date('2026-11-22T09:00:00.000Z')}
    ])}}
   }),now
  });
  assert.equal(answer.type,'outsideHistory',question);
  assert.equal(answer.total,1,question);
  assert.ok(filter.exitTime.$gte>=service.getHistoryCutoff(now),question);
  assert.equal(answer.language,question.startsWith('How')?'en':'hi');
 }
});

test('rejects history older than 45 IST calendar days before reading records',async()=>{
 let historyRead=false;
 const answer=await service.answerQuestion('UP14GT0100 ki 07-10-2026 history',{
  models:makeModels({VehicleLocationHistory:{find:()=>{historyRead=true;return chain([])}}}),now
 });
 assert.equal(answer.type,'historyLimit');
 assert.equal(answer.text,service.HISTORY_LIMIT_REPLY);
 assert.equal(historyRead,false);
});

test('limits historical plant occupancy reads to the requested IST time and 45-day window',async()=>{
 const salt={_id:'salt',name:'Salt Plant',status:'Active'};
 let filter;
 const answer=await service.answerQuestion('Which vehicles were at Salt Plant on 18-11-2026 at 3 PM?',{
  models:makeModels({
   Plant:{find:()=>chain([salt])},
   Vehicle:{find:()=>chain([{vehicleNumber:'UP14GT0100',gpsLink:'Wheelseye'}])},
   VehiclePlantStay:{find:value=>{filter=value;return chain([
    {vehicle:'UP14GT0100',entryTime:new Date('2026-11-18T08:30:00.000Z')}
   ])}}
  }),now
 });
 assert.equal(answer.type,'plantVehicles');
 assert.equal(answer.rows[0].vehicleNumber,'UP14GT0100');
 assert.equal(filter.entryTime.$lte.toISOString(),'2026-11-18T09:30:00.000Z');
 assert.equal(filter.entryTime.$gte.toISOString(),service.getHistoryCutoff(now).toISOString());
});

test('denies GPS data access when the user lacks GPS Track permission',async()=>{
 let vehicleRead=false;
 const answer=await service.answerQuestion('UP14GT0100 Location',{
  models:makeModels({Vehicle:{find:()=>{vehicleRead=true;return chain([])}}}),
  permissions:{gpsTrack:false},now
 });
 assert.equal(answer.type,'forbidden');
 assert.equal(vehicleRead,false);
});

test('denies GPS vehicle lists when the user lacks GPS Track permission',async()=>{
 let vehicleRead=false;
 const answer=await service.answerQuestion('Show all registered GPS vehicles',{
  models:makeModels({Vehicle:{find:()=>{vehicleRead=true;return chain([])}}}),
  permissions:{gpsTrack:false},now
 });
 assert.equal(answer.type,'forbidden');
 assert.equal(vehicleRead,false);
});

test('daily retention deletes only GPS and completed plant history older than 60 days',async()=>{
 const filters=[];
 const logs={info(){},error(){}};
 const result=await historyRetention.cleanupHistory({
  VehicleLocationHistory:{deleteMany:async filter=>{filters.push(['gps',filter]);return {deletedCount:2}}},
  VehiclePlantStay:{deleteMany:async filter=>{filters.push(['stay',filter]);return {deletedCount:3}}}
 },now,logs);
 const expectedCutoff=new Date(now.getTime()-60*24*60*60*1000);
 assert.equal(result.cutoff,expectedCutoff.toISOString());
 assert.equal(result.vehicleLocationHistoryDeleted,2);
 assert.equal(result.vehiclePlantStayDeleted,3);
 assert.deepEqual(filters.map(([collection,filter])=>[collection,Object.keys(filter),filter.gpsTime?.$lt||filter.exitTime?.$lt]),[
  ['gps',['gpsTime'],expectedCutoff],
  ['stay',['exitTime'],expectedCutoff]
 ]);
});

test('retention logs a collection error with execution context and continues cleanup',async()=>{
 const errors=[];
 let stayDeleted=false;
 const logger={
  info(){},
  error(message,details){errors.push({message,details})}
 };
 const result=await historyRetention.cleanupHistory({
  VehicleLocationHistory:{deleteMany:async()=>{throw new Error('history unavailable')}},
  VehiclePlantStay:{deleteMany:async()=>{stayDeleted=true;return {deletedCount:1}}}
 },now,logger);
 assert.equal(result.errors[0].collection,'VehicleLocationHistory');
 assert.equal(result.vehiclePlantStayDeleted,1);
 assert.equal(stayDeleted,true);
 assert.equal(errors[0].details.stack.includes('history unavailable'),true);
 assert.equal(errors[0].details.cutoff,historyRetention.getHistoryCutoff(now).toISOString());
});
