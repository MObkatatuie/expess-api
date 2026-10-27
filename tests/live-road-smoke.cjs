// Optional live provider check. Never opens or changes the application database.
const fs = require('node:fs');
const assert = require('node:assert/strict');
const { buildRoadPlans } = require('../dist/road-plans');
const { pool } = require('../dist/db');
const source = fs.readFileSync('db.ts','utf8');
const rows=JSON.parse(source.match(/const SAMPLE_CUSTOMERS:[\s\S]*?= (\[[\s\S]*?\n\]);/)[1].replace(/,\s*]/g,']'));
const orders=rows.map((r,i)=>({order_id:i+1,customer_id:i+1,first_name:r[0],last_name:r[1],phone:r[2],address:r[3],latitude:r[4],longitude:r[5],quantity_boxes:(i%3)+1}));
const riders=Array.from({length:12},(_,i)=>({rider_id:i+1,name:`ไรเดอร์ ${i+1}`,phone:null,color:['#e53935','#43a047','#1e88e5','#fb8c00','#8e24aa','#00acc1'][i%6]}));
(async()=>{
  const result=await buildRoadPlans(orders,riders,123,1);
  assert(!result.error,result.error);
  const plan=result.plans[0];
  assert.equal(plan.summary.orders,12);
  assert(plan.routes.every(r=>r.path.length>2 && r.stops.length<=3));
  fs.writeFileSync('live-road-preview.json',JSON.stringify({...plan,plan_token:'preview-only'},null,2));
  console.log(JSON.stringify({summary:plan.summary,routes:plan.routes.map(r=>({stops:r.stops.map(s=>s.order_id),km:r.distance_km,minutes:r.time_min,path_points:r.path.length}))},null,2));
})().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>pool.end());
