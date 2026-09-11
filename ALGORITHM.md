# FCO calculation reference

The new engine preserves PurFCO's fuel-balance and purchase-cost objective, specialised to Div's final **Full Tank / Half Tank** requirement. It uses an exact dynamic programme rather than a greedy cheapest-next-stop heuristic or a discretised fuel grid.

## Inputs and objective

For a selected route of length D miles, each candidate station has its route position x, price p per US gallon, inbound road distance a and outbound road distance b. Inputs also include tank capacity C, MPG m, starting fuel F, ending target E, a stop limit K, and the chosen reserve/arrival-window policy.

Every actual purchase leaves the truck with Q gallons:

- Full Tank: Q = C.
- Half Tank: Q = C/2.

For a leg from station i to a later station j, miles driven are:

`b_i + (x_j - x_i) + a_j`

Arrival fuel is departure fuel minus leg miles / MPG. The purchase is Q minus arrival fuel and must be positive. At the origin, departure fuel is the entered starting fuel and there is no outbound station spur.

Minimise **sum(purchase gallons × station price)**. Initial onboard fuel has no new purchase cost. No stop fee, time penalty or ending-fuel credit is added. Ending fuel is reported separately, so plans with different leftover fuel are compared on immediate cash spent, as requested.

## Why the search is exact for this model

After a positive purchase, departure fuel is always Q. Therefore all feasible paths ending at the same station with the same number of stops (and the same pre-California requirement state) have the same future fuel possibilities. Retaining only the cheapest such path cannot discard a better continuation.

The engine processes stations in increasing route position, examining every feasible forward transition. Each state also tests whether the destination can be reached. It retains predecessor links to reconstruct the selected stops and fuel balances. A route requiring no purchase is considered from the initial state.

There is no top-N candidate cutoff, greedy price pruning, approximate fuel binning or partial-purchase relaxation. Complexity is O(KN²) time and O(KN) retained states for N station occurrences. The worker can be cancelled. An unusually dense/long route can still take time.

At equal route position, stations are alternatives rather than a way to manufacture a sequence of fuel-consuming loops. The route candidate builder can retain separate occurrences of the same pump on a route that later revisits its area. Ties prefer fewer stops and then fewer actual miles. Cross-route selection chooses the lowest feasible fuel purchase cost among the selected, returned routes.

## Enforced constraints

- Finite positive capacity/MPG; starting fuel within capacity; valid ending target and non-negative buffer.
- Integer stop limit; the route can have zero stops.
- Positive valid station prices, valid route progress and non-negative road-access distances.
- No negative fuel, over-capacity refuelling, fuel disposal or negative purchases.
- The selected reserve is checked through fuel-consuming legs and the final destination leg.
- Every positive purchase reaches the selected exact full/half target.
- Ending fuel reaches the larger of the ending target and applicable minimum reserve.
- Optional ending tolerance adds an upper bound of ending target + tolerance, capped by capacity. An upper bound can legitimately make a short or full-tank trip infeasible.
- Conflicting duplicate station prices are rejected rather than choosing one silently.

### Planning policies

| Policy                     | Stop arrival requirement                                                                        | Minimum through the trip                                |
| -------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| Plain Buffer               | At least the entered buffer                                                                     | Entered buffer                                          |
| Strict arrival window      | From max(0, buffer − lower offset) to buffer + upper offset                                     | The lower window edge, matching the supplied FCO policy |
| Before entering California | Arrive at fuel stops with 35–55 gallons; all purchases before the first actual California entry | 35 gallons, with the ending target also enforced        |

The optional **rescue** setting applies only to Strict mode. If the strict window yields no plan, it may relax the upper arrival bound. It does not relax the minimum reserve, tank capacity, fixed-fill target, stop limit or ending requirements. A rescue result is labelled.

Before-California mode uses the included official Census boundary, requires a route entering California from outside and ending in California, and excludes pumps physically inside the state. It is not based on longitude or Arizona-only guesses. A pre-entry purchase is required by this policy. If that cannot supply the final leg, the result is infeasible.

Half Tank infeasibility produces an explanation and an explicit Full Tank option; there is no automatic rule change.

## Candidate selection and road access

1. Use the full road-route geometry supplied by the routing provider.
2. Project pumps onto route segments and measure geographic distance to the nearest route point. The default radius is 1 mile; the editable setting supports more than 0 through 10 miles. This is the agreed geographic corridor, not a one-mile road-distance limit.
3. Order eligible station occurrences by cumulative route mileage.
4. Request directional road distances from the attachment point to each pump and back. Ordinary driving uses OSRM matrices; Truck mode uses the configured ORS truck restrictions.
5. Exclude confirmed unreachable station connections. Reject incomplete/failed access responses rather than declaring an unverified plan optimal. The standard matrix implementation also rejects station coordinates snapped more than 250 metres from the routable road network.
6. Supply every remaining candidate and its inbound/outbound distances to the exact engine. Fuel for both spurs is included.

The detour model returns to the same route attachment point. It can be conservative where a driver could rejoin downstream, and it does not jointly redesign the route around the fuel stop. A geographically close pump can have a much longer road detour. Directional distances follow the selected provider's network/profile, not guaranteed real-world entrance availability.

Each calculation captures its rules and fuel dataset before comparisons. Automatic background updates can populate the next calculation without mixing old and new prices across the routes in the current one.

## Independent replay

`verifyPlan` recomputes each leg, arrival fuel, purchased fuel, departure target, total miles, total gallons, cost and final fuel. It validates the constraints again. Results are replay-checked before export and before creating a driver message. An inconsistent result fails visibly.

Tests compare the dynamic programme with independent exhaustive station-subset enumeration on 600 deterministic random cases. Additional cases cover a 1-gallon half-fill, starting above half capacity, zero-stop trips, exact buffer boundaries, final-leg shortages, road detours, strict/rescue rules, ending tolerances, duplicate prices, revisited routes and California entry. This provides evidence for the implementation; it is not a proof about uncertain external data or every possible real road network.

## Data and operating limits

- MPG is constant for a calculation. Weather, grade, load, idling and traffic do not change fuel burn automatically.
- Prices come from the selected source. Currency is USD and fuel quantities are US gallons; cross-border currencies/litres are not mixed.
- Routing is US-focused. OSRM standard driving does not validate commercial-truck restrictions. ORS HGV applies configured restrictions subject to its data/coverage.
- The source notebooks' unconstrained arbitrary purchase quantities are not exposed as a third fill mode: the final requested full/half departure targets govern every purchase.
- Availability of road alternatives comes from the provider. A returned route can be fastest/shortest among the returned options without being globally fastest/shortest.
- There is no real-time traffic model, driver-hours scheduler, tax recovery calculation, fleet-wide allocation solver or guaranteed station entrance/operating-hours feed.
- Shared-link access is intentional. Browser history and preferences are local; there is no shared dispatch database or cross-device editing sync.
- Google/Samsara/routing caches in Vercel functions are instance-local and ephemeral. Browser storage survives ordinary page refreshes but can be cleared by the user/browser.
- Fleet/price polling is approximately every minute while the page is open. Google tab metadata is cached for 10 minutes; fleet list metadata for 10 minutes; telemetry roughly 50 seconds; selected-truck report/history results 55 seconds; registry 55 seconds; price data 30 seconds. Road routes cache for 6 hours and verified road access for 24 hours. A provider can return measurements older than its response time.
- No live Samsara token or Google service-account key is bundled. The supplied connection tests use generated/fake test credentials.

The correct claim is **exact minimum purchase cost for the selected routes and this stated model**, with clear infeasibility when its constraints cannot be met.
