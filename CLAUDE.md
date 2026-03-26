# GB Grid Scenario Tool

## What this is

An interactive web tool for stress-testing the GB electricity transmission grid. 20-node zonal model with DC power flow physics, real public data, all computation client-side. Hosted on GitHub Pages.

**Stack:** Vite + React 18, Leaflet.js (OpenStreetMap tiles), no backend, no external APIs at runtime.

## Repository structure

```
gb-grid-tool/
├── CLAUDE.md                    ← You are here
├── docs/
│   └── IMPLEMENTATION.md        ← Full pseudocode and component specs
├── public/
│   └── data/
│       ├── zones.json           (5.5 KB — 20 transmission zones)
│       ├── links.json           (4.3 KB — 37 transmission links)
│       ├── plants.json          (47 KB — 383 generation plants)
│       ├── climatology.json     (1.2 MB raw / ~373 KB gzipped — 34-year ERA5 climatology)
│       ├── demand_climatology.json (~5 KB — NESO historic demand distributions)
│       ├── gb_coastline.geojson (~15 KB — simplified GB outline)
│       └── zone_boundaries.geojson (TBD — ETYS zone polygons, may not exist yet)
├── src/
│   ├── App.jsx
│   ├── main.jsx
│   ├── index.css
│   ├── components/
│   │   ├── MapView.jsx          (Leaflet map with zones, links, boundaries)
│   │   ├── LeftPanel.jsx        (Global controls, fuel toggles, sliders)
│   │   ├── RightPanel.jsx       (Zone/link detail on click)
│   │   ├── ZonePolygon.jsx      (Individual zone overlay on map)
│   │   ├── LinkLine.jsx         (Transmission link on map)
│   │   ├── PlantList.jsx        (Sortable, filterable plant table)
│   │   ├── WindSliders.jsx      (Per-zone wind percentile sliders, collapsible)
│   │   ├── PeriodSelector.jsx   (Winter/Spring/Summer/Autumn/Annual toggle)
│   │   ├── FuelToggles.jsx
│   │   ├── SystemSummary.jsx    (Total gen/dem/balance/bottlenecks)
│   │   ├── ContingencyPanel.jsx (N-1 analysis results)
│   │   ├── NodeEdgeEditor.jsx   (Add/remove nodes and edges)
│   │   ├── ExportImport.jsx     (PNG/CSV/JSON export, CSV/JSON import)
│   │   └── AboutPage.jsx        (Methodology, assumptions, data sources)
│   ├── engine/
│   │   ├── dcPowerFlow.js       (Matrix solve, flow calculation)
│   │   ├── capacityFactors.js   (Wind/solar CF from climatology percentiles)
│   │   ├── contingency.js       (N-1 analysis — remove each link, re-solve)
│   │   └── networkEditor.js     (Add/remove nodes and edges, rebuild B matrix)
│   ├── state/
│   │   └── useGridState.js      (Central state hook — all scenario state)
│   ├── utils/
│   │   ├── colours.js           (Utilisation → colour mapping)
│   │   ├── stateExport.js       (CSV/URL state serialisation)
│   │   └── constants.js         (Fuel colours, default CFs, season months)
│   └── hooks/
│       └── useDataLoader.js     (Async load of JSON data files)
├── .github/
│   └── workflows/
│       └── deploy.yml           (GitHub Pages deploy action)
├── package.json
├── vite.config.js
├── index.html
└── README.md
```

## Critical rules for implementation

### 1. DC power flow is the ONLY physics engine
No ML, no GNN, no approximations. The solve is: `B × θ = P`, LU decomposition with partial pivoting. This is exact within its assumptions. See `docs/IMPLEMENTATION.md` Section 3 for the full algorithm.

### 2. All computation is client-side
No backend, no API calls, no serverless functions. Everything runs in the browser. The DC power flow solve on a 26×26 matrix takes <1ms. Even N-1 contingency (37 re-solves) takes <50ms.

### 3. Data files are immutable at runtime
`zones.json`, `links.json`, `plants.json`, `climatology.json` are loaded once on startup. User modifications (toggle plant, add node) modify in-memory state only. Export/import allows persisting state.

### 4. Every user interaction triggers a re-solve
Toggle a fuel → recalculate zone generation → re-solve DC power flow → update all flows → update map colours. This must be <16ms to feel instant. At 26 nodes it will be.

### 5. Graceful degradation for missing data
If `zone_boundaries.geojson` doesn't exist, fall back to circle markers at zone centroids. If `climatology.json` fails to load, disable scenario sliders but keep fuel toggles and plant toggles working. Always show something useful.

### 6. Interconnectors are NOT generation
Fuel types starting with `INT` (INTFR, INTNED, INTELEC, INTNEM, INTIFA2, INTNSL, INTVKL, INTGRNL, INTEW, INTIRL) are interconnector capacity. They appear in `plants.json` and `zones.json` capacity_mw but must be treated as import links, not dispatchable generation. Their flow is determined by the DC power flow solve via the interconnector links in `links.json`.

### 7. Capacity ≠ Output
Never display nameplate capacity as generation. Always apply capacity factors:
- **Wind:** From `climatology.json`, per-zone, per-season, at user-selected percentile (p1-p99)
- **Solar:** From `climatology.json`, per-zone, per-season, at user-selected percentile (p1-p99)  
- **Nuclear:** 0.90
- **CCGT:** 0.50
- **Biomass:** 0.85
- **Coal:** 0.70
- **OCGT:** 0.30
- **Hydro (NPSHYD):** 0.40
- **Pumped Storage (PS):** 0.10 (default, adjustable)
- **Other:** 0.30

### 8. Demand comes from real data, not hardcoded multipliers
Demand is driven by `demand_climatology.json`, which contains p1-p99 distributions of actual NESO half-hourly demand data (2009-2025), broken down per zone, per season, plus annual.

The demand slider works identically to the wind slider: pick a percentile (p1-p99) and get a realistic demand level for the selected period (season or annual). This replaces the earlier approach of base demand × seasonal multiplier.

For each zone: `demand_mw = demand_climatology.zones[zoneId][season].hourly["p" + demandPercentile]`

The user can also select "annual" as the period, which uses the all-months distribution.

Default: p50 (median demand for the selected season).

The `demand_share` field in demand_climatology.json records each zone's proportion of national demand (from PyPSA-GB ESPENI). This is used to distribute national demand to zones.

---

## Data schemas

### zones.json
```typescript
interface Zone {
  id: string;           // "Z1_1", "Z2", etc.
  name: string;         // "Shetland & North Scotland"
  lat: number;          // Centroid latitude
  lon: number;          // Centroid longitude
  capacity_mw: Record<string, number>;  // Fuel type → nameplate MW
  total_capacity_mw: number;
  demand_mw: number;    // Base annual average demand
}
// File is Zone[]
```

### links.json
```typescript
interface Link {
  id: string;           // "Z9-Z3" or "IFA"
  from: string;         // Zone ID or foreign node name
  to: string;
  capacity_mw: number;
  carrier: "AC" | "DC";
}
// File is Link[]
// Foreign nodes: France1, France2, Netherlands, Belgium, N. Ireland, Ireland
// These are NOT in zones.json — position them off-coast on the map
```

### plants.json
```typescript
interface Plant {
  id: string;           // "DRAXX-1"
  name: string;         // "T_DRAXX-1"
  zone: string;         // "Z5"
  fuel: string;         // "BIOMASS", "CCGT", "WIND", etc.
  capacity_mw: number;
}
// File is Plant[]
// 383 plants, covering 98.9% of GB generation
```

### climatology.json
```typescript
interface Climatology {
  metadata: { ... };
  capacity_factor_curves: { wind: {...}, solar: {...} };
  zones: Record<string, ZoneClimatology>;
}

interface ZoneClimatology {
  wind_ms: SeasonalVar;    // 100m wind speed (m/s)
  wind_cf: SeasonalVar;    // Wind capacity factor (0-1)
  solar_jm2: SeasonalVar;  // Solar radiation (J/m²/hour)
  solar_cf: SeasonalVar;   // Solar capacity factor (0-1)
  cloud_frac: SeasonalVar; // Cloud cover (0-1)
  t2m_c: SeasonalVar;      // Temperature (°C)
}

interface SeasonalVar {
  winter: Resolution;
  spring: Resolution;
  summer: Resolution;
  autumn: Resolution;
  annual: Resolution;      // All months combined
}

interface Resolution {
  hourly: Stats;
  daily: Stats;
}

interface Stats {
  p1: number; p2: number; ... p99: number;  // Every integer percentile
  mean: number; min: number; max: number; std: number; count: number;
}
```

### demand_climatology.json
```typescript
interface DemandClimatology {
  metadata: { ... };
  national: DemandPeriods;   // National-level demand distributions
  zones: Record<string, ZoneDemand>;
}

interface ZoneDemand {
  name: string;
  demand_share: number;      // Fraction of national demand (sums to 1.0)
  base_demand_mw: number;    // From zones.json
  winter: Resolution;        // p1-p99 demand in MW for this zone
  spring: Resolution;
  summer: Resolution;
  autumn: Resolution;
  annual: Resolution;
}

// national has the same structure (Resolution per period)
// Source: NESO Historic Demand Data (half-hourly TSD), 2009-2025
// Zone shares: PyPSA-GB ESPENI population-weighted profiles
```

---

## Foreign node positions (for map display)
```javascript
const FOREIGN_NODES = {
  "France1":      { lat: 49.8,  lon: 1.3,  name: "France (IFA)" },
  "France2":      { lat: 49.6,  lon: 0.5,  name: "France (IFA2)" },
  "Netherlands":  { lat: 52.1,  lon: 3.5,  name: "Netherlands" },
  "Belgium":      { lat: 51.2,  lon: 2.8,  name: "Belgium" },
  "N. Ireland":   { lat: 54.6,  lon: -5.9, name: "N. Ireland" },
  "Ireland":      { lat: 53.3,  lon: -6.3, name: "Ireland" },
};
```

---

## Region groupings (for collapsible wind sliders)
```javascript
const REGION_GROUPS = {
  "Scotland":  ["Z1_1", "Z1_2", "Z1_3", "Z1_4"],
  "North":     ["Z2", "Z3", "Z4", "Z5"],
  "Midlands":  ["Z6", "Z7", "Z8"],
  "West":      ["Z9"],
  "East":      ["Z10"],
  "Central":   ["Z11"],
  "South":     ["Z12", "Z13", "Z14", "Z15", "Z16", "Z17"],
};
```

---

## B6 boundary
The Scotland-England boundary is the single most important constraint in GB transmission. Links `Z9-Z3` (8000 MW) and `Z7-Z2` (6000 MW) are the B6 boundary. These should be visually highlighted on the map with a distinct style (dashed line, label, or glow) and called out in the system summary when stressed.

---

## Build phases
See `docs/IMPLEMENTATION.md` for detailed specs. Summary:

1. **Phase 1:** Project scaffold, data loading, Leaflet map with zones + links + coastline
2. **Phase 2:** DC power flow engine, link colouring by utilisation, zone colouring by surplus/deficit
3. **Phase 3:** Left panel — fuel toggles, season selector, demand slider, system summary
4. **Phase 4:** Per-zone wind sliders (p1-p99), solar slider, seasonal CF switching
5. **Phase 5:** Right panel — zone detail, generation mix chart, plant list with on/off toggles
6. **Phase 6:** N-1 contingency analysis, add/remove nodes and edges
7. **Phase 7:** Export/import (PNG, CSV, JSON), shareable URL state
8. **Phase 8:** About/methodology page, polish, mobile responsive, error handling, deploy

Each phase should be a working commit. Each phase builds on the previous. Do not skip ahead.
