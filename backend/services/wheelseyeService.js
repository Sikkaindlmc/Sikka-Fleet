const axios=require('axios');

async function fetchLive({baseUrl}={}){
 const environmentUrl=process.env.WHEELSEYE_API_URL||'https://api.wheelseye.com/currentLoc';
 const configuredUrl=baseUrl||environmentUrl;
 const url=new URL(configuredUrl);
 const accessToken=process.env.WHEELSEYE_API_TOKEN||
  new URL(environmentUrl).searchParams.get('accessToken')||url.searchParams.get('accessToken');
 url.searchParams.delete('accessToken');
 if(accessToken)url.searchParams.set('accessToken',accessToken);
 const response=await axios.get(url.toString(),{
  timeout:25000,
  headers:{Accept:'application/json'}
 });
 if(response.data?.success===false||response.data?.data?.success===false){
  throw new Error('WheelsEye returned an unsuccessful response');
 }
 return response;
}

module.exports={fetchLive};
