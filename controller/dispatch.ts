import { Router } from "express";
import { ResultSetHeader } from "mysql2";
import { pool } from "../db";
import { buildPlans, describePlan, ordersSignature, type DispatchOrder, type Rider } from "../routing";

export const router = Router();

// ออร์เดอร์ที่ยังไม่ได้ส่ง (pending = ยังไม่จัด, assigned = จัดแล้วแต่ยังจัดใหม่ได้)
async function loadOrders(): Promise<DispatchOrder[]> {
  const [rows] = await pool.query(
    `SELECT o.order_id, o.customer_id, o.quantity_boxes,
            c.first_name, c.last_name, c.phone, c.address, c.latitude, c.longitude
     FROM orders o JOIN customers c ON c.customer_id = o.customer_id
     WHERE o.status IN ('pending', 'assigned')
     ORDER BY o.order_id`
  );
  return rows as DispatchOrder[];
}
async function loadRiders(): Promise<Rider[]> {
  const [rows] = await pool.query("SELECT rider_id, name, phone, color FROM riders ORDER BY rider_id");
  return rows as Rider[];
}

// วันที่ปัจจุบันตามเวลาไทย (YYYY-MM-DD)
const todayTH = () => new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);

// แฮชสั้น ๆ ของชุดออร์เดอร์ ใส่ใน plan_token เพื่อตรวจว่าออร์เดอร์ไม่เปลี่ยนก่อนยืนยัน
function shortHash(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36);
}

// POST /api/dispatch/plans?count=3&seed=123
// คำนวณเส้นทางและเสนอหลายแผน (ยังไม่บันทึก) กดซ้ำโดยไม่ใส่ seed = คำนวณใหม่ได้แผนชุดใหม่
router.post("/plans", async (req, res) => {
  const count = req.query.count !== undefined ? Number(req.query.count) : 3;
  if (!Number.isInteger(count) || count < 1 || count > 5)
    return res.status(400).json({ error: "count ต้องเป็นจำนวนเต็ม 1-5" });
  const seed = req.query.seed !== undefined ? Number(req.query.seed) : Math.floor(Math.random() * 1e9);
  if (!Number.isInteger(seed) || seed < 0) return res.status(400).json({ error: "seed ต้องเป็นจำนวนเต็มตั้งแต่ 0" });

  const [orders, riders] = await Promise.all([loadOrders(), loadRiders()]);
  if (orders.length === 0) return res.status(400).json({ error: "ไม่มีออร์เดอร์ที่รอจัดส่ง" });
  const result = buildPlans(orders, riders, seed, count);
  if ("error" in result) return res.status(400).json({ error: result.error });

  const h = shortHash(ordersSignature(orders));
  res.json({
    seed,
    orders_waiting: orders.length,
    riders_available: riders.length,
    note: "ยังไม่บันทึก เลือกแผนแล้วส่ง plan_token ไปที่ POST /api/dispatch/confirm หรือเรียกซ้ำเพื่อคำนวณใหม่",
    plans: result.plans.map((p) => ({ plan_token: `${seed}-${p.plan_no}-${h}`, ...p })),
  });
});

// POST /api/dispatch/confirm  body: { plan_token }
// บันทึกแผนที่เลือก: สร้างใบงาน (delivery_routes) + ใส่ route_id/stop_seq ให้ออร์เดอร์
router.post("/confirm", async (req, res) => {
  const token = String(req.body?.plan_token ?? "");
  const m = /^(\d+)-(\d+)-([0-9a-z]+)$/.exec(token);
  if (!m) return res.status(400).json({ error: "ต้องส่ง plan_token ที่ได้จาก POST /api/dispatch/plans" });
  const [seed, planNo, hash] = [Number(m[1]), Number(m[2]), m[3]];

  const [orders, riders] = await Promise.all([loadOrders(), loadRiders()]);
  if (shortHash(ordersSignature(orders)) !== hash)
    return res.status(409).json({ error: "ออร์เดอร์มีการเปลี่ยนแปลงหลังคำนวณ กรุณาคำนวณแผนใหม่" });
  const result = buildPlans(orders, riders, seed, Math.max(planNo, 1));
  if ("error" in result) return res.status(400).json({ error: result.error });
  const plan = result.plans.find((p) => p.plan_no === planNo);
  if (!plan) return res.status(404).json({ error: "ไม่พบแผนนี้" });

  const date = todayTH();
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    // ลบใบงานเดิมของออร์เดอร์ชุดนี้ (FK ตั้ง route_id ของออร์เดอร์เป็น NULL ให้เอง)
    await conn.query(
      `DELETE FROM delivery_routes WHERE route_id IN (
         SELECT route_id FROM (SELECT DISTINCT route_id FROM orders
           WHERE status IN ('pending','assigned') AND route_id IS NOT NULL) t)`
    );
    await conn.query("UPDATE orders SET stop_seq = NULL, status = 'pending' WHERE status = 'assigned'");
    const jobs: { job_code: string; rider: string; color: string }[] = [];
    for (const r of plan.routes) {
      const [info] = await conn.query<ResultSetHeader>(
        `INSERT INTO delivery_routes (rider_id, job_code, route_date, total_distance_km, total_time_min, total_cost)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [r.rider.rider_id, `tmp-${Date.now()}-${r.rider.rider_id}`.slice(0, 20), date, r.distance_km, r.time_min, r.money.rider_fee_total]
      );
      // เลขใบงาน: วันที่ + รหัสใบงาน เช่น 20261010-0007
      const jobCode = `${date.replace(/-/g, "")}-${String(info.insertId).padStart(4, "0")}`;
      await conn.query("UPDATE delivery_routes SET job_code = ? WHERE route_id = ?", [jobCode, info.insertId]);
      for (const s of r.stops)
        await conn.query("UPDATE orders SET route_id = ?, stop_seq = ?, status = 'assigned' WHERE order_id = ?", [
          info.insertId,
          s.seq,
          s.order_id,
        ]);
      jobs.push({ job_code: jobCode, rider: r.rider.name, color: r.rider.color });
    }
    await conn.commit();
    res.status(201).json({ message: "บันทึกแผนจัดส่งแล้ว", route_date: date, jobs, summary: plan.summary });
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
});

// GET /api/dispatch/current  -> แผนที่บันทึกไว้ (ภาพรวมเงิน/เวลา + เส้นทางแต่ละไรเดอร์)
router.get("/current", async (_req, res) => {
  const [rows] = await pool.query(
    `SELECT r.route_id, r.job_code, r.route_date, d.rider_id, d.name, d.phone, d.color,
            o.order_id, o.customer_id, o.quantity_boxes, o.stop_seq,
            c.first_name, c.last_name, c.phone AS c_phone, c.address, c.latitude, c.longitude
     FROM delivery_routes r
     JOIN riders d ON d.rider_id = r.rider_id
     JOIN orders o ON o.route_id = r.route_id AND o.status = 'assigned'
     JOIN customers c ON c.customer_id = o.customer_id
     ORDER BY r.route_id, o.stop_seq`
  );
  const list = rows as any[];
  if (list.length === 0) return res.status(404).json({ error: "ยังไม่มีแผนที่บันทึกไว้" });
  const byRoute = new Map<number, { rider: Rider; job_code: string; route_date: string; stops: DispatchOrder[] }>();
  for (const r of list) {
    if (!byRoute.has(r.route_id))
      byRoute.set(r.route_id, {
        rider: { rider_id: r.rider_id, name: r.name, phone: r.phone, color: r.color },
        job_code: r.job_code,
        route_date: r.route_date,
        stops: [],
      });
    byRoute.get(r.route_id)!.stops.push({ ...r, phone: r.c_phone });
  }
  const groups = [...byRoute.values()];
  const plan = describePlan(
    groups.map((g) => g.stops),
    groups.map((g) => g.rider)
  );
  res.json({
    route_date: groups[0]!.route_date,
    summary: plan.summary,
    routes: plan.routes.map((r, i) => ({ job_code: groups[i]!.job_code, ...r })),
  });
});
