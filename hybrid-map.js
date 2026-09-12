// Reference styling only. No routing, fuel calculation or telemetry lives here.
export const HYBRID_STYLE_URL = "https://tiles.openfreemap.org/styles/liberty";
const ATTRIBUTION = '<a href="https://openfreemap.org/">OpenFreeMap</a> · <a href="https://openmaptiles.org/">OpenMapTiles</a> · © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';
const COMPATIBILITY_ATTRIBUTION = 'Reference: Esri, HERE, Garmin, OpenStreetMap contributors';
const REFERENCE_URL = "https://services.arcgisonline.com/ArcGIS/rest/services/Reference/";

export function makeHybridStyle(original) {
  if (!original || original.version !== 8 || !Array.isArray(original.layers))
    throw new Error("The Hybrid reference style is unavailable.");
  const style = structuredClone(original);
  style.name = "Fuelio Hybrid reference";
  // Transparent reference only: no land, shaded relief or raster background.
  style.layers = style.layers.filter((layer) =>
    layer.type === "symbol" || (layer.type === "line" &&
      (/road|transport|highway|bridge|tunnel|boundary/.test(layer.id))));
  const used = new Set(style.layers.map((layer) => layer.source).filter(Boolean));
  style.sources = Object.fromEntries(Object.entries(style.sources || {}).filter(([id]) => used.has(id)));
  for (const layer of style.layers) {
    layer.paint = { ...layer.paint };
    layer.layout = { ...layer.layout };
    if (layer.type === "symbol" && layer.layout["text-field"]) {
      if (/highway-shield/.test(layer.id)) continue;
      layer.paint["text-color"] = "#ffffff";
      layer.paint["text-halo-color"] = "#142331";
      layer.paint["text-halo-width"] = 1.8;
      layer.paint["text-halo-blur"] = 0.3;
      layer.paint["text-opacity"] = 1;
      // Missing optional POI/city sprites must never hide the place name.
      if (layer.layout["icon-image"]) layer.layout["icon-optional"] = true;
    }
    if (layer.type === "line") {
      const casing = /casing|outline/.test(layer.id);
      const local = /minor|service|track|path|pedestrian/.test(layer.id);
      const rail = /rail/.test(layer.id);
      layer.paint["line-color"] = /boundary/.test(layer.id) ? "#d9e2eb"
        : casing ? "#27333d" : rail ? "#c8d2d8" : local ? "#f2f0e6" : "#ffd18a";
    }
  }
  // Explicit, sprite-independent US route labels also cover US/state highways,
  // which the stock Liberty shield filters do not consistently include.
  const shield = style.layers.find((layer) => /highway-shield/.test(layer.id));
  if (shield) {
    style.layers = style.layers.filter((layer) => !/highway-shield/.test(layer.id));
    const placeIndex = style.layers.findIndex((layer) => layer["source-layer"] === "place");
    const ref = ["to-string", ["get", "ref"]];
    const numericStart = ["match", ["slice", ref, 0, 1], ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"], true, false];
    const refs = {
      id: "fuelio-highway-references", type: "symbol", source: shield.source,
      "source-layer": shield["source-layer"], minzoom: 6,
      filter: ["all", ["has", "ref"], ["!=", ["get", "ref"], ""],
        ["match", ["geometry-type"], ["LineString", "MultiLineString"], true, false]],
      layout: {
        "symbol-placement": "line", "symbol-spacing": 260,
        "text-field": ["concat", ["case", numericStart, ["match", ["get", "network"],
          "us-interstate", "I-", "us-highway", "US-", "us-state", "SR-", ""], ""], ref],
        "text-font": ["Noto Sans Bold"], "text-size": 11,
        "text-rotation-alignment": "viewport", "text-pitch-alignment": "viewport",
        "text-padding": 5, "text-max-width": 12,
      },
      paint: { "text-color": "#ffffff", "text-halo-color": "#142331", "text-halo-width": 2, "text-halo-blur": 0.2 },
    };
    style.layers.splice(placeIndex < 0 ? style.layers.length : placeIndex, 0, refs);
  }
  return style;
}

export class HybridReference {
  constructor(map, leaflet, report = () => {}) {
    this.map = map; this.L = leaflet; this.report = report; this.generation = 0;
    for (const [name, z] of [["fuelioHybridFallback", 300], ["fuelioHybridLabels", 350]]) {
      const pane = map.getPane(name) || map.createPane(name);
      pane.style.zIndex = String(z);
      pane.style.pointerEvents = "none";
    }
  }
  remove(layer) { if (layer && this.map.hasLayer(layer)) this.map.removeLayer(layer); }
  hide() {
    this.generation++; this.visible = false;
    this.controller?.abort(); clearTimeout(this.timer); clearTimeout(this.readyTimer);
    this.remove(this.vector); this.vector = null;
    for (const layer of this.fallback || []) this.remove(layer);
  }
  showFallback() {
    if (!this.visible) return;
    if (!this.fallback) this.fallback = ["World_Transportation", "World_Boundaries_and_Places"].map((name) => {
      const layer = this.L.tileLayer(`${REFERENCE_URL}${name}/MapServer/tile/{z}/{y}/{x}`, {
        pane: "fuelioHybridFallback", maxZoom: 19, maxNativeZoom: 19,
        attribution: COMPATIBILITY_ATTRIBUTION,
      });
      layer.on?.("tileerror", () => {
        if (this.visible && this.map.hasLayer(layer) && !this.tileWarning) {
          this.tileWarning = true;
          this.report("Some Hybrid reference tiles could not load. Toggle Satellite to retry.");
        }
      });
      return layer;
    });
    for (const layer of this.fallback) if (!this.map.hasLayer(layer)) layer.addTo(this.map);
  }
  async show() {
    this.hide(); this.visible = true; this.tileWarning = false;
    const generation = this.generation;
    this.showFallback();
    if (!this.L.maplibreGL) return;
    const current = () => this.visible && generation === this.generation;
    let degraded = false;
    const fallback = () => {
      if (!current() || degraded) return;
      degraded = true; clearTimeout(this.readyTimer);
      this.remove(this.vector); this.vector = null; this.showFallback();
      this.report("Hybrid is using its compatibility road-and-place reference layer.");
    };
    try {
      if (!this.style) {
        const controller = this.controller = new AbortController();
        this.timer = setTimeout(() => controller.abort(), 12000);
        let response;
        try {
          response = await fetch(HYBRID_STYLE_URL, { signal: controller.signal });
          if (!response.ok) throw new Error("Reference style did not load.");
          const style = makeHybridStyle(await response.json());
          if (!current()) return;
          this.style = style;
        } finally { if (current()) clearTimeout(this.timer); }
      }
      if (!current()) return;
      const layer = this.vector = this.L.maplibreGL({
        style: structuredClone(this.style), interactive: false,
        pane: "fuelioHybridLabels", attribution: ATTRIBUTION,
      });
      layer.addTo(this.map);
      const gl = layer.getMaplibreMap();
      gl.on("error", fallback);
      const ready = () => {
        if (!current() || degraded || !gl.isStyleLoaded() || !gl.queryRenderedFeatures().length) return;
        clearTimeout(this.readyTimer);
        for (const raster of this.fallback || []) this.remove(raster);
      };
      gl.on("idle", ready);
      this.readyTimer = setTimeout(fallback, 16000);
    } catch { fallback(); }
  }
}
