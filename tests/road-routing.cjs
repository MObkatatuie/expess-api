const { test } = require('node:test');
const assert = require('node:assert/strict');
process.env.OSRM_URL = 'https://routing.test';
const originalFetch = global.fetch;
let providerCalls = 0;
let mode = 'ok';
const matrixDistance = [[0,9000,1000],[8000,0,1000],[3000,1000,0]];
const matrixDuration = [[0,100,600],[100,0,100],[100,900,0]];
global.fetch = async (url, options) => {
  if (!String(url).startsWith('https://routing.test')) return originalFetch(url, options);
  providerCalls++;
  if (mode === 'timeout') throw new Error('timeout');
  const coordinates = String(url).split('/driving/')[1].split('?')[0].split(';').map(s=>s.split(',').map(Number));
  if (String(url).includes('/table/')) {
    assert(String(url).includes('annotations=distance,duration'));
    return { ok: true, json: async () => ({code:'Ok', distances: mode==='unreachable' ? matrixDistance.map(r=>r.map(()=>null)) : matrixDistance, durations:matrixDuration}) };
  }
  assert(String(url).includes('continue_straight=false'));
  const legs = coordinates.slice(1).map((_,i)=>({distance:1000,duration:i===0 ? 600 : 900}));
  return { ok:true, json:async()=>({code:'Ok',routes:[{legs: mode==='bad-legs' ? [] : legs, geometry:{coordinates:[coordinates[0], [103.249,16.245], ...coordinates.slice(1)]}}]}) };
};
const { CENTER, RULES, pool } = require('../dist/db');
const { createPlanner } = require('../dist/routing');
const { loadRoadMatrix, loadRoadRoute } = require('../dist/road-network');
const { buildRoadPlans, describeRoadPlan, saveDraft, getDraft, deleteDraft, draftSignature } = require('../dist/road-plans');
const { app } = require('../dist/app');
const origin = {latitude:CENTER.lat,longitude:CENTER.lng};
const orders = [1,2].map((id)=>({order_id:id,customer_id:id,first_name:'Test',last_name:String(id),phone:null,address:'Dorm '+id,latitude:16.24+id*.001,longitude:103.24+id*.001,quantity_boxes:id}));
const riders = [{rider_id:1,name:'Rider',phone:null,color:'#123456'}];

test('road routing, preview, confirmation and saved endpoints', async t => {
  let plan;
  await t.test('directional matrix, road ordering, duration, geometry, fees and repeatable seed', async()=>{
    const matrix = await loadRoadMatrix([origin,...orders]);
    assert.equal(matrix.leg(origin,orders[0]).distance,9000);
    assert.equal(matrix.leg(orders[0],origin).distance,8000);
    const planner = createPlanner(matrix);
    const a=planner.buildPlans(orders,riders,123,1), b=planner.buildPlans(orders,riders,123,1);
    assert.deepEqual(a,b);
    assert.deepEqual(a.plans[0].routes[0].stops.map(s=>s.order_id),[2,1]);
    const result=await buildRoadPlans(orders,riders,123,1);
    plan=result.plans[0];
    assert.equal(plan.summary.total_distance_km,2);
    assert.equal(plan.routes[0].time_min,25);
    assert.equal(plan.routes[0].finish_time,'11:55');
    assert.equal(plan.routes[0].money.rider_fee_total,15+2*2*3);
    assert.deepEqual(plan.routes[0].path[1],[16.245,103.249]);
    const before=providerCalls;
    const restored=await describeRoadPlan([[orders[1],orders[0]]],riders,[JSON.stringify(plan.snapshots[0])]);
    assert.deepEqual(restored.routes,plan.routes);
    assert.equal(providerCalls,before);
    const token=saveDraft(plan,draftSignature(orders,riders));
    assert.deepEqual(getDraft(token).plan,plan);
    deleteDraft(token);
    assert.equal(getDraft(token),undefined);
    assert.notEqual(draftSignature(orders,riders),draftSignature([{...orders[0],quantity_boxes:3},orders[1]],riders));
  });
  await t.test('capacity, duplicates and independent planners', async()=>{
    const before=providerCalls;
    assert.match((await buildRoadPlans(orders,[],1,1)).error,/ไรเดอร์/);
    assert.equal(providerCalls,before);
    const matrix={leg:(a,b)=>({distance:a.latitude===b.latitude ? 0:100,duration:60})};
    const duplicates=[...orders,{...orders[0],order_id:3}];
    const result=createPlanner(matrix).buildPlans(duplicates,riders,44,1);
    assert.deepEqual(result.plans[0].routes.flatMap(r=>r.stops.map(s=>s.order_id)).sort(),[1,2,3]);
    assert(result.plans[0].routes.every(r=>r.orders<=3));
    assert.notEqual(result.plans[0].summary.total_distance_km,plan.summary.total_distance_km);
  });
  let dbOrders=structuredClone(orders), savedSnapshot, commits=0, rollbacks=0;
  const query=async (sql,args)=>{
    if(sql.startsWith('SELECT COUNT(*) AS total FROM riders')) return [[{total:riders.length}]];
    if(sql.includes('SELECT o.order_id')) return [structuredClone(dbOrders)];
    if(sql.startsWith('SELECT rider_id')) return [structuredClone(riders)];
    if(sql.startsWith('INSERT INTO delivery_routes')) { savedSnapshot=args[6]; return [{insertId:7}]; }
    if(sql.includes('SELECT r.')) return [plan.routes[0].stops.map((s,i)=>{
      const o=orders.find(o=>o.order_id===s.order_id);
      return {...o,route_id:7,job_code:'20261028-0007',route_date:'2026-10-28',road_snapshot:savedSnapshot,...riders[0],c_phone:o.phone,stop_seq:i+1};
    })];
    return [{affectedRows:1}];
  };
  pool.query=query;
  pool.getConnection=async()=>({query,beginTransaction:async()=>{},commit:async()=>{commits++},rollback:async()=>{rollbacks++},release:()=>{}});
  const server=app.listen(0,'127.0.0.1');
  await new Promise(resolve=>server.once('listening',resolve));
  const base=`http://127.0.0.1:${server.address().port}/api`;
  const post=(path,body={})=>originalFetch(base+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  try {
    await t.test('API preview → confirm exact snapshot → current and rider job, without provider on confirm/read',async()=>{
      const preview=await (await post('/dispatch/plans?count=1&seed=123')).json();
      assert.equal(preview.plans.length,1);
      assert.equal(preview.plans[0].snapshots,undefined);
      const token=preview.plans[0].plan_token;
      const before=providerCalls;
      const response=await post('/dispatch/confirm',{plan_token:token});
      assert.equal(response.status,201);
      assert.equal(commits,1);
      assert.deepEqual((await response.json()).summary,preview.plans[0].summary);
      assert.deepEqual(JSON.parse(savedSnapshot),plan.snapshots[0]);
      const current=await (await originalFetch(base+'/dispatch/current')).json();
      assert.deepEqual(current.routes[0].path,plan.routes[0].path);
      assert.deepEqual(current.summary,plan.summary);
      const job=await (await originalFetch(base+'/jobs/20261028-0007')).json();
      assert.deepEqual(job.path,plan.routes[0].path);
      assert.equal(job.finish_time,'11:55');
      assert.equal(providerCalls,before);
      assert.equal((await post('/dispatch/confirm',{plan_token:token})).status,409);
    });
    await t.test('stale orders rejected inside transaction before saving',async()=>{
      const token=saveDraft(plan,draftSignature(orders,riders));
      dbOrders[0].latitude+=.01;
      const response=await post('/dispatch/confirm',{plan_token:token});
      assert.equal(response.status,409);
      assert.equal(commits,1);
      assert.equal(rollbacks,1);
      dbOrders=structuredClone(orders);
    });
    await t.test('provider failure yields explicit 503, never straight-line substitution',async()=>{
      mode='timeout'; dbOrders[0].latitude+=.02;
      const response=await post('/dispatch/plans?seed=44');
      assert.equal(response.status,503);
      assert.match((await response.json()).error,/บริการเส้นทาง/);
    });
    await t.test('unreachable and incomplete provider results rejected',async()=>{
      mode='unreachable';
      await assert.rejects(loadRoadMatrix([origin,{...orders[0],latitude:16.3},orders[1]]),/เชื่อมถึง/);
      mode='bad-legs';
      await assert.rejects(loadRoadRoute([origin,{...orders[0],latitude:16.31}]),/ข้อมูลไม่ครบ/);
    });
  } finally { await new Promise(resolve=>server.close(resolve)); await pool.end(); global.fetch=originalFetch; }
});
