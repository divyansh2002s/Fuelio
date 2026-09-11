import { tableRecords, number, clean } from "./data.js";
import { haversine } from "./geo.js";
export function parseLoads(table) {
  const records = tableRecords(table);
  return records.map((r, i) => {
    const get = (...keys) => keys.map((k) => r[k]).find((v) => clean(v) !== "");
    const pickup = {
      lat: number(get("pickuplatitude", "originlatitude", "pickuplat")),
      lng: number(
        get("pickuplongitude", "originlongitude", "pickuplng", "pickuplon"),
      ),
      label: clean(get("pickupcity", "origincity", "pickup")),
    };
    const delivery = {
      lat: number(
        get("deliverylatitude", "destinationlatitude", "deliverylat"),
      ),
      lng: number(
        get(
          "deliverylongitude",
          "destinationlongitude",
          "deliverylng",
          "deliverylon",
        ),
      ),
      label: clean(get("deliverycity", "destinationcity", "delivery")),
    };
    for (const p of [pickup, delivery])
      if (
        p.lat === null ||
        p.lng === null ||
        Math.abs(p.lat) > 90 ||
        Math.abs(p.lng) > 180
      )
        throw new Error(
          `Load row ${i + 2} has invalid pickup or delivery coordinates.`,
        );
    const overrides = {};
    for (const [key, col] of [
      ["startFuel", "startingfuel"],
      ["capacity", "tankcapacity"],
      ["mpg", "mpg"],
      ["endFuel", "endingfuel"],
    ]) {
      const v = number(r[col]);
      if (v !== null) overrides[key] = v;
    }
    return {
      id: clean(get("loadid", "tripid", "id")) || `Load ${i + 1}`,
      pickup,
      delivery,
      overrides,
      status: "Imported",
      matches: [],
    };
  });
}
/** DBSCAN with min_samples=1, equivalent to connected components of radius links.
 * Clusters are descriptive. Lane eligibility ALWAYS uses each actual endpoint,
 * preventing a long chain of cities from admitting a distant load by its cluster.
 */
export function clusterCities(points, radius = 50) {
  if (!(radius > 0 && Number.isFinite(radius)))
    throw new Error("Cluster radius must be positive.");
  const unique = [],
    lookup = new Map(),
    original = [];
  for (const point of points) {
    const key = `${point.lat},${point.lng}`;
    if (!lookup.has(key)) {
      lookup.set(key, unique.length);
      unique.push(point);
    }
    original.push(lookup.get(key));
  }
  const parent = unique.map((_, i) => i),
    find = (i) => {
      while (parent[i] !== i) {
        parent[i] = parent[parent[i]];
        i = parent[i];
      }
      return i;
    };
  const latitudeCell = radius / 69.0,
    maxLatitude = unique.reduce((a, p) => Math.max(a, Math.abs(p.lat)), 0);
  const longitudeCell =
    radius /
    (69.0 *
      Math.max(
        0.005,
        Math.cos((Math.min(89.7, maxLatitude + latitudeCell) * Math.PI) / 180),
      ));
  const columns = Math.max(1, Math.floor(360 / longitudeCell)),
    width = 360 / columns,
    grid = new Map();
  for (let i = 0; i < unique.length; i++) {
    const p = unique[i],
      row = Math.floor((p.lat + 90) / latitudeCell),
      col = Math.floor((p.lng + 180) / width) % columns;
    for (let dr = -1; dr <= 1; dr++)
      for (const dc of new Set(
        [-1, 0, 1].map((d) => (col + d + columns) % columns),
      )) {
        for (const j of grid.get(`${row + dr}:${dc}`) || []) {
          if (find(i) !== find(j) && haversine(p, unique[j]) <= radius) {
            parent[find(i)] = find(j);
          }
        }
      }
    const key = `${row}:${col}`;
    if (!grid.has(key)) grid.set(key, []);
    grid.get(key).push(i);
  }
  const ids = new Map();
  return points.map((p, i) => {
    const root = find(original[i]);
    if (!ids.has(root)) ids.set(root, ids.size + 1);
    return { ...p, cluster: ids.get(root) };
  });
}

export function prepareLoads(loads, lanes, radius = 50) {
  const clustered = clusterCities(
    loads.flatMap((l) => [l.pickup, l.delivery]),
    radius,
  );
  return loads.map((load, i) => {
    const matches = lanes
      .filter(
        (l) =>
          l.points?.length >= 2 &&
          haversine(load.pickup, l.points[0]) <= radius &&
          haversine(load.delivery, l.points.at(-1)) <= radius,
      )
      .map((l) => ({
        id: l.id,
        name: l.name,
        distance:
          haversine(load.pickup, l.points[0]) +
          haversine(load.delivery, l.points.at(-1)),
      }))
      .sort((a, b) => a.distance - b.distance);
    return {
      ...load,
      pickupCluster: clustered[i * 2].cluster,
      deliveryCluster: clustered[i * 2 + 1].cluster,
      matches,
      status: matches.length ? "Eligible" : "No matching lane",
    };
  });
}
