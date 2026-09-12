import { mkdir, copyFile, cp, readFile, writeFile } from "node:fs/promises";
const files = [
  "index.html",
  "styles.css",
  "workspace.js",
  "optimizer.js",
  "geo.js",
  "data.js",
  "messages.js",
  "batch.js",
  "worker.js",
  "route-library.json",
  "california.json",
  "fuel-template.csv",
  "load-template.csv",
  "message-template.csv",
  "message-editor.js",
  "view-model.js",
  "place-search.js",
  "hybrid-map.js",
  "vehicle-rocket.svg",
  "vehicle-ufo.svg",
  "fuelio-brand.png",
];
await mkdir("public", { recursive: true });
for (const file of files) await copyFile(file, `public/${file}`);
await mkdir("public/vendor", { recursive: true });
await copyFile(
  "node_modules/exceljs/dist/exceljs.min.js",
  "public/vendor/exceljs.min.js",
);
await cp("node_modules/leaflet/dist", "public/vendor/leaflet", {
  recursive: true,
});
await copyFile(
  "node_modules/maplibre-gl/dist/maplibre-gl.js",
  "public/vendor/maplibre-gl.js",
);
await copyFile(
  "node_modules/maplibre-gl/dist/maplibre-gl.css",
  "public/vendor/maplibre-gl.css",
);
await copyFile(
  "node_modules/@maplibre/maplibre-gl-leaflet/leaflet-maplibre-gl.js",
  "public/vendor/leaflet-maplibre-gl.js",
);
const notices = [];
for (const [name, path] of [
  ["Leaflet", "leaflet/LICENSE"],
  ["MapLibre GL JS", "maplibre-gl/LICENSE.txt"],
  ["MapLibre GL Leaflet", "@maplibre/maplibre-gl-leaflet/LICENSE"],
  ["ExcelJS", "exceljs/LICENSE"],
])
  notices.push(`${name}\n${await readFile(`node_modules/${path}`, "utf8")}`);
await writeFile("public/vendor/THIRD-PARTY-NOTICES.txt", notices.join("\n\n"));
const html = await readFile("public/index.html", "utf8");
if (!html.includes("workspace.js"))
  throw new Error("Missing application entrypoint");
console.log(
  "FCO built. Only public assets are copied to public/; server configuration stays private.",
);
