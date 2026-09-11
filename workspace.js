import {
  parseCSV,
  parseFuelTable,
  parseMessageTable,
  escapeHTML as h,
  number,
  clean,
  toCSV,
  STATES,
} from "./data.js";
import {
  prepareRoute,
  routeCandidates,
  parseCoordinates,
  californiaEntry,
  insidePolygon,
  haversine,
} from "./geo.js";
import { validateRules, verifyPlan } from "./optimizer.js";
import { planMessage, customMessage, pumpLine } from "./messages.js";
import { parseLoads, prepareLoads } from "./batch.js";

const $ = (id) => document.getElementById(id),
  $$ = (selector) => [...document.querySelectorAll(selector)];
const money = (n) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
  }).format(n);
const fmt = (n, d = 1) =>
  Number.isFinite(n)
    ? n.toLocaleString("en-US", {
        maximumFractionDigits: d,
        minimumFractionDigits: d,
      })
    : "—";
const time = (s) => `${Math.floor(s / 3600)}h ${Math.round((s % 3600) / 60)}m`;
const colours = ["#2457da", "#168767", "#b87917", "#b44885", "#58829f"];
const FORM_IDS = [
  "truck",
  "origin",
  "destination",
  "waypoints",
  "capacity",
  "mpg",
  "startFuel",
  "fuelPercent",
  "fill",
  "reserve",
  "endFuel",
  "mode",
  "maxStops",
  "corridor",
  "windowLower",
  "windowUpper",
  "endTolerance",
  "rescue",
  "routingProfile",
  "truckHeight",
  "truckWidth",
  "truckWeight",
  "truckLength",
  "hazmat",
  "avoidTolls",
];
const STATE_KEY = "fco.workspace.v1";
let restored = {};
try {
  restored = JSON.parse(localStorage.getItem(STATE_KEY) || "{}");
} catch {}
const state = {
  view: "planner",
  config: { clients: [], masters: [], messageMasters: [] },
  client: restored.client || "",
  master: restored.master || "",
  vehicle: null,
  vehicles: [],
  fleetSeq: 0,
  fuelSeq: 0,
  fuel: null,
  routes: [],
  selected: new Set(),
  plans: [],
  saved: [],
  history: [],
  loads: [],
  log: [],
  overrides: restored.overrides || {},
  sourcePrefs: restored.sourcePrefs || null,
  highways: new Set(),
  map: null,
  heat: !!restored.heat,
  mapMode: restored.mapMode || "map",
  activeSolve: null,
  routeStamp: null,
  messageRows: null,
  pairs: [{ a: "", b: "" }],
  planForMessage: null,
  accessCache: new Map(),
  ca: null,
};
const dbPromise = new Promise((resolve) => {
  try {
    const req = indexedDB.open("fco-workspace", 1);
    req.onupgradeneeded = () => req.result.createObjectStore("data");
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
  } catch {
    resolve(null);
  }
});
async function dbGet(key) {
  const db = await dbPromise;
  if (!db) return null;
  return new Promise((resolve) => {
    const req = db.transaction("data").objectStore("data").get(key);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => resolve(null);
  });
}
async function dbPut(key, value) {
  const db = await dbPromise;
  if (!db) {
    toast(
      "Browser storage is unavailable. Keep this tab open or export your work.",
    );
    return;
  }
  return new Promise((resolve) => {
    const tx = db.transaction("data", "readwrite");
    tx.objectStore("data").put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => {
      toast("Browser storage is full. Export a backup of your work.");
      resolve();
    };
  });
}
function formData() {
  return Object.fromEntries(
    FORM_IDS.map((id) => [
      id,
      $(id).type === "checkbox" ? $(id).checked : $(id).value,
    ]),
  );
}
function persist() {
  try {
    localStorage.setItem(
      STATE_KEY,
      JSON.stringify({
        form: formData(),
        theme: $("theme").value,
        client: state.client,
        master: state.master,
        sourcePrefs: state.sourcePrefs,
        overrides: state.overrides,
        mapMode: state.mapMode,
        heat: state.heat,
      }),
    );
  } catch {
    toast("Preferences could not be saved in this browser.");
  }
}
function toast(message) {
  $("toast").textContent = message;
  $("toast").hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => ($("toast").hidden = true), 4500);
}
function notice(message) {
  $("notice").hidden = !message;
  if (message)
    $("notice").innerHTML =
      `<span>${h(message)}</span><button class="text-button" id="dismissNotice" aria-label="Dismiss notice">×</button>`;
  if ($("dismissNotice")) $("dismissNotice").onclick = () => notice("");
}
function log(message, type = "info") {
  state.log.unshift({ message, type, time: new Date().toISOString() });
  state.log = state.log.slice(0, 200);
  renderLog();
}
async function api(path, body, signal) {
  const response = await fetch("/api/" + path, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: signal || AbortSignal.timeout(180000),
  });
  let result;
  try {
    result = await response.json();
  } catch {
    throw new Error(
      "The server is unavailable. Check the Vercel deployment and try again.",
    );
  }
  if (!response.ok) throw new Error(result.error || "Request failed.");
  return result;
}
function action(fn) {
  return async (event) => {
    const button = event?.currentTarget;
    if (button instanceof HTMLButtonElement) button.disabled = true;
    try {
      await fn(event);
    } catch (e) {
      if (e.name !== "AbortError") {
        notice(e.message);
        log(e.message, "error");
      }
    } finally {
      if (button instanceof HTMLButtonElement) button.disabled = false;
    }
  };
}
function setView(view) {
  state.view = view;
  $("workspace").dataset.view = view;
  $$(".nav").forEach((b) =>
    b.classList.toggle("active", b.dataset.view === view),
  );
  for (const id of [
    "planner",
    "fleet",
    "pump",
    "library",
    "message",
    "activity",
  ])
    $(id + "Content").hidden =
      id !==
      (view === "pumps" ? "pump" : view === "messages" ? "message" : view);
  if (view === "fleet") renderFleet();
  if (view === "pumps") renderPumps();
  if (view === "library") renderLibrary();
  if (view === "messages") renderMessages();
  if (view === "activity") {
    renderLog();
    renderHistory();
  }
  requestAnimationFrame(() => {
    state.map?.invalidateSize();
    drawMap();
    if (view === "fleet") fitMap();
  });
  location.hash = view;
}
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  $("theme").value = theme;
  persist();
}
function keyForVehicle() {
  return `${state.client || "manual"}:${state.vehicle?.id || $("truck").value || "manual"}`;
}
function manualEdits() {
  return state.overrides[keyForVehicle()] || {};
}
function markManual(id, value) {
  const key = keyForVehicle();
  state.overrides[key] = { ...(state.overrides[key] || {}), [id]: value };
  $("overrideBadge").textContent = "Manual values";
  persist();
}
function updateFuelUI(changed) {
  const cap = number($("capacity").value),
    fuel = number($("startFuel").value),
    percent = number($("fuelPercent").value);
  if (changed === "fuelPercent" && cap !== null && percent !== null)
    $("startFuel").value = String(Math.round(cap * percent) / 100);
  else if (cap > 0 && fuel !== null)
    $("fuelPercent").value = String(Math.round((fuel / cap) * 10000) / 100);
  const target = (cap || 0) * ($("fill").value === "half" ? 0.5 : 1);
  $("fillHelp").textContent =
    `Leave each selected stop with ${fmt(target, 1)} gallons.`;
  const mpg = number($("mpg").value) || 0,
    reserve = number($("reserve").value) || 0;
  $("rangeHelp").textContent =
    `Buffer: ${fmt(reserve * mpg, 0)} miles · Available range above buffer: ${fmt(Math.max(0, (number($("startFuel").value) || 0) - reserve) * mpg, 0)} miles`;
  $("modeHelp").textContent =
    $("mode").value === "strict"
      ? `Arrival window: ${fmt(Math.max(0, reserve - (number($("windowLower").value) || 0)), 0)}–${fmt(reserve + (number($("windowUpper").value) || 0), 0)} gal. The lower edge is the minimum buffer.`
      : $("mode").value === "before_ca"
        ? "Arrive at pre-California fuel stops with 35–55 gal; complete all purchases before the actual state boundary. Destination fuel is checked."
        : "Keep at least the buffer throughout the trip; buy the lowest-cost feasible combination.";
}
function currentRules() {
  const numeric = [
    "capacity",
    "mpg",
    "startFuel",
    "reserve",
    "endFuel",
    "maxStops",
    "windowLower",
    "windowUpper",
  ];
  const r = Object.fromEntries(numeric.map((id) => [id, number($(id).value)]));
  r.corridor = number($("corridor").value);
  r.fill = $("fill").value;
  r.mode = $("mode").value;
  r.rescue = $("rescue").checked;
  r.endTolerance =
    $("endTolerance").value === "" ? null : number($("endTolerance").value);
  return r;
}
function routeOptions() {
  return {
    height: number($("truckHeight").value),
    width: number($("truckWidth").value),
    weight: number($("truckWeight").value),
    length: number($("truckLength").value),
    hazmat: $("hazmat").checked,
    avoidTolls: $("avoidTolls").checked,
  };
}
function tripStamp() {
  return JSON.stringify([
    $("origin").value.trim(),
    $("destination").value.trim(),
    $("waypoints").value.trim(),
    $("routingProfile").value,
    routeOptions(),
  ]);
}

async function loadConfig(initial = false) {
  const r = await api("config");
  // A temporarily unavailable tab is not an authoritative empty registry.
  for (const kind of ["clients", "masters", "messageMasters"]) {
    if (r.available?.[kind] === false && state.config[kind].length)
      r[kind] = state.config[kind];
  }
  state.config = r;
  if (state.client && !r.clients.some((c) => c.id === state.client)) {
    state.client = "";
    state.vehicle = null;
    state.vehicles = [];
    state.fleetSeq++;
    $("truck").value = "";
    $("trucks").innerHTML = "";
  }
  if (
    !state.client &&
    initial &&
    r.clients.length &&
    !Object.prototype.hasOwnProperty.call(restored, "client")
  )
    state.client = r.clients[0].id;
  $("client").innerHTML =
    '<option value="">Manual planning</option>' +
    r.clients
      .map(
        (c) =>
          `<option value="${h(c.id)}">${h(c.name)}${c.connections > 1 ? ` · ${c.connections} connections` : ""}</option>`,
      )
      .join("");
  $("client").value = state.client;
  const currentMaster = state.master;
  if (!r.masters.some((m) => m.id === state.master))
    state.master = initial && !state.master ? r.masters[0]?.id || "" : "";
  if (
    r.available?.masters !== false &&
    state.sourcePrefs?.kind === "master" &&
    !r.masters.some((m) => m.id === state.sourcePrefs.id) &&
    state.fuel
  ) {
    state.activeSolve?.abort();
    state.fuel = null;
    state.sourcePrefs = null;
    state.fuelSeq++;
    $("sourceBadge").textContent = "Source removed — choose a fuel master";
    await dbPut("fuel", null);
    renderPumps();
    drawMap();
  }
  $("master").innerHTML =
    '<option value="">Choose a source</option>' +
    r.masters
      .map((m) => `<option value="${h(m.id)}">${h(m.name)}</option>`)
      .join("");
  $("master").value = state.master;
  const previous = $("messageMaster").value || state.messageMasterId || "";
  $("messageMaster").innerHTML =
    '<option value="">Use loaded fuel pumps</option>' +
    r.messageMasters
      .map((m) => `<option value="${h(m.id)}">${h(m.name)}</option>`)
      .join("");
  if (r.messageMasters.some((m) => m.id === previous))
    $("messageMaster").value = previous;
  $("settingsStatus").textContent =
    `${r.privateMaster ? "Private Master connected" : "Private Master is not connected"} · ${r.clients.length} clients · ${r.masters.length} fuel masters. ${r.truckRouting ? "Truck routing is configured." : "Standard routing is available."}`;
  if (!state.client) {
    $("connection").textContent = "Manual mode";
    $("connection").classList.remove("connected");
  } else if (!state.vehicles.length) {
    $("connection").textContent = "Connecting to fleet…";
    $("connection").classList.remove("connected");
  }
  if (initial) {
    if (r.errors.length) log(r.errors.join(" "));
    if (
      state.sourcePrefs?.kind === "master" &&
      r.masters.some((m) => m.id === state.sourcePrefs.id)
    ) {
      state.master = state.sourcePrefs.id;
      $("master").value = state.master;
      await loadMaster();
    } else if (!state.fuel && state.master) await loadMaster();
  }
  if (currentMaster !== state.master) persist();
}
function vehicleLabel(vehicle) {
  return state.vehicles.filter((v) => v.name === vehicle.name).length > 1
    ? `${vehicle.name} · ${vehicle.id}`
    : vehicle.name;
}
function findTruck(value) {
  const exact = state.vehicles.find((v) => vehicleLabel(v) === value);
  if (exact) return exact;
  const unit = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
  if (!unit) return null;
  const matches = state.vehicles.filter((v) => {
    const name = v.name.toLowerCase().replace(/[^a-z0-9]/g, "");
    return (
      name === unit || (/^\d+$/.test(unit) && name.match(/\d+$/)?.[0] === unit)
    );
  });
  return matches.length === 1 ? matches[0] : null;
}
let fleetJob = null;
async function loadFleet() {
  if (!state.client) return;
  if (fleetJob?.client === state.client && fleetJob.seq === state.fleetSeq) return fleetJob.promise;
  const client = state.client,
    seq = ++state.fleetSeq;
  const promise = updateFleet(client, seq);
  const job = { client, seq, promise };
  fleetJob = job;
  try {
    return await promise;
  } finally {
    if (fleetJob === job) fleetJob = null;
  }
}
async function updateFleet(client, seq) {
  let result;
  try {
    result = await api(`fleet?client=${encodeURIComponent(client)}`);
  } catch (error) {
    if (seq === state.fleetSeq && client === state.client) {
      $("connection").textContent = "Fleet unavailable · last values retained";
      $("connection").classList.remove("connected");
    }
    throw error;
  }
  if (seq !== state.fleetSeq || client !== state.client) return;
  state.vehicles = result.vehicles;
  $("trucks").innerHTML = result.vehicles
    .map(
      (v) =>
        `<option value="${h(vehicleLabel(v))}" label="${h([v.make, v.model].filter(Boolean).join(" "))}"></option>`,
    )
    .join("");
  if (state.vehicle) {
    const next = result.vehicles.find((v) => v.id === state.vehicle.id);
    if (next) {
      state.vehicle = { ...state.vehicle, ...next };
      applyLive();
    }
  } else {
    const v = findTruck($("truck").value);
    if (v) {
      state.vehicle = v;
      $("truck").value = vehicleLabel(v);
      applyLive();
    }
  }
  $("connection").textContent =
    `${result.vehicles.length} trucks · ${result.partial ? "partial data · see Activity" : "live every 60 sec"}`;
  $("connection").classList.toggle("connected", !result.partial);
  if (result.warnings.length) log(result.warnings.join(" "), "warning");
  drawTruck();
  if (state.view === "fleet") renderFleet();
  // Optional reports must not block the truck list or the next fleet refresh.
  if (state.vehicle) void loadVehicleDetail().catch((error) => log(error.message, "warning"));
}
function applyLive(force = false) {
  const v = state.vehicle;
  if (!v) {
    renderTelemetry();
    return;
  }
  const overrides = force ? {} : manualEdits();
  const set = (id, value) => {
    if (overrides[id] !== undefined) $(id).value = overrides[id];
    else if (
      value !== null &&
      value !== undefined &&
      document.activeElement !== $(id)
    )
      $(id).value = value;
  };
  set("capacity", null);
  set("origin", v.lat !== null && v.lng !== null ? `${v.lat}, ${v.lng}` : null);
  set("mpg", v.mpg ?? null);
  const percent = number(v.fuelPercent);
  if (overrides.startFuel !== undefined) set("startFuel", overrides.startFuel);
  else if (overrides.fuelPercent !== undefined) {
    $("fuelPercent").value = overrides.fuelPercent;
    updateFuelUI("fuelPercent");
  } else if (
    percent !== null &&
    document.activeElement !== $("startFuel") &&
    document.activeElement !== $("fuelPercent")
  )
    $("startFuel").value = (
      (Number($("capacity").value) * percent) /
      100
    ).toFixed(2);
  $("overrideBadge").textContent = Object.keys(overrides).length
    ? "Manual values"
    : "";
  updateFuelUI();
  renderTelemetry();
  drawTruck();
  if (state.view === "fleet") renderFleet();
  persist();
}
async function chooseTruck() {
  const name = $("truck").value;
  const v = findTruck(name);
  if (state.vehicle?.id === v?.id && v) return;
  state.vehicle = v || null;
  if (v) {
    $("truck").value = vehicleLabel(v);
    $("capacity").value = manualEdits().capacity ?? "240";
    $("mpg").value = manualEdits().mpg ?? "7";
    $("startFuel").value = manualEdits().startFuel ?? "";
    $("fuelPercent").value = "";
    if (v.lat === null || v.lng === null)
      $("origin").value = manualEdits().origin ?? "";
    applyLive();
    await loadVehicleDetail();
    log(`Selected ${v.name}.`);
  } else {
    renderTelemetry();
    updateFuelUI();
  }
  persist();
}
async function loadVehicleDetail() {
  if (!state.vehicle || !state.client) return;
  const id = state.vehicle.id,
    client = state.client;
  try {
    const d = await api(
      `vehicle-detail?client=${encodeURIComponent(client)}&vehicle=${encodeURIComponent(id)}`,
    );
    if (client !== state.client || id !== state.vehicle?.id) return;
    if (number(d.mpg) !== null) {
      state.vehicle.mpg = d.mpg;
      state.vehicle.mpgSource = d.mpgSource;
    }
    if (state.vehicle.fuelPercent === null && d.historyFuel) {
      state.vehicle.fuelPercent = d.historyFuel.value;
      state.vehicle.fuelTime = d.historyFuel.time;
      state.vehicle.fuelSource = "history";
    }
    applyLive();
    if (d.warnings.length) log(d.warnings.join(" "), "warning");
  } catch (e) {
    log(e.message, "warning");
  }
}
function renderTelemetry() {
  const v = state.vehicle;
  if (!v) {
    $("telemetryTitle").textContent = "Manual planning";
    $("liveTime").textContent = "API connection optional";
    $("telemetryBody").textContent =
      "All trip values are editable. Connect a client to load live truck information.";
    return;
  }
  $("telemetryTitle").textContent = v.name;
  $("liveTime").textContent = v.gpsTime
    ? `GPS ${new Date(v.gpsTime).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}`
    : "GPS unavailable";
  const entries = [
    ["Location", "location", v.location],
    ["Speed · mph", "speed", v.speed],
    [
      "Odometer · mi",
      "odometer",
      v.odometer == null ? "" : v.odometer.toFixed(1),
    ],
    ["Heading · degrees", "heading", v.heading],
    ["Engine", "engine", v.engine],
    ["VIN", "vin", v.vin],
    ["Make", "make", v.make],
    ["Model", "model", v.model],
    ["Year", "year", v.year],
    ["Plate", "licensePlate", v.licensePlate],
  ];
  if ($("telemetryBody").contains(document.activeElement)) return;
  $("telemetryBody").innerHTML =
    `<div class="live-grid">${entries.map(([label, key, value]) => `<div><label for="live-${key}">${label}</label><input id="live-${key}" data-live-field="${key}" value="${h(manualEdits()["live-" + key] ?? value ?? "")}" placeholder="Not supplied"></div>`).join("")}</div><p class="field-help">Fuel: ${v.fuelPercent === null ? "not supplied" : fmt(v.fuelPercent, 1) + "%"}${v.fuelTime ? " · " + h(new Date(v.fuelTime).toLocaleString()) : ""}${v.fuelSource === "history" ? " · history fallback" : ""}<br>MPG: ${h(v.mpgSource || "manual / fallback value")}</p>`;
  $$("[data-live-field]").forEach(
    (el) => (el.oninput = () => markManual(el.id, el.value)),
  );
}

async function applyFuel(data, prefs, background = false) {
  if (!background) state.activeSolve?.abort();
  if (!data.rows?.length) throw new Error("No valid fuel rows were loaded.");
  state.fuel = data;
  state.sourcePrefs = prefs;
  if (!background) {
    state.plans = [];
    $("results").innerHTML = "";
  }
  $("sourceBadge").textContent = `${data.source} · ${data.rows.length} pumps`;
  $("dataIssueCount").textContent =
    `Data checks · ${(data.issues || []).length} notes`;
  $("dataIssues").innerHTML =
    (data.issues || []).map((i) => `<p>${h(i)}</p>`).join("") ||
    "All loaded rows passed validation.";
  state.routes.forEach((r) => delete r.candidates);
  await dbPut("fuel", data);
  persist();
  renderPumps();
  drawMap();
  log(`Loaded ${data.rows.length} pumps from ${data.source}.`);
  if (!state.messageRows) renderMessages();
}
async function loadMaster() {
  const sequence = ++state.fuelSeq;
  const id = $("master").value;
  if (!id) throw new Error("Choose a fuel master first.");
  state.master = id;
  const label = state.config.masters.find((m) => m.id === id)?.name;
  const result = await api("fuel", { masterId: id });
  if ($("master").value !== id || sequence !== state.fuelSeq) return;
  await applyFuel(
    { ...result, source: label || result.source },
    { kind: "master", id },
  );
}
async function loadCustomSheet() {
  const sequence = ++state.fuelSeq;
  try {
    $("sourceError").textContent = "";
    const url = $("sheetUrl").value,
      gid = $("sheetGid").value;
    const data = await api("fuel", { url, gid, label: "Custom Google Sheet" });
    if (sequence !== state.fuelSeq) return;
    await applyFuel(data, { kind: "sheet", url, gid });
    $("sourceDialog").close();
  } catch (e) {
    $("sourceError").textContent = e.message;
  }
}
async function refreshFuelSource() {
  const prefs = state.sourcePrefs;
  if (!prefs || !["master", "sheet"].includes(prefs.kind)) return;
  const sequence = state.fuelSeq;
  const body =
    prefs.kind === "master"
      ? { masterId: prefs.id }
      : { url: prefs.url, gid: prefs.gid, label: "Custom Google Sheet" };
  const data = await api("fuel", body);
  if (sequence !== state.fuelSeq || prefs !== state.sourcePrefs) return;
  if (JSON.stringify(data.rows) !== JSON.stringify(state.fuel?.rows))
    await applyFuel(data, prefs, true);
}
async function uploadFuel(event) {
  const sequence = ++state.fuelSeq;
  const file = event.target.files[0];
  if (!file) return;
  try {
    if (file.size > 15_000_000)
      throw new Error("Choose a CSV smaller than 15 MB.");
    const data = parseFuelTable(await readTableFile(file), file.name);
    if (sequence !== state.fuelSeq) return;
    await applyFuel(data, { kind: "csv", name: file.name });
    $("sourceDialog").close();
  } finally {
    event.target.value = "";
  }
}
function currentPumps() {
  return state.fuel?.rows || [];
}

function createMap() {
  if (!window.L) {
    notice("Map assets did not load. Check the deployment build and reload.");
    return;
  }
  const map = (state.map = L.map("map", {
    zoomControl: true,
    preferCanvas: true,
  }).setView([38, -97], 4));
  state.base = L.tileLayer(
    "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
    {
      maxZoom: 19,
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    },
  ).addTo(map);
  L.control
    .scale({ metric: false, imperial: true, position: "bottomright" })
    .addTo(map);
  state.routeLayer = L.layerGroup().addTo(map);
  state.pumpLayer = L.layerGroup().addTo(map);
  state.pointLayer = L.layerGroup().addTo(map);
  state.truckLayer = L.layerGroup().addTo(map);
  state.connectorLayer = L.layerGroup().addTo(map);
  map.on("click", (e) => {
    const mode = $("mapClick").value;
    if (mode === "none") return;
    const text = `${e.latlng.lat.toFixed(6)}, ${e.latlng.lng.toFixed(6)}`;
    if (mode === "waypoint")
      $("waypoints").value = [$("waypoints").value.trim(), text]
        .filter(Boolean)
        .join("\n");
    else {
      $(mode).value = text;
      if (mode === "origin") markManual("origin", text);
    }
    persist();
    toast(
      mode === "waypoint"
        ? "Waypoint added."
        : `${mode === "origin" ? "Origin" : "Destination"} selected.`,
    );
  });
  setMapMode(state.mapMode);
}
async function setMapMode(mode) {
  if (!state.map) return;
  state.mapMode = mode;
  $("streetBtn").classList.toggle("active", mode === "map");
  $("satelliteBtn").classList.toggle("active", mode === "satellite");
  $("mapShell").classList.toggle("satellite", mode === "satellite");
  state.map.removeLayer(state.base);
  if (state.labelLayer && state.map.hasLayer(state.labelLayer))
    state.map.removeLayer(state.labelLayer);
  if (mode === "satellite") {
    state.base = L.tileLayer(
      "https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}",
      {
        maxZoom: 19,
        attribution: "Imagery: USGS · Labels: OpenFreeMap / OpenStreetMap",
      },
    ).addTo(state.map);
    try {
      if (!state.labelLayer && L.maplibreGL) {
        const response = await fetch(
          "https://tiles.openfreemap.org/styles/liberty",
        );
        const style = await response.json();
        style.layers = style.layers.filter(
          (l) =>
            l.type === "symbol" ||
            (l.type === "line" && /road|transport|highway/.test(l.id)),
        );
        state.labelLayer = L.maplibreGL({ style, interactive: false });
      }
      if (state.mapMode === "satellite" && state.labelLayer)
        state.labelLayer.addTo(state.map);
    } catch {
      log(
        "Satellite imagery loaded; road labels are temporarily unavailable.",
        "warning",
      );
    }
  } else
    state.base = L.tileLayer(
      "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
      {
        maxZoom: 19,
        attribution:
          '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      },
    ).addTo(state.map);
  state.base.bringToBack();
  persist();
}
function popup(p) {
  return `<strong>${h(p.name)}</strong><br>${h(p.location || [p.city, p.state].filter(Boolean).join(", "))}<br><b>${"$"}${p.price.toFixed(4)} / gal</b><br>${h(p.highway || "Highway not supplied")}${p.exit ? " · Exit " + h(p.exit) : ""}<br><small>${h(p.source || state.fuel?.source || "")}</small>`;
}
function visiblePumps() {
  const query = $("pumpSearch").value.toLowerCase().trim(),
    st = $("stateFilter").value;
  let rows = currentPumps().filter(
    (p) =>
      (!st || p.state === st) &&
      (!state.highways.size ||
        p.highways.some((hw) => state.highways.has(hw))) &&
      (!query ||
        `${p.name} ${p.location} ${p.city} ${p.state} ${STATES.find((s) => s[0] === p.state)?.[1] || ""} ${p.highway} ${p.exit} ${p.price}`
          .toLowerCase()
          .includes(query)),
  );
  if ($("routeOnly").checked && state.routes.length) {
    const ids = new Set(
      state.routes
        .filter((r) => state.selected.has(r.id))
        .flatMap((r) =>
          (
            r.candidates ||
            routeCandidates(r, currentPumps(), Number($("corridor").value))
          ).map((p) => p.pumpId),
        ),
    );
    rows = rows.filter((p) => ids.has(p.id));
  }
  if ($("priceSort").value === "low") rows.sort((a, b) => a.price - b.price);
  if ($("priceSort").value === "high") rows.sort((a, b) => b.price - a.price);
  return rows;
}
function drawMap() {
  if (!state.map) return;
  state.routeLayer.clearLayers();
  state.pointLayer.clearLayers();
  state.pumpLayer.clearLayers();
  const routes = state.routes;
  routes.forEach((r, i) => {
    const selected = state.selected.has(r.id);
    L.polyline(r.points, {
      color: colours[i % colours.length],
      weight: selected ? 5 : 3,
      opacity: selected ? 0.9 : 0.3,
    })
      .addTo(state.routeLayer)
      .on("click", () => {
        state.selected.has(r.id)
          ? state.selected.delete(r.id)
          : state.selected.add(r.id);
        renderRouteCards();
        drawMap();
      });
  });
  if (routes.length) {
    const r = routes[0];
    for (const [p, label] of [
      [r.points[0], "A"],
      [r.points.at(-1), "B"],
    ])
      L.marker([p.lat, p.lng], {
        icon: L.divIcon({
          className: "",
          html: `<span class="point-label">${label}</span>`,
          iconSize: [28, 28],
          iconAnchor: [14, 14],
        }),
      }).addTo(state.pointLayer);
  }
  const nearby = routes
    .filter((r) => state.selected.has(r.id))
    .flatMap(
      (r) =>
        r.candidates ||
        routeCandidates(r, currentPumps(), Number($("corridor").value)),
    );
  const pumps =
    state.view === "pumps"
      ? visiblePumps()
      : routes.length
        ? [...new Map(nearby.map((p) => [p.pumpId, p])).values()]
        : currentPumps();
  const prices = pumps.map((p) => p.price),
    min = prices.reduce((a, b) => Math.min(a, b), Infinity),
    max = prices.reduce((a, b) => Math.max(a, b), -Infinity);
  const picked = new Set(
    state.plans
      .filter((p) => p.status === "optimal")
      .flatMap((p) => p.stops.map((s) => s.pumpId || s.id)),
  );
  for (const p of pumps) {
    const recommended = picked.has(p.pumpId || p.id),
      ratio = max > min ? (p.price - min) / (max - min) : 0.5;
    const colour = recommended
      ? "#2457da"
      : state.heat
        ? `hsl(${145 - ratio * 145} 60% 42%)`
        : "#4d927b";
    const marker = L.circleMarker([p.lat, p.lng], {
      radius: recommended ? 8 : 5,
      weight: recommended ? 3 : 1.2,
      color: recommended ? "#fff" : "#fff",
      fillColor: colour,
      fillOpacity: recommended ? 1 : 0.85,
    })
      .bindPopup(popup(p))
      .addTo(state.pumpLayer);
    if (recommended)
      marker.bindTooltip(`$${p.price.toFixed(3)}`, {
        permanent: true,
        direction: "top",
        className: "pump-label recommended",
      });
    marker.on("click", () => {
      state.focusedPump = p;
      $$("[data-pump-row]").forEach((row) => {
        const selected = row.dataset.pumpRow === (p.pumpId || p.id);
        row.classList.toggle("focused-pump", selected);
        if (selected && state.view === "pumps")
          row.scrollIntoView({ behavior: "smooth", block: "nearest" });
      });
    });
  }
  if (state.view === "fleet") {
    state.pumpLayer.clearLayers();
    state.routeLayer.clearLayers();
    state.pointLayer.clearLayers();
  }
  $("heatBtn").classList.toggle("active", state.heat);
  $("heatBtn").setAttribute("aria-pressed", String(state.heat));
  $("priceLegend").hidden = !state.heat || !pumps.length;
  if (pumps.length)
    $("priceLegend").innerHTML =
      `Price / gal<div class="ramp"></div>${money(min)} — ${money(max)}`;
  $("mapCaption").textContent = routes.length
    ? `${routes.length} route${routes.length === 1 ? "" : "s"} · ${pumps.length} nearby pumps · ${state.fuel?.source || "load fuel data"}`
    : pumps.length
      ? `${pumps.length} pumps · ${state.fuel.source}`
      : "Route first. Fuel stops next.";
  drawTruck();
}
function drawTruck() {
  if (!state.truckLayer) return;
  state.truckLayer.clearLayers();
  const list =
    state.view === "fleet"
      ? state.vehicles
      : state.vehicle
        ? [state.vehicle]
        : [];
  for (const v of list) {
    if (number(v.lat) === null || number(v.lng) === null) continue;
    L.marker([v.lat, v.lng], {
      icon: L.divIcon({
        className: "",
        html: '<span class="point-label">↑</span>',
        iconSize: [28, 28],
        iconAnchor: [14, 14],
      }),
    })
      .bindPopup(
        h(v.name) +
          "<br>" +
          h(v.location || "") +
          "<br>Fuel: " +
          (v.fuelPercent == null ? "—" : h(v.fuelPercent) + "%"),
      )
      .addTo(state.truckLayer);
  }
}
function renderFleet() {
  const q = $("fleetSearch").value.toLowerCase().trim();
  const rows = state.vehicles.filter((v) =>
    `${v.name} ${v.vin} ${v.location}`.toLowerCase().includes(q),
  );
  $("fleetCount").textContent =
    `${rows.length} of ${state.vehicles.length} trucks · ${$("client").selectedOptions[0]?.textContent || "Manual mode"}`;
  $("fleetRows").innerHTML = rows
    .map(
      (v) =>
        `<tr><td><strong>${h(v.name)}</strong><small>${h(v.vin || "")}</small></td><td>${h(v.location || "Not supplied")}</td><td>${v.fuelPercent == null ? "—" : fmt(v.fuelPercent, 1) + "%"}</td><td>${v.speed == null ? "—" : fmt(v.speed, 0) + " mph"}</td><td>${v.odometer == null ? "—" : fmt(v.odometer, 0) + " mi"}</td><td>${v.gpsTime ? h(new Date(v.gpsTime).toLocaleString()) : "Not supplied"}</td><td><button class="secondary" data-fleet-truck="${h(v.id)}">Plan trip</button></td></tr>`,
    )
    .join("");
  $$("[data-fleet-truck]").forEach(
    (b) =>
      (b.onclick = action(async () => {
        const v = state.vehicles.find((v) => v.id === b.dataset.fleetTruck);
        $("truck").value = vehicleLabel(v);
        await chooseTruck();
        setView("planner");
      })),
  );
}

function fitMap() {
  if (!state.map) return;
  const points =
    state.view === "fleet"
      ? state.vehicles.filter(
          (v) => number(v.lat) !== null && number(v.lng) !== null,
        )
      : state.routes.length
        ? state.routes
            .filter((r) => state.selected.has(r.id))
            .flatMap((r) => r.points)
        : visiblePumps();
  if (points.length)
    state.map.fitBounds(L.latLngBounds(points.map((p) => [p.lat, p.lng])), {
      padding: [35, 65],
      maxZoom: 12,
    });
  else state.map.setView([38, -97], 4);
}
function focusPump(id) {
  const p = currentPumps().find((p) => p.id === id);
  if (!p) return;
  state.focusedPump = p;
  $$("[data-pump-row]").forEach((row) =>
    row.classList.toggle("focused-pump", row.dataset.pumpRow === id),
  );
  if (!state.map) return;
  state.map.setView([p.lat, p.lng], 13);
  L.popup().setLatLng([p.lat, p.lng]).setContent(popup(p)).openOn(state.map);
  $("mapShell").scrollIntoView({ behavior: "smooth", block: "start" });
}
function renderPumps() {
  const old = $("stateFilter").value;
  const states = [
    ...new Set(
      currentPumps()
        .map((p) => p.state)
        .filter(Boolean),
    ),
  ].sort();
  $("stateFilter").innerHTML =
    '<option value="">All states</option>' +
    states.map((s) => `<option>${h(s)}</option>`).join("");
  $("stateFilter").value = old;
  const rows = visiblePumps();
  $("pumpCount").textContent =
    `${rows.length} of ${currentPumps().length} pumps · ${state.fuel?.source || "No data loaded"}`;
  $("pumpRows").innerHTML = rows
    .map(
      (p) =>
        `<tr data-pump-row="${h(p.id)}" class="${state.focusedPump?.id === p.id ? "focused-pump" : ""}"><td><strong>${h(p.name)}</strong><small>${h(p.brand)}</small></td><td>${h(p.location || [p.city, p.state].filter(Boolean).join(", "))}</td><td>${h(p.highway || "—")}${p.exit ? `<small>Exit ${h(p.exit)}</small>` : ""}</td><td class="price">$${p.price.toFixed(4)}</td><td><button class="text-button" data-focus="${h(p.id)}">View</button><button class="text-button" data-message-pump="${h(p.id)}">Message</button></td></tr>`,
    )
    .join("");
  $$("[data-focus]").forEach(
    (b) => (b.onclick = () => focusPump(b.dataset.focus)),
  );
  $$("[data-message-pump]").forEach(
    (b) =>
      (b.onclick = () => {
        state.messageRows = null;
        state.pairs.push({ a: b.dataset.messagePump, b: "" });
        state.pairs = state.pairs.filter((p) => p.a);
        setView("messages");
      }),
  );
  const counts = new Map();
  currentPumps().forEach((p) =>
    p.highways.forEach((hw) => counts.set(hw, (counts.get(hw) || 0) + 1)),
  );
  const search = $("highwaySearch").value.toUpperCase();
  $("highwayOptions").innerHTML = [...counts]
    .sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }))
    .filter(([hw]) => hw.includes(search))
    .map(
      ([hw, count]) =>
        `<label><input type="checkbox" data-highway="${h(hw)}" ${state.highways.has(hw) ? "checked" : ""}>${h(hw)} <span class="muted">${count}</span></label>`,
    )
    .join("");
  $("highwayCount").textContent = state.highways.size
    ? `· ${state.highways.size} selected`
    : "";
  $$("[data-highway]").forEach(
    (el) =>
      (el.onchange = () => {
        el.checked
          ? state.highways.add(el.dataset.highway)
          : state.highways.delete(el.dataset.highway);
        renderPumps();
        drawMap();
      }),
  );
}

async function geocode(text) {
  const direct = parseCoordinates(text);
  if (direct) return [direct];
  const result = await api("geocode?q=" + encodeURIComponent(text));
  if (!result.results.length)
    throw new Error(
      `No US location found for “${text}”. Enter city and state, or coordinates.`,
    );
  return result.results;
}
async function searchPlace(field) {
  const results = await geocode($(field).value);
  const box = $(field + "Suggestions");
  box.hidden = false;
  box.innerHTML = results
    .map((r, i) => `<button data-place="${i}">${h(r.label)}</button>`)
    .join("");
  box.querySelectorAll("button").forEach(
    (b) =>
      (b.onclick = () => {
        const place = results[Number(b.dataset.place)];
        $(field).value = place.label;
        $(field).dataset.coordinates = JSON.stringify(place);
        $(field).dataset.selectedLabel = place.label;
        box.hidden = true;
        if (field === "origin") markManual("origin", place.label);
        persist();
      }),
  );
}
async function resolveField(field) {
  const el = $(field);
  if (el.dataset.selectedLabel === el.value && el.dataset.coordinates)
    return JSON.parse(el.dataset.coordinates);
  const results = await geocode(el.value);
  return results[0];
}
async function findRoutes() {
  if (state.activeSolve) state.activeSolve.abort();
  notice("");
  const originText = $("origin").value.trim(),
    destText = $("destination").value.trim();
  if (!originText || !destText)
    throw new Error("Enter both an origin and a destination.");
  const stamp = tripStamp();
  $("findRoutes").textContent = "Finding roads…";
  try {
    const origin = await resolveField("origin"),
      destination = await resolveField("destination");
    const waypoints = $("waypoints")
      .value.split("\n")
      .map(clean)
      .filter(Boolean);
    if (waypoints.length > 23)
      throw new Error("Use no more than 23 waypoints per route.");
    const via = [];
    for (const text of waypoints) via.push((await geocode(text))[0]);
    const profile = $("routingProfile").value,
      options = routeOptions();
    const result = await api("routes", {
      points: [origin, ...via, destination],
      profile,
      options,
    });
    if (!result.routes.length) throw new Error("No routes were returned.");
    state.routes = result.routes.map((r, i) =>
      prepareRoute({
        ...r,
        id: `${Date.now()}-${i}`,
        trip: {
          origin: originText,
          destination: destText,
          truck: $("truck").value,
          client: $("client").selectedOptions[0]?.textContent || "Manual",
        },
        inputPoints: [origin, ...via, destination],
        options,
      }),
    );
    state.routeStamp = stamp;
    state.selected = new Set(state.routes.map((r) => r.id));
    state.plans = [];
    $("results").innerHTML = "";
    state.connectorLayer?.clearLayers();
    renderRouteCards();
    drawMap();
    fitMap();
    log(
      `Found ${state.routes.length} route(s): ${fmt(Math.min(...state.routes.map((r) => r.distance)), 1)} miles shortest. ${result.note}`,
    );
    $("candidateSummary").textContent = result.note;
    persist();
  } finally {
    $("findRoutes").innerHTML = "Find routes <span>→</span>";
  }
}
function renderRouteCards() {
  if (!state.routes.length) return;
  const shortest = Math.min(...state.routes.map((r) => r.distance)),
    fastest = Math.min(...state.routes.map((r) => r.duration));
  $("routeCount").textContent =
    `${state.routes.length} route${state.routes.length > 1 ? "s" : ""} available`;
  $("routeCards").innerHTML = state.routes
    .map(
      (r, i) =>
        `<div class="route-card ${state.selected.has(r.id) ? "selected" : ""}" style="--route:${colours[i % colours.length]}"><div class="route-title"><h3><input type="checkbox" data-route="${h(r.id)}" ${state.selected.has(r.id) ? "checked" : ""} aria-label="Select ${h(r.name)}">${h(r.name)}</h3><span class="small muted">0${i + 1}</span></div><p>${h(r.summary)}</p><div class="metrics"><div>${fmt(r.distance, 1)}<span>route miles</span></div><div>${time(r.duration)}<span>driving time</span></div></div><div class="tags">${r.distance === shortest ? '<span class="tag good">SHORTEST RETURNED</span>' : ""}${r.duration === fastest ? '<span class="tag blue">FASTEST RETURNED</span>' : ""}${r.profile === "hgv" ? '<span class="tag">TRUCK</span>' : ""}</div></div>`,
    )
    .join("");
  $$("[data-route]").forEach(
    (el) =>
      (el.onchange = () => {
        el.checked
          ? state.selected.add(el.dataset.route)
          : state.selected.delete(el.dataset.route);
        renderRouteCards();
        drawMap();
      }),
  );
  $$(".route-card").forEach((card) => {
    card.onclick = (event) => {
      if (event.target.closest("input, button, a, label")) return;
      card.querySelector("input[data-route]").click();
    };
  });
  $("solveBar").hidden = false;
  $("solveRoutes").disabled = !state.selected.size;
  $("solveRoutes").textContent =
    `Find cheapest fuel plan${state.selected.size > 1 ? ` · ${state.selected.size} routes` : ""}`;
}
function showProgress(message, percent) {
  $("progress").hidden = false;
  $("progressText").textContent = message;
  $("progressValue").value = percent;
}
async function enrichCandidates(
  route,
  signal,
  onProgress = () => {},
  fuel = state.fuel,
  radius = number($("corridor").value),
) {
  if (!(radius > 0 && radius <= 10))
    throw new Error(
      "Route radius must be greater than 0 and at most 10 miles.",
    );
  const candidates = routeCandidates(route, fuel.rows, radius);
  route.candidates = candidates;
  const unverified = [],
    verified = [],
    excluded = [];
  const profile = route.profile,
    options = route.options || routeOptions();
  const cacheKey = (p) =>
    JSON.stringify([
      profile,
      options,
      p.projection.lat.toFixed(6),
      p.projection.lng.toFixed(6),
      p.lat.toFixed(6),
      p.lng.toFixed(6),
    ]);
  for (const p of candidates) {
    const saved = state.accessCache.get(cacheKey(p));
    if (saved && saved.until > Date.now()) {
      if (saved.unreachable) excluded.push(p);
      else verified.push({ ...p, ...saved });
    } else unverified.push(p);
  }
  const size = profile === "hgv" ? 3 : 20;
  let done = verified.length + excluded.length;
  for (let i = 0; i < unverified.length; i += size) {
    if (signal.aborted) throw new DOMException("Cancelled", "AbortError");
    const batch = unverified.slice(i, i + size);
    onProgress(done, candidates.length);
    const result = await api(
      "access",
      {
        items: batch.map((p) => ({
          id: p.id,
          projection: p.projection,
          pump: { lat: p.lat, lng: p.lng },
        })),
        profile,
        options,
      },
      signal,
    );
    for (const p of batch) {
      const access = result.items.find((a) => a.id === p.id);
      if (!access)
        throw new Error(
          "A road-access response was incomplete. Retry planning.",
        );
      const saved = {
        inMiles: access.inMiles,
        outMiles: access.outMiles,
        seconds: access.seconds,
        unreachable: access.unreachable,
        until: Date.now() + 86400000,
      };
      state.accessCache.set(cacheKey(p), saved);
      if (access.unreachable) excluded.push(p);
      else verified.push({ ...p, ...saved });
    }
    done += batch.length;
    onProgress(done, candidates.length);
  }
  while (state.accessCache.size > 3000)
    state.accessCache.delete(state.accessCache.keys().next().value);
  await dbPut("access", [...state.accessCache]);
  return { stations: verified, excluded };
}
function solveInWorker(input, signal) {
  return new Promise((resolve, reject) => {
    const worker = new Worker("/worker.js", { type: "module" });
    const stop = () => {
      worker.terminate();
      reject(new DOMException("Cancelled", "AbortError"));
    };
    if (signal.aborted) {
      stop();
      return;
    }
    signal.addEventListener("abort", stop, { once: true });
    worker.onmessage = ({ data }) => {
      signal.removeEventListener("abort", stop);
      worker.terminate();
      data.error ? reject(new Error(data.error)) : resolve(data.result);
    };
    worker.onerror = () => {
      signal.removeEventListener("abort", stop);
      worker.terminate();
      reject(
        new Error(
          "The optimiser could not run. Reload the page and try again.",
        ),
      );
    };
    worker.postMessage({ id: Date.now(), input });
  });
}
async function planRoute(
  route,
  rules,
  signal,
  progress,
  fuelSnapshot = state.fuel,
) {
  const r = { ...rules },
    fuel = fuelSnapshot || { rows: [], source: "No purchase required" };
  if (r.mode === "before_ca") {
    if (!state.ca) state.ca = await (await fetch("/california.json")).json();
    const boundary = state.ca.geometry || state.ca;
    if (!insidePolygon(route.points.at(-1), boundary))
      throw new Error(
        "Before California applies to trips ending in California.",
      );
    r.caEntryMile = californiaEntry(route, boundary);
  }
  validateRules(r);
  const access = await enrichCandidates(
    route,
    signal,
    progress,
    fuel,
    r.corridor,
  );
  const eligible =
    r.mode === "before_ca"
      ? access.stations.filter(
          (s) => !insidePolygon(s, state.ca.geometry || state.ca),
        )
      : access.stations;
  const plan = await solveInWorker(
    { distance: route.distance, stations: eligible, rules: r },
    signal,
  );
  if (plan.status === "infeasible" && !fuelSnapshot)
    plan.reason =
      "Load a fuel master, Google Sheet or file to find refuelling stops. The entered fuel does not cover this trip and its ending target.";
  plan.route = route;
  plan.source = fuel.source;
  plan.createdAt = new Date().toISOString();
  plan.id = crypto.randomUUID();
  plan.trip = { ...route.trip };
  plan.excludedPumps = access.excluded.length;
  return plan;
}
async function solveSelected() {
  if (state.activeSolve) throw new Error("A plan is already running.");
  if (!state.routes.length || !state.selected.size)
    throw new Error("Find routes and select at least one.");
  if (state.routeStamp !== tripStamp())
    throw new Error(
      "Trip locations or routing settings changed. Find routes again before planning.",
    );
  const routes = state.routes.filter((r) => state.selected.has(r.id)),
    rules = currentRules(),
    fuelSnapshot = state.fuel,
    controller = new AbortController();
  state.activeSolve = controller;
  state.plans = [];
  $("results").innerHTML = "";
  $("solveRoutes").disabled = true;
  try {
    for (let i = 0; i < routes.length; i++) {
      const route = routes[i];
      showProgress(
        `Checking road access · ${route.name}`,
        (i / routes.length) * 100,
      );
      const plan = await planRoute(
        route,
        rules,
        controller.signal,
        (done, total) =>
          showProgress(
            `${route.name} · checked ${done} of ${total} pump connections`,
            ((i + (total ? done / total : 1)) / routes.length) * 100,
          ),
        fuelSnapshot,
      );
      state.plans.push(plan);
      log(
        plan.status === "optimal"
          ? `${route.name}: ${money(plan.cost)} · ${plan.stops.length} stops · ${fmt(plan.endFuel, 1)} gal at destination.`
          : `${route.name}: ${plan.reason}`,
        plan.status === "optimal" ? "success" : "warning",
      );
      renderResults();
    }
    drawMap();
    const good = state.plans.filter((p) => p.status === "optimal");
    if (good.length) {
      for (const p of good) state.history.unshift(p);
      state.history = state.history.slice(0, 30);
      await dbPut("history", state.history);
      $("results").scrollIntoView({ behavior: "smooth", block: "start" });
    }
  } finally {
    state.activeSolve = null;
    $("progress").hidden = true;
    $("solveRoutes").disabled = false;
  }
}
function fuelChart(plan) {
  const points = [[0, plan.rules.startFuel]];
  let previous = 0;
  for (const s of plan.stops) {
    points.push([s.tripMile, s.arrival], [s.tripMile, s.departure]);
    previous = s.tripMile;
  }
  points.push([plan.totalMiles, plan.endFuel]);
  const x = (n) => 35 + (n / Math.max(1, plan.totalMiles)) * 620,
    y = (n) => 108 - (n / plan.rules.capacity) * 90;
  const path = points
    .map(([a, b], i) => `${i ? "L" : "M"}${x(a).toFixed(1)},${y(b).toFixed(1)}`)
    .join(" ");
  const reserve = y(plan.rules.hardReserve);
  return `<svg viewBox="0 0 680 135" role="img" aria-label="Fuel remaining over the trip, with refuelling increases and minimum buffer"><line x1="35" x2="655" y1="108" y2="108" stroke="var(--line)"/><line x1="35" x2="655" y1="${reserve}" y2="${reserve}" stroke="var(--warning)" stroke-dasharray="4 4"/><path d="${path}" fill="none" stroke="var(--accent)" stroke-width="2.5"/><text x="0" y="18">${plan.rules.capacity}</text><text x="10" y="112">0</text><text x="35" y="130">Start</text><text x="585" y="130">${fmt(plan.totalMiles, 0)} mi</text><text x="500" y="${Math.max(12, reserve - 5)}">Buffer ${fmt(plan.rules.hardReserve, 0)} gal</text></svg>`;
}
function renderResults() {
  const plans = [...state.plans].sort(
    (a, b) =>
      (a.status === "optimal" ? a.cost : Infinity) -
      (b.status === "optimal" ? b.cost : Infinity),
  );
  const best = plans.find((p) => p.status === "optimal");
  $("results").innerHTML = plans
    .map((p) => {
      if (p.status !== "optimal")
        return `<article class="infeasible"><h3>${h(p.route.name)} · No feasible plan</h3><p>${h(p.reason)}</p>${p.rules?.fill === "half" || $("fill").value === "half" ? '<button class="secondary" data-full-tank>Use Full Tank</button>' : ""}</article>`;
      return `<article class="plan-result ${p === best ? "best" : ""}"><div class="result-top"><div><span class="tag ${p === best ? "good" : ""}">${p === best ? "LOWEST FUEL SPEND" : "FEASIBLE PLAN"}</span><h2>${h(p.route.name)} · ${h(p.trip.truck || "Manual trip")}</h2><p class="stop-note">${h(p.source)} · ${p.rules.fill === "half" ? "Half Tank" : "Full Tank"} · ${h(new Date(p.createdAt).toLocaleString())}</p></div><div class="result-cost">${money(p.cost)}<small>fuel to purchase</small></div></div><div class="result-metrics"><div><strong>${fmt(p.totalMiles, 1)} mi</strong><span>Including pump access</span></div><div><strong>${fmt(p.gallons, 2)} gal</strong><span>Fuel to buy</span></div><div><strong>${p.stops.length} stops</strong><span>${fmt(p.detourMiles, 1)} extra miles</span></div><div><strong>${fmt(p.endFuel, 2)} gal</strong><span>At destination</span></div></div>${p.warnings.map((w) => `<p class="callout">${h(w)}</p>`).join("")}${p.excludedPumps ? `<p class="callout">${p.excludedPumps} pumps had no confirmed road access and were excluded.</p>` : ""}<div class="stop-list">${p.stops.length ? p.stops.map((s, i) => `<div class="stop-row"><span class="stop-number">${i + 1}</span><div><button class="text-button stop-name" data-stop="${h(p.id)}:${i}">${h(s.name)}</button><p class="stop-location">${h(s.location || [s.city, s.state].filter(Boolean).join(", "))}</p><p class="stop-note">${h(s.highway || "")}${s.exit ? " · Exit " + h(s.exit) : ""} · Route mile ${fmt(s.mile, 1)}</p></div><div class="fuel-flow"><span><small>ARRIVE</small>${fmt(s.arrival, 2)}</span><span class="muted">→</span><span class="purchase"><small>BUY · GAL</small>+${fmt(s.gallons, 2)}</span><span class="muted">→</span><span><small>LEAVE</small>${fmt(s.departure, 2)}</span></div><div class="stop-price">${money(s.cost)}<small>$${s.price.toFixed(4)} / gal</small></div></div>`).join("") : '<p style="padding:20px 0">No fuel purchase is needed. The entered starting fuel covers this trip and its reserve.</p>'}</div><div class="fuel-chart"><details><summary>Fuel profile &amp; calculation details</summary>${fuelChart(p)}<p class="field-help">${fmt(p.rules.startFuel, 2)} starting + ${fmt(p.gallons, 2)} purchased − ${fmt(p.burned, 2)} consumed = ${fmt(p.endFuel, 2)} ending gallons. Exact minimum for the supplied routes, prices and fixed-fill rules. Initial fuel is already on hand; remaining fuel is shown separately. Road access uses return-to-route connectors. ${h(p.route.provider)}.</p></details></div><div class="result-actions"><button class="secondary" data-export-csv="${p.id}">Export CSV</button><button class="secondary" data-export-json="${p.id}">Export JSON</button><button class="quiet" data-plan-map="${p.id}">Show on map</button><button class="quiet" data-plan-message="${p.id}">Preview message</button><button class="primary" data-copy-plan="${p.id}">Copy driver message</button></div></article>`;
    })
    .join("");
  $$("[data-copy-plan]").forEach(
    (b) =>
      (b.onclick = action(() => {
        const p = plans.find((p) => p.id === b.dataset.copyPlan);
        return copy(
          planMessage(p, {
            ...p.trip,
            driver: $("resultDriver").value || $("messageDriver").value,
            partner: $("resultPartner").value || $("messagePartner").value,
          }),
        );
      })),
  );
  $$("[data-plan-message]").forEach(
    (b) =>
      (b.onclick = () =>
        openPlanMessage(plans.find((p) => p.id === b.dataset.planMessage))),
  );
  $$("[data-export-csv]").forEach(
    (b) =>
      (b.onclick = () =>
        exportPlan(
          plans.find((p) => p.id === b.dataset.exportCsv),
          "csv",
        )),
  );
  $$("[data-export-json]").forEach(
    (b) =>
      (b.onclick = () =>
        exportPlan(
          plans.find((p) => p.id === b.dataset.exportJson),
          "json",
        )),
  );
  $$("[data-plan-map]").forEach(
    (b) =>
      (b.onclick = () => {
        const p = plans.find((p) => p.id === b.dataset.planMap);
        state.selected = new Set([p.route.id]);
        drawMap();
        fitMap();
        $("mapShell").scrollIntoView({ behavior: "smooth" });
      }),
  );
  $$("[data-full-tank]").forEach(
    (b) =>
      (b.onclick = () => {
        $("fill").value = "full";
        updateFuelUI();
        persist();
        toast("Full Tank selected. Run the plan again.");
      }),
  );
  $$("[data-stop]").forEach(
    (b) =>
      (b.onclick = action(async () => {
        const [id, index] = b.dataset.stop.split(":");
        const p = plans.find((p) => p.id === id),
          s = p.stops[Number(index)];
        state.map.setView([s.lat, s.lng], 12);
        L.popup()
          .setLatLng([s.lat, s.lng])
          .setContent(popup(s))
          .openOn(state.map);
        $("mapShell").scrollIntoView({ behavior: "smooth" });
        const geometry = await api("stop-path", {
          projection: s.projection,
          pump: { lat: s.lat, lng: s.lng },
          profile: p.route.profile,
          options: p.route.options,
        });
        state.connectorLayer.clearLayers();
        L.polyline(
          geometry.coordinates.map((c) => [c[1], c[0]]),
          { color: "#dc7440", weight: 5, dashArray: "7 5" },
        ).addTo(state.connectorLayer);
      })),
  );
}
function download(name, text, type = "text/plain") {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function exportPlan(p, type) {
  verifyPlan(p);
  if (type === "json")
    download("fco-plan.json", JSON.stringify(p, null, 2), "application/json");
  else
    download(
      "fco-plan.csv",
      toCSV([
        [
          "Route",
          "Master",
          "Truck",
          "Stop",
          "Pump",
          "City",
          "State",
          "Highway",
          "Exit",
          "Route mile",
          "Arrival gal",
          "Buy gal",
          "Departure gal",
          "Price per gal",
          "Fuel cost",
          "End fuel gal",
        ],
        ...p.stops.map((s, i) => [
          p.trip.origin + " to " + p.trip.destination,
          p.source,
          p.trip.truck,
          i + 1,
          s.name,
          s.city,
          s.state,
          s.highway,
          s.exit,
          s.mile,
          s.arrival,
          s.gallons,
          s.departure,
          s.price,
          s.cost,
          "",
        ]),
        [
          "TOTAL",
          p.source,
          p.trip.truck,
          p.stops.length,
          "",
          "",
          "",
          "",
          "",
          p.totalMiles,
          "",
          p.gallons,
          "",
          "",
          p.cost,
          p.endFuel,
        ],
      ]),
      "text/csv",
    );
}
async function copy(text) {
  if (!text.trim()) throw new Error("There is no message to copy.");
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const el = document.createElement("textarea");
    el.value = text;
    el.style.position = "fixed";
    el.style.opacity = "0";
    document.body.append(el);
    el.select();
    const ok = document.execCommand("copy");
    el.remove();
    if (!ok)
      throw new Error(
        "Copy was blocked. Select the preview text and copy it manually.",
      );
  }
  toast("Message copied.");
}
function openPlanMessage(plan) {
  state.planForMessage = plan;
  updateResultMessage();
  $("messageDialog").showModal();
}
function updateResultMessage() {
  if (!state.planForMessage) return;
  $("resultMessage").value = planMessage(state.planForMessage, {
    ...state.planForMessage.trip,
    driver: $("resultDriver").value,
    partner: $("resultPartner").value,
  });
}
function renderMessages() {
  const rows = state.messageRows || currentPumps();
  $("messageSource").textContent =
    state.messageRows?.[0]?.source ||
    state.fuel?.source ||
    "Load a message master or fuel pumps";
  const options =
    '<option value="">Choose a pump</option>' +
    rows
      .map((p) => `<option value="${h(p.id)}">${h(pumpLine(p))}</option>`)
      .join("");
  $("messagePairs").innerHTML = state.pairs
    .map(
      (pair, i) =>
        `<div class="message-pair"><div class="section-heading"><h3>Stop ${i + 1}</h3><button data-remove-pair="${i}" class="text-button">Remove</button></div><div class="inline"><select data-pair="${i}" data-side="a" aria-label="Stop ${i + 1} first pump">${options}</select><span>OR</span><select data-pair="${i}" data-side="b" aria-label="Stop ${i + 1} alternative pump">${options}</select></div></div>`,
    )
    .join("");
  $$("[data-pair]").forEach((el) => {
    el.value = state.pairs[Number(el.dataset.pair)][el.dataset.side];
    el.onchange = () => {
      state.pairs[Number(el.dataset.pair)][el.dataset.side] = el.value;
      updateCustomMessage();
    };
  });
  $$("[data-remove-pair]").forEach(
    (el) =>
      (el.onclick = () => {
        state.pairs.splice(Number(el.dataset.removePair), 1);
        renderMessages();
      }),
  );
  updateCustomMessage();
}
function saveMessages() {
  clearTimeout(saveMessages.timer);
  saveMessages.timer = setTimeout(
    () =>
      dbPut("messages", {
        rows: state.messageRows,
        pairs: state.pairs,
        master: $("messageMaster").value,
        fields: Object.fromEntries(
          [
            "messageDriver",
            "messagePartner",
            "messageRoute",
            "messageInstruction",
          ].map((id) => [id, $(id).value]),
        ),
      }),
    200,
  );
}
function messageInputs() {
  const rows = state.messageRows || currentPumps();
  return {
    driver: $("messageDriver").value,
    partner: $("messagePartner").value,
    route: $("messageRoute").value,
    instruction: $("messageInstruction").value,
    pairs: state.pairs
      .filter((p) => p.a || p.b)
      .map((pair) => ({
        a: rows.find((p) => p.id === pair.a),
        b: rows.find((p) => p.id === pair.b),
      })),
  };
}
function updateCustomMessage() {
  saveMessages();
  try {
    const data = messageInputs();
    $("messagePreview").value = data.pairs.length ? customMessage(data) : "";
    $("partnerPreview").innerHTML =
      data.partner && data.pairs.length
        ? `<div class="section-heading"><h3>Team driver copy</h3><button id="copyPartner" class="secondary">Copy for ${h(data.partner)}</button></div><textarea id="partnerMessage" class="message-preview" rows="7" readonly></textarea>`
        : "";
    if ($("partnerMessage")) {
      $("partnerMessage").value = customMessage({
        ...data,
        driver: data.partner,
        partner: data.driver,
      });
      $("copyPartner").onclick = action(() => copy($("partnerMessage").value));
    }
  } catch (e) {
    $("messagePreview").value = e.message;
    $("partnerPreview").innerHTML = "";
  }
}
function renderLibrary() {
  const lanes = [...state.saved, ...(state.library || [])];
  $("savedRoutes").innerHTML = lanes
    .map(
      (l) =>
        `<article class="library-card"><span class="tag">${l.source === "PurFCO route library" ? "PURFCO LANE" : "SAVED TRIP"}</span><h3 style="margin-top:8px">${h(l.name)}</h3><p>${h(l.origin)} → ${h(l.destination)}${l.waypoints?.length ? `<br>Via ${h(l.waypoints.join(" · "))}` : ""}</p><div><button class="secondary" data-use-lane="${h(l.id)}">Use lane</button>${l.source !== "PurFCO route library" ? `<button class="text-button" data-delete-lane="${h(l.id)}">Delete</button>` : ""}</div></article>`,
    )
    .join("");
  $$("[data-use-lane]").forEach(
    (b) =>
      (b.onclick = () =>
        useLane(lanes.find((l) => l.id === b.dataset.useLane))),
  );
  $$("[data-delete-lane]").forEach(
    (b) =>
      (b.onclick = async () => {
        state.saved = state.saved.filter((l) => l.id !== b.dataset.deleteLane);
        await dbPut("saved", state.saved);
        renderLibrary();
      }),
  );
  renderLoads();
}
function useLane(lane) {
  $("origin").value = lane.origin;
  $("destination").value = lane.destination;
  $("waypoints").value = (lane.waypoints || []).join("\n");
  if (lane.form)
    for (const [id, val] of Object.entries(lane.form)) {
      if (
        !FORM_IDS.includes(id) ||
        ["truck", "origin", "destination", "waypoints"].includes(id)
      )
        continue;
      $(id).type === "checkbox" ? ($(id).checked = !!val) : ($(id).value = val);
    }
  markManual("origin", $("origin").value);
  if (lane.points?.length) {
    for (const [field, p] of [
      ["origin", lane.points[0]],
      ["destination", lane.points.at(-1)],
    ]) {
      $(field).dataset.coordinates = JSON.stringify(p);
      $(field).dataset.selectedLabel = $(field).value;
    }
  }
  updateFuelUI();
  setView("planner");
  persist();
  toast("Lane loaded. Find routes to use current road distances.");
}
async function saveTrip() {
  if (!$("origin").value || !$("destination").value)
    throw new Error("Enter origin and destination first.");
  const origin = await resolveField("origin"),
    destination = await resolveField("destination");
  const name = prompt(
    "Name this saved trip",
    `${$("origin").value} → ${$("destination").value}`,
  );
  if (!name) return;
  state.saved.unshift({
    id: crypto.randomUUID(),
    name,
    origin: $("origin").value,
    destination: $("destination").value,
    waypoints: $("waypoints").value.split("\n").map(clean).filter(Boolean),
    points: [origin, destination],
    form: formData(),
    source: "Saved trip",
  });
  await dbPut("saved", state.saved);
  toast("Trip saved in this browser.");
}
function renderLoads() {
  $("loadRows").innerHTML = state.loads
    .map(
      (l, i) =>
        `<tr><td>${h(l.id)}${l.pickupCluster ? `<small>Clusters ${l.pickupCluster} → ${l.deliveryCluster}</small>` : ""}</td><td>${h(l.pickup.label || `${l.pickup.lat}, ${l.pickup.lng}`)}<small>→ ${h(l.delivery.label || `${l.delivery.lat}, ${l.delivery.lng}`)}</small></td><td>${h(l.matches?.[0]?.name || "—")}</td><td>${h(l.status)}${l.plan ? `<small>${money(l.plan.cost)} · ${l.plan.stops.length} stops</small>` : ""}</td><td><button class="text-button" data-load="${i}">Review</button></td></tr>`,
    )
    .join("");
  $$("[data-load]").forEach(
    (b) =>
      (b.onclick = () => {
        const l = state.loads[Number(b.dataset.load)];
        $("origin").value = `${l.pickup.lat}, ${l.pickup.lng}`;
        $("destination").value = `${l.delivery.lat}, ${l.delivery.lng}`;
        $("waypoints").value = (
          [...state.saved, ...state.library].find(
            (x) => x.id === l.matches?.[0]?.id,
          )?.waypoints || []
        ).join("\n");
        for (const [k, v] of Object.entries(l.overrides)) $(k).value = v;
        markManual("origin", $("origin").value);
        updateFuelUI();
        setView("planner");
        if (l.plan) {
          verifyPlan(l.plan);
          state.plans = [l.plan];
          state.routes = [prepareRoute(l.plan.route)];
          state.selected = new Set([l.plan.route.id]);
          state.routeStamp = null;
          renderRouteCards();
          renderResults();
          drawMap();
          fitMap();
        }
      }),
  );
}
async function runBatch() {
  if (!state.fuel) throw new Error("Load current fuel prices first.");
  const eligible = state.loads.filter((l) => l.matches?.length);
  if (!eligible.length)
    throw new Error("Prepare and match loads before batch planning.");
  if (state.activeSolve) throw new Error("A plan is already running.");
  const rules = currentRules(),
    fuelSnapshot = state.fuel,
    options = routeOptions(),
    profile = $("routingProfile").value,
    controller = new AbortController();
  state.activeSolve = controller;
  try {
    for (let i = 0; i < eligible.length; i++) {
      const load = eligible[i];
      if (controller.signal.aborted) break;
      const lanes = load.matches
        .map((match) =>
          [...state.saved, ...state.library].find((l) => l.id === match.id),
        )
        .filter(Boolean);
      load.plan = null;
      load.status = "Planning";
      renderLoads();
      showProgress(
        `Load ${i + 1} of ${eligible.length} · ${load.id}`,
        (i / eligible.length) * 100,
      );
      try {
        const plans = [];
        const seenPaths = new Set();
        for (const lane of lanes) {
          if (controller.signal.aborted)
            throw new DOMException("Cancelled", "AbortError");
          const via = [];
          for (const text of lane.waypoints || [])
            via.push((await geocode(text))[0]);
          const pathKey = JSON.stringify(via.map((p) => [p.lat, p.lng]));
          if (seenPaths.has(pathKey)) continue;
          seenPaths.add(pathKey);
          const result = await api(
            "routes",
            { points: [load.pickup, ...via, load.delivery], profile, options },
            controller.signal,
          );
          for (const raw of result.routes) {
            const route = prepareRoute({
              ...raw,
              id: `${lane.id}:${raw.id}`,
              name: `${lane.name} · ${raw.name}`,
              options,
              trip: {
                origin:
                  load.pickup.label || `${load.pickup.lat}, ${load.pickup.lng}`,
                destination:
                  load.delivery.label ||
                  `${load.delivery.lat}, ${load.delivery.lng}`,
                truck: load.id,
                client: state.client,
              },
            });
            plans.push(
              await planRoute(
                route,
                { ...rules, ...load.overrides },
                controller.signal,
                () => {},
                fuelSnapshot,
              ),
            );
          }
        }
        const best = plans
          .filter((p) => p.status === "optimal")
          .sort((a, b) => a.cost - b.cost)[0];
        load.plan = best || null;
        load.status = best ? "Planned" : plans[0]?.reason || "No feasible plan";
      } catch (e) {
        if (e.name === "AbortError") throw e;
        load.status = e.message;
      }
      renderLoads();
      await dbPut("loads", state.loads);
    }
    $("batchStatus").textContent =
      `${state.loads.filter((l) => l.plan).length} loads planned. Results are saved in this browser.`;
  } finally {
    state.activeSolve = null;
    $("progress").hidden = true;
  }
}
function renderLog() {
  $("activityLog").innerHTML =
    state.log
      .map(
        (l) =>
          `<div class="log-row"><time>${h(new Date(l.time).toLocaleTimeString())}</time><span class="${l.type === "error" ? "error" : ""}">${h(l.message)}</span></div>`,
      )
      .join("") || '<p class="muted">New activity will appear here.</p>';
}
function renderHistory() {
  $("historyPlans").innerHTML = state.history
    .map(
      (p) =>
        `<div class="history-row"><div><strong>${h(p.trip.origin)} → ${h(p.trip.destination)}</strong><small>${h(p.trip.truck || "Manual")} · ${h(p.source)} · ${h(new Date(p.createdAt).toLocaleString())}</small></div><strong>${money(p.cost)}</strong><button class="secondary" data-history="${p.id}">Open</button></div>`,
    )
    .join("");
  $$("[data-history]").forEach(
    (b) =>
      (b.onclick = () => {
        const p = state.history.find((p) => p.id === b.dataset.history);
        verifyPlan(p);
        state.plans = [p];
        state.routes = [prepareRoute(p.route)];
        state.selected = new Set([p.route.id]);
        state.routeStamp = null;
        setView("planner");
        renderRouteCards();
        renderResults();
        drawMap();
        fitMap();
      }),
  );
}

async function readTableFile(file) {
  if (file.size > 15_000_000)
    throw new Error("Choose a file smaller than 15 MB.");
  if (!/\.xlsx$/i.test(file.name)) return parseCSV(await file.text());
  if (!window.ExcelJS)
    await new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "/vendor/exceljs.min.js";
      script.onload = resolve;
      script.onerror = () =>
        reject(
          new Error(
            "Excel reader could not load. Export CSV or check the deployment build.",
          ),
        );
      document.head.append(script);
    });
  const workbook = new window.ExcelJS.Workbook();
  await workbook.xlsx.load(await file.arrayBuffer());
  const sheets = workbook.worksheets.filter((s) => s.state !== "veryHidden");
  if (!sheets.length) throw new Error("No worksheets found.");
  let chosen = sheets[0];
  if (sheets.length > 1) {
    const index = await new Promise((resolve, reject) => {
      const dialog = $("workbookDialog");
      $("workbookSheet").innerHTML = sheets
        .map((s, i) => `<option value="${i}">${h(s.name)}</option>`)
        .join("");
      $("workbookUse").onclick = () => {
        dialog.returnValue = "use";
        dialog.close();
      };
      dialog.addEventListener(
        "close",
        () =>
          dialog.returnValue === "use"
            ? resolve(Number($("workbookSheet").value))
            : reject(new DOMException("Cancelled", "AbortError")),
        { once: true },
      );
      dialog.returnValue = "";
      dialog.showModal();
    });
    chosen = sheets[index];
  }
  if (chosen.rowCount > 100000)
    throw new Error("Use a worksheet with at most 100,000 rows.");
  const value = (v) =>
    v == null
      ? ""
      : v instanceof Date
        ? v.toISOString()
        : typeof v === "object"
          ? "result" in v
            ? value(v.result)
            : v.richText
              ? v.richText.map((r) => r.text).join("")
              : (v.text ?? "")
          : v;
  const table = [];
  chosen.eachRow({ includeEmpty: true }, (row) =>
    table.push(
      Array.from({ length: chosen.columnCount }, (_, i) =>
        value(row.getCell(i + 1).value),
      ),
    ),
  );
  return table;
}

function bindEvents() {
  $$(".nav").forEach((b) => (b.onclick = () => setView(b.dataset.view)));
  $("theme").onchange = () => applyTheme($("theme").value);
  $("settingsBtn").onclick = () => {
    $("settingsDialog").showModal();
  };
  $("sourceBtn").onclick = () => $("sourceDialog").showModal();
  $("findRoutes").onclick = action(findRoutes);
  $("solveRoutes").onclick = action(solveSelected);
  $("cancelSolve").onclick = () => state.activeSolve?.abort();
  $("loadFuel").onclick = action(loadMaster);
  $("master").onchange = action(loadMaster);
  $("loadCustomSheet").onclick = action(loadCustomSheet);
  $("fuelUpload").onchange = action(uploadFuel);
  $("truck").onchange = action(chooseTruck);
  $("truck").oninput = () => {
    if (state.vehicle && $("truck").value !== vehicleLabel(state.vehicle)) {
      state.vehicle = null;
      renderTelemetry();
      drawTruck();
    }
  };
  $("client").onchange = action(async () => {
    state.client = $("client").value;
    state.vehicle = null;
    state.vehicles = [];
    state.fleetSeq++;
    $("truck").value = "";
    $("trucks").innerHTML = "";
    $("origin").value = "";
    $("startFuel").value = "";
    $("fuelPercent").value = "";
    renderTelemetry();
    drawTruck();
    if (state.view === "fleet") renderFleet();
    persist();
    if (state.client) await loadFleet();
    else {
      $("connection").textContent = "Manual mode";
      $("connection").classList.remove("connected");
    }
  });
  $("useLive").onclick = () => {
    if (!state.vehicle) {
      toast("Choose a connected truck first.");
      return;
    }
    delete state.overrides[keyForVehicle()];
    applyLive(true);
    toast("Current live values applied. You can edit them again.");
  };
  FORM_IDS.filter((id) => id !== "truck").forEach((id) =>
    $(id).addEventListener("input", () => {
      if (
        ["capacity", "mpg", "origin", "startFuel", "fuelPercent"].includes(id)
      ) {
        markManual(id, $(id).value);
        if (id === "startFuel")
          delete state.overrides[keyForVehicle()].fuelPercent;
        if (id === "fuelPercent")
          delete state.overrides[keyForVehicle()].startFuel;
      }
      if (
        id === "capacity" &&
        state.vehicle &&
        state.vehicle.fuelPercent !== null &&
        manualEdits().startFuel === undefined &&
        manualEdits().fuelPercent === undefined
      ) {
        $("startFuel").value = (
          (Number($("capacity").value) * state.vehicle.fuelPercent) /
          100
        ).toFixed(2);
      }
      updateFuelUI(id);
      persist();
    }),
  );
  $$(".search-place").forEach(
    (b) => (b.onclick = action(() => searchPlace(b.dataset.field))),
  );
  for (const id of ["origin", "destination"])
    $(id).addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        action(() => searchPlace(id))(e);
      }
    });
  $("streetBtn").onclick = action(() => setMapMode("map"));
  $("satelliteBtn").onclick = action(() => setMapMode("satellite"));
  $("heatBtn").onclick = () => {
    state.heat = !state.heat;
    persist();
    drawMap();
  };
  $("fitBtn").onclick = fitMap;
  $("fullscreenBtn").onclick = action(async () => {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await $("mapShell").requestFullscreen();
    setTimeout(() => state.map?.invalidateSize(), 50);
  });
  for (const id of [
    "pumpSearch",
    "stateFilter",
    "priceSort",
    "routeOnly",
    "highwaySearch",
  ])
    $(id).addEventListener(
      id === "pumpSearch" || id === "highwaySearch" ? "input" : "change",
      () => {
        renderPumps();
        drawMap();
      },
    );
  $("clearHighways").onclick = () => {
    state.highways.clear();
    renderPumps();
    drawMap();
  };
  $("fuelExport").onclick = () =>
    download(
      "fco-fuel-pumps.csv",
      toCSV([
        [
          "pump_name",
          "price_per_gallon",
          "latitude",
          "longitude",
          "city",
          "state",
          "brand",
          "store_number",
          "highway",
          "exit",
        ],
        ...visiblePumps().map((p) => [
          p.name,
          p.price,
          p.lat,
          p.lng,
          p.city,
          p.state,
          p.brand,
          p.store,
          p.highway,
          p.exit,
        ]),
      ]),
      "text/csv",
    );
  $("fleetSearch").oninput = renderFleet;
  $("refreshFleet").onclick = action(loadFleet);
  $("saveRoute").onclick = action(saveTrip);
  $("resetTrip").onclick = () => {
    if (
      !confirm(
        "Clear this trip? Saved trips, fuel data and history will remain.",
      )
    )
      return;
    state.routes = [];
    state.plans = [];
    state.vehicle = null;
    state.routeStamp = null;
    for (const id of ["origin", "destination", "waypoints", "truck"])
      $(id).value = "";
    $("routeCards").innerHTML =
      '<div class="empty-state"><p>Enter your next trip and find routes.</p></div>';
    $("results").innerHTML = "";
    $("solveBar").hidden = true;
    state.connectorLayer?.clearLayers();
    renderTelemetry();
    drawMap();
    persist();
  };
  $("copyResultMessage").onclick = action(() => copy($("resultMessage").value));
  for (const id of ["resultDriver", "resultPartner"])
    $(id).oninput = updateResultMessage;
  $("addPair").onclick = () => {
    state.pairs.push({ a: "", b: "" });
    renderMessages();
  };
  for (const id of [
    "messageDriver",
    "messagePartner",
    "messageRoute",
    "messageInstruction",
  ])
    $(id).oninput = updateCustomMessage;
  $("copyCustomMessage").onclick = action(() =>
    copy(customMessage(messageInputs())),
  );
  $("clearMessage").onclick = () => {
    state.pairs = [{ a: "", b: "" }];
    for (const id of ["messageDriver", "messagePartner", "messageRoute"])
      $(id).value = "";
    renderMessages();
  };
  $("loadMessageMaster").onclick = action(async () => {
    const id = $("messageMaster").value;
    if (!id) {
      state.messageRows = null;
    } else {
      const r = await api("messages", { masterId: id });
      state.messageRows = r.rows;
    }
    state.pairs = [{ a: "", b: "" }];
    renderMessages();
  });
  $("messageUpload").onchange = action(async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    state.messageRows = parseMessageTable(await readTableFile(file), file.name);
    state.pairs = [{ a: "", b: "" }];
    renderMessages();
    e.target.value = "";
  });
  $("messageSheetBtn").onclick = action(async () => {
    const url = prompt("Google Sheet URL for message locations");
    if (!url) return;
    const r = await api("messages", { url, label: "Custom message sheet" });
    state.messageRows = r.rows;
    state.pairs = [{ a: "", b: "" }];
    renderMessages();
  });
  $("loadUpload").onchange = action(async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    state.loads = parseLoads(await readTableFile(file));
    await dbPut("loads", state.loads);
    $("batchStatus").textContent = `${state.loads.length} loads imported.`;
    renderLoads();
    e.target.value = "";
  });
  $("prepareLoads").onclick = action(async () => {
    state.loads = prepareLoads(
      state.loads,
      [...state.saved, ...state.library],
      Number($("clusterRadius").value),
    );
    await dbPut("loads", state.loads);
    $("batchStatus").textContent =
      `${state.loads.filter((l) => l.matches.length).length} of ${state.loads.length} loads match a saved lane by actual endpoint distance.`;
    renderLoads();
  });
  $("runBatch").onclick = action(runBatch);
  $("exportLoads").onclick = () =>
    download(
      "fco-load-results.csv",
      toCSV([
        [
          "Load ID",
          "Pickup",
          "Delivery",
          "Pickup cluster",
          "Delivery cluster",
          "Lane",
          "Status",
          "Fuel cost",
          "Gallons",
          "Stops",
          "Ending fuel",
        ],
        ...state.loads.map((l) => [
          l.id,
          l.pickup.label,
          l.delivery.label,
          l.pickupCluster,
          l.deliveryCluster,
          l.matches?.[0]?.name,
          l.status,
          l.plan?.cost,
          l.plan?.gallons,
          l.plan?.stops.length,
          l.plan?.endFuel,
        ]),
      ]),
      "text/csv",
    );
  $("exportLibrary").onclick = () =>
    download(
      "fco-saved-routes.json",
      JSON.stringify(state.saved, null, 2),
      "application/json",
    );
  $("clearLog").onclick = () => {
    state.log = [];
    renderLog();
  };
  $("refreshConfig").onclick = action(async () => {
    await loadConfig();
    toast("Master registry refreshed.");
  });
  $("exportBackup").onclick = () =>
    download(
      "fco-workspace-backup.json",
      JSON.stringify(
        {
          version: 1,
          settings: JSON.parse(localStorage.getItem(STATE_KEY) || "{}"),
          fuel: state.fuel,
          saved: state.saved,
          history: state.history,
          loads: state.loads,
          messages: {
            rows: state.messageRows,
            pairs: state.pairs,
            master: $("messageMaster").value,
            fields: Object.fromEntries(
              [
                "messageDriver",
                "messagePartner",
                "messageRoute",
                "messageInstruction",
              ].map((id) => [id, $(id).value]),
            ),
          },
        },
        null,
        2,
      ),
      "application/json",
    );
  $("restoreBackup").onchange = action(async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const data = JSON.parse(await file.text());
    if (
      data.version !== 1 ||
      !Array.isArray(data.saved) ||
      !Array.isArray(data.history)
    )
      throw new Error("This is not a supported FCO workspace backup.");
    for (const p of data.history) verifyPlan(p);
    if (!confirm("Restore this backup over the current browser workspace?"))
      return;
    await dbPut("saved", data.saved);
    await dbPut("history", data.history);
    await dbPut("loads", data.loads || []);
    if (data.messages) await dbPut("messages", data.messages);
    if (data.fuel) await dbPut("fuel", data.fuel);
    localStorage.setItem(STATE_KEY, JSON.stringify(data.settings || {}));
    location.reload();
  });
}
async function bootstrap() {
  for (const [id, value] of Object.entries(restored.form || {})) {
    if (FORM_IDS.includes(id))
      $(id).type === "checkbox"
        ? ($(id).checked = !!value)
        : ($(id).value = value);
  }
  document.documentElement.dataset.theme = restored.theme || "light";
  $("theme").value = restored.theme || "light";
  bindEvents();
  updateFuelUI();
  createMap();
  const [fuel, saved, history, loads, access, library, messages] =
    await Promise.all([
      dbGet("fuel"),
      dbGet("saved"),
      dbGet("history"),
      dbGet("loads"),
      dbGet("access"),
      fetch("/route-library.json")
        .then((r) => r.json())
        .catch(() => []),
      dbGet("messages"),
    ]);
  state.saved = saved || [];
  state.history = history || [];
  state.loads = loads || [];
  state.accessCache = new Map(access || []);
  state.library = library;
  if (messages) {
    state.messageRows = messages.rows;
    state.pairs = messages.pairs || [{ a: "", b: "" }];
    state.messageMasterId = messages.master || "";
    for (const [id, value] of Object.entries(messages.fields || {})) {
      if ($(id)) $(id).value = value;
    }
  }
  if (fuel) await applyFuel(fuel, state.sourcePrefs);
  setView(
    ["planner", "fleet", "pumps", "library", "messages", "activity"].includes(
      location.hash.slice(1),
    )
      ? location.hash.slice(1)
      : "planner",
  );
  try {
    await loadConfig(true);
    await loadFleet();
  } catch (e) {
    $("settingsStatus").textContent = e.message;
    log(e.message, "warning");
    $("connection").textContent = "Manual mode · connection unavailable";
    $("connection").classList.remove("connected");
  }
  let refreshing = false;
  const refresh = async () => {
    if (refreshing) return;
    refreshing = true;
    try {
      await loadConfig();
      const updates = await Promise.allSettled([
        loadFleet(),
        refreshFuelSource(),
      ]);
      for (const update of updates)
        if (update.status === "rejected") throw update.reason;
    } catch (e) {
      $("connection").textContent =
        "Last values retained · refresh unavailable";
      $("connection").classList.remove("connected");
      log(e.message, "warning");
    } finally {
      refreshing = false;
    }
  };
  setInterval(refresh, 60000);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") refresh();
  });
  log(
    "Workspace ready. Live data refreshes every 60 seconds while this app is open.",
  );
}
function registerWorkspaceTools() {
  const context = document.modelContext;
  if (!context?.registerTool) return;
  const lifecycle = new AbortController();
  window.addEventListener("pagehide", () => lifecycle.abort(), { once: true });
  const tools = [
    {
      name: "read_fco_workspace",
      description:
        "Read current trip inputs, selected fuel source and calculated plan summaries.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, untrustedContentHint: true },
      execute: () => ({
        inputs: formData(),
        source: state.fuel?.source || null,
        client: state.client,
        selectedRoutes: [...state.selected],
        plans: state.plans.map((p) => ({
          status: p.status,
          cost: p.cost,
          stops: p.stops?.length,
          endFuel: p.endFuel,
          reason: p.reason,
        })),
      }),
    },
    {
      name: "stage_fco_trip_inputs",
      description:
        "Edit visible trip inputs. Does not find routes or calculate a plan.",
      inputSchema: {
        type: "object",
        properties: { values: { type: "object" } },
        required: ["values"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, untrustedContentHint: false },
      execute: (input) => {
        if (
          !input ||
          typeof input.values !== "object" ||
          Array.isArray(input.values) ||
          !input.values
        )
          throw new Error("Supply a values object.");
        const entries = Object.entries(input.values);
        for (const [id, value] of entries) {
          if (
            !FORM_IDS.includes(id) ||
            ["object", "function", "undefined"].includes(typeof value)
          )
            throw new Error("Unknown or invalid trip input.");
          const el = $(id);
          if (
            el.tagName === "SELECT" &&
            ![...el.options].some((o) => o.value === String(value))
          )
            throw new Error("Unknown selection.");
          if (
            el.type === "number" &&
            (number(value) === null || Number(value) < Number(el.min || 0))
          )
            throw new Error("Invalid numeric input.");
        }
        for (const [id, value] of entries) {
          const el = $(id);
          if (el.type === "checkbox") el.checked = !!value;
          else el.value = String(value);
          el.dispatchEvent(new Event("input", { bubbles: true }));
        }
        return { inputs: formData() };
      },
    },
    {
      name: "find_fco_routes",
      description:
        "Find road routes from the current visible trip inputs and update the map.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, untrustedContentHint: true },
      execute: async () => {
        await findRoutes();
        return {
          routes: state.routes.map((r) => ({
            id: r.id,
            name: r.name,
            miles: r.distance,
            seconds: r.duration,
          })),
        };
      },
    },
    {
      name: "calculate_fco_fuel_plans",
      description:
        "Calculate fuel plans for the selected routes using current fuel prices and rules, and update results.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, untrustedContentHint: true },
      execute: async () => {
        await solveSelected();
        return {
          plans: state.plans.map((p) => ({
            status: p.status,
            cost: p.cost,
            stops: p.stops?.length,
            endFuel: p.endFuel,
            reason: p.reason,
          })),
        };
      },
    },
  ];
  for (const tool of tools) {
    try {
      Promise.resolve(
        context.registerTool(tool, { signal: lifecycle.signal }),
      ).catch(() => {});
    } catch {}
  }
}
bootstrap()
  .then(registerWorkspaceTools)
  .catch((e) => {
    notice(e.message);
    log(e.message, "error");
  });
