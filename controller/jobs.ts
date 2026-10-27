import { Router } from "express";
import { CENTER, RULES, pool } from "../db";
import type { DispatchOrder } from "../routing";
import { describeRoadPlan } from "../road-plans";

export const router = Router();

const mapLink = (lat: number, lng: number) => `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`;

// GET /api/jobs/:job_code  -> ใบงานของไรเดอร์ (เปิดดูผ่านมือถือ)
router.get("/:job_code", async (req, res) => {
  const [rows] = await pool.query(
    `SELECT r.job_code, r.route_date, r.road_snapshot, d.rider_id, d.name, d.phone, d.color,
            o.order_id, o.customer_id, o.quantity_boxes, o.stop_seq,
            c.first_name, c.last_name, c.phone AS c_phone, c.address, c.latitude, c.longitude
     FROM delivery_routes r
     JOIN riders d ON d.rider_id = r.rider_id
     JOIN orders o ON o.route_id = r.route_id
     JOIN customers c ON c.customer_id = o.customer_id
     WHERE r.job_code = ?
     ORDER BY o.stop_seq`,
    [req.params.job_code.trim()]
  );
  const list = rows as any[];
  if (list.length === 0) return res.status(404).json({ error: "ไม่พบใบงานนี้ ตรวจสอบเลขใบงานอีกครั้ง" });

  const first = list[0];
  const stops: DispatchOrder[] = list.map((r) => ({ ...r, phone: r.c_phone }));
  const rider = { rider_id: first.rider_id, name: first.name, phone: first.phone, color: first.color };
  const route = (await describeRoadPlan([stops], [rider], [first.road_snapshot])).routes[0]!;

  // ลิงก์นำทางทั้งเส้น: ร้าน -> จุดที่ 1 -> ... -> จุดสุดท้าย
  const pts = stops.map((s) => `${s.latitude},${s.longitude}`);
  const fullRoute =
    `https://www.google.com/maps/dir/?api=1&origin=${CENTER.lat},${CENTER.lng}` +
    `&destination=${pts[pts.length - 1]}` +
    (pts.length > 1 ? `&waypoints=${encodeURIComponent(pts.slice(0, -1).join("|"))}` : "") +
    "&travelmode=driving";

  res.json({
    job_code: first.job_code,
    date: first.route_date,
    rider,
    pickup: `หยิบข้าวกล่องทั้งหมด ${route.boxes} กล่อง ออกจากร้าน ${RULES.DELIVERY_START}`,
    total_boxes: route.boxes,
    total_stops: route.stops.length,
    distance_km: route.distance_km,
    path: route.path,
    routing_source: route.routing_source,
    shop: CENTER,
    finish_time: route.finish_time,
    steps: route.stops.map(
      (s) => `จุดที่ ${s.seq}: ส่งบ้านคุณ${s.customer.name} ${s.boxes} กล่อง (ถึงประมาณ ${s.eta})`
    ),
    stops: route.stops.map((s) => ({
      seq: s.seq,
      order_id: s.order_id,
      boxes: s.boxes,
      customer_name: s.customer.name,
      phone: s.customer.phone,
      address: s.customer.address,
      eta: s.eta,
      latitude: s.customer.latitude,
      longitude: s.customer.longitude,
      map_url: mapLink(s.customer.latitude, s.customer.longitude),
    })),
    full_route_map_url: fullRoute,
  });
});
