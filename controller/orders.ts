import { Router } from "express";
import { ResultSetHeader } from "mysql2";
import { pool, RULES, cleanupEmptyRoutes } from "../db";
import { boundingBox, haversineKm, parseCoord } from "../geo";

export const router = Router();

const MAX_BOXES = RULES.MAX_BOXES_PER_ORDER; // ออร์เดอร์หนึ่งสั่งได้ไม่เกิน 3 กล่อง (ตามโจทย์)
const PRICE = RULES.BOX_PRICE;

type OrderRow = {
  order_id: number;
  customer_id: number;
  order_date: string;
  quantity_boxes: number;
  status: string;
  is_mock: number;
  route_id: number | null;
  stop_seq: number | null;
  first_name: string;
  last_name: string;
  phone: string | null;
  latitude: number; // พิกัดบ้านลูกค้า (จากตาราง customers)
  longitude: number;
};

// ออร์เดอร์ไม่เก็บพิกัดของตัวเอง ใช้พิกัดบ้านลูกค้าผ่านการ JOIN
const ORDER_SELECT = `
  SELECT o.*, c.first_name, c.last_name, c.phone, c.latitude, c.longitude
  FROM orders o JOIN customers c ON c.customer_id = o.customer_id`;

function format(o: OrderRow, price: number) {
  return {
    order_id: o.order_id,
    order_date: o.order_date,
    status: o.status,
    is_mock: !!o.is_mock,
    route_id: o.route_id,
    stop_seq: o.route_id === null ? null : o.stop_seq, // ลำดับจุดส่งมีความหมายเมื่ออยู่ในใบงานเท่านั้น
    quantity_boxes: o.quantity_boxes,
    total_price: o.quantity_boxes * price,
    customer: {
      customer_id: o.customer_id,
      first_name: o.first_name,
      last_name: o.last_name,
      phone: o.phone,
      latitude: o.latitude,
      longitude: o.longitude,
    },
  };
}

const getOrder = async (id: number | string) => {
  const [rows] = await pool.query(`${ORDER_SELECT} WHERE o.order_id = ?`, [id]);
  const row = (rows as OrderRow[])[0];
  return row ? format(row, PRICE) : undefined;
};

const getBasic = async (id: string) => {
  const [rows] = await pool.query("SELECT order_id, quantity_boxes, status FROM orders WHERE order_id = ?", [id]);
  return (rows as { order_id: number; quantity_boxes: number; status: string }[])[0];
};

const validBoxes = (n: unknown): n is number => Number.isInteger(n) && (n as number) >= 1 && (n as number) <= MAX_BOXES;

// ---------- จำลอง / ล้าง / ใกล้เคียง (ต้องอยู่ก่อน /:id) ----------
// POST /api/orders/mock?count=25  -> จำลองรายการสั่งซื้อ 20-30 รายการ
router.post("/mock", async (req, res) => {
  const count = req.query.count !== undefined ? Number(req.query.count) : 20 + Math.floor(Math.random() * 11);
  if (!Number.isInteger(count) || count < 20 || count > 30)
    return res.status(400).json({ error: "count ต้องเป็นจำนวนเต็ม 20-30" });

  const [custRows] = await pool.query("SELECT customer_id FROM customers");
  const custs = custRows as { customer_id: number }[];
  if (custs.length === 0)
    return res.status(400).json({ error: "ยังไม่มีลูกค้า กรุณาเพิ่มลูกค้าก่อนจำลองออร์เดอร์" });

  const rnd = (a: number, b: number) => a + Math.floor(Math.random() * (b - a + 1));
  const today = new Date().toISOString().slice(0, 10);
  const values: (string | number)[][] = [];
  for (let n = 0; n < count; n++) {
    const c = custs[rnd(0, custs.length - 1)]!;
    // ออร์เดอร์เข้ามาช่วงเช้าประมาณ 09:00-10:59
    const hh = String(rnd(9, 10)).padStart(2, "0");
    const mm = String(rnd(0, 59)).padStart(2, "0");
    values.push([c.customer_id, `${today} ${hh}:${mm}:00`, rnd(1, MAX_BOXES), 1]);
  }
  const [info] = await pool.query<ResultSetHeader>(
    "INSERT INTO orders (customer_id, order_date, quantity_boxes, is_mock) VALUES ?",
    [values]
  );
  const ids = Array.from({ length: count }, (_, i) => info.insertId + i);
  res.status(201).json({ message: `จำลองรายการสั่งซื้อ ${count} รายการ`, count, order_ids: ids });
});

// DELETE /api/orders/mock  -> ล้างรายการสั่งซื้อที่จำลองทั้งหมด
router.delete("/mock", async (_req, res) => {
  const [info] = await pool.query<ResultSetHeader>("DELETE FROM orders WHERE is_mock = 1");
  const routes = await cleanupEmptyRoutes();
  res.json({ message: "ล้างรายการสั่งซื้อที่จำลองทั้งหมดแล้ว", deleted_orders: info.affectedRows, deleted_routes: routes });
});

// DELETE /api/orders/real  -> ลบออร์เดอร์ที่ไม่ใช่ข้อมูลจำลองทั้งหมด (ออร์เดอร์จำลองและลูกค้าไม่ถูกลบ)
router.delete("/real", async (_req, res) => {
  const [info] = await pool.query<ResultSetHeader>("DELETE FROM orders WHERE is_mock = 0");
  const routes = await cleanupEmptyRoutes();
  res.json({ message: "ลบออร์เดอร์ที่ไม่ใช่ข้อมูลจำลองทั้งหมดแล้ว", deleted_orders: info.affectedRows, deleted_routes: routes });
});

// GET /api/orders/nearby?lat=..&lng=..  -> ออร์เดอร์ทั้งหมดในระยะ 2 กม. (วัดจากพิกัดบ้านลูกค้าที่สั่ง)
router.get("/nearby", async (req, res) => {
  const c = parseCoord(req.query.lat, req.query.lng);
  if (!c) return res.status(400).json({ error: "ต้องระบุ lat และ lng ที่ถูกต้อง" });
  const radius = 2;
  const b = boundingBox(c.lat, c.lng, radius);
  const [rows] = await pool.query(
    `${ORDER_SELECT} WHERE c.latitude BETWEEN ? AND ? AND c.longitude BETWEEN ? AND ?`,
    [b.minLat, b.maxLat, b.minLng, b.maxLng]
  );
  const price = PRICE;
  const data = (rows as OrderRow[])
    .map((o) => ({
      ...format(o, price),
      distance_km: +haversineKm(c.lat, c.lng, o.latitude, o.longitude).toFixed(3),
    }))
    .filter((o) => o.distance_km <= radius)
    .sort((a, b) => a.distance_km - b.distance_km);
  res.json({ center: c, radius_km: radius, count: data.length, data });
});

// ---------- CRUD ออร์เดอร์ ----------
// GET /api/orders
router.get("/", async (_req, res) => {
  const [rows] = await pool.query(`${ORDER_SELECT} ORDER BY o.order_id`);
  const price = PRICE;
  const data = (rows as OrderRow[]).map((o) => format(o, price));
  res.json({
    count: data.length,
    total_boxes: data.reduce((s, o) => s + o.quantity_boxes, 0),
    data,
  });
});

// GET /api/orders/:id
router.get("/:id", async (req, res) => {
  const o = await getOrder(req.params.id);
  if (!o) return res.status(404).json({ error: "ไม่พบออร์เดอร์" });
  res.json(o);
});

// POST /api/orders  body: { customer_id, quantity_boxes (1-3) }
router.post("/", async (req, res) => {
  const { customer_id, quantity_boxes } = req.body ?? {};
  const [cust] = await pool.query("SELECT 1 FROM customers WHERE customer_id = ?", [customer_id ?? null]);
  if ((cust as any[]).length === 0) return res.status(400).json({ error: "ไม่พบ customer_id นี้" });
  if (!validBoxes(quantity_boxes))
    return res.status(400).json({ error: `quantity_boxes ต้องเป็นจำนวนเต็ม 1-${MAX_BOXES}` });
  const [info] = await pool.query<ResultSetHeader>(
    "INSERT INTO orders (customer_id, quantity_boxes, is_mock) VALUES (?,?,0)",
    [customer_id, quantity_boxes]
  );
  res.status(201).json(await getOrder(info.insertId));
});

// PUT /api/orders/:id  body: { quantity_boxes?, status? }  -> แก้ไขออร์เดอร์/ตั้งจำนวนกล่องใหม่
router.put("/:id", async (req, res) => {
  const old = await getBasic(req.params.id);
  if (!old) return res.status(404).json({ error: "ไม่พบออร์เดอร์" });
  const b = req.body ?? {};
  if (b.quantity_boxes !== undefined && !validBoxes(b.quantity_boxes))
    return res.status(400).json({ error: `quantity_boxes ต้องเป็นจำนวนเต็ม 1-${MAX_BOXES}` });
  if (b.status !== undefined && (typeof b.status !== "string" || b.status.trim() === ""))
    return res.status(400).json({ error: "status ต้องเป็นข้อความที่ไม่ว่าง" });
  await pool.query("UPDATE orders SET quantity_boxes=?, status=? WHERE order_id=?", [
    b.quantity_boxes ?? old.quantity_boxes,
    b.status ?? old.status,
    old.order_id,
  ]);
  res.json(await getOrder(old.order_id));
});

// DELETE /api/orders/:id  -> ลบทั้งออร์เดอร์
router.delete("/:id", async (req, res) => {
  const [info] = await pool.query<ResultSetHeader>("DELETE FROM orders WHERE order_id = ?", [req.params.id]);
  if (info.affectedRows === 0) return res.status(404).json({ error: "ไม่พบออร์เดอร์" });
  await cleanupEmptyRoutes();
  res.json({ message: "ลบออร์เดอร์เรียบร้อย", order_id: Number(req.params.id) });
});

// ---------- เพิ่ม / ลบ จำนวนกล่อง ----------
// POST /api/orders/:id/boxes  body: { amount }  -> เพิ่มจำนวนกล่อง (รวมแล้วไม่เกิน 3)
router.post("/:id/boxes", async (req, res) => {
  const o = await getBasic(req.params.id);
  if (!o) return res.status(404).json({ error: "ไม่พบออร์เดอร์" });
  const amount = req.body?.amount ?? 1;
  if (!Number.isInteger(amount) || amount < 1)
    return res.status(400).json({ error: "amount ต้องเป็นจำนวนเต็มตั้งแต่ 1 ขึ้นไป" });
  if (o.quantity_boxes + amount > MAX_BOXES)
    return res.status(400).json({ error: `ออร์เดอร์หนึ่งสั่งได้ไม่เกิน ${MAX_BOXES} กล่อง (ตอนนี้มี ${o.quantity_boxes} กล่อง)` });
  await pool.query("UPDATE orders SET quantity_boxes = quantity_boxes + ? WHERE order_id = ?", [amount, o.order_id]);
  res.status(201).json(await getOrder(o.order_id));
});

// DELETE /api/orders/:id/boxes?amount=1  -> ลดจำนวนกล่อง (ต้องเหลืออย่างน้อย 1 กล่อง)
router.delete("/:id/boxes", async (req, res) => {
  const o = await getBasic(req.params.id);
  if (!o) return res.status(404).json({ error: "ไม่พบออร์เดอร์" });
  const amount = req.query.amount !== undefined ? Number(req.query.amount) : 1;
  if (!Number.isInteger(amount) || amount < 1)
    return res.status(400).json({ error: "amount ต้องเป็นจำนวนเต็มตั้งแต่ 1 ขึ้นไป" });
  if (o.quantity_boxes - amount < 1)
    return res
      .status(400)
      .json({ error: "ลดแล้วเหลือน้อยกว่า 1 กล่อง ถ้าต้องการยกเลิกทั้งออร์เดอร์ให้ใช้ DELETE /api/orders/:id" });
  await pool.query("UPDATE orders SET quantity_boxes = quantity_boxes - ? WHERE order_id = ?", [amount, o.order_id]);
  res.json(await getOrder(o.order_id));
});
