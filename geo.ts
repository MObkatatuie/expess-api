const R = 6371; // รัศมีโลก (กม.)
const toRad = (d: number) => (d * Math.PI) / 180;

/** ระยะทาง (กม.) ระหว่างสองพิกัด ด้วยสูตร Haversine */
export function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** กรอบสี่เหลี่ยมคร่าว ๆ ไว้กรองใน SQL ก่อนคำนวณจริง */
export function boundingBox(lat: number, lng: number, km: number) {
  const dLat = (km / R) * (180 / Math.PI);
  const dLng = dLat / Math.max(0.01, Math.cos(toRad(lat)));
  return { minLat: lat - dLat, maxLat: lat + dLat, minLng: lng - dLng, maxLng: lng + dLng };
}

export function parseCoord(latRaw: unknown, lngRaw: unknown): { lat: number; lng: number } | null {
  const lat = Number(latRaw);
  const lng = Number(lngRaw);
  if (latRaw === undefined || lngRaw === undefined || latRaw === "" || lngRaw === "") return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return { lat, lng };
}
