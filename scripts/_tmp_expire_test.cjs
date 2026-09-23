const Module = require('module');
const path = require('path');

const store = {};
function seed(id, doc){ store[id]=JSON.parse(JSON.stringify(doc)); }

function matches(doc, cond){
  for (const [k,v] of Object.entries(cond)) {
    if (v && typeof v==='object') {
      for (const op of ['__lt','__lte','__gt','__gte']) {
        if (op in v) { const val=v[op]; if (op==='__lt') { if(!(doc[k] < val)) return false; } else if (op==='__lte') { if(!(doc[k] <= val)) return false; } else if (op==='__gt') { if(!(doc[k] > val)) return false; } else if(op==='__gte'){ if(!(doc[k] >= val)) return false; } }
      }
    } else if (Array.isArray(v)) {
      // _.in 之类，此处简化
    } else {
      if (doc[k] !== v) return false;
    }
  }
  return true;
}

const mockDb = {
  command: { lt:(v)=>({__lt:v}), gt:(v)=>({__gt:v}), lte:(v)=>({__lte:v}), gte:(v)=>({__gte:v}), in:(a)=>({__in:a}) },
  collection(){
    return {
      doc(id){
        return {
          async update({data}){
            const r=store[id]; if(!r) throw new Error('not found '+id);
            for (const [k,v] of Object.entries(data)) {
              if (k.indexOf('payload.')===0){ r.payload=r.payload||{}; r.payload[k.slice(8)]=v; }
              else r[k]=v;
            }
            return {};
          },
        };
      },
      where(cond){
        const picked = Object.values(store).filter(d=>matches(d,cond));
        return { limit(){ return { get: async ()=>({ data: JSON.parse(JSON.stringify(picked)) }) }; } };
      },
    };
  },
};

const origResolve = Module._resolveFilename;
Module._resolveFilename = function(request,...args){
  if(request==='wx-server-sdk'){
    const p = path.join(process.cwd(),'scripts','_sandbox_wx.cjs');
    require.cache[p]={id:p,filename:p,loaded:true,exports:{},children:[],paths:[]};
    require.cache[p].exports={ init(){}, database(){return mockDb;}, getWXContext(){return{};}, DYNAMIC_CURRENT_ENV:'env' };
    return p;
  }
  return origResolve.call(this,request,...args);
};
const expire = require(path.join(process.cwd(),'cloudfunctions','expireRecords','index.js'));

let pass=0, fail=0;
function expect(n,c,d=''){ c?(pass++,console.log('  PASS',n)):(fail++,console.log('  FAIL',n,d)); }

(async ()=>{
  const old = new Date(Date.now()-40*60*1000).toISOString();
  seed('p1',{_id:'p1',record_type:'reservation',status:'paused',updated_at:old,payload:{},start_at:old,end_at:new Date(Date.now()+3600e3).toISOString()});
  seed('p2',{_id:'p2',record_type:'reservation',status:'paused',updated_at:new Date().toISOString(),payload:{}});
  seed('pd1',{_id:'pd1',record_type:'reservation',status:'pending_checkin',start_at:old});
  seed('ac1',{_id:'ac1',record_type:'reservation',status:'active',end_at:old});

  const res = await expire.main({});
  expect('长期暂离(>30min) -> active+auto_return', store.p1.status==='active' && store.p1.payload.auto_return_from==='leave_timeout', JSON.stringify(store.p1));
  expect('短暂离保持 paused', store.p2.status==='paused');
  expect('pending超时 -> no_show', store.pd1.status==='no_show');
  expect('active到时 -> completed', store.ac1.status==='completed');
  expect('auto_returned=1', res.data && res.data.auto_returned===1, JSON.stringify(res.data));
  expect('no_show=1', res.data && res.data.no_show===1, JSON.stringify(res.data));
  expect('completed=1', res.data && res.data.completed===1, JSON.stringify(res.data));

  console.log('\n==== expireRecords: pass='+pass+' fail='+fail+' ====');
  process.exit(fail?1:0);
})().catch(e=>{console.error('crash',e);process.exit(2)});
