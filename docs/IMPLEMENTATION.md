# Implementation Specification

## 1. Data Schemas

All schemas show real values from actual data files. Units and sources documented per field.

### 1.1 zone_boundaries_tnuos.geojson
27 features. WGS84. Source: NESO GIS Boundaries for GB Generation Charging Zones.
```json
{ "type": "FeatureCollection", "features": [{
    "properties": { "id": "GZ1", "name": "GZ1", "centroid_lat": 57.79, "centroid_lon": -4.07 },
    "geometry": { "type": "Polygon", "coordinates": [...] }
}]}
```

### 1.2 zone_boundaries_dno.geojson
14 features. IDs: `_A` through `_P`. Display only — not used in physics. Source: NESO GIS Boundaries for GB DNO Licence Areas.

### 1.3 etys_boundaries.geojson
34 LineString features. Note: GeoJSON IDs (e.g. "B6") differ from capability keys (e.g. "B6F") — use `cap_name_map` in `boundary_link_mapping.json` to translate.
```json
{ "properties": { "id": "B6", "name": "B6", "is_b6": true }, "geometry": { "type": "LineString" } }
```

### 1.4 etys_capabilities.json
22 boundaries × 20 years × 5 scenarios × 7 metrics. All values MW, exact from NESO's published ETYS 2024 Boundary Chart Data xlsx. Zero approximation.
```json
{
  "boundaries": {
    "B6F": {
      "fes24": {
        "Holistic Transition": {
          "Capability": { "2024": 7200, "2025": 7000, "2027": 9600, "2029": 11400, "2035": 14700 },
          "75pc": { "2024": 5200, ... },
          "95pc": { "2024": 6800, ... }
        }
      },
      "cp30": { "Further Flex & Renewables": { ... }, "New Dispatch": { ... } }
    }
  }
}
```
Scenarios: 3 FES (`Holistic Transition`, `Electric Engagement`, `Hydrogen Evolution`) + 2 CP30 (`Further Flex & Renewables`, `New Dispatch`). Metrics: `5pc`, `25pc`, `75pc`, `95pc`, `Economy RT`, `Security RT`, `Capability`. **Use `Capability` for utilisation denominator.** The `75pc`/`95pc` values are NESO's expected flows — use for validation.

### 1.5 links_tnuos.json
40 adjacency-filtered links. Only between geographically neighbouring zones (polygon intersection test).
```json
[{
  "id": "GZ11-GZ12", "from": "GZ11", "to": "GZ12",
  "capacity_mw": 7733,
  "n_circuits": 13,
  "x_equivalent": 0.082156,
  "carrier": "AC"
}]
```
- `capacity_mw`: Sum of winter ratings (MVA) from ETYS Appendix B (B-2-1 sheets)
- `x_equivalent`: Parallel reactance = `1/Σ(1/x_i)` where x_i is each circuit's reactance in % on 100 MVA base (Appendix B column G). **This is the physically correct value — not a 1/capacity proxy.**
- `n_circuits`: Number of parallel transmission circuits

### 1.6 links_tnuos_by_year.json
String-keyed by year. Network evolves per ETYS Appendix B planned changes (B-2-2 sheets).
```json
{ "2024": [{ link objects }], "2025": [...], ..., "2035": [...] }
```

### 1.7 boundary_link_mapping.json
Derived from geometric intersection of boundary GeoJSON lines with zone polygons.
```json
{
  "boundary_links": {
    "B6F": {
      "geo_id": "B6",
      "north_zones": ["GZ11"], "south_zones": ["GZ12"],
      "crossing_links": ["GZ11-GZ12"],
      "capability_2024_mw": 7200
    }
  },
  "cap_name_map": { "B6": "B6F", "EC5": "EC5I", "B1a": "B1aF", ... }
}
```
18/22 boundaries mapped. 4 unmapped (B0, NW1, NW2, SC3) are network-edge boundaries.

### 1.8 zones_tnuos.json
27 zones. Generation from ETYS Appendix F (TEC Register). Demand from Appendix G (965 GSP nodes, 100% mapped). Total: 47,940 MW (2024).
```json
{
  "GZ18": {
    "n_substations": 54,
    "generation_by_type": {
      "CCGT": { "built_mw": 1500, "total_mw": 2800, "n_projects": 5 },
      "Wind Offshore": { "built_mw": 0, "total_mw": 4200, "n_projects": 3 }
    },
    "total_built_mw": 2883,
    "total_pipeline_mw": 12500,
    "demand_mw_by_year": { "2024": 10361, "2025": 11380, ..., "2031": 14850 }
  }
}
```

### 1.9 plants_tnuos.json
1,896 projects. Status: Built (313), Scoping (1254), Consents Approved (152), Awaiting Consents (152), Under Construction (25).
```json
[{
  "project": "Beatrice Offshore Windfarm",
  "connection_site": "Blackhillock 275kV Substation",
  "zone_id": "GZ1",
  "mw_connected": 588, "mw_total": 588,
  "status": "Built", "host_to": "SHET", "plant_type": "Wind Offshore"
}]
```

### 1.10 demand_by_node.json
965 GSP nodes, 100% mapped to zones.
```json
[{ "node": "ABHA4A", "site_code": "ABHA", "zone_id": "GZ16", "demands": { "2024": 40.5, ..., "2031": 48.3 } }]
```

### 1.11 climatology.json (296 KB)
ERA5 1991-2024, 27 TNUoS zones, 23 percentiles, 6 variables, 5 seasons. **Solar is daylight-filtered.**
```json
{
  "metadata": {
    "percentiles": [1,2,5,10,15,20,25,30,35,40,45,50,55,60,65,70,75,80,85,90,95,98,99],
    "solar_method": "Daylight hours only (solar elevation > 0°, Spencer 1971)",
    "capacity_factor_curves": {
      "wind": { "cut_in_ms": 3.0, "rated_ms": 12.0, "cut_out_ms": 25.0 },
      "solar": { "stc_wm2": 1000, "system_efficiency": 0.85 }
    }
  },
  "tnuos_zones": {
    "GZ18": {
      "wind_cf":   { "winter": { "p10": 0.001, "p50": 0.167, "p90": 1.0, "mean": 0.328, ... } },
      "solar_cf":  { "summer": { "p10": 0.025, "p50": 0.110, "p90": 0.312, "mean": 0.145, "daylight_fraction": 0.6608 } },
      "wind_ms":   { "winter": { "p10": 3.9, "p50": 7.95, "p90": 14.1, "mean": 8.0, ... } },
      "solar_jm2": { "summer": { "p50": 396000, "mean": 520000, "daylight_fraction": 0.6608, ... } },
      "cloud_frac":{ "winter": { "p50": 0.85, "mean": 0.78, ... } },
      "t2m_c":     { "winter": { "p10": 0.5, "p50": 5.2, "p90": 10.1, "mean": 5.4, ... } }
    }
  }
}
```
**Units**: wind_ms (m/s), wind_cf (0-1), solar_jm2 (J/m²/hr), solar_cf (0-1), cloud_frac (0-1), t2m_c (°C).
**Solar formula**: `zone_solar_mw = installed_mw × solar_cf × daylight_fraction`

### 1.12 demand_climatology.json
NESO historic TSD 2009-2025 (~280k records). Zone demand = national percentile × zone share.
```json
{
  "national": { "winter": { "mean": 37591, "percentiles": { "p10": 27221, "p50": 37200, "p90": 48178 } } },
  "zones": {
    "GZ18": {
      "share": 0.216082,
      "demand_by_year": { "2024": 10361, ..., "2031": 14850 },
      "seasonal": { "winter": { "mean": 8121, "percentiles": { "p10": 5815, "p50": 8038, "p90": 10349 } } }
    }
  }
}
```

---

## 2. DC Power Flow Engine

### 2.1 Algorithm

1. **Build bus admittance matrix B** (27×27):
   - For each link between zones i,j: susceptance `b_ij = 1 / x_equivalent`
   - `B[i][j] -= b_ij`, `B[j][i] -= b_ij` (off-diagonal)
   - `B[i][i] += b_ij`, `B[j][j] += b_ij` (diagonal)
2. **Net injection per zone**: `P[i] = generation[i] - demand[i]` (MW, then ÷ 100 for per-unit on 100 MVA base)
3. **Slack bus**: GZ18 (highest demand). Remove slack row/column → 26×26 system
4. **Solve B·θ = P** via Gaussian elimination with partial pivoting
5. **Flows**: `flow_ij = (θ[i] - θ[j]) / x_ij` (per-unit × 100 = MW)

**Assumptions**: Flat voltage (|V|=1.0 pu), small angles (sinθ≈θ), lossless (R≈0), no reactive power. Same approximation NESO uses for boundary transfer analysis.

### 2.2 dcPowerFlow.js
```javascript
export function solveDCPF(links, injections, slackZone = "GZ18") → { flows, angles }
```

### 2.3 networkBuilder.js
```javascript
export function getLinksForYear(linksByYear, year) → links[]
// Returns link set for year, with any user edits (added/removed/modified links) applied
```

### 2.4 scenarioRunner.js
```javascript
export function runScenario(params) → { flows, angles, boundaryUtilisation, thermalUtilisation, zoneInjections }
```

Steps:
1. Sum `built_mw` per zone per plant type, respecting fuel toggles and plant edits
2. Wind: `zone_wind_mw = built_wind_mw × climatology.wind_cf[season][pN]`
3. Solar: `zone_solar_mw = built_solar_mw × climatology.solar_cf[season][pN] × daylight_fraction`
4. Thermal/nuclear/hydro: full output when toggled on (CF=1.0), unless merit order mode
5. Add any user-added hypothetical generation nodes
6. Demand: `zone_demand = zones.demand_mw_by_year[year]`, scaled by demand percentile from demand_climatology
7. Net injection = generation - demand per zone
8. If merit order mode: apply merit order dispatch (see §2.5) before computing injections
9. Call `solveDCPF(links, injections)`
10. Compute boundary utilisation from flows + capabilities + boundary mapping

### 2.5 meritOrder.js
```javascript
export function applyMeritOrder(zoneGeneration, zoneDemand, fuelToggles) → adjustedGeneration
```

Merit stack (dispatched first to last):
| Priority | Type | Marginal cost | Behaviour |
|----------|------|--------------|-----------|
| 1 | Wind (Onshore + Offshore) | ~£0/MWh | Output set by weather percentile, cannot be increased |
| 2 | Solar | ~£0/MWh | Output set by weather × daylight_fraction |
| 3 | Nuclear | ~£5/MWh | Baseload, always on when toggled (inflexible) |
| 4 | Hydro / Pumped Storage | ~£10/MWh | Flexible, dispatched as needed |
| 5 | Biomass | ~£40/MWh | Dispatched if needed after hydro |
| 6 | CCGT | ~£50-80/MWh | Main flexible thermal, dispatched to fill gap |
| 7 | OCGT | ~£100-150/MWh | Peaking only, last resort |

Logic per zone:
1. Sum must-run generation (wind + solar at weather CF, nuclear if on)
2. Calculate remaining demand: `gap = demand - must_run`
3. If gap > 0: dispatch flexible plant in merit order until gap filled
4. If gap < 0: surplus (zone exports). Curtail from top of stack if needed for network reasons

**National balancing**: Total national generation must equal total national demand (the slack bus absorbs any residual). Per-zone, surpluses and deficits are resolved by the DC power flow — power flows from surplus zones to deficit zones through the transmission network.

### 2.6 contingency.js
```javascript
export function runNMinus1(links, injections, slackZone, boundaryMapping, capabilities, year, scenario)
  → { worstCase, allResults }
```

For each link in the network:
1. Remove the link temporarily
2. Re-solve DC power flow with remaining links
3. Record all boundary utilisations
4. Identify the worst-case boundary exceedance

Return the link whose removal causes the highest boundary utilisation (the "critical contingency"). Display as a table: "if link X trips, boundary Y reaches Z% utilisation."

---

## 3. Utilisation Calculation

### 3.1 Boundary capability utilisation (default map view)
```javascript
function computeBoundaryUtilisation(flows, boundaryMapping, capabilities, year, scenario) {
  for (const [capName, boundary] of Object.entries(boundaryMapping.boundary_links)) {
    const cap = capabilities.boundaries?.[capName]?.fes24?.[scenario]?.Capability?.[String(year)]
             || capabilities.boundaries?.[capName]?.cp30?.[scenario]?.Capability?.[String(year)];
    const totalFlow = boundary.crossing_links.reduce((sum, id) => sum + Math.abs(flows[id] || 0), 0);
    result[capName] = { flow_mw: totalFlow, capability_mw: cap, utilisation_pct: (totalFlow/cap)*100 };
  }
}
```

### 3.2 Thermal utilisation (detail panel)
```javascript
function computeThermalUtilisation(flows, links) {
  for (const link of links) {
    const flow = Math.abs(flows[link.id] || 0);
    result[link.id] = { flow_mw: flow, capacity_mw: link.capacity_mw, utilisation_pct: (flow/link.capacity_mw)*100 };
  }
}
```

---

## 4. Scenario Editing Features

### 4.1 PlantEditor.jsx
When a zone is selected and the plant list is visible, each plant row has:
- **Output slider**: Adjust from 0 to `mw_total` (default: `mw_connected` for Built, 0 for Scoping)
- **Status override**: Toggle between Built/Retired/Future
- **Commissioning year**: For pipeline projects, set when they come online (affects which years they appear)

Edits are stored in React state as an overlay on `plants_tnuos.json` — the base data is never mutated. When the scenario runner computes generation per zone, it applies the overlay.

```javascript
// Edit overlay structure
const plantEdits = {
  "Beatrice Offshore Windfarm": { mw_override: 400, status_override: "Built" },
  "Hinkley Point C": { mw_override: 3200, commission_year: 2029 },
};
```

### 4.2 NodeAdder.jsx
Button: "Add Generation". Opens a form:
- **Zone**: dropdown of 27 zones
- **Plant type**: Wind Onshore, Wind Offshore, Solar, CCGT, Nuclear, Hydro, OCGT, Biomass, Other
- **Capacity (MW)**: numeric input
- **Name** (optional): for display

Added nodes appear in the zone's generation total and in the plant list. They participate in merit order dispatch (ranked by their plant type). They persist during the session.

```javascript
const addedNodes = [
  { id: "user_1", zone: "GZ17", type: "Wind Offshore", mw: 3000, name: "Hypothetical East Anglia OWF" },
  { id: "user_2", zone: "GZ1", mw: 500, type: "Hydro", name: "Test pumped storage" },
];
```

### 4.3 LinkEditor.jsx
Three modes:
- **Add link**: Select two adjacent zones, set capacity (MW) and reactance (or auto-calculate from capacity using average x/capacity ratio from existing links)
- **Upgrade link**: Select existing link, increase capacity
- **Remove link**: Select existing link, remove it (useful for testing "what if this reinforcement is delayed?")

```javascript
const linkEdits = {
  added: [{ from: "GZ9", to: "GZ12", capacity_mw: 2400, x_equivalent: 0.15, name: "Bootstraps HVDC" }],
  removed: ["GZ16-GZ18"],  // Test: what if this link trips permanently?
  modified: { "GZ11-GZ12": { capacity_mw: 12000 } },  // Upgrade B6 capacity
};
```

### 4.4 Scenario Sharing + Export

**Scenario JSON** — single file capturing all user edits as deltas from base data:
```json
{
  "version": "1.0",
  "name": "Winter stress test - no gas",
  "created": "2026-03-28T10:30:00Z",
  "base": { "year": 2028, "scenario": "Holistic Transition", "season": "winter", "dispatch": "merit_order" },
  "sliders": { "wind_percentile": 10, "solar_percentile": 25, "demand_percentile": 90 },
  "fuel_toggles": { "CCGT (Combined Cycle Gas Turbine)": false, "Wind Offshore": true, "Nuclear": true },
  "plant_edits": {
    "Hinkley Point C": { "mw_override": 3200, "status": "Built" },
    "Torness": { "mw_override": 0, "status": "Retired" }
  },
  "added_nodes": [
    { "zone": "GZ17", "type": "Wind Offshore", "mw": 3000, "name": "East Anglia Hub" }
  ],
  "link_edits": {
    "added": [{ "from": "GZ1", "to": "GZ12", "capacity_mw": 2000, "name": "Bootstraps delay test" }],
    "removed": [],
    "modified": { "GZ11-GZ12": { "capacity_mw": 12000 } }
  }
}
```

Typical size: 0.5-7 KB. Only stores what changed — base data is never duplicated.

**Three export methods:**
1. **Copy JSON** — button copies scenario to clipboard. Primary method.
2. **Download .json** — triggers file download for local storage.
3. **Share URL** — encode as base64 query param: `gb-grid-tool.github.io/?scenario=eyJ...`. Auto-loads on page visit. Greyed out for large scenarios (>1.5 KB raw) with tooltip suggesting Copy JSON instead.

**Import:** Paste JSON into text area, or auto-decode from URL `?scenario=` parameter on page load. Validate schema before applying.

**PNG Export:**
- Use `html2canvas` to capture map as downloadable PNG
- Three modes: Full map / Current zoomed view / Map + detail panel side-by-side
- Auto-stamp watermark in bottom corner: scenario parameters, timestamp, `gb-grid-tool.github.io`
- Every exported image is self-documenting and traceable

---

## 5. UI Specification

### 5.1 Layout
```
┌─────────────────────────────────────────────────────────┐
│  GB Grid Scenario Tool                    [TNUoS|DNO] ▼ │
├──────────────────────────┬──────────────────────────────┤
│                          │  CONTROL PANEL               │
│                          │  Year / Scenario / Season    │
│       LEAFLET MAP        │  Dispatch: [Simple|Merit] ▼  │
│                          │  Fuel toggles                │
│   Zones + Boundaries     │  Wind / Solar / Demand sliders│
│   + Flow arrows          │                              │
│                          │  SCENARIO EDITING             │
│                          │  [+ Add Generation]          │
│                          │  [+ Add/Edit Link]           │
│                          │                              │
│                          │  DETAIL PANEL (click zone)   │
│                          │  Zone stats / Plant list     │
│                          │  [Edit plant] buttons        │
├──────────────────────────┴──────────────────────────────┤
│  Data & Sources  │  Methodology  │  Export/Import  │ OGL│
└─────────────────────────────────────────────────────────┘
```

### 5.2 Map layers
1. **GB coastline** — thin grey, z-index base
2. **Zone polygons** — fill by net injection (blue=import, orange=export), opacity 0.3
3. **ETYS boundary lines** — coloured by utilisation (green→red), weight by capability, labelled
4. **Flow arrows** — direction + thickness by flow magnitude
5. **Zone labels** — zone ID + name at centroid
6. **User-added nodes** — highlighted marker (distinct colour) showing hypothetical generation

### 5.3 Colour scales
Utilisation: `0-40% #22c55e → 40-60% #84cc16 → 60-75% #eab308 → 75-85% #f97316 → 85-100% #ef4444 → >100% #991b1b`
Net injection: orange (export) → grey (balanced) → blue (import)

### 5.4 Progressive disclosure
**Layer 1**: Map + year slider + scenario selector. One-click overview.
**Layer 2**: Expand for fuel toggles, weather sliders, dispatch mode, season selector.
**Layer 3**: Click zone → detail panel with plant list, edit buttons, add generation. Click boundary → capability chart, crossing link breakdown.
**Layer 4**: Scenario editing panel for link changes, export/import.

### 5.5 Year slider behaviour
When year changes: load links for that year, update demand, update capabilities, apply user link edits, re-solve power flow, update map. Highlight new reinforcements appearing vs previous year.

### 5.6 DataSourcesPage
**Critical for credibility.** Must include:
- Full attribution table (§7)
- Methodology: DC power flow assumptions, solar daylight filtering, wind power curve, merit order logic
- Known limitations (from CLAUDE.md)
- Validation table: tool flows vs NESO published 75pc/95pc values for key boundaries
- OGL v3 + C3S licence notices
- Links to download raw data from NESO and ECMWF

---

## 6. Build Phases

### Phase 1: Scaffold + Map
- Vite + React project setup
- Data loading (all 13 JSON/GeoJSON files via Promise.all)
- Leaflet map with TNUoS zone polygons, coastline, ETYS boundary lines
- Zone click → show zone name and basic stats in detail panel
- No power flow yet

### Phase 2: DC Power Flow
- Implement dcPowerFlow.js (Gaussian elimination, 27×27)
- Wire up networkBuilder.js + scenarioRunner.js
- Default scenario: all generation on, 2024, winter, wind p50, solar p50, demand p75
- Show flow arrows on map, colour boundaries by utilisation

### Phase 3: Controls + Validation
- Year slider with network topology updates
- Scenario selector (3 FES + 2 CP30)
- Season selector (winter/spring/summer/autumn/annual)
- Zone scheme toggle (TNUoS ↔ DNO display)
- **Validate**: Compare tool B6F, B8, EC5I flows against NESO 75pc/95pc values. Build validation table.

### Phase 4: Scenario Controls + Merit Order
- Fuel type toggles
- Wind/solar/demand percentile sliders using climatology + demand_climatology
- Real-time re-solve on slider change (debounced 300ms)
- Dispatch mode toggle: Simple vs Merit Order
- Merit order implementation in meritOrder.js

### Phase 5: Detail Panel + Plant Editing
- Zone detail: generation breakdown, plant list with edit buttons, demand
- Boundary detail: capability, flow, utilisation, time series sparkline (2024-2043)
- Plant editor: output slider, status override, commissioning year
- Thermal utilisation per link

### Phase 6: Scenario Editing + Sharing
- Add hypothetical generation nodes to any zone
- Add/upgrade/remove transmission links
- N-1 contingency analysis
- User-added elements highlighted on map with distinct styling
- **Scenario export/import:**
  - Copy scenario as JSON to clipboard (primary method)
  - Download scenario as .json file
  - Share as URL: encode scenario as base64 query param (`?scenario=eyJ...`). Auto-decode on page load. Works for typical scenarios (<1.5 KB). Greyed out with tooltip for large scenarios.
  - Import: paste JSON into text area, or load from URL parameter
  - Scenario JSON stores only deltas from base data (year, sliders, fuel toggles, plant edits, added nodes, link edits). Typically 0.5-7 KB.
- **PNG export:**
  - Use `html2canvas` library to capture map as PNG
  - Three modes: Full map, Current view (zoomed crop), Map + detail panel
  - Auto-stamp watermark in corner with: scenario parameters (year, scenario, wind/solar/demand percentiles), timestamp, and `gb-grid-tool.github.io` attribution
  - Every shared image is self-documenting and links back to the tool

### Phase 7: Data & Sources Page
- Full attribution page with methodology and limitations
- Validation table
- Download links for all source data

### Phase 8: Polish + Deploy
- Responsive design (mobile: panel as bottom sheet)
- Performance (memoisation, lazy loading, debounced re-solve)
- Deploy to GitHub Pages
- README with screenshots and example scenario URLs

---

## 7. Data Sources and Attribution

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
