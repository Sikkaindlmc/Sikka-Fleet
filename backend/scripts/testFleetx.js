const path=require('path');
require('dotenv').config({path:path.join(__dirname,'..','.env')});
const fleetxService=require('../services/fleetxService');

async function main(){
 const response=await fleetxService.fetchLive();
 const vehicles=fleetxService.mapLiveRecords(response.data);
 console.log(`FleetX realtime vehicles received: ${vehicles.length}`);
 console.log(JSON.stringify(vehicles.slice(0,3).map(({vehicleNumber,lat,lng,speed,ignition})=>({
  vehicleNumber,lat,lng,speed,ignition
 })),null,2));
}

main().catch(error=>{
 const status=error.response?.status||error.statusCode||'network';
 console.error(`FleetX test failed (HTTP ${status}): ${error.response?.data?.message||error.message}`);
 process.exitCode=1;
});
