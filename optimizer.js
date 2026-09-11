/**
 * Exact resource-constrained shortest path for a fixed route and fixed fill target.
 * PurFCO fuel balance / purchase-cost objective, specialised to Full / Half Tank.
 * After buying fuel, departure fuel is always Q. Thus (last station, stop count,
 * pre-CA-stop flag) is a sufficient state. All forward edges are examined: no
 * greedy pruning, rounded fuel grid, candidate cap, or relaxed reserve.
 * Optimality is for the supplied routes, stations, road-spur distances, MPG and
 * rules, not for unprovided roads/prices or uncertain real-world consumption.
 */
export const EPS = 1e-7;
const finite = (v) => typeof v === "number" && Number.isFinite(v);
function required(v, label, min = 0, max = Infinity) {
  if (!finite(v) || v < min || v > max)
    throw new Error(
      `${label} must be between ${min} and ${max === Infinity ? "a finite positive value" : max}.`,
    );
  return v;
}
export function validateRules(input) {
  const r = {
    mode: "buffer",
    fill: "full",
    windowLower: 10,
    windowUpper: 5,
    endTolerance: null,
    caEntryMile: null,
    rescue: false,
    ...input,
  };
  required(r.capacity, "Tank capacity", 0.01, 5000);
  required(r.mpg, "MPG", 0.01, 100);
  required(r.startFuel, "Starting fuel", 0, r.capacity);
  required(r.reserve, "Buffer fuel", 0, r.capacity);
  required(r.endFuel, "Ending fuel target", 0, r.capacity);
  required(r.maxStops, "Maximum stops", 0, 1000);
  if (!Number.isInteger(r.maxStops))
    throw new Error("Maximum stops must be a whole number.");
  if (!["full", "half"].includes(r.fill))
    throw new Error("Choose Full Tank or Half Tank.");
  if (!["buffer", "strict", "before_ca"].includes(r.mode))
    throw new Error("Unknown planning rule.");
  required(r.windowLower, "Lower window offset", 0, r.capacity);
  required(r.windowUpper, "Upper window offset", 0, r.capacity);
  if (r.endTolerance !== null && r.endTolerance !== "")
    required(r.endTolerance, "Ending tolerance", 0, r.capacity);
  else r.endTolerance = null;
  r.target = r.capacity * (r.fill === "half" ? 0.5 : 1);
  // Strict mode's lower window edge is its minimum reserve, as in FCO.
  r.hardReserve =
    r.mode === "strict"
      ? Math.max(0, r.reserve - r.windowLower)
      : r.mode === "before_ca"
        ? 35
        : r.reserve;
  if (r.mode === "before_ca" && !finite(r.caEntryMile))
    throw new Error(
      "Before California needs a route that enters California from outside.",
    );
  return r;
}
function arrivalAllowed(arrival, r, rescue = false) {
  if (arrival < r.hardReserve - EPS) return false;
  if (rescue || r.mode === "buffer") return true;
  if (r.mode === "before_ca") return arrival <= 55 + EPS;
  return arrival <= r.reserve + r.windowUpper + EPS;
}
function normaliseStations(stations, distance) {
  const seen = new Map();
  for (const raw of stations) {
    const s = { ...raw };
    for (const key of ["mile", "price", "inMiles", "outMiles"])
      required(s[key], `Station ${s.name || s.id}: ${key}`, 0);
    if (s.price <= 0)
      throw new Error(`Station ${s.name || s.id} has an invalid price.`);
    if (s.mile > distance + EPS)
      throw new Error("A station lies beyond the destination.");
    if (!s.id) throw new Error("Every station needs a unique identifier.");
    const key = `${s.id}@${s.mile.toFixed(7)}`;
    if (seen.has(key)) {
      const old = seen.get(key);
      if (
        Math.abs(old.price - s.price) > EPS ||
        Math.abs(old.inMiles - s.inMiles) > EPS ||
        Math.abs(old.outMiles - s.outMiles) > EPS
      )
        throw new Error(
          `Conflicting records for ${s.name || s.id}. Fix the source data first.`,
        );
    } else seen.set(key, s);
  }
  return [...seen.values()].sort(
    (a, b) => a.mile - b.mile || String(a.id).localeCompare(String(b.id)),
  );
}
function run(distance, stations, r, rescue = false) {
  const n = stations.length,
    max = Math.min(r.maxStops, n);
  const layers = Array.from({ length: max + 1 }, () => new Map());
  layers[0].set("-1:0", {
    index: -1,
    cost: 0,
    prev: null,
    ca: false,
    fuel: r.startFuel,
    stops: 0,
    miles: 0,
  });
  let best = null;
  for (let k = 0; k <= max; k++) {
    for (const state of layers[k].values()) {
      const prev = state.index < 0 ? null : stations[state.index];
      const baseMile = prev?.mile ?? 0;
      const afterSpur = prev?.outMiles ?? 0;
      if (state.fuel - afterSpur / r.mpg < r.hardReserve - EPS) continue;
      const endLeg = distance - baseMile + afterSpur;
      const endFuel = state.fuel - endLeg / r.mpg;
      const endMin = Math.max(r.endFuel, r.hardReserve);
      const endMax =
        r.endTolerance === null
          ? r.capacity
          : Math.min(r.capacity, r.endFuel + r.endTolerance);
      if (
        endFuel >= endMin - EPS &&
        endFuel <= endMax + EPS &&
        (r.mode !== "before_ca" || state.ca)
      ) {
        const finished = {
          ...state,
          endFuel,
          endLeg,
          totalMiles: state.miles + endLeg,
        };
        if (
          !best ||
          finished.cost < best.cost - EPS ||
          (Math.abs(finished.cost - best.cost) <= EPS &&
            (k < best.stops ||
              (k === best.stops && finished.totalMiles < best.totalMiles)))
        )
          best = finished;
      }
      if (k === max) continue;
      for (let j = state.index + 1; j < n; j++) {
        const s = stations[j];
        // At equal route progress pumps are alternatives, not artificial fuel loops.
        if (prev && s.mile <= prev.mile + EPS) continue;
        if (
          r.mode === "before_ca" &&
          (s.mile >= r.caEntryMile - EPS || s.state === "CA")
        )
          continue;
        const leg = s.mile - baseMile + afterSpur + s.inMiles;
        const arrival = state.fuel - leg / r.mpg;
        const purchase = r.target - arrival;
        if (
          !arrivalAllowed(arrival, r, rescue) ||
          purchase <= EPS ||
          purchase > r.capacity - arrival + EPS
        )
          continue;
        if (r.target - s.outMiles / r.mpg < r.hardReserve - EPS) continue;
        const ca =
          state.ca ||
          (r.mode === "before_ca" &&
            s.mile < r.caEntryMile &&
            s.state !== "CA");
        const next = {
          index: j,
          cost: state.cost + purchase * s.price,
          prev: state,
          ca,
          fuel: r.target,
          arrival,
          purchase,
          leg,
          stops: k + 1,
          miles: state.miles + leg,
        };
        const key = `${j}:${ca ? 1 : 0}`;
        const old = layers[k + 1].get(key);
        if (
          !old ||
          next.cost < old.cost - EPS ||
          (Math.abs(next.cost - old.cost) <= EPS && next.miles < old.miles)
        )
          layers[k + 1].set(key, next);
      }
    }
  }
  if (!best) return null;
  const path = [];
  for (let cursor = best; cursor.index >= 0; cursor = cursor.prev) {
    const s = stations[cursor.index];
    path.unshift({
      ...s,
      arrival: cursor.arrival,
      gallons: cursor.purchase,
      departure: r.target,
      cost: cursor.purchase * s.price,
      legMiles: cursor.leg,
      tripMile: cursor.miles,
    });
  }
  return {
    status: "optimal",
    cost: best.cost,
    gallons: path.reduce((s, p) => s + p.gallons, 0),
    stops: path,
    endFuel: best.endFuel,
    totalMiles: best.totalMiles,
    routeMiles: distance,
    detourMiles: best.totalMiles - distance,
    burned: best.totalMiles / r.mpg,
    finalLegMiles: best.endLeg,
    rules: r,
    rescueUsed: rescue,
  };
}
export function solveFuelPlan({ distance, stations = [], rules }) {
  required(distance, "Route miles", 0);
  const r = validateRules(rules);
  const candidates = normaliseStations(stations, distance);
  const warnings = [];
  if (r.startFuel < r.hardReserve - EPS)
    return {
      status: "infeasible",
      reason:
        "Starting fuel is already below the selected minimum buffer. Correct the input or explicitly adjust the rule.",
      warnings,
    };
  let result = run(distance, candidates, r);
  if (!result && r.rescue && r.mode === "strict") {
    result = run(distance, candidates, r, true);
    if (result)
      warnings.push(
        "Rescue used: the upper refill window was relaxed. The minimum buffer, filling mode, stop limit and ending target are still enforced.",
      );
  }
  if (!result) {
    let reason = `No feasible ${r.fill === "half" ? "Half Tank" : "Full Tank"} plan meets the selected rules.`;
    if (r.fill === "half") reason += " Try Full Tank.";
    reason +=
      " Check starting fuel, MPG, buffer, ending target, maximum stops and the available route-side pumps.";
    return {
      status: "infeasible",
      reason,
      warnings,
      candidateCount: candidates.length,
    };
  }
  result.warnings = warnings;
  result.candidateCount = candidates.length;
  verifyPlan(result);
  return result;
}
/** Independent forward replay; a failed replay is never exportable. */
export function verifyPlan(plan) {
  if (plan.status !== "optimal")
    throw new Error("Only a feasible plan can be verified.");
  const r = plan.rules;
  let fuel = r.startFuel,
    mile = 0,
    out = 0,
    cost = 0,
    bought = 0,
    driven = 0;
  if (plan.stops.length > r.maxStops) throw new Error("Stop limit exceeded.");
  for (const s of plan.stops) {
    const leg = s.mile - mile + out + s.inMiles;
    const arrival = fuel - leg / r.mpg;
    if (
      !arrivalAllowed(arrival, r, plan.rescueUsed) ||
      Math.abs(arrival - s.arrival) > 1e-5
    )
      throw new Error("Fuel arrival verification failed.");
    if (s.gallons <= EPS || Math.abs(arrival + s.gallons - r.target) > 1e-5)
      throw new Error("Filling policy verification failed.");
    if (r.target - s.outMiles / r.mpg < r.hardReserve - EPS)
      throw new Error("Return-to-route reserve failed.");
    driven += leg;
    cost += s.gallons * s.price;
    bought += s.gallons;
    fuel = r.target;
    mile = s.mile;
    out = s.outMiles;
  }
  driven += plan.routeMiles - mile + out;
  fuel -= (plan.routeMiles - mile + out) / r.mpg;
  if (
    fuel < Math.max(r.hardReserve, r.endFuel) - EPS ||
    Math.abs(fuel - plan.endFuel) > 1e-5
  )
    throw new Error("Destination fuel verification failed.");
  if (r.endTolerance !== null && fuel > r.endFuel + r.endTolerance + EPS)
    throw new Error("Ending tolerance exceeded.");
  if (
    Math.abs(cost - plan.cost) > 1e-5 ||
    Math.abs(driven - plan.totalMiles) > 1e-5 ||
    Math.abs(r.startFuel + bought - driven / r.mpg - fuel) > 1e-5
  )
    throw new Error("Plan accounting failed.");
  if (
    r.mode === "before_ca" &&
    (!plan.stops.length ||
      plan.stops.some((s) => s.mile >= r.caEntryMile || s.state === "CA"))
  )
    throw new Error("Before-California rule failed.");
  return true;
}
