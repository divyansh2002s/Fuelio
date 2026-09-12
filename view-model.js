// Presentation-only helpers. Never alter the source rows or optimiser inputs.
import { clean, number } from "./data.js";

export function stopNumber(stop) {
  return clean(stop?.store) || clean(stop?.name).match(/(?:#|[A-Z]{2}|\b)(\d+)\s*$/i)?.[1] || "";
}
export function activeVehicles(vehicles) {
  return vehicles.filter((v) => !/deactivat/i.test(v.name || ""));
}
const normal = (value) => clean(value).toLowerCase().replace(/[.,]/g, " ").replace(/\s+/g, " ").trim();
function alias(value) {
  return normal(value)
    .replace(/\bmt\b/g, "mount").replace(/\bst\b/g, "saint")
    .replace(/\bn\b/g, "north").replace(/\bs\b/g, "south")
    .replace(/\be\b/g, "east").replace(/\bw\b/g, "west")
    .replace(/\b(?:mc|mac)\s*([a-z])/g, "mc$1");
}
export function searchStops(rows, { query = "", state = "", highways = new Set(), sort = "master" } = {}) {
  const q = normal(query), aq = alias(query);
  const matched = rows.map((row, index) => ({ row, index })).filter(({ row: p }) => {
    if (state && p.state !== state) return false;
    if (highways.size && !(p.highways || []).some((hw) => highways.has(hw))) return false;
    if (!q) return true;
    const raw = [p.name, stopNumber(p), p.city, p.state, p.location, p.highway, p.exit, p.price, number(p.price) === null ? "" : `$${Number(p.price).toFixed(4)}`].join(" ");
    // Normal matching is retained; aliases add matches, never state-name expansion.
    return normal(raw).includes(q) || alias(raw).includes(aq);
  });
  const rank = (p) => q && /^\d+$/.test(q) && stopNumber(p).replace(/^0+(?=\d)/, "") === q.replace(/^0+(?=\d)/, "") ? 0 : 1;
  matched.sort((a, b) => {
    if (sort === "high") return b.row.price - a.row.price || a.index - b.index;
    if (sort === "low") return a.row.price - b.row.price || a.index - b.index;
    return rank(a.row) - rank(b.row) || a.index - b.index;
  });
  return matched.map(({ row }) => row);
}
export function stopMapRows(all, filtered, highways) {
  return highways.size ? filtered : all;
}
export function headingDegrees(value) {
  const n = number(value);
  return n === null ? 0 : ((n % 360) + 360) % 360;
}
export function mergeVehicleDetail(vehicle, detail) {
  const result = { ...vehicle };
  if (number(detail?.mpg) !== null) {
    result.mpg = detail.mpg;
    result.mpgSource = detail.mpgSource;
  }
  // A snapshot always wins. History is used only when Samsara supplies no fuel.
  if (number(result.fuelPercent) === null && number(detail?.historyFuel?.value) !== null) {
    result.fuelPercent = detail.historyFuel.value;
    result.fuelTime = detail.historyFuel.time;
    result.fuelSource = "history";
  }
  return result;
}
export function routeHighways(route) {
  // No origin/destination or guessed highway when no highway is supplied.
  const summary = clean(route?.summary);
  return [...new Set(summary.match(/\b(?:I|US|SR|CA|TX|AZ|NM|OK|IL|IN|OH|PA|NY|NJ|FL)[ -]?\d+[A-Z]?\b/gi) || [])].join(" / ");
}
export function vehicleIconHTML(vehicle, kind, selected = false) {
  return `<span class="vehicle-pin ${kind} ${selected ? "selected" : ""}"><span class="vehicle-heading" style="transform:rotate(${headingDegrees(vehicle.heading)}deg)"><img src="/${kind === "rocket" ? "vehicle-rocket" : "vehicle-ufo"}.svg" alt="" draggable="false"></span></span>`;
}
