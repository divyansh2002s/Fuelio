# Fuelio — page update

This is an **update package**, not a replacement repository. It contains only changed/new files, plus this note and a checksum manifest. Keep all your other GitHub files.

## Install

1. Extract `Fuelio-Pages-Update.zip` on your computer.
2. In the **Fuelio** GitHub repository, use **Add file → Upload files**. Upload the extracted files into the same root folder as your existing `package.json`. Replace matching filenames and commit the changes. Upload the extracted files, not the ZIP or a containing folder.
3. Let your connected Vercel project deploy that commit. After it is Ready, refresh Fuelio with **Ctrl+Shift+R**.

Keep the existing Vercel settings and environment variables. Do not upload a service-account JSON/key file. There are no new required keys, dependencies or paid plans for this update.

## Included files

| Replace existing | Add new |
| --- | --- |
| `index.html` | `message-editor.js` |
| `styles.css` | `view-model.js` |
| `workspace.js` | `place-search.js` |
| `messages.js` | `message-template.csv` |
| `server.js` | `vehicle-rocket.svg` |
| `build.js` | `vehicle-ufo.svg` |
| `tests.mjs` | `fuelio-brand.png` |

`UPDATE-FUELIO.md` and `UPDATE-MANIFEST.json` are documentation/verification files. They are safe to upload too, but are not served as app assets.

## What changed

- **Messages and Planner messages:** the same editor, manual stop-number entry with suggestions, editable details, blank alternatives, separate primary/team-driver wording, editable previews, copy buttons, CSV template and Google Sheet instructions. Planner message edits do not change its fuel calculation. Reopening a result retains its draft during the current session; the standalone Messages draft is saved in browser storage.
- **Fuel Stops:** list left/map right; live search with exact stop-number priority; Mt/Mount, St/Saint, directional and Mc/Mac matching; no state-name alias expansion; data-driven state and highway filters; highway counts and search; three-state price-header sorting; synchronized selection, popups and hover details; map/satellite, Price Heat, fit, fullscreen and reset.
- **Critical filter behavior:** without a selected highway, Search and State affect only the list. Selecting highways makes both map and list use Search AND State AND (Highway A OR Highway B). Clear resets those filters, ordering and selection, fits all stops, and retains the source/theme/basemap. The small highway × clears only the highway-search text. Stop filters, ordering and selection are remembered in browser preferences.
- **Fleet:** list left/map right; deactivated-name records hidden from the interface, not deleted from source data; fuel%, MPG, speed and location in list/map; history fallback where the existing API supplies it; heading-aware rocket markers; row-to-map focus and hover; no Plan trip action, Price Heat or fuel-source caption on the Fleet map.
- **Planner:** active vehicle UFO markers plus its existing stop layers; information-only vehicle marker clicks; compact editable telemetry; search-as-you-type origin/destination/waypoints; individually reorderable waypoints; default maximum stops 3; independent desktop scroll areas; pinned Find routes and Fuelio Hunt actions; no Save trip button or manual-planning information card. Fuel-rule edits reuse routes; changing truck/locations/routing settings requires Find routes again. On narrow screens the layout stacks to keep controls usable.
- **Branding:** Fuelio name and the supplied logo artwork; reference-style scalable rocket/UFO icons; refreshed Icy palette alongside Light, Dark and Crimson. User-facing terminology is Stop/Stops. Compatibility headers such as `pump_name`, source records, internal IDs and URLs remain unchanged.
- **Routes & loads:** navigation and page are hidden, including direct navigation. All library, saved-route, import, clustering, batch and export code/data remain intact.

## What did NOT change

The optimiser, worker, geometry/corridor calculations, fuel and message input parsers, route library, California boundary, batch calculations, existing routing endpoints, and server-side Samsara/Google Sheets integration are unchanged. The existing timeout protection is retained. Authentication, client connections, units, MPG calculations, pagination and fuel-history rules are not rewritten. Existing saved trip values are retained; the new maximum-stops default is 3 for a fresh workspace, and remains manually editable if your browser previously saved another value.

`server.js` is included only because it adds `/api/suggest` for autocomplete. The existing API sections are protected by hash-based regression checks.

Live fleet snapshots still refresh every 60 seconds while the app is open. Optional per-vehicle MPG/history details load separately with at most two background requests at once, so slow reports do not block the list. A selected truck refreshes its existing detail report on the normal refresh cycle. Other already-loaded 30-day MPG reports are cached for up to 15 minutes; missing fuel uses the existing history fallback and retries on the next eligible refresh. Missing values remain “—”, not guessed data. Manual Planner overrides remain editable and are not overwritten by live refreshes.

## Address suggestions

Typing uses a debounced, cached [Photon autocomplete endpoint](https://github.com/komoot/photon/blob/master/docs/api-v1.md). The existing submit/Enter geocoder is retained; [public Nominatim does not permit client-side autocomplete](https://operations.osmfoundation.org/policies/nominatim/).

No new API key is required. The public suggestions service has no guaranteed availability. If it cannot respond, the field offers Enter/search or direct latitude, longitude entry. An optional server-only `PHOTON_URL` may point to your own compatible Photon server later; nothing needs to be added now. Route providers, street tiles, satellite imagery and reference labels are unchanged.

## Verification and first live check

Run locally with the existing project dependencies: `npm run build` followed by `npm test`.

The automated suite covers the existing 600 exhaustive-comparison optimiser cases, unchanged-file/section hashes, the supplied CSV formats, multi-client isolation and failure/time-out recovery, history fuel, map/list selection rules, editable messages, autocomplete races and waypoint order. DOM interaction tests use simulated API responses; they are not a test against your actual private fleet.

After deployment, check each client, one live truck, both message copies, a fuel-source upload and one familiar route. The live Google/Samsara/provider checks and a real-browser visual review could not be completed in the packaging environment. If a provider does not supply fuel or MPG, confirm its Activity warning; the update intentionally does not manufacture a value.

The `UPDATE-MANIFEST.json` SHA-256 entries verify every packaged app file. The GitHub commit can be reverted if you need the previous interface; do not delete the repository or your browser data.
