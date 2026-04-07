# GB Grid Scenario Tool

## What this is

Interactive client-side tool for stress-testing and scenario planning on the GB electricity transmission grid. Users can:
- Select a year (2024-2035) and see planned reinforcements appear on the network
- Toggle reinforcements on/off to compare current vs future network capacity
- Choose FES/CP30 scenarios with different generation and demand assumptions
- Switch between TNUoS 27-zone and FLOP 82-zone resolution for power flow analysis
- Stress-test with weather percentile sliders (wind, solar, demand by season)
- Toggle fuel types on/off to explore retirement scenarios (e.g. "what if all gas retires?")
- Edit individual power plants (ramp up, ramp down, retire, change commissioning date)
- Add hypothetical generation nodes ("what if 3 GW offshore wind connects into GZ17?")
- Add or upgrade transmission links ("what if B6 capacity doubles?")
- Run N-1 contingency analysis (remove one link, see cascading effects)
- Compare merit order dispatch against simple dispatch
- See DC power flow results on a Leaflet map with boundary utilisation heatmapping

All data is from publicly available NESO and ECMWF sources. All calculations, assumptions, and limitations are documented in IMPLEMENTATION.md and exposed in the tool's Data & Methodology page.

Built with React + Vite, deployed to GitHub Pages. No backend — all computation is client-side.

## Repo structure

```
gb-grid-tool/
├── public/data/                  # Static JSON/GeoJSON data files (see Data Files below)
├── src/
│   ├── main.jsx                  # Entry point
│   ├── App.jsx                   # Top-level layout: map + control panel + detail panel
│   ├── components/
│   │   ├── GridMap.jsx           # Leaflet map: zones, boundaries, links, coastline
│   │   ├── ControlPanel.jsx      # Year slider, scenario selector, fuel toggles, weather sliders
│   │   ├── DetailPanel.jsx       # Click-to-inspect: zone, boundary, or link detail
│   │   ├── LinkLayer.jsx         # Zonal link arrows with flow magnitude
│   │   ├── ScenarioManager.jsx   # FES scenario + CP30 scenario management
│   │   ├── PlantEditor.jsx       # Edit individual plant output (0-200%), status, commissioning
│   │   ├── NodeAdder.jsx         # Add hypothetical generation to any zone
│   │   ├── LinkEditor.jsx        # Add/upgrade/remove transmission links
│   │   ├── ContingencyPanel.jsx  # N-1 contingency analysis UI
│   │   ├── NationalSummary.jsx   # National generation/demand summary bar
│   │   ├── MapLegend.jsx         # Map colour legend
│   │   ├── ScenarioChangeSummary.jsx # Summary of user scenario edits
│   │   ├── ErrorBoundary.jsx     # React error boundary wrapper
│   │   └── DataSourcesPage.jsx   # Attribution, methodology, limitations, download links
│   ├── engine/
│   │   ├── dcPowerFlow.js        # Gaussian elimination DC power flow solver
│   │   ├── networkBuilder.js     # Build admittance matrix from links for selected year
│   │   ├── scenarioRunner.js     # Combine generation, demand, weather → run power flow
│   │   ├── meritOrder.js         # Stack generation by marginal cost until demand met
│   │   ├── lopf.js               # Linear optimal power flow (HiGHS-based, per-link thermal + boundary constraints)
│   │   └── contingency.js        # N-1 analysis: remove each link, re-solve, find worst case
│   ├── data/
│   │   └── dataLoader.js         # Fetch and cache all JSON/GeoJSON from public/data/
│   └── utils/
│       ├── colours.js            # Utilisation → colour mapping (green-amber-red)
│       └── percentiles.js        # Interpolated percentile lookup for climatology data
├── scripts/
│   ├── validation/               # Validation and testing scripts
│   ├── data-processing/          # Data preparation scripts (ERA5, FES, FLOP, IC lookup)
│   └── *.json                    # Intermediate model files (not tracked in git)
├── index.html
├── vite.config.js
├── package.json
├── CLAUDE.md                     # This file
└── IMPLEMENTATION.md             # Detailed specs (data schemas, algorithms, UI)
```

## Tech stack

- **Vite + React 18** (JSX, no TypeScript)
- **Leaflet + react-leaflet** for the map
- **No backend** — all data is static JSON in `public/data/`, all computation is client-side
- **GitHub Pages** deployment via `vite build` → `dist/`
- No state management library — React useState/useReducer is sufficient
- No UI framework — custom CSS, clean and functional

## Key concepts

### Zone schemes

- **27 TNUoS generation zones** (GZ1–GZ27): Primary physics network. DC power flow runs at this resolution. Each zone is a node in the power flow.
- **82 FLOP zones** (A1, B2, R5, T1, etc.): Higher-resolution zonal model derived from NESO's FLOP (Forecast of Locational Prices) methodology. Uses substation-level aggregation. Year-dependent topology from ETYS Appendix B circuit changes mapped to FLOP zones (99% coverage via circuit-graph propagation). Slack bus = R5 (Lancashire/Cumbria, maps to GZ14).
- **14 DNO licence areas**: Display aggregation layer. Toggle to show demand grouped by distribution region. Not used in physics.

### ETYS boundaries

34 named transmission boundaries (B0, B6F, EC5I, SC1, NW1, etc.) that cross between specific TNUoS zones. Each has a published **capability** (MW) per year per FES scenario from NESO's ETYS 2024. The boundary-to-link mapping in `boundary_link_mapping.json` was derived programmatically from geometric intersection of boundary lines with zone polygons. 18 of 22 boundaries with capability data have crossing links mapped; the 4 unmapped (B0, NW1, NW2, SC3) are network-edge boundaries at peninsulas/islands with no cross-zone link to map.

### Utilisation (the core metric)

**Default view — Boundary capability utilisation:**
```
boundary_util = Σ|flow across links crossing boundary| / ETYS_capability_MW × 100%
```
This is the operationally meaningful metric — what NESO manages to. Capability incorporates N-1 security, voltage constraints, and stability limits.

**Detail panel — Thermal utilisation:**
```
thermal_util = |flow on link| / sum(circuit winter ratings) × 100%
```
Raw physical headroom in the conductors. Always lower than boundary utilisation because boundary capability is more conservative than thermal limits.

### DC power flow

Standard DC power flow approximation (linearised from full AC power flow by assuming flat voltage profile and small angle differences). Drops reactive power — solves only for MW flows and voltage angles. Valid for transmission-level planning studies at this zonal resolution. Uses real equivalent reactances aggregated from ETYS Appendix B individual circuit data (parallel combination: X_eq = 1/Σ(1/x_i)), not a capacity proxy.

Gaussian elimination with partial pivoting, 27×27 system, <1ms solve time. Pure JS, no libraries. Slack bus = highest-demand zone (GZ18, London/Thames Valley).

**Assumption**: Power distributes inversely proportional to reactance. This is physically correct for DC power flow but does not account for active dispatch decisions or constraint management. Three dispatch modes are available: Simple (all generation runs), Merit Order (cost-stacked with MSL constraints), and LOPF (network-constrained economic dispatch with per-link thermal limits and boundary capability constraints, solved via HiGHS LP). DC power flow implementation independently verified against PyPSA 1.1.2 — all 43 link flows match to 0.000 MW.

### Year slider (2024-2035)

Network topology changes per year from ETYS Appendix B planned changes (B-2-2 sheets). Links appear/disappear, ratings change. ETYS boundary capabilities also vary by year and scenario. Total network capacity grows from ~267 GVA (2024) to ~408 GVA (2035) as reinforcements are built. Users can see exactly when each reinforcement is scheduled and test "what if it's delayed?"

### Scenario editing

Users can modify the network beyond the published ETYS plan:
- **Plant editing**: Change output, status, or commissioning year of any of the 1,896 TEC Register projects
- **Node addition**: Add hypothetical generation (any type, any MW) to any zone
- **Link editing**: Add new transmission links, upgrade existing capacity, or remove links
- All edits persist during the session and can be exported/imported as JSON
- The year slider shows how user edits interact with NESO's planned reinforcement timeline

### Climatology

ERA5 reanalysis (1991-2024, 34 years, hourly, 0.25° grid) provides per-zone weather distributions:

- **Wind CF**: IEC cubic ramp power curve (cut-in 3 m/s, rated 12 m/s, cut-out 25 m/s) applied to ERA5 100m wind speed. All hours included. Source: Staffell & Pfenninger (2016), doi:10.1016/j.energy.2016.08.060.
- **Solar CF**: 85% system efficiency applied to ERA5 surface solar radiation downwards (ssrd), per IEC 61215 STC (1000 W/m²). **DAYLIGHT HOURS ONLY** — percentiles computed after filtering to hours where solar elevation angle > 0° at zone centroid, using Spencer (1971) solar position equations. Each entry includes `daylight_fraction`.
- **Temperature**: ERA5 2m temperature converted to °C.
- **Raw variables also stored**: wind_ms (m/s), solar_jm2 (J/m²/hr), cloud_frac (0-1) — allows swapping in different turbine power curves or panel efficiency models without rebuilding ERA5 data.

**Front-end solar usage**: `zone_solar_mw = installed_mw × solar_cf_at_percentile × daylight_fraction`

### Demand climatology

NESO historic half-hourly Transmission System Demand (TSD) from 2009-2025 (~280,000 records) provides national seasonal percentile distributions. Per-zone demand computed by applying ETYS Appendix G zone shares (47,940 MW total, 2024) to national percentiles.

**Assumption**: Zone demand shares are constant across percentiles. See limitations.

## Data files (public/data/)

| File | Size | Content |
|------|------|---------|
| `zone_boundaries_tnuos.geojson` | 38 KB | 27 TNUoS zone polygons, WGS84 |
| `zone_boundaries_dno.geojson` | 349 KB | 14 DNO licence area polygons, WGS84 |
| `zone_boundaries_flop.geojson` | ~200 KB | 82 FLOP zone polygons, WGS84 |
| `etys_boundaries.geojson` | 63 KB | 34 boundary lines, WGS84 |
| `gb_coastline.geojson` | 146 KB | GB outline (union of DNO areas) |
| `etys_capabilities.json` | 323 KB | 22 boundaries × 20 years × 5 scenarios × 7 metrics (exact NESO values) |
| `links_tnuos.json` | ~5 KB | 40 adjacency-filtered zonal links with real reactances |
| `links_tnuos_by_year.json` | ~60 KB | Network evolution 2024-2035 (from Appendix B planned changes) |
| `links_flop.json` | ~15 KB | FLOP zonal links with reactances (2024 baseline) |
| `links_flop_by_year.json` | ~293 KB | FLOP network evolution 2024-2035 (from Appendix B circuit changes) |
| `boundary_link_mapping.json` | ~5 KB | ETYS boundary → crossing TNUoS link pairs (18/22 mapped) |
| `boundary_link_mapping_flop.json` | ~8 KB | ETYS boundary → crossing FLOP link pairs with shares_with |
| `zones_tnuos.json` | ~30 KB | 27 zones: generation by type + demand by year (47,940 MW base) |
| `zones_flop.json` | ~80 KB | 82 FLOP zones: generation by type, demand_mw, primary_tnuos_zone |
| `plants_tnuos.json` | ~100 KB | 1,896 generation projects with zone assignments |
| `demand_by_node.json` | ~80 KB | 965 demand nodes with yearly MW (100% mapped) |
| `climatology.json` | 296 KB | ERA5 6 variables, 23 percentiles, daylight-filtered solar |
| `demand_climatology.json` | 56 KB | 27-zone seasonal demand percentiles from NESO historic TSD |
| `ic_lookup.json` | ~5 KB | NESO historic IC import % binned by wind CF × demand quintile |
| `marginal_costs.json` | ~2 KB | Fuel-type marginal costs for merit order and LOPF dispatch |
| `substation_zone_mapping.json` | 183 KB | 795 ETYS substations mapped to TNUoS zones |

**Total: ~2 MB. All data from NESO (OGL v3) and ECMWF/Copernicus (C3S licence).**

## Commands

```bash
npm install          # Install dependencies
npm run dev          # Dev server on localhost:5173
npm run build        # Production build to dist/
npm run preview      # Preview production build
```

## Code style

- Functional components with hooks
- Named exports for components, default export for pages
- Data loading in a single `dataLoader.js` with Promise.all
- No prop drilling beyond 2 levels — use context if needed
- Comments on non-obvious engineering calculations, citing sources where applicable
- British spelling in UI text (utilisation, licence, colour)

## Known limitations and assumptions

1. **DC power flow approximation**: Drops reactive power and voltage magnitude. Valid for MW flow patterns at zonal resolution but cannot detect voltage stability or reactive power issues. This is the same approximation NESO uses for boundary transfer analysis.
2. **27-node zonal aggregation**: Internal congestion within zones is invisible. A zone like GZ18 (101 ERA5 grid points, 54 substations) may have internal bottlenecks the model cannot see.
3. **4 unmapped edge boundaries**: B0 (Orkney/Caithness), NW1/NW2 (Anglesey), SC3 (South Coast) are network-edge boundaries with no cross-zone link. Displayed on map but not included in utilisation calculation.
4. **Plant mapping coverage**: 58% of TEC Register projects (1,093/1,896) mapped to zones. The 42% unmapped are predominantly "Scoping" status. All 313 "Built" projects and most "Under Construction" projects are mapped.
5. **Solar daylight filtering**: Uses Spencer (1971) solar position at zone centroid. Does not account for terrain shading. ~5% of daytime winter hours have genuinely zero solar CF from heavy overcast — these are correctly included as real daytime conditions.
6. **Demand year-scaling with constant zone shares**: Zone demand = year-projected baseline × (seasonal percentile / seasonal mean). This preserves ETYS demand growth projections while applying seasonal weather variation from historic data. However, per-zone shares of national demand are constant across percentiles — the zone's share at p10 is the same as at p90.
7. **Storage dispatch approximated**: Batteries dispatch at up to 67% CF (4h duration over 6h peak window) and pumped hydro at up to 85% CF (6h duration, derated for round-trip losses). No temporal arbitrage or state-of-charge modelling — output is bounded by a duration-derived energy constraint rather than flat percentage.
8. **Substation mapping**: 795/885 ETYS substations mapped via 3-phase process (GSP point-in-polygon → circuit-graph propagation → TO fallback + fuzzy name matching).
9. **Shared boundary resolution**: Boundaries sharing crossing links at 27-node resolution (B1aF/B2F, B3/B4F/B5, B8/NW3, EC5I/B14/LE1, SC1/SC1.5/B13) use the maximum capability in the shared group as denominator. This prevents artificial utilisation inflation but means the model cannot distinguish individual boundary constraints within a shared group.
10. **FLOP reinforcement mapping**: The 82-zone FLOP model derives year-dependent links from ETYS Appendix B circuit changes mapped to FLOP zones via circuit-graph propagation (99% substation coverage). Seven new Western Isles substations are assigned by geographic proximity. Reactances are recalculated per year using proper parallel combination. FLOP generation uses the same plant-level `isPlantOperational` pipeline as TNUoS, with plants mapped to FLOP zones via connection site matching (98.6% built MW coverage).

## Future: Monte Carlo stress testing

The tool architecture is designed to support probabilistic analysis in a future phase. The climatology data contains joint weather distributions across all 27 zones from 34 years of hourly ERA5 data. Combined with a copula-based sampling framework (preserving the spatial and inter-variable dependence structure), this enables Monte Carlo simulation: sample 10,000+ weather scenarios, run DC power flow for each, and produce probability distributions of boundary exceedance. This transforms the tool from deterministic scenario exploration into quantitative risk assessment.

## Data sources and attribution

| Data | Source | Licence | URL |
|------|--------|---------|-----|
| DNO licence areas | NESO | OGL v3 | neso.energy/data-portal/gis-boundaries-gb-dno-license-areas |
| TNUoS generation zones | NESO | OGL v3 | neso.energy/data-portal/gis-boundaries-gb-generation-charging-zones |
| ETYS boundary geometry | NESO | OGL v3 | neso.energy/data-portal/etys-gb-transmission-system-boundaries |
| ETYS boundary capabilities | NESO | OGL v3 | neso.energy/data-portal/electricity-transmission-network-requirements |
| ETYS Appendix B (network) | NESO | OGL v3 | neso.energy/data-portal/etys-documents-and-appendices |
| ETYS Appendix F (TEC Register) | NESO | OGL v3 | neso.energy/data-portal/etys-documents-and-appendices |
| ETYS Appendix G (GSP demand) | NESO | OGL v3 | neso.energy/data-portal/etys-documents-and-appendices |
| GSP region boundaries | NESO | OGL v3 | neso.energy/data-portal/gis-boundaries-gb-grid-supply-points |
| Historic demand (TSD) | NESO | OGL v3 | neso.energy/data-portal/historic-demand-data |
| ERA5 reanalysis | ECMWF/Copernicus | C3S licence | earthdatahub.destine.eu |
| Wind CF power curve | Staffell & Pfenninger (2016) | Academic | doi.org/10.1016/j.energy.2016.08.060 |
| Solar CF methodology | IEC 61215 / Pfenninger & Staffell (2016) | Standard | — |
| Solar position equations | Spencer (1971) | Academic | — |

Contains NESO data © Crown copyright, used under the Open Government Licence v3.0.
Contains modified Copernicus Climate Change Service information, 2024.
