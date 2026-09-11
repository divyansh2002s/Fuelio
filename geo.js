// Distances are statute miles. Geographic radius is measured to route segments,
// not just sampled vertices; fuel travel uses routed miles separately.
const RAD = Math.PI / 180,
  R = 3958.7613;
export function haversine(a, b) {
  const p = a.lat * RAD,
    q = b.lat * RAD,
    dp = q - p,
    dl = (b.lng - a.lng) * RAD;
  return (
    2 *
    R *
    Math.asin(
      Math.min(
        1,
        Math.sqrt(
          Math.sin(dp / 2) ** 2 +
            Math.cos(p) * Math.cos(q) * Math.sin(dl / 2) ** 2,
        ),
      ),
    )
  );
}
function bearing(a, b) {
  const p = a.lat * RAD,
    q = b.lat * RAD,
    l = (b.lng - a.lng) * RAD;
  return Math.atan2(
    Math.sin(l) * Math.cos(q),
    Math.cos(p) * Math.sin(q) - Math.sin(p) * Math.cos(q) * Math.cos(l),
  );
}
function move(a, theta, miles) {
  const d = miles / R,
    p = a.lat * RAD,
    l = a.lng * RAD;
  const q = Math.asin(
    Math.sin(p) * Math.cos(d) + Math.cos(p) * Math.sin(d) * Math.cos(theta),
  );
  return {
    lat: q / RAD,
    lng:
      (((l +
        Math.atan2(
          Math.sin(theta) * Math.sin(d) * Math.cos(p),
          Math.cos(d) - Math.sin(p) * Math.sin(q),
        )) /
        RAD +
        540) %
        360) -
      180,
  };
}
export function segmentProjection(point, a, b) {
  const length = haversine(a, b);
  if (length < 1e-9)
    return { ...a, distance: haversine(point, a), fraction: 0 };
  const d = haversine(a, point) / R,
    delta = bearing(a, point) - bearing(a, b);
  const along = Math.atan2(Math.sin(d) * Math.cos(delta), Math.cos(d)) * R;
  const fraction = Math.max(0, Math.min(1, along / length));
  const p = move(a, bearing(a, b), fraction * length);
  return { ...p, fraction, distance: haversine(p, point) };
}
export function prepareRoute(route) {
  const points = route.coordinates.map((p) =>
    Array.isArray(p) ? { lng: p[0], lat: p[1] } : p,
  );
  if (points.length < 2)
    throw new Error("A road route needs at least two coordinates.");
  const cumulative = [0];
  for (let i = 1; i < points.length; i++)
    cumulative.push(cumulative.at(-1) + haversine(points[i - 1], points[i]));
  const distance = route.distance ?? cumulative.at(-1);
  if (!(distance > 0)) throw new Error("Route distance must be positive.");
  const scale = distance / cumulative.at(-1);
  return {
    ...route,
    distance,
    points,
    cumulative: cumulative.map((n) => n * scale),
  };
}
export function routeCandidates(route, pumps, radius = 1) {
  const out = [];
  for (const pump of pumps) {
    let run = null,
      lastInside = -2,
      visits = [];
    for (let i = 0; i < route.points.length - 1; i++) {
      const a = route.points[i],
        b = route.points[i + 1];
      const pad = radius / 69.0 + 0.001;
      if (
        pump.lat < Math.min(a.lat, b.lat) - pad ||
        pump.lat > Math.max(a.lat, b.lat) + pad
      )
        continue;
      const hit = segmentProjection(pump, a, b);
      if (hit.distance > radius + 1e-7) continue;
      const mile =
        route.cumulative[i] +
        hit.fraction * (route.cumulative[i + 1] - route.cumulative[i]);
      if (run && i > lastInside + 1 && mile - run.lastMile > 2 * radius + 0.5) {
        visits.push(run);
        run = null;
      }
      if (!run) run = { ...hit, mile, lastMile: mile };
      else {
        if (hit.distance < run.distance) run = { ...hit, mile, lastMile: mile };
        else run.lastMile = mile;
      }
      lastInside = i;
    }
    if (run) visits.push(run);
    visits.forEach((hit, k) =>
      out.push({
        ...pump,
        id: `${pump.id}@visit${k}`,
        pumpId: pump.id,
        mile: hit.mile,
        offset: hit.distance,
        projection: { lat: hit.lat, lng: hit.lng },
      }),
    );
  }
  return out.sort((a, b) => a.mile - b.mile || a.price - b.price);
}
export function pointAtMile(route, mile) {
  let i = 1;
  while (i < route.cumulative.length - 1 && route.cumulative[i] < mile) i++;
  const a = route.points[i - 1],
    b = route.points[i],
    len = route.cumulative[i] - route.cumulative[i - 1];
  return move(
    a,
    bearing(a, b),
    haversine(a, b) *
      (len
        ? Math.max(0, Math.min(1, (mile - route.cumulative[i - 1]) / len))
        : 0),
  );
}
export function insidePolygon(point, geometry) {
  const ringHas = (ring) => {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i],
        [xj, yj] = ring[j];
      if (
        yi > point.lat !== yj > point.lat &&
        point.lng < ((xj - xi) * (point.lat - yi)) / (yj - yi) + xi
      )
        inside = !inside;
    }
    return inside;
  };
  const polygons =
    geometry.type === "MultiPolygon"
      ? geometry.coordinates
      : [geometry.coordinates];
  return polygons.some(
    (rings) => ringHas(rings[0]) && !rings.slice(1).some(ringHas),
  );
}
export function californiaEntry(route, geometry) {
  if (insidePolygon(route.points[0], geometry)) return null;
  for (let i = 1; i < route.points.length; i++) {
    if (insidePolygon(route.points[i], geometry)) {
      let lo = route.cumulative[i - 1],
        hi = route.cumulative[i];
      for (let n = 0; n < 22; n++) {
        const mid = (lo + hi) / 2;
        if (insidePolygon(pointAtMile(route, mid), geometry)) hi = mid;
        else lo = mid;
      }
      return hi;
    }
  }
  return null;
}
export function parseCoordinates(text) {
  const m = String(text)
    .trim()
    .match(/^([+-]?\d+(?:\.\d+)?)\s*,\s*([+-]?\d+(?:\.\d+)?)$/);
  if (!m) return null;
  const lat = Number(m[1]),
    lng = Number(m[2]);
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180)
    throw new Error("Latitude or longitude is outside its valid range.");
  return { lat, lng, label: `${lat}, ${lng}` };
}
