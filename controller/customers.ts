import { Router } from "express";
import { ResultSetHeader } from "mysql2";
import { pool } from "../db";
import { boundingBox, haversineKm, parseCoord } from "../geo";

export const router = Router();

type Customer = {
  customer_id: number;
  first_name: string;
  last_name: string;
  phone: string | null;
  address: string | null;
  latitude: number;
  longitude: number;
  created_at: string;
};

const findCustomer = async (id: unknown) => {
  const [rows] = await pool.query("SELECT * FROM customers WHERE customer_id = ?", [id]);
  return (rows as Customer[])[0];
};

// GET /api/customers  -> แสดงลูกค้าทุกคน
router.get("/", async (_req, res) => {
  const [rows] = await pool.query("SELECT * FROM customers ORDER BY customer_id");
  res.json({ count: (rows as any[]).length, data: rows });
});

// GET /api/customers/search?q=สม  -> ค้นหาจากส่วนหนึ่งของชื่อหรือนามสกุล
router.get("/search", async (req, res) => {
  const q = String(req.query.q ?? "").trim();
  if (!q) return res.status(400).json({ error: "ต้องระบุ query parameter 'q'" });
  const like = `%${q.replace(/[\\%_]/g, (m) => "\\" + m)}%`;
  const [rows] = await pool.query(
    "SELECT * FROM customers WHERE first_name LIKE ? OR last_name LIKE ? ORDER BY customer_id",
    [like, like]
  );
  res.json({ query: q, count: (rows as any[]).length, data: rows });
});

// GET /api/customers/nearby?lat=..&lng=..  -> ลูกค้าทั้งหมดในระยะ 1 กม.
router.get("/nearby", async (req, res) => {
  const c = parseCoord(req.query.lat, req.query.lng);
  if (!c) return res.status(400).json({ error: "ต้องระบุ lat และ lng ที่ถูกต้อง" });
  const radius = 1;
  const b = boundingBox(c.lat, c.lng, radius);
  const [rows] = await pool.query(
    "SELECT * FROM customers WHERE latitude BETWEEN ? AND ? AND longitude BETWEEN ? AND ?",
    [b.minLat, b.maxLat, b.minLng, b.maxLng]
  );
  const data = (rows as Customer[])
    .map((r) => ({ ...r, distance_km: +haversineKm(c.lat, c.lng, r.latitude, r.longitude).toFixed(3) }))
    .filter((r) => r.distance_km <= radius)
    .sort((a, b) => a.distance_km - b.distance_km);
  res.json({ center: c, radius_km: radius, count: data.length, data });
});

// GET /api/customers/:id
router.get("/:id", async (req, res) => {
  const row = await findCustomer(req.params.id);
  if (!row) return res.status(404).json({ error: "ไม่พบลูกค้า" });
  res.json(row);
});

// POST /api/customers  -> เพิ่มลูกค้า
router.post("/", async (req, res) => {
  const { first_name, last_name, phone = null, address = null } = req.body ?? {};
  const c = parseCoord(req.body?.latitude, req.body?.longitude);
  if (!first_name || !last_name || !c)
    return res.status(400).json({ error: "ต้องมี first_name, last_name, latitude, longitude" });
  const [info] = await pool.query<ResultSetHeader>(
    "INSERT INTO customers (first_name,last_name,phone,address,latitude,longitude) VALUES (?,?,?,?,?,?)",
    [first_name, last_name, phone, address, c.lat, c.lng]
  );
  res.status(201).json(await findCustomer(info.insertId));
});

// PUT /api/customers/:id  -> แก้ไขลูกค้า (ส่งเฉพาะฟิลด์ที่ต้องการแก้ได้)
router.put("/:id", async (req, res) => {
  const old = await findCustomer(req.params.id);
  if (!old) return res.status(404).json({ error: "ไม่พบลูกค้า" });
  const b = req.body ?? {};
  let lat = old.latitude;
  let lng = old.longitude;
  if (b.latitude !== undefined || b.longitude !== undefined) {
    const c = parseCoord(b.latitude ?? old.latitude, b.longitude ?? old.longitude);
    if (!c) return res.status(400).json({ error: "latitude/longitude ไม่ถูกต้อง" });
    lat = c.lat;
    lng = c.lng;
  }
  await pool.query(
    `UPDATE customers SET first_name=?, last_name=?, phone=?, address=?, latitude=?, longitude=?
     WHERE customer_id=?`,
    [
      b.first_name ?? old.first_name,
      b.last_name ?? old.last_name,
      b.phone ?? old.phone,
      b.address ?? old.address,
      lat,
      lng,
      old.customer_id,
    ]
  );
  res.json(await findCustomer(old.customer_id));
});

// DELETE /api/customers/:id  -> ลบลูกค้า (ออร์เดอร์ของลูกค้าถูกลบตามด้วย)
router.delete("/:id", async (req, res) => {
  const [info] = await pool.query<ResultSetHeader>("DELETE FROM customers WHERE customer_id = ?", [req.params.id]);
  if (info.affectedRows === 0) return res.status(404).json({ error: "ไม่พบลูกค้า" });
  res.json({ message: "ลบลูกค้าเรียบร้อย", customer_id: Number(req.params.id) });
});
