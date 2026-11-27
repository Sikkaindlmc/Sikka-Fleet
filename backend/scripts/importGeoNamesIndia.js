const crypto=require('crypto');
const fs=require('fs');
const path=require('path');
const readline=require('readline');
require('dotenv').config({path:path.join(__dirname,'..','.env')});
const mongoose=require('mongoose');
const M=require('../models');
const {calculateObjectSize}=require('bson');

const BATCH_SIZE=1000;
const ATLAS_FREE_STORAGE_LIMIT=512*1024*1024;
const INDEX_ESTIMATE_FACTOR=1.6;

function parseLine(line){
 const columns=line.split('\t');
 if(columns.length<12||columns[0]!=='IN'||!columns[1]||!columns[2])return null;
 const lat=Number(columns[9]),lng=Number(columns[10]);
 if(!Number.isFinite(lat)||lat < -90||lat > 90||!Number.isFinite(lng)||lng < -180||lng > 180)return null;
 const key=crypto.createHash('sha256').update(columns.slice(0,12).join('\t')).digest('hex');
 return {
  key,countryCode:columns[0],postalCode:columns[1],placeName:columns[2],
  state:columns[3],stateCode:columns[4],district:columns[5],
  districtCode:columns[6],subdistrict:columns[7],subdistrictCode:columns[8],
  location:{type:'Point',coordinates:[lng,lat]},
  accuracy:Number.isFinite(Number(columns[11]))?Number(columns[11]):null
 };
}

async function* records(file){
 const lines=readline.createInterface({input:fs.createReadStream(file),crlfDelay:Infinity});
 for await(const line of lines){
  if(!line)continue;
  const record=parseLine(line);
  if(record)yield record;
 }
}

async function scan(file,apply){
 let count=0,invalid=0,bsonBytes=0,batch=[];
 const collection=apply?M.GeoPlace.collection:null;
 async function flush(){
  if(!apply||!batch.length)return;
  const operations=batch.map(record=>({
   updateOne:{filter:{key:record.key},update:{$set:record},upsert:true}
  }));
  await collection.bulkWrite(operations,{ordered:false});
  batch=[];
 }
 const lines=readline.createInterface({input:fs.createReadStream(file),crlfDelay:Infinity});
 for await(const line of lines){
  if(!line)continue;
  const record=parseLine(line);
  if(!record){invalid++;continue;}
  bsonBytes+=calculateObjectSize({_id:new mongoose.Types.ObjectId(),...record});
  count++;
  if(apply){
   batch.push(record);
   if(batch.length>=BATCH_SIZE)await flush();
  }
 }
 await flush();
 return {count,invalid,bsonBytes};
}

async function main(){
 const args=process.argv.slice(2);
 const fileIndex=args.indexOf('--file');
 const file=fileIndex>=0?path.resolve(args[fileIndex+1]||''):'';
 const apply=args.includes('--apply');
 if(!file||!fs.existsSync(file)||!fs.statSync(file).isFile()){
  throw new Error('Provide an existing tab-delimited file with --file');
 }

 const estimate=await scan(file,false);
 const estimatedWithIndexesBytes=Math.ceil(estimate.bsonBytes*INDEX_ESTIMATE_FACTOR);
 if(!estimate.count)throw new Error('The input file contains no valid India postal rows');
 if(!apply){
  console.log(JSON.stringify({
   mode:'dry-run',rows:estimate.count,invalidRows:estimate.invalid,
   documentBsonBytes:estimate.bsonBytes,estimatedWithIndexesBytes,
   atlasFreeStorageLimitBytes:ATLAS_FREE_STORAGE_LIMIT
  }));
  return;
 }

 const uri=process.env.MONGO_URI||process.env.MONGODB_URI;
 if(!uri)throw new Error('MONGO_URI or MONGODB_URI must be configured');
 const options=process.env.MONGODB_DB_NAME?{dbName:process.env.MONGODB_DB_NAME}:{};
 await mongoose.connect(uri,options);
 const before=await mongoose.connection.db.stats();
 const usedBefore=Number(before.storageSize||0)+Number(before.indexSize||0);
 if(usedBefore+estimatedWithIndexesBytes>ATLAS_FREE_STORAGE_LIMIT){
  throw new Error('The estimated import would exceed the MongoDB Atlas free storage limit');
 }
 await M.GeoPlace.createIndexes();
 const imported=await scan(file,true);
 const collectionStats=await mongoose.connection.db.command({collStats:M.GeoPlace.collection.name,scale:1});
 const after=await mongoose.connection.db.stats();
 console.log(JSON.stringify({
  mode:'imported',rows:imported.count,invalidRows:imported.invalid,
  collectionDocuments:collectionStats.count,
  collectionDataBytes:collectionStats.size,
  collectionStorageBytes:collectionStats.storageSize,
  collectionIndexBytes:collectionStats.totalIndexSize,
  databaseStorageAndIndexBytes:Number(after.storageSize||0)+Number(after.indexSize||0),
  atlasFreeStorageLimitBytes:ATLAS_FREE_STORAGE_LIMIT
 }));
}

main().catch(error=>{
 console.error(`GeoNames import failed: ${error.name}`);
 process.exitCode=1;
}).finally(async()=>{
 await mongoose.disconnect().catch(()=>{});
});
