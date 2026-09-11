import { verifyPlan } from "./optimizer.js";
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
  instruction = "Please follow the planned fuel quantities.",
}) {
  const lines = [
    driver ? `Hi ${driver},` : "Hello,",
    route ? `Route: ${route}` : "Fuel stops",
  ];
  if (partner) lines.push(`Team driver: ${partner}`);
  const used = new Set();
  pairs.forEach((pair, i) => {
    if (!pair.a) throw new Error(`Select the first pump for stop ${i + 1}.`);
    for (const p of [pair.a, pair.b].filter(Boolean)) {
      if (used.has(p.id))
        throw new Error(`Pump ${p.name} appears more than once.`);
      used.add(p.id);
    }
    lines.push("", `${i + 1}. ${pumpLine(pair.a)}`);
    if (pair.b) lines.push(`OR ${pumpLine(pair.b)}`);
  });
  lines.push("", instruction);
  return lines.join("\n");
}
