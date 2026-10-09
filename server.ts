import { app } from "./app";
import { initDb } from "./db";

const port = Number(process.env.PORT) || 3000;

initDb()
  .then(() => app.listen(port, "0.0.0.0", () => console.log(`API running on port ${port}`)))
  .catch((err: any) => {
    // เชื่อมต่อไม่ได้บางกรณี (เช่น ECONNREFUSED) message จะว่าง จึงแสดง code และรายละเอียดด้วย
    const list: any[] = err?.errors?.length ? err.errors : [err];
    console.error("เชื่อมต่อ/เตรียมฐานข้อมูล MySQL ไม่สำเร็จ:");
    for (const e of list) console.error(` - ${e?.code ?? ""} ${e?.message ?? ""} ${e?.address ?? ""}${e?.port ? ":" + e.port : ""}`.trimEnd());
    if (list.some((e) => e?.code === "ECONNREFUSED"))
      console.error("→ ติดต่อ MySQL server ไม่ได้: ตรวจว่าเปิด MySQL (เช่น XAMPP) แล้ว และ DB_HOST / DB_PORT ถูกต้อง");
    if (list.some((e) => e?.code === "ER_ACCESS_DENIED_ERROR"))
      console.error("→ user หรือรหัสผ่านไม่ถูกต้อง: ตรวจ DB_USER / DB_PASSWORD");
    process.exit(1);
  });
