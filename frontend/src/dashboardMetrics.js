export function getIgnitionStatus(value){
 if(value===true||value===1)return 'ON';
 if(value===false||value===0)return 'OFF';
 const ignition=String(value??'').trim().toUpperCase();
 if(['ON','TRUE','1'].includes(ignition))return 'ON';
 if(['OFF','FALSE','0'].includes(ignition))return 'OFF';
 return 'UNKNOWN';
}

export function getIgnitionCounts(rows){
 const counts={on:0,off:0,unknown:0};
 for(const row of Array.isArray(rows)?rows:[]){
  const ignition=getIgnitionStatus(row?.ignitionStatus??row?.ignition);
  if(ignition==='ON')counts.on++;
  else if(ignition==='OFF')counts.off++;
  else counts.unknown++;
 }
 return counts;
}
