# FCO — Dispatch workspace

Built for Div from the supplied FCO, PurFCO and Fuel Pump Viewer material.

Extract **FCO-Dispatch-Vercel-Hobby.zip** into one folder, preserving all filenames. Upload the extracted files themselves to the root of your GitHub repository. The ZIP contains the complete source project; Vercel installs its dependencies and builds its public assets automatically.

## Put it online with GitHub and Vercel

1. Create a **private GitHub repository**. Choose **Add file → Upload files**, upload all the supplied files together, and commit. `package.json`, `server.js` and `vercel.json` must be at the repository root.
2. In Vercel, choose **Add New → Project**, import that repository, and use the **Express** framework preset with **Node.js 22.x**. Build command: `npm run build`. Leave Output Directory and other framework defaults unchanged. The build creates `public/` automatically.
3. Add the connection values described in **ENVIRONMENT.txt** under the project's environment variables. You can deploy first and use manual truck inputs plus a fuel CSV/XLSX while setting up the connections.
4. Click **Deploy**, open the production URL, select a fuel master or upload prices, enter a trip, choose routes, then click **Find cheapest fuel plan**.
5. Later GitHub commits trigger new deployments. After changing environment variables, redeploy. Adding clients or fuel-master rows to the connected workbook does **not** require a code change or redeployment.

Use **Vercel Hobby** for Div's confirmed non-commercial use, within its included usage limits. See [Vercel Hobby](https://vercel.com/docs/plans/hobby). The project follows [Vercel's Express deployment structure](https://vercel.com/docs/frameworks/backend/express).

## Connect your Master workbook

The supplied [Master workbook](https://docs.google.com/spreadsheets/d/1VpTN7OY40d1yVFLvtBu2otIbUjAjqm6DVy71FDsBeeY/edit?usp=sharing) is already the default. Its three exact tab IDs are configured:

| Purpose                         | GID        | Optional override    |
| ------------------------------- | ---------- | -------------------- |
| Fuel rates registry             | 0          | FUEL_REGISTRY_GID    |
| Driver Message Masters registry | 970811620  | MESSAGE_REGISTRY_GID |
| Samsara client/API registry     | 1100093231 | SAMSARA_REGISTRY_GID |

The server selects these tabs by GID and resolves their current names automatically. These are the **registry tabs**: the fuel/message rows provide the URLs and GIDs of the underlying data tabs shown in your screenshots. Those per-master source GIDs remain editable in the workbook. You can replace the workbook using `MASTER_SHEET_ID`.

1. Create a project in Google Cloud and enable **Google Sheets API**.
2. Under **IAM & Admin → Service Accounts**, create a service account. Create/download a JSON key for it.
3. Share the Master workbook, and every linked fuel/message workbook you want to load, with the JSON file's `client_email` as **Viewer**.
4. In Vercel, set `GOOGLE_SERVICE_ACCOUNT_JSON` to the **entire JSON file contents**, without adding surrounding quotes. Set `MASTER_SHEET_ID` to your workbook ID. Add these values to the Production environment and redeploy.
5. Keep the Master workbook containing Samsara tokens **Restricted**. The server reads it privately and returns client names and vehicle data to the app. The integrated Pump Viewer uses that same server connection.

The names below describe the tabs; selection uses the configured GIDs. Column spaces/capitalisation are normalised.

| Tab             | Columns                                                             | Behaviour                                                                        |
| --------------- | ------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Fuel Stops      | Master Name, Google Sheet URL, GID, Active                          | One row per selectable price source. `GID = 0` is valid. `FALSE` disables a row. |
| Message Masters | Master Name, Google Sheet URL, GID, Active                          | One row per selectable message source.                                           |
| FCO Samsara API | Name, Samsara API, Samsara API 2, Samsara API 3, …; optional Active | One row per client. Every non-empty API column is used. Blank cells are ignored. |

For example, Young's can have two token columns filled and Golden Mile one. Additional numbered API columns are detected automatically. Use unique client names. Tokens should have read access to their vehicles, vehicle statistics and fuel/energy reports. Missing optional report access leaves the corresponding input manually editable.

Client and fuel-master selections are independent and remembered in the browser, following the final agreed two-client workflow. A client change does not silently choose a different fuel-price source. Source names appear in the selector, Pump Viewer and each result. Existing calculations retain their original price/source snapshot.

The application intentionally has **no login**, as requested. Anyone who can reach its deployment URL can use the connected fleet data. API tokens and the Google credential stay on the server and must never be committed to GitHub.

## Daily use

1. **Choose client and prices.** Use a connected master, another Google Sheet, or a CSV/TSV/XLSX file. Excel imports let you choose the worksheet.
2. **Choose a truck or enter one manually.** GPS origin, fuel percentage/gallons, MPG and additional telemetry load when available. Every trip field remains editable. Manual overrides are remembered by client/truck; **Use live** replaces them with available live values.
3. **Enter destination and optional waypoints.** Type a city/state, paste coordinates, submit an address search, use a saved lane, or choose points on the map. Address search happens on submission, not every keystroke.
4. **Choose Full Tank or Half Tank**, buffer, ending target and maximum stops. Advanced rules include the strict arrival window and pre-California planning. The default pump radius is one geographic mile from any point on the selected route.
5. **Find routes**, select one or more returned routes, then optimise. Compare fuel purchase cost, gallons, stops, detour miles and ending fuel. Expand the fuel profile for the fuel-balance calculation.
6. **Copy driver message** directly from the result. Preview it to add a driver/team-driver name. Export the plan as CSV or JSON. Click a stop to inspect its road connection.

### Full and Half Tank

- Full Tank means leave every purchased stop at 100% of the entered capacity.
- Half Tank means leave at exactly 50%: a 240-gallon truck arriving with 119 gallons buys 1 gallon and leaves with 120.
- A truck already carrying more than the selected fill target can keep driving. The optimiser never removes fuel to create a stop.
- If Half Tank cannot meet the selected constraints, the result explains the infeasibility and offers a button to choose Full Tank. It does not silently change the rule.
- No stop fees, labour charges, time penalties, taxes added separately, or terminal-fuel credits are introduced. The objective is the money spent buying fuel at the supplied prices. Fuel already on board is treated as already purchased.

### Live updates and manual values

While the page is open, the app requests fleet telemetry, selected-truck detail, the registry and connected fuel prices every 60 seconds. It also refreshes when you return to the tab. An update does not overwrite a manual field override or automatically recalculate a plan. A calculation uses a fixed price snapshot across its route comparisons.

Browser/OS background throttling can delay an inactive tab's timer. This is an in-app refresh, not a continuously running Vercel scheduled job. Latest measured GPS/fuel times are shown; a polling request cannot make an old Samsara measurement newer.

Without Samsara, enter truck, origin, tank, starting fuel and MPG yourself. Road routing and map tiles still require their internet services. If no purchase is necessary, a valid zero-stop plan can be calculated without loading fuel prices.

### Pump Viewer and appearance

- Light, Dark and Crimson themes, plus Icy; saved appearance preferences.
- Street map and the advanced viewer's USGS satellite imagery with OpenFreeMap road/place labels.
- Fullscreen, fit map, route/truck/station markers, recommended-stop labels and a price heat legend.
- Pump search, state filter, highway multi-select, route-only filter and price sorting.
- Linked table/map selection, source indicator, validation notes and filtered fuel CSV export.
- Separate message workspace with brand-correct pump names, highway/exit information, OR alternatives, driver/team-driver copies and editable instructions. Nothing is sent automatically.

### Saved routes and historical loads

The 12 supplied PurFCO lanes are included as reusable origin/destination/waypoint definitions. Their road routes and prices are calculated from current services/data; old notebook fuel prices are not used.

Save your own trips with **Save trip**. In **Routes & loads**, import historical loads using `load-template.csv` or an equivalent XLSX. Prepare & match groups nearby city coordinates and checks each actual pickup and delivery against the lane's endpoints. A chain of clustered cities cannot qualify a distant load by its cluster label alone.

Batch planning examines every matched lane's distinct waypoint sequence and the routes returned for it, then keeps the lowest fuel-spend feasible result. It runs sequentially with progress/cancellation and shared request caches. Each load can override starting fuel, capacity, MPG and ending target; other rules come from the current form. Export batch results or review a load individually.

### Storage

Trip inputs, client/source selection, theme and manual overrides use browser local storage. Fuel rows, access cache, saved lanes, messages, loads and the last 30 valid plans use IndexedDB. Settings provides backup/restore. This storage is specific to the browser and deployment URL; it is not shared automatically between teammates or devices. The Google Master remains the shared source configuration.

## Fuel and message files

Preferred fuel columns are in `fuel-template.csv`:

`pump_name, price_per_gallon, latitude, longitude, city, state, highway, Exit`

This matches the supplied eight-column fuel screenshot. Optional `brand` and `store_number` columns may be added; the existing parser detects columns by header, not fixed position.

The first four are required. Existing discounted-price, store/location, coordinate and generic A–F aliases are accepted. Header detection checks the first 12 rows. Invalid rows are reported, exact duplicate stations are omitted, and conflicting prices for the same station require correcting the data. Prices must be positive and coordinates valid. A station cannot be routed from a city name alone; latitude/longitude are required.

The supplied message screenshot is accepted exactly: **StoreNumber, Latitude, Longitude, Location, Highway, Exit**. Message text uses StoreNumber, Location, Highway and Exit; the coordinate columns do not shift those fields. Alphanumeric exits such as `107/24th St` are retained. Missing highway/exit cells remain empty. The original four-column and six-column headerless layouts are also supported. The source name supplies the brand when there is no Brand column.

| Column | Fuel-price data  | Driver-message data |
| ------ | ---------------- | ------------------- |
| A      | pump_name        | StoreNumber         |
| B      | price_per_gallon | Latitude            |
| C      | latitude         | Longitude           |
| D      | longitude        | Location            |
| E      | city             | Highway             |
| F      | state            | Exit                |
| G      | highway          | —                   |
| H      | Exit             | —                   |

File uploads are limited to 15 MB; XLSX sheets to 100,000 rows. ExcelJS reads saved formula results; it does not calculate formulas. Recalculate and save your workbook before importing it. Old `.xls` files should be saved as `.xlsx` or CSV first.

## Routing and optimality boundaries

Read **ALGORITHM.md** for the complete objective, constraints and proof of the dynamic-programming state.

The result is the minimum fuel-purchase cost **within the supplied routes, candidate stations, road-access model and Full/Half Tank rules**. It is not a guarantee across every possible highway or future price/consumption scenario.

Standard routing uses OSRM's ordinary driving profile. It does not check truck height, weight or hazmat restrictions. Configure `ORS_API_KEY` and select Truck routing to apply those inputs. The hosted ORS service restricts long-distance alternative-route requests, so truck routing uses the returned truck route and explicit saved lanes/waypoints rather than promising three alternatives. See [ORS restrictions](https://openrouteservice.org/restrictions/).

The station filter is a one-mile **geographic** corridor by default. Road distance to a station may be longer because of exits, ramps or one-way roads. Inbound and outbound road fuel are included using a return to the selected route attachment point. This does not optimise a separate downstream rejoin point. There is no silent corridor widening. Travel-time labels exclude traffic, driver breaks and fuelling time.

Public routing/geocoding/map services can be slow, rate-limited or unavailable. Requests are cached, paced and retried, but per-process pacing is not a global limit across multiple Vercel instances. For heavier shared use, configure a managed/self-hosted OSRM-compatible router and Nominatim-compatible geocoder with suitable usage allowances. See the [Nominatim policy](https://operations.osmfoundation.org/policies/nominatim/). The app does not silently substitute straight-line road distances when a service fails.

## Run or verify locally

Install Node.js 22, open a terminal in this folder, and run:

```sh
npm ci
npm run build
npm test
npm start
```

Open `http://localhost:3000`. For local connections, create a `.env` file using the variable names in ENVIRONMENT.txt. Keep that credential file out of Git.

Automated coverage includes the optimiser against exhaustive enumeration on 600 deterministic random instances, constraints and replay checks, data import, geometry, messages, city eligibility, functional UI interactions, Excel worksheet selection, and mocked Google/Samsara integration. The mocked tests do not require or use real credentials. Live account permissions and the deployed integration must be checked after you add your own configuration. No rendered-browser visual test or authenticated Samsara/Google production test has been performed in this delivery.

## File guide

| Files                                                  | Purpose                                                        |
| ------------------------------------------------------ | -------------------------------------------------------------- |
| index.html, styles.css, workspace.js                   | Layout, themes and application interactions                    |
| optimizer.js, worker.js                                | Exact fixed-fill optimisation and background worker            |
| geo.js, california.json                                | Route geometry, corridor candidates and California boundary    |
| data.js, messages.js, batch.js                         | Import/validation, driver messages and historical loads        |
| server.js                                              | Private Google/Samsara connections and routing APIs            |
| build.js, package.json, package-lock.json, vercel.json | Reproducible install, public asset build and Vercel deployment |
| route-library.json                                     | The 12 supplied PurFCO lane definitions                        |
| fuel-template.csv, load-template.csv                   | Import templates                                               |
| tests.mjs                                              | Automated verification                                         |
| README.md, ENVIRONMENT.txt, ALGORITHM.md               | Hosting, configuration and calculation reference               |

`npm run build` copies only browser assets into `public/`, installs bundled browser libraries from the locked dependencies, and includes their licence notices. Maps retain provider attribution. `california.json` records its official US Census TIGERweb source. Original handoff documents, notebooks, credential screenshots and Python SDK copies are not required in the deployed repository.

## Troubleshooting

| Symptom                                | Check                                                                                                                                               |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Only Manual planning appears           | Google credential, private Master sharing, `SAMSARA_REGISTRY_GID=1100093231` and non-empty token cells. Settings/Activity shows connection details. |
| Fuel master cannot load                | Workbook sharing with the service account, correct GID, Active flag, and fuel column/coordinate validity.                                           |
| Fuel/MPG unavailable for a truck       | Samsara measurement/report availability and token read permissions. Enter manual values; history fallback is labelled when used.                    |
| No feasible plan                       | Starting fuel, buffer, ending target, max stops, fixed-fill mode and actual candidate coverage. Choose Full Tank explicitly when Half cannot work.  |
| Route inputs changed                   | Click Find routes again, then calculate using the updated route.                                                                                    |
| Truck routing unavailable              | Configure ORS_API_KEY, redeploy, select Truck routing and check dimensions.                                                                         |
| Page loads without map/styles          | All source filenames must be preserved, build must complete, and Vercel must use the Express preset with its default output behaviour.              |
| A service times out or limits requests | Retry after the provider recovers, or configure a suitable provider. No incomplete access response is treated as a verified connection.             |
