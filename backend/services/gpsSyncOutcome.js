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

function aggregateSyncOutcome(providerResult,{geofenceError=null}={}){
 const success=Boolean(providerResult?.ok&&!geofenceError);
 return {
  status:success?'Successful':'Failed',success
 };
}

module.exports={persistMatchedRecords,aggregateSyncOutcome};
