import { verifyPlan } from "./optimizer.js";
import { stopNumber } from "./view-model.js";
const gallons = (n) => Number(n).toFixed(2).replace(/\.00$/, "");
export function pumpLine(pump) {
  return `${pump.name || [pump.brand, pump.store ? `#${pump.store}` : ""].filter(Boolean).join(" ")} — ${pump.location || [pump.city, pump.state].filter(Boolean).join(", ") || "Location not supplied"}${pump.highway ? ` | ${pump.highway}` : ""}${pump.exit ? ` | Exit ${pump.exit}` : ""}`;
}
export function planMessage(
  plan,
  { driver = "", partner = "", truck = "", origin = "", destination = "" } = {},
) {
  verifyPlan(plan);
  const lines = [
    driver ? `Hi ${driver},` : "Hello,",
    `Fuel plan${truck ? ` — ${truck}` : ""}`,
    `${origin} → ${destination}`,
  ];
  if (partner) lines.push(`Team driver: ${partner}`);
  if (!plan.stops.length)
    lines.push(
      "No fuel stop is needed on this trip with the entered starting fuel.",
    );
  plan.stops.forEach((p, i) =>
    lines.push(
      "",
      `${i + 1}. ${pumpLine(p)}`,
      `Buy approximately ${gallons(p.gallons)} gallons. Leave with ${gallons(p.departure)} gallons (${plan.rules.fill === "half" ? "half tank" : "full tank"}).`,
    ),
  );
  if (plan.rules.mode === "before_ca")
    lines.push("Complete these fuel stops before entering California.");
  lines.push(
    "",
    `Expected fuel at destination: ${gallons(plan.endFuel)} gallons.`,
    `Minimum fuel buffer: ${gallons(plan.rules.hardReserve)} gallons.`,
  );
  return lines.join("\n");
}
export function customMessage({
  driver = "",
  partner = "",
  route = "",
  pairs = [],
  audience = "driver",
  brand = "",
}) {
  const tidy = (s) => String(s ?? "").trim();
  const brands = [...new Set(pairs.flatMap((p) => [p.a, p.b]).filter(Boolean).map((p) => tidy(p.brand)).filter(Boolean))];
  const chain = brands.length === 1 ? brands[0] : brands.length > 1 ? "" : tidy(brand);
  const stations = chain ? `${chain} fuel stations` : "fuel stations";
  const primary = tidy(driver), secondary = tidy(partner), road = tidy(route);
  if (audience === "team" && (!primary || !secondary)) throw new Error("Enter both driver names for the team-driver message.");
  const greeting = audience === "team"
    ? `Hey ${secondary}, We spoke to ${primary}, I have listed down the suggested ${stations} with their nearest city for filling up your vehicle tank. The company is getting a discount on filling up at these fuel stops.`
    : `${primary ? `Hey ${primary},` : "Hey,"} I have listed down the suggested ${stations} with their nearest city for your consideration.`;
  const lines = [greeting];
  const used = new Set();
  const line = (p, i) => `${"*".repeat(i + 1)}${stopNumber(p) || tidy(p.name)}  ${tidy(p.location) || [p.city, p.state].filter(Boolean).join(", ")} ( HW: ${tidy(p.highway)}, Exit: ${tidy(p.exit)} )`;
  pairs.forEach((pair, i) => {
    if (!pair.a) throw new Error(`Enter the first stop for pair ${i + 1}.`);
    for (const p of [pair.a, pair.b].filter(Boolean)) {
      const key = p.id || `${p.brand}:${stopNumber(p)}:${p.location}`;
      if (used.has(key)) throw new Error(`Stop ${p.name || stopNumber(p)} appears more than once.`);
      used.add(key);
    }
    lines.push("", line(pair.a, i));
    if (pair.b) lines.push("OR", line(pair.b, i));
  });
  lines.push("", `We will appreciate if you fill up the tank at these fuel stops. This Result is based on the route ${audience === "team" ? `${primary} discussed with us ` : ""}(${road}). If you change your route please let me know.`, "", "Drive Safe!");
  return lines.join("\n");
}
