const mongoose = require('mongoose');
const {normalizeVehicleNumber}=require('./services/vehicleIdentity');

const pagePermissionSchema=new mongoose.Schema({
  view:{type:Boolean,default:false},
  edit:{type:Boolean,default:false}
},{_id:false});

const permissionSchema = new mongoose.Schema({
  dashboard:{type:pagePermissionSchema,default:()=>({view:true,edit:false})},
  vehicleRegistry:{type:pagePermissionSchema,default:()=>({})},
  plant:{type:pagePermissionSchema,default:()=>({})},
  gpsTrack:{type:pagePermissionSchema,default:()=>({})},
  users:{type:pagePermissionSchema,default:()=>({})},
  sikkaAi:{type:pagePermissionSchema,default:()=>({})}
},{_id:false});

const userSchema=new mongoose.Schema({
 fullName:{type:String,required:true},username:{type:String,required:true,unique:true,trim:true,lowercase:true},
 passwordHash:{type:String,required:true,select:false},isAdmin:{type:Boolean,default:false},active:{type:Boolean,default:true},
 permissions:{type:permissionSchema,default:()=>({})},lastLogin:{type:Date},failedAttempts:{type:Number,default:0},lockedUntil:{type:Date}
},{timestamps:true});

const vehicleGpsProviderSchema=new mongoose.Schema({
 name:{type:String,enum:['Wheelseye','Fleetx'],required:true},
 vehicleId:String
},{_id:false});

const vehicleSchema=new mongoose.Schema({
 vehicleNumber:{type:String,required:true,unique:true,set:normalizeVehicleNumber},
 normalizedVehicleNumber:{type:String,required:true},
 fleetType:{type:String,enum:['Own Fleet','Contract Fleet'],required:true},
 gpsLink:{type:String,enum:['Wheelseye','Fleetx'],required:true},
 driver:{type:String,trim:true},
 mobile:{type:String,trim:true},
 plant:{type:String,trim:true},
 createdBy:{type:mongoose.Schema.Types.ObjectId,ref:'User'},
 updatedBy:{type:mongoose.Schema.Types.ObjectId,ref:'User'},
 providerVehicleId:{type:String},gpsProviders:{type:[vehicleGpsProviderSchema],default:[]},
 status:{type:String,enum:['Active','Inactive'],default:'Active'}
},{timestamps:true});
vehicleSchema.pre('validate',function(){
 const normalized=normalizeVehicleNumber(this.vehicleNumber);
 this.vehicleNumber=normalized;
 this.normalizedVehicleNumber=normalized;
});
vehicleSchema.index({normalizedVehicleNumber:1},{unique:true,partialFilterExpression:{normalizedVehicleNumber:{$type:'string'}}});

const plantSchema=new mongoose.Schema({
 code:{type:String,trim:true,uppercase:true},plantId:{type:String,trim:true},name:{type:String,required:true,trim:true},
 address:{type:String,trim:true},lat:{type:Number,required:true},lng:{type:Number,required:true},
 radius:{type:Number,required:true,min:1},status:{type:String,enum:['Active','Inactive'],default:'Active'}
},{timestamps:true});
plantSchema.index({code:1},{unique:true,sparse:true});
plantSchema.index({plantId:1},{unique:true,sparse:true});

const liveSchema=new mongoose.Schema({
 vehicleNumber:{type:String,required:true,unique:true,index:true,set:normalizeVehicleNumber},
 normalizedVehicleNumber:{type:String,required:true},lat:Number,lng:Number,speed:mongoose.Schema.Types.Mixed,
 ignition:{type:mongoose.Schema.Types.Mixed,default:null},gpsTime:Date,syncedAt:Date,provider:{type:String,enum:['Wheelseye','Fleetx','FLEETX']},
 address:String,heading:Number,unregistered:{type:Boolean,default:false},stale:{type:Boolean,default:false},
 lastGoodTime:Date,runningStatus:{type:String,enum:['Moving','Stopped','Idle','Unknown'],default:'Unknown'},
 providerVehicleId:String,driverName:String,vehicleStatus:String,
 readableLocation:String,locality:String,city:String,district:String,state:String,pincode:String,country:String,
 geocodedAt:Date,addressLat:Number,addressLng:Number,addressIsCurrent:{type:Boolean,default:false},
 geocodingProvider:{type:String,enum:['Google','OpenStreetMap','Provider','Coordinate']}
},{timestamps:true});
liveSchema.pre('validate',function(){
 const normalized=normalizeVehicleNumber(this.vehicleNumber);
 this.vehicleNumber=normalized;
 this.normalizedVehicleNumber=normalized;
});
liveSchema.index({normalizedVehicleNumber:1},{unique:true,partialFilterExpression:{normalizedVehicleNumber:{$type:'string'}}});

const historySchema=new mongoose.Schema({
 vehicle:{type:String,required:true,index:true,set:normalizeVehicleNumber},
 vehicleNumber:{type:String,set:value=>value?normalizeVehicleNumber(value):value},lat:Number,lng:Number,address:String,
 readableLocation:String,locality:String,city:String,district:String,state:String,pincode:String,country:String,
 geocodedAt:Date,addressLat:Number,addressLng:Number,addressIsCurrent:{type:Boolean,default:false},geocodingProvider:String,
 providerVehicleId:String,driverName:String,vehicleStatus:String,
 speed:mongoose.Schema.Types.Mixed,ignition:mongoose.Schema.Types.Mixed,gpsTime:{type:Date,index:true},provider:String,syncedAt:{type:Date,default:Date.now}
});
historySchema.index({vehicleNumber:1,gpsTime:1});
historySchema.index({vehicleNumber:1,gpsTime:1,provider:1},{unique:true,sparse:true});

const staySchema=new mongoose.Schema({
 vehicle:{type:String,required:true,index:true,set:normalizeVehicleNumber},
 normalizedVehicleNumber:{type:String,required:true},
 plant:{type:mongoose.Schema.Types.ObjectId,ref:'Plant',required:true},
 entryTime:{type:Date,required:true},exitTime:{type:Date}
});
staySchema.index({exitTime:1});
staySchema.pre('validate',function(){
 const normalized=normalizeVehicleNumber(this.vehicle);
 this.vehicle=normalized;
 this.normalizedVehicleNumber=normalized;
});
staySchema.index(
 {normalizedVehicleNumber:1},
 {unique:true,partialFilterExpression:{exitTime:null,normalizedVehicleNumber:{$type:'string'}}}
);

const planSchema=new mongoose.Schema({
 vehicle:{type:String,required:true,index:true,set:normalizeVehicleNumber},plant:{type:mongoose.Schema.Types.ObjectId,ref:'Plant'},
 planType:{type:String,enum:['Loading','Unloading','Maintenance','Waiting','Other'],required:true},
 remarks:String,expectedDeparture:Date,
 createdBy:{type:String},
 createdByUserId:{type:mongoose.Schema.Types.ObjectId,ref:'User'},createdByName:String,
 updatedByUserId:{type:mongoose.Schema.Types.ObjectId,ref:'User'},updatedByName:String,
 expiresAt:Date
},{timestamps:true});
planSchema.index({expiresAt:1},{expireAfterSeconds:0});

const providerStatusSchema=new mongoose.Schema({
 provider:{type:String,enum:['Wheelseye','Fleetx'],unique:true},status:{type:String,enum:['Connected','Disconnected','Error'],default:'Disconnected'},
 lastAttemptTime:Date,lastSuccessTime:Date,lastErrorMessage:String,lastErrorCode:Number,lastErrorTime:Date,vehicleCount:{type:Number,default:0},
 vehiclesReceived:{type:Number,default:0},vehiclesNotResponding:{type:Number,default:0},
 apiResponseStatus:Number
},{timestamps:true});
const gpsSettingSchema=new mongoose.Schema({
 provider:{type:String,enum:['Wheelseye','Fleetx'],required:true,unique:true},
 enabled:{type:Boolean,default:true},
 baseUrl:{type:String,trim:true},
 credentialsReference:{type:String,required:true},
 lastSyncStatus:{type:String,enum:['Connected','Disconnected','Error','Disabled'],default:'Disconnected'},
 lastSyncError:{type:String,default:''},
 lastSyncedAt:Date
},{timestamps:true});

const syncLogSchema=new mongoose.Schema({
 type:{type:String,enum:['auto','manual']},startedAt:{type:Date,default:Date.now},finishedAt:Date,
 result:{type:Object},success:{type:Boolean,default:false},
 totalRegisteredVehicles:{type:Number,default:0},successfulVehicles:{type:Number,default:0},
 failedVehicles:{type:Number,default:0},
 status:{type:String,enum:['Success','Partial','Failed','Skipped']},
 errorDetails:{type:[mongoose.Schema.Types.Mixed],default:[]}
},{timestamps:true});
syncLogSchema.index({type:1,startedAt:-1});
syncLogSchema.index({success:1,finishedAt:-1});
const gpsSyncConfigurationSchema=new mongoose.Schema({
 key:{type:String,required:true,unique:true},
 enabled:{type:Boolean,default:true},
 intervalMinutes:{type:Number,default:30},
 lastExecutionAt:Date,nextExecutionAt:Date,lastSuccessfulAt:Date,
 nextRetryAt:Date,retryAttempts:{type:Number,default:0},
 schedulerStatus:{type:String,enum:['starting','running','disabled','error','stopped'],default:'starting'},
 schedulerMode:{type:String,enum:['persistent','external']},
 schedulerHeartbeatAt:Date
},{timestamps:true});
const gpsSyncLockSchema=new mongoose.Schema({
 key:{type:String,required:true,unique:true},
 owner:{type:String,required:true},
 type:{type:String,enum:['auto','manual']},
 lockUntil:{type:Date,required:true},
 acquiredAt:{type:Date,required:true}
},{timestamps:true});
const syncStatusSchema=new mongoose.Schema({
 key:{type:String,required:true,unique:true},
 lastSyncAt:Date,lastSyncType:{type:String,enum:['AUTO','MANUAL']},
 lastSyncStatus:{type:String,enum:['Successful','Partial','Failed']},
 lastError:{type:String,default:''},providerResults:{type:mongoose.Schema.Types.Mixed,default:{}},lastAutoSyncAt:Date,
 isSyncing:{type:Boolean,default:false},syncStartedAt:Date
},{timestamps:true});
const fleetxTokenSchema=new mongoose.Schema({
 key:{type:String,required:true,unique:true},
 token:{type:String,required:true,select:false},
 expiresAt:{type:Date,default:null}
},{timestamps:true});

const shareSchema=new mongoose.Schema({
 vehicleNumber:{type:String,required:true,set:normalizeVehicleNumber},token:{type:String,required:true,unique:true},
 expiresAt:{type:Date,required:true},revoked:{type:Boolean,default:false},createdBy:{type:String}
},{timestamps:true});

const appSettingSchema=new mongoose.Schema({key:{type:String,unique:true},value:String},{timestamps:true});
const auditSchema=new mongoose.Schema({action:String,user:String,details:Object,ip:String},{timestamps:true});
const geocodeCacheSchema=new mongoose.Schema({
 key:{type:String,required:true,unique:true},
 lat:{type:Number,required:true},
 lng:{type:Number,required:true},
 readableLocation:{type:String},
 locality:String,
 city:String,
 district:String,
 state:String,
 pincode:String,
 country:String,
 provider:{type:String,enum:['Google','OpenStreetMap','Provider','Coordinate']},
 geocodedAt:Date,
 expiresAt:{type:Date,required:true}
},{timestamps:true});
geocodeCacheSchema.index({expiresAt:1},{expireAfterSeconds:0});
const sessionSchema=new mongoose.Schema({
 sessionId:{type:String,required:true,unique:true,index:true},
 user:{type:mongoose.Schema.Types.ObjectId,ref:'User',required:true,index:true},
 revoked:{type:Boolean,default:false},
 expiresAt:{type:Date,required:true},
 lastSeenAt:{type:Date,default:Date.now},
 userAgent:String,
 ip:String
},{timestamps:true});
sessionSchema.index({expiresAt:1},{expireAfterSeconds:0});
const sikkaAiChatSchema=new mongoose.Schema({
 userId:{type:mongoose.Schema.Types.ObjectId,ref:'User',required:true,index:true},
 username:{type:String,required:true,index:true},
 userFullName:{type:String,required:true},
 fullName:{type:String,required:true},
 role:{type:String,enum:['admin','user'],required:true},
 sessionId:{type:String,required:true,index:true},
 question:{type:String,required:true},
 answer:{type:mongoose.Schema.Types.Mixed,required:true},
 askedAt:{type:Date,required:true},
 answeredAt:{type:Date,required:true},
 language:{type:String,enum:['en','hi'],default:'en'},
 createdAt:{type:Date,required:true,default:Date.now},
 expireAt:{type:Date,required:true}
},{versionKey:false});
sikkaAiChatSchema.index({expireAt:1},{expireAfterSeconds:0});
sikkaAiChatSchema.index({userId:1,createdAt:-1});
sikkaAiChatSchema.index({createdAt:-1});
sikkaAiChatSchema.index({userId:1,askedAt:-1});
sikkaAiChatSchema.index({askedAt:-1});

module.exports={
 User:mongoose.model('User',userSchema),Vehicle:mongoose.model('Vehicle',vehicleSchema),
 Plant:mongoose.model('Plant',plantSchema),VehicleLiveStatus:mongoose.model('VehicleLiveStatus',liveSchema),
 VehicleLocationHistory:mongoose.model('VehicleLocationHistory',historySchema),
 VehiclePlantStay:mongoose.model('VehiclePlantStay',staySchema),VehiclePlan:mongoose.model('VehiclePlan',planSchema),
 GpsProviderStatus:mongoose.model('GpsProviderStatus',providerStatusSchema),
 GpsSetting:mongoose.model('GpsSetting',gpsSettingSchema,'gps_settings'),
 SyncLog:mongoose.model('SyncLog',syncLogSchema),ShareLink:mongoose.model('ShareLink',shareSchema),
 GpsSyncConfiguration:mongoose.model('GpsSyncConfiguration',gpsSyncConfigurationSchema,'gps_sync_configuration'),
 AppSetting:mongoose.model('AppSetting',appSettingSchema),AuditLog:mongoose.model('AuditLog',auditSchema),
 GeocodeCache:mongoose.model('GeocodeCache',geocodeCacheSchema),
 Session:mongoose.model('Session',sessionSchema),SikkaAiChat:mongoose.model('SikkaAiChat',sikkaAiChatSchema,'SikkaAiChat'),
 GpsSyncLock:mongoose.model('GpsSyncLock',gpsSyncLockSchema),
 SyncStatus:mongoose.model('SyncStatus',syncStatusSchema,'sync_status'),
 FleetxToken:mongoose.model('FleetxToken',fleetxTokenSchema,'fleetx_tokens')
};
