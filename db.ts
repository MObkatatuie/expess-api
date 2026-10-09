import "dotenv/config"; // อ่านค่าจากไฟล์ .env (ถ้ามี)
import mysql from "mysql2/promise";

// ---------- เชื่อมต่อ MySQL Server (ตั้งค่าด้วย environment variable) ----------
// DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME  (หรือ DATABASE_URL = mysql://user:pass@host:port/dbname)
function config() {
  if (process.env.DATABASE_URL) {
    const u = new URL(process.env.DATABASE_URL);
    return {
      host: u.hostname,
      port: Number(u.port) || 3306,
      user: decodeURIComponent(u.username),
      password: decodeURIComponent(u.password),
      database: u.pathname.replace(/^\//, ""),
    };
  }
  return {
    host: process.env.DB_HOST || "127.0.0.1",
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER || "root",
    password: process.env.DB_PASSWORD || "",
    database: process.env.DB_NAME || "hw5",
  };
}

const cfg = config();
const sslOpt = process.env.DB_SSL === "true" ? { ssl: { rejectUnauthorized: false } } : {};

export const pool = mysql.createPool({
  ...cfg,
  ...sslOpt,
  charset: "utf8mb4",
  dateStrings: true, // ให้วันเวลาเป็นข้อความ "YYYY-MM-DD HH:MM:SS"
  waitForConnections: true,
  connectionLimit: 10,
});

// จุดศูนย์กลาง/ที่ตั้งร้าน: มหาวิทยาลัยมหาสารคาม (พิกัดโดยประมาณ) — ลูกค้าอยู่ในรัศมีประมาณ 3 กม.
export const CENTER = { lat: 16.19944, lng: 103.28389 };

// ค่าคงที่ตามโจทย์โปรเจกต์ (ไม่ต้องเก็บเป็นตาราง)
export const RULES = {
  BOX_PRICE: 65, // ราคาขายต่อกล่อง (บาท)
  BOX_COST: 40, // ต้นทุนต่อกล่อง (บาท)
  RIDER_CALL_FEE: 15, // ค่าเรียกไรเดอร์ต่อครั้ง (บาท)
  RATE_PER_KM_BOX: 2, // ค่าขนส่ง บาท/กม./กล่อง
  RIDER_SPEED_KMH: 30, // ความเร็วไรเดอร์เฉลี่ย
  MAX_BOXES_PER_ORDER: 3,
  MAX_ORDERS_PER_RIDER: 3,
  DELIVERY_START: "11:30",
  DELIVERY_DEADLINE: "12:30",
};

// ---------- 4 ตาราง: customers, orders, riders, delivery_routes ----------
const schema = [
  // ลูกค้า (พิกัดบ้าน)
  `CREATE TABLE IF NOT EXISTS customers (
    customer_id INT AUTO_INCREMENT PRIMARY KEY,
    first_name  VARCHAR(100) NOT NULL,
    last_name   VARCHAR(100) NOT NULL,
    phone       VARCHAR(20),
    address     VARCHAR(255),
    latitude    DOUBLE NOT NULL,
    longitude   DOUBLE NOT NULL,
    created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_customers_pos (latitude, longitude)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  // ไรเดอร์ (รับไม่เกิน 3 ออร์เดอร์ต่อคน) และสีเส้นทางบนแผนที่
  `CREATE TABLE IF NOT EXISTS riders (
    rider_id   INT AUTO_INCREMENT PRIMARY KEY,
    name       VARCHAR(100) NOT NULL,
    phone      VARCHAR(20),
    color      VARCHAR(10) NOT NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  // ใบงาน = เส้นทางของไรเดอร์ 1 คนใน 1 วัน (job_code = เลขใบงานที่ไรเดอร์ใช้เปิดดูงาน)
  `CREATE TABLE IF NOT EXISTS delivery_routes (
    route_id          INT AUTO_INCREMENT PRIMARY KEY,
    rider_id          INT NOT NULL,
    job_code          VARCHAR(20) NOT NULL UNIQUE,
    route_date        DATE NOT NULL,
    total_distance_km DOUBLE,
    total_time_min    DOUBLE,
    total_cost        DOUBLE,
    created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_routes_rider FOREIGN KEY (rider_id) REFERENCES riders(rider_id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  // ออร์เดอร์ข้าวกล่อง (1 ออร์เดอร์ไม่เกิน 3 กล่อง)
  // route_id + stop_seq = ออร์เดอร์นี้อยู่ใบงานไหน เป็นจุดส่งที่เท่าไร (ว่างได้ ถ้ายังไม่จัดเส้นทาง)
  `CREATE TABLE IF NOT EXISTS orders (
    order_id       INT AUTO_INCREMENT PRIMARY KEY,
    customer_id    INT NOT NULL,
    route_id       INT NULL,
    stop_seq       TINYINT NULL,
    order_date     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    quantity_boxes TINYINT NOT NULL,
    status         VARCHAR(30) NOT NULL DEFAULT 'pending',
    is_mock        TINYINT(1) NOT NULL DEFAULT 0,
    CONSTRAINT chk_boxes CHECK (quantity_boxes BETWEEN 1 AND 3),
    CONSTRAINT chk_stop_seq CHECK (stop_seq IS NULL OR stop_seq BETWEEN 1 AND 3),
    UNIQUE KEY uq_route_stop (route_id, stop_seq),
    CONSTRAINT fk_orders_customer FOREIGN KEY (customer_id) REFERENCES customers(customer_id) ON DELETE CASCADE,
    CONSTRAINT fk_orders_route FOREIGN KEY (route_id) REFERENCES delivery_routes(route_id) ON DELETE SET NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
];

async function count(table: string): Promise<number> {
  const [rows] = await pool.query(`SELECT COUNT(*) AS c FROM ${table}`);
  return Number((rows as any[])[0].c);
}

async function hasColumn(table: string, column: string): Promise<boolean> {
  const [rows] = await pool.query(
    "SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?",
    [table, column]
  );
  return (rows as any[]).length > 0;
}

/** ฐานข้อมูลเดิมแบบ 6 ตาราง -> ปรับเป็น 4 ตาราง (ข้อมูลลูกค้า/ออร์เดอร์/ไรเดอร์เดิมยังอยู่) */
async function migrateFromOldSchema() {
  await pool.query("DROP TABLE IF EXISTS route_stops");
  await pool.query("DROP TABLE IF EXISTS settings");
  if (await hasColumn("riders", "max_orders")) await pool.query("ALTER TABLE riders DROP COLUMN max_orders");
  if (!(await hasColumn("orders", "route_id"))) {
    await pool.query(`ALTER TABLE orders
      ADD COLUMN route_id INT NULL AFTER customer_id,
      ADD COLUMN stop_seq TINYINT NULL AFTER route_id,
      ADD CONSTRAINT chk_stop_seq CHECK (stop_seq IS NULL OR stop_seq BETWEEN 1 AND 3),
      ADD UNIQUE KEY uq_route_stop (route_id, stop_seq),
      ADD CONSTRAINT fk_orders_route FOREIGN KEY (route_id) REFERENCES delivery_routes(route_id) ON DELETE SET NULL`);
  }
}

/** สร้างฐานข้อมูล/ตาราง (ถ้ายังไม่มี) และใส่ข้อมูลเริ่มต้นครั้งแรก */
export async function initDb() {
  // พยายามสร้างฐานข้อมูลให้ก่อน (ถ้าไม่มีสิทธิ์ก็ข้าม แล้วใช้ฐานข้อมูลที่มีอยู่)
  try {
    const { database, ...noDb } = cfg;
    const conn = await mysql.createConnection({ ...noDb, ...sslOpt });
    await conn.query(`CREATE DATABASE IF NOT EXISTS \`${database}\` CHARACTER SET utf8mb4`);
    await conn.end();
  } catch {
    /* ignore */
  }

  for (const sql of schema) await pool.query(sql);
  await migrateFromOldSchema();

  if ((await count("riders")) === 0) {
    // ออร์เดอร์ 20-30 ใบ รับคนละไม่เกิน 3 ใบ => ต้องใช้ไรเดอร์อย่างน้อย 7-10 คนต่อรอบ จึงเตรียมไว้ 12 คน
    const colors = [
      "#e53935", "#43a047", "#1e88e5", "#fb8c00", "#8e24aa", "#00acc1",
      "#6d4c41", "#d81b60", "#7cb342", "#3949ab", "#fdd835", "#546e7a",
    ];
    const rows = colors.map((c, i) => [`ไรเดอร์ ${i + 1}`, `09000000${String(i + 1).padStart(2, "0")}`, c]);
    await pool.query("INSERT INTO riders (name, phone, color) VALUES ?", [rows]);
  }

  if ((await count("customers")) === 0) {
    // [ชื่อ, นามสกุล, เบอร์, ที่อยู่, ระยะเหนือ(+)/ใต้(-) เป็นองศา, ระยะตะวันออก(+)/ตะวันตก(-) เป็นองศา]
    const rows: [string, string, string, string, number, number][] = [
      ["สมชาย", "ใจดี", "0811111111", "หอพักใกล้ มมส. ต.ขามเรียง", 0.003, 0.002],
      ["สมหญิง", "รักเรียน", "0822222222", "ต.ขามเรียง อ.กันทรวิชัย", 0.004, -0.003],
      ["วิชัย", "มั่นคง", "0833333333", "ต.ขามเรียง อ.กันทรวิชัย", -0.006, 0.005],
      ["มานี", "มีตา", "0844444444", "ถ.มหาสารคาม-กาฬสินธุ์", 0.01, 0.008],
      ["ปิติ", "ชูใจ", "0855555555", "ต.ขามเรียง อ.กันทรวิชัย", -0.012, -0.01],
      ["ชูใจ", "สุขสันต์", "0866666666", "ต.ท่าขอนยาง อ.กันทรวิชัย", 0.018, -0.012],
      ["อารี", "ดีงาม", "0877777777", "ต.ท่าขอนยาง อ.กันทรวิชัย", -0.015, 0.016],
      ["ธนา", "พัฒนา", "0888888888", "ต.ขามเรียง อ.กันทรวิชัย", 0.022, 0.01],
      ["นภา", "ฟ้าใส", "0899999999", "ต.ขามเรียง อ.กันทรวิชัย", -0.02, -0.005],
      ["กานต์", "ศรีสุข", "0800000000", "ต.ท่าขอนยาง อ.กันทรวิชัย", 0.008, -0.02],
      ["สุดา", "แสงทอง", "0811110000", "ต.ขามเรียง อ.กันทรวิชัย", -0.004, 0.021],
      ["บุญมา", "เจริญสุข", "0822220000", "ต.ท่าขอนยาง อ.กันทรวิชัย", 0.014, 0.019],
    ];
    const data = rows.map(([f, l, p, a, dLat, dLng]) => [
      f, l, p, a, +(CENTER.lat + dLat).toFixed(6), +(CENTER.lng + dLng).toFixed(6),
    ]);
    await pool.query("INSERT INTO customers (first_name,last_name,phone,address,latitude,longitude) VALUES ?", [data]);
  }
}
