// Reusable, race-safe autocomplete for origin, destination and each waypoint.
export function bindPlaceSearch(input, box, { suggest, submit, coordinates, select, changed = () => {} }) {
  let timer, sequence = 0, controller, results = [], active = -1;
  const close = () => {
    sequence++; clearTimeout(timer); controller?.abort(); box.hidden = true;
    input.setAttribute("aria-expanded", "false"); active = -1; input.removeAttribute("aria-activedescendant");
  };
  input.setAttribute("role", "combobox"); input.setAttribute("aria-autocomplete", "list");
  input.setAttribute("aria-controls", box.id); input.setAttribute("aria-expanded", "false");
  box.setAttribute("role", "listbox");
  const choose = (index) => {
    const place = results[index]; if (!place) return;
    input.value = place.label || `${place.lat}, ${place.lng}`;
    input.dataset.selectedLabel = input.value; input.dataset.coordinates = JSON.stringify(place);
    close(); select(place);
  };
  const search = async (explicit = false) => {
    clearTimeout(timer); controller?.abort();
    const query = input.value.trim(), token = ++sequence;
    if (!query || (!explicit && query.length < 3)) { close(); return; }
    controller = new AbortController();
    try {
      const direct = coordinates(query);
      results = direct ? [{ ...direct, label: direct.label || query }] : await (explicit ? submit : suggest)(query, controller.signal);
      if (token !== sequence || query !== input.value.trim() || !input.isConnected) return;
      box.replaceChildren(); active = -1;
      results.forEach((place, i) => {
        const button = document.createElement("button"); button.type = "button"; button.role = "option";
        button.id = `${box.id}-${i}`; button.textContent = place.label; button.onclick = () => choose(i);
        box.append(button);
      });
      if (!results.length) { const p = document.createElement("p"); p.className = "small muted"; p.textContent = "No suggestions. Try city and state, or enter coordinates."; box.append(p); }
      box.hidden = false; input.setAttribute("aria-expanded", "true");
    } catch (error) {
      if (token !== sequence || error.name === "AbortError") return;
      box.replaceChildren();
      const p = document.createElement("p"); p.className = "small muted";
      p.textContent = explicit ? error.message : "Suggestions unavailable. Press Enter to search, or enter coordinates.";
      box.append(p); box.hidden = false; input.setAttribute("aria-expanded", "true");
    }
  };
  input.addEventListener("input", () => {
    close(); delete input.dataset.coordinates; delete input.dataset.selectedLabel;
    changed(); timer = setTimeout(() => search(false), 450);
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Escape") { event.preventDefault(); close(); }
    if ((event.key === "ArrowDown" || event.key === "ArrowUp") && !box.hidden && results.length) {
      event.preventDefault(); active = (active + (event.key === "ArrowDown" ? 1 : -1) + results.length) % results.length;
      [...box.querySelectorAll("button")].forEach((button, i) => button.setAttribute("aria-selected", String(i === active)));
      input.setAttribute("aria-activedescendant", `${box.id}-${active}`);
    }
    if (event.key === "Enter") { event.preventDefault(); if (active >= 0 && !box.hidden) choose(active); else void search(true); }
  });
  return { search, close, contains: (target) => target === input || box.contains(target) };
}
