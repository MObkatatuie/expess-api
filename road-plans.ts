import { randomUUID } from "node:crypto";
import { CENTER, RULES } from "./db";
import { createPlanner, ordersSignature, type DispatchOrder, type Rider } from "./routing";
import { loadRoadMatrix, loadRoadRoute, type RoadRoute } from "./road-network";

const shop = { latitude: CENTER.lat, longitude: CENTER.lng };
const formatter = createPlanner({ leg() { throw new Error("Road legs required"); } });
export type Plan = ReturnType<typeof formatter.describePlan>;
export type Snapshot = { signature: string; road: RoadRoute };
const routeSignature = (stops: DispatchOrder[]) => JSON.stringify([CENTER, stops.map(s => [s.order_id, s.latitude, s.longitude])]);

export async function describeRoadPlan(groups: DispatchOrder[][], riders: Rider[], saved: unknown[] = []) {
  const snapshots: Snapshot[] = [];
  for (const [i, stops] of groups.entries()) {
    let previous: Snapshot | undefined;
    try { previous = typeof saved[i] === "string" ? JSON.parse(saved[i] as string) : saved[i] as Snapshot; } catch { /* legacy data */ }
    const signature = routeSignature(stops);
    const road = previous?.signature === signature && previous.road?.legs?.length === stops.length
      && previous.road.path?.length >= 2 ? previous.road : await loadRoadRoute([shop, ...stops]);
    snapshots.push({ signature, road });
  }
  return { ...formatter.describePlan(groups, riders, snapshots.map(s => s.road)), snapshots };
}

export async function buildRoadPlans(orders: DispatchOrder[], riders: Rider[], seed: number, count: number) {
  const required = Math.ceil(orders.length / RULES.MAX_ORDERS_PER_RIDER);
  if (!orders.length) return { error: "ไม่มีออร์เดอร์ที่รอจัดส่ง" } as const;
  if (required > riders.length) return { error: `ต้องใช้ไรเดอร์อย่างน้อย ${required} คน แต่มีแค่ ${riders.length} คน` } as const;
  const matrix = await loadRoadMatrix([shop, ...orders]);
  const candidates = createPlanner(matrix).buildPlans(orders, riders, seed, count);
  if ("error" in candidates) return { error: candidates.error } as const;
  const byId = new Map(orders.map(o => [o.order_id, o]));
  const plans = [];
  for (const candidate of candidates.plans) {
    const groups = candidate.routes.map(r => r.stops.map(s => byId.get(s.order_id)!));
    const detailed = await describeRoadPlan(groups, candidate.routes.map(r => r.rider));
    plans.push({ plan_no: candidate.plan_no, label: candidate.label, ...detailed });
  }
  return { plans } as const;
}

// Drafts preserve the exact preview; confirmation never re-queries the routing provider.
type Draft = { plan: Plan & { snapshots: Snapshot[] }; signature: string; expires: number };
const drafts = new Map<string, Draft>();
export const draftSignature = (orders: DispatchOrder[], riders: Rider[]) =>
  JSON.stringify([ordersSignature(orders), riders, CENTER, RULES]);
export function saveDraft(plan: Draft["plan"], signature: string) {
  for (const [token, draft] of drafts) if (draft.expires <= Date.now()) drafts.delete(token);
  if (drafts.size >= 100) drafts.delete(drafts.keys().next().value!);
  const token = randomUUID();
  drafts.set(token, { plan, signature, expires: Date.now() + 15 * 60_000 });
  return token;
}
export function getDraft(token: string) {
  const draft = drafts.get(token);
  if (draft && draft.expires > Date.now()) return draft;
  drafts.delete(token);
  return undefined;
}
export function deleteDraft(token: string) { drafts.delete(token); }
