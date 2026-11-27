const M=require('../models');

function validCoordinates(lat,lng){
 return lat!==null&&lat!==undefined&&String(lat).trim()!==''&&
  lng!==null&&lng!==undefined&&String(lng).trim()!==''&&
  Number.isFinite(Number(lat))&&Number(lat)>=-90&&Number(lat)<=90&&
  Number.isFinite(Number(lng))&&Number(lng)>=-180&&Number(lng)<=180;
}

function distanceKm(first,second){
 const toRadians=value=>value*Math.PI/180;
 const latDelta=toRadians(second.lat-first.lat);
 const lngDelta=toRadians(second.lng-first.lng);
 const value=Math.sin(latDelta/2)**2+
  Math.cos(toRadians(first.lat))*Math.cos(toRadians(second.lat))*
  Math.sin(lngDelta/2)**2;
 return 6371*2*Math.atan2(Math.sqrt(value),Math.sqrt(1-value));
}

function formatLayerOne(place){
 const placeName=String(place?.placeName||'').trim();
 const parts=[placeName,place?.district,place?.state,place?.postalCode]
  .map(value=>String(value||'').trim()).filter(Boolean);
 if(!parts.length)return '';
 if(placeName&&Number(place.distanceKm)>10){
  return `About ${Math.round(Number(place.distanceKm))} km from ${parts.join(', ')}`;
 }
 return `${placeName?'Near ':''}${parts.join(', ')}`;
}

async function lookup(lat,lng){
 if(!validCoordinates(lat,lng))return null;
 const latitude=Number(lat),longitude=Number(lng);
 const place=await M.GeoPlace.findOne({
  location:{$nearSphere:{$geometry:{type:'Point',coordinates:[longitude,latitude]}}}
 }).lean();
 if(!place)return null;
 const coordinates=place.location?.coordinates;
 if(!Array.isArray(coordinates)||coordinates.length<2)return null;
 const distance=distanceKm(
  {lat:latitude,lng:longitude},
  {lat:Number(coordinates[1]),lng:Number(coordinates[0])}
 );
 const result={
  placeName:place.placeName||'',district:place.district||'',
  state:place.state||'',postalCode:place.postalCode||'',
  distanceKm:distance
 };
 result.readableLocation=formatLayerOne(result);
 return result.readableLocation?result:null;
}

module.exports={lookup,distanceKm,formatLayerOne,validCoordinates};
