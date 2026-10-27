const {test} = require('node:test');
const assert = require('node:assert/strict');
const {pool} = require('../dist/db');
const {ensureRiderCapacity} = require('../dist/rider-capacity');
test('grows beyond 12, reuses riders and rechecks capacity under lock', async () => {
  let roster = Array.from({length:12},(_,i)=>({rider_id:i+1,name:`ไรเดอร์ ${i+1}`}));
  let inserts=0, commits=0, releases=0, staleCount=false;
  pool.query=async()=>[[{total:staleCount ? 0 : roster.length}]];
  pool.getConnection=async()=>({
    beginTransaction:async()=>{}, commit:async()=>{commits++}, rollback:async()=>{}, release:()=>{releases++},
    query:async(sql,args)=>{
      if(sql.includes('GET_LOCK')) return [[{acquired:1}]];
      if(sql.startsWith('SELECT rider_id')) return [roster];
      if(sql.startsWith('INSERT')) {
        assert.equal(args[1],null); assert.match(args[2],/^#[0-9a-f]{6}$/);
        assert(!roster.some(r=>r.name===args[0]));
        roster.push({rider_id:roster.length+1,name:args[0]}); inserts++;
      }
      return [{}];
    }
  });
  await ensureRiderCapacity(0);
  await ensureRiderCapacity(36); assert.equal(inserts,0);
  await ensureRiderCapacity(40); assert.equal(roster.length,14); assert.equal(inserts,2);
  await ensureRiderCapacity(40); assert.equal(inserts,2);
  staleCount=true;
  await ensureRiderCapacity(40); assert.equal(inserts,2);
  staleCount=false;
  await ensureRiderCapacity(301); assert.equal(roster.length,101);
  assert.equal(commits,3); assert.equal(releases,3);
  await pool.end();
});
