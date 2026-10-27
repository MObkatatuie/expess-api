# เส้นทางตามถนน

ระบบใช้ OSRM Table เพื่อจัดกลุ่ม/เรียงจุดส่งตามระยะถนนแบบมีทิศทาง แล้วใช้ Route เพื่อรับแนวถนนและระยะ/เวลารายช่วงที่ใช้แสดงผลและคิดค่าจ้างจริงในแผน ค่าบริการยังเป็น 15 + 2 × กม. × จำนวนกล่องทั้งหมดในรอบ ไม่รวมขากลับร้าน

การแบ่งตามมุมเป็นจุดเริ่มต้นของการค้นหา จากนั้นลองย้าย/สลับออร์เดอร์และเรียงจุดส่งใหม่โดยใช้ระยะถนน ไม่ใช่ Haversine ไม่รับประกัน optimum ทั้งระบบ OSRM เองคืนระยะของเส้นทางที่เร็วที่สุดตาม profile ไม่ใช่เส้นทางที่สั้นที่สุดทุกกรณี

## เปิดใช้งาน

1. ใช้ Node.js 20 ขึ้นไป ตั้งค่า MySQL ตามเดิม แล้ว `npm ci`, `npm run build`, `npm start`
2. `initDb` เพิ่มคอลัมน์ `delivery_routes.road_snapshot` แบบ nullable ถ้ายังไม่มี ต้องมีสิทธิ์ ALTER ตาราง
3. ตั้ง `OSRM_URL` และ `OSRM_PROFILE` ใน environment ได้ ค่าเริ่มต้นคือ `https://router.project-osrm.org` และ `driving`
4. Frontend ใช้ API URL เดิมใน `src/app/api.ts` (`https://express-api-7ar9.onrender.com/api`) ต้องเผยแพร่ Backend รุ่นนี้ก่อน Frontend ใหม่จึงจะเห็นข้อมูลถนนจากเซิร์ฟเวอร์นั้น การทดสอบกับ local Backend ให้ตั้ง BASE เป็น `http://localhost:3000/api`

OSRM สาธารณะเป็น demo สำหรับการใช้งานที่เหมาะสมและไม่ใช่เชิงพาณิชย์ ไม่รับประกัน uptime ตั้งเซิร์ฟเวอร์เองหรือใช้ผู้ให้บริการที่เหมาะสมเมื่อใช้งานจริง โค้ดคิวคำขอไม่เกินหนึ่งครั้งต่อ 1.1 วินาทีต่อ process และแคช 15 นาที (ถ้ารันหลาย instance ต้องใช้บริการของตนเองหรือคิวกลาง)

## สัญญา API และการบันทึก

- `POST /api/dispatch/plans?count=1` สุ่ม seed ใหม่ถ้าไม่ระบุ คืนหนึ่งแผนแนะนำตามเดิม
- `routes[].path` เป็นแนวถนนหลายจุดในรูป `[latitude, longitude]`; `stops` ยังเป็นจุดลูกค้าตามลำดับส่ง หมุดไม่จำเป็นต้องอยู่บนถนนพอดี
- `time_min`, ETA, ค่าไรเดอร์และกำไรคำนวณจาก legs ของเส้นทางที่แสดง `duration_seconds` ใช้เก็บเวลาที่ไม่ปัดเศษสำหรับสรุปเวลา
- OSRM driving เป็น profile รถยนต์ ไม่ใช่ routing เฉพาะมอเตอร์ไซค์ และไม่มีการจราจรสดหรือเวลาจอดส่ง
- จำกัด snap ไปถนนภายใน 200 เมตร หากไม่พบเส้นทางจะตอบ 503 พร้อมข้อความ ไม่ใช้เส้นตรงแทนโดยเงียบ ๆ
- `plan_token` เป็น opaque UUID อายุ 15 นาที เก็บ draft ในหน่วยความจำของ Backend กดยืนยันจะใช้ preview เดิมและตรวจออร์เดอร์/ไรเดอร์ซ้ำภายใน transaction หากข้อมูลเปลี่ยนหรือ token หมดอายุจะตอบ 409
- รีสตาร์ต Backend หรือเปลี่ยน instance ต้องคำนวณ draft ใหม่ สำหรับหลาย instance ต้องเพิ่ม shared draft storage/sticky routing
- ใบงานที่ยืนยันแล้วเก็บ geometry/legs ใน MySQL จึงเปิดใหม่ได้โดยไม่เรียก OSRM หากพิกัดและลำดับเดิมไม่เปลี่ยน ใบงานเก่าที่ยังไม่มี snapshot จะคำนวณตามถนนเมื่อเปิดดู
- แก้พิกัดหรือออร์เดอร์หลังยืนยัน: หน้าปัจจุบันจะคำนวณตามข้อมูลล่าสุดโดยรักษาลำดับเดิม ควรคำนวณและยืนยันแผนใหม่เพื่อจัดกลุ่มและบันทึกยอดใหม่
- ลิงก์นำทาง Google Maps ยังคงส่งจุดตามลำดับ แต่ Google อาจเลือกแนวถนนต่างจาก OSRM

## ตรวจสอบ

- `npm test` build และทดสอบ matrix ทางเดียว, deterministic seed, ขีดจำกัดไรเดอร์, ค่าขนส่ง/เวลา/geometry, preview-confirm-current-job, stale token และ provider failure ด้วยฐานข้อมูล/OSRM จำลอง ไม่เชื่อมฐานข้อมูลจริง
- `node tests/live-road-smoke.cjs` เป็นการตรวจ OSRM จริงแบบเลือกเรียกเอง ใช้พิกัด seed 12 จุด ไม่เชื่อม MySQL และเขียน `live-road-preview.json`
- Frontend: `npm test -- --watch=false --include=src/app/road-map.spec.ts`

เอกสาร: [OSRM API](https://project-osrm.org/docs/v5.24.0/api/) · [นโยบาย demo](https://github.com/Project-OSRM/osrm-backend/wiki/Demo-server)
