const Module = require('module');
const path = require('path');
const crypto = require('crypto');

const records = {};
let WX_OPENID = 'mock-openid-abc';
const hash = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0,32);
const USER = hash('mock-openid-abc');

const mockDb = {
  command: { in: (a)=>({__in:a}), lt:(v)=>({__lt:v}), gt:(v)=>({__gt:v}), and:(a)=>({a}), gte:(v)=>({__gte:v}), lte:(v)=>({__lte:v}) },
  collection(){ return {
    doc(id){
      return {
        async get(){ const r=records[id]; if(!r) throw new Error('not found'); return {data: JSON.parse(JSON.stringify(r))}; },
        async update({data}){
          const r=records[id]; if(!r) throw new Error('not found');
          for (const [k,v] of Object.entries(data)) {
            if (k.indexOf('payload.')===0){ r.payload=r.payload||{}; r.payload[k.slice(8)]=v; }
            else r[k]=v;
          }
          return {};
        },
      };
    },
    where(){ return { limit(){ return { get: async ()=>({data:[]}) }; } }; },
  }; },
};

const origResolve = Module._resolveFilename;
Module._resolveFilename = function(request, ...args){
  if (request === 'wx-server-sdk') {
    const p = path.join(process.cwd(), 'scripts', '_sandbox_wx_server_sdk.cjs');
    require.cache[p] = { id:p, filename:p, loaded:true, exports:{}, children:[], paths:[] };
    require.cache[p].exports = {
      init(){}, database(){ return mockDb; },
      getWXContext(){ return { OPENID: WX_OPENID }; },
      DYNAMIC_CURRENT_ENV: 'env',
    };
    return p;
  }
  return origResolve.call(this, request, ...args);
};

const leaveSeat = require(path.join(process.cwd(), 'cloudfunctions', 'leaveSeat', 'index.js'));

const activeId = 'rev-001';
records[activeId] = {
  _id: activeId, user_id: USER, record_type: 'reservation', status: 'active',
  room_id: 'r1', seat_id: 's1',
  start_at: new Date(Date.now()-3600e3).toISOString(), end_at: new Date(Date.now()+3600e3).toISOString(),
  payload: { checked_in_at: new Date().toISOString() },
  created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
};

let pass=0, fail=0;
function expect(name, cond, detail=''){ if(cond){pass++; console.log('  PASS', name);} else {fail++; console.log('  FAIL', name, detail);} }

(async () => {
  let res = await leaveSeat.main({ action:'leave', record_id: activeId });
  expect('leave: active->paused', res.success && records[activeId].status==='paused', JSON.stringify(res));
  expect('leave: leave_count=1', records[activeId].payload.leave_count===1, JSON.stringify(records[activeId].payload));

  res = await leaveSeat.main({ action:'return', record_id: activeId });
  expect('return: paused->active', res.success && records[activeId].status==='active', JSON.stringify(res));

  res = await leaveSeat.main({ action:'leave', record_id: activeId });
  expect('2nd leave count=2', res.success && records[activeId].status==='paused' && records[activeId].payload.leave_count===2, JSON.stringify(records[activeId].payload));

  WX_OPENID = 'attacker-xyz';
  res = await leaveSeat.main({ action:'return', record_id: activeId });
  expect('foreign user denied', res.success===false && records[activeId].status!=='active', JSON.stringify(res));
  WX_OPENID = 'mock-openid-abc';

  res = await leaveSeat.main({ action:'fly', record_id: activeId });
  expect('unknown action fails', res.success===false);

  console.log('\n==== leaveSeat: pass='+pass+' fail='+fail+' ====');
  process.exit(fail?1:0);
})().catch(e=>{ console.error('test crash', e); process.exit(2); });
