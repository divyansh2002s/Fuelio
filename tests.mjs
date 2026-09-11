import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { solveFuelPlan, verifyPlan } from "./optimizer.js";
import {
  parseFuelTable,
  parseCSV,
  toCSV,
  parseSheetReference,
  parseMessageTable,
} from "./data.js";
import {
  prepareRoute,
  routeCandidates,
  haversine,
  segmentProjection,
  californiaEntry,
  insidePolygon,
} from "./geo.js";
import { planMessage, customMessage } from "./messages.js";
import { clusterCities, prepareLoads, parseLoads } from "./batch.js";
const suppliedFuelTable = [
  [
    "pump_name",
    "price_per_gallon",
    "latitude",
    "longitude",
    "city",
    "state",
    "highway",
    "Exit",
  ],
  [
    "Pilot - IN30",
    1,
    39.82150284,
    -85.91623097,
    "Greenfield",
    "IN",
    "I-70",
    96,
  ],
  [
    "Pilot - CA154",
    1,
    35.615131,
    -119.658782,
    "Lost Hills",
    "CA",
    "I-5/CA-46",
    278,
  ],
  [
    "Pilot - NC275",
    1,
    35.270415,
    -80.8381034,
    "Charlotte",
    "NC",
    "I-85/77",
    39,
  ],
];
const suppliedMessageTable = [
  ["StoreNumber", "Latitude", "Longitude", "Location", "Highway", "Exit"],
  [245, 35.377833, -97.573646, "Oklahoma City, OK", "I-44", 113],
  [712, 35.277217, -97.601128, "Newcastle, OK", "I-44", "107/24th St"],
  [41, 35.579576, -97.547947, "Oklahoma City, OK", "", ""],
  [167, 35.081871, -97.923971, "Chickasha, OK", "44/HE Bailey Tpk", "Mile 85"],
];
const rule = {
  capacity: 240,
  startFuel: 100,
  mpg: 7,
  reserve: 50,
  endFuel: 50,
  maxStops: 6,
  fill: "full",
  mode: "buffer",
};
const station = (id, mile, price = 4, extra = {}) => ({
  id,
  name: id,
  mile,
  price,
  inMiles: 0,
  outMiles: 0,
  ...extra,
});
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-5, `${a} != ${b}`);

test("Half Tank: arrive with 119 gallons, purchase 1 and depart with exactly 120", () => {
  const p = solveFuelPlan({
    distance: 70,
    stations: [station("A", 0)],
    rules: { ...rule, fill: "half", startFuel: 119, reserve: 20, endFuel: 110 },
  });
  assert.equal(p.status, "optimal");
  assert.equal(p.stops.length, 1);
  close(p.stops[0].gallons, 1);
  close(p.stops[0].departure, 120);
  close(p.endFuel, 110);
  close(p.cost, 4);
});
test("Starting above half capacity does not drain the tank or force an unnecessary stop", () => {
  const p = solveFuelPlan({
    distance: 700,
    stations: [station("A", 200)],
    rules: { ...rule, fill: "half", startFuel: 200 },
  });
  assert.equal(p.status, "optimal");
  assert.equal(p.stops.length, 0);
  close(p.endFuel, 100);
  close(p.cost, 0);
});
test("Infeasible Half Tank has a Full Tank warning and no exportable stops", () => {
  const input = {
    distance: 1000,
    stations: [station("A", 300)],
    rules: { ...rule, startFuel: 100, endFuel: 140, fill: "half" },
  };
  const p = solveFuelPlan(input);
  assert.equal(p.status, "infeasible");
  assert.match(p.reason, /Full Tank/);
  assert.throws(() => planMessage(p));
});
test("Zero stops is a real constraint; below-buffer starts do not silently relax it", () => {
  assert.equal(
    solveFuelPlan({
      distance: 1000,
      stations: [station("A", 300)],
      rules: { ...rule, maxStops: 0 },
    }).status,
    "infeasible",
  );
  assert.equal(
    solveFuelPlan({
      distance: 1,
      stations: [],
      rules: { ...rule, startFuel: 49 },
    }).status,
    "infeasible",
  );
});
test("Unreachable cheapest pump cannot enter a solution", () => {
  const p = solveFuelPlan({
    distance: 1100,
    stations: [station("cheap", 500, 1), station("reachable", 300, 4)],
    rules: rule,
  });
  assert.equal(p.status, "optimal");
  assert.deepEqual(
    p.stops.map((s) => s.id),
    ["reachable"],
  );
  assert.ok(p.endFuel >= 50);
});
test("Both inbound and return road access consume fuel and count in purchased cost", () => {
  const p = solveFuelPlan({
    distance: 1000,
    stations: [station("A", 300, 4, { inMiles: 3, outMiles: 7 })],
    rules: rule,
  });
  assert.equal(p.status, "optimal");
  close(p.totalMiles, 1010);
  close(p.stops[0].arrival, 100 - 303 / 7);
  close(p.endFuel, 240 - 707 / 7);
  close(p.cost, (240 - (100 - 303 / 7)) * 4);
});
test("Fixed filling policy and ending tolerance are enforced together", () => {
  const p = solveFuelPlan({
    distance: 1000,
    stations: [station("A", 300)],
    rules: { ...rule, endFuel: 50, endTolerance: 0 },
  });
  assert.equal(p.status, "infeasible");
});
test("Strict-window rescue retains the lower reserve, stop limit and fill target", () => {
  const common = {
    distance: 1000,
    stations: [station("A", 250)],
    rules: {
      ...rule,
      mode: "strict",
      rescue: false,
      windowLower: 10,
      windowUpper: 5,
    },
  };
  assert.equal(solveFuelPlan(common).status, "infeasible");
  const p = solveFuelPlan({
    ...common,
    rules: { ...common.rules, rescue: true },
  });
  assert.equal(p.status, "optimal");
  assert.equal(p.rescueUsed, true);
  assert.ok(p.stops[0].arrival >= 40);
  close(p.stops[0].departure, 240);
});
test("Same-mile pumps remain distinct price alternatives", () => {
  const p = solveFuelPlan({
    distance: 1100,
    stations: [station("expensive", 300, 5), station("cheap", 300, 3)],
    rules: rule,
  });
  assert.equal(p.status, "optimal");
  assert.equal(p.stops[0].id, "cheap");
});
test("Invalid, negative, NaN and conflicting records fail loudly", () => {
  for (const price of [0, -1, NaN, Infinity])
    assert.throws(() =>
      solveFuelPlan({
        distance: 1000,
        stations: [station("A", 300, price)],
        rules: rule,
      }),
    );
  assert.throws(() =>
    solveFuelPlan({ distance: 1000, stations: [], rules: { ...rule, mpg: 0 } }),
  );
  assert.throws(() =>
    solveFuelPlan({
      distance: 1000,
      stations: [station("A", 300, 3), station("A", 300, 4)],
      rules: rule,
    }),
  );
});
test("Independent replay detects corrupted accounting", () => {
  const p = solveFuelPlan({
    distance: 1000,
    stations: [station("A", 300)],
    rules: rule,
  });
  p.endFuel += 1;
  assert.throws(() => verifyPlan(p));
});

// Exhaustive subset enumeration is independent of the DP state recurrence.
function brute(distance, stations, r) {
  let best = Infinity;
  const reserve =
    r.mode === "strict" ? Math.max(0, r.reserve - r.windowLower) : r.reserve;
  for (let mask = 0; mask < 2 ** stations.length; mask++) {
    const chosen = stations.filter((_, i) => mask & (2 ** i));
    if (chosen.length > r.maxStops) continue;
    let fuel = r.startFuel,
      cost = 0,
      mile = 0,
      out = 0,
      valid = fuel >= reserve - 1e-7;
    for (const s of chosen) {
      fuel -= (s.mile - mile + out + s.inMiles) / r.mpg;
      const upper = r.mode === "strict" ? r.reserve + r.windowUpper : Infinity;
      const target = r.capacity * (r.fill === "half" ? 0.5 : 1);
      const buy = target - fuel;
      if (fuel < reserve - 1e-7 || fuel > upper + 1e-7 || buy <= 1e-7) {
        valid = false;
        break;
      }
      cost += buy * s.price;
      fuel = target;
      out = s.outMiles;
      mile = s.mile;
      if (fuel - out / r.mpg < reserve - 1e-7) {
        valid = false;
        break;
      }
    }
    fuel -= (distance - mile + out) / r.mpg;
    if (
      fuel < Math.max(r.endFuel, reserve) - 1e-7 ||
      (r.endTolerance != null && fuel > r.endFuel + r.endTolerance + 1e-7)
    )
      valid = false;
    if (valid) best = Math.min(best, cost);
  }
  return best;
}
test("600 random instances match exhaustive global minimum over every stop subset", () => {
  let seed = 1771;
  const random = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  let feasible = 0;
  for (let trial = 0; trial < 600; trial++) {
    const capacity = 60 + Math.floor(random() * 220),
      mpg = 3 + random() * 8,
      distance = 50 + random() * 1800,
      n = 7;
    const reserve = random() * capacity * 0.2,
      r = {
        capacity,
        mpg,
        startFuel: reserve + random() * (capacity - reserve),
        reserve,
        endFuel: random() * capacity * 0.45,
        maxStops: Math.floor(random() * 7),
        fill: random() < 0.5 ? "half" : "full",
        mode: random() < 0.35 ? "strict" : "buffer",
        windowLower: 10,
        windowUpper: 30,
        endTolerance: random() < 0.2 ? 40 : null,
      };
    const stations = Array.from({ length: n }, (_, i) =>
      station("S" + i, (distance * (i + 0.5)) / n, 2 + random() * 4, {
        inMiles: random() * 5,
        outMiles: random() * 5,
      }),
    );
    const expected = brute(distance, stations, r),
      actual = solveFuelPlan({ distance, stations, rules: r });
    if (Number.isFinite(expected)) {
      feasible++;
      assert.equal(actual.status, "optimal", `Trial ${trial}`);
      close(actual.cost, expected);
    } else assert.equal(actual.status, "infeasible", `Trial ${trial}`);
  }
  assert.ok(feasible > 50);
});

test("CSV handles BOM, quoted commas, newlines, aliases and non-positive price rejection", () => {
  const csv =
    '\uFEFFReport,,,,,\nStore No,Best Discounted Price,Latitude,Longitude,City,State\n123,4.1234,35,-100,"City, name",TX\n124,0,35,-99,Other,TX\n';
  const data = parseFuelTable(parseCSV(csv), "Young's Pilot");
  assert.equal(data.rows.length, 1);
  assert.equal(data.rows[0].brand, "Pilot");
  assert.equal(data.rows[0].store, "123");
  assert.equal(data.rows[0].city, "City, name");
  assert.equal(data.issues.length, 1);
  assert.deepEqual(parseCSV('A,B\n"line\none","say ""hi"""'), [
    ["A", "B"],
    ["line\none", 'say "hi"'],
  ]);
});
test("CSV exports protect formula-leading text and retain numeric negatives", () => {
  const csv = toCSV([['=HYPERLINK("bad")', -12.4, "+cmd"]]);
  assert.match(csv, /'=HYPERLINK/);
  assert.match(csv, /"-12.4"/);
  assert.match(csv, /'\+cmd/);
});
test("Sheet GID 0 is valid; wrong domains and nonnumeric GIDs fail", () => {
  const id = "a".repeat(30);
  assert.deepEqual(
    parseSheetReference(
      `https://docs.google.com/spreadsheets/d/${id}/edit#gid=5`,
      0,
    ),
    { id, gid: "0" },
  );
  assert.throws(() => parseSheetReference("https://example.com/sheet"));
  assert.throws(() => parseSheetReference(id, "bad"));
});
test("Fuel duplicate conflicts never silently select another price", () => {
  const table = [
    ["pump_name", "price_per_gallon", "latitude", "longitude"],
    ["A", 3, 35, -100],
    ["A", 4, 35, -100],
  ];
  assert.throws(() => parseFuelTable(table), /Conflicting/);
});
test("Message brands and pump IDs stay distinct; Half Tank text agrees with the plan", () => {
  const rows = parseMessageTable(
    [
      ["Store Number", "Location", "Highway", "Exit"],
      ["123", "Fresno, CA", "I-5", "4"],
    ],
    "Pilot",
  );
  assert.match(customMessage({ pairs: [{ a: rows[0] }] }), /Pilot #123/);
  const p = solveFuelPlan({
    distance: 70,
    stations: [
      station("Pilot #123", 0, 4, { brand: "Pilot", location: "Test, TX" }),
    ],
    rules: { ...rule, fill: "half", startFuel: 119, reserve: 20, endFuel: 110 },
  });
  const text = planMessage(p);
  assert.match(text, /120 gallons \(half tank\)/);
  assert.match(text, /1 gallons/);
  assert.doesNotMatch(text, /Love/);
});
test("Message master import accepts prefaced headers and original headerless layouts", () => {
  const prefaced = parseMessageTable(
    [
      ["Master notes"],
      ["Store Number", "Location", "Highway", "Exit"],
      [123, "Fresno, CA", "I-5", 4],
    ],
    "Pilot",
  );
  const four = parseMessageTable([[123, "Fresno, CA", "I-5", 4]], "Pilot");
  const six = parseMessageTable(
    [[123, "unused", "unused", "Fresno, CA", "I-5", 4]],
    "Pilot",
  );
  assert.deepEqual(prefaced, four);
  assert.deepEqual(prefaced, six);
});
test("Supplied eight-column fuel format retains coordinates, prices, highways and exits", () => {
  const parsed = parseFuelTable(suppliedFuelTable, "Young's Pilot");
  assert.equal(parsed.rows.length, 3);
  assert.equal(parsed.issues.length, 0);
  const pump = parsed.rows[0];
  assert.equal(pump.name, "Pilot - IN30");
  assert.equal(pump.brand, "Pilot");
  close(pump.price, 1);
  close(pump.lat, 39.82150284);
  close(pump.lng, -85.91623097);
  assert.equal(pump.city, "Greenfield");
  assert.equal(pump.state, "IN");
  assert.equal(pump.highway, "I-70");
  assert.equal(pump.exit, "96");
  assert.equal(parsed.rows[1].highway, "I-5/CA-46");
  assert.equal(parsed.rows[2].highway, "I-85/77");
});
test("Supplied six-column message format uses Location, Highway and Exit without coordinate shifts", () => {
  const rows = parseMessageTable(suppliedMessageTable, "Love's");
  assert.equal(rows.length, 4);
  assert.equal(rows[0].store, "245");
  assert.equal(rows[0].location, "Oklahoma City, OK");
  assert.equal(rows[0].highway, "I-44");
  assert.equal(rows[0].exit, "113");
  assert.equal(rows[1].exit, "107/24th St");
  assert.equal(rows[2].highway, "");
  assert.equal(rows[2].exit, "");
  assert.equal(rows[3].exit, "Mile 85");
  const text = customMessage({ pairs: [{ a: rows[1] }] });
  assert.match(text, /Love's #712.*Newcastle, OK.*I-44.*107\/24th St/);
  assert.doesNotMatch(text, /35\.277217|97\.601128/);
});
test("One-mile corridor uses distance to any segment, including between vertices", () => {
  const route = prepareRoute({
    distance: 140,
    coordinates: [
      [-102, 35],
      [-100, 35],
    ],
  });
  const hit = segmentProjection(
    { lat: 35.008, lng: -101 },
    route.points[0],
    route.points[1],
  );
  assert.ok(hit.distance < 1);
  const pumps = [
    {
      id: "inside",
      name: "Inside",
      price: 4,
      lat: hit.lat + 0.005,
      lng: hit.lng,
    },
    { id: "outside", name: "Outside", price: 3, lat: 35.2, lng: -101 },
  ];
  const candidates = routeCandidates(route, pumps, 1);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].pumpId, "inside");
  close(candidates[0].mile, 70);
});
test("Route revisits can expose the same pump at separate route positions", () => {
  const r = prepareRoute({
    distance: 400,
    coordinates: [
      [-101, 35],
      [-100, 35],
      [-99, 35],
      [-99, 36],
      [-100, 35],
      [-101, 36],
    ],
  });
  const matches = routeCandidates(
    r,
    [{ id: "A", lat: 35, lng: -100, price: 4 }],
    0.2,
  );
  assert.equal(matches.length, 2);
  assert.ok(matches[1].mile > matches[0].mile);
});
test("California boundary, outside start, first entry and final leg are checked", async () => {
  const ca = JSON.parse(
    await readFile(new URL("./california.json", import.meta.url)),
  );
  assert.equal(insidePolygon({ lat: 36.74, lng: -119.78 }, ca.geometry), true);
  assert.equal(insidePolygon({ lat: 35.2, lng: -111.65 }, ca.geometry), false);
  const r = prepareRoute({
    distance: 500,
    coordinates: [
      [-111.65, 35.2],
      [-114.2, 35.2],
      [-115, 35.2],
      [-119.78, 36.74],
    ],
  });
  const mile = californiaEntry(r, ca.geometry);
  assert.ok(mile > 0 && mile < 500);
  const p = solveFuelPlan({
    distance: 700,
    stations: [station("AZ", 300, 4, { state: "AZ" })],
    rules: { ...rule, startFuel: 90, mode: "before_ca", caEntryMile: 400 },
  });
  assert.equal(p.status, "optimal");
  assert.ok(p.endFuel >= 50);
  const bad = solveFuelPlan({
    distance: 2500,
    stations: [station("AZ", 300, 4, { state: "AZ" })],
    rules: { ...rule, startFuel: 90, mode: "before_ca", caEntryMile: 400 },
  });
  assert.equal(bad.status, "infeasible");
});
test("City clusters are descriptive; chained clusters cannot grant lane eligibility", () => {
  const cities = [
    { lat: 35, lng: -100 },
    { lat: 35, lng: -99.5 },
    { lat: 35, lng: -99 },
  ];
  const groups = clusterCities(cities, 30);
  assert.equal(groups[0].cluster, groups[2].cluster);
  const lanes = [
    { id: "L", name: "Lane", points: [cities[0], { lat: 40, lng: -80 }] },
  ];
  const loads = [
    { id: "x", pickup: cities[2], delivery: { lat: 40, lng: -80 } },
  ];
  assert.equal(prepareLoads(loads, lanes, 30)[0].matches.length, 0);
});
test("Historical load aliases and manual per-load overrides are read correctly", () => {
  const loads = parseLoads(
    parseCSV(
      "load_id,pickup_latitude,pickup_longitude,delivery_latitude,delivery_longitude,starting_fuel,mpg\nA,35,-100,36,-99,120,6.5",
    ),
  );
  assert.equal(loads[0].overrides.startFuel, 120);
  assert.equal(loads[0].overrides.mpg, 6.5);
});

test("Build output contains the app and excludes server code and credential instructions", async () => {
  const html = await readFile(
    new URL("./public/index.html", import.meta.url),
    "utf8",
  );
  assert.match(html, /workspace\.js/);
  assert.match(html, /value="light"/);
  assert.match(html, /value="dark"/);
  assert.match(html, /value="crimson"/);
  for (const file of [
    "workspace.js",
    "optimizer.js",
    "geo.js",
    "data.js",
    "styles.css",
    "vendor/leaflet/leaflet.js",
  ])
    assert.ok(
      (await readFile(new URL("./public/" + file, import.meta.url))).length > 0,
    );
  await assert.rejects(
    readFile(new URL("./public/server.js", import.meta.url)),
  );
});

test("DOM workflow: editable live values, manual overrides, themes, routes and verified plan messages", async () => {
  const { JSDOM } = await import("jsdom");
  const html = await readFile(new URL("./index.html", import.meta.url), "utf8");
  const dom = new JSDOM(html, { url: "http://fco.test/" });
  const w = dom.window,
    originals = {};
  const assign = (key, value) => {
    originals[key] = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, {
      value,
      writable: true,
      configurable: true,
    });
  };
  for (const key of [
    "window",
    "document",
    "location",
    "localStorage",
    "HTMLButtonElement",
    "HTMLElement",
    "Event",
  ])
    assign(key, w[key]);
  assign("navigator", { clipboard: { writeText: async () => {} } });
  assign("requestAnimationFrame", (f) => f());
  assign("confirm", () => true);
  assign("prompt", () => null);
  w.HTMLElement.prototype.scrollIntoView = function () {};
  w.HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  w.HTMLDialogElement.prototype.close = function () {
    this.open = false;
    this.dispatchEvent(new w.Event("close"));
  };
  const realSetTimeout = globalThis.setTimeout,
    timers = new Set();
  assign("setTimeout", (fn, ms, ...args) => {
    const t = realSetTimeout(fn, ms, ...args);
    timers.add(t);
    return t;
  });
  let refresh;
  assign("setInterval", (fn) => {
    refresh = fn;
    return 1;
  });
  const registrations = new Map();
  w.document.modelContext = {
    registerTool: (tool) => {
      registrations.set(tool.name, tool);
    },
  };
  const chain = () => ({
    addTo() {
      return this;
    },
    on() {
      return this;
    },
    bindPopup() {
      return this;
    },
    bindTooltip() {
      return this;
    },
    bringToBack() {
      return this;
    },
    clearLayers() {
      return this;
    },
    setLatLng() {
      return this;
    },
    setContent() {
      return this;
    },
    openOn() {
      return this;
    },
  });
  const map = {
    ...chain(),
    setView() {
      return this;
    },
    removeLayer() {},
    hasLayer() {
      return false;
    },
    invalidateSize() {},
    fitBounds() {},
  };
  const L = {
    map: () => map,
    tileLayer: chain,
    layerGroup: chain,
    control: { scale: chain },
    polyline: chain,
    marker: chain,
    circleMarker: chain,
    divIcon: (x) => x,
    popup: chain,
    latLngBounds: (x) => x,
  };
  w.L = L;
  assign("L", L);
  assign(
    "Worker",
    class {
      postMessage({ id, input }) {
        queueMicrotask(() => {
          if (!this.stopped) {
            try {
              this.onmessage?.({ data: { id, result: solveFuelPlan(input) } });
            } catch (e) {
              this.onmessage?.({ data: { id, error: e.message } });
            }
          }
        });
      }
      terminate() {
        this.stopped = true;
      }
    },
  );
  const fuel = parseFuelTable(
    [
      [
        "pump_name",
        "price_per_gallon",
        "latitude",
        "longitude",
        "city",
        "state",
      ],
      ["A", 4, 35, -99, "Test", "TX"],
      ["B", 3, 35, -98, "Test2", "TX"],
      ["C", 5, 35, -97, "Test3", "TX"],
    ],
    "Test Master",
  );
  let fuelPercent = 60;
  const response = (data) =>
    new Response(JSON.stringify(data), {
      headers: { "Content-Type": "application/json" },
    });
  assign("fetch", async (url, options = {}) => {
    const path = String(url);
    if (path === "/route-library.json") return response([]);
    if (path === "/api/config")
      return response({
        clients: [
          { id: "a", name: "Client A", connections: 2 },
          { id: "b", name: "Client B", connections: 1 },
        ],
        masters: [{ id: "master", name: "Test Master" }],
        messageMasters: [],
        errors: [],
        privateMaster: true,
        truckRouting: false,
      });
    if (path === "/api/fuel") return response(fuel);
    if (path.startsWith("/api/fleet"))
      return response({
        vehicles: [
          {
            id: "104",
            name: "TRUCK 104",
            lat: 35,
            lng: -100,
            location: "Test, TX",
            fuelPercent,
            fuelTime: new Date().toISOString(),
            gpsTime: new Date().toISOString(),
            odometer: 1000,
            speed: 0,
            vin: "TEST",
            heading: 90,
          },
        ],
        warnings: [],
      });
    if (path.startsWith("/api/vehicle-detail"))
      return response({
        mpg: 7,
        mpgSource: "Test report",
        historyFuel: null,
        warnings: [],
      });
    if (path === "/api/routes")
      return response({
        routes: [
          {
            id: "r1",
            name: "Route 1",
            distance: 1000,
            duration: 72000,
            coordinates: [
              [-100, 35],
              [-99, 35],
              [-98, 35],
              [-97, 35],
              [-96, 35],
            ],
            profile: "driving",
            provider: "Test routing",
            summary: "Test corridor",
          },
        ],
        note: "Test routes",
      });
    if (path === "/api/access") {
      const b = JSON.parse(options.body);
      return response({
        items: b.items.map((i) => ({
          id: i.id,
          inMiles: 0,
          outMiles: 0,
          seconds: 0,
        })),
      });
    }
    throw new Error("Unexpected test request: " + path);
  });
  const tick = () => new Promise((r) => setTimeout(r, 5));
  const until = async (fn) => {
    for (let i = 0; i < 250; i++) {
      if (fn()) return;
      await tick();
    }
    throw new Error(
      "DOM condition did not complete: " +
        w.document.getElementById("notice").textContent +
        " / " +
        w.document.getElementById("activityLog").textContent,
    );
  };
  try {
    await import("./workspace.js?dom-test");
    await until(() => registrations.size === 4);
    const el = (id) => w.document.getElementById(id),
      input = (id, value) => {
        el(id).value = value;
        el(id).dispatchEvent(new w.Event("input", { bubbles: true }));
      };
    el("truck").value = "TRUCK 104";
    await el("truck").onchange({ currentTarget: el("truck") });
    close(Number(el("startFuel").value), 144);
    close(Number(el("mpg").value), 7);
    input("mpg", "8");
    input("startFuel", "99");
    fuelPercent = 25;
    await refresh();
    close(Number(el("mpg").value), 8);
    close(Number(el("startFuel").value), 99);
    assert.match(el("telemetryBody").textContent, /25\.0%/);
    el("useLive").click();
    close(Number(el("mpg").value), 7);
    close(Number(el("startFuel").value), 60);
    input("startFuel", "100");
    input("mpg", "7");
    input("destination", "35, -96");
    for (const theme of ["dark", "crimson", "light"]) {
      el("theme").value = theme;
      el("theme").onchange();
      assert.equal(w.document.documentElement.dataset.theme, theme);
    }
    const tools = registrations;
    assert.throws(() =>
      tools
        .get("stage_fco_trip_inputs")
        .execute({ values: { capacity: "bad" } }),
    );
    const staged = tools
      .get("stage_fco_trip_inputs")
      .execute({ values: { capacity: 240 } });
    assert.equal(staged.inputs.capacity, "240");
    await tools.get("find_fco_routes").execute({});
    assert.match(el("routeCards").textContent, /Route 1/);
    await tools.get("calculate_fco_fuel_plans").execute({});
    assert.match(el("results").textContent, /LOWEST FUEL SPEND/);
    const summary = tools.get("read_fco_workspace").execute({});
    assert.equal(summary.plans[0].status, "optimal");
    el("results").querySelector("[data-plan-message]").click();
    assert.match(el("resultMessage").value, /full tank/);
    assert.equal(el("messageDialog").open, true);
    input("truck", "MANUAL");
    input("capacity", "300");
    assert.equal(el("capacity").value, "300");
    w.ExcelJS = (await import("exceljs")).default;
    const book = new w.ExcelJS.Workbook();
    book.addWorksheet("Notes").addRow(["Use the Prices worksheet"]);
    const prices = book.addWorksheet("Prices");
    prices.addRow(["pump_name", "price_per_gallon", "latitude", "longitude"]);
    prices.addRow(["Excel station", 3.75, 35, -100]);
    const buffer = await book.xlsx.writeBuffer();
    const uploading = el("fuelUpload").onchange({
      target: {
        value: "",
        files: [
          {
            name: "prices.xlsx",
            size: buffer.byteLength,
            arrayBuffer: async () => buffer,
          },
        ],
      },
    });
    await until(() => el("workbookDialog").open);
    el("workbookSheet").value = "1";
    el("workbookUse").click();
    await uploading;
    assert.match(el("sourceBadge").textContent, /prices.xlsx · 1 pumps/);
  } finally {
    for (const timer of timers) clearTimeout(timer);
    dom.window.close();
    for (const [key, descriptor] of Object.entries(originals)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
});

test("Backend: private registry, multiple tokens, pagination, client isolation and history fallback", async () => {
  const { generateKeyPairSync } = await import("node:crypto");
  const { once } = await import("node:events");
  const envKeys = [
    "GOOGLE_SERVICE_ACCOUNT_JSON",
    "MASTER_SHEET_ID",
    "SAMSARA_TOKEN",
    "FUEL_REGISTRY_GID",
    "MESSAGE_REGISTRY_GID",
    "SAMSARA_REGISTRY_GID",
  ];
  const oldEnv = Object.fromEntries(envKeys.map((k) => [k, process.env[k]]));
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  process.env.GOOGLE_SERVICE_ACCOUNT_JSON = JSON.stringify({
    client_email: "fco-test@example.invalid",
    private_key: privateKey.export({ type: "pkcs8", format: "pem" }),
  });
  process.env.MASTER_SHEET_ID = "MASTER_TEST";
  delete process.env.SAMSARA_TOKEN;
  delete process.env.FUEL_REGISTRY_GID;
  delete process.env.MESSAGE_REGISTRY_GID;
  delete process.env.SAMSARA_REGISTRY_GID;
  const originalFetch = globalThis.fetch,
    originalNow = Date.now;
  let now = originalNow();
  Date.now = () => now;
  let addClient = false;
  const fakeKeys = [
    "TEST_ALPHA_ONE",
    "TEST_ALPHA_TWO",
    "TEST_BETA",
    "TEST_GAMMA",
  ];
  const requests = [];
  const json = (value) =>
    new Response(JSON.stringify(value), {
      headers: { "Content-Type": "application/json" },
    });
  globalThis.fetch = async (input, options = {}) => {
    const u = new URL(input);
    if (u.hostname === "127.0.0.1") return originalFetch(input, options);
    requests.push({ url: u.toString(), auth: options.headers?.Authorization });
    if (u.hostname === "oauth2.googleapis.com")
      return json({ access_token: "TEST_GOOGLE_OAUTH", expires_in: 3600 });
    if (u.hostname === "sheets.googleapis.com") {
      const decoded = decodeURIComponent(u.pathname);
      if (!decoded.includes("/values/"))
        return json({
          sheets: decoded.includes("/MASTER_TEST")
            ? [
                { properties: { sheetId: 0, title: "Renamed Fuel Registry" } },
                {
                  properties: {
                    sheetId: 970811620,
                    title: "Renamed Driver Registry",
                  },
                },
                {
                  properties: {
                    sheetId: 1100093231,
                    title: "Renamed Fleet Registry",
                  },
                },
              ]
            : [
                { properties: { sheetId: 0, title: "Screenshot Fuel Data" } },
                {
                  properties: { sheetId: 6, title: "Screenshot Message Data" },
                },
              ],
        });
      if (decoded.includes("Screenshot Fuel Data"))
        return json({ values: suppliedFuelTable });
      if (decoded.includes("Screenshot Message Data"))
        return json({ values: suppliedMessageTable });
      if (decoded.includes("Renamed Fleet Registry"))
        return json({
          values: [
            ["Name", "Samsara API", "Samsara API 2", "Samsara API 3"],
            ["Alpha", fakeKeys[0], fakeKeys[1], ""],
            ["Beta", fakeKeys[2], "", ""],
            ...(addClient ? [["Gamma", "", "", fakeKeys[3]]] : []),
          ],
        });
      if (decoded.includes("Renamed Driver Registry"))
        return json({
          values: [
            ["Master Name", "Google Sheet URL", "GID", "Active"],
            [
              "Love's",
              "https://docs.google.com/spreadsheets/d/abcdefghijklmnopqrst1234567890/edit",
              6,
              true,
            ],
          ],
        });
      return json({
        values: [
          ["Master Name", "Google Sheet URL", "GID", "Active"],
          [
            "Alpha Prices",
            "https://docs.google.com/spreadsheets/d/abcdefghijklmnopqrst1234567890/edit",
            0,
            true,
          ],
          [
            "Disabled Prices",
            "https://docs.google.com/spreadsheets/d/abcdefghijklmnopqrst1234567890/edit",
            1,
            false,
          ],
        ],
      });
    }
    if (u.hostname === "api.samsara.com") {
      const token = options.headers.Authorization.slice(7);
      assert.ok(fakeKeys.includes(token));
      assert.ok(!token.includes(","));
      const beta = token === fakeKeys[2],
        second = token === fakeKeys[1];
      if (u.pathname === "/fleet/vehicles") {
        if (!u.searchParams.has("after"))
          return json({
            data: [
              {
                id: "104",
                name: beta ? "BETA 104" : "TRUCK 104",
                vin: "TESTVIN",
              },
            ],
            pagination: { hasNextPage: true, endCursor: "page2" },
          });
        return json({
          data: [{ id: beta ? "B2" : "A2", name: beta ? "BETA 2" : "TRUCK 2" }],
          pagination: { hasNextPage: false, endCursor: "done" },
        });
      }
      if (u.pathname.includes("/stats/feed")) {
        assert.ok(u.searchParams.get("types").split(",").length <= 4);
        if (u.searchParams.get("types") === "engineStates")
          return json({
            data: [
              {
                id: "104",
                engineStates: [{ value: "On", time: "2026-09-11T15:00:00Z" }],
              },
            ],
            pagination: { hasNextPage: false, endCursor: "engine-cursor" },
          });
        return json({
          data: [
            {
              id: "104",
              gps: [
                {
                  latitude: beta ? 40 : second ? 36 : 35,
                  longitude: -100,
                  speedMilesPerHour: 0,
                  time: second
                    ? "2026-09-11T15:01:00Z"
                    : "2026-09-11T15:00:00Z",
                },
              ],
              ...(!beta
                ? {
                    fuelPercents: [
                      {
                        value: second ? 75 : 60,
                        time: second
                          ? "2026-09-11T15:01:00Z"
                          : "2026-09-11T15:00:00Z",
                      },
                    ],
                  }
                : {}),
              obdOdometerMeters: [
                { value: 1609344, time: "2026-09-11T15:00:00Z" },
              ],
            },
          ],
          pagination: { hasNextPage: false, endCursor: "stats-cursor" },
        });
      }
      if (u.pathname.includes("/fuel-energy"))
        return json({
          data: {
            vehicleReports: [
              {
                vehicle: { id: "104", energyType: "fuel" },
                efficiencyMpge: 7,
                distanceTraveledMeters: 1609344,
                fuelConsumedMl: 473176.473,
              },
            ],
          },
          pagination: { hasNextPage: false },
        });
      if (u.pathname.endsWith("/stats/history"))
        return json({
          data: [
            {
              id: "104",
              fuelPercents: [
                { value: 50, time: "2026-09-10T10:00:00Z" },
                { value: 55, time: "2026-09-10T11:00:00Z" },
              ],
            },
          ],
          pagination: { hasNextPage: false },
        });
    }
    throw new Error("Unmocked external endpoint: " + u.pathname);
  };
  let server;
  try {
    const { default: app } = await import("./server.js");
    server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = async (path, body) => {
      const r = await originalFetch(base + "/api/" + path, {
        method: body ? "POST" : "GET",
        headers: body ? { "Content-Type": "application/json" } : {},
        body: body ? JSON.stringify(body) : undefined,
      });
      return { status: r.status, data: await r.json() };
    };
    const config = (await call("config")).data;
    assert.equal(config.clients.length, 2);
    assert.equal(config.clients[0].connections, 2);
    assert.equal(config.masters.length, 1);
    assert.equal(config.messageMasters.length, 1);
    assert.equal(config.errors.length, 0);
    const prices = await call("fuel", { masterId: config.masters[0].id });
    assert.equal(prices.status, 200);
    assert.equal(prices.data.rows[0].name, "Pilot - IN30");
    assert.equal(prices.data.rows[0].exit, "96");
    const locations = await call("messages", {
      masterId: config.messageMasters[0].id,
    });
    assert.equal(locations.status, 200);
    assert.equal(locations.data.rows[1].location, "Newcastle, OK");
    assert.equal(locations.data.rows[1].exit, "107/24th St");
    for (const title of [
      "Renamed Fuel Registry",
      "Renamed Driver Registry",
      "Renamed Fleet Registry",
    ])
      assert.ok(
        requests.some((r) => decodeURIComponent(r.url).includes(title)),
      );
    const visible = JSON.stringify(config);
    for (const key of fakeKeys) assert.ok(!visible.includes(key));
    assert.ok(!visible.includes("private_key"));
    const alpha = (await call("fleet?client=" + config.clients[0].id)).data;
    assert.equal(alpha.vehicles.length, 2);
    const av = alpha.vehicles.find((v) => v.id === "104");
    close(av.lat, 36);
    close(av.fuelPercent, 75);
    close(av.speed, 0);
    close(av.odometer, 1000);
    const beta = (await call("fleet?client=" + config.clients[1].id)).data;
    const bv = beta.vehicles.find((v) => v.id === "104");
    close(bv.lat, 40);
    assert.equal(bv.name, "BETA 104");
    assert.equal(bv.fuelPercent, null);
    const detail = (
      await call(
        "vehicle-detail?client=" + config.clients[1].id + "&vehicle=104",
      )
    ).data;
    close(detail.mpg, 8);
    assert.equal(detail.historyFuel.value, 55);
    assert.equal(detail.historyFuel.time, "2026-09-10T11:00:00Z");
    assert.equal((await call("fleet?client=not-a-client")).status, 400);
    assert.equal(
      (await call("fuel", { url: "http://127.0.0.1/private" })).status,
      400,
    );
    assert.equal((await call("config")).data.clients.length, 2);
    addClient = true;
    now += 61000;
    assert.equal((await call("config")).data.clients.length, 3);
    await call("fleet?client=" + config.clients[0].id);
    assert.ok(requests.some((r) => r.url.includes("after=stats-cursor")));
    assert.ok(requests.some((r) => r.url.includes("after=page2")));
    for (const key of fakeKeys)
      assert.ok(!JSON.stringify({ alpha, beta, detail }).includes(key));
  } finally {
    if (server) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
    for (const [k, v] of Object.entries(oldEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});
