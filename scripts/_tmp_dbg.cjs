const Module=require('module'),path=require('path');
const store={};
function seed(id,d){store[id]=JSON.parse(JSON.stringify(d));}
function matches(doc,cond){
  for(const[k,v]of Object.entries(cond)){
    if(v&&typeof v==='object'){
      for(const op of ['__lt','__lte','__gt','__gte']) if(op in v){const val=v[op];if(doc[k]<val===false&&op==='__lt')return false;}
    } else { if(doc[k]!==v)return false; }
  }
  return true;
}
const mockDb={command:{lt:(v)=>({__lt:v}),gt:(v)=>({__gt:v}),and:(a)=>({_and:a}),in:(a)=>({__in:a})},collection(){return{
  where(cond){const picked=Object.values(store).filter(d=>matches(d,cond));console.log('WHERE',JSON.stringify(cond),'->picked',picked.map(p=>p._id));return{limit(){return{get:async()=>({data:JSON.parse(JSON.stringify(picked))})};}};},
};}};
const orig=Module._resolveFilename;
Module._resolveFilename=function(req,...a){if(req==='wx-server-sdk'){const p=path.join(process.cwd(),'scripts','_s.cjs');require.cache[p]={id:p,filename:p,loaded:true,exports:{},children:[],paths:[]};require.cache[p].exports={init(){},database(){return mockDb;},getWXContext(){return{}},DYNAMIC_CURRENT_ENV:'env'};return p;}return orig.call(this,req,...a);};
const expire=require(path.join(process.cwd(),'cloudfunctions','expireRecords','index.js'));
(async()=>{
  const old=new Date(Date.now()-40*60e3).toISOString();
  seed('p1',{_id:'p1',record_type:'reservation',status:'paused',updated_at:old,payload:{},start_at:old});
  seed('pd1',{_id:'pd1',record_type:'reservation',status:'pending_checkin',start_at:old});
  seed('ac1',{_id:'ac1',record_type:'reservation',status:'active',end_at:old});
  const res=await expire.main({});
  console.log('RES',JSON.stringify(res));
  console.log('stores',JSON.stringify(store,null,0));
})();
