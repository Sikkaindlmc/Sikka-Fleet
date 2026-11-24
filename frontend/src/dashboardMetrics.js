export function getIgnitionCounts(rows){
 const counts={on:0,off:0,unknown:0};
 for(const row of Array.isArray(rows)?rows:[]){
  const ignition=typeof row?.ignition==='string'?row.ignition.trim().toUpperCase():'';
  if(ignition==='ON')counts.on++;
  else if(ignition==='OFF')counts.off++;
  else counts.unknown++;
 }
 return counts;
}
