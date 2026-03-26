# GB Grid Scenario Tool — Implementation Specification

## Table of contents
1. Project setup
2. Data loading
3. DC power flow engine
4. Capacity factor system
5. State management
6. Map component
7. Left panel components
8. Right panel components
9. N-1 contingency and network editing
10. Export/import system
11. About page
12. Phased build with acceptance criteria

---

## 1. Project setup

### 1.1 Vite + React scaffold

```bash
npm create vite@latest gb-grid-tool -- --template react
cd gb-grid-tool
npm install leaflet react-leaflet
npm install --save-dev @vitejs/plugin-react gh-pages
```

### 1.2 vite.config.js
```javascript
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: '/gb-grid-tool/',  // GitHub Pages subpath
  build: { outDir: 'dist' }
});
```

### 1.3 package.json scripts
```json
{
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview",
    "deploy": "gh-pages -d dist"
  }
}
```

### 1.4 GitHub Actions deploy (.github/workflows/deploy.yml)
```yaml
name: Deploy to GitHub Pages
on:
  push:
    branches: [main]
permissions:
  contents: read
  pages: write
  id-token: write
jobs:
  build-and-deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: npm ci
      - run: npm run build
      - uses: actions/upload-pages-artifact@v3
        with: { path: dist }
      - uses: actions/deploy-pages@v4
```

### 1.5 index.html
Minimal. Vite injects the React app. Include Leaflet CSS in `<head>`:
```html
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
```

---

## 2. Data loading

### 2.1 useDataLoader.js hook

```javascript
/**
 * @returns {{ zones, links, plants, climatology, demandClimatology, boundaries, coastline, loading, error }}
 * 
 * Loads all JSON data files on mount. Each file loaded independently
 * so partial failures don't block the whole app.
 * 
 * zones:             Zone[] from zones.json
 * links:             Link[] from links.json
 * plants:            Plant[] from plants.json
 * climatology:       Climatology from climatology.json (ERA5 wind/solar/cloud/temp)
 * demandClimatology: DemandClimatology from demand_climatology.json (NESO demand)
 * boundaries:        GeoJSON FeatureCollection from zone_boundaries.geojson (nullable)
 * coastline:         GeoJSON FeatureCollection from gb_coastline.geojson (nullable)
 */
export function useDataLoader() {
  // Fetch each file with individual try/catch
  // zones, links, plants are REQUIRED — set error if any fail
  // climatology is REQUIRED for sliders — warn but don't block if missing
  // demandClimatology is REQUIRED for demand slider — fall back to zones.json demand_mw if missing
  // boundaries and coastline are OPTIONAL — null if missing
  
  // Return loading=true until all required files resolve
  // Return error string if required files fail
}
```

### 2.2 Data indexing on load

After loading, build lookup maps for fast access:
```javascript
const zoneMap = {};        // zoneId → Zone object
const plantsByZone = {};   // zoneId → Plant[]
const linksByZone = {};    // zoneId → Link[] (links where from or to === zoneId)
const climByZone = {};     // zoneId → ZoneClimatology
```

Build these once in the data loader and pass them through context or props. Do NOT rebuild on every render.

---

## 3. DC power flow engine

### 3.1 Core solve: `solveDCPF(zones, links, injections, slackIndex)`

```javascript
/**
 * Solve DC power flow: B × θ = P
 * 
 * @param {string[]} nodeIds - All node IDs (zone IDs + foreign node names)
 * @param {Link[]} activeLinks - Currently active links (may exclude removed links)
 * @param {Record<string, number>} injections - nodeId → net injection MW (gen - demand)
 * @param {number} slackIndex - Index of slack bus (default: 0, first node)
 * @returns {{ theta: number[], flows: FlowResult[] }}
 * 
 * FlowResult: { linkId, from, to, flow_mw, utilisation_pct, capacity_mw }
 * 
 * ALGORITHM:
 * 1. Build node index map: nodeId → integer index
 * 2. Build admittance matrix B (n × n):
 *    For each link with capacity C between nodes i, j:
 *      susceptance = C / 1000
 *      B[i][j] -= susceptance
 *      B[j][i] -= susceptance
 *      B[i][i] += susceptance
 *      B[j][j] += susceptance
 * 3. Build injection vector P (n × 1):
 *    P[i] = injections[nodeIds[i]] || 0
 * 4. Remove slack bus row and column from B, remove from P
 *    → gives (n-1) × (n-1) system
 * 5. Solve via LU decomposition with partial pivoting
 * 6. Insert θ_slack = 0 back into solution vector
 * 7. For each link, compute flow = susceptance × (θ_from - θ_to)
 * 8. Compute utilisation = |flow| / capacity × 100
 * 9. Return theta vector and flow results
 */
```

### 3.2 LU solve: `luSolve(A, b)`

```javascript
/**
 * Solve Ax = b using Gaussian elimination with partial pivoting.
 * 
 * @param {number[][]} A - n×n matrix (will be modified in place)
 * @param {number[]} b - n×1 vector (will be modified in place)
 * @returns {number[]} x - solution vector
 * 
 * ALGORITHM:
 * Forward elimination with partial pivoting:
 *   For k = 0 to n-1:
 *     Find row with max |A[i][k]| for i >= k, swap with row k
 *     For i = k+1 to n-1:
 *       factor = A[i][k] / A[k][k]
 *       Subtract factor × row k from row i
 *       b[i] -= factor × b[k]
 * Back substitution:
 *   For i = n-1 down to 0:
 *     x[i] = (b[i] - sum(A[i][j] × x[j] for j > i)) / A[i][i]
 * 
 * Handle near-zero pivots (|A[k][k]| < 1e-12) by setting x[k] = 0
 * This happens when a node is isolated (no links).
 */
```

### 3.3 Building injections: `computeInjections(data, state)`

```javascript
/**
 * Compute net power injection per node for current scenario.
 * 
 * @param {Object} data - { zones, plants, climatology, demandClimatology }
 * @param {GridState} state - Current UI state (fuel toggles, plant toggles,
 *                            wind percentiles, solar percentile, period, demandPercentile)
 * @returns {Record<string, number>} nodeId → net injection MW
 * 
 * For each zone:
 *   generation = sum of (plant_capacity × capacity_factor) for all enabled plants
 *   demand = getZoneDemand(demandClimatology, zoneId, period, demandPercentile)
 *   injection = generation - demand
 * 
 * For foreign nodes:
 *   injection = 0 (they're passive — flow is determined by the network)
 * 
 * Capacity factor logic per plant:
 *   if plant.fuel === "WIND":
 *     cf = getWindCF(climatology, plant.zone, period, windPercentiles[plant.zone])
 *   else if plant.fuel === "SOLAR" (if any exist):
 *     cf = getSolarCF(climatology, plant.zone, period, solarPercentile)
 *   else if INT_FUELS.includes(plant.fuel):
 *     skip — not dispatchable generation
 *   else:
 *     cf = DEFAULT_CF[plant.fuel]
 * 
 *   if fuelEnabled[plant.fuel] === false: cf = 0
 *   if plantEnabled[plant.id] === false: cf = 0
 * 
 * IMPORTANT: demand comes from demand_climatology.json (real NESO data),
 * NOT from zones.json × multiplier. The zones.json demand_mw field is only
 * used as a fallback if demand_climatology is unavailable.
 */
```

### 3.4 Wrapper: `runPowerFlow(data, state)`

```javascript
/**
 * Top-level function called on every state change.
 * 
 * @param {Object} data - { zones, links, plants, climatology, demandClimatology }
 * @param {GridState} state - { period, demandPercentile, windPercentiles,
 *                              solarPercentile, fuelEnabled, plantDisabled,
 *                              removedLinks, addedNodes, addedLinks, linkCapacityOverrides }
 * 
 * 1. Compute injections from current state (using demand_climatology for demand)
 * 2. Build active links list (exclude user-removed links, include user-added links)
 * 3. Build node list (all zone IDs + foreign nodes + user-added nodes)
 * 4. Call solveDCPF
 * 5. Return { flows, zoneGeneration, zoneDemand, systemSummary }
 * 
 * systemSummary: {
 *   totalGeneration: number,
 *   totalDemand: number,
 *   balance: number,
 *   maxUtilisation: number,
 *   bottleneckCount: number,  // links > 80%
 *   criticalCount: number,    // links > 95%
 *   b6Utilisation: number,    // max of Z9-Z3 and Z7-Z2
 * }
 */
```

---

## 4. Capacity factor system

### 4.1 capacityFactors.js

```javascript
/**
 * Get wind capacity factor for a zone at given period and percentile.
 * 
 * @param {Climatology} clim
 * @param {string} zoneId
 * @param {string} period - "winter"|"spring"|"summer"|"autumn"|"annual"
 * @param {number} percentile - 1-99
 * @returns {number} 0-1
 */
export function getWindCF(clim, zoneId, period, percentile) {
  // Access: clim.zones[zoneId].wind_cf[period].hourly["p" + percentile]
  // Return 0 if path doesn't exist
  const path = clim?.zones?.[zoneId]?.wind_cf?.[period]?.hourly;
  return path?.["p" + percentile] ?? 0;
}

/**
 * Get solar capacity factor for a zone at given period and percentile.
 * Same structure but reading solar_cf.
 */
export function getSolarCF(clim, zoneId, period, percentile) {
  // Access: clim.zones[zoneId].solar_cf[period].hourly["p" + percentile]
  const path = clim?.zones?.[zoneId]?.solar_cf?.[period]?.hourly;
  return path?.["p" + percentile] ?? 0;
}

/**
 * Get demand for a zone at given period and percentile.
 * Reads from demand_climatology.json, NOT from zones.json.
 * 
 * @param {DemandClimatology} demClim
 * @param {string} zoneId
 * @param {string} period - "winter"|"spring"|"summer"|"autumn"|"annual"
 * @param {number} percentile - 1-99
 * @returns {number} MW
 */
export function getZoneDemand(demClim, zoneId, period, percentile) {
  const path = demClim?.zones?.[zoneId]?.[period]?.hourly;
  return path?.["p" + percentile] ?? 0;
}

/**
 * Get wind speed (m/s) for display labels on sliders.
 */
export function getWindSpeed(clim, zoneId, period, percentile) {
  const path = clim?.zones?.[zoneId]?.wind_ms?.[period]?.hourly;
  return path?.["p" + percentile] ?? 0;
}

/**
 * Get solar irradiance (J/m²/hour) for display labels on sliders.
 */
export function getSolarIrradiance(clim, zoneId, period, percentile) {
  const path = clim?.zones?.[zoneId]?.solar_jm2?.[period]?.hourly;
  return path?.["p" + percentile] ?? 0;
}

/**
 * Get national demand for display labels on demand slider.
 */
export function getNationalDemand(demClim, period, percentile) {
  const path = demClim?.national?.[period]?.hourly;
  return path?.["p" + percentile] ?? 0;
}

/**
 * Get default CF for dispatchable fuels.
 * These don't vary by zone or season in the current model.
 */
export const DEFAULT_CF = {
  NUCLEAR: 0.90,
  CCGT: 0.50,
  BIOMASS: 0.85,
  COAL: 0.70,
  OCGT: 0.30,
  NPSHYD: 0.40,
  PS: 0.10,
  OTHER: 0.30,
};

/**
 * Demand is now driven by demand_climatology.json, NOT hardcoded multipliers.
 * The demand slider is a percentile slider (p1-p99) just like wind/solar.
 * 
 * To get zone demand:
 *   demandClimatology.zones[zoneId][period].hourly["p" + demandPercentile]
 * where period = "winter"|"spring"|"summer"|"autumn"|"annual"
 */

/**
 * Valid periods for all climatology lookups (season + annual).
 */
export const PERIODS = ["winter", "spring", "summer", "autumn", "annual"];

/**
 * Fuel types that are interconnectors (not dispatchable generation).
 */
export const INT_FUELS = [
  "INTFR","INTNED","INTELEC","INTNEM","INTIFA2",
  "INTNSL","INTVKL","INTGRNL","INTEW","INTIRL"
];
```

---

## 5. State management

### 5.1 useGridState.js — central state hook

```javascript
/**
 * All mutable scenario state lives here.
 * Every setter triggers a re-solve of DC power flow.
 * 
 * @returns {GridState}
 */
export function useGridState(data) {
  // --- Scenario controls ---
  const [period, setPeriod] = useState("winter");  // "winter"|"spring"|"summer"|"autumn"|"annual"
  const [demandPercentile, setDemandPercentile] = useState(50);  // p1-p99, reads from demand_climatology
  
  // --- Wind percentile per zone (default all at p50) ---
  // Record<zoneId, number(1-99)>
  const [windPercentiles, setWindPercentiles] = useState(
    () => Object.fromEntries(data.zones.map(z => [z.id, 50]))
  );
  // Helper: setZoneWindPercentile(zoneId, pct)
  // Helper: setRegionWindPercentile(regionZoneIds[], pct)
  // Helper: setAllWindPercentile(pct)
  
  // --- Solar percentile (national, single slider) ---
  const [solarPercentile, setSolarPercentile] = useState(50);
  
  // --- Fuel toggles ---
  // Record<fuelType, boolean>
  const [fuelEnabled, setFuelEnabled] = useState(
    () => Object.fromEntries(GEN_FUELS.map(f => [f, true]))
  );
  
  // --- Individual plant toggles ---
  // Record<plantId, boolean> — default all true
  // Only store overrides (plants explicitly toggled off)
  const [plantDisabled, setPlantDisabled] = useState({});
  
  // --- Network modifications ---
  const [removedLinks, setRemovedLinks] = useState(new Set());
  const [addedNodes, setAddedNodes] = useState([]);
  // AddedNode: { id, name, lat, lon, capacity_mw, connectedTo: zoneId, linkCapacity }
  const [addedLinks, setAddedLinks] = useState([]);
  // AddedLink: { id, from, to, capacity_mw, carrier }
  const [linkCapacityOverrides, setLinkCapacityOverrides] = useState({});
  // Record<linkId, number> — user-modified capacities
  
  // --- UI state ---
  const [selectedZone, setSelectedZone] = useState(null);
  const [selectedLink, setSelectedLink] = useState(null);
  const [contingencyEnabled, setContingencyEnabled] = useState(false);
  
  // --- Derived: run power flow on every state change ---
  const flowResults = useMemo(() => {
    if (!data.zones || !data.links) return null;
    return runPowerFlow(data, {
      season, demandMultiplier, windPercentiles, solarPercentile,
      fuelEnabled, plantDisabled, removedLinks, addedNodes, addedLinks,
      linkCapacityOverrides,
    });
  }, [
    season, demandMultiplier, windPercentiles, solarPercentile,
    fuelEnabled, plantDisabled, removedLinks, addedNodes, addedLinks,
    linkCapacityOverrides, data,
  ]);
  
  // --- Derived: contingency results (expensive, only when enabled) ---
  const contingencyResults = useMemo(() => {
    if (!contingencyEnabled || !data.zones || !data.links) return null;
    return runContingency(data, state);
  }, [contingencyEnabled, ...sameDepsAsAbove]);
  
  return { /* all state and setters */ };
}
```

---

## 6. Map component

### 6.1 MapView.jsx

```jsx
/**
 * Leaflet map centered on GB.
 * 
 * Layers (bottom to top):
 * 1. OSM tile layer (base map)
 * 2. GB coastline GeoJSON (if available) — thin grey outline
 * 3. Zone boundary polygons (if available) — filled with surplus/deficit colour
 *    Fallback: CircleMarker at zone centroid if no boundaries
 * 4. Transmission links — lines coloured by utilisation
 * 5. Foreign node markers — small grey circles off-coast
 * 6. Zone labels — zone ID text at centroid
 * 7. B6 boundary highlight — dashed overlay on Z9-Z3 and Z7-Z2
 * 
 * Map config:
 *   center: [55.5, -3.5]
 *   zoom: 6
 *   minZoom: 5
 *   maxZoom: 10
 *   maxBounds: [[49, -9], [62, 4]]
 * 
 * Interactions:
 *   Click zone polygon/circle → setSelectedZone(zoneId)
 *   Click link line → setSelectedLink(linkId)
 *   Click empty area → clear selection
 * 
 * Link styling:
 *   width: Math.max(1.5, link.capacity_mw / 4000)  — scale to 1.5-3px
 *   colour: utilisation-based
 *     < 50%:  #1D9E75 (green)
 *     50-80%: #EF9F27 (amber)
 *     80-95%: #E24B4A (red)
 *     > 95%:  #791F1F (dark red), dashArray: "8 4"
 *   opacity: 0.8
 * 
 * Zone polygon styling:
 *   fillColor: surplus > 200 MW → green (#1D9E75, opacity 0.3)
 *              deficit > 200 MW → red (#E24B4A, opacity 0.3)
 *              balanced → grey (#888780, opacity 0.15)
 *   stroke: 0.5px #888
 *   On selected: stroke 2px #378ADD
 * 
 * Zone circle fallback (if no boundaries):
 *   radius: 12px fixed (NOT scaled by capacity — that was the POC problem)
 *   same fill logic as polygons
 * 
 * Foreign nodes:
 *   CircleMarker radius 5, fill #B4B2A9, with tooltip showing name
 * 
 * B6 boundary:
 *   Additional dashed overlay on Z9-Z3 and Z7-Z2 links
 *   When utilisation > 60%: pulsing animation or thicker line
 *   Small label "B6" at midpoint
 */
```

### 6.2 Flow direction arrows on links

```javascript
/**
 * Show flow direction on each link.
 * Use a small arrowhead at the midpoint of the line, pointing in flow direction.
 * Only show if |flow| > 100 MW (avoid clutter on near-zero flows).
 * 
 * Arrow rotation = atan2(to.lat - from.lat, to.lon - from.lon)
 * If flow is negative (from←to), flip the arrow.
 * 
 * Implement as Leaflet DivIcon or SVG marker at line midpoint.
 */
```

---

## 7. Left panel components

### 7.1 PeriodSelector.jsx (was SeasonSelector)
```jsx
/**
 * Five-button toggle: Winter | Spring | Summer | Autumn | Annual
 * Highlighted button = active period.
 * On change: state.setPeriod(period)
 * Display: period name. "Annual" uses all-months distributions for wind, solar, and demand.
 * When period changes, ALL sliders (wind, solar, demand) read from the new period's
 * climatology data. Labels update accordingly.
 */
```

### 7.2 FuelToggles.jsx
```jsx
/**
 * One row per generation fuel type (not INT fuels).
 * Order: WIND, NUCLEAR, CCGT, BIOMASS, COAL, OCGT, NPSHYD, PS, OTHER
 * 
 * Each row:
 *   [checkbox] [coloured dot] [fuel name] [current output GW]
 * 
 * Current output = sum across all zones of (enabled plant capacity × CF)
 * Checkbox toggles fuelEnabled[fuel]
 * 
 * Fuel colours (consistent everywhere):
 *   WIND: #378ADD (blue)
 *   NUCLEAR: #7F77DD (purple)
 *   CCGT: #EF9F27 (amber)
 *   BIOMASS: #1D9E75 (teal)
 *   COAL: #5F5E5A (grey)
 *   OCGT: #D85A30 (coral)
 *   NPSHYD: #5DCAA5 (light teal)
 *   PS: #85B7EB (light blue)
 *   OTHER: #B4B2A9 (light grey)
 */
```

### 7.3 WindSliders.jsx
```jsx
/**
 * Per-zone wind percentile sliders, collapsible by region.
 * 
 * Layout:
 *   [Scotland ▼]  <-- click to expand/collapse
 *     [All Scotland] ---|========|--- p50  (master slider for region)
 *     Z1_1 Shetland  ---|========|--- p50
 *     Z1_2 W. Scot   ---|========|--- p50
 *     Z1_3 C. Scot   ---|========|--- p50
 *     Z1_4 S. Scot   ---|========|--- p50
 *   [North ▼]
 *     ...
 *   [South ▼]
 *     ...
 * 
 * Slider: range input, min=1, max=99, step=1, default=50
 * Label shows: "p{value}" and the corresponding wind speed + CF for CURRENT PERIOD
 *   e.g. "p72 — 11.2 m/s → 0.84 CF"
 *   Read from: getWindSpeed(clim, zoneId, period, pct) and getWindCF(clim, zoneId, period, pct)
 *   When period changes, labels update automatically with new period's data.
 * 
 * Master slider: sets all zones in that region to same value.
 *   If individual zones differ, master shows average (greyed).
 * 
 * Region groups defined in CLAUDE.md.
 */
```

### 7.4 Solar slider
```jsx
/**
 * Single national slider for solar percentile (p1-p99).
 * Simpler than wind — less regional variation matters for GB solar.
 * Label shows: "p{value} — {solar_jm2} J/m² → {cf} CF"
 *   Read from: getSolarIrradiance and getSolarCF for current period
 *   Uses a representative zone (e.g. Z12 or national average) for the label.
 * 
 * If a future version needs per-zone solar, the architecture supports it
 * (same pattern as wind sliders).
 */
```

### 7.5 Demand slider
```jsx
/**
 * Percentile slider: p1 to p99, default p50.
 * Reads from demand_climatology.json for the selected period.
 * Label: "Demand: p{N} — {national_demand} GW ({zone_demand} MW for selected zone)"
 * 
 * For each zone: demand = demandClimatology.zones[zoneId][period].hourly["p" + pct]
 * 
 * This replaces the old percentage-of-baseline approach with real
 * demand distributions from NESO historic data.
 */
```

### 7.6 SystemSummary.jsx
```jsx
/**
 * Dashboard cards showing system-wide metrics:
 * 
 *   Total generation:   XX.X GW    (green if > demand)
 *   Total demand:       XX.X GW
 *   System balance:    +X.X GW     (green if positive, red if negative)
 *   Max utilisation:    XX%         (coloured by severity)
 *   Bottlenecks:        N links    (count of links > 80%)
 *   B6 utilisation:     XX%         (always shown, key constraint)
 * 
 * All values update on every state change.
 */
```

---

## 8. Right panel components

### 8.1 RightPanel.jsx (container)
```jsx
/**
 * Shows different content depending on selection:
 *   - Nothing selected: prompt "Click a zone or link on the map"
 *   - Zone selected: ZoneDetail
 *   - Link selected: LinkDetail
 */
```

### 8.2 ZoneDetail
```jsx
/**
 * Shown when a zone is clicked.
 * 
 * Header: Zone name, zone ID
 * 
 * Stats cards:
 *   Generation: XXXX MW (actual output after CF)
 *   Demand: XXXX MW (after seasonal + user adjustment)
 *   Balance: ±XXXX MW
 * 
 * Generation mix bar:
 *   Horizontal stacked bar, one segment per active fuel type.
 *   Width proportional to that fuel's output (NOT capacity).
 *   Coloured by fuel. Hover/click segment shows tooltip.
 * 
 * Connected links table:
 *   Direction arrow (→ or ←), other zone name, flow MW, utilisation %
 *   Colour utilisation value by severity.
 *   B6 links get a small badge.
 *   Click link row → setSelectedLink(linkId) → show LinkDetail
 * 
 * Plant list (PlantList component):
 *   Table: Name | Fuel | Capacity MW | Output MW | Status toggle
 *   Sorted by capacity descending.
 *   Search box to filter by name.
 *   Toggle switches plant on/off individually.
 *   "Toggle all [fuel]" buttons above the table.
 *   Fuel colour dot next to each plant name.
 *   Output MW = capacity × CF if enabled, 0 if disabled.
 */
```

### 8.3 LinkDetail
```jsx
/**
 * Shown when a link is clicked on the map.
 * 
 * Header: Link ID (e.g. "Z9 → Z3")
 * B6 badge if applicable.
 * 
 * Stats:
 *   Capacity: XXXX MW (editable if link capacity editing enabled)
 *   Current flow: XXXX MW (with direction arrow)
 *   Utilisation: XX% (coloured by severity, large text)
 *   Carrier: AC or DC
 * 
 * Capacity slider: allows user to adjust link capacity (0 to 2× original)
 *   Changes stored in linkCapacityOverrides
 *   "Reset" button to restore original
 * 
 * "Remove link" button: adds to removedLinks set, triggers re-solve
 *   Shows warning: "This simulates link failure"
 *   "Restore" button to undo
 */
```

### 8.4 PlantList.jsx
```jsx
/**
 * Sortable, filterable table of plants in a zone.
 * 
 * Props: zoneId, plants[], state
 * 
 * Features:
 *   Search input: filters by plant name (case-insensitive substring)
 *   Sort: click column header to sort by name, fuel, capacity, output
 *   Bulk toggles: "All WIND off" / "All CCGT on" etc.
 *   Per-plant toggle: small switch on each row
 * 
 * Columns:
 *   Fuel dot | Name | Fuel type | Capacity MW | Output MW | On/Off toggle
 * 
 * Output MW = capacity × applicable CF if plant is on, 0 if off.
 * Grey out rows where plant is off.
 */
```

---

## 9. N-1 contingency and network editing

### 9.1 contingency.js

```javascript
/**
 * N-1 contingency analysis: what happens if each link fails?
 * 
 * @param {Data} data - zones, links, climatology
 * @param {GridState} state - current scenario state
 * @returns {ContingencyResult[]}
 * 
 * ContingencyResult: {
 *   removedLinkId: string,
 *   maxUtilisation: number,         // highest utilisation on remaining links
 *   overloadedLinks: string[],      // links exceeding 100% after removal
 *   worstAffectedLink: string,      // link with highest utilisation increase
 *   utilisationIncrease: number,    // max increase in utilisation on any link
 *   cascadeRisk: "low"|"medium"|"high"|"critical"
 * }
 * 
 * ALGORITHM:
 * For each link L in active links:
 *   1. Create temporary link list without L
 *   2. Run solveDCPF with same injections but reduced link set
 *   3. Compare resulting utilisations to base case
 *   4. Record worst-case metrics
 * 
 * cascadeRisk classification:
 *   critical: any link > 100% after removal
 *   high: any link > 90% after removal
 *   medium: any link > 80% after removal
 *   low: all links < 80% after removal
 * 
 * Performance: 37 solves × ~0.5ms each = ~20ms total. Fine for UI.
 */
```

### 9.2 ContingencyPanel.jsx
```jsx
/**
 * Toggle button: "N-1 Analysis: Off / On"
 * When on, shows sortable table of results:
 * 
 *   Link removed | Cascade risk | Max util | Worst affected | Δ util
 * 
 * Sorted by cascade risk (critical first).
 * Click row → highlight that link on map + show what would overload.
 * 
 * Colour-coded risk badges:
 *   critical = red, high = amber, medium = yellow, low = green
 */
```

### 9.3 networkEditor.js

```javascript
/**
 * Functions for modifying the network topology.
 * All return new state — never mutate existing data.
 */

/**
 * Add a new generation node to the network.
 * @param {string} id - Unique ID for new node
 * @param {string} name - Display name
 * @param {number} lat, lon - Position
 * @param {Record<string, number>} capacity_mw - Fuel type → MW
 * @param {string} connectTo - Existing zone to link to
 * @param {number} linkCapacity - MW capacity of new link
 * @returns {AddedNode}
 */
export function createNode(id, name, lat, lon, capacity_mw, connectTo, linkCapacity) {}

/**
 * Add a new transmission link between two nodes.
 * @param {string} from - Node ID
 * @param {string} to - Node ID
 * @param {number} capacity_mw
 * @param {string} carrier - "AC" or "DC"
 * @returns {AddedLink}
 */
export function createLink(from, to, capacity_mw, carrier) {}

/**
 * Remove a link (mark as removed in state).
 * @param {string} linkId
 */
export function removeLink(linkId) {}

/**
 * Modify link capacity.
 * @param {string} linkId
 * @param {number} newCapacity
 */
export function setLinkCapacity(linkId, newCapacity) {}
```

### 9.4 NodeEdgeEditor.jsx
```jsx
/**
 * UI for adding/removing nodes and edges.
 * 
 * "Add generation node" dialog:
 *   - Name text input
 *   - Lat/lon inputs (or click map to place)
 *   - Fuel type dropdown + capacity MW input
 *   - Connect to: dropdown of existing zones
 *   - Link capacity: number input (default 2000 MW)
 *   - "Add" button
 * 
 * "Add link" dialog:
 *   - From: dropdown of all nodes
 *   - To: dropdown of all nodes
 *   - Capacity MW input
 *   - Carrier: AC/DC toggle
 *   - "Add" button
 * 
 * "Active modifications" list:
 *   Shows all user-added nodes, added links, removed links, capacity overrides.
 *   Each has a "Remove" / "Restore" button.
 *   "Reset all" button clears everything.
 */
```

---

## 10. Export/import system

### 10.1 stateExport.js

```javascript
/**
 * Export current state as CSV.
 * 
 * CSV structure:
 * Section 1: Scenario settings
 *   season, windPercentiles (JSON), solarPercentile, demandMultiplier
 * 
 * Section 2: Zone results
 *   zoneId, name, generation_mw, demand_mw, balance_mw
 * 
 * Section 3: Link results
 *   linkId, from, to, capacity_mw, flow_mw, utilisation_pct
 * 
 * Section 4: Plant statuses
 *   plantId, zone, fuel, capacity_mw, enabled, output_mw
 * 
 * Section 5: Network modifications
 *   type (added_node|added_link|removed_link|capacity_override), details JSON
 */
export function exportCSV(state, flowResults) {}

/**
 * Export state as JSON (full fidelity, for reimporting).
 */
export function exportJSON(state) {}

/**
 * Import state from JSON.
 * Validates structure, warns on version mismatch.
 */
export function importJSON(jsonString) {}

/**
 * Encode key state into URL query params for sharing.
 * Only encode non-default values to keep URL short.
 * 
 * Example: ?season=winter&wind=p90&nuclear=off&demand=1.3
 * For per-zone wind, use: &wZ1_1=72&wZ5=90 etc.
 */
export function encodeStateToURL(state) {}
export function decodeStateFromURL(searchString) {}
```

### 10.2 PNG export
```javascript
/**
 * Use Leaflet's built-in or html2canvas to screenshot the map.
 * Add legend overlay before capture, remove after.
 * Trigger browser download of resulting PNG.
 */
```

### 10.3 ExportImport.jsx
```jsx
/**
 * Buttons in the header or left panel:
 *   [Export PNG] [Export CSV] [Export JSON] [Import] [Share URL]
 * 
 * Import: file input accepting .json and .csv
 * Share URL: copies URL with state params to clipboard, shows confirmation
 */
```

---

## 11. About page

### 11.1 AboutPage.jsx
```jsx
/**
 * Accessible via button/link in header.
 * Can be a modal overlay or a route (/about).
 * 
 * Sections:
 * 
 * 1. What this tool does (2-3 sentences)
 * 
 * 2. Methodology
 *    - DC power flow explanation (B × θ = P)
 *    - Susceptance approximation (capacity / 1000)
 *    - Zonal model (20 nodes from PyPSA-GB ETYS)
 *    - Capacity factors: wind from IEC power curve (Staffell & Pfenninger 2016),
 *      solar from IEC 61215 STC with 0.85 performance ratio
 * 
 * 3. Assumptions and limitations
 *    (All 9 points from spec Section 6 — display verbatim)
 * 
 * 4. Data sources
 *    - Network topology: PyPSA-GB (Lyden et al., 2024), NESO ETYS
 *    - Generation units: Elexon BMRS Insights Solution API
 *    - Zone mapping: Custom multi-source (GSP + ETYS + TEC + manual)
 *    - Demand: PyPSA-GB ESPENI, population-weighted
 *    - Climatology: ERA5 reanalysis (Hersbach et al., 2020), 1991-2024
 *    - Renewable locations: REPD (DESNZ)
 * 
 * 5. References
 *    - Staffell & Pfenninger (2016), Energy
 *    - Pfenninger & Staffell (2016), Energy
 *    - Hersbach et al. (2020), QJRMS
 *    - Lyden et al. (2024), PyPSA-GB
 *    - IEC 61400-1:2019, IEC 61215:2021
 * 
 * 6. Author / contact / GitHub link
 */
```

---

## 12. Phased build with acceptance criteria

### Phase 1: Scaffold + data + static map
**Tasks:**
- `npm create vite` with React template
- Install leaflet, react-leaflet
- Create file structure per CLAUDE.md
- Copy data files to `public/data/`
- Implement `useDataLoader.js`
- Implement `MapView.jsx` with OSM tiles, zone markers, link lines
- Add GB coastline GeoJSON overlay
- Position foreign nodes off-coast
- Deploy scaffold to GitHub Pages

**Acceptance criteria:**
- `npm run dev` shows Leaflet map centered on GB
- 20 zone circles visible at correct positions
- 37 links drawn as lines between zones
- 6 foreign nodes visible off-coast
- GB coastline outline visible
- Click zone → console.log(zoneId)
- No errors in console

### Phase 2: DC power flow engine
**Tasks:**
- Implement `dcPowerFlow.js` (solveDCPF, luSolve)
- Implement `capacityFactors.js` (getWindCF, getSolarCF, defaults)
- Implement `computeInjections` in engine
- Implement `runPowerFlow` wrapper
- Wire to map: links coloured by utilisation, zones by surplus/deficit
- Add B6 boundary visual highlight

**Acceptance criteria:**
- Links change colour based on flow (green/amber/red)
- B6 links (Z9-Z3, Z7-Z2) correctly identified and highlighted
- Zone markers show surplus (green) or deficit (red)
- Console shows: total gen, total demand, balance, max utilisation
- Flows reverse direction when generation/demand balance changes

### Phase 3: Left panel controls
**Tasks:**
- Implement `LeftPanel.jsx` container
- Implement `SeasonSelector.jsx`
- Implement `FuelToggles.jsx`
- Implement demand slider
- Implement `SystemSummary.jsx`
- Wire all controls → state → re-solve → map update

**Acceptance criteria:**
- Changing season updates demand and wind/solar CFs
- Toggling NUCLEAR off shows significant flow changes
- Toggling WIND off reduces Scottish surplus
- Demand slider changes zone demands and system balance
- System summary shows correct totals
- All changes reflected on map within <100ms

### Phase 4: Wind and solar sliders
**Tasks:**
- Implement `WindSliders.jsx` with per-zone p1-p99 sliders
- Region collapsible groups with master sliders
- Solar percentile slider
- Read actual climatology data for labels (wind speed + CF at selected percentile)
- Seasonal switching (sliders read correct season from climatology)

**Acceptance criteria:**
- Each zone has its own wind slider
- Regions collapse/expand
- Master slider moves all zone sliders in region
- Slider label shows: "p{N} — {wind_ms} m/s → {CF} CF"
- Moving slider → re-solve → map updates
- Changing season → slider labels update with new season's climatology
- Solar slider works independently

### Phase 5: Right panel — zone detail + plant list
**Tasks:**
- Implement `RightPanel.jsx` container
- Implement zone detail view (stats, gen mix bar, connected links)
- Implement `PlantList.jsx` with search, sort, per-plant toggles
- Implement link detail view (stats, capacity slider, remove button)
- Wire plant toggles → state → re-solve

**Acceptance criteria:**
- Click zone → right panel shows zone detail
- Generation mix bar shows correct proportions by fuel
- Plant list shows all plants in zone, sorted by capacity
- Search filters plants by name
- Toggle plant off → output drops → zone balance changes → map updates
- Click link → right panel shows link detail with flow and utilisation
- Link capacity slider adjusts capacity → re-solve → new flows

### Phase 6: N-1 contingency + network editing
**Tasks:**
- Implement `contingency.js`
- Implement `ContingencyPanel.jsx`
- Implement `networkEditor.js`
- Implement `NodeEdgeEditor.jsx`
- Add node dialog (with map click placement)
- Add link dialog
- Active modifications list with undo

**Acceptance criteria:**
- N-1 toggle runs 37 re-solves, shows results table
- Results sorted by cascade risk
- Clicking contingency result highlights affected links on map
- Can add new node → appears on map → connected to existing zone → flows recalculate
- Can add new link between nodes → flows recalculate
- Can remove link → flows recalculate → "restore" button works
- "Reset all" clears all modifications

### Phase 7: Export/import + shareable URL
**Tasks:**
- Implement `stateExport.js` (CSV, JSON, URL encoding)
- PNG export (html2canvas or leaflet plugin)
- Implement `ExportImport.jsx`
- URL state decoding on page load

**Acceptance criteria:**
- Export CSV downloads with all sections populated
- Export JSON downloads valid JSON that can be reimported
- Import JSON restores full scenario state
- Share URL copies link to clipboard
- Opening shared URL restores scenario state
- PNG export captures current map with legend

### Phase 8: About page + polish
**Tasks:**
- Implement `AboutPage.jsx` with all methodology content
- Mobile responsive layout (stack panels vertically below 768px)
- Loading spinner on data load
- Error boundaries for each panel
- Leaflet map resize handling
- Performance: debounce rapid slider changes (16ms)
- Final deploy to GitHub Pages

**Acceptance criteria:**
- About page shows all methodology, assumptions, data sources
- Works on mobile (panels stack, map still interactive)
- Loading state shown while data loads
- No console errors
- Slider dragging feels smooth (debounced re-solve)
- Deployed and accessible via GitHub Pages URL
