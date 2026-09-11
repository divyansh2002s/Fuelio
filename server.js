import express from "express";
import { createHash, createSign } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  parseCSV,
  parseFuelTable,
  parseMessageTable,
  parseSheetReference,
  tableRecords,
  clean,
  number,
  header,
} from "./data.js";
import { haversine, parseCoordinates } from "./geo.js";

const app = express(),
  root = path.dirname(fileURLToPath(import.meta.url));
app.disable("x-powered-by");
app.use(express.json({ limit: "2mb" }));
const hash = (s) =>
  createHash("sha256").update(String(s)).digest("hex").slice(0, 24);
const cache = new Map(),
  pending = new Map();
async function cached(key, ttl, fn) {
  const old = cache.get(key);
  if (old && old.until > Date.now()) return old.value;
  if (pending.has(key)) return pending.get(key);
  const p = (async () => {
    const value = await fn();
    cache.set(key, { value, until: Date.now() + ttl });
    while (cache.size > 1500) cache.delete(cache.keys().next().value);
    return value;
  })();
  pending.set(key, p);
  try {
    return await p;
  } finally {
    pending.delete(key);
  }
}
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const queues = new Map();
async function paced(name, ms, fn) {
  const old = queues.get(name) || Promise.resolve();
  const task = old
    .catch(() => {})
    .then(async () => {
      try {
        return await fn();
      } finally {
        await wait(ms);
      }
    });
  queues.set(name, task);
  return task;
}
async function fetchData(
  url,
  { json = true, headers = {}, body, method = "GET", timeout = 25000 } = {},
) {
  for (let attempt = 0; attempt < 3; attempt++) {
    let response;
    try {
      response = await fetch(url, {
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        method,
        signal: AbortSignal.timeout(timeout),
        redirect: "error",
      });
    } catch (e) {
      if (attempt < 2) {
        await wait(500 * (attempt + 1));
        continue;
      }
      throw new Error(
        "An external data service could not be reached. Please retry.",
      );
    }
    if ((response.status === 429 || response.status >= 500) && attempt < 2) {
      const retry = Number(response.headers.get("retry-after"));
      await wait(
        Math.min(
          5000,
          Number.isFinite(retry) && retry > 0
            ? retry * 1000
            : 800 * 2 ** attempt,
        ),
      );
      continue;
    }
    if (!response.ok) {
      const e = new Error(
        `External service returned ${response.status}. Check access, configuration and service availability.`,
      );
      e.status = response.status;
      throw e;
    }
    const content = await response.text();
    if (content.length > 15_000_000)
      throw new Error(
        "External response is too large. Use a smaller sheet or request.",
      );
    try {
      return json ? JSON.parse(content) : content;
    } catch {
      throw new Error("The data service returned an unexpected response.");
    }
  }
}
function serviceAccount() {
  const text = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!text) return null;
  try {
    const account = JSON.parse(text);
    if (!account.client_email || !account.private_key) throw new Error();
    return account;
  } catch {
    throw new Error(
      "GOOGLE_SERVICE_ACCOUNT_JSON is not a valid service-account credential.",
    );
  }
}
async function googleToken() {
  const account = serviceAccount();
  if (!account) return null;
  return cached("google-oauth", 50 * 60000, async () => {
    const now = Math.floor(Date.now() / 1000);
    const enc = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url");
    const body = `${enc({ alg: "RS256", typ: "JWT" })}.${enc({ iss: account.client_email, scope: "https://www.googleapis.com/auth/spreadsheets.readonly", aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 })}`;
    const sign = createSign("RSA-SHA256");
    sign.update(body);
    const assertion =
      body +
      "." +
      sign.sign(account.private_key.replace(/\\n/g, "\n"), "base64url");
    const response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion,
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok)
      throw new Error(
        "Google could not authenticate the configured service account.",
      );
    const result = await response.json();
    if (!result.access_token)
      throw new Error("Google authentication returned no access token.");
    return result.access_token;
  });
}
const MASTER_ID =
  process.env.MASTER_SHEET_ID || "1VpTN7OY40d1yVFLvtBu2otIbUjAjqm6DVy71FDsBeeY";
const FUEL_REGISTRY_GID = process.env.FUEL_REGISTRY_GID || "0";
const MESSAGE_REGISTRY_GID = process.env.MESSAGE_REGISTRY_GID || "970811620";
const SAMSARA_REGISTRY_GID = process.env.SAMSARA_REGISTRY_GID || "1100093231";
async function sheetMeta(id, token) {
  return cached(`sheet-meta:${id}`, 10 * 60000, () =>
    fetchData(
      `https://sheets.googleapis.com/v4/spreadsheets/${id}?fields=sheets.properties`,
      { headers: { Authorization: `Bearer ${token}` } },
    ),
  );
}
async function sheetTable({ id, gid, title, privateOnly = false }) {
  const token = await googleToken();
  if (!token) {
    if (privateOnly)
      throw new Error(
        "Connect a private Master workbook with GOOGLE_SERVICE_ACCOUNT_JSON to load Samsara clients.",
      );
    if (title)
      throw new Error(
        "Private Master configuration is required to resolve tab names.",
      );
    return parseCSV(
      await fetchData(
        `https://docs.google.com/spreadsheets/d/${id}/gviz/tq?tqx=out:csv&gid=${gid || 0}`,
        { json: false },
      ),
    );
  }
  const meta = await sheetMeta(id, token);
  const tab = meta.sheets?.find((s) =>
    title
      ? s.properties.title === title
      : String(s.properties.sheetId) === String(gid ?? 0),
  );
  if (!tab)
    throw new Error(
      `The requested tab ${title || gid} does not exist. Check its GID or name.`,
    );
  const range = `'${tab.properties.title.replace(/'/g, "''")}'`;
  const data = await fetchData(
    `https://sheets.googleapis.com/v4/spreadsheets/${id}/values/${encodeURIComponent(range)}?valueRenderOption=UNFORMATTED_VALUE`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  return data.values || [];
}
const active = (v) =>
  v === undefined ||
  v === null ||
  v === "" ||
  ["true", "yes", "1", "active"].includes(String(v).toLowerCase());
function registryRows(table) {
  return tableRecords(table)
    .filter((r) => active(r.active))
    .map((r) => {
      const name = clean(r.mastername || r.name),
        url = clean(r.googlesheeturl || r.sheeturl || r.url);
      if (!name || !url) return null;
      const ref = parseSheetReference(url, r.gid);
      return {
        id: hash(`${name}:${ref.id}:${ref.gid}`),
        name,
        ...ref,
        sheetId: ref.id,
      };
    })
    .filter(Boolean)
    .map((r) => ({ ...r, id: hash(`${r.name}:${r.sheetId}:${r.gid}`) }));
}
async function registry() {
  return cached("master-registry", 55000, async () => {
    const configured = !!process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
    const errors = [];
    const [fuel, msg, clientData] = await Promise.allSettled([
      sheetTable({
        id: MASTER_ID,
        gid: FUEL_REGISTRY_GID,
        privateOnly: configured,
      }),
      sheetTable({
        id: MASTER_ID,
        gid: MESSAGE_REGISTRY_GID,
        privateOnly: configured,
      }),
      configured
        ? sheetTable({
            id: MASTER_ID,
            gid: SAMSARA_REGISTRY_GID,
            privateOnly: true,
          })
        : Promise.resolve([]),
    ]);
    const masters =
      fuel.status === "fulfilled" && fuel.value.length
        ? registryRows(fuel.value)
        : [];
    const messageMasters =
      msg.status === "fulfilled" && msg.value.length
        ? registryRows(msg.value)
        : [];
    if (fuel.status === "rejected")
      errors.push(
        "Fuel master registry could not be loaded. Custom Sheets and CSV uploads remain available.",
      );
    if (msg.status === "rejected")
      errors.push("Message master registry could not be loaded.");
    if (clientData.status === "rejected")
      errors.push(
        "Samsara client tab could not be loaded. Check its configured GID and sharing.",
      );
    const clients = [];
    if (clientData.status === "fulfilled" && clientData.value.length) {
      for (const r of tableRecords(clientData.value)) {
        if (!active(r.active)) continue;
        const name = clean(r.name || r.client);
        if (!name) continue;
        const tokens = [
          ...new Set(
            Object.entries(r)
              .filter(([k, v]) => /^samsaraapi\d*$/.test(k) && clean(v))
              .map(([, v]) => clean(v)),
          ),
        ];
        if (tokens.length) clients.push({ id: hash(name), name, tokens });
      }
    }
    if (!clients.length && process.env.SAMSARA_TOKEN) {
      const name = process.env.SAMSARA_CLIENT_NAME || "Connected fleet";
      clients.push({
        id: hash(name),
        name,
        tokens: [
          ...new Set(
            process.env.SAMSARA_TOKEN.split(/[\n,]+/)
              .map(clean)
              .filter(Boolean),
          ),
        ],
      });
    }
    return {
      masters,
      messageMasters,
      clients,
      errors,
      configured,
      available: {
        masters: fuel.status === "fulfilled",
        messageMasters: msg.status === "fulfilled",
        clients:
          clientData.status === "fulfilled" || !!process.env.SAMSARA_TOKEN,
      },
    };
  });
}
app.use("/api", (req, res, next) => {
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (req.headers["sec-fetch-site"] === "cross-site")
    return res
      .status(403)
      .json({ error: "Open this endpoint from the FCO workspace." });
  next();
});
app.get("/api/health", (req, res) => res.json({ ok: true, version: "1.0.0" }));
app.get("/api/config", async (req, res) => {
  const r = await registry();
  res.json({
    masters: r.masters,
    messageMasters: r.messageMasters,
    clients: r.clients.map((c) => ({
      id: c.id,
      name: c.name,
      connections: c.tokens.length,
    })),
    errors: r.errors,
    available: r.available,
    privateMaster: r.configured,
    truckRouting: !!process.env.ORS_API_KEY,
    refreshSeconds: 60,
  });
});
async function sourceRequest(body, type) {
  const r = await registry();
  const list = type === "fuel" ? r.masters : r.messageMasters;
  let ref, source;
  if (body.masterId) {
    const master = list.find((m) => m.id === body.masterId);
    if (!master)
      throw new Error(
        "The selected master is no longer active. Reload the registry.",
      );
    ref = { id: master.sheetId, gid: master.gid };
    source = master.name;
  } else {
    ref = parseSheetReference(body.url, body.gid);
    source = clean(body.label) || "Custom Google Sheet";
  }
  return cached(`${type}:${ref.id}:${ref.gid}:${source}`, 30000, async () => {
    const table = await sheetTable(ref);
    return type === "fuel"
      ? parseFuelTable(table, source)
      : { rows: parseMessageTable(table, source), source };
  });
}
app.post("/api/fuel", async (req, res) =>
  res.json(await sourceRequest(req.body, "fuel")),
);
app.post("/api/messages", async (req, res) =>
  res.json(await sourceRequest(req.body, "messages")),
);

async function samsaraPage(token, endpoint, params = {}) {
  const all = [],
    seen = new Set();
  let after = params.after,
    cursor = null;
  for (let page = 0; page < 500; page++) {
    const q = new URLSearchParams({ ...params, ...(after ? { after } : {}) });
    const value = await fetchData(`https://api.samsara.com${endpoint}?${q}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const rows = Array.isArray(value.data)
      ? value.data
      : value.data?.vehicleReports || [];
    all.push(...rows);
    cursor = value.pagination?.endCursor || cursor;
    if (!value.pagination?.hasNextPage) return { rows: all, cursor };
    if (!cursor || seen.has(cursor))
      throw new Error("Samsara pagination stopped before all records arrived.");
    seen.add(cursor);
    after = cursor;
  }
  throw new Error("Samsara result exceeds the supported request size.");
}
const statState = new Map();
const latest = (value) =>
  Array.isArray(value)
    ? (value
        .filter(Boolean)
        .sort((a, b) => Date.parse(b.time || 0) - Date.parse(a.time || 0))[0] ??
      null)
    : (value ?? null);
function mergeStat(old = {}, next = {}) {
  const out = { ...old, id: next.id || old.id };
  for (const key of [
    "gps",
    "fuelPercents",
    "obdOdometerMeters",
    "gpsOdometerMeters",
    "engineStates",
  ]) {
    const value = latest(next[key]);
    const prior = latest(old[key]);
    if (
      value &&
      (!prior || Date.parse(value.time || 0) >= Date.parse(prior.time || 0))
    )
      out[key] = value;
  }
  return out;
}
async function tokenFleet(token) {
  const key = hash(token);
  return cached(`fleet:${key}`, 50000, async () => {
    const vehicles = (
      await cached(`vehicles:${key}`, 600000, () =>
        samsaraPage(token, "/fleet/vehicles", { limit: "512" }),
      )
    ).rows;
    let state = statState.get(key) || { cursors: {}, stats: new Map() };
    // Samsara accepts at most four stat types per request.
    for (const types of [
      "gps,fuelPercents,obdOdometerMeters,gpsOdometerMeters",
      "engineStates",
    ]) {
      let response;
      try {
        response = await samsaraPage(token, "/fleet/vehicles/stats/feed", {
          types,
          ...(state.cursors[types] ? { after: state.cursors[types] } : {}),
        });
        state.cursors[types] = response.cursor;
      } catch {
        try {
          response = await samsaraPage(token, "/fleet/vehicles/stats", {
            types,
          });
          state.cursors[types] = null;
        } catch (e) {
          if (types === "engineStates") continue;
          throw e;
        }
      }
      for (const s of response.rows)
        state.stats.set(s.id, mergeStat(state.stats.get(s.id), s));
    }
    statState.set(key, state);
    while (statState.size > 100)
      statState.delete(statState.keys().next().value);
    return vehicles.map((v) => ({
      id: v.id,
      name: v.name || v.id,
      vin: v.vin || "",
      make: v.make || "",
      model: v.model || "",
      year: v.year ?? null,
      licensePlate: v.licensePlate || "",
      stats: state.stats.get(v.id) || {},
    }));
  });
}
function publicVehicle(v) {
  const gps = latest(v.stats.gps),
    fuel = latest(v.stats.fuelPercents),
    odo =
      latest(v.stats.obdOdometerMeters) || latest(v.stats.gpsOdometerMeters);
  return {
    id: v.id,
    name: v.name,
    vin: v.vin,
    make: v.make,
    model: v.model,
    year: v.year,
    licensePlate: v.licensePlate,
    lat: number(gps?.latitude),
    lng: number(gps?.longitude),
    location: gps?.reverseGeo?.formattedLocation || gps?.address?.name || "",
    gpsTime: gps?.time || null,
    speed: number(gps?.speedMilesPerHour),
    heading: number(gps?.headingDegrees),
    fuelPercent: number(fuel?.value),
    fuelTime: fuel?.time || null,
    odometer: odo?.value != null ? Number(odo.value) / 1609.344 : null,
    odometerTime: odo?.time || null,
    engine: latest(v.stats.engineStates)?.value || null,
  };
}
async function getClient(id) {
  const c = (await registry()).clients.find((c) => c.id === id);
  if (!c)
    throw new Error(
      "Choose an active connected client, or use manual planning.",
    );
  return c;
}
app.get("/api/fleet", async (req, res) => {
  const client = await getClient(req.query.client);
  const results = await Promise.allSettled(client.tokens.map(tokenFleet));
  const combined = new Map(),
    warnings = [];
  results.forEach((result, i) => {
    if (result.status === "rejected") {
      warnings.push(
        `Connection ${i + 1} could not load its fleet. Other connections are still available.`,
      );
      return;
    }
    for (const v of result.value) {
      const old = combined.get(v.id);
      combined.set(
        v.id,
        old ? { ...old, stats: mergeStat(old.stats, v.stats) } : v,
      );
    }
  });
  if (results.every((r) => r.status === "rejected"))
    throw new Error(
      "No Samsara connection responded. Check the API permissions or enter values manually.",
    );
  res.json({
    client: client.id,
    vehicles: [...combined.values()]
      .map(publicVehicle)
      .sort((a, b) =>
        a.name.localeCompare(b.name, undefined, { numeric: true }),
      ),
    warnings,
    fetchedAt: new Date().toISOString(),
  });
});
app.get("/api/vehicle-detail", async (req, res) => {
  const client = await getClient(req.query.client),
    id = clean(req.query.vehicle);
  if (!/^[\w:-]{1,120}$/.test(id))
    throw new Error("Invalid vehicle identifier.");
  const details = await cached(`detail:${client.id}:${id}`, 55000, async () => {
    const warnings = [];
    let mpg = null,
      mpgSource = null,
      historyFuel = null;
    for (const token of client.tokens) {
      // Verify this token can see the requested vehicle before obtaining reports.
      let fleet;
      try {
        fleet = await tokenFleet(token);
      } catch {
        continue;
      }
      const v = fleet.find((v) => v.id === id);
      if (!v) continue;
      const end = new Date(),
        start = new Date(end.getTime() - 30 * 86400000);
      try {
        const reports = (
          await samsaraPage(token, "/fleet/reports/vehicles/fuel-energy", {
            vehicleIds: id,
            startDate: start.toISOString(),
            endDate: end.toISOString(),
          })
        ).rows;
        const report = reports.find(
          (r) => String(r.vehicle?.id || r.vehicleId) === id,
        );
        if (report) {
          const miles = number(report.distanceTraveledMeters),
            ml = number(report.fuelConsumedMl),
            direct = number(report.efficiencyMpge);
          mpg =
            miles > 0 && ml > 0
              ? miles / 1609.344 / (ml / 3785.411784)
              : direct > 0
                ? direct
                : null;
          if (mpg > 100 || mpg <= 0) mpg = null;
          if (mpg) mpgSource = "Samsara · previous 30 days";
        }
      } catch {
        warnings.push(
          "Fuel-efficiency report unavailable. MPG stays manually editable.",
        );
      }
      if (number(latest(v.stats.fuelPercents)?.value) === null) {
        try {
          const history = (
            await samsaraPage(token, "/fleet/vehicles/stats/history", {
              types: "fuelPercents",
              vehicleIds: id,
              startTime: new Date(end.getTime() - 7 * 86400000).toISOString(),
              endTime: end.toISOString(),
            })
          ).rows;
          for (const record of history) {
            if (String(record.id) !== id) continue;
            const value = latest(record.fuelPercents);
            if (
              value &&
              number(value.value) !== null &&
              (!historyFuel ||
                Date.parse(value.time) > Date.parse(historyFuel.time))
            )
              historyFuel = { value: number(value.value), time: value.time };
          }
        } catch {
          warnings.push(
            "Fuel history unavailable. Enter starting fuel manually.",
          );
        }
      }
      if (mpg !== null) break;
    }
    return { mpg, mpgSource, historyFuel, warnings };
  });
  res.json({ vehicle: id, ...details });
});

// Submit-only US geocoding. No autocomplete requests are sent to public Nominatim.
const NOMINATIM = (
  process.env.NOMINATIM_URL || "https://nominatim.openstreetmap.org"
).replace(/\/$/, "");
app.get("/api/geocode", async (req, res) => {
  const text = clean(req.query.q);
  if (text.length < 2 || text.length > 250)
    throw new Error("Enter a US city, address, or coordinates.");
  const coords = parseCoordinates(text);
  if (coords) return res.json({ results: [coords] });
  const results = await cached(`geo:${text.toLowerCase()}`, 86400000, () =>
    paced("nominatim", 1100, () =>
      fetchData(
        `${NOMINATIM}/search?${new URLSearchParams({ q: text, format: "jsonv2", countrycodes: "us", addressdetails: "1", limit: "6" })}`,
        {
          headers: {
            "User-Agent":
              process.env.GEOCODER_USER_AGENT ||
              "FCO-Dispatch/1.0 (interactive US dispatch address search)",
          },
        },
      ),
    ),
  );
  res.json({
    results: results.map((r) => ({
      lat: Number(r.lat),
      lng: Number(r.lon),
      label: r.display_name,
      state:
        r.address?.["ISO3166-2-lvl4"]?.split("-").at(-1) ||
        r.address?.state ||
        "",
    })),
  });
});
const OSRM = (
  process.env.OSRM_URL || "https://router.project-osrm.org"
).replace(/\/$/, "");
const ORS = (process.env.ORS_URL || "https://api.openrouteservice.org").replace(
  /\/$/,
  "",
);
const road = (fn) => paced("road", process.env.OSRM_URL ? 100 : 1050, fn);
function validPoints(points, max = 25) {
  if (!Array.isArray(points) || points.length < 2 || points.length > max)
    throw new Error(`Supply between 2 and ${max} route points.`);
  return points.map((p) => {
    const lat = number(p.lat),
      lng = number(p.lng);
    if (
      lat === null ||
      lng === null ||
      lat < 18 ||
      lat > 72 ||
      lng < -180 ||
      lng > -60
    )
      throw new Error("Route coordinates must be valid US-region coordinates.");
    return { lat, lng };
  });
}
const coordinateString = (points) =>
  points.map((p) => `${p.lng.toFixed(6)},${p.lat.toFixed(6)}`).join(";");
function orsOptions(input = {}) {
  const restrictions = {};
  for (const [from, to, max] of [
    ["height", "height", 10],
    ["weight", "weight", 150],
    ["width", "width", 10],
    ["length", "length", 60],
  ]) {
    const value = number(input[from]);
    if (value !== null) {
      if (value <= 0 || value > max) throw new Error(`Invalid truck ${from}.`);
      restrictions[to] = value;
    }
  }
  if (input.hazmat) restrictions.hazmat = true;
  return {
    profile_params: { restrictions },
    ...(input.avoidTolls ? { avoid_features: ["tollways"] } : {}),
  };
}
async function orsRoute(points, options) {
  if (!process.env.ORS_API_KEY)
    throw new Error(
      "Truck routing needs ORS_API_KEY in Vercel. Standard routing remains available.",
    );
  return road(() =>
    fetchData(`${ORS}/v2/directions/driving-hgv/geojson`, {
      method: "POST",
      headers: {
        Authorization: process.env.ORS_API_KEY,
        "Content-Type": "application/json",
      },
      body: {
        coordinates: points.map((p) => [p.lng, p.lat]),
        instructions: true,
        options: orsOptions(options),
      },
      timeout: 40000,
    }),
  );
}
app.post("/api/routes", async (req, res) => {
  const points = validPoints(req.body.points),
    profile = req.body.profile === "hgv" ? "hgv" : "driving",
    options = req.body.options || {};
  const result = await cached(
    `routes:${hash(JSON.stringify({ points, profile, options }))}`,
    6 * 3600000,
    async () => {
      if (profile === "hgv") {
        const value = await orsRoute(points, options);
        return {
          routes: (value.features || []).map((f, i) => ({
            id: `hgv-${i}`,
            name: "Truck route",
            summary: [
              ...new Set(
                (f.properties.segments || [])
                  .flatMap((s) => s.steps || [])
                  .map((s) => s.name)
                  .filter((n) => n && n !== "-"),
              ),
            ]
              .slice(0, 5)
              .join(" · "),
            distance: f.properties.summary.distance / 1609.344,
            duration: f.properties.summary.duration,
            coordinates: f.geometry.coordinates,
            profile,
            provider: "OpenRouteService HGV",
          })),
          note: "Truck restrictions applied. Add waypoints or saved lanes for alternative long-distance truck routes.",
        };
      }
      const value = await road(() =>
        fetchData(
          `${OSRM}/route/v1/driving/${coordinateString(points)}?alternatives=${points.length === 2 ? "3" : "false"}&overview=full&geometries=geojson&steps=true`,
          { timeout: 40000 },
        ),
      );
      if (value.code !== "Ok")
        throw new Error("No road route was returned for these locations.");
      return {
        routes: value.routes.map((r, i) => ({
          id: `road-${i}`,
          name: `Route ${i + 1}`,
          summary:
            r.legs
              .map((l) => l.summary)
              .filter(Boolean)
              .join(" · ") || "Road route",
          distance: r.distance / 1609.344,
          duration: r.duration,
          coordinates: r.geometry.coordinates,
          profile,
          provider: "OSRM standard roads",
        })),
        note: "Standard road routing. Truck-specific restrictions are not checked. Driving time excludes breaks, stops and live traffic.",
      };
    },
  );
  res.json(result);
});
app.post("/api/access", async (req, res) => {
  const items = req.body.items,
    profile = req.body.profile === "hgv" ? "hgv" : "driving",
    options = req.body.options || {};
  if (!Array.isArray(items) || !items.length || items.length > 20)
    throw new Error("Access requests support 1–20 pumps at a time.");
  const normal = items.map((item) => {
    const [projection, pump] = validPoints([item.projection, item.pump], 2);
    if (haversine(projection, pump) > 10.1)
      throw new Error("A pump is outside the supported corridor.");
    return { id: String(item.id).slice(0, 250), projection, pump };
  });
  const key = `access:${hash(JSON.stringify({ normal, profile, options }))}`;
  const result = await cached(key, 86400000, async () => {
    if (profile === "hgv") {
      const rows = [];
      for (const item of normal) {
        const result = await orsRoute(
          [item.projection, item.pump, item.projection],
          options,
        );
        const segments = result.features?.[0]?.properties?.segments;
        if (!segments || segments.length !== 2)
          throw new Error(
            "Truck access route is unavailable for a candidate. No candidate was silently skipped.",
          );
        rows.push({
          id: item.id,
          inMiles: segments[0].distance / 1609.344,
          outMiles: segments[1].distance / 1609.344,
          seconds: segments[0].duration + segments[1].duration,
        });
      }
      return rows;
    }
    const points = normal.flatMap((n) => [n.projection, n.pump]);
    const value = await road(() =>
      fetchData(
        `${OSRM}/table/v1/driving/${coordinateString(points)}?annotations=distance,duration`,
        { timeout: 40000 },
      ),
    );
    if (value.code !== "Ok")
      throw new Error(
        "Road access could not be checked. Retry to finish the plan.",
      );
    return normal.map((item, i) => {
      const a = 2 * i,
        b = a + 1;
      const inbound = value.distances?.[a]?.[b],
        outbound = value.distances?.[b]?.[a];
      const snap = value.sources?.[b]?.distance ?? 0;
      if (
        inbound === null ||
        outbound === null ||
        inbound === undefined ||
        outbound === undefined ||
        snap > 250
      )
        return {
          id: item.id,
          unreachable: true,
          reason:
            snap > 250
              ? "Pump coordinates could not be matched closely to a road."
              : "No road access in both directions.",
        };
      return {
        id: item.id,
        inMiles: inbound / 1609.344,
        outMiles: outbound / 1609.344,
        seconds:
          (value.durations?.[a]?.[b] || 0) + (value.durations?.[b]?.[a] || 0),
      };
    });
  });
  res.json({ items: result });
});
app.post("/api/stop-path", async (req, res) => {
  const [anchor, pump] = validPoints([req.body.projection, req.body.pump], 2);
  if (haversine(anchor, pump) > 10.1)
    throw new Error("Invalid pump connector.");
  if (req.body.profile === "hgv") {
    const v = await orsRoute([anchor, pump, anchor], req.body.options || {});
    return res.json({ coordinates: v.features[0].geometry.coordinates });
  }
  const v = await road(() =>
    fetchData(
      `${OSRM}/route/v1/driving/${coordinateString([anchor, pump, anchor])}?overview=full&geometries=geojson&steps=false`,
    ),
  );
  if (v.code !== "Ok") throw new Error("Stop access map is unavailable.");
  res.json({ coordinates: v.routes[0].geometry.coordinates });
});

app.use(
  express.static(path.join(root, "public"), {
    index: "index.html",
    dotfiles: "deny",
  }),
);
app.use("/api", (req, res) =>
  res.status(404).json({ error: "Endpoint not found." }),
);
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const message = String(err.message || "Request failed.").replace(
    /samsara_api_[\w-]+/gi,
    "[redacted]",
  );
  res
    .status(err.type === "entity.too.large" ? 413 : 400)
    .json({ error: message });
});
export default app;
if (
  !process.env.VERCEL &&
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  app.listen(Number(process.env.PORT) || 3000, () =>
    console.log(
      "FCO is available at http://localhost:" + (process.env.PORT || 3000),
    ),
  );
}
