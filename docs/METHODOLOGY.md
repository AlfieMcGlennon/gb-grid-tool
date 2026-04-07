# GB Grid Scenario Tool — Methodology

## 1. Overview

The GB Grid Scenario Tool is an interactive, client-side application for stress-testing and scenario planning on the Great Britain electricity transmission network. Users select a year (2024--2035), choose a Future Energy Scenarios (FES) or Clean Power 2030 scenario, adjust weather percentile sliders for wind, solar, and demand, toggle fuel types on or off, edit individual power plants, add hypothetical generation or transmission links, and run N-1 contingency analysis. All computation — DC power flow, merit order dispatch, and linear optimal power flow — runs in the browser with no backend. The tool produces zonal power flow results displayed on a Leaflet map with boundary utilisation heatmapping.

### Key Capabilities

- **Scenario planning**: Select from five NESO scenarios across 12 years of network evolution.
- **Stress testing**: Adjust wind, solar, and demand percentiles independently by season, drawn from 34 years of ERA5 reanalysis and 16 years of historic demand.
- **Dispatch comparison**: Three dispatch modes — simple (all generation runs), merit order (wind-dependent blended dispatch), and LOPF (LP-based cost minimisation with boundary constraints).
- **Boundary analysis**: ETYS boundary utilisation with year- and scenario-specific capabilities, shared boundary resolution, and N-1 contingency assessment.
- **Network editing**: Modify plants, add hypothetical generation, add or upgrade transmission links, and observe the effects on power flow and boundary stress.


## 2. Data Sources and Processing

All input data is derived from publicly available sources. No proprietary or confidential data is used.

| Data File | Source | Licence | Processing |
|-----------|--------|---------|------------|
| `zones_tnuos.json` | NESO ETYS Appendix F (TEC Register) + Appendix G (GSP demand) | OGL v3 | 27 TNUoS zones with generation aggregated by plant type from 1,896 TEC Register projects. Demand from 965 GSP nodes (100% mapped to zones). Total 2024 demand: 47,940 MW. |
| `plants_tnuos.json` | NESO ETYS Appendix F | OGL v3 | 2,239 generation projects (313 Built, 25 Under Construction, 152 Consents Approved, 152 Awaiting Consents, 1,254 Scoping) plus 9 interconnectors. Zone assignment via 3-phase substation mapping (GSP point-in-polygon, circuit-graph propagation, TO fallback + fuzzy name matching). 58% of projects mapped; all 313 Built projects mapped. |
| `links_tnuos.json` | NESO ETYS Appendix B (B-2-1 sheets) | OGL v3 | 43 adjacency-filtered zonal links. Equivalent reactances from parallel combination of individual circuit reactances at 400 kV and 275 kV (backbone methodology per NESO GB Reduced Model Release Note 2024). Capacity is sum of winter ratings (MVA). |
| `links_tnuos_by_year.json` | NESO ETYS Appendix B (B-2-2 sheets) | OGL v3 | Network evolution 2024--2035 from planned reinforcements. Links appear, disappear, or change rating per year. Total network capacity grows from ~267 GVA (2024) to ~408 GVA (2035). |
| `etys_capabilities.json` | NESO ETYS Boundary Chart Data | OGL v3 | 22 boundaries, 20 years, 5 scenarios, 7 metrics (5pc, 25pc, 75pc, 95pc, Economy RT, Security RT, Capability). Exact values from published NESO xlsx — no approximation. |
| `boundary_link_mapping.json` | Derived from NESO boundary GeoJSON and zone polygons | OGL v3 | Programmatic geometric intersection of boundary lines with zone polygons. 18 of 22 boundaries with capability data have crossing links mapped. 4 unmapped (B0, NW1, NW2, SC3) are network-edge boundaries at peninsulas or islands with no cross-zone link. Includes `shares_with` field for shared boundary resolution. |
| `climatology.json` | ECMWF ERA5 reanalysis via Copernicus C3S | C3S licence | 1991--2024, 0.25 degree grid, hourly, 6 variables (wind speed, wind CF, solar irradiance, solar CF, cloud fraction, 2 m temperature), 23 percentiles (p1--p99), 5 seasons, 27 zones. Wind CF computed via IEC cubic power curve. Solar CF daylight-filtered using Spencer (1971) solar position at zone centroid. See Section 6. |
| `demand_climatology.json` | NESO historic half-hourly Transmission System Demand (TSD) | OGL v3 | 2009--2025 (~280,000 records). National seasonal percentile distributions allocated to 27 zones using ETYS Appendix G zone shares. |
| `zones_flop.json` | NESO ETYS Appendix B substations, programmatic aggregation | OGL v3 | 82 FLOP zones built from substation-level data. Each zone maps to one or more TNUoS zones. Generation and demand disaggregated from TNUoS-level data proportional to substation counts. |
| `links_flop.json` | NESO ETYS Appendix B circuit data | OGL v3 | 134 links at FLOP resolution. Reactances from parallel combination of circuits between FLOP zone pairs. |
| `ic_lookup.json` | NESO historic TSD + ERA5 wind data, aligned by timestamp | OGL v3 + C3S | 69,952 winter half-hours (2009--2024). 5x5 lookup grid: wind CF quintile x demand quintile, each cell containing mean historic IC import as percentage of total IC capacity. Built via `scripts/data-processing/build_ic_lookup.py`. |
| `marginal_costs.json` | DESNZ Electricity Generation Costs 2023, Ofgem wholesale market indicators, NESO FES 2024 fuel price assumptions | Public | SRMC (fuel + carbon + VOM), start-up cost, ramp penalty, minimum stable level by technology. Base assumptions: gas 55 p/therm, carbon 45 GBP/tCO2 (UK ETS 2024). |


## 3. Network Model

### Zone Schemes

The tool supports two zone schemes, selectable at runtime:

**TNUoS (27 zones)**: The primary physics network, corresponding to NESO's Transmission Network Use of System generation charging zones (GZ1--GZ27). Each zone is a node in the DC power flow. This is the resolution at which ETYS boundary capabilities are defined and at which NESO publishes boundary transfer analysis.

**FLOP (82 zones)**: A higher-resolution scheme built from ETYS Appendix B substation data. Each FLOP zone typically corresponds to a cluster of substations within a TNUoS zone, providing finer spatial granularity for power flow. 134 links connect the FLOP zones. Each FLOP zone maps to a primary TNUoS zone for weather data lookup.

### Link Reactances

Equivalent reactances for each zonal link are computed from ETYS Appendix B individual circuit data following the NESO GB Reduced Model methodology (Release Note 2024, Section 5):

1. Extract circuit parameters (R, X, B) from Appendix B.
2. Filter to 400 kV and 275 kV circuits (backbone only — 132 kV distribution excluded).
3. For each adjacent zone pair, parallel-combine all backbone circuits:

```
X_equivalent = 1 / sum(1 / X_i)
```

where X_i is each circuit's reactance in percent on a 100 MVA base. This yields the physically correct equivalent impedance, not a capacity proxy.

For zone pairs with only 132 kV inter-zone circuits (no backbone), all circuits are included with a fallback parallel combination (marked `x_method: "parallel-combine-all (fallback)"` in the data).

### Slack Bus

- **TNUoS**: GZ18 (London / Thames Valley) — the zone with the highest demand.
- **FLOP**: R5 — the FLOP zone corresponding to the highest-demand node.

The slack bus absorbs the system power imbalance. Its selection does not affect inter-zonal flow patterns (a property of DC power flow), only the absolute angle reference.


## 4. DC Power Flow

### Mathematical Formulation

Standard DC power flow approximation, linearised from the full AC power flow equations by assuming:

- Flat voltage profile: |V_i| = 1.0 per unit at all buses.
- Small angle differences: sin(theta_ij) approximately equals theta_ij.
- Lossless network: resistance negligible relative to reactance (R << X).
- No reactive power.

This yields the linear system:

```
B . theta = P
```

where:

- **B** is the bus susceptance matrix (N x N, symmetric, singular).
- **theta** is the vector of voltage angles (radians).
- **P** is the vector of net power injections (per-unit on 100 MVA base).

### Susceptance Matrix Construction

For each link between zones i and j with equivalent reactance X_ij (percent on 100 MVA base):

```
b_ij = 100 / X_ij     (susceptance in per-unit)

B[i][j] -= b_ij       (off-diagonal, negative)
B[j][i] -= b_ij       (symmetric)
B[i][i] += b_ij       (diagonal, sum of connected susceptances)
B[j][j] += b_ij
```

### Solution

The slack bus row and column are removed, yielding a (N-1) x (N-1) non-singular system (26 x 26 for TNUoS, 81 x 81 for FLOP). This is solved via **Gaussian elimination with partial pivoting** — a direct method, implemented in pure JavaScript with no external libraries. Solve time is under 1 ms for the 27-node system.

### Flow Calculation

Power flow on each link:

```
flow_ij = (theta_i - theta_j) / (X_ij / 100)   [per-unit]
flow_ij_MW = flow_ij * 100                       [MW, on 100 MVA base]
```

Positive flow indicates power transfer from zone i to zone j.

### Validity

This is the same DC power flow approximation that NESO uses for boundary transfer analysis at zonal resolution. It correctly distributes power inversely proportional to reactance. It does not account for active dispatch decisions, constraint management, or voltage stability — these are operational concerns beyond the scope of a planning-level tool.


## 5. Dispatch Modes

### 5.1 Simple Dispatch

All enabled generation runs simultaneously at its weather-adjusted output. No demand matching is performed. Wind and solar output is set by the selected weather percentile and season; nuclear runs at 80% availability (validated against EDF fleet data); all other thermal generation runs at 100% of installed capacity. This mode is useful for exploring raw generation potential and identifying structural surpluses or deficits, but it does not represent realistic grid operation.

### 5.2 Merit Order Dispatch

A wind-dependent blended dispatch model that transitions between two modes based on the national average wind capacity factor:

| National Wind CF | Mode | Behaviour |
|-----------------|------|-----------|
| >= 0.35 | 100% National | All generation ranked nationally by marginal cost. Cheapest dispatched first until national demand is met. Scotland's wind displaces England's gas. Produces large inter-zonal flows. |
| <= 0.15 | 100% Local-first | Must-run generation dispatches everywhere. Flexible thermal fills local demand first. Remaining national deficit filled by cheapest available. Produces smaller inter-zonal flows. |
| 0.15 -- 0.35 | Linear blend | `blend = (wind_cf - 0.15) / 0.20`. Final dispatch is weighted average of national and local-first results. |

The blend thresholds (0.15 / 0.35) correspond approximately to the 25th and 75th percentiles of the ERA5 national wind CF distribution.

**Merit order priority** (lowest marginal cost first):

| Priority | Type | Behaviour | Min Stable Level |
|----------|------|-----------|-----------------|
| 1 | Wind (onshore + offshore) | Must-run, weather-dependent | 0% |
| 2 | Solar | Must-run, weather x daylight fraction | 0% |
| 3 | Nuclear | Must-run, 80% availability | 50% |
| 4 | Hydro / Pumped Storage | Flexible | 0% |
| 5 | Biomass | Flexible | 40% |
| 6 | CCGT | Flexible, main balancing plant | 50% |
| 7 | OCGT | Peaking, last resort | 20% |

**Minimum stable level (MSL) enforcement**: If the remaining demand to be met is below a unit's MSL, that unit is skipped rather than dispatched below its technical minimum. This prevents unrealistic partial dispatch of large thermal plant.

**Post-dispatch curtailment**: After interconnector imports are added, if total generation exceeds total demand, flexible (non-must-run) generation is scaled down proportionally. This occurs in the scenario runner, not the merit order engine.

### 5.3 Linear Optimal Power Flow (LOPF)

A cost-minimising LP dispatch solved using the HiGHS WASM solver running client-side in the browser.

**Objective**: Minimise total system cost:

```
min  sum_g ( p_g * effective_cost_g )
```

where:

```
effective_cost = SRMC + (startup_cost / 8) + ramp_penalty
```

Start-up costs are amortised over an assumed 8-hour run. Cost data from `marginal_costs.json`.

**Subject to**:

1. **Power balance** at each node (equality constraint):
   ```
   sum(generators at node n) - demand_n = sum(DC power flows leaving node n)
   ```

2. **DC power flow physics** (embedded in power balance via angle variables):
   ```
   flow_ij = (theta_i - theta_j) / x_ij
   ```

3. **Generator limits**:
   ```
   min_stable <= p_g <= p_max
   ```

4. **Boundary flow limits** (optional, from ETYS capabilities):
   ```
   -capability <= sum(flows across crossing links) + s_pos - s_neg <= capability
   ```
   where s_pos and s_neg are slack variables penalised at 10,000 GBP/MWh in the objective to allow feasibility while discouraging boundary violations.

5. **Slack bus**: theta_slack = 0.

**Scaling**: All MW values are divided by 1,000 (working in GW) to maintain well-conditioned LP coefficients. Results are scaled back to MW.

**Outputs**: Optimal dispatch per generator, link flows, voltage angles, nodal prices (LP duals on power balance constraints), total system cost, and boundary violation costs.


## 6. Weather Climatology

### ERA5 Reanalysis

Source: ECMWF ERA5 reanalysis via the Copernicus Climate Change Service (C3S). 34 years (1991--2024), hourly, 0.25 degree spatial resolution (~28 km). Six variables extracted per zone:

- **100 m wind speed** (m/s)
- **Surface solar radiation downwards** (J/m^2/hr)
- **2 m temperature** (degrees C)
- **Total cloud cover** (0--1)
- **Wind capacity factor** (derived, 0--1)
- **Solar capacity factor** (derived, 0--1)

### Wind Capacity Factor

Computed using the IEC cubic ramp power curve from Staffell and Pfenninger (2016):

- Cut-in: 3 m/s
- Rated: 12 m/s
- Cut-out: 25 m/s
- Below cut-in: CF = 0
- Cut-in to rated: CF = (v - 3)^3 / (12 - 3)^3 (cubic ramp)
- Rated to cut-out: CF = 1.0
- Above cut-out: CF = 0

All hours are included in the percentile distributions (including calm periods). An offshore wind CF multiplier of 1.4x is applied during validation, consistent with DUKES published load factors showing offshore CF approximately 40% higher than onshore at equivalent wind speeds.

**Reference**: Staffell, I. and Pfenninger, S. (2016). Using bias-corrected reanalysis to simulate current and future wind power output. *Energy*, 114, 1224--1239. doi:10.1016/j.energy.2016.08.060.

### Solar Capacity Factor

Computed as:

```
solar_cf = ssrd / (1000 * 3600) * 0.85
```

where ssrd is ERA5 surface solar radiation downwards in J/m^2/hr, 1000 W/m^2 is the IEC 61215 Standard Test Conditions reference irradiance, and 0.85 is the assumed system efficiency (inverter losses, soiling, temperature derating).

**Daylight filtering**: Percentiles are computed only from hours where the solar elevation angle is greater than 0 degrees at the zone centroid, calculated using Spencer (1971) solar position equations. Each entry includes a `daylight_fraction` field (fraction of hours in the season that are daylight). The front-end applies this as:

```
zone_solar_mw = installed_mw * solar_cf_at_percentile * daylight_fraction
```

This correctly distinguishes between "nighttime" (no solar by definition) and "daytime with heavy overcast" (genuinely low solar CF included in the percentile distribution).

### Demand Climatology

Source: NESO historic half-hourly Transmission System Demand (TSD), 2009--2025 (~280,000 records). National seasonal percentile distributions (23 percentiles from p1 to p99) are computed, then allocated to 27 zones using ETYS Appendix G zone demand shares.

**Assumption**: Zone demand shares are constant across percentiles. That is, London's share of national demand at p10 is assumed to be the same as at p90. This is a simplification — in practice, industrial vs residential demand profiles vary by region and temperature.

For future years, demand is scaled proportionally:

```
demand_zone_year = seasonal_percentile_mw * (zone_demand_year / zone_demand_2024)
```


## 7. Boundary Analysis

### ETYS Boundary Capabilities

34 named transmission boundaries are defined by NESO (B0, B6F, EC5I, SC1, NW1, etc.). Each boundary crosses between specific TNUoS zones and has a published **capability** (MW) per year per scenario from NESO's ETYS 2024 Boundary Chart Data. Capability incorporates N-1 security margins, voltage constraints, and stability limits — it is more conservative than raw thermal ratings.

### Shared Boundary Resolution

At the 27-node TNUoS resolution, some boundaries that are distinct at the circuit level map to the same set of crossing links (they "share" a zonal link). For these shared boundaries, the effective capability used in the utilisation calculation is the **maximum** of the shared group's individual capabilities. This prevents artificial inflation of utilisation where the model cannot distinguish between physically separate boundaries.

### Utilisation Calculation

**Boundary capability utilisation** (the primary metric displayed on the map):

```
boundary_utilisation = sum(|flow across each crossing link|) / ETYS_capability_MW * 100%
```

This is the operationally meaningful metric — what NESO manages to. It reflects the transfer across the boundary relative to the published secure limit.

**Thermal utilisation** (shown in the detail panel per link):

```
thermal_utilisation = |flow on link| / sum(circuit winter ratings) * 100%
```

Raw physical headroom in the conductors. Always lower than boundary utilisation because boundary capability is more conservative than thermal limits.

### N-1 Contingency Analysis

For each link in the network:

1. Remove the link temporarily.
2. Check network connectivity via BFS. If the network becomes disconnected, mark the contingency as **critical**.
3. Re-solve DC power flow with the remaining links.
4. Compute all boundary utilisations and link thermal utilisations.
5. Identify boundary overloads (utilisation > 100%) and classify severity:

| Worst Utilisation | Severity |
|------------------|----------|
| <= 80% | Secure |
| 80--90% | Stressed |
| 90--100% | Marginal |
| > 100% | Overloaded |
| Network split | Critical |

Results are sorted by worst boundary utilisation. The tool reports the total count per severity category, solve time (typically under 50 ms for all 43 contingencies at 27-node resolution), and identifies the single worst-case contingency.


## 8. Interconnector Modelling

### Static Mode

A simple slider (0--100%) sets the import as a fixed percentage of total built interconnector capacity (~9.8 GW across 9 interconnectors). Default: 65%. This is the original Phase 4 approach and is retained for manual exploration.

### Dynamic Mode (Default)

A data-driven lookup table derived from 69,952 aligned ERA5 and NESO winter half-hours (2009--2024). The table is a 5 x 5 grid indexed by:

- **Wind CF quintile**: National average wind capacity factor, binned at the 20th, 40th, 60th, and 80th percentiles.
- **Demand quintile**: National TSD demand (MW), binned at the same percentiles.

Each cell contains the mean historic IC import as a percentage of total IC capacity, computed from the aligned dataset.

**Key finding**: The overall mean historic IC import is **16.4%** (1,611 MW), far below the commonly assumed 65%. Import is highest during low-wind, low-demand conditions (30.1%) and lowest during high-wind, high-demand conditions (5.6%). This reflects correlated weather across the North Sea region: when GB demand is high (cold weather), continental Europe is also cold and has less surplus to export.

The dynamic IC lookup automatically adjusts interconnector imports based on the user's wind and demand slider positions, producing more realistic generation-demand balances without manual tuning.

**Interconnector allocation by zone**: GZ26 (Kent) 5,000 MW; GZ24 (East Anglia) 1,000 MW; GZ10 (Wales) 500 MW; GZ19 (South West) 500 MW; GZ13 (Yorkshire) 1,400 MW; GZ15 (East Midlands) 1,400 MW.


## 9. Validation

### Approach

The tool has been validated against NESO's published ETYS boundary transfer data (75th and 95th percentile expected flows by boundary, year, and scenario). Validation was conducted systematically across **16+ configurations**: 4 network resolutions x 2 dispatch methods x 2 IC modes x 2 time periods, using automated scripts in `scripts/validation/`.

### Best Results

**B6F (Scotland--England boundary)**: The single most important boundary in the GB network, carrying Scotland's wind surplus to English demand centres.

- **27-zone DC power flow with real NESO TSD demand**: **-2% error** at p75. This is the best single-boundary result and demonstrates that the DC power flow engine correctly captures the dominant north-south transfer pattern when fed realistic demand data.

**FLOP Net Injection method**: At the 82-zone FLOP resolution using net injection dispatch:

- **6 boundaries rated FAIR** (|error| < 50%).
- Mean |p75 error| across all mapped boundaries: 68%.

**27-zone DC power flow (standard mode)**: B6F rated GOOD. 7 boundaries rated POOR.

### Systematic Investigation

Over the course of development, the following configurations were tested:

| Resolution | Dispatch | IC Mode | Notes |
|-----------|----------|---------|-------|
| 27-zone TNUoS | Simple | Static 65% | Baseline — large errors due to over-dispatched ICs |
| 27-zone TNUoS | Merit order | Static 65% | Improved generation balance, still over-imports |
| 27-zone TNUoS | Merit order | Dynamic (16.4% mean) | Best B6F result (-2% at p75) |
| 27-zone TNUoS | LOPF | Dynamic | Cost-minimised with boundary constraints |
| 82-zone FLOP | Net injection | Static | Higher resolution, 6 FAIR boundaries |
| 82-zone FLOP | Net injection | Dynamic | Marginal improvement |
| NESO 28-zone | Merit order | Dynamic | Tested official NESO reduced model topology |
| Hybrid | Various | Various | Round-robin testing across combinations |

Additional targeted investigations: correction factor fitting, reactance sensitivity analysis, backbone vs full-circuit reactances, MSL enforcement, curtailment logic, demand percentile calibration.

### Root Cause of Remaining Error

The dominant source of error is **dispatch methodology**, not network topology or power flow formulation. NESO uses PLEXOS, a commercial LP-based unit commitment and economic dispatch tool that:

- Solves **security-constrained economic dispatch** with boundary flow limits as constraints (not impedance-based power flow).
- Applies **generator-specific offers and bids** from the Balancing Mechanism.
- Incorporates **temporal coupling** (unit commitment, ramp rates, start costs across multiple settlement periods).
- Uses **constraint management** to actively re-dispatch generation away from boundary limits.

This is fundamentally different from DC power flow, which distributes power based on network impedances. NESO's constraint model does not use impedances — it uses transfer sensitivities (dF/dP) that relate generator output changes to boundary flow changes. The tool's DC power flow produces the "unconstrained" flow pattern; NESO's published flows reflect the "constrained" pattern after re-dispatch.

As documented during the validation campaign: *"NESO uses LP-based economic dispatch with boundary flow limits (no impedances in their constraint model) — fundamentally different from DC power flow."*

### Interpretation

The tool is most accurate for:

- **B6F and other major north-south boundaries** where the flow pattern is dominated by the Scotland-England generation-demand imbalance.
- **Relative comparisons** between scenarios (e.g., "what happens to B6 if Scottish wind doubles?") where systematic biases cancel.
- **Identifying structural bottlenecks** rather than predicting exact MW flows.

It is least accurate for:

- **Peripheral boundaries** (e.g., NW3, SC1) where local dispatch decisions dominate over impedance-driven flow patterns.
- **Absolute flow magnitudes** at non-B6 boundaries, where errors of 50--100% are common.


## 10. Known Limitations

1. **DC power flow approximation**: Drops reactive power and voltage magnitude. Cannot detect voltage stability issues, reactive power constraints, or harmonic problems. Valid for MW flow patterns at zonal resolution — the same approximation NESO uses for boundary transfer analysis.

2. **27-node zonal aggregation**: Internal congestion within zones is invisible. A zone like GZ18 (54 substations, 101 ERA5 grid points) may have internal bottlenecks the model cannot see. The 82-zone FLOP resolution partially addresses this but is fixed at 2024 topology.

3. **Static snapshot**: No temporal coupling. Each solve is an independent snapshot — there is no unit commitment, no ramp rate enforcement across time steps (except the linearised ramp penalty in LOPF), no maintenance scheduling, and no inter-temporal storage optimisation.

4. **FLOP zone topology fixed at 2024**: The FLOP zone links do not change with year. Only the TNUoS network evolves annually (2024--2035) per ETYS Appendix B planned changes.

5. **Shared boundary zones at FLOP level**: Some ETYS boundaries that are distinct at circuit level share crossing links at the FLOP zonal resolution. Effective capability is taken as the maximum of the shared group, but the flow attribution remains approximate.

6. **Simplified dispatch**: Merit order does not model ramp rates, minimum up/down times, or maintenance outages. LOPF includes linearised start-up and ramp costs but not integer commitment decisions. Neither mode replicates NESO's Balancing Mechanism actions.

7. **Storage dispatch approximated by duration-bounded CF**: Battery output is capped at 67% of rated power (4h duration over a 6h peak window) and pumped hydro at 85% (6h duration, derated for round-trip losses). This is a static energy constraint — there is no temporal arbitrage (charge during surplus, discharge during deficit) or state-of-charge tracking. The approximation is reasonable for single-snapshot planning studies but overestimates storage availability during sustained high-demand periods and underestimates it during brief peaks.

8. **Interconnector lookup is average historic**: The dynamic IC import percentage reflects the mean of historic observations in each wind-demand bin, not a market-responsive model. It does not account for changes in European interconnector capacity, market coupling evolution, or future price dynamics.

9. **Constant zone demand shares**: Per-zone demand at each percentile assumes the zone's share of national demand is invariant across the demand distribution. Industrial vs residential load profiles differ by region and temperature.

10. **Plant mapping coverage**: 58% of TEC Register projects (1,093 of 1,896) are mapped to zones. The 42% unmapped are predominantly "Scoping" status (which are excluded from operational dispatch by default). All 313 Built projects and most Under Construction projects are mapped.

11. **4 unmapped edge boundaries**: B0 (Orkney/Caithness), NW1 and NW2 (Anglesey), and SC3 (South Coast) are network-edge boundaries with no cross-zone link at either TNUoS or FLOP resolution. They are displayed on the map but excluded from utilisation calculations.

12. **Solar daylight filtering**: Uses Spencer (1971) solar position at zone centroid only. Does not account for terrain shading. Approximately 5% of daytime winter hours have genuinely zero solar CF from heavy overcast — these are correctly included as real daytime conditions, not filtered out.


## 11. Reproducibility

### Data Provenance

All input data is derived from publicly available sources:

- **NESO data**: Published under the Open Government Licence v3.0. Available from neso.energy/data-portal.
- **ERA5 reanalysis**: Published by ECMWF via the Copernicus Climate Change Service under the C3S licence. Available from the Climate Data Store.
- **Cost data**: Published by DESNZ (Electricity Generation Costs 2023) and Ofgem (wholesale market indicators).

### Processing Scripts

All data processing and validation scripts are included in the repository:

- `scripts/data-processing/` — ERA5/NESO data alignment (`align_era5_neso.py`), IC lookup construction (`build_ic_lookup.py`), FES generation scenarios (`build_fes_generation.py`), FLOP zone construction (`build_flop_data.py`).
- `scripts/validation/` — Boundary flow validation against NESO published data across multiple configurations (`validate_boundaries.mjs`, `validate_correlated.mjs`, `validate_flop_zones.py`, `validate_lopf.mjs`, `validate_comprehensive.py`, and others).

### Client-Side Computation

All power flow, dispatch, and contingency calculations run in the user's browser. There is no backend server, no API calls, and no hidden computation. The complete engine source is in `src/engine/`:

- `dcPowerFlow.js` — Gaussian elimination DC power flow solver.
- `networkBuilder.js` — Year-dependent link set construction with user edit support.
- `meritOrder.js` — Wind-dependent blended merit order dispatch.
- `lopf.js` — Linear optimal power flow via HiGHS WASM.
- `contingency.js` — N-1 contingency analysis with connectivity checking.
- `scenarioRunner.js` — Integration layer combining generation, demand, weather, and dispatch into power flow inputs.

### Attribution

Contains NESO data (c) Crown copyright, used under the Open Government Licence v3.0.

Contains modified Copernicus Climate Change Service information, 2024.

Wind capacity factor methodology: Staffell and Pfenninger (2016), doi:10.1016/j.energy.2016.08.060.

Solar capacity factor methodology: IEC 61215 STC; Pfenninger and Staffell (2016).

Solar position equations: Spencer (1971).
