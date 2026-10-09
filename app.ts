import express from "express";
import { router as index } from "./controller/index";
import { router as customers } from "./controller/customers";
import { router as orders } from "./controller/orders";

export const app = express();

app.use(express.json());

app.use("/", index);
app.use("/api/customers", customers);
app.use("/api/orders", orders);

app.use((_req, res) => res.status(404).json({ error: "ไม่พบ endpoint นี้" }));
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (err?.type === "entity.parse.failed") return res.status(400).json({ error: "JSON ไม่ถูกต้อง" });
  console.error(err);
  res.status(500).json({ error: "เกิดข้อผิดพลาดภายในเซิร์ฟเวอร์" });
});
