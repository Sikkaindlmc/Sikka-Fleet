const PERMISSION_PAGES={
 dashboard:'Dashboard',
 vehicleRegistry:'Vehicle Registry',
 plant:'Plant',
 gpsTrack:'GPS Track',
 users:'Users',
 sikkaAi:'Sikka AI'
};

const LEGACY_KEYS=Object.fromEntries(
 Object.entries(PERMISSION_PAGES).map(([key,label])=>[key,label])
);

function normalizePermissions(value={},isAdmin=false){
 const result={};
 for(const [key,label] of Object.entries(PERMISSION_PAGES)){
  const saved=value?.[key]??value?.[LEGACY_KEYS[key]];
  let view=false,edit=false;
  if(typeof saved==='string'){
   const level=saved.toLowerCase();
   view=level==='view'||level==='edit';
   edit=level==='edit';
  }else if(saved&&typeof saved==='object'){
   edit=saved.edit===true;
   view=saved.view===true||edit;
  }
  if(key==='dashboard')view=true;
  if(isAdmin)view=edit=true;
  result[key]={view,edit};
 }
 return result;
}

function hasPermission(permissions,name,level='view',isAdmin=false){
 const key=Object.prototype.hasOwnProperty.call(PERMISSION_PAGES,name)
  ?name
  :Object.entries(PERMISSION_PAGES).find(([,label])=>label===name)?.[0];
 if(!key)return false;
 if(key==='sikkaAi'&&level==='edit')return false;
 if(isAdmin)return true;
 if(key==='dashboard'&&level==='view')return true;
 return permissions?.[key]?.[level]===true;
}

module.exports={PERMISSION_PAGES,normalizePermissions,hasPermission};
