function normalizeVehicleNumber(value){
 return String(value||'').normalize('NFKC').toUpperCase().replace(/[^A-Z0-9]/g,'');
}

function groupByVehicleNumber(records,getNumber=record=>record.vehicleNumber){
 const groups=new Map();
 for(const record of records){
  const vehicleNumber=normalizeVehicleNumber(getNumber(record));
  if(!vehicleNumber)continue;
  const group=groups.get(vehicleNumber)||[];
  group.push(record);
  groups.set(vehicleNumber,group);
 }
 return groups;
}

function vehicleNumberRegex(value){
 const normalized=normalizeVehicleNumber(value);
 if(!normalized)return null;
 const characters=[...normalized].map(character=>character.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'));
 return new RegExp(`^${characters.join('[^A-Z0-9]*')}$`,'i');
}

module.exports={normalizeVehicleNumber,groupByVehicleNumber,vehicleNumberRegex};
