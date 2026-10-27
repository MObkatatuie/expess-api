import { pool, RULES } from './db';

// Reuse the roster; add only the capacity missing for this batch.
export async function ensureRiderCapacity(orderCount: number) {
  const required = Math.ceil(orderCount / RULES.MAX_ORDERS_PER_RIDER);
  if (required === 0) return;
  const [existing] = await pool.query('SELECT COUNT(*) AS total FROM riders');
  if (Number((existing as { total: number }[])[0]!.total) >= required) return;
  const conn = await pool.getConnection();
  let locked = false;
  try {
    const [result] = await conn.query("SELECT GET_LOCK('dispatch_rider_capacity', 10) AS acquired");
    locked = Number((result as { acquired: number }[])[0]!.acquired) === 1;
    if (!locked) throw new Error('Could not acquire rider capacity lock');
    await conn.beginTransaction();
    const [rows] = await conn.query('SELECT rider_id, name FROM riders ORDER BY rider_id');
    const roster = rows as { rider_id: number; name: string }[];
    const names = new Set(roster.map(r => r.name));
    let number = 1;
    for (let i = roster.length; i < required; i++) {
      while (names.has(`ไรเดอร์ ${number}`)) number++;
      const name = `ไรเดอร์ ${number}`;
      names.add(name);
      // Golden-angle hues remain available beyond the original 12 colors.
      const hue = (number * 137.508) % 360;
      const x = 1 - Math.abs((hue / 60) % 2 - 1);
      const rgb = hue < 60 ? [1,x,0] : hue < 120 ? [x,1,0] : hue < 180 ? [0,1,x]
        : hue < 240 ? [0,x,1] : hue < 300 ? [x,0,1] : [1,0,x];
      const color = '#' + rgb.map(v => Math.round((0.15 + v * 0.6) * 255).toString(16).padStart(2,'0')).join('');
      await conn.query('INSERT INTO riders (name, phone, color) VALUES (?, ?, ?)', [name, null, color]);
      number++;
    }
    await conn.commit();
  } catch (error) {
    if (locked) await conn.rollback();
    throw error;
  } finally {
    try { if (locked) await conn.query("SELECT RELEASE_LOCK('dispatch_rider_capacity')"); }
    finally { conn.release(); }
  }
}
