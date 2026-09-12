# Fuelio map and Hybrid update

Apply this small update to the existing Fuelio Pages Update release. It contains four replacements, one new module, and these release notes/checksums.

## Upload to GitHub

1. Extract this ZIP on your computer.
2. Open the Fuelio repository root and choose Add file → Upload files. Upload all seven extracted files together, replacing the matching filenames. Do not delete any other project files or put these files inside a new folder.
3. Commit the changes. After the connected Vercel deployment finishes, refresh the app with Ctrl+Shift+R.

Keep your existing Vercel environment variables and deployment settings. The updated build.js includes the new hybrid-map.js in the website build. Both files must be uploaded together.

## Included files

| File | Action | Purpose |
| --- | --- | --- |
| styles.css | Replace | Larger Planner map and Dark theme gold accents; neutral Hybrid imagery. |
| workspace.js | Replace | Trip-only vehicle display after routing; map resize and Hybrid integration. |
| build.js | Replace | Include the new Hybrid module in deployment output. |
| tests.mjs | Replace | Preserve existing checks and add Hybrid/vehicle visibility regression checks. |
| hybrid-map.js | Add | Transparent road, highway-number, and place references with fallback. |
| UPDATE-MAP-HYBRID.md | Add | These installation notes. |
| HYBRID-UPDATE-MANIFEST.json | Add | File hashes and verification record. |

## Four requested changes

- The Planner map fills almost the full height of its right pane. Route cards and results flow below it and are reachable by scrolling that pane. The left input panel keeps its independent scrollbar and Find routes action. Fuelio Hunt stays immediately below the map.
- After routes or a fuel plan exist, the Planner map shows only the selected active trip vehicle. Minute-by-minute refreshes keep that restriction. Fleet keeps all active vehicles, and clearing the trip restores the Planner's normal fleet display. Manual planning without a selected live vehicle does not show unrelated trucks.
- Dark mode uses charcoal surfaces with gold buttons, small gold dots, warmer borders and restrained highlights. The other themes retain their existing palettes; fuel-price heat colors remain intact.
- Satellite retains the USGS imagery base with a separate transparent road-and-place reference overlay. White labels with dark halos, visible road lines, and route numbers improve readability. The reference panes stay below stop/vehicle markers. Switching basemaps preserves filters, selection and stored map preference. Satellite imagery receives no theme filter or tint.

## Hybrid providers and availability

The primary reference layer uses the existing OpenFreeMap Liberty vector source, restyled for satellite imagery. Label detail follows available map data and zoom level. See the [official OpenFreeMap integration guide](https://openfreemap.org/quick_start/).

Transparent Esri transportation and place tiles provide a compatibility layer while the vector layer loads, or if it fails. Failed reference tiles are reported in Activity. This fallback is a maintenance dependency: Esri schedules retirement of World Transportation for March 2028 and World Boundaries and Places for December 2029. The primary vector layer is separate from those services. See [Esri's retirement notice](https://www.esri.com/arcgis-blog/products/arcgis-living-atlas/announcements/sunsetting-legacy-basemaps).

The imagery provider remains [USGS Imagery Only](https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer). Native imagery is overzoomed above its supported tile level so zooming closer does not request nonexistent higher-resolution tiles.

## Verification

- 53 automated tests pass, including the existing optimiser checks and 600 exhaustive small-case comparisons.
- Added checks cover selected-vehicle visibility after routes, Hunt, live refresh and view switching; trip reset; Hybrid pane order; transparent/high-contrast styles; rapid basemap switching; and failed reference loading.
- The transformed current Liberty style validates with zero MapLibre style errors; the stylesheet parses successfully.
- The update is extracted over a clean copy of the previous release and built/tested to check that all required modules are included.
- Planning calculations, routing/stop eligibility, Samsara API calls and telemetry normalization, source loading, and the other page features are preserved. Engine, server, data, dependency and route-data file hashes match the previous release.
- A visual browser check could not be completed because this environment's browser security policy blocked the local preview. Automated/static checks do not verify live third-party tile rendering or visual appearance on your device.

Optional local check: run npm ci, npm test and npm run build with the existing Node 22 project setup.
