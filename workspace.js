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
import { MessageEditor } from "./message-editor.js";
import { bindPlaceSearch } from "./place-search.js";
import { HybridReference } from "./hybrid-map.js";
import { activeVehicles, searchStops, stopMapRows, stopNumber, mergeVehicleDetail, routeHighways, vehicleIconHTML } from "./view-model.js";

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
const uiText = (value) => String(value ?? "").replace(/\bPumps\b/g, "Stops").replace(/\bPump\b/g, "Stop").replace(/\bpumps\b/g, "stops").replace(/\bpump\b/g, "stop");
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
  highways: new Set(restored.stopView?.highways || []),
  focusedPump: restored.stopView?.selectedId ? { id: restored.stopView.selectedId } : null,
  pendingStopState: restored.stopView?.state || "",
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
  detailCache: new Map(),
  detailPending: new Map(),
  focusedTruck: null,
  waypointItems: [],
  findSeq: 0,
  planMessageDrafts: new Map(),
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
        stopView: {
          query: $("pumpSearch").value,
          state: $("stateFilter").value || state.pendingStopState,
          highways: [...state.highways],
          highwaySearch: $("highwaySearch").value,
          sort: $("priceSort").value,
          selectedId: state.focusedPump?.id || null,
        },
      }),
    );
  } catch {
    toast("Preferences could not be saved in this browser.");
  }
}
function toast(message) {
  $("toast").textContent = uiText(message);
  $("toast").hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => ($("toast").hidden = true), 4500);
}
function notice(message) {
  $("notice").hidden = !message;
  if (message)
    $("notice").innerHTML =
      `<span>${h(uiText(message))}</span><button class="text-button" id="dismissNotice" aria-label="Dismiss notice">×</button>`;
  if ($("dismissNotice")) $("dismissNotice").onclick = () => notice("");
}
function log(message, type = "info") {
  state.log.unshift({ message: uiText(message), type, time: new Date().toISOString() });
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
      if (button?.id === "solveRoutes") updateRouteStatus();
    }
  };
}
function setView(view) {
  // Hide only the Routes & Loads surface. Its data and functions stay intact.
  if (view === "library") view = "planner";
  if (view === "stops") view = "pumps";
  if (state.view !== view) { state.openStopId = null; state.map?.closePopup?.(); }
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
  $("heatBtn").hidden = view === "fleet";
  $("mapCaption").hidden = view === "fleet";
  $("solveBar").hidden = view !== "planner";
  if (view === "fleet" || view === "planner") hydrateVisibleVehicles();
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
    state.client,
    $("truck").value.trim(),
    $("origin").value.trim(),
    $("destination").value.trim(),
    $("waypoints").value.trim(),
    $("routingProfile").value,
    routeOptions(),
  ]);
}
function updateRouteStatus() {
  const stale = state.routes.length && state.routeStamp !== tripStamp();
  $("routeInputStatus").textContent = stale
    ? "Truck, locations or routing settings changed. Find routes again."
    : state.routes.length ? "Routes ready. Fuel changes only need Fuelio Hunt." : "Choose your locations, then find routes.";
  $("routeInputStatus").classList.toggle("error", !!stale);
  $("solveRoutes").disabled = !!state.activeSolve || !state.routes.length || !state.selected.size || !!stale;
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
  state.messageEditor?.setMasters(r.messageMasters);
  state.resultEditor?.setMasters(r.messageMasters);
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
  return activeVehicles(state.vehicles).filter((v) => v.name === vehicle.name).length > 1
    ? `${vehicle.name} · ${vehicle.id}`
    : vehicle.name;
}
function findTruck(value) {
  const exact = activeVehicles(state.vehicles).find((v) => vehicleLabel(v) === value);
  if (exact) return exact;
  const unit = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
  if (!unit) return null;
  const matches = activeVehicles(state.vehicles).filter((v) => {
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
  const vehicles = activeVehicles(result.vehicles);
  $("trucks").innerHTML = vehicles
    .map(
      (v) =>
        `<option value="${h(vehicleLabel(v))}" label="${h([v.make, v.model].filter(Boolean).join(" "))}"></option>`,
    )
    .join("");
  if (state.vehicle) {
    const next = vehicles.find((v) => v.id === state.vehicle.id);
    if (next) {
      state.vehicle = { ...state.vehicle, ...next };
      applyLive();
    } else {
      state.vehicle = null;
      $("truck").value = "";
      renderTelemetry();
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
    `${vehicles.length} trucks · ${result.partial ? "partial data · see Activity" : "live every 60 sec"}`;
  $("connection").classList.toggle("connected", !result.partial);
  if (result.warnings.length) log(result.warnings.join(" "), "warning");
  drawTruck();
  if (state.view === "fleet") renderFleet();
  // Optional reports must not block the truck list or the next fleet refresh.
  if (state.vehicle) void loadVehicleDetail().catch((error) => log(error.message, "warning"));
  hydrateVisibleVehicles();
  updateRouteStatus();
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
  updateRouteStatus();
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
  updateRouteStatus();
}
function displayedVehicle(vehicle) {
  return mergeVehicleDetail(vehicle, state.detailCache.get(`${state.client}:${vehicle.id}`)?.data);
}
async function fetchVehicleDetail(vehicle, force = false) {
  const client = state.client, key = `${client}:${vehicle.id}`;
  if (!client) return null;
  const entry = state.detailCache.get(key);
  const ttl = number(vehicle.fuelPercent) === null || number(entry?.data?.mpg) === null ? 55000 : 15 * 60000;
  if (entry && Date.now() - entry.at < (force ? 55000 : ttl)) return entry.data;
  if (state.detailPending.has(key)) return state.detailPending.get(key);
  const job = (async () => {
    try {
      const data = await api(`vehicle-detail?client=${encodeURIComponent(client)}&vehicle=${encodeURIComponent(vehicle.id)}`);
      state.detailCache.set(key, { data, at: Date.now() });
      if (client === state.client) {
        if (state.vehicle?.id === vehicle.id) { state.vehicle = mergeVehicleDetail(state.vehicle, data); applyLive(); }
        if (state.view === "fleet") renderFleet();
        drawTruck();
      }
      return data;
    } catch (error) {
      // Retain known telemetry; failed optional reports never invent zero fuel or MPG.
      state.detailCache.set(key, { data: entry?.data || {}, at: Date.now() });
      log(`${vehicle.name}: ${error.message}`, "warning");
      return entry?.data || null;
    } finally { state.detailPending.delete(key); }
  })();
  state.detailPending.set(key, job);
  return job;
}
async function loadVehicleDetail() {
  if (!state.vehicle || !state.client) return;
  const id = state.vehicle.id, client = state.client;
  const d = await fetchVehicleDetail(state.vehicle, true);
  if (d && state.client === client && state.vehicle?.id === id) {
    state.vehicle = mergeVehicleDetail(state.vehicle, d);
    applyLive();
  }
  if (d?.warnings?.length) log(d.warnings.join(" "), "warning");
}
let hydrationJob = null;
function hydrateVisibleVehicles() {
  if (!state.client || !["fleet", "planner"].includes(state.view)) return;
  if (hydrationJob?.client === state.client) return;
  const client = state.client;
  const queue = activeVehicles(state.vehicles).filter((v) => {
    const cached = state.detailCache.get(`${client}:${v.id}`);
    return !cached || Date.now() - cached.at >= (number(v.fuelPercent) === null || number(cached.data?.mpg) === null ? 55000 : 15 * 60000);
  });
  if (!queue.length) return;
  queue.sort((a, b) => Number(b.id === state.vehicle?.id || b.id === state.focusedTruck) - Number(a.id === state.vehicle?.id || a.id === state.focusedTruck));
  const job = { client };
  hydrationJob = job;
  const run = async () => {
    while (queue.length && client === state.client && ["fleet", "planner"].includes(state.view)) {
      const vehicle = queue.shift();
      await fetchVehicleDetail(vehicle);
    }
  };
  // Optional detail reports are paced at two concurrent requests, separate from 60s snapshots.
  void Promise.all([run(), run()]).finally(() => { if (hydrationJob === job) hydrationJob = null; });
}
function renderTelemetry() {
  const v = state.vehicle;
  $("telemetryDetails").hidden = !v;
  if (!v) return;
  $("telemetryTitle").textContent = v.name;
  $("liveTime").textContent = v.gpsTime ? new Date(v.gpsTime).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "GPS unavailable";
  if ($("telemetryBody").contains(document.activeElement)) return;
  const actual = displayedVehicle(v);
  $("telemetryBody").innerHTML = `<div class="compact-telemetry">
    <label>Speed · MPH<input data-compact="speed" type="number" min="0" step="1" value="${h(manualEdits()["live-speed"] ?? actual.speed ?? "")}" placeholder="—"></label>
    <label>Fuel · %<input data-compact="fuel" type="number" min="0" max="100" step="0.01" value="${h($("fuelPercent").value)}" placeholder="—"></label>
    <label>MPG<input data-compact="mpg" type="number" min=".1" step=".01" value="${h($("mpg").value)}" placeholder="—"></label>
    </div><p class="telemetry-source">Live fuel: ${number(actual.fuelPercent) === null ? "—" : fmt(number(actual.fuelPercent), 1) + "%"}${actual.fuelSource === "history" ? " · history fallback" : ""} · MPG: ${number(actual.mpg) === null ? "not supplied" : fmt(number(actual.mpg), 2)}</p>`;
  $$("[data-compact]").forEach((el) => el.oninput = () => {
    if (el.dataset.compact === "speed") markManual("live-speed", el.value);
    else {
      const target = $(el.dataset.compact === "fuel" ? "fuelPercent" : "mpg");
      target.value = el.value;
      target.dispatchEvent(new Event("input", { bubbles: true }));
    }
  });
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
  $("sourceBadge").textContent = `${data.source} · ${data.rows.length} stops`;
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
  log(`Loaded ${data.rows.length} stops from ${data.source}.`);
  renderMessages();
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
    state.openStopId = null;
    state.map.closePopup?.();
    for (const marker of [...(state.pumpMarkers?.values() || []), ...(state.truckMarkers?.values() || [])]) marker.closeTooltip?.();
    if (state.view !== "planner") return;
    const mode = $("mapClick").value;
    if (mode === "none") return;
    const text = `${e.latlng.lat.toFixed(6)}, ${e.latlng.lng.toFixed(6)}`;
    if (mode === "waypoint") {
      if (state.waypointItems.length >= 23) { toast("Use no more than 23 waypoints."); return; }
      state.waypointItems.push({ id: crypto.randomUUID(), value: text });
      renderWaypoints(); syncWaypoints();
    }
    else {
      $(mode).value = text;
      if (mode === "origin") markManual("origin", text);
    }
    persist();
    updateRouteStatus();
    toast(
      mode === "waypoint"
        ? "Waypoint added."
        : `${mode === "origin" ? "Origin" : "Destination"} selected.`,
    );
  });
  setMapMode(state.mapMode);
  if (typeof ResizeObserver !== "undefined") {
    state.mapResizeObserver = new ResizeObserver(() => {
      cancelAnimationFrame(state.mapResizeFrame);
      state.mapResizeFrame = requestAnimationFrame(() => state.map?.invalidateSize({ pan: false }));
    });
    state.mapResizeObserver.observe($("map"));
  }
}
async function setMapMode(mode) {
  if (!state.map) return;
  state.mapMode = mode;
  $("streetBtn").classList.toggle("active", mode === "map");
  $("satelliteBtn").classList.toggle("active", mode === "satellite");
  $("mapShell").classList.toggle("satellite", mode === "satellite");
  state.map.removeLayer(state.base);
  if (!state.hybridReference)
    state.hybridReference = new HybridReference(state.map, L, (message) => log(message, "warning"));
  state.hybridReference.hide();
  if (mode === "satellite") {
    state.base = L.tileLayer(
      "https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}",
      {
        maxZoom: 19,
        maxNativeZoom: 16,
        attribution: 'Imagery: <a href="https://www.usgs.gov/programs/national-geospatial-program/national-map">USGS</a>',
      },
    ).addTo(state.map);
    void state.hybridReference.show();
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
  return `<div class="map-details"><strong>${h(p.name)}</strong><br>${h(p.location || [p.city, p.state].filter(Boolean).join(", "))}<br><b>$${number(p.price) === null ? "—" : Number(p.price).toFixed(4)} / gal</b><br>Highway: ${h(p.highway || "—")} · Exit: ${h(p.exit || "—")}<br><small>${number(p.lat) === null ? "—" : Number(p.lat).toFixed(5)}, ${number(p.lng) === null ? "—" : Number(p.lng).toFixed(5)}</small></div>`;
}
function visiblePumps() {
  return searchStops(currentPumps(), { query: $("pumpSearch").value, state: $("stateFilter").value, highways: state.highways, sort: $("priceSort").value });
}
function pumpsOnMap() {
  return stopMapRows(currentPumps(), visiblePumps(), state.highways);
}
function drawMap() {
  if (!state.map) return;
  state.redrawingMap = true;
  state.routeLayer.clearLayers(); state.pointLayer.clearLayers(); state.pumpLayer.clearLayers();
  state.pumpMarkers = new Map();
  const planning = state.view === "planner", routes = planning ? state.routes : [];
  if (state.connectorLayer) {
    if (planning && !state.map.hasLayer(state.connectorLayer)) state.connectorLayer.addTo(state.map);
    else if (!planning) state.map.removeLayer(state.connectorLayer);
  }
  routes.forEach((r, i) => {
    L.polyline(r.points, { color: colours[i % colours.length], weight: state.selected.has(r.id) ? 5 : 3, opacity: state.selected.has(r.id) ? .9 : .3 })
      .addTo(state.routeLayer).on("click", () => {
        state.selected.has(r.id) ? state.selected.delete(r.id) : state.selected.add(r.id);
        renderRouteCards(); drawMap();
      });
  });
  if (routes.length) {
    const r = routes[0];
    for (const [p, label] of [[r.points[0], "A"], [r.points.at(-1), "B"]])
      L.marker([p.lat, p.lng], { icon: L.divIcon({ className: "", html: `<span class="point-label">${label}</span>`, iconSize: [28,28], iconAnchor: [14,14] }) }).addTo(state.pointLayer);
  }
  const nearby = routes.filter((r) => state.selected.has(r.id)).flatMap((r) => r.candidates || routeCandidates(r, currentPumps(), Number($("corridor").value)));
  const pumps = state.view === "fleet" ? [] : state.view === "pumps" ? pumpsOnMap() : routes.length ? [...new Map(nearby.map((p) => [p.pumpId, p])).values()] : currentPumps();
  state.displayedPumps = pumps;
  const prices = pumps.map((p) => p.price), min = prices.reduce((a,b) => Math.min(a,b), Infinity), max = prices.reduce((a,b) => Math.max(a,b), -Infinity);
  const picked = new Set(planning ? state.plans.filter((p) => p.status === "optimal").flatMap((p) => p.stops.map((s) => s.pumpId || s.id)) : []);
  for (const p of pumps) {
    const id = p.pumpId || p.id, recommended = picked.has(id), focused = state.view === "pumps" && state.focusedPump?.id === id;
    const ratio = max > min ? (p.price - min)/(max - min) : .5;
    const colour = recommended ? "#2457da" : state.heat ? `hsl(${145 - ratio * 145} 60% 42%)` : "#4d927b";
    const marker = L.circleMarker([p.lat, p.lng], { radius: recommended || focused ? 8 : 5, weight: recommended || focused ? 3 : 1.2, color: focused ? "#142d53" : "#fff", fillColor: colour, fillOpacity: .9 })
      .bindPopup(popup(p)).bindTooltip(popup(p), { direction: "top", className: "stop-tooltip", sticky: true }).addTo(state.pumpLayer);
    state.pumpMarkers.set(id, marker);
    marker.on("click", () => focusPump(id, true));
    marker.on("popupclose", () => { if (!state.redrawingMap && state.openStopId === id) state.openStopId = null; });
  }
  $("heatBtn").hidden = state.view === "fleet";
  $("heatBtn").classList.toggle("active", state.heat);
  $("heatBtn").setAttribute("aria-pressed", String(state.heat));
  $("priceLegend").hidden = state.view === "fleet" || !state.heat || !pumps.length;
  if (pumps.length) $("priceLegend").innerHTML = `Price / gal<div class="ramp"></div>${money(min)} — ${money(max)}`;
  $("mapCaption").hidden = state.view === "fleet";
  $("mapCaption").textContent = routes.length ? `${routes.length} routes · ${pumps.length} nearby stops · ${state.fuel?.source || "load fuel data"}` : `${pumps.length} stops · ${state.fuel?.source || "No fuel data loaded"}`;
  drawTruck();
  if (state.openStopId) state.pumpMarkers.get(state.openStopId)?.openPopup?.();
  state.redrawingMap = false;
}
function vehiclePopup(raw) {
  const v = displayedVehicle(raw);
  return `<div class="map-details"><strong>${h(v.name)}</strong><br>${h(v.location || "Location not supplied")}<br>${number(v.speed) === null ? "— MPH" : fmt(number(v.speed), 0) + " MPH"}<br>Fuel: ${number(v.fuelPercent) === null ? "—" : fmt(number(v.fuelPercent), 0) + "%"} | MPG: ${number(v.mpg) === null ? "—" : fmt(number(v.mpg), 2)}${v.fuelSource === "history" ? "<br><small>Fuel from last available history" + (v.fuelTime ? " · " + h(new Date(v.fuelTime).toLocaleString()) : "") + "</small>" : ""}</div>`;
}
function fleetRows() {
  const q = $("fleetSearch").value.toLowerCase().trim();
  return activeVehicles(state.vehicles).filter((v) => `${v.name} ${v.vin || ""} ${v.location || ""}`.toLowerCase().includes(q));
}
function drawTruck() {
  if (!state.truckLayer) return;
  const kind = state.view === "fleet" ? "rocket" : "ufo";
  if (!state.truckMarkers || state.truckKind !== kind || state.truckClient !== state.client) { state.truckLayer.clearLayers(); state.truckMarkers = new Map(); state.truckKind = kind; state.truckClient = state.client; }
  const active = activeVehicles(state.vehicles);
  const planningTruckOnly = state.routes.length > 0 || state.plans.length > 0;
  const list = state.view === "fleet" ? fleetRows() : state.view === "planner"
    ? planningTruckOnly ? active.filter((v) => v.id === state.vehicle?.id) : active
    : [];
  const ids = new Set(list.filter((v) => number(v.lat) !== null && number(v.lng) !== null).map((v) => v.id));
  for (const [id, marker] of state.truckMarkers) if (!ids.has(id)) { state.truckLayer.removeLayer?.(marker); state.truckMarkers.delete(id); }
  for (const v of list) {
    if (!ids.has(v.id)) continue;
    const icon = L.divIcon({ className: "vehicle-marker", html: vehicleIconHTML(v, kind, state.view === "fleet" ? state.focusedTruck === v.id : state.vehicle?.id === v.id), iconSize: kind === "rocket" ? [44,44] : [30,30], iconAnchor: kind === "rocket" ? [22,22] : [15,15] });
    let marker = state.truckMarkers.get(v.id);
    if (marker) {
      marker.setLatLng([v.lat,v.lng]); marker.setIcon?.(icon);
      marker.setPopupContent?.(vehiclePopup(v)); marker.setTooltipContent?.(vehiclePopup(v));
    } else {
      marker = L.marker([v.lat,v.lng], { icon, title: v.name, keyboard: true })
        .bindPopup(vehiclePopup(v)).bindTooltip(vehiclePopup(v), { direction: "top", className: "vehicle-tooltip" }).addTo(state.truckLayer);
      marker.on("click", () => {
        if (state.view === "fleet") focusTruck(v.id);
        // Planner markers are information-only: never change the selected trip truck.
        else { const current = state.vehicles.find((item) => item.id === v.id); if (current) void fetchVehicleDetail(current); }
      });
      marker.on("mouseover", () => { const current = state.vehicles.find((item) => item.id === v.id); if (current) void fetchVehicleDetail(current); });
      state.truckMarkers.set(v.id, marker);
    }
  }
}
function focusTruck(id) {
  const v = activeVehicles(state.vehicles).find((v) => v.id === id);
  if (!v) return;
  state.focusedTruck = id; renderFleet(); drawTruck();
  if (number(v.lat) !== null && number(v.lng) !== null && state.map) {
    const zoom = Math.max(10, state.map.getZoom?.() || 4);
    if (state.map.flyTo) state.map.flyTo([v.lat,v.lng], zoom); else state.map.setView([v.lat,v.lng], zoom);
    state.truckMarkers.get(id)?.openPopup?.();
  } else toast("This truck has no current GPS coordinates.");
  void fetchVehicleDetail(v);
}
function renderFleet() {
  const rows = fleetRows();
  $("fleetCount").textContent = `${rows.length} of ${activeVehicles(state.vehicles).length} trucks · ${$("client").selectedOptions[0]?.textContent || "Manual mode"}`;
  $("fleetRows").innerHTML = rows.map((raw) => {
    const v = displayedVehicle(raw);
    return `<tr tabindex="0" role="button" data-fleet-row="${h(v.id)}" aria-label="Locate ${h(v.name)}" class="${state.focusedTruck === v.id ? "focused-truck" : ""}"><td class="fleet-name"><strong>${h(v.name)}</strong></td><td class="fleet-location">${h(v.location || "Location not supplied")}</td><td><small>FUEL</small>${number(v.fuelPercent) === null ? "—" : fmt(number(v.fuelPercent), 0) + "%"}${v.fuelSource === "history" ? '<small title="' + h(v.fuelTime || "") + '">history fallback</small>' : ""}</td><td><small>MPG</small>${number(v.mpg) === null ? "—" : fmt(number(v.mpg), 2)}</td><td><small>SPEED</small>${number(v.speed) === null ? "—" : fmt(number(v.speed), 0) + " MPH"}</td><td class="fleet-odo"><small>ODOMETER</small>${number(v.odometer) === null ? "—" : fmt(number(v.odometer), 0) + " mi"}</td><td class="fleet-time"><small>GPS</small>${v.gpsTime ? h(new Date(v.gpsTime).toLocaleString()) : "Not supplied"}</td></tr>`;
  }).join("") || '<tr><td colspan="7" class="empty-list">No active trucks match this view.</td></tr>';
  $$("[data-fleet-row]").forEach((row) => {
    row.onclick = () => focusTruck(row.dataset.fleetRow);
    row.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); focusTruck(row.dataset.fleetRow); } };
  });
}
function fitMap() {
  if (!state.map) return;
  const points = state.view === "fleet" ? fleetRows().filter((v) => number(v.lat) !== null && number(v.lng) !== null)
    : state.view === "pumps" ? pumpsOnMap()
    : state.routes.length ? state.routes.filter((r) => state.selected.has(r.id)).flatMap((r) => r.points) : currentPumps();
  if (points.length) state.map.fitBounds(L.latLngBounds(points.map((p) => [p.lat,p.lng])), { padding: [35,65], maxZoom: 12 });
  else state.map.setView([38,-97],4);
}
function focusPump(id, fromMarker = false) {
  const p = currentPumps().find((p) => p.id === id) || state.displayedPumps?.find((p) => (p.pumpId || p.id) === id);
  if (!p) return;
  if (fromMarker && state.view === "pumps" && !state.highways.size && !visiblePumps().some((row) => row.id === id)) {
    $("pumpSearch").value = ""; $("stateFilter").value = "";
  }
  state.focusedPump = { ...p, id }; state.openStopId = id;
  persist();
  if (state.view === "pumps") renderPumps();
  $$("[data-pump-row]").forEach((row) => row.classList.toggle("focused-pump", row.dataset.pumpRow === id));
  if (state.view === "pumps") for (const [markerId, marker] of state.pumpMarkers || []) marker.setStyle?.({ radius: markerId === id ? 8 : 5, weight: markerId === id ? 3 : 1.2, color: markerId === id ? "#142d53" : "#fff" });
  if (!state.map) return;
  const zoom = Math.max(8, state.map.getZoom?.() || 4);
  if (state.map.flyTo) state.map.flyTo([p.lat,p.lng], zoom); else state.map.setView([p.lat,p.lng], zoom);
  const marker = state.pumpMarkers?.get(id);
  if (marker?.openPopup) marker.openPopup();
  else L.popup().setLatLng([p.lat,p.lng]).setContent(popup(p)).openOn(state.map);
  // Deliberately do not scroll the table or the document on selection.
}
function renderPumps() {
  const old = $("stateFilter").value || state.pendingStopState, states = [...new Set(currentPumps().map((p) => p.state).filter(Boolean))].sort();
  $("stateFilter").innerHTML = '<option value="">All</option>' + states.map((s) => `<option>${h(s)}</option>`).join("");
  $("stateFilter").value = states.includes(old) ? old : "";
  if (currentPumps().length) state.pendingStopState = "";
  const rows = visiblePumps();
  $("pumpCount").textContent = `${rows.length} of ${currentPumps().length} stops · ${state.fuel?.source || "No data loaded"}`;
  $("pumpRows").innerHTML = rows.map((p) => `<tr tabindex="0" data-pump-row="${h(p.id)}" class="${state.focusedPump?.id === p.id ? "focused-pump" : ""}"><td><strong>${h(p.name)}</strong></td><td>${h(p.location || [p.city,p.state].filter(Boolean).join(", "))}</td><td>${h(p.highway || "—")}${p.exit ? `<small>Exit ${h(p.exit)}</small>` : ""}</td><td class="price">$${p.price.toFixed(4)}</td><td><button class="text-button" data-message-pump="${h(p.id)}" aria-label="Add ${h(p.name)} to a driver message">Message</button></td></tr>`).join("") || '<tr><td colspan="5" class="empty-list">No stops match these filters.</td></tr>';
  $$("[data-pump-row]").forEach((row) => {
    row.onclick = (e) => { if (!e.target.closest("button")) focusPump(row.dataset.pumpRow); };
    row.onkeydown = (e) => { if (e.target === row && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); focusPump(row.dataset.pumpRow); } };
  });
  $$("[data-message-pump]").forEach((b) => b.onclick = () => {
    const stop = currentPumps().find((p) => p.id === b.dataset.messagePump);
    const editor = state.messageEditor;
    editor.pairs = editor.pairs.filter((p) => p.a.text || p.b.text);
    editor.pairs.push({ a: { text: stopNumber(stop) || stop.name, record: { ...stop, store: stopNumber(stop) }, manual: false }, b: { text: "", record: null, manual: false } });
    editor.renderPairs();
    setView("messages");
  });
  const counts = new Map();
  currentPumps().forEach((p) => (p.highways || []).forEach((hw) => counts.set(hw, (counts.get(hw) || 0) + 1)));
  const search = $("highwaySearch").value.toUpperCase();
  $("highwayOptions").innerHTML = [...counts].sort((a,b) => a[0].localeCompare(b[0], undefined, { numeric: true })).filter(([hw]) => hw.includes(search)).map(([hw,count]) =>
    `<label><input type="checkbox" data-highway="${h(hw)}" ${state.highways.has(hw) ? "checked" : ""}>${h(hw)} <span class="muted">${count}</span></label>`).join("") || '<p class="small muted">No highways match.</p>';
  $("highwayCount").textContent = state.highways.size ? `· ${state.highways.size} selected` : "";
  $$("[data-highway]").forEach((el) => el.onchange = () => {
    el.checked ? state.highways.add(el.dataset.highway) : state.highways.delete(el.dataset.highway);
    renderPumps(); drawMap(); persist();
  });
  $("priceHeading").setAttribute("aria-sort", $("priceSort").value === "high" ? "descending" : $("priceSort").value === "low" ? "ascending" : "none");
  $("priceDirection").textContent = $("priceSort").value === "high" ? "↓" : $("priceSort").value === "low" ? "↑" : "↕";
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
const placeControls = new Map();
function bindLocation(field, onSelect, onChange = () => {}) {
  const el = $(field), box = $(field + "Suggestions");
  const control = bindPlaceSearch(el, box, {
    suggest: async (q, signal) => (await api("suggest?q=" + encodeURIComponent(q), undefined, signal)).results,
    submit: async (q) => geocode(q),
    coordinates: parseCoordinates,
    select: (place) => { onSelect?.(place); persist(); updateRouteStatus(); },
    changed: () => { onChange(); updateRouteStatus(); },
  });
  placeControls.set(field, control);
}
async function searchPlace(field) { return placeControls.get(field)?.search(true); }
function syncWaypoints() {
  $("waypoints").value = state.waypointItems.map((p) => p.value).filter((v) => v.trim()).join("\n");
  $("waypointCount").textContent = state.waypointItems.length ? String(state.waypointItems.length) : "";
  updateRouteStatus(); persist();
}
function restoreWaypoints() {
  state.waypointItems = $("waypoints").value.split("\n").filter((v) => v.trim()).map((value) => ({ id: crypto.randomUUID(), value }));
  renderWaypoints();
}
function renderWaypoints() {
  for (const [key, control] of placeControls) if (key.startsWith("via-")) { control.close(); placeControls.delete(key); }
  $("waypointRows").innerHTML = state.waypointItems.map((item, i) => {
    const id = "via-" + item.id;
    return `<div class="waypoint-row"><div class="section-heading"><label for="${id}">Waypoint ${i+1}</label><div class="waypoint-actions"><button data-via-up="${i}" class="text-button" ${!i ? "disabled" : ""} aria-label="Move waypoint ${i+1} up">↑</button><button data-via-down="${i}" class="text-button" ${i === state.waypointItems.length-1 ? "disabled" : ""} aria-label="Move waypoint ${i+1} down">↓</button><button data-via-remove="${i}" class="text-button" aria-label="Remove waypoint ${i+1}">×</button></div></div><div class="location-wrap"><input id="${id}" autocomplete="off" placeholder="City, state or latitude, longitude" value="${h(item.value)}"><button data-via-search="${id}" class="search-place" aria-label="Search waypoint ${i+1}">⌕</button></div><div id="${id}Suggestions" class="suggestions" hidden></div></div>`;
  }).join("");
  state.waypointItems.forEach((item) => {
    const field = "via-" + item.id;
    if (item.place) { $(field).dataset.selectedLabel = item.value; $(field).dataset.coordinates = JSON.stringify(item.place); }
    bindLocation(field, (place) => { item.value = $(field).value; item.place = place; syncWaypoints(); },
      () => { item.value = $(field).value; delete item.place; syncWaypoints(); });
  });
  $$("[data-via-search]").forEach((b) => b.onclick = () => searchPlace(b.dataset.viaSearch));
  for (const kind of ["up", "down", "remove"]) $$(`[data-via-${kind}]`).forEach((b) => b.onclick = () => {
    const i = Number(b.getAttribute(`data-via-${kind}`));
    if (kind === "remove") state.waypointItems.splice(i,1);
    else { const j = i + (kind === "up" ? -1 : 1); if (j < 0 || j >= state.waypointItems.length) return; [state.waypointItems[i],state.waypointItems[j]] = [state.waypointItems[j],state.waypointItems[i]]; }
    renderWaypoints(); syncWaypoints();
  });
  $("addWaypoint").disabled = state.waypointItems.length >= 23;
  $("waypointCount").textContent = state.waypointItems.length ? String(state.waypointItems.length) : "";
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
  const sequence = ++state.findSeq;
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
    const waypointSnapshot = state.waypointItems.filter((item) => item.value.trim());
    for (const [i, text] of waypoints.entries()) {
      const selected = waypointSnapshot[i];
      via.push(selected?.value === text && selected.place ? selected.place : (await geocode(text))[0]);
    }
    const profile = $("routingProfile").value,
      options = routeOptions();
    const result = await api("routes", {
      points: [origin, ...via, destination],
      profile,
      options,
    });
    if (!result.routes.length) throw new Error("No routes were returned.");
    if (sequence !== state.findSeq || stamp !== tripStamp())
      throw new Error("Truck or locations changed during the search. Find routes again for the current trip.");
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
    updateRouteStatus();
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
  $("solveRoutes").textContent = "Fuelio Hunt";
  updateRouteStatus();
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
            `${route.name} · checked ${done} of ${total} stop connections`,
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
      // Keep the larger map in view; the route/results area scrolls below it.
    }
  } finally {
    state.activeSolve = null;
    $("progress").hidden = true;
    $("solveRoutes").disabled = false;
    updateRouteStatus();
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
        return `<article class="infeasible"><h3>${h(p.route.name)} · No feasible plan</h3><p>${h(uiText(p.reason))}</p>${p.rules?.fill === "half" || $("fill").value === "half" ? '<button class="secondary" data-full-tank>Use Full Tank</button>' : ""}</article>`;
      return `<article class="plan-result ${p === best ? "best" : ""}"><div class="result-top"><div><span class="tag ${p === best ? "good" : ""}">${p === best ? "LOWEST FUEL SPEND" : "FEASIBLE PLAN"}</span><h2>${h(p.route.name)} · ${h(p.trip.truck || "Manual trip")}</h2><p class="stop-note">${h(p.source)} · ${p.rules.fill === "half" ? "Half Tank" : "Full Tank"} · ${h(new Date(p.createdAt).toLocaleString())}</p></div><div class="result-cost">${money(p.cost)}<small>fuel to purchase</small></div></div><div class="result-metrics"><div><strong>${fmt(p.totalMiles, 1)} mi</strong><span>Including stop access</span></div><div><strong>${fmt(p.gallons, 2)} gal</strong><span>Fuel to buy</span></div><div><strong>${p.stops.length} stops</strong><span>${fmt(p.detourMiles, 1)} extra miles</span></div><div><strong>${fmt(p.endFuel, 2)} gal</strong><span>At destination</span></div></div>${p.warnings.map((w) => `<p class="callout">${h(uiText(w))}</p>`).join("")}${p.excludedPumps ? `<p class="callout">${p.excludedPumps} stops had no confirmed road access and were excluded.</p>` : ""}<div class="stop-list">${p.stops.length ? p.stops.map((s, i) => `<div class="stop-row"><span class="stop-number">${i + 1}</span><div><button class="text-button stop-name" data-stop="${h(p.id)}:${i}">${h(s.name)}</button><p class="stop-location">${h(s.location || [s.city, s.state].filter(Boolean).join(", "))}</p><p class="stop-note">${h(s.highway || "")}${s.exit ? " · Exit " + h(s.exit) : ""} · Route mile ${fmt(s.mile, 1)}</p></div><div class="fuel-flow"><span><small>ARRIVE</small>${fmt(s.arrival, 2)}</span><span class="muted">→</span><span class="purchase"><small>BUY · GAL</small>+${fmt(s.gallons, 2)}</span><span class="muted">→</span><span><small>LEAVE</small>${fmt(s.departure, 2)}</span></div><div class="stop-price">${money(s.cost)}<small>$${s.price.toFixed(4)} / gal</small></div></div>`).join("") : '<p style="padding:20px 0">No fuel purchase is needed. The entered starting fuel covers this trip and its reserve.</p>'}</div><div class="fuel-chart"><details><summary>Fuel profile &amp; calculation details</summary>${fuelChart(p)}<p class="field-help">${fmt(p.rules.startFuel, 2)} starting + ${fmt(p.gallons, 2)} purchased − ${fmt(p.burned, 2)} consumed = ${fmt(p.endFuel, 2)} ending gallons. Exact minimum for the supplied routes, prices and fixed-fill rules. Initial fuel is already on hand; remaining fuel is shown separately. Road access uses return-to-route connectors. ${h(p.route.provider)}.</p></details></div><div class="result-actions"><button class="secondary" data-export-csv="${p.id}">Export CSV</button><button class="secondary" data-export-json="${p.id}">Export JSON</button><button class="quiet" data-plan-map="${p.id}">Show on map</button><button class="primary" data-plan-message="${p.id}">Driver messages</button></div></article>`;
    })
    .join("");

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
          "Stop name",
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
function initMessageEditors() {
  const callbacks = { api, readFile: readTableFile, copy, onError: (e) => log(e.message, "warning") };
  state.messageEditor = new MessageEditor($("messageEditor"), {
    ...callbacks, prefix: "message",
    onSave: (snapshot) => {
      if (!state.messagesReady) return;
      clearTimeout(saveMessages.timer);
      saveMessages.timer = setTimeout(() => dbPut("messages", snapshot), 200);
    },
  });
  state.resultEditor = new MessageEditor($("resultEditor"), {
    ...callbacks, prefix: "result", onSave: (snapshot) => {
      if (state.planForMessage && !state.loadingPlanMessage) state.planMessageDrafts.set(state.planForMessage.id, snapshot);
    },
  });
}
function openPlanMessage(plan) {
  verifyPlan(plan);
  state.planForMessage = plan;
  state.loadingPlanMessage = true;
  const saved = state.messageEditor.snapshot();
  state.resultEditor.setFallback(currentPumps(), state.fuel?.source);
  const draft = state.planMessageDrafts.get(plan.id);
  if (draft) state.resultEditor.restore(draft);
  else {
    state.resultEditor.restore({ ...saved, pairs: [] });
    state.resultEditor.setPlan(plan, routeHighways(plan.route), saved.fields);
  }
  state.loadingPlanMessage = false;
  state.planMessageDrafts.set(plan.id, state.resultEditor.snapshot());
  $("messageDialog").showModal();
}
function renderMessages() {
  if (!state.messageEditor) return;
  for (const editor of [state.messageEditor, state.resultEditor]) editor.setFallback(currentPumps(), state.fuel?.source);
}
function saveMessages() { return dbPut("messages", state.messageEditor.snapshot()); }
function messageInputs() { return state.messageEditor.inputs(); }
function updateCustomMessage() { state.messageEditor.update(); }

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
  document.querySelector(".brand").onclick = (e) => { e.preventDefault(); setView("planner"); };
  window.addEventListener("hashchange", () => {
    const view = location.hash.slice(1);
    if (view !== state.view) setView(["planner", "fleet", "pumps", "stops", "messages", "activity"].includes(view) ? view : "planner");
  });
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
    updateRouteStatus(); persist();
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
    updateRouteStatus();
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
      if (id === "waypoints" && $("waypoints").value !== state.waypointItems.map((p) => p.value).filter((v) => v.trim()).join("\n")) restoreWaypoints();
      if (["fuelPercent", "mpg", "startFuel", "capacity"].includes(id)) renderTelemetry();
      if (id === "corridor") { state.routes.forEach((r) => delete r.candidates); drawMap(); }
      updateRouteStatus();
      persist();
    }),
  );
  $$(".search-place").forEach(
    (b) => (b.onclick = action(() => searchPlace(b.dataset.field))),
  );
  for (const id of ["origin", "destination"]) bindLocation(id, () => {
    if (id === "origin") markManual("origin", $(id).value);
  });
  document.addEventListener("pointerdown", (e) => {
    for (const control of placeControls.values()) if (!control.contains(e.target) && !e.target.closest(".search-place")) control.close();
    const menu = document.querySelector(".highway-filter");
    if (menu && !menu.contains(e.target)) menu.open = false;
  });
  document.addEventListener("focusin", (e) => {
    for (const control of placeControls.values()) if (!control.contains(e.target) && !e.target.closest(".search-place")) control.close();
  });
  $("addWaypoint").onclick = () => {
    if (state.waypointItems.length >= 23) return;
    state.waypointItems.push({ id: crypto.randomUUID(), value: "" });
    renderWaypoints(); syncWaypoints();
    $("via-" + state.waypointItems.at(-1).id).focus();
  };
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
        persist();
      },
    );
  $("clearHighways").onclick = () => {
    state.highways.clear();
    renderPumps();
    drawMap();
    persist();
  };
  $("clearHighwaySearch").onclick = () => { $("highwaySearch").value = ""; renderPumps(); $("highwaySearch").focus(); persist(); };
  $("cyclePrice").onclick = () => {
    const sequence = ["master", "high", "low"];
    $("priceSort").value = sequence[(sequence.indexOf($("priceSort").value) + 1) % 3];
    renderPumps();
    persist();
  };
  $("clearStops").onclick = () => {
    for (const id of ["pumpSearch", "stateFilter", "highwaySearch"]) $(id).value = "";
    $("priceSort").value = "master"; $("routeOnly").checked = false;
    state.highways.clear(); state.focusedPump = null; state.openStopId = null;
    state.pendingStopState = "";
    state.map?.closePopup?.(); renderPumps(); drawMap(); fitMap();
    persist();
  };
  $("fuelExport").onclick = () =>
    download(
      "fuelio-fuel-stops.csv",
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
  $("fleetSearch").oninput = () => { renderFleet(); drawTruck(); };
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
    restoreWaypoints();
    $("routeCards").innerHTML =
      '<div class="empty-state"><p>Enter your next trip and find routes.</p></div>';
    $("results").innerHTML = "";
    $("solveBar").hidden = false;
    state.connectorLayer?.clearLayers();
    renderTelemetry();
    drawMap();
    persist();
    updateRouteStatus();
  };

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
          messages: state.messageEditor.snapshot(),
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
  $("pumpSearch").value = restored.stopView?.query || "";
  $("highwaySearch").value = restored.stopView?.highwaySearch || "";
  $("priceSort").value = ["master","high","low"].includes(restored.stopView?.sort) ? restored.stopView.sort : "master";
  $("theme").value = restored.theme || "light";
  initMessageEditors();
  bindEvents();
  restoreWaypoints();
  updateFuelUI();
  renderTelemetry();
  updateRouteStatus();
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
  if (fuel) await applyFuel(fuel, state.sourcePrefs);
  if (messages) state.messageEditor.restore(messages);
  state.messagesReady = true;
  setView(
    ["planner", "fleet", "pumps", "stops", "messages", "activity"].includes(
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
