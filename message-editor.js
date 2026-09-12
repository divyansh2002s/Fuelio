import { escapeHTML as h, clean, parseMessageTable } from "./data.js";
import { customMessage, pumpLine } from "./messages.js";
import { stopNumber } from "./view-model.js";

const clone = (value) => JSON.parse(JSON.stringify(value));
export function resolveMessageStop(text, rows) {
  const q = clean(text).toLowerCase();
  if (!q) return { record: null, ambiguous: false };
  let matches = rows.filter((p) => [p.id, p.name, pumpLine(p)].some((x) => clean(x).toLowerCase() === q));
  if (!matches.length && /^#?\d+$/.test(q)) {
    const digits = q.replace(/^#/, "").replace(/^0+(?=\d)/, "");
    matches = rows.filter((p) => stopNumber(p).replace(/^0+(?=\d)/, "") === digits);
  }
  const distinct = [...new Map(matches.map((p) => [JSON.stringify([p.brand, stopNumber(p), p.location, p.highway, p.exit]), p])).values()];
  return { record: distinct.length === 1 ? { ...distinct[0], store: stopNumber(distinct[0]) } : null, ambiguous: distinct.length > 1 };
}
const emptySide = () => ({ text: "", record: null, manual: false, ambiguous: false });
const emptyPair = () => ({ a: emptySide(), b: emptySide() });

// The page and plan dialog use this same component, with independent editable drafts.
export class MessageEditor {
  constructor(root, { prefix, api, readFile, copy, onSave = () => {}, onError = () => {} }) {
    Object.assign(this, { root, prefix, api, readFile, copy, onSave, onError });
    this.fallback = [];
    this.rows = null;
    this.source = "Loaded fuel stops";
    this.master = "";
    this.masters = [];
    this.pairs = [emptyPair()];
    this.sequence = 0;
    const id = (s) => `${prefix}${s}`;
    root.innerHTML = `
      <div class="section-heading"><div><p class="eyebrow">DRIVER MESSAGES</p><h1>Clear stops. Ready to copy.</h1></div><button data-clear class="text-button">Clear</button></div>
      <div class="message-names"><div><label for="${id("Driver")}">Driver</label><input id="${id("Driver")}" data-field="driver" placeholder="Driver name"></div><div><label for="${id("Partner")}">Team driver</label><input id="${id("Partner")}" data-field="partner" placeholder="Optional"></div><div><label for="${id("Route")}">Route</label><input id="${id("Route")}" data-field="route" placeholder="e.g. I-10"></div></div>
      <label for="${id("Master")}">Message master</label><div class="message-source-controls"><select id="${id("Master")}" data-master></select><button data-load class="secondary">Load</button><label class="button secondary">CSV / Excel<input data-upload type="file" accept=".csv,.tsv,.xlsx" hidden></label><button data-sheet-toggle class="quiet">Google Sheet</button><a class="button quiet" href="/message-template.csv" download>CSV template</a></div>
      <p id="${id("Source")}" class="source-badge" data-source></p>
      <div data-sheet-form class="message-sheet" hidden><label>Google Sheet URL<input data-sheet-url placeholder="https://docs.google.com/spreadsheets/d/…"></label><div class="field-grid"><label>Tab GID (optional)<input data-sheet-gid placeholder="From the selected tab URL"></label><label>Brand / source name<input data-sheet-label placeholder="Love's or Pilot"></label></div><button data-sheet-load class="secondary">Load message sheet</button></div>
      <details class="message-help"><summary>CSV &amp; Google Sheet instructions</summary><p>Use this exact header row in row 1:</p><code>StoreNumber,Latitude,Longitude,Location,Highway,Exit</code><p>One fuel stop per row. Keep store numbers as text if they have leading zeros. Location is the city and state, for example <strong>Oklahoma City, OK</strong>. Highway and Exit may be blank. Coordinates are optional for messages. The CSV template contains sample rows; replace them with your own.</p><p>For Google Sheets, use these same six columns, copy the sheet link, and select the correct tab using its GID. Share a private sheet with the existing service-account email as Viewer, or use a sheet already available to anyone with its link. Never publish API keys. Existing message-master links and accepted older headers continue to work. An optional <code>Brand</code> column supports mixed brands.</p></details>
      <p data-error class="error small" role="alert"></p><div id="${id("Pairs")}" data-pairs></div><button data-add class="secondary">+ Add stop / alternative</button>
      <div class="message-previews"><div><div class="section-heading"><h2>Driver message</h2><button data-copy="driver" class="primary">Copy driver message</button></div><textarea id="${id("Preview")}" data-preview="driver" class="message-preview" rows="12" aria-label="Editable driver message"></textarea></div><div data-team-panel><div class="section-heading"><h2>Team-driver message</h2><button data-copy="team" class="secondary">Copy team-driver message</button></div><textarea id="${id("PartnerPreview")}" data-preview="team" class="message-preview" rows="12" aria-label="Editable team-driver message"></textarea></div></div>`;
    this.q = (s) => root.querySelector(s);
    this.qa = (s) => [...root.querySelectorAll(s)];
    this.qa("[data-field]").forEach((el) => el.addEventListener("input", () => this.update()));
    this.qa("[data-preview]").forEach((el) => el.addEventListener("input", () => this.save()));
    this.q("[data-add]").onclick = () => { this.pairs.push(emptyPair()); this.renderPairs(); };
    this.q("[data-clear]").onclick = () => {
      this.pairs = [emptyPair()]; this.qa("[data-field]").forEach((el) => el.value = ""); this.renderPairs();
    };
    this.qa("[data-copy]").forEach((button) => button.onclick = () => this.run(button, async () => {
      if (this.error) throw new Error(this.error);
      const text = this.q(`[data-preview="${button.dataset.copy}"]`).value;
      if (!text.trim()) throw new Error(button.dataset.copy === "team" ? "Enter both driver names and at least one stop." : "Enter at least one stop.");
      await this.copy(text);
    }));
    this.q("[data-master]").onchange = () => { this.sequence++; };
    this.q("[data-load]").onclick = (e) => this.run(e.currentTarget, async () => {
      const seq = ++this.sequence, masterId = this.q("[data-master]").value;
      if (!masterId) { this.rows = null; this.master = ""; this.source = "Loaded fuel stops"; this.pairs = [emptyPair()]; this.renderPairs(); return; }
      const result = await this.api("messages", { masterId });
      if (seq !== this.sequence) return;
      this.applySource(result.rows, this.masters.find((m) => m.id === masterId)?.name || result.source, masterId);
    });
    this.q("[data-upload]").onchange = (e) => this.run(null, async () => {
      const file = e.target.files[0]; if (!file) return;
      const seq = ++this.sequence;
      try {
        const label = this.masters.find((m) => m.id === this.q("[data-master]").value)?.name || file.name;
        const rows = parseMessageTable(await this.readFile(file), label);
        if (seq === this.sequence) this.applySource(rows, `${label} · ${file.name}`, "");
      } finally { e.target.value = ""; }
    });
    this.q("[data-sheet-toggle]").onclick = () => {
      this.q("[data-sheet-form]").hidden = !this.q("[data-sheet-form]").hidden;
    };
    this.q("[data-sheet-load]").onclick = (e) => this.run(e.currentTarget, async () => {
      const seq = ++this.sequence, url = this.q("[data-sheet-url]").value.trim(), gid = this.q("[data-sheet-gid]").value.trim();
      const label = this.q("[data-sheet-label]").value.trim() || "Custom message sheet";
      if (!url) throw new Error("Enter your Google Sheet URL.");
      const result = await this.api("messages", { url, gid, label });
      if (seq !== this.sequence) return;
      this.applySource(result.rows, result.source || label, "");
      this.q("[data-sheet-form]").hidden = true;
    });
    this.setMasters([]); this.renderPairs();
  }
  async run(button, fn) {
    if (button) button.disabled = true;
    try { this.q("[data-error]").textContent = ""; await fn(); }
    catch (error) { this.q("[data-error]").textContent = error.message; this.onError(error); }
    finally { if (button) button.disabled = false; }
  }
  setMasters(masters) {
    this.masters = masters;
    const selected = this.q("[data-master]").value || this.master;
    this.q("[data-master]").innerHTML = `<option value="">Use loaded fuel stops</option>${masters.map((m) => `<option value="${h(m.id)}">${h(m.name)}</option>`).join("")}`;
    this.q("[data-master]").value = masters.some((m) => m.id === selected) ? selected : "";
  }
  setFallback(rows, source) {
    this.fallback = rows;
    this.fallbackSource = source || "No fuel data loaded";
    this.renderSuggestions();
    this.updateSource();
  }
  catalog() { return this.rows || this.fallback; }
  applySource(rows, source, master) {
    if (!rows?.length) throw new Error("No valid message stops were found. Check the template and selected tab.");
    this.rows = rows; this.source = source || rows[0]?.source || "Message file"; this.master = master;
    this.pairs = [emptyPair()]; this.renderPairs();
  }
  updateSource() { this.q("[data-source]").textContent = `${this.rows ? this.source : this.fallbackSource || "Loaded fuel stops"} · ${this.catalog().length} stops`; }
  renderSuggestions() {
    let list = this.q("datalist");
    if (!list) { list = document.createElement("datalist"); list.id = `${this.prefix}StopOptions`; this.root.append(list); }
    list.innerHTML = [...new Map(this.catalog().map((p) => [pumpLine(p), p])).values()]
      .map((p) => `<option value="${h(pumpLine(p))}">${h(stopNumber(p))}</option>`).join("");
  }
  renderPairs() {
    this.renderSuggestions(); this.updateSource();
    this.q("[data-pairs]").innerHTML = this.pairs.map((pair, i) => `<div class="message-pair"><div class="section-heading"><h3>Stop ${i + 1}</h3><button class="text-button" data-remove="${i}">Remove</button></div><div class="message-pair-grid">${["a", "b"].map((side) => `<div class="message-stop"><label for="${this.prefix}-${i}-${side}">${side === "a" ? "Suggested stop" : "Alternative (optional)"}</label><input id="${this.prefix}-${i}-${side}" data-stop-input="${i}:${side}" value="${h(pair[side].text)}" list="${this.prefix}StopOptions" autocomplete="off" placeholder="Enter stop number, e.g. 245"><p class="stop-match small muted" data-match="${i}:${side}"></p><details class="stop-edit"><summary>Edit stop details</summary><div class="field-grid">${[["store", "Stop number"], ["brand", "Brand"], ["location", "City / state"], ["highway", "Highway"], ["exit", "Exit"]].map(([field, label]) => `<label>${label}<input data-detail="${i}:${side}:${field}" value="${h(pair[side].record?.[field] ?? "")}" placeholder="${field === "highway" || field === "exit" ? "May be blank" : "Enter manually"}"></label>`).join("")}</div></details></div>`).join('<span class="pair-or">OR</span>')}</div></div>`).join("");
    this.qa("[data-stop-input]").forEach((input) => input.oninput = () => {
      const [i, side] = input.dataset.stopInput.split(":");
      this.pairs[i][side] = { text: input.value, ...resolveMessageStop(input.value, this.catalog()), manual: false };
      this.fillDetails(i, side); this.update();
    });
    this.qa("[data-detail]").forEach((input) => input.oninput = () => {
      const [i, side, field] = input.dataset.detail.split(":"); const item = this.pairs[i][side];
      item.record = { ...(item.record || { store: item.text.replace(/^#/, ""), brand: "", location: "", highway: "", exit: "" }), [field]: input.value };
      item.record.id = `manual:${i}:${side}`;
      item.record.name = item.record.store ? [item.record.brand, `#${item.record.store}`].filter(Boolean).join(" ") : item.record.name || "";
      item.manual = true; item.ambiguous = false;
      if (field === "store" || !item.text) { item.text = item.record.store || ""; this.q(`[data-stop-input="${i}:${side}"]`).value = item.text; }
      this.update();
    });
    this.qa("[data-remove]").forEach((b) => b.onclick = () => {
      this.pairs.splice(Number(b.dataset.remove), 1); if (!this.pairs.length) this.pairs.push(emptyPair()); this.renderPairs();
    });
    this.update();
  }
  fillDetails(i, side) {
    const record = this.pairs[i][side].record;
    this.qa(`[data-detail^="${i}:${side}:"]`).forEach((el) => el.value = record?.[el.dataset.detail.split(":")[2]] || "");
  }
  inputs() {
    const pairs = this.pairs.filter((p) => p.a.text.trim() || p.b.text.trim() || p.a.manual || p.b.manual).map((p, i) => {
      for (const side of ["a", "b"]) {
        const item = p[side];
        if (side === "b" && !item.text.trim() && !item.manual) continue;
        if (item.ambiguous) throw new Error(`Stop ${item.text} matches more than one brand or location. Choose its full entry from the suggestions.`);
        if (!item.record) throw new Error(`Enter or choose ${side === "a" ? "the suggested stop" : "an alternative"} for pair ${i + 1}. Unmatched numbers need manual details.`);
        if (item.manual && ((!clean(item.record.store) && !clean(item.record.name)) || !clean(item.record.location))) throw new Error("Enter the manual stop number or name and city / state before copying.");
      }
      return { a: p.a.record, b: p.b.record };
    });
    return { ...Object.fromEntries(this.qa("[data-field]").map((el) => [el.dataset.field, el.value])), pairs };
  }
  update() {
    this.pairs.forEach((p, i) => ["a", "b"].forEach((side) => {
      const item = p[side], match = this.q(`[data-match="${i}:${side}"]`);
      if (match) match.textContent = item.record ? pumpLine(item.record) : item.ambiguous ? "Multiple matches — choose the full stop entry." : item.text ? "No exact match. Select a suggestion or enter stop details below." : "";
    }));
    this.error = "";
    try {
      const data = this.inputs();
      this.q('[data-preview="driver"]').value = data.pairs.length ? customMessage(data) : "";
      this.q('[data-preview="team"]').value = data.pairs.length && data.driver.trim() && data.partner.trim() ? customMessage({ ...data, audience: "team" }) : "";
      this.q('[data-copy="driver"]').disabled = !data.pairs.length;
      this.q('[data-copy="team"]').disabled = !data.pairs.length || !data.driver.trim() || !data.partner.trim();
    } catch (error) {
      this.error = error.message;
      this.qa("[data-preview]").forEach((el) => el.value = "");
      this.qa("[data-copy]").forEach((el) => el.disabled = true);
    }
    this.q("[data-error]").textContent = this.error;
    this.save();
  }
  save() { this.onSave(this.snapshot()); }
  snapshot() {
    return { version: 2, rows: this.rows, source: this.source, master: this.master, pairs: clone(this.pairs), fields: Object.fromEntries(this.qa("[data-field]").map((el) => [el.dataset.field, el.value])), previews: Object.fromEntries(this.qa("[data-preview]").map((el) => [el.dataset.preview, el.value])) };
  }
  restore(data) {
    if (!data) return;
    this.rows = data.rows || null; this.source = data.source || data.rows?.[0]?.source || "Message master"; this.master = data.master || "";
    this.q("[data-master]").value = this.master;
    this.qa("[data-field]").forEach((el) => {
      const oldKey = { driver: "messageDriver", partner: "messagePartner", route: "messageRoute" }[el.dataset.field];
      el.value = data.fields?.[el.dataset.field] ?? data.fields?.[oldKey] ?? "";
    });
    this.pairs = (data.pairs?.length ? data.pairs : [emptyPair()]).map((p) => Object.fromEntries(["a", "b"].map((side) => {
      const value = p[side];
      if (value && typeof value === "object") return [side, clone(value)];
      const match = resolveMessageStop(value, this.catalog());
      return [side, { ...emptySide(), ...match, text: match.record ? stopNumber(match.record) || match.record.name : value || "" }];
    })));
    this.setMasters(this.masters); this.renderPairs();
    if (data.version === 2 && !this.error) this.qa("[data-preview]").forEach((el) => { if (data.previews?.[el.dataset.preview] != null) el.value = data.previews[el.dataset.preview]; });
  }
  setPlan(plan, route, names = {}) {
    this.pairs = plan.stops.map((stop) => {
      const source = { ...stop, store: stopNumber(stop) };
      const numberMatch = resolveMessageStop(source.store, this.catalog());
      const matched = numberMatch.record;
      const sameBrand = matched && clean(matched.brand).toLowerCase() === clean(stop.brand).toLowerCase();
      const record = sameBrand ? { ...source, ...matched } : source;
      return { a: { text: record.store || record.name, record, manual: false, ambiguous: false }, b: emptySide() };
    });
    if (!this.pairs.length) this.pairs = [emptyPair()];
    this.q('[data-field="route"]').value = route;
    for (const field of ["driver", "partner"]) this.q(`[data-field="${field}"]`).value = names[field] || "";
    this.renderPairs();
  }
}
