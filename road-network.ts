import "dotenv/config";

export type Point = { latitude: number; longitude: number };
export type Leg = { distance: number; duration: number }; // metres, seconds
export type RoadRoute = { legs: Leg[]; path: [number, number][] };
export type RoadMatrix = { leg: (from: Point, to: Point) => Leg };
export class RoadError extends Error {
  status = 503;
}
const base = (process.env.OSRM_URL || "https://router.project-osrm.org").replace(/\/$/, "");
const profile = process.env.OSRM_PROFILE || "driving";
const key = (p: Point) => `${p.longitude},${p.latitude}`;
const cache = new Map<string, { expires: number; value: unknown }>();
const inFlight = new Map<string, Promise<any>>();
let queue: Promise<unknown> = Promise.resolve();
let lastStarted = 0;

// A shared queue respects the public demo's 1 request/second limit across API requests.
async function request(path: string): Promise<any> {
  const url = `${base}/${path}`;
  const hit = cache.get(url);
  if (hit && hit.expires > Date.now()) return hit.value;
  const running = inFlight.get(url);
  if (running) return running;
  const task = queue.then(async () => {
    const wait = Math.max(0, 1100 - (Date.now() - lastStarted));
    if (wait) await new Promise(resolve => setTimeout(resolve, wait));
    lastStarted = Date.now();
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw new Error(`OSRM HTTP ${response.status}`);
      const data: any = await response.json();
      if (data.code !== "Ok") throw new Error(`OSRM ${data.code}`);
      if (cache.size >= 200) cache.delete(cache.keys().next().value!);
      cache.set(url, { expires: Date.now() + 15 * 60_000, value: data });
      return data;
    } catch {
      throw new RoadError("บริการเส้นทางถนนไม่พร้อม หรือไม่พบถนนถึงพิกัด กรุณาตรวจพิกัดแล้วลองใหม่");
    }
  });
  queue = task.catch(() => undefined);
  inFlight.set(url, task);
  try { return await task; } finally { inFlight.delete(url); }
}

function coordinates(points: Point[]) {
  if (!points.length || points.some(p => !Number.isFinite(p.latitude) || !Number.isFinite(p.longitude)
    || Math.abs(p.latitude) > 90 || Math.abs(p.longitude) > 180)) throw new RoadError("พิกัดจัดส่งไม่ถูกต้อง");
  return points.map(key).join(";");
}
function validMetric(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export async function loadRoadMatrix(points: Point[]): Promise<RoadMatrix> {
  const unique = [...new Map(points.map(p => [key(p), p])).values()];
  if (unique.length > 100) throw new RoadError("รองรับจุดจัดส่งไม่เกิน 99 ตำแหน่งต่อรอบ");
  const data = await request(`table/v1/${encodeURIComponent(profile)}/${coordinates(unique)}?annotations=distance,duration&radiuses=${unique.map(() => 200).join(";")}`);
  const indexes = new Map(unique.map((p, i) => [key(p), i]));
  for (let i = 0; i < unique.length; i++) for (let j = 0; j < unique.length; j++) {
    if (!validMetric(data.distances?.[i]?.[j]) || !validMetric(data.durations?.[i]?.[j]))
      throw new RoadError("มีจุดจัดส่งที่ถนนเชื่อมถึงกันไม่ได้ กรุณาตรวจพิกัดลูกค้า");
  }
  return { leg(from, to) {
    const i = indexes.get(key(from)), j = indexes.get(key(to));
    if (i === undefined || j === undefined) throw new RoadError("ไม่พบพิกัดในตารางเส้นทาง");
    return { distance: data.distances[i][j], duration: data.durations[i][j] };
  }};
}

export async function loadRoadRoute(points: Point[]): Promise<RoadRoute> {
  const data = await request(`route/v1/${encodeURIComponent(profile)}/${coordinates(points)}?overview=full&geometries=geojson&steps=false&continue_straight=false&radiuses=${points.map(() => 200).join(";")}`);
  const route = data.routes?.[0];
  if (!route || route.legs?.length !== points.length - 1 || !Array.isArray(route.geometry?.coordinates)
    || route.geometry.coordinates.length < 2 || route.legs.some((l: Leg) => !validMetric(l.distance) || !validMetric(l.duration))
    || route.geometry.coordinates.some((p: any) => !Array.isArray(p) || p.length < 2
      || !Number.isFinite(p[0]) || !Number.isFinite(p[1]) || Math.abs(p[0]) > 180 || Math.abs(p[1]) > 90))
    throw new RoadError("บริการเส้นทางส่งข้อมูลไม่ครบ กรุณาคำนวณใหม่");
  return {
    legs: route.legs.map((l: Leg) => ({ distance: l.distance, duration: l.duration })),
    path: route.geometry.coordinates.map(([lng, lat]: [number, number]) => [lat, lng]),
  };
}
