export const clean = (value) => String(value ?? "").trim();
export const header = (value) =>
  clean(value)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
export const escapeHTML = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
export function number(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  let text = clean(value).replace(/[$%\s]/g, "");
  if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(text)) text = text.replace(/,/g, "");
  if (!/^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(text)) return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}
export function parseCSV(text) {
  text = String(text).replace(/^\uFEFF/, "");
  const sample = text.split(/\r?\n/).slice(0, 12).join("\n");
  const delimiter = ["\t", ",", ";"]
    .map((d) => [d, sample.split(d).length])
    .sort((a, b) => b[1] - a[1])[0][0];
  const rows = [];
  let row = [],
    field = "",
    quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      if (quoted && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (quoted || !field) quoted = !quoted;
      else field += c;
    } else if (!quoted && c === delimiter) {
      row.push(field);
      field = "";
    } else if (!quoted && (c === "\n" || c === "\r")) {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      if (row.some((c) => clean(c))) rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (quoted) throw new Error("CSV has an unclosed quoted field.");
  row.push(field);
  if (row.some((c) => clean(c))) rows.push(row);
  return rows;
}
export function toCSV(rows) {
  return rows
    .map((row) =>
      row
        .map((cell) => {
          let s = String(cell ?? "");
          if (/^[=+@\t\r]/.test(s) || (/^-/.test(s) && number(s) === null))
            s = "'" + s;
          return '"' + s.replace(/"/g, '""') + '"';
        })
        .join(","),
    )
    .join("\r\n");
}
export const ALIASES = {
  name: [
    "pumpname",
    "truckstop",
    "stationname",
    "pump",
    "name",
    "storename",
    "locationname",
    "station",
    "fuelstop",
    "sitename",
    "vendor",
    "store",
    "columna",
    "a",
  ],
  store: [
    "storenumber",
    "storeno",
    "store",
    "pumpnumber",
    "stationid",
    "storeid",
    "id",
  ],
  price: [
    "bestdiscountedprice",
    "discountedprice",
    "netprice",
    "pricepergallon",
    "pricepergal",
    "pricegallon",
    "costpergallon",
    "cpg",
    "dieselprice",
    "price",
    "fuelprice",
    "bestprice",
    "retailprice",
    "rate",
    "columnb",
    "b",
  ],
  lat: ["latitude", "lat", "latitudedegrees", "y", "columnc", "c"],
  lon: [
    "longitude",
    "long",
    "lng",
    "lon",
    "longitudedegrees",
    "x",
    "columnd",
    "d",
  ],
  city: ["city", "town", "municipality", "columne", "e"],
  state: ["state", "statecode", "province", "st", "columnf", "f"],
  location: ["location", "address", "citystate", "fulladdress"],
  brand: ["brand", "network", "chain"],
  highway: [
    "highway",
    "hw",
    "interstate",
    "route",
    "highways",
    "highwayname",
    "interstatehighway",
    "corridor",
    "routename",
    "road",
    "columng",
    "g",
  ],
  exit: ["exit", "exitnumber", "exitno", "exitname", "columnh", "h"],
  mile: ["distancefromstartmiles", "routemile", "mile", "milepost"],
};
const findCol = (hs, aliases) => {
  for (const a of aliases) {
    const i = hs.indexOf(a);
    if (i >= 0) return i;
  }
  return -1;
};
export function tableRecords(table) {
  if (!Array.isArray(table) || !table.length)
    throw new Error("The sheet is empty.");
  const names = table[0].map(header);
  return table
    .slice(1)
    .filter((row) => row.some((v) => clean(v)))
    .map((row) =>
      Object.fromEntries(names.map((name, i) => [name, row[i] ?? ""])),
    );
}
export function highwayTokens(value) {
  return [
    ...new Set(
      clean(value)
        .toUpperCase()
        .replace(/INTERSTATE\s*/g, "I-")
        .replace(/\b(I|US|SR)\s*-?\s*(\d+)/g, "$1-$2")
        .match(/(?:I|US|SR)-\d+[A-Z]?/g) || [],
    ),
  ];
}
export const STATES =
  "AL Alabama|AK Alaska|AZ Arizona|AR Arkansas|CA California|CO Colorado|CT Connecticut|DE Delaware|DC District of Columbia|FL Florida|GA Georgia|HI Hawaii|ID Idaho|IL Illinois|IN Indiana|IA Iowa|KS Kansas|KY Kentucky|LA Louisiana|ME Maine|MD Maryland|MA Massachusetts|MI Michigan|MN Minnesota|MS Mississippi|MO Missouri|MT Montana|NE Nebraska|NV Nevada|NH New Hampshire|NJ New Jersey|NM New Mexico|NY New York|NC North Carolina|ND North Dakota|OH Ohio|OK Oklahoma|OR Oregon|PA Pennsylvania|RI Rhode Island|SC South Carolina|SD South Dakota|TN Tennessee|TX Texas|UT Utah|VT Vermont|VA Virginia|WA Washington|WV West Virginia|WI Wisconsin|WY Wyoming"
    .split("|")
    .map((x) => [x.slice(0, 2), x.slice(3)]);
export function stateCode(v) {
  const t = clean(v);
  return (
    STATES.find(
      ([a, b]) =>
        a.toLowerCase() === t.toLowerCase() ||
        b.toLowerCase() === t.toLowerCase(),
    )?.[0] || t.toUpperCase()
  );
}
export function parseFuelTable(table, source = "Uploaded data") {
  if (!table?.length) throw new Error("No fuel rows found.");
  let best = -1,
    bestScore = -1;
  table.slice(0, 12).forEach((row, i) => {
    const hs = row.map(header);
    const score =
      ["lat", "lon", "price"].reduce(
        (n, k) => n + (findCol(hs, ALIASES[k]) >= 0 ? 3 : 0),
        0,
      ) + (findCol(hs, [...ALIASES.name, ...ALIASES.store]) >= 0 ? 1 : 0);
    if (score > bestScore) {
      best = i;
      bestScore = score;
    }
  });
  if (bestScore < 9)
    throw new Error(
      "Fuel data needs price, latitude and longitude headers. Download the fuel template for accepted columns.",
    );
  const hs = table[best].map(header),
    cols = Object.fromEntries(
      Object.entries(ALIASES).map(([k, a]) => [k, findCol(hs, a)]),
    );
  if (hs.every((k) => /^(column)?[a-z]$/.test(k)) && hs.length === 5) {
    const sample = table.slice(best + 1).find((r) => r.some((v) => clean(v)));
    if (sample && number(sample[1]) === null && number(sample[2]) !== null) {
      Object.assign(cols, {
        name: 0,
        location: 1,
        price: 2,
        lat: 3,
        lon: 4,
        city: -1,
        state: -1,
      });
    }
  }
  const seen = new Map(),
    rows = [],
    issues = [];
  for (let i = best + 1; i < table.length; i++) {
    const row = table[i];
    if (!row.some((v) => clean(v))) continue;
    const get = (k) => (cols[k] < 0 ? "" : row[cols[k]]);
    const lat = number(get("lat")),
      lng = number(get("lon")),
      price = number(get("price"));
    if (
      lat === null ||
      lng === null ||
      lat < -90 ||
      lat > 90 ||
      lng < -180 ||
      lng > 180 ||
      price === null ||
      price <= 0
    ) {
      issues.push(`Row ${i + 1}: invalid coordinates or non-positive price.`);
      continue;
    }
    let brand = clean(get("brand"));
    const originalName = clean(get("name"));
    const sourceText = `${brand} ${originalName} ${source}`;
    if (!brand)
      brand = /love'?s/i.test(sourceText)
        ? "Love's"
        : /pilot|flying\s*j/i.test(sourceText)
          ? /flying\s*j/i.test(sourceText)
            ? "Flying J"
            : "Pilot"
          : "";
    const store =
      clean(get("store")) || originalName.match(/(?:#|\b)(\d+)\s*$/)?.[1] || "";
    const name =
      /^#?\d+$/.test(originalName) && brand
        ? `${brand} #${store || originalName.replace("#", "")}`
        : originalName ||
          [brand, store ? `#${store}` : ""].filter(Boolean).join(" ") ||
          `Pump ${i + 1}`;
    let city = clean(get("city")),
      state = stateCode(get("state")),
      location = clean(get("location"));
    if (!city && location) {
      const match = location.match(/^(.*?),\s*([A-Z]{2})(?:\s+\d{5}.*)?$/i);
      if (match) {
        city = match[1];
        if (!state) state = stateCode(match[2]);
      }
    }
    const highway = clean(get("highway")),
      exit = clean(get("exit"));
    const id = `${brand.toLowerCase()}|${store || name.toLowerCase()}|${lat.toFixed(6)},${lng.toFixed(6)}`;
    const pump = {
      id,
      name,
      store,
      brand,
      price,
      lat,
      lng,
      city,
      state,
      location: location || [city, state].filter(Boolean).join(", "),
      highway,
      highways: highwayTokens(highway),
      exit,
      source,
      mile: number(get("mile")),
    };
    if (seen.has(id)) {
      const prev = seen.get(id);
      if (Math.abs(prev.price - price) > 1e-8)
        throw new Error(
          `Conflicting prices for ${name} at the same coordinates. Correct duplicate rows in ${source}.`,
        );
      issues.push(`Row ${i + 1}: duplicate ${name} omitted.`);
      continue;
    }
    seen.set(id, pump);
    rows.push(pump);
  }
  if (!rows.length)
    throw new Error(
      "No valid fuel pumps remain after checking prices and coordinates.",
    );
  return { rows, issues, source, loadedAt: new Date().toISOString() };
}
export function parseSheetReference(value, gidOverride) {
  const s = clean(value);
  let id,
    gid = "0";
  if (/^[\w-]{20,}$/.test(s)) id = s;
  else {
    let u;
    try {
      u = new URL(s);
    } catch {
      throw new Error("Enter a Google Sheets URL.");
    }
    if (u.hostname !== "docs.google.com")
      throw new Error("Only docs.google.com spreadsheet URLs are accepted.");
    id = u.pathname.match(/\/spreadsheets\/d\/([\w-]+)/)?.[1];
    if (!id) throw new Error("The spreadsheet URL is not valid.");
    gid =
      u.searchParams.get("gid") ||
      new URLSearchParams(u.hash.slice(1)).get("gid") ||
      "0";
  }
  if (
    gidOverride !== undefined &&
    gidOverride !== null &&
    String(gidOverride) !== ""
  )
    gid = String(gidOverride);
  if (!/^\d+$/.test(gid))
    throw new Error("GID must be the numeric sheet-tab ID; 0 is valid.");
  return { id, gid };
}
export function parseMessageTable(table, source = "Message master") {
  if (!Array.isArray(table) || !table.length)
    throw new Error("The sheet is empty.");
  const headerIndex = table.slice(0, 12).findIndex((row) => {
    const hs = row.map(header);
    return (
      findCol(hs, ALIASES.store) >= 0 &&
      findCol(hs, ["location", "city", "address", ...ALIASES.highway]) >= 0
    );
  });
  const records =
    headerIndex >= 0
      ? tableRecords(table.slice(headerIndex))
      : table
          .filter((row) => clean(row[0]) && /^#?\d+$/.test(clean(row[0])))
          .map((row) => ({
            storenumber: clean(row[0]).replace(/^#/, ""),
            location: row[row.length >= 6 ? 3 : 1],
            highway: row[row.length >= 6 ? 4 : 2],
            exit: row[row.length >= 6 ? 5 : 3],
          }));
  const rows = [];
  for (const rec of records) {
    const take = (names) =>
      names.map((n) => rec[n]).find((v) => clean(v)) ?? "";
    const store = clean(take(ALIASES.store));
    if (!store) continue;
    const brand =
      clean(take(ALIASES.brand)) ||
      (/pilot/i.test(source)
        ? "Pilot"
        : /love/i.test(source)
          ? "Love's"
          : source);
    rows.push({
      id: `${brand}:${store}`,
      store,
      brand,
      location: clean(take(["location", "city", "address"])),
      highway: clean(take(ALIASES.highway)),
      exit: clean(take(ALIASES.exit)),
      name: `${brand} #${store}`,
      source,
    });
  }
  if (!rows.length)
    throw new Error(
      "Message master needs Store Number, Location, Highway and Exit columns.",
    );
  return rows;
}
