import React,{createContext,useContext,useEffect,useRef,useState} from 'react';
import {BrowserRouter,Routes,Route,Navigate,useNavigate,useLocation} from 'react-router-dom';
import {motion,AnimatePresence} from 'framer-motion';
import {createPortal} from 'react-dom';
import {LayoutDashboard,Truck,Factory,MapPin,Users,LogOut,Menu,X,Bot,RefreshCw,Moon,Sun,Plus,Edit3,Trash2,Search,Eye,EyeOff,Share2,Settings,MapPinned,ChevronRight,AlertTriangle} from 'lucide-react';
import axios from 'axios';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import './index.css';
import './permissions.css';
import './chat.css';
import './gps.css';

axios.defaults.baseURL='/api';axios.defaults.withCredentials=true;
let refreshPromise=null;
axios.interceptors.response.use(
 response=>response,
 async error=>{
  const request=error.config;
  if(error.response?.status===401&&request&&!request._authRetried&&!request.url?.startsWith('/auth/')){
   request._authRetried=true;
   try{
    refreshPromise=refreshPromise||axios.post('/auth/refresh');
    await refreshPromise;
    refreshPromise=null;
    return axios(request);
   }catch{
    refreshPromise=null;
   }
  }
  return Promise.reject(error);
 }
);
const Auth=createContext(null);
const useAuth=()=>useContext(Auth);
const fmt=(d,withTime=true)=>d?new Date(d).toLocaleString('en-IN',{day:'2-digit',month:'2-digit',year:'numeric',...(withTime?{hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:true}:{})}):'N/A';
const fmtIst=d=>{
 if(!d)return 'N/A';
 const parts=new Intl.DateTimeFormat('en-IN',{
  timeZone:'Asia/Kolkata',day:'2-digit',month:'2-digit',year:'numeric',
  hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:true
 }).formatToParts(new Date(d));
 const values=Object.fromEntries(parts.filter(part=>part.type!=='literal').map(part=>[part.type,part.value]));
 return `${values.day}-${values.month}-${values.year} ${values.hour}:${values.minute}:${values.second} ${String(values.dayPeriod||'').toUpperCase()}`;
};
const speedText=vehicle=>vehicle?.speed==null||vehicle.speed==='N/A'?'N/A':vehicle.provider==='FleetX'?String(vehicle.speed):`${vehicle.speed} km/h`;
const showToast=(text,type='success')=>window.dispatchEvent(new CustomEvent('toast',{detail:{text,type}}));
const PERMISSION_PAGES=[
 {key:'dashboard',label:'Dashboard'},
 {key:'vehicleRegistry',label:'Vehicle Registry'},
 {key:'plant',label:'Plant'},
 {key:'gpsTrack',label:'GPS Track'},
 {key:'users',label:'Users'},
 {key:'sikkaAi',label:'Sikka AI'}
];
const createDefaultPermissions=()=>({
 dashboard:{view:true,edit:false},
 vehicleRegistry:{view:false,edit:false},
 plant:{view:false,edit:false},
 gpsTrack:{view:false,edit:false},
 users:{view:false,edit:false},
 sikkaAi:{view:false,edit:false}
});
const canView=(user,key)=>Boolean(user?.isAdmin||key==='dashboard'||user?.permissions?.[key]?.view===true);
const canEdit=(user,key)=>key!=='sikkaAi'&&Boolean(user?.isAdmin||user?.permissions?.[key]?.edit===true);
const summarizePermissions=permissions=>PERMISSION_PAGES.map(({key,label})=>{
 const access=permissions?.[key]||{};
 const level=key==='sikkaAi'?(access.view?'View':'None'):access.edit?'Edit':access.view?'View':'None';
 return level==='None'?null:`${label}:${level}`;
}).filter(Boolean).join(', ')||'No access';
const modalStack=[];
let savedBodyOverflow='';
let savedRootOverflow='';

function AnimatedButton({children,variant='blue',loading=false,disabled=false,className='',onClick,type='button',...props}){
 return <motion.button whileHover={!disabled&&!loading?{y:-2}:{}} whileTap={!disabled&&!loading?{scale:.97}:{}} type={type} disabled={disabled||loading}
 onClick={onClick} className={`animated-btn ${variant} ${loading?'is-loading':''} ${className}`} {...props}>
 {loading&&<motion.span className="spinner" animate={{rotate:360}} transition={{repeat:Infinity,duration:.8,ease:'linear'}}/>}
 {children}</motion.button>
}

function Modal({open,onClose,title,children,size='md',disableClose=false,placement='center'}){
 const close=()=>{if(!disableClose)onClose()};
 const closeRef=useRef(()=>{if(!disableClose)onClose()});
 useEffect(()=>{closeRef.current=()=>{if(!disableClose)onClose()}},[onClose,disableClose]);
 useEffect(()=>{
  if(!open)return;
  const entry={close:()=>closeRef.current(),disableClose};
  if(!modalStack.length){
   savedBodyOverflow=document.body.style.overflow;
   savedRootOverflow=document.documentElement.style.overflow;
   document.body.style.overflow='hidden';
   document.documentElement.style.overflow='hidden';
  }
  modalStack.push(entry);
  const onKeyDown=event=>{
   if(event.key==='Escape'&&modalStack[modalStack.length-1]===entry&&!entry.disableClose){
    event.preventDefault();
    event.stopPropagation();
    entry.close();
   }
  };
  document.addEventListener('keydown',onKeyDown);
  return ()=>{
   document.removeEventListener('keydown',onKeyDown);
   const index=modalStack.indexOf(entry);
   if(index>=0)modalStack.splice(index,1);
   if(!modalStack.length){
    document.body.style.overflow=savedBodyOverflow;
    document.documentElement.style.overflow=savedRootOverflow;
   }
  };
 },[open,disableClose]);
 const right=placement==='right';
 const bottom=placement==='bottom';
 return createPortal(<AnimatePresence>{open&&
  <motion.div className={`modal-overlay ${right?'modal-overlay-right':''} ${bottom?'modal-overlay-bottom':''}`} initial={{opacity:0}} animate={{opacity:1}} exit={{opacity:0}} onClick={event=>{if(event.target===event.currentTarget)close()}}>
  <motion.section role="dialog" aria-modal="true" aria-label={title} className={`app-modal modal-${size} ${right?'app-modal-right':''} ${bottom?'app-modal-bottom':''}`} initial={right?{opacity:0,x:24}:bottom?{opacity:0,y:24,scale:.98}:{opacity:0,y:18,scale:.98}} animate={{opacity:1,x:0,y:0,scale:1}} exit={right?{opacity:0,x:24}:bottom?{opacity:0,y:24,scale:.98}:{opacity:0,y:18,scale:.98}} onClick={event=>event.stopPropagation()}>
   <div className="modal-head"><h2>{title}</h2><AnimatedButton variant="ghost" onClick={close} disabled={disableClose} aria-label="Close"><X size={20}/></AnimatedButton></div>
   <div className="modal-body">{children}</div>
  </motion.section>
  </motion.div>
 }</AnimatePresence>,document.body)
}

function Toasts(){
 const [items,setItems]=useState([]);
 useEffect(()=>{const h=e=>{const id=Date.now();setItems(x=>[...x,{id,...e.detail}]);setTimeout(()=>setItems(x=>x.filter(i=>i.id!==id)),3500)};window.addEventListener('toast',h);return()=>window.removeEventListener('toast',h)},[]);
 return <div className="toast-stack">{items.map(t=><motion.div key={t.id} className={`toast ${t.type}`} initial={{x:80,opacity:0}} animate={{x:0,opacity:1}}>{t.text}</motion.div>)}</div>
}

function Login(){
 const {login}=useAuth();const [username,setUsername]=useState('');const [password,setPassword]=useState('');const [show,setShow]=useState(false);const [loading,setLoading]=useState(false);const [shake,setShake]=useState(false);
 const submit=async()=>{setLoading(true);try{await login(username,password)}catch(e){setShake(true);setTimeout(()=>setShake(false),500);showToast(e.response?.data?.error||'Login failed','error')}finally{setLoading(false)}};
 return <main className="login-page">
  <div className="login-orb orb-a"/><div className="login-orb orb-b"/>
  <motion.div className="login-brand" initial={{scale:.7,opacity:0}} animate={{scale:1,opacity:1}} transition={{duration:.7}}><motion.img src="/logo.png" alt="Sikka Fleet" animate={{filter:['drop-shadow(0 0 0 rgba(96,165,250,0)','drop-shadow(0 0 16px rgba(96,165,250,.8))','drop-shadow(0 0 0 rgba(96,165,250,0)']}} transition={{duration:2.5,repeat:Infinity}}/><h1>{'Welcome to Sikka Fleet'.split(' ').map((w,i)=><motion.span key={i} initial={{opacity:0,y:12}} animate={{opacity:1,y:0}} transition={{delay:.35+i*.12}}>{w}&nbsp;</motion.span>)}</h1></motion.div>
  <motion.form onSubmit={e=>{e.preventDefault();submit()}} className={`login-card ${shake?'shake':''}`} initial={{y:60,opacity:0}} animate={{y:0,opacity:1}}>
   <label>Username<div className="input-wrap"><input value={username} onChange={e=>setUsername(e.target.value)} autoComplete="username"/></div></label>
   <label>Password<div className="input-wrap"><input type={show?'text':'password'} value={password} onChange={e=>setPassword(e.target.value)} autoComplete="current-password"/><button type="button" onClick={()=>setShow(!show)}>{show?<EyeOff size={18}/>:<Eye size={18}/>}</button></div></label>
   <div className="login-actions"><AnimatedButton variant="red" onClick={()=>{setUsername('');setPassword('')}}>Cancel</AnimatedButton><AnimatedButton variant="green" type="submit" loading={loading}>Login Now</AnimatedButton></div>
  </motion.form>
 </main>
}

function Guard({permission,children}){
 const {user}=useAuth();if(!user)return null;return canView(user,permission)?children:<NoAccess/>
}
function NoAccess(){return <div className="empty-state"><X size={44}/><h2>No access</h2><p>You do not have permission to view this page.</p></div>}

function Layout(){
 const {user,logout}=useAuth();const [drawer,setDrawer]=useState(false);const [ai,setAi]=useState(false);const [dark,setDark]=useState(false);const nav=useNavigate();
 useEffect(()=>{document.documentElement.dataset.theme=dark?'dark':'light'},[dark]);
 const links=[['Dashboard','/dashboard',LayoutDashboard,'dashboard'],['Vehicle Registry','/vehicles',Truck,'vehicleRegistry'],['Plant','/plants',Factory,'plant'],['GPS Track','/gps',MapPin,'gpsTrack'],['Users','/users',Users,'users']];
 return <div className="app-shell">
  <AnimatePresence>{drawer&&<motion.div className="drawer-backdrop" onClick={()=>setDrawer(false)} initial={{opacity:0}} animate={{opacity:1}} exit={{opacity:0}}/>}</AnimatePresence>
  <aside className={`sidebar ${drawer?'open':''}`}><div className="brand"><img src="/logo.png"/><strong>SIKKA FLEET</strong><AnimatedButton variant="ghost" className="drawer-close" onClick={()=>setDrawer(false)}><X/></AnimatedButton></div>
   <nav>{links.map(([name,to,Icon,key])=>canView(user,key)&&<NavLink key={name} to={to} name={name} icon={Icon} onClick={()=>setDrawer(false)}/>)}</nav>
  </aside>
  <div className="workspace"><header className="topbar"><AnimatedButton variant="ghost" className="hamburger" onClick={()=>setDrawer(true)}><Menu/></AnimatedButton><div className="top-actions"><AnimatedButton variant="ghost" onClick={()=>setDark(!dark)}>{dark?<Sun size={18}/>:<Moon size={18}/>}</AnimatedButton>{canView(user,'sikkaAi')&&<AnimatedButton variant="orange" onClick={()=>setAi(true)}><Bot size={18}/> Sikka AI</AnimatedButton>}<span className="user-name">{user.fullName}</span><AnimatedButton variant="red" onClick={logout}><LogOut size={18}/> Logout</AnimatedButton></div></header>
   <main className="content"><AnimatePresence mode="wait"><motion.div key={useLocation().pathname} initial={{opacity:0,x:18}} animate={{opacity:1,x:0}} exit={{opacity:0,x:-18}} transition={{duration:.22}}><Routes><Route path="/dashboard" element={<Guard permission="dashboard"><Dashboard/></Guard>}/><Route path="/vehicles" element={<Guard permission="vehicleRegistry"><Vehicles/></Guard>}/><Route path="/plants" element={<Guard permission="plant"><Plants/></Guard>}/><Route path="/gps" element={<Guard permission="gpsTrack"><Gps/></Guard>}/><Route path="/users" element={<Guard permission="users"><UsersPage/></Guard>}/><Route path="*" element={<Navigate to="/dashboard"/>}/></Routes></motion.div></AnimatePresence></main>
  </div>
  {canView(user,'sikkaAi')&&<motion.button whileHover={{scale:1.06}} whileTap={{scale:.94}} className="ai-fab" onClick={()=>setAi(true)}><Bot/> Sikka AI</motion.button>}
  <AIChat open={ai} onClose={()=>setAi(false)}/>
 </div>
}
function NavLink({to,name,icon:Icon,onClick}){const loc=useLocation();const navigate=useNavigate();const active=loc.pathname===to||loc.pathname.startsWith(to+'/');return <button className={`nav-link ${active?'active':''}`} onClick={()=>{navigate(to);onClick?.()}}><Icon size={19}/><span>{name}</span></button>}

function Dashboard(){
 const {user}=useAuth();
 const canManage=canEdit(user,'dashboard');
 const [data,setData]=useState(null);const [syncing,setSyncing]=useState(false);const [countdown,setCountdown]=useState('--:--');const [plantModal,setPlantModal]=useState(null);const [transitModal,setTransitModal]=useState(false);const [planModal,setPlanModal]=useState(null);const [plan,setPlan]=useState({planType:'Loading',remarks:'',expectedDeparture:''});const [planSaving,setPlanSaving]=useState(false);
 const load=async()=>{try{const r=await axios.get('/dashboard');setData(r.data)}catch(e){showToast(e.response?.data?.error||'Failed to load dashboard','error')}};
 useEffect(()=>{load()},[]);
 useEffect(()=>{const refresh=()=>load();window.addEventListener('gps-sync-complete',refresh);return()=>window.removeEventListener('gps-sync-complete',refresh)},[]);
 useEffect(()=>{if(!data?.nextSyncAt)return;const tick=()=>{const sec=Math.max(0,Math.floor((new Date(data.nextSyncAt)-new Date())/1000));setCountdown(`${String(Math.floor(sec/60)).padStart(2,'0')}:${String(sec%60).padStart(2,'0')}`)};tick();const i=setInterval(tick,1000);return()=>clearInterval(i)},[data?.nextSyncAt]);
 const sync=async()=>{
  setSyncing(true);
  try{
   const response=await axios.post('/sync');
   const result=response.data;
   showToast(result.success
    ?`GPS sync complete: ${result.totalVehiclesSynced||0} vehicle(s) synchronized.`
    :`GPS sync incomplete: ${result.totalVehiclesSynced||0} synchronized, ${result.failedVehicleCount||0} failed, ${result.failedProviderCount||0} provider(s) failed.`,result.success?'success':'error');
  }catch(error){showToast(error.response?.data?.reason||error.response?.data?.error||'Sync failed','error')}
  finally{
   window.dispatchEvent(new CustomEvent('gps-sync-complete'));
   setSyncing(false);
  }
 };
 const savePlan=async()=>{if(planSaving)return;setPlanSaving(true);try{await axios.post('/plans',{vehicle:planModal.vehicleNumber,plant:plantModal?.plant?._id,planType:plan.planType,remarks:plan.remarks,expectedDeparture:plan.expectedDeparture||undefined});showToast('Plan saved');setPlanModal(null);setPlan({planType:'Loading',remarks:'',expectedDeparture:''})}catch(e){showToast(e.response?.data?.error||'Failed to save plan','error')}finally{setPlanSaving(false)}};
 if(!data)return <Skeleton/>
 return <>
 <div className="page-head"><div><p className="eyebrow">Fleet operations</p><h1>Dashboard</h1></div><div className="sync-controls">{canManage&&<AnimatedButton variant="green" loading={syncing} onClick={sync}><RefreshCw size={18}/> Sync Now</AnimatedButton>}<div className="clock"><b>Next sync</b><span>{countdown}</span></div><div className="clock"><b>Last Sync</b><span>{fmt(data.lastSync)}</span></div></div></div>
 <div className="widget-grid">{data.plants.map((p,i)=><motion.button key={p.plant} className="plant-widget" onClick={()=>setPlantModal(p)} initial={{opacity:0,y:15}} animate={{opacity:1,y:0}} transition={{delay:i*.07}}><span className="widget-icon"><Factory/></span><div><small>{p.plant}</small><Count value={p.count}/></div></motion.button>)}
 <motion.button className="plant-widget transit" onClick={()=>setTransitModal(true)} initial={{opacity:0,y:15}} animate={{opacity:1,y:0}}><span className="widget-icon"><MapPinned/></span><div><small>Transit</small><Count value={data.transit.count}/><em>active vehicles</em></div></motion.button></div>
 <Modal open={!!plantModal} onClose={()=>setPlantModal(null)} title={`${plantModal?.plant||''} - Vehicles`} size="lg"><PlantPopup plant={plantModal} canPlan={canManage} onPlan={r=>setPlanModal(r)}/></Modal>
 <Modal open={transitModal} onClose={()=>setTransitModal(false)} title="Transit Vehicles" size="lg"><Table headers={['Vehicle Number','Left Plant','Current Location','Speed','IGN','GPS time','GPS data','']} rows={data.transit.rows.map(r=>[r.vehicleNumber,r.leftPlant,<LocationText location={r.location} current={r.addressIsCurrent}/>,speedText(r),r.ignition||'N/A',fmt(r.lastGpsUpdatedAt),r.stale?'Stale':'Live',<AnimatedButton variant="blue" onClick={()=>window.location.assign('/gps')}>Track Now</AnimatedButton>])}/></Modal>
 <Modal open={!!planModal} onClose={()=>setPlanModal(null)} title={`Plan - ${planModal?.vehicleNumber||''}`} disableClose={planSaving}><div className="form-grid"><label>Plan Type<select value={plan.planType} onChange={e=>setPlan({...plan,planType:e.target.value})}>{['Loading','Unloading','Maintenance','Waiting','Other'].map(v=><option key={v}>{v}</option>)}</select></label><label>Expected Departure<input type="datetime-local" value={plan.expectedDeparture} onChange={e=>setPlan({...plan,expectedDeparture:e.target.value})}/></label><label className="span-2">Remarks<textarea value={plan.remarks} onChange={e=>setPlan({...plan,remarks:e.target.value})}/></label></div><div className="modal-actions"><AnimatedButton variant="red" onClick={()=>setPlanModal(null)} disabled={planSaving}>Cancel</AnimatedButton><AnimatedButton variant="green" loading={planSaving} onClick={savePlan}>Save Plan</AnimatedButton></div></Modal>
 </>
}
function Count({value}){const [n,setN]=useState(0);useEffect(()=>{let cur=0;const step=Math.max(1,Math.ceil(value/20));const i=setInterval(()=>{cur=Math.min(value,cur+step);setN(cur);if(cur>=value)clearInterval(i)},25);return()=>clearInterval(i)},[value]);return <b>{n}</b>}
function PlantPopup({plant,onPlan,canPlan}){const [search,setSearch]=useState('');if(!plant)return null;const rows=plant.rows.filter(r=>r.vehicleNumber.includes(search.toUpperCase())).sort((a,b)=>a.vehicleNumber.localeCompare(b.vehicleNumber));return <>{<div className="search-box"><Search/><input placeholder="Search vehicle" value={search} onChange={e=>setSearch(e.target.value.toUpperCase())}/></div>}<Table headers={['Vehicle Number','Entry Time','Stay Hours','Current Location','Speed','IGN','GPS time','GPS data','Latest Plan',...(canPlan?['']:[])]} rows={rows.map(r=>[r.vehicleNumber,fmt(r.entryTime),`${r.stayHours} h ${r.stayMinutes} m`,<LocationText location={r.location} current={r.addressIsCurrent}/>,speedText(r),r.ignition||'N/A',fmt(r.gpsTime),r.hasGps?(r.stale?'Stale':'Live'):'No data',<PlanName vehicle={r.vehicleNumber}/>,...(canPlan?[<AnimatedButton variant="orange" onClick={()=>onPlan(r)}>Plan</AnimatedButton>]:[])])}/></>}
function PlanName({vehicle}){const [x,setX]=useState('');useEffect(()=>{axios.get('/plans/'+vehicle).then(r=>setX(r.data[0]?.planType||'-')).catch(()=>setX('-'))},[vehicle]);return <>{x||'...'}</>}
function Table({headers,rows}){return <div className="table-wrap"><table><thead><tr>{headers.map((h,i)=><th key={i}>{h}</th>)}</tr></thead><tbody>{rows.map((r,i)=><motion.tr key={i} initial={{opacity:0,y:8}} animate={{opacity:1,y:0}} transition={{delay:i*.025}}>{r.map((c,j)=><td key={j}>{c}</td>)}</motion.tr>)}</tbody></table>{!rows.length&&<div className="no-rows">No data found</div>}</div>}
function LocationText({location,current=true}){
 const readableLocation=typeof location==='string'&&!/^\s*-?\d+(?:\.\d+)?\s*,\s*-?\d+(?:\.\d+)?\s*$/.test(location)?location.trim():'';
 return <span title={readableLocation||'No readable address'}>
  {readableLocation?(current?readableLocation:`Last resolved: ${readableLocation}`):'Address unavailable'}
 </span>
}
function Skeleton(){return <div className="skeleton-grid">{[1,2,3,4].map(i=><motion.div key={i} className="skeleton" animate={{opacity:[.45,.8,.45]}} transition={{repeat:Infinity,duration:1.2}}/>)}</div>}

function Vehicles(){
 const {user}=useAuth();
 const canManage=canEdit(user,'vehicleRegistry');
 const [data,setData]=useState({items:[],total:0,page:1,pages:1});const [search,setSearch]=useState('');const [status,setStatus]=useState('');const [fleet,setFleet]=useState('');const [provider,setProvider]=useState('');const [modal,setModal]=useState(false);const [edit,setEdit]=useState(null);const [deleteTarget,setDeleteTarget]=useState(null);const [deleting,setDeleting]=useState(false);const [unreg,setUnreg]=useState([]);const [form,setForm]=useState({vehicleNumber:'',fleetType:'Own Fleet',gpsLink:'Wheelseye',status:'Active'});const [saving,setSaving]=useState(false);
 const load=async()=>{try{const r=await axios.get('/vehicles',{params:{search,status,fleetType:fleet,provider,page:data.page,limit:20}});setData(r.data);const u=await axios.get('/unregistered');setUnreg(u.data)}catch(e){showToast('Failed to load vehicles','error')}};
 useEffect(()=>{load()},[status,fleet,provider,data.page]);useEffect(()=>{const t=setTimeout(()=>load(),300);return()=>clearTimeout(t)},[search]);
 const open=(v=null)=>{setEdit(v);setForm(v?{vehicleNumber:v.vehicleNumber,fleetType:v.fleetType,gpsLink:v.gpsLink,status:v.status}:{vehicleNumber:'',fleetType:'Own Fleet',gpsLink:'Wheelseye',status:'Active'});setModal(true)};
 const save=async()=>{setSaving(true);try{if(edit)await axios.put('/vehicles/'+edit._id,form);else await axios.post('/vehicles',form);showToast(edit?'Vehicle updated':'Vehicle added');setModal(false);load()}catch(e){showToast(e.response?.data?.error||'Save failed','error')}finally{setSaving(false)}};
 const remove=v=>setDeleteTarget(v);
 const confirmRemove=async()=>{if(!deleteTarget||deleting)return;setDeleting(true);try{await axios.delete('/vehicles/'+deleteTarget._id);showToast('Vehicle deleted');setDeleteTarget(null);await load()}catch(e){showToast(e.response?.data?.error||'Delete failed','error')}finally{setDeleting(false)}};
 return <><div className="page-head"><div><p className="eyebrow">Fleet master</p><h1>Vehicle Registry</h1></div>{canManage&&<AnimatedButton variant="green" onClick={()=>open()}><Plus/> Add New Vehicle</AnimatedButton>}</div>
 {canManage&&!!unreg.length&&<div className="unregistered"><b>{unreg.length} unregistered provider vehicle(s)</b>{unreg.slice(0,5).map(v=><button key={v.vehicleNumber} onClick={()=>{setForm({vehicleNumber:v.vehicleNumber,fleetType:'Own Fleet',gpsLink:v.provider,status:'Active'});setModal(true)}}>{v.vehicleNumber} <Plus size={14}/></button>)}</div>}
 <div className="filters"><div className="search-box"><Search/><input placeholder="Search vehicle" value={search} onChange={e=>setSearch(e.target.value.toUpperCase())}/></div><select value={fleet} onChange={e=>setFleet(e.target.value)}><option value="">Fleet Type</option><option>Own Fleet</option><option>Contract Fleet</option></select><select value={provider} onChange={e=>setProvider(e.target.value)}><option value="">GPS Provider</option><option>Wheelseye</option><option>FleetX</option></select><select value={status} onChange={e=>setStatus(e.target.value)}><option value="">Status</option><option>Active</option><option>Inactive</option></select></div>
 <Table headers={['Vehicle Number','Fleet Type','GPS Link','Status','Last GPS time',...(canManage?['']:[])]} rows={data.items.map(v=>[v.vehicleNumber,v.fleetType,[...new Set([v.gpsLink,...(v.gpsProviders||[]).map(link=>link.name)])].filter(Boolean).join(' + '),<span className={`badge ${v.status.toLowerCase()}`}>{v.status}</span>,fmt(v.lastGps),...(canManage?[<div className="row-actions"><AnimatedButton variant="blue" onClick={()=>open(v)}><Edit3 size={16}/></AnimatedButton><AnimatedButton variant="red" onClick={()=>remove(v)}><Trash2 size={16}/></AnimatedButton></div>]:[])])}/>
 <div className="pagination"><AnimatedButton variant="ghost" disabled={data.page<=1} onClick={()=>setData({...data,page:data.page-1})}>Previous</AnimatedButton><span>Page {data.page} of {data.pages||1}</span><AnimatedButton variant="ghost" disabled={data.page>=data.pages} onClick={()=>setData({...data,page:data.page+1})}>Next</AnimatedButton></div>
 <Modal open={modal} onClose={()=>setModal(false)} title={edit?'Edit Vehicle':'Add New Vehicle'} disableClose={saving}><div className="form-grid"><label>Vehicle Number<input value={form.vehicleNumber} onChange={e=>setForm({...form,vehicleNumber:e.target.value.toUpperCase()})}/></label><label>Fleet Type<select value={form.fleetType} onChange={e=>setForm({...form,fleetType:e.target.value})}><option>Own Fleet</option><option>Contract Fleet</option></select></label><label>GPS Link<select value={form.gpsLink} onChange={e=>setForm({...form,gpsLink:e.target.value})}><option>Wheelseye</option><option>FleetX</option></select></label><label>Status<select value={form.status} onChange={e=>setForm({...form,status:e.target.value})}><option>Active</option><option>Inactive</option></select></label></div><div className="modal-actions"><AnimatedButton variant="red" onClick={()=>setModal(false)} disabled={saving}>Cancel</AnimatedButton><AnimatedButton variant="green" loading={saving} onClick={save}>Save</AnimatedButton></div></Modal>
 <Modal open={Boolean(deleteTarget)} onClose={()=>{if(!deleting)setDeleteTarget(null)}} title="Delete Vehicle" disableClose={deleting}><p>Delete vehicle <b>{deleteTarget?.vehicleNumber}</b>? This action cannot be undone.</p><div className="modal-actions"><AnimatedButton variant="red" loading={deleting} onClick={confirmRemove}>Delete Vehicle</AnimatedButton><AnimatedButton variant="ghost" onClick={()=>setDeleteTarget(null)} disabled={deleting}>Cancel</AnimatedButton></div></Modal></>
}

function Plants(){
 const emptyForm=()=>({plantId:'',name:'',address:'',lng:'',lat:'',radius:'500'});
 const {user}=useAuth();
 const canManage=canEdit(user,'plant');
 const [items,setItems]=useState([]);
 const [modal,setModal]=useState(false);
 const [edit,setEdit]=useState(null);
 const [form,setForm]=useState(emptyForm);
 const [errors,setErrors]=useState({});
 const [saving,setSaving]=useState(false);
 const [deleteTarget,setDeleteTarget]=useState(null);
 const [deleteText,setDeleteText]=useState('');
 const [deleting,setDeleting]=useState(false);
 const load=async()=>{
  try{setItems((await axios.get('/plants')).data)}
  catch(error){showToast(error.response?.data?.error||'Failed to load plants','error')}
 };
 useEffect(()=>{load()},[]);
 const closeForm=()=>{if(saving)return;setModal(false);setEdit(null);setErrors({})};
 const open=plant=>{
  setEdit(plant||null);
  setForm(plant?{
   plantId:String(plant.plantId||''),name:plant.name||'',address:plant.address||'',
   lng:String(plant.lng??''),lat:String(plant.lat??''),radius:String(plant.radius??'')
  }:emptyForm());
  setErrors({});
  setModal(true);
 };
 const validate=()=>{
  const next={};
  if(!form.plantId.trim())next.plantId='Plant ID is required';
  else if(items.some(plant=>plant.plantId?.trim().toLowerCase()===form.plantId.trim().toLowerCase()&&plant._id!==edit?._id))next.plantId='Plant ID already exists';
  if(!form.name.trim())next.name='Plant Name is required';
  if(!form.address.trim())next.address='Address is required';
  const longitude=Number(form.lng);
  if(!form.lng.trim()||!Number.isFinite(longitude)||longitude < -180||longitude > 180)next.lng='Longitude must be between -180 and 180';
  const latitude=Number(form.lat);
  if(!form.lat.trim()||!Number.isFinite(latitude)||latitude < -90||latitude > 90)next.lat='Latitude must be between -90 and 90';
  const radius=Number(form.radius);
  if(!form.radius.trim()||!Number.isFinite(radius)||radius<=0)next.radius='Radius must be a positive number';
  setErrors(next);
  return Object.keys(next).length===0;
 };
 const save=async event=>{
  event.preventDefault();
  if(!validate())return;
  setSaving(true);
  const body={plantId:form.plantId.trim(),name:form.name.trim(),address:form.address.trim(),lng:Number(form.lng),lat:Number(form.lat),radius:Number(form.radius)};
  try{
   if(edit)await axios.put('/plants/'+edit._id,body);
   else await axios.post('/plants',body);
   showToast(edit?'Plant updated':'Plant added');
   setModal(false);setEdit(null);setErrors({});
   await load();
  }catch(error){
   const message=error.response?.data?.error||'Plant could not be saved';
   if(error.response?.status===409)setErrors(current=>({...current,plantId:message}));
   showToast(message,'error');
  }finally{setSaving(false)}
 };
 const confirmDelete=async()=>{
  if(deleteText!=='DELETE'||!deleteTarget||deleting)return;
  setDeleting(true);
  try{
   await axios.delete('/plants/'+deleteTarget._id,{data:{confirmation:deleteText}});
   showToast('Plant deleted');
   setDeleteTarget(null);setDeleteText('');
   await load();
  }catch(error){showToast(error.response?.data?.error||'Plant could not be deleted','error')}
  finally{setDeleting(false)}
 };
 const closeDelete=()=>{if(!deleting){setDeleteTarget(null);setDeleteText('')}};
 const field=(key,label,type='text',props={})=><label className="plant-field" key={key}>{label}<input type={type} value={form[key]} onChange={event=>{setForm(current=>({...current,[key]:event.target.value}));setErrors(current=>({...current,[key]:''}))}} aria-invalid={Boolean(errors[key])} {...props}/>{errors[key]&&<small className="field-error">{errors[key]}</small>}</label>;
 return <>
  <div className="page-head"><div><p className="eyebrow">Locations</p><h1>Plant History</h1></div>{canManage&&<AnimatedButton variant="green" onClick={()=>open()}><Plus/> Add Plant</AnimatedButton>}</div>
  <Table headers={['Plant ID','Plant Name','Address','Longitude','Latitude','Radius in Meter','Status',...(canManage?['Actions']:[])]} rows={items.map(plant=>[
   plant.plantId||'-',plant.name,plant.address||'-',plant.lng,plant.lat,plant.radius,plant.status,
   ...(canManage?[<div className="row-actions" key="actions"><AnimatedButton variant="blue" onClick={()=>open(plant)}><Edit3 size={16}/> Edit</AnimatedButton><AnimatedButton variant="red" onClick={()=>{setDeleteTarget(plant);setDeleteText('')}}><Trash2 size={16}/> Delete</AnimatedButton></div>]:[])
  ])}/>
  <Modal open={modal} onClose={closeForm} title={edit?'Edit Plant':'Add Plant'} size="md" disableClose={saving}>
   <form className="plant-form" onSubmit={save} noValidate>
    <div className="plant-form-grid">
     {field('plantId','Plant ID')}
     {field('name','Plant Name')}
     {field('address','Address')}
     {field('lng','Longitude','number',{step:'any'})}
     {field('lat','Latitude','number',{step:'any'})}
     {field('radius','Radius in Meter','number',{min:'0',step:'any'})}
    </div>
    <div className="modal-actions"><AnimatedButton variant="green" type="submit" loading={saving}>Save</AnimatedButton><AnimatedButton variant="red" onClick={closeForm} disabled={saving}>Cancel</AnimatedButton></div>
   </form>
  </Modal>
  <Modal open={Boolean(deleteTarget)} onClose={closeDelete} title="Confirm Plant Deletion" disableClose={deleting}>
   <div className="plant-delete-warning"><b>Warning: this action permanently deletes the Plant record.</b><p>Deletion is blocked if the plant has vehicle stays or plans. Verify the record before continuing.</p></div>
   <dl className="plant-delete-details"><dt>Plant ID</dt><dd>{deleteTarget?.plantId||'-'}</dd><dt>Plant Name</dt><dd>{deleteTarget?.name||'-'}</dd></dl>
   <label className="plant-delete-confirm">Type DELETE to confirm<input value={deleteText} onChange={event=>setDeleteText(event.target.value)} autoComplete="off"/></label>
   <div className="modal-actions"><AnimatedButton variant="red" onClick={confirmDelete} loading={deleting} disabled={deleteText!=='DELETE'}>Delete Plant</AnimatedButton><AnimatedButton variant="ghost" onClick={closeDelete} disabled={deleting}>Cancel</AnimatedButton></div>
  </Modal>
 </>
}

function validGpsPoint(vehicle){
 const lat=Number(vehicle.lat),lng=Number(vehicle.lng);
 return vehicle.lat!=null&&vehicle.lng!=null&&Number.isFinite(lat)&&Number.isFinite(lng)&&lat>=-90&&lat<=90&&lng>=-180&&lng<=180;
}
function vehiclePopup(vehicle,showProvider=true){
 const content=document.createElement('div');
 const addLine=(label,value)=>{
  const line=document.createElement('div');
  line.textContent=`${label}: ${value??'N/A'}`;
  content.appendChild(line);
 };
 const title=document.createElement('strong');
 title.textContent=vehicle.vehicleNumber||'Vehicle';
 content.appendChild(title);
 if(showProvider)addLine('Provider',vehicle.provider||'N/A');
 addLine('Status',vehicle.runningStatus||(vehicle.provider==='FleetX'?'Unknown':(+vehicle.speed>0?'Moving':'Stopped')));
 addLine('Speed',speedText(vehicle));
 addLine('Ignition',vehicle.ignition||'N/A');
 if(vehicle.stale)addLine('GPS data','Stale');
 addLine('Location',vehicle.location||'Location not resolved');
 if(vehicle.location&&!vehicle.addressIsCurrent)addLine('Address status','Last verified address; may be outdated');
 addLine('GPS',`${vehicle.lat}, ${vehicle.lng}`);
 addLine('Last GPS update',fmt(vehicle.gpsTime));
 return content;
}
function OpenStreetMap({vehicles=[],selectedVehicleNumber,onSelect,settings={},showRoute=false}){
 const container=React.useRef(null);
 const mapRef=React.useRef(null);
 const markersRef=React.useRef(new Map());
 const routeRef=React.useRef(null);
 const [tileError,setTileError]=useState(false);
 useEffect(()=>{
  if(!container.current)return;
  const markers=markersRef.current;
  const map=L.map(container.current,{scrollWheelZoom:true}).setView([20.5937,78.9629],5);
  const tiles=L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{
   maxZoom:19,attribution:'&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>'
  }).addTo(map);
  tiles.on('tileerror',()=>setTileError(true));
  mapRef.current=map;
  const resize=setTimeout(()=>map.invalidateSize(),100);
  return ()=>{
   clearTimeout(resize);
   markers.clear();
   map.remove();
  };
 },[]);
 useEffect(()=>{
  const map=mapRef.current;
  if(!map)return;
  const points=vehicles.filter(validGpsPoint);
  const activeKeys=new Set();
  const routePoints=[];
  if(showRoute){
   routeRef.current?.remove();
   routeRef.current=null;
   points.forEach(vehicle=>routePoints.push([Number(vehicle.lat),Number(vehicle.lng)]));
   if(routePoints.length>1){
    routeRef.current=L.polyline(routePoints,{color:'#2563eb',weight:4,opacity:.8}).addTo(map);
   }
  }
  points.forEach((vehicle,index)=>{
   const key=showRoute?`${vehicle.vehicleNumber}:${vehicle.gpsTime||index}`:vehicle.vehicleNumber;
   activeKeys.add(key);
   const position=[Number(vehicle.lat),Number(vehicle.lng)];
   const moving=vehicle.runningStatus==='Moving'||(!vehicle.runningStatus&&Number(vehicle.speed)>0);
   const iconUrl=moving?settings.runningIcon:settings.stoppedIcon;
   const icon=iconUrl?L.icon({iconUrl,iconSize:[38,38],iconAnchor:[19,19],popupAnchor:[0,-18]}):
    L.divIcon({className:'vehicle-marker-icon',html:`<span class="vehicle-marker ${moving?'moving':'stopped'}"></span>`,iconSize:[30,30],iconAnchor:[15,15]});
   const tooltip=document.createElement('span');
   tooltip.textContent=showRoute?`${vehicle.vehicleNumber} · ${fmt(vehicle.gpsTime)} · ${speedText(vehicle)}`:vehicle.vehicleNumber;
   let marker=markersRef.current.get(key);
   if(!marker){
    marker=L.marker(position,{icon,title:vehicle.vehicleNumber||'',alt:vehicle.vehicleNumber||'Vehicle'}).addTo(map);
    markersRef.current.set(key,marker);
    marker.bindPopup(vehiclePopup(vehicle,!showRoute));
    marker.bindTooltip(tooltip,{direction:'top',offset:[0,-18]});
   }else{
    marker.setLatLng(position);
    marker.setIcon(icon);
    marker.setPopupContent(vehiclePopup(vehicle,!showRoute));
    marker.setTooltipContent(tooltip);
   }
   marker.off('click');
   marker.on('click',()=>onSelect?.(vehicle));
  });
  markersRef.current.forEach((marker,key)=>{
   if(!activeKeys.has(key)){
    marker.remove();
    markersRef.current.delete(key);
   }
  });
  if(points.length){
   const bounds=L.latLngBounds(points.map(point=>[Number(point.lat),Number(point.lng)]));
   map.fitBounds(bounds,{padding:[32,32],maxZoom:13});
  }else if(showRoute){
   map.setView([20.5937,78.9629],5);
  }
 },[vehicles,settings,showRoute,onSelect]);
 useEffect(()=>{
  const map=mapRef.current;
  if(!map||!selectedVehicleNumber)return;
  const marker=Array.from(markersRef.current.entries()).find(([key])=>key===selectedVehicleNumber||key.startsWith(`${selectedVehicleNumber}:`))?.[1];
  if(marker){
   map.setView(marker.getLatLng(),Math.max(map.getZoom(),13),{animate:true});
   marker.openPopup();
  }
 },[selectedVehicleNumber]);
 const hasPoints=vehicles.some(validGpsPoint);
 return <div className="leaflet-map-wrap">
  <div ref={container} className="leaflet-map" role="application" aria-label={showRoute?'Historical vehicle route map':'Live vehicle locations map'}/>
  {tileError&&<div className="map-status">Map tiles are temporarily unavailable. GPS synchronization and the location table continue to work.</div>}
  {!hasPoints&&<div className="map-status">No valid GPS coordinates are currently available.</div>}
 </div>;
}

function Gps(){
 const {user}=useAuth();
 const canManage=canEdit(user,'gpsTrack');
 const [tab,setTab]=useState('tracking');const [data,setData]=useState({live:[],registeredVehicles:[],providers:[],syncStatus:{}});const [selected,setSelected]=useState(null);const [search,setSearch]=useState('');const [provider,setProvider]=useState('');const [running,setRunning]=useState('');
 const [settings,setSettings]=useState({});const [runningFile,setRunningFile]=useState(null);const [stoppedFile,setStoppedFile]=useState(null);const [saving,setSaving]=useState(false);const [shareUrl,setShareUrl]=useState('');
 const [syncing,setSyncing]=useState(false);const [syncCountdown,setSyncCountdown]=useState('--:--');
 const load=async()=>{try{const r=await axios.get('/tracking');setData(r.data);setSelected(current=>current?r.data.live.find(v=>v.vehicleNumber===current.vehicleNumber)||null:null);const s=await axios.get('/settings');setSettings(s.data)}catch(e){showToast('Failed to load GPS data','error')}};
 useEffect(()=>{
  load();
  const interval=setInterval(load,60000);
  const syncComplete=()=>load();
  window.addEventListener('gps-sync-complete',syncComplete);
  return()=>{clearInterval(interval);window.removeEventListener('gps-sync-complete',syncComplete)};
 },[]);
 useEffect(()=>{
  const target=data.syncStatus?.nextAutoSyncAt;
  if(!target){setSyncCountdown('--:--');return}
  const tick=()=>{
   const seconds=Math.max(0,Math.floor((new Date(target).getTime()-Date.now())/1000));
   setSyncCountdown(`${String(Math.floor(seconds/60)).padStart(2,'0')}:${String(seconds%60).padStart(2,'0')}`);
  };
  tick();
  const interval=setInterval(tick,1000);
  return()=>clearInterval(interval);
 },[data.syncStatus?.nextAutoSyncAt]);
 const manualSync=async()=>{
  if(syncing)return;
  setSyncing(true);
  try{
   const response=await axios.post('/sync');
   const result=response.data;
   if(result.success){
    showToast(`GPS sync complete: ${result.totalVehiclesSynced||0} vehicle(s) synchronized.`);
   }else{
    const details=Object.values(result.result||{}).flatMap(providerResult=>providerResult.errors||[])
     .slice(0,2).map(error=>error.vehicleNumber?`${error.vehicleNumber}: ${error.message}`:error.message).join('; ');
    showToast(`GPS sync incomplete: ${result.totalVehiclesSynced||0} synchronized, ${result.failedVehicleCount||0} failed, ${result.failedProviderCount||0} provider(s) failed.${details?` ${details}`:''}`,'error');
   }
  }catch(error){
   showToast(error.response?.data?.reason||error.response?.data?.error||'Manual GPS sync failed.','error');
  }finally{
   await load();
   window.dispatchEvent(new CustomEvent('gps-sync-complete'));
   setSyncing(false);
  }
 };
 const share=async(v)=>{try{const r=await axios.post('/share',{vehicleNumber:v.vehicleNumber});setShareUrl(location.origin+r.data.url);showToast('Share link created')}catch(e){showToast(e.response?.data?.error||'Share failed','error')}};
 const copyShareLink=async()=>{try{await navigator.clipboard.writeText(shareUrl);showToast('Share link copied')}catch{showToast('Copy is unavailable; select and copy the link','error')}};
 const saveIcons=async()=>{setSaving(true);const fd=new FormData();if(runningFile)fd.append('running',runningFile);if(stoppedFile)fd.append('stopped',stoppedFile);try{await axios.post('/settings/icons',fd);showToast('Icons saved');load()}catch(e){showToast(e.response?.data?.error||'Icon upload failed','error')}finally{setSaving(false)}};
 const live=data.live.filter(v=>(!search||v.vehicleNumber.includes(search))&&(!provider||v.provider===provider)&&(!running||(running==='running'?(v.ignition==='ON'||(+v.speed>0)):(v.ignition==='OFF'||(+v.speed===0)))));
 const providerWidget=n=>{
  const p=data.providers.find(x=>x.provider===n)||{status:'Disconnected',vehicleCount:0};
  const status=typeof p.status==='string'?p.status:'Disconnected';
  const providerRecords=data.live.filter(v=>v.provider===n);
  const count=providerRecords.filter(v=>!v.stale).length;
  const staleCount=providerRecords.filter(v=>v.stale).length;
  return <div className={`provider-widget ${status.toLowerCase()}`}><b>{n}</b><span className="badge">{status==='Error'?'Failed':status}</span><div><small>Registered</small><strong>{p.vehicleCount||0}</strong></div><div><small>Reporting</small><strong>{count}</strong></div><div><small>Failed vehicles</small><strong>{p.vehiclesNotResponding||0}</strong></div><div><small>Stale data</small><strong>{staleCount}</strong></div><div><small>Last successful sync (IST)</small><strong>{fmtIst(p.lastSuccessTime)}</strong></div>{status==='Error'&&<em>{p.lastErrorMessage||'Provider request failed'} ({p.lastErrorCode||'N/A'})</em>}</div>
 };
 const syncStatus=data.syncStatus||{};
 return <><div className="page-head"><div><p className="eyebrow">Live operations</p><h1>GPS Track</h1></div><div className="sync-controls">{canManage&&<AnimatedButton variant="green" loading={syncing} onClick={manualSync}><RefreshCw size={17}/> Manual Sync</AnimatedButton>}<AnimatedButton variant="ghost" onClick={load}><RefreshCw size={17}/> Refresh</AnimatedButton></div></div><div className="tabs"><AnimatedButton variant={tab==='tracking'?'blue':'ghost'} onClick={()=>setTab('tracking')}>Tracking</AnimatedButton><AnimatedButton variant={tab==='history'?'blue':'ghost'} onClick={()=>setTab('history')}>History</AnimatedButton>{canManage&&<AnimatedButton variant={tab==='setting'?'blue':'ghost'} onClick={()=>setTab('setting')}>Setting</AnimatedButton>}</div>
 {tab==='tracking'?<>
 <div className="gps-sync-status">
  <div><small>Auto Sync</small><b className={syncStatus.autoSyncActive?'sync-active':'sync-inactive'}>{syncStatus.autoSyncActive?'Active':'Inactive'}</b></div>
  <div><small>Next Automatic Sync</small><b>{syncCountdown}</b></div>
  <div><small>Last Successful Sync (IST)</small><b>{fmtIst(syncStatus.lastSuccessfulSyncAt)}</b></div>
  <div><small>Last Manual Sync (IST)</small><b>{fmtIst(syncStatus.lastManualSyncAt)}</b></div>
  <div><small>Total Vehicles Synced</small><b>{syncStatus.totalVehiclesSynced||0}</b></div>
  <div><small>Failed Vehicles / Providers</small><b>{syncStatus.failedVehicleCount||0} / {syncStatus.failedProviderCount||0}</b></div>
  <div><small>GPS Data Last Updated (IST)</small><b>{fmtIst(syncStatus.gpsDataLastUpdated)}</b></div>
 </div>
 <div className="gps-stats">{[['Registered',data.registeredCount||0],['WheelsEye received',data.providers.find(p=>p.provider==='Wheelseye')?.vehiclesReceived||0],['FleetX received',data.providers.find(p=>p.provider==='FleetX')?.vehiclesReceived||0],['Moving',data.summary?.moving||0],['Stopped',data.summary?.stopped||0],['IGN ON',data.summary?.ignitionOn||0],['IGN OFF',data.summary?.ignitionOff||0],['Not Responding',data.summary?.notResponding||0],['API Errors',data.summary?.apiErrors||0]].map(([label,value])=><div className="gps-stat" key={label}><small>{label}</small><b>{value}</b></div>)}</div>
 <div className="provider-grid">{providerWidget('Wheelseye')}{providerWidget('FleetX')}</div>
 {(syncStatus.lastCycleErrors?.length>0||syncStatus.lastCycleGeofenceError)&&<div className="gps-sync-errors"><b>Last synchronization issues</b>{syncStatus.lastCycleGeofenceError&&<p>Plant status update: {syncStatus.lastCycleGeofenceError}</p>}{syncStatus.lastCycleErrors?.length>0&&<ul>{syncStatus.lastCycleErrors.map((error,index)=><li key={`${error.provider}-${error.vehicleNumber||index}-${index}`}>{error.provider}{error.vehicleNumber?` / ${error.vehicleNumber}`:''}: {error.message||'Synchronization failed'}{error.code?` (code ${error.code})`:''}</li>)}</ul>}</div>}
 <div className="gps-layout"><div className="gps-map"><OpenStreetMap vehicles={live} selectedVehicleNumber={selected?.vehicleNumber} onSelect={setSelected} settings={settings}/></div>
 <div className="gps-list"><div className="filters"><div className="search-box"><Search/><input placeholder="Search" value={search} onChange={e=>setSearch(e.target.value.toUpperCase())}/></div><select value={provider} onChange={e=>setProvider(e.target.value)}><option value="">Provider</option><option>Wheelseye</option><option>FleetX</option></select><select value={running} onChange={e=>setRunning(e.target.value)}><option value="">Running Status</option><option value="running">Moving</option><option value="stopped">Stopped</option></select></div><Table headers={['Vehicle','Provider','Fleet Type','Running','IGN','Speed','GPS data','Live Location','Coordinates','Driver','GPS time',...(canManage?['']:[])]} rows={live.map(v=>[<button className="vehicle-select" onClick={()=>setSelected(v)}>{v.vehicleNumber}</button>,v.provider,v.fleetType||'-',v.runningStatus||'Unknown',<span className={`ignition ${/^on|^1|^true$/i.test(String(v.ignition))?'on':'off'}`}>{v.ignition}</span>,speedText(v),v.stale?'Stale':'Live',<LocationText location={v.location} current={v.addressIsCurrent}/>,`${v.lat}, ${v.lng}`,v.driverName||'-',fmt(v.gpsTime),...(canManage?[<AnimatedButton variant="blue" onClick={()=>share(v)}><Share2 size={16}/></AnimatedButton>]:[])])}/></div></div>
 <div className="gps-attribution">Address data may be provided by OpenStreetMap contributors.</div>
 </>:tab==='history'?<HistoryTab vehicles={data.registeredVehicles||[]}/>:canManage&&tab==='setting'?<div className="icon-settings"><IconUploader title="Running Vehicle icon" file={runningFile} setFile={setRunningFile} preview={settings.runningIcon}/><IconUploader title="Stopped Vehicle icon" file={stoppedFile} setFile={setStoppedFile} preview={settings.stoppedIcon}/><div className="modal-actions"><AnimatedButton variant="red" onClick={()=>{setRunningFile(null);setStoppedFile(null)}}>Reset</AnimatedButton><AnimatedButton variant="green" loading={saving} onClick={saveIcons}>Save</AnimatedButton></div></div>:<HistoryTab vehicles={data.registeredVehicles||[]}/>}
 <Modal open={Boolean(shareUrl)} onClose={()=>setShareUrl('')} title="Vehicle Share Link"><label className="plant-field">Share link<input value={shareUrl} readOnly onFocus={event=>event.target.select()}/></label><div className="modal-actions"><AnimatedButton variant="green" onClick={copyShareLink}>Copy Link</AnimatedButton><AnimatedButton variant="red" onClick={()=>setShareUrl('')}>Close</AnimatedButton></div></Modal>
 </>
}
function HistoryTab({vehicles}){
 const initialTo=new Date();
 const initialFrom=new Date(initialTo.getTime()-24*60*60*1000);
 const localInput=d=>{const x=new Date(d.getTime()-d.getTimezoneOffset()*60000);return x.toISOString().slice(0,16)};
 const [provider,setProvider]=useState('Wheelseye');
 const [vehicleNumber,setVehicleNumber]=useState('');
 const [from,setFrom]=useState(localInput(initialFrom));
 const [to,setTo]=useState(localInput(initialTo));
 const [rows,setRows]=useState([]);
 const [loading,setLoading]=useState(false);
 const available=vehicles.filter(v=>v.provider===provider);
 const search=async e=>{
  e.preventDefault();setLoading(true);
  try{
   const response=await axios.get('/history/search',{params:{provider,vehicleNumber,from:new Date(from).toISOString(),to:new Date(to).toISOString()}});
   setRows(response.data);showToast(`${response.data.length} history record(s) loaded`);
  }catch(error){showToast(error.response?.data?.error||'History request failed','error')}
  finally{setLoading(false)}
 };
 const exportCsv=()=>{
  if(!rows.length)return showToast('No history data to export','error');
  const fields=['gpsTime','vehicleNumber','provider','location','lat','lng','speed','ignition','driverName'];
  const escape=value=>`"${String(value??'').replace(/"/g,'""')}"`;
  const content=[fields.join(','),...rows.map(row=>fields.map(k=>escape(k==='location'?row.location:row[k])).join(','))].join('\r\n');
  const url=URL.createObjectURL(new Blob([content],{type:'text/csv;charset=utf-8'}));
  const a=document.createElement('a');a.href=url;a.download=`${vehicleNumber}-gps-history.csv`;a.click();URL.revokeObjectURL(url);
 };
 return <section className="history-panel">
  <form className="history-filters" onSubmit={search}>
   <label>GPS Provider<select value={provider} onChange={e=>{setProvider(e.target.value);setVehicleNumber('')}}><option>Wheelseye</option><option>FleetX</option></select></label>
   <label>Vehicle<select value={vehicleNumber} onChange={e=>setVehicleNumber(e.target.value)} required><option value="">Select vehicle</option>{available.map(v=><option key={v.vehicleNumber} value={v.vehicleNumber}>{v.vehicleNumber}</option>)}</select></label>
   <label>From<input type="datetime-local" value={from} max={to} onChange={e=>setFrom(e.target.value)} required/></label>
   <label>To<input type="datetime-local" value={to} max={localInput(new Date())} onChange={e=>setTo(e.target.value)} required/></label>
   <AnimatedButton variant="blue" type="submit" loading={loading}>Search History</AnimatedButton>
  </form>
  <div className="history-map"><OpenStreetMap vehicles={rows} showRoute/></div>
  <div className="history-actions"><AnimatedButton variant="green" onClick={exportCsv} disabled={!rows.length}>Export Excel (CSV)</AnimatedButton><AnimatedButton variant="ghost" onClick={()=>window.print()} disabled={!rows.length}>Print / Save PDF</AnimatedButton></div>
  <Table headers={['GPS time','Vehicle','Provider','Readable Location','Latitude','Longitude','Speed','IGN','Driver']} rows={rows.map(r=>[fmt(r.gpsTime),r.vehicleNumber,r.provider,<LocationText location={r.location} current={r.addressIsCurrent}/>,r.lat,r.lng,r.speed||'N/A',r.ignition||'N/A',r.driverName||'-'])}/>
 </section>
}
function IconUploader({title,file,setFile,preview}){return <div className="icon-card"><h3>{title}</h3><label className="upload-zone">{file?<img src={URL.createObjectURL(file)} alt="preview"/>:preview?<img src={preview} alt="preview"/>:<Truck/>}<input type="file" accept=".png,.svg,.webp" onChange={e=>setFile(e.target.files[0])}/></label><small>PNG, SVG or WebP - maximum 1 MB</small></div>}

function UsersPage(){
 const {user}=useAuth();
 const canManage=canEdit(user,'users');
 const [items,setItems]=useState([]);
 const [modal,setModal]=useState(false);
 const [edit,setEdit]=useState(null);
 const [deleteTarget,setDeleteTarget]=useState(null);
 const [deleteText,setDeleteText]=useState('');
 const [saving,setSaving]=useState(false);
 const [deleting,setDeleting]=useState(false);
 const [form,setForm]=useState({fullName:'',username:'',password:'',permissions:createDefaultPermissions()});
 const editingSelf=Boolean(edit&&edit.username.toLowerCase()===user.username.toLowerCase());
 const load=async()=>{try{setItems((await axios.get('/users')).data)}catch(error){showToast(error.response?.data?.error||'Failed to load users','error')}};
 useEffect(()=>{load()},[]);
 const open=u=>{
  if(u?.isAdmin)return;
  const permissions=createDefaultPermissions();
  for(const {key,label} of PERMISSION_PAGES){
   const saved=u?.permissions?.[key]??u?.permissions?.[label];
   if(typeof saved==='string'){
    const level=saved.toLowerCase();
    permissions[key]={view:key==='dashboard'||level==='view'||level==='edit',edit:level==='edit'};
   }else if(saved&&typeof saved==='object'){
    const editAccess=saved.edit===true;
    permissions[key]={view:key==='dashboard'||saved.view===true||editAccess,edit:editAccess};
   }
  }
  permissions.dashboard.view=true;
  setEdit(u||null);
  setForm({fullName:u?.fullName||'',username:u?.username||'',password:'',permissions});
  setModal(true);
 };
 const changePermission=(key,capability,checked)=>{
  if(key==='dashboard'&&capability==='view')return;
  setForm(current=>{
   const currentAccess=current.permissions[key];
   const next={...currentAccess,[capability]:checked};
   if(capability==='edit'&&checked)next.view=true;
   if(capability==='view'&&!checked)next.edit=false;
   if(key==='dashboard')next.view=true;
   return {...current,permissions:{...current.permissions,[key]:next}};
  });
 };
 const selectAll=capability=>setForm(current=>({
  ...current,
  permissions:Object.fromEntries(PERMISSION_PAGES.map(({key})=>{
   const access=current.permissions[key];
   if(capability==='edit')return [key,{view:true,edit:true}];
   return [key,{view:true,edit:access.edit}];
  }))
 }));
 const save=async()=>{
  if(saving)return;
  setSaving(true);
  const payload={fullName:form.fullName,username:form.username,password:form.password||undefined};
  if(!editingSelf)payload.permissions=form.permissions;
  try{
   if(edit)await axios.put('/users/'+edit._id,payload);
   else await axios.post('/users',payload);
   showToast(edit?'User updated':'User created');
   setModal(false);
   await load();
  }catch(error){showToast(error.response?.data?.error||'Save failed','error')}
  finally{setSaving(false)}
 };
 const remove=u=>{if(canManage&&!u.isAdmin&&u.username.toLowerCase()!==user.username.toLowerCase()){setDeleteText('');setDeleteTarget(u)}};
 const confirmRemove=async()=>{
  if(!deleteTarget||deleting||deleteText!=='Delete')return;
  setDeleting(true);
  try{await axios.delete('/users/'+deleteTarget._id,{data:{confirmText:deleteText}});showToast('User deleted');setDeleteTarget(null);setDeleteText('');await load()}
  catch(error){showToast(error.response?.data?.error||'Delete failed','error')}
  finally{setDeleting(false)}
 };
 const toggle=async u=>{
  if(!canManage||u.isAdmin||u.username.toLowerCase()===user.username.toLowerCase())return;
  try{await axios.put('/users/'+u._id,{active:!u.active});showToast(u.active?'User deactivated':'User activated');await load()}
  catch(error){showToast(error.response?.data?.error||'Update failed','error')}
 };
 const strength=form.password.length>=12&&/[!@#$%^&*]/.test(form.password)?'Strong':form.password.length>=8?'Medium':form.password?'Weak':'';
 const permissionsReadOnly=editingSelf;
 const closeForm=()=>{if(!saving)setModal(false)};
 return <>
  <div className="page-head"><div><p className="eyebrow">Access control</p><h1>Users</h1></div>{canManage&&<AnimatedButton variant="green" onClick={()=>open()}><Plus/> Add User</AnimatedButton>}</div>
  <Table headers={['Full Name','Username','Status','Last login','Permissions',...(canManage?['']:[])]} rows={items.map(u=>[
   u.fullName,u.username,<span className={`badge ${u.active?'active':'inactive'}`}>{u.active?'Active':'Inactive'}</span>,fmt(u.lastLogin),
   u.isAdmin?'Administrator':summarizePermissions(u.permissions),
   ...(canManage?[u.isAdmin?'-':<div className="row-actions" key="actions">
    <AnimatedButton variant="blue" onClick={()=>open(u)}><Edit3 size={16}/></AnimatedButton>
    {u.username.toLowerCase()!==user.username.toLowerCase()&&<><AnimatedButton variant={u.active?'orange':'green'} onClick={()=>toggle(u)}>{u.active?'Deactivate':'Activate'}</AnimatedButton><AnimatedButton variant="red" onClick={()=>remove(u)}><Trash2 size={16}/></AnimatedButton></>}
   </div>]:[])
  ])}/>
  <Modal open={modal} onClose={closeForm} title={edit?'Edit User':'Add User'} size="lg" disableClose={saving}>
   <div className="form-grid">
    <label>Full Name<input value={form.fullName} onChange={event=>setForm({...form,fullName:event.target.value})}/></label>
    <label>Username<input value={form.username} disabled={!!edit} onChange={event=>setForm({...form,username:event.target.value})}/></label>
    <label className="span-2">Password<input type="password" value={form.password} placeholder={edit?'Leave blank to keep password':'Minimum 8 characters'} onChange={event=>setForm({...form,password:event.target.value})}/>{strength&&<div className={`strength ${strength.toLowerCase()}`}>{strength}</div>}</label>
   </div>
   <div className="permissions-heading"><h3>Page Permissions</h3>{permissionsReadOnly&&<small>Your own permissions cannot be changed.</small>}</div>
   <div className="permission-bulk-actions">
    <AnimatedButton variant="ghost" onClick={()=>selectAll('view')} disabled={saving||permissionsReadOnly}>Select All View</AnimatedButton>
    <AnimatedButton variant="ghost" onClick={()=>selectAll('edit')} disabled={saving||permissionsReadOnly}>Select All Edit</AnimatedButton>
   </div>
   <div className="permission-grid">
    {PERMISSION_PAGES.map(({key,label})=>{
     const access=form.permissions[key];
     const lockedDashboardView=key==='dashboard';
     const disabled=saving||permissionsReadOnly;
     return <fieldset className="permission-card" key={key}>
      <legend>{label}</legend>
      <div className="permission-options">
       <label className="permission-check">
        <input type="checkbox" checked={lockedDashboardView||access.view} disabled={disabled||lockedDashboardView} onChange={event=>changePermission(key,'view',event.target.checked)}/>
        <span className="permission-checkmark" aria-hidden="true">✓</span><span>View</span>
       </label>
       <label className="permission-check">
        <input type="checkbox" checked={access.edit} disabled={disabled} onChange={event=>changePermission(key,'edit',event.target.checked)}/>
        <span className="permission-checkmark" aria-hidden="true">✓</span><span>Edit</span>
       </label>
      </div>
      {lockedDashboardView&&<small className="default-permission">Default access</small>}
      {key==='sikkaAi'&&<small className="readonly-permission">Sikka AI remains read-only.</small>}
     </fieldset>
    })}
   </div>
   <div className="modal-actions"><AnimatedButton variant="red" onClick={closeForm} disabled={saving}>Cancel</AnimatedButton><AnimatedButton variant="green" loading={saving} onClick={save}>Save</AnimatedButton></div>
  </Modal>
  <Modal open={Boolean(deleteTarget)} onClose={()=>{if(!deleting){setDeleteTarget(null);setDeleteText('')}}} title="Delete User?" placement="bottom" disableClose={deleting}>
   <div className="delete-user-warning"><AlertTriangle size={28} aria-hidden="true"/><p>Yeh user (<b>{deleteTarget?.fullName} / {deleteTarget?.username}</b>) hamesha ke liye delete ho jayega. Yeh action wapas nahi ho sakta.</p></div>
   <label className="delete-user-confirm">Confirm karne ke liye neeche Delete type karein<input value={deleteText} onChange={event=>setDeleteText(event.target.value)} autoComplete="off" disabled={deleting}/></label>
   <div className="modal-actions"><AnimatedButton variant="ghost" onClick={()=>{setDeleteTarget(null);setDeleteText('')}} disabled={deleting}>Cancel</AnimatedButton><AnimatedButton variant="red" loading={deleting} onClick={confirmRemove} disabled={deleteText!=='Delete'||deleting}>Delete User</AnimatedButton></div>
  </Modal>
 </>
}

function createAiSessionId(){
 return globalThis.crypto?.randomUUID?.()||`${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function getStoredAiSessionId(username){
 const key=`sikka-ai-session:${username||'user'}`;
 try{
  const existing=localStorage.getItem(key);
  if(existing)return existing;
  const next=createAiSessionId();
  localStorage.setItem(key,next);
  return next;
 }catch{return createAiSessionId()}
}

function storeAiSessionId(username,sessionId){
 try{localStorage.setItem(`sikka-ai-session:${username||'user'}`,sessionId)}catch{}
}

function AIChat({open,onClose}){
 const {user}=useAuth();
 const [messages,setMessages]=useState([]);
 const [text,setText]=useState('');
 const [loading,setLoading]=useState(false);
 const [sessionId,setSessionId]=useState(()=>getStoredAiSessionId(user?.username));
 const [latestLoading,setLatestLoading]=useState(false);
 const [latestError,setLatestError]=useState('');
 const [tab,setTab]=useState('chat');
 const [historySearch,setHistorySearch]=useState('');
 const [historyItems,setHistoryItems]=useState([]);
 const [historyPage,setHistoryPage]=useState(1);
 const [historyPages,setHistoryPages]=useState(1);
 const [historyError,setHistoryError]=useState('');
 const [historyRowsLoading,setHistoryRowsLoading]=useState(false);
 const [adminSearch,setAdminSearch]=useState('');
 const [adminUsername,setAdminUsername]=useState('');
 const [adminFrom,setAdminFrom]=useState('');
 const [adminTo,setAdminTo]=useState('');
 const [adminPage,setAdminPage]=useState(1);
 const [adminData,setAdminData]=useState({items:[],pages:1,total:0,usernames:[]});
 const [adminError,setAdminError]=useState('');
 const messagesRef=useRef(null);
 const isAdmin=Boolean(user?.isAdmin);

 useEffect(()=>{
  if(!open)return;
  let active=true;
  setLatestLoading(true);
  setLatestError('');
  axios.get('/ai/latest').then(response=>{
   if(!active)return;
   const items=Array.isArray(response.data.items)?response.data.items:[];
   const latestSessionId=response.data.sessionId||getStoredAiSessionId(user?.username);
   setSessionId(latestSessionId);
   storeAiSessionId(user?.username,latestSessionId);
   setMessages(items.flatMap(chat=>{
    const answer=normalizeChatAnswer(chat.answer);
    const metadata={
     userFullName:chat.userFullName||chat.fullName||user?.fullName,
     askedAt:chat.askedAt||chat.createdAt,
     answeredAt:chat.answeredAt||chat.createdAt,
     language:chat.language||answer.language||'en'
    };
    return [
     {id:`saved-question-${chat._id}`,from:'user',text:chat.question,...metadata},
     {id:`saved-answer-${chat._id}`,from:'bot',question:chat.question,...metadata,...answer}
    ];
   }));
  }).catch(error=>{
   if(active)setLatestError(error.response?.data?.error||'Latest chat could not be loaded.');
  }).finally(()=>{if(active)setLatestLoading(false)});
  return()=>{active=false};
 },[open,user?.username,user?.fullName]);

 const send=async(question=text)=>{
  const prompt=String(question||'').trim();
  if(!prompt||loading)return;
  const userMessageId=`user-${Date.now()}`;
  setMessages(current=>[...current,{id:userMessageId,from:'user',text:prompt,userFullName:user?.fullName}]);
  setText('');
  setTab('chat');
  setLoading(true);
  try{
   const response=await axios.post('/ai/chat',{message:prompt,sessionId});
   const answer=normalizeChatAnswer(response.data);
   const metadata={
    userFullName:response.data.userFullName||user?.fullName,
    askedAt:response.data.askedAt,answeredAt:response.data.answeredAt,
    language:response.data.language||answer.language||'en'
   };
   setMessages(current=>[
    ...current.map(item=>item.id===userMessageId?{...item,...metadata}:item),
    {id:`answer-${Date.now()}`,from:'bot',question:prompt,...metadata,...answer}
   ]);
   if(response.data.historySaved===false)showToast(response.data.historyError||'Reply received, but chat history could not be saved.','error');
  }catch(error){
   const status=error.response?.status;
   const message=status===401?'Login session expire ho gaya. Dobara login karein.'
    :status===403?'Aapko Sikka AI ka access nahi hai.'
    :error.code==='ERR_NETWORK'||!error.response
     ?'Sikka AI backend se connection nahi ho pa raha. API server aur frontend proxy connection check karein.'
     :error.response?.data?.text||error.response?.data?.error||
      `Sikka AI request failed${status?` (HTTP ${status})`:''}. Please try again.`;
   const responseData=error.response?.data||{};
   const metadata={
    userFullName:responseData.userFullName||user?.fullName,
    askedAt:responseData.askedAt,answeredAt:responseData.answeredAt,
    language:responseData.language||'en'
   };
   setMessages(current=>[
    ...current.map(item=>item.id===userMessageId?{...item,...metadata}:item),
    {id:`answer-${Date.now()}`,from:'bot',question:prompt,...metadata,text:message||'Data nahi mila.'}
   ]);
  }finally{setLoading(false)}
 };

 useEffect(()=>{
  if(open&&tab==='history'){
   let active=true;
   const timer=setTimeout(async()=>{
    setHistoryError('');
    try{
     const response=await axios.get('/ai/history',{params:{search:historySearch,page:1,limit:20}});
     if(active){setHistoryItems(response.data.items||[]);setHistoryPage(1);setHistoryPages(response.data.pages||1)}
    }catch(error){if(active)setHistoryError(error.response?.data?.error||'Chat history load nahi hui.')}
   },220);
   return()=>{active=false;clearTimeout(timer)};
  }
 },[open,tab,historySearch]);

 useEffect(()=>{
  if(open&&tab==='admin'){
   let active=true;
   const timer=setTimeout(async()=>{
    setAdminError('');
    try{
     const response=await axios.get('/ai/admin/chats',{params:{search:adminSearch,username:adminUsername,from:adminFrom,to:adminTo,page:adminPage,limit:20}});
     if(active)setAdminData(response.data);
    }catch(error){if(active)setAdminError(error.response?.data?.error||'Admin chat history load nahi hui.')}
   },220);
   return()=>{active=false;clearTimeout(timer)};
  }
 },[open,tab,adminSearch,adminUsername,adminFrom,adminTo,adminPage]);

 useEffect(()=>{
  const container=messagesRef.current;
  if(container)container.scrollTop=container.scrollHeight;
 },[messages,loading,tab,latestLoading]);

 const loadMoreHistory=async()=>{
  const next=historyPage+1;
  try{
   const response=await axios.get('/ai/history',{params:{search:historySearch,page:next,limit:20}});
   setHistoryItems(items=>[...items,...(response.data.items||[])]);
   setHistoryPage(next);
   setHistoryPages(response.data.pages||1);
  }catch(error){setHistoryError(error.response?.data?.error||'More chat history load nahi hui.')}
 };

 const loadMoreHistoryRows=async message=>{
  const range=message.historyRange;
  if(!range||historyRowsLoading)return;
  setHistoryRowsLoading(true);
  try{
   const response=await axios.get('/ai/history/records',{params:{
    vehicleNumber:message.vehicleNumber,from:range.from,to:range.to,offset:message.rows?.length||0,limit:20
   }});
   setMessages(current=>current.map(item=>item.id===message.id?{...item,rows:[...(item.rows||[]),...(response.data.rows||[])]}:item));
  }catch(error){showToast(error.response?.data?.error||'Vehicle history load nahi hui.','error')}
  finally{setHistoryRowsLoading(false)}
 };

 const showSavedChat=chat=>{
  const answer=normalizeChatAnswer(chat.answer);
  if(chat.sessionId){
   setSessionId(chat.sessionId);
   storeAiSessionId(user?.username,chat.sessionId);
  }
  const metadata={
   userFullName:chat.userFullName||chat.fullName,
   askedAt:chat.askedAt||chat.createdAt,
   answeredAt:chat.answeredAt||chat.createdAt,
   language:chat.language||answer.language||'en'
  };
  setMessages([
   {id:`saved-question-${chat._id}`,from:'user',text:chat.question,...metadata},
   {id:`saved-answer-${chat._id}`,from:'bot',question:chat.question,...metadata,...answer}
  ]);
  setTab('chat');
 };

 return <Modal open={open} onClose={onClose} title="Sikka AI" placement="right">
  <div className="chat">
   <div className="ai-chat-tabs">
    <button type="button" className={tab==='chat'?'active':''} onClick={()=>setTab('chat')}>Chat</button>
    <button type="button" className={tab==='history'?'active':''} onClick={()=>setTab('history')}>History</button>
    {isAdmin&&<button type="button" className={tab==='admin'?'active':''} onClick={()=>setTab('admin')}>All Users Chats</button>}
   </div>
   <div className="ai-chat-retention-note">Chats 7 din baad apne aap delete ho jaati hain aur admin dekh sakta hai.</div>
   {tab==='chat'?<>
    <div className="chat-messages" ref={messagesRef} aria-live="polite">
     {latestLoading&&<div className="typing" role="status"><span className="typing-dots"/>Latest conversation loading...</div>}
     {latestError&&<p className="chat-error">{latestError}</p>}
     {!latestLoading&&!messages.length&&<p className="chat-empty">Ask Sikka AI about fleet vehicles, plants, or recent history.</p>}
     {messages.map(message=><ChatMessage key={message.id} message={message} onAskAgain={send} onLoadMoreHistory={loadMoreHistoryRows} loadingMoreHistory={historyRowsLoading}/>)}
     {loading&&<div className="typing" role="status"><span className="typing-dots"/>Sikka AI typing...</div>}
    </div>
    <form className="chat-input" onSubmit={event=>{event.preventDefault();send()}}>
     <input value={text} maxLength={500} onChange={event=>setText(event.target.value)} placeholder="Ask Sikka AI (max 500 characters)" aria-label="Ask Sikka AI"/>
     <AnimatedButton variant="blue" type="submit" loading={loading} disabled={loading||!text.trim()} aria-label="Send"><ChevronRight/></AnimatedButton>
    </form>
   </>:tab==='history'?<div className="chat-history-view">
    <div className="chat-history-search"><Search size={16}/><input value={historySearch} onChange={event=>setHistorySearch(event.target.value)} placeholder="Apni chats search karein"/></div>
    {historyError&&<p className="chat-error">{historyError}</p>}
    {!historyError&&!historyItems.length&&<p className="chat-empty">Pichhle 7 din ki koi chat nahi mili.</p>}
    {groupChatsByDay(historyItems).map(group=><section className="chat-history-group" key={group.label}>
     <h3>{group.label}</h3>
     {group.items.map(chat=><article className="chat-history-item" key={chat._id}>
      <button type="button" className="chat-history-open" onClick={()=>showSavedChat(chat)}>
       <b>{chat.userFullName||chat.fullName} · {chat.question}</b><span>{chatAnswerPreview(chat.answer)}</span>
       <small>Asked: {formatChatFooter(chat.askedAt||chat.createdAt)} · Answered: {formatChatFooter(chat.answeredAt||chat.createdAt)}</small>
      </button>
      <button type="button" className="chat-reask" onClick={()=>send(chat.question)}>Is sawal ko dobara poocho</button>
     </article>)}
    </section>)}
    {historyPage<historyPages&&<AnimatedButton variant="ghost" onClick={loadMoreHistory}>Aur history dikhayein</AnimatedButton>}
   </div>:<div className="chat-admin-view">
    <div className="chat-admin-filters">
     <select value={adminUsername} onChange={event=>{setAdminUsername(event.target.value);setAdminPage(1)}} aria-label="Filter by user"><option value="">All users</option>{adminData.usernames.map(username=><option key={username}>{username}</option>)}</select>
     <label>From<input type="date" value={adminFrom} onChange={event=>{setAdminFrom(event.target.value);setAdminPage(1)}}/></label>
     <label>To<input type="date" value={adminTo} onChange={event=>{setAdminTo(event.target.value);setAdminPage(1)}}/></label>
     <div className="chat-history-search"><Search size={16}/><input value={adminSearch} onChange={event=>{setAdminSearch(event.target.value);setAdminPage(1)}} placeholder="Search user, sawal, jawab"/></div>
    </div>
    {adminError&&<p className="chat-error">{adminError}</p>}
    {!adminError&&!adminData.items.length&&<p className="chat-empty">Pichhle 7 din ki koi chat nahi mili.</p>}
    {adminData.items.map(chat=><article className="admin-chat-item" key={chat._id}>
     <div className="admin-chat-user"><b>{chat.userFullName||chat.fullName}</b><span>@{chat.username} · Asked: {formatChatFooter(chat.askedAt||chat.createdAt)} · Answered: {formatChatFooter(chat.answeredAt||chat.createdAt)}</span></div>
     <details><summary>{chat.question}</summary><ChatMessage message={{...normalizeChatAnswer(chat.answer),from:'bot',id:`admin-${chat._id}`,userFullName:chat.userFullName||chat.fullName,askedAt:chat.askedAt||chat.createdAt,answeredAt:chat.answeredAt||chat.createdAt}}/></details>
    </article>)}
    {adminData.pages>1&&<div className="chat-pagination">
     <button type="button" disabled={adminPage<=1} onClick={()=>setAdminPage(page=>page-1)}>Previous</button>
     <span>Page {adminData.page||adminPage} of {adminData.pages} · {adminData.total} chats</span>
     <button type="button" disabled={adminPage>=adminData.pages} onClick={()=>setAdminPage(page=>page+1)}>Next</button>
    </div>}
   </div>}
  </div>
 </Modal>
}

function normalizeChatAnswer(value){
 const answer=typeof value==='string'?{text:value}:value&&typeof value==='object'?value:{};
 return {...answer,text:String(answer.text||answer.reply||answer.error||'Saved answer text is unavailable.')};
}

function chatAnswerPreview(value){
 const answer=normalizeChatAnswer(value);
 return answer.text;
}

function formatChatDate(value){
 return value?new Date(value).toLocaleString('en-IN',{timeZone:'Asia/Kolkata',day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit',hour12:true}):'';
}

function formatChatFooter(value){
 if(!value)return '';
 const parts=new Intl.DateTimeFormat('en-IN',{
  timeZone:'Asia/Kolkata',day:'2-digit',month:'2-digit',year:'numeric',
  hour:'2-digit',minute:'2-digit',hour12:true
 }).formatToParts(new Date(value));
 const values=Object.fromEntries(parts.filter(part=>part.type!=='literal').map(part=>[part.type,part.value]));
 return `${values.day}-${values.month}-${values.year} ${values.hour}:${values.minute} ${String(values.dayPeriod||'').toUpperCase()}`.trim();
}

function chatDayKey(value){
 const parts=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Kolkata',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(value));
 const values=Object.fromEntries(parts.filter(part=>part.type!=='literal').map(part=>[part.type,part.value]));
 return `${values.year}-${values.month}-${values.day}`;
}

function groupChatsByDay(items){
 const today=chatDayKey(new Date());
 const yesterday=chatDayKey(new Date(Date.now()-24*60*60*1000));
 const groups=new Map();
 for(const item of items){
  const askedAt=item.askedAt||item.createdAt;
  const key=chatDayKey(askedAt);
  const label=key===today?'Aaj':key===yesterday?'Kal':new Date(askedAt).toLocaleDateString('en-IN',{timeZone:'Asia/Kolkata',day:'2-digit',month:'long',year:'numeric'});
  if(!groups.has(label))groups.set(label,[]);
  groups.get(label).push(item);
 }
 return [...groups].map(([label,groupItems])=>({label,items:groupItems}));
}

function chatText(language,english,hindi){
 return language==='hi'?hindi:english;
}

function ChatMessage({message,onAskAgain,onLoadMoreHistory,loadingMoreHistory=false}){
 const [visibleRows,setVisibleRows]=useState(20);
 const answer=message.from==='bot'?normalizeChatAnswer(message):null;
 const language=answer?.language||message.language||'en';
 const labels=language==='hi'
  ?{vehicle:'गाड़ी',location:'लोकेशन',coordinates:'निर्देशांक',speed:'स्पीड',ignition:'IGN',gpsTime:'GPS समय',provider:'प्रदाता',plant:'प्लांट',entry:'प्रवेश',stay:'ठहराव',map:'मैप खोलें',more:'और दिखाएं',outside:'बाहर/ट्रांजिट',records:'रिकॉर्ड'}
  :{vehicle:'Vehicle',location:'Location',coordinates:'Coordinates',speed:'Speed',ignition:'IGN',gpsTime:'GPS time',provider:'Provider',plant:'Plant',entry:'Entry',stay:'Stay',map:'Open map',more:'Show more',outside:'Outside/Transit',records:'records'};
 const rows=answer?.rows||[];
 const showRows=rows.slice(0,visibleRows);
 const timestamp=message.from==='user'
  ?message.askedAt||message.createdAt
  :message.answeredAt||message.createdAt;
 return <motion.div className={`chat-message ${message.from}`} initial={{opacity:0,y:8}} animate={{opacity:1,y:0}}>
  <strong className="chat-message-header">{message.from==='user'?message.userFullName||'User':'Sikka AI'}</strong>
  {message.from==='user'?<p>{message.text}</p>:<>
   <p>{answer.text}</p>
   {answer.type==='plantVehicles'&&rows.length>0&&<div className="chat-answer-card">
    <b>{answer.plantName} · {answer.total??rows.length} {chatText(language,'vehicles','गाड़ियाँ')}</b>
    <div className="chat-answer-table">
     {rows.map((row,index)=><div className="chat-answer-row" key={`${row.vehicleNumber}-${index}`}>
      <strong>{row.vehicleNumber}</strong><span>{labels.entry}: {formatChatDate(row.entryTime)}</span><span>{labels.stay}: {row.stay||`${row.stayHours||0} h`}</span>
     </div>)}
    </div>
   </div>}
   {answer.type==='plants'&&<div className="chat-answer-groups">
    {(answer.plants||[]).map(plant=><section className="chat-answer-card" key={plant.plantName}>
     <b>{plant.plantName} · {plant.count}</b>
     {plant.rows?.length>0&&<div className="chat-answer-table">{plant.rows.map((row,index)=><div className="chat-answer-row" key={`${row.vehicleNumber}-${index}`}><strong>{row.vehicleNumber}</strong><span>{labels.entry}: {formatChatDate(row.entryTime)}</span><span>{labels.stay}: {row.stay}</span></div>)}</div>}
    </section>)}
    <section className="chat-answer-card"><b>{labels.outside} · {answer.transit?.count||0}</b>{answer.transit?.vehicles?.length>0&&<span>{answer.transit.vehicles.join(', ')}</span>}</section>
   </div>}
   {answer.type==='outside'&&<div className="chat-answer-card"><b>{labels.outside} · {answer.count||0}</b>{answer.vehicles?.length>0&&<span>{answer.vehicles.join(', ')}</span>}</div>}
   {answer.type==='outsideHistory'&&rows.length>0&&<div className="chat-answer-table chat-history-results">
    {rows.map((row,index)=><div className="chat-history-result" key={`${row.vehicleNumber}-${index}`}><strong>{row.vehicleNumber} · {row.plantName}</strong><span>{formatChatDate(row.exitTime)}</span></div>)}
   </div>}
   {answer.type==='plantDetails'&&<div className="chat-answer-card"><b>{answer.plantName}</b><span>{answer.address||chatText(language,'Address not recorded','पता दर्ज नहीं')}</span><span>{chatText(language,'Radius','रेडियस')}: {answer.radius} m</span></div>}
   {answer.type==='plans'&&rows.length>0&&<div className="chat-answer-table chat-history-results">
    {rows.map((row,index)=><div className="chat-history-result" key={`${row.vehicleNumber}-${index}`}><strong>{row.vehicleNumber} · {row.planType} · {row.plantName}</strong><span>{row.remarks}</span><span>{row.expectedDeparture?formatChatDate(row.expectedDeparture):''}</span></div>)}
   </div>}
   {answer.type==='providers'&&rows.length>0&&<div className="chat-answer-table chat-history-results">
    {rows.map(row=><div className="chat-history-result" key={row.provider}><strong>{row.provider} · {row.status}</strong><span>{chatText(language,'Last success','आखिरी सफलता')}: {formatChatDate(row.lastSuccessTime)}</span><span>{chatText(language,'Vehicles','गाड़ियाँ')}: {row.vehicleCount??0} · {chatText(language,'Not responding','जवाब नहीं दे रहीं')}: {row.vehiclesNotResponding??0}</span></div>)}
   </div>}
   {(answer.type==='vehicle'||answer.type==='vehicleMissing')&&answer.location&&<div className="chat-answer-card chat-vehicle-card">
    <span><b>{labels.vehicle}:</b> {answer.vehicleNumber}</span><span><b>{labels.location}:</b> {answer.location}</span><span><b>{labels.coordinates}:</b> {answer.lat??'N/A'}, {answer.lng??'N/A'}</span><span><b>{labels.speed}:</b> {answer.speed}</span><span><b>{labels.ignition}:</b> {answer.ignition}</span><span><b>{labels.gpsTime}:</b> {formatChatDate(answer.gpsTime)}</span><span><b>{labels.provider}:</b> {answer.provider}</span><span><b>{labels.plant}:</b> {answer.plantName}</span>
    {answer.entryTime&&<span><b>{labels.entry}:</b> {formatChatDate(answer.entryTime)} · {labels.stay}: {answer.stay}</span>}
    {answer.stale&&<em>{chatText(language,'GPS data is stale.','GPS डेटा पुराना है।')}</em>}
    {answer.map&&<a className="chat-map-link" href={answer.map} target="_blank" rel="noreferrer">{labels.map}</a>}
   </div>}
   {answer.type==='history'&&rows.length>0&&<div className="chat-answer-table chat-history-results">
    {showRows.map((row,index)=><div className="chat-history-result" key={`${row.time}-${index}`}>
     <strong>{formatChatDate(row.time)}</strong><span>{row.address}</span><span>{labels.speed}: {row.speed} · {labels.ignition}: {row.ignition}</span>
     {row.map&&<a className="chat-map-link" href={row.map} target="_blank" rel="noreferrer">{labels.map}</a>}
    </div>)}
    {visibleRows<rows.length&&<button type="button" className="chat-more" onClick={()=>setVisibleRows(count=>count+20)}>{labels.more}</button>}
    {visibleRows>=rows.length&&answer.total>rows.length&&onLoadMoreHistory&&<button type="button" className="chat-more" disabled={loadingMoreHistory} onClick={()=>onLoadMoreHistory(message)}>{loadingMoreHistory?'Loading...':labels.more}</button>}
    {answer.total>rows.length&&<small>{chatText(language,'Showing','दिखाए जा रहे हैं')} {rows.length} {chatText(language,'of','में से')} {answer.total} {labels.records}.</small>}
    {onAskAgain&&<button type="button" className="chat-reask" onClick={()=>onAskAgain(message.question||`${answer.vehicleNumber} history`)}>{chatText(language,'Ask this again','यह सवाल फिर पूछें')}</button>}
   </div>}
   {answer.suggestions?.length>0&&onAskAgain&&<div className="chat-suggestion-chips" aria-label="Suggested questions">
    {answer.suggestions.map(suggestion=><button type="button" key={suggestion.question} onClick={()=>onAskAgain(suggestion.question)}>{suggestion.label}</button>)}
   </div>}
  </>}
  {timestamp&&<small className="chat-message-footer">{formatChatFooter(timestamp)}</small>}
 </motion.div>;
}

function AppRoutes(){
 const {user}=useAuth();
 if(!user)return <Login/>;
 return <BrowserRouter><Layout/></BrowserRouter>;
}

function AuthProvider({children}){
 const [user,setUser]=useState(undefined);
 const [deferred,setDeferred]=useState(null);
 const [offlineInstall,setOfflineInstall]=useState(false);
 useEffect(()=>{
   const restore=async()=>{
    try{const r=await axios.get('/auth/me');setUser(r.data.user)}
    catch{
     try{await axios.post('/auth/refresh');const r=await axios.get('/auth/me');setUser(r.data.user)}
     catch{setUser(null)}
    }
   };
   restore();
  const prompt=e=>{e.preventDefault();setDeferred(e);setOfflineInstall(true)};
  window.addEventListener('beforeinstallprompt',prompt);
   return()=>{window.removeEventListener('beforeinstallprompt',prompt)};
 },[]);
 const login=async(username,password)=>{const r=await axios.post('/auth/login',{username,password});setUser(r.data.user)};
 const logout=async()=>{try{await axios.post('/auth/logout')}finally{setUser(null)}};
 if(user===undefined)return <Skeleton/>;
 return <Auth.Provider value={{user,login,logout}}>{children}
  {offlineInstall&&<div className="install-banner"><b>Install Sikka Fleet</b><AnimatedButton variant="blue" onClick={async()=>{if(deferred){await deferred.prompt();setDeferred(null);setOfflineInstall(false)}else showToast('Use Share > Add to Home Screen on iPhone')}}>Install App</AnimatedButton></div>}
 </Auth.Provider>;
}

export default function App(){
 return <><AuthProvider><AppRoutes/></AuthProvider><Toasts/></>
}
