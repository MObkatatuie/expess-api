import { CENTER, RULES } from "./db";
import type { RoadMatrix, RoadRoute } from "./road-network";

// ---------- ตัวคำนวณเส้นทางจัดส่ง (ไม่แตะฐานข้อมูล) ----------

export type DispatchOrder = {
  order_id: number;
  customer_id: number;
  first_name: string;
  last_name: string;
  phone: string | null;
  address: string | null;
  latitude: number;
  longitude: number;
  quantity_boxes: number;
};
export type Rider = { rider_id: number; name: string; phone: string | null; color: string };

const SHOP = CENTER;
const round = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d;

/** สุ่มแบบกำหนด seed ได้ (seed เดิม = ผลเดิมทุกครั้ง ใช้ยืนยันแผนที่เลือก) */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function createPlanner(matrix: RoadMatrix) {
const dist = (a: { latitude: number; longitude: number }, b: { latitude: number; longitude: number }) =>
  matrix.leg(a, b).distance / 1000;
const shopPt = { latitude: SHOP.lat, longitude: SHOP.lng };

/** ระยะทางเมื่อวิ่งจากร้านไปตามลำดับจุด (ไม่นับขากลับ) */
function pathKm(stops: DispatchOrder[]): number {
  let km = 0;
  let prev: { latitude: number; longitude: number } = shopPt;
  for (const s of stops) {
    km += dist(prev, s);
    prev = s;
  }
  return km;
}

// แคชอยู่ภายใน planner แต่ละคำขอ ไม่แชร์ตารางถนนข้ามคำขอ
const bestCache = new Map<string, DispatchOrder[]>();
const feeCache = new Map<string, number>();
const idKey = (stops: DispatchOrder[]) => stops.map((o) => o.order_id).join(",");

/** จุดไม่เกิน 3 จุด ลองทุกลำดับ (สูงสุด 6 แบบ) แล้วเลือกลำดับที่ระยะสั้นที่สุด */
function bestOrder(stops: DispatchOrder[]): DispatchOrder[] {
  const key = stops.map((o) => o.order_id).sort((a, b) => a - b).join(",");
  const hit = bestCache.get(key);
  if (hit) return hit;
  const best = bestOrderUncached(stops);
  bestCache.set(key, best);
  return best;
}
function bestOrderUncached(stops: DispatchOrder[]): DispatchOrder[] {
  const perms = (xs: DispatchOrder[]): DispatchOrder[][] =>
    xs.length <= 1 ? [xs] : xs.flatMap((x, i) => perms([...xs.slice(0, i), ...xs.slice(i + 1)]).map((p) => [x, ...p]));
  let best = stops;
  let bestKm = Infinity;
  for (const p of perms(stops)) {
    const km = pathKm(p);
    if (km < bestKm) [best, bestKm] = [p, km];
  }
  return best;
}

/** ค่าจ้างไรเดอร์ 1 รอบ = 15 บาท + 2 บาท x กม. x จำนวนกล่องที่ถือ */
function riderFee(stops: DispatchOrder[]): number {
  const key = idKey(stops);
  const hit = feeCache.get(key);
  if (hit !== undefined) return hit;
  const boxes = stops.reduce((s, o) => s + o.quantity_boxes, 0);
  const fee = RULES.RIDER_CALL_FEE + RULES.RATE_PER_KM_BOX * pathKm(stops) * boxes;
  feeCache.set(key, fee);
  return fee;
}
const planCost = (groups: DispatchOrder[][]) => groups.reduce((s, g) => s + riderFee(g), 0);

/** แบ่งกลุ่มตามมุมรอบร้าน (sweep) เริ่มที่มุมสุ่ม แล้วตัดทีละไม่เกิน 3 ออร์เดอร์ */
function sweep(orders: DispatchOrder[], startAngle: number, size: number): DispatchOrder[][] {
  const ang = (o: DispatchOrder) => {
    const a = Math.atan2(o.latitude - SHOP.lat, o.longitude - SHOP.lng) - startAngle;
    return (a + 4 * Math.PI) % (2 * Math.PI);
  };
  const sorted = [...orders].sort((a, b) => ang(a) - ang(b));
  const groups: DispatchOrder[][] = [];
  for (let i = 0; i < sorted.length; i += size) groups.push(sorted.slice(i, i + size));
  return groups;
}

/** ปรับปรุงแผน: ลองย้าย/สลับออร์เดอร์ระหว่างกลุ่ม ถ้าค่าไรเดอร์รวมลดลงก็เก็บไว้ */
function improve(groups: DispatchOrder[][], maxGroups: number): DispatchOrder[][] {
  let g = groups.map((x) => bestOrder(x));
  let improved = true;
  while (improved) {
    improved = false;
    for (let i = 0; !improved && i < g.length; i++) {
      for (let a = 0; !improved && a < g[i]!.length; a++) {
        const o = g[i]![a]!;
        const without = g[i]!.filter((_, k) => k !== a);
        const baseI = riderFee(g[i]!);
        const newI = without.length ? riderFee(bestOrder(without)) : 0;
        // ย้ายไปกลุ่มอื่น หรือแยกเป็นไรเดอร์คนใหม่ (j === g.length)
        for (let j = 0; !improved && j <= g.length; j++) {
          if (j === i) continue;
          if (j === g.length && (g.length >= maxGroups || without.length === 0)) continue;
          const target = j < g.length ? g[j]! : [];
          if (target.length < RULES.MAX_ORDERS_PER_RIDER) {
            const moved = bestOrder([...target, o]);
            const delta = newI + riderFee(moved) - baseI - (target.length ? riderFee(target) : 0);
            if (delta < -1e-6) {
              const next = g.map((x) => [...x]);
              next[i] = bestOrder(without);
              if (j < g.length) next[j] = moved;
              else next.push(moved);
              g = next.filter((x) => x.length > 0);
              improved = true;
            }
          }
          // สลับออร์เดอร์ 1 ต่อ 1
          if (!improved && j < g.length) {
            for (let b = 0; !improved && b < g[j]!.length; b++) {
              const gi = bestOrder([...without, g[j]![b]!]);
              const gj = bestOrder([...g[j]!.filter((_, k) => k !== b), o]);
              const delta = riderFee(gi) + riderFee(gj) - baseI - riderFee(g[j]!);
              if (delta < -1e-6) {
                const next = g.map((x) => [...x]);
                next[i] = gi;
                next[j] = gj;
                g = next;
                improved = true;
              }
            }
          }
        }
      }
    }
  }
  return g;
}

const signature = (groups: DispatchOrder[][]) =>
  groups
    // เทียบจากลูกค้า+จำนวนกล่อง (ออร์เดอร์ของลูกค้าคนเดียวกันสลับกันถือว่าแผนเดียวกัน)
    .map((g) => g.map((o) => `${o.customer_id}x${o.quantity_boxes}`).sort().join(","))
    .sort()
    .join("|");

/** เปลี่ยนนาทีนับจาก 11:30 เป็นเวลา HH:MM */
function clock(minFromStart: number): string {
  const [h, m] = RULES.DELIVERY_START.split(":").map(Number) as [number, number];
  const total = h * 60 + m + Math.ceil(minFromStart);
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}
const deadlineMin = (() => {
  const [h1, m1] = RULES.DELIVERY_START.split(":").map(Number) as [number, number];
  const [h2, m2] = RULES.DELIVERY_DEADLINE.split(":").map(Number) as [number, number];
  return h2 * 60 + m2 - (h1 * 60 + m1);
})();

/** สร้างรายละเอียดแผน: เส้นทางแต่ละไรเดอร์ เวลา และเงิน */
function describePlan(groups: DispatchOrder[][], riders: Rider[], roads?: RoadRoute[]) {
  const routes = groups.map((stops, idx) => {
    const rider = riders[idx]!;
    let km = 0;
    let elapsed = 0;
    let prev: { latitude: number; longitude: number } = shopPt;
    const stopRows = stops.map((o, k) => {
      const segment = roads ? roads[idx]!.legs[k]! : matrix.leg(prev, o);
      const leg = segment.distance / 1000;
      km += leg;
      elapsed += segment.duration / 60;
      prev = o;
      const min = elapsed;
      return {
        seq: k + 1,
        order_id: o.order_id,
        boxes: o.quantity_boxes,
        customer: {
          customer_id: o.customer_id,
          name: `${o.first_name} ${o.last_name}`,
          phone: o.phone,
          address: o.address,
          latitude: o.latitude,
          longitude: o.longitude,
        },
        leg_km: round(leg),
        cumulative_km: round(km),
        eta: clock(min),
        on_time: min <= deadlineMin,
      };
    });
    const boxes = stops.reduce((s, o) => s + o.quantity_boxes, 0);
    const timeMin = elapsed;
    const revenue = boxes * RULES.BOX_PRICE;
    const foodCost = boxes * RULES.BOX_COST;
    const fee = RULES.RIDER_CALL_FEE + RULES.RATE_PER_KM_BOX * km * boxes;
    return {
      rider: { rider_id: rider.rider_id, name: rider.name, phone: rider.phone, color: rider.color },
      orders: stops.length,
      boxes,
      distance_km: round(km),
      time_min: round(timeMin, 1),
      duration_seconds: elapsed * 60,
      finish_time: clock(timeMin),
      on_time: timeMin <= deadlineMin,
      money: {
        revenue,
        food_cost: foodCost,
        rider_call_fee: RULES.RIDER_CALL_FEE,
        rider_distance_fee: round(RULES.RATE_PER_KM_BOX * km * boxes),
        rider_fee_total: round(fee),
        profit: round(revenue - foodCost - fee),
      },
      stops: stopRows,
      // แนวถนนจาก OSRM เป็น [lat, lng] สำหรับ Leaflet
      path: roads ? roads[idx]!.path : [] as [number, number][],
      routing_source: "osrm" as const,
    };
  });
  const sum = (f: (r: (typeof routes)[number]) => number) => round(routes.reduce((s, r) => s + f(r), 0));
  const profit = sum((r) => r.money.profit);
  const maxTime = Math.max(0, ...routes.map((r) => r.duration_seconds / 60));
  return {
    summary: {
      riders_used: routes.length,
      orders: sum((r) => r.orders),
      boxes: sum((r) => r.boxes),
      total_distance_km: sum((r) => r.distance_km),
      revenue: sum((r) => r.money.revenue),
      food_cost: sum((r) => r.money.food_cost),
      rider_fee: sum((r) => r.money.rider_fee_total),
      profit,
      result: profit >= 0 ? "กำไร" : "ขาดทุน",
      start_time: RULES.DELIVERY_START,
      deadline: RULES.DELIVERY_DEADLINE,
      longest_route_min: round(maxTime, 1),
      all_delivered_by: clock(maxTime),
      all_on_time: routes.every((r) => r.on_time),
    },
    routes,
  };
}

const longestMin = (groups: DispatchOrder[][]) =>
  Math.max(0, ...groups.map(g => {
    let previous = shopPt;
    let minutes = 0;
    for (const stop of g) { minutes += matrix.leg(previous, stop).duration / 60; previous = stop; }
    return minutes;
  }));

/**
 * คำนวณหลายแผนจาก seed เดียวกัน (seed เดิม = ได้แผนเดิม)
 * สร้างแผนผู้สมัครหลายแบบ (sweep เริ่มมุมสุ่ม ขนาดกลุ่ม 2-3 ทั้งแบบปรับปรุงและไม่ปรับปรุง)
 * แล้วเลือกแผนที่ต่างกันจริงมาเสนอ: ประหยัดที่สุด, ส่งเสร็จเร็วที่สุด, ใช้ไรเดอร์น้อยที่สุด, ตามด้วยแผนถูกรองลงมา
 */
function buildPlans(orders: DispatchOrder[], riders: Rider[], seed: number, count: number) {
  bestCache.clear();
  feeCache.clear();
  const rand = rng(seed);
  const maxGroups = riders.length;
  const minGroups = Math.ceil(orders.length / RULES.MAX_ORDERS_PER_RIDER);
  if (minGroups > maxGroups) return { error: `ต้องใช้ไรเดอร์อย่างน้อย ${minGroups} คน แต่มีแค่ ${maxGroups} คน` } as const;

  const pool = new Map<string, DispatchOrder[][]>();
  const add = (g: DispatchOrder[][]) => {
    const sig = signature(g);
    if (!pool.has(sig)) pool.set(sig, g);
  };
  for (let t = 0; t < 60; t++) {
    const size = rand() < 0.6 ? 3 : 2;
    let groups = sweep(orders, rand() * 2 * Math.PI, size);
    if (groups.length > maxGroups) groups = sweep(orders, rand() * 2 * Math.PI, 3);
    add(groups.map((g) => bestOrder(g))); // แบบตรง ๆ (ไม่ปรับปรุง)
    add(improve(groups, maxGroups)); // แบบปรับปรุงให้ค่าไรเดอร์ต่ำลง
  }
  const all = [...pool.values()];
  const byCost = [...all].sort((a, b) => planCost(a) - planCost(b));
  const picks: { label: string; groups: DispatchOrder[][] }[] = [];
  const used = new Set<string>();
  const pick = (label: string, list: DispatchOrder[][][]) => {
    const g = list.find((x) => !used.has(signature(x)));
    if (g && picks.length < count) {
      used.add(signature(g));
      picks.push({ label, groups: g });
    }
  };
  pick("แผนแนะนำตามระยะทางถนน", byCost);
  pick("ส่งเสร็จเร็วที่สุด", [...all].sort((a, b) => longestMin(a) - longestMin(b) || planCost(a) - planCost(b)));
  pick("ใช้ไรเดอร์น้อยที่สุด", [...all].sort((a, b) => a.length - b.length || planCost(a) - planCost(b)));
  while (picks.length < count && picks.length < all.length) pick("ทางเลือกอื่น (ประหยัดรองลงมา)", byCost);

  return {
    plans: picks.map((p, i) => ({ plan_no: i + 1, label: p.label, ...describePlan(p.groups, riders) })),
  } as const;
}

return { buildPlans, describePlan };
}

/** ลายเซ็นของชุดออร์เดอร์ ใช้ตรวจว่าออร์เดอร์เปลี่ยนไปหรือยังก่อนยืนยันแผน */
export const ordersSignature = (orders: DispatchOrder[]) =>
  orders
    .map((o) => JSON.stringify([o.order_id, o.customer_id, o.quantity_boxes, o.latitude, o.longitude, o.first_name, o.last_name, o.phone, o.address]))
    .sort()
    .join(",");
