const path=require('path');
require('dotenv').config({path:path.join(__dirname,'..','.env')});
const mongoose=require('mongoose');
const {normalizePermissions}=require('../permissions');

async function migrate(){
 const uri=process.env.MONGO_URI||process.env.MONGODB_URI;
 if(!uri)throw new Error('MONGO_URI or MONGODB_URI must be configured');
 await mongoose.connect(uri,{dbName:process.env.MONGODB_DB_NAME});
 const users=mongoose.connection.collection('users');
 const adminNames=new Set(['ajaysomra',(process.env.ADMIN_USERNAME||'ajaysomra').toLowerCase()]);
 let migrated=0;
 const cursor=users.find({}, {projection:{username:1,isAdmin:1,permissions:1}});
 for await(const user of cursor){
  const isAdmin=Boolean(user.isAdmin)||adminNames.has(String(user.username||'').toLowerCase());
  const update={$set:{permissions:normalizePermissions(user.permissions,isAdmin)}};
  if(isAdmin&&!user.isAdmin)update.$set.isAdmin=true;
  await users.updateOne({_id:user._id},update);
  migrated++;
 }
 console.log(`Migrated permissions for ${migrated} existing users.`);
}

migrate().then(()=>mongoose.disconnect()).catch(async error=>{
 console.error(`Permission migration failed: ${error.message}`);
 await mongoose.disconnect();
 process.exitCode=1;
});
