async function persistMatchedRecords({
 records,vehiclesByNumber,providerName,isLinked,persistRecord
}){
 const receivedNumbers=new Set();
 const savedNumbers=new Set();
 let vehicleNumberMismatches=0;
 let saveErrors=0;
 for(const record of records){
  const vehicle=vehiclesByNumber.get(record.vehicleNumber);
  if(!vehicle||!isLinked(vehicle,providerName)){
   vehicleNumberMismatches++;
   continue;
  }
  receivedNumbers.add(record.vehicleNumber);
  try{
   await persistRecord(record,vehicle);
   savedNumbers.add(record.vehicleNumber);
  }catch{
   saveErrors++;
  }
 }
 return {receivedNumbers,savedNumbers,vehicleNumberMismatches,saveErrors};
}

function aggregateSyncOutcome(providerResults,{failedVehicleCount=0,geofenceError=null}={}){
 const enabled=Object.values(providerResults).filter(result=>result.enabled!==false);
 const succeeded=enabled.filter(result=>result.ok);
 const allEnabledSucceeded=enabled.length>0&&succeeded.length===enabled.length;
 const anyEnabledSucceeded=succeeded.length>0;
 const status=allEnabledSucceeded&&failedVehicleCount===0&&!geofenceError
  ?'Successful'
  :anyEnabledSucceeded||failedVehicleCount>0?'Partial':'Failed';
 return {
  status,success:status==='Successful',partialSuccess:status==='Partial',
  enabledProviderCount:enabled.length,succeededProviderCount:succeeded.length,
  failedProviderCount:enabled.length-succeeded.length
 };
}

module.exports={persistMatchedRecords,aggregateSyncOutcome};
