#!/usr/bin/env node
/**
 * Correlated Boundary Flow Validation
 *
 * Uses real ERA5 weather hours aligned with NESO demand and interconnector data.
 * Each sample preserves real-world correlations:
 *   - Wind-demand anti-correlation (windy = mild = less heating)
 *   - Spatial wind coherence (all zones from same hour)
 *   - Real interconnector imports (not fixed percentage)
 *
 * Usage: node scripts/validate_correlated.mjs
 */

import { readFileSync } from 'fs';
import { solveDCPF } from '../src/engine/dcPowerFlow.js';
import { getLinksForYear } from '../src/engine/networkBuilder.js';
import { applyMeritOrder } from '../src/engine/meritOrder.js';

// --- Load data ---
function loadJSON(path) {
  return JSON.parse(readFileSync(path, 'utf-8'));
}

const zonesTNUoS = loadJSON('public/data/zones_tnuos.json');
const linksByYear = loadJSON('public/data/links_tnuos_by_year.json');
const boundaryMapping = loadJSON('public/data/boundary_link_mapping.json');
const etysCapabilities = loadJSON('public/data/etys_capabilities.json');
const validationData = loadJSON('scripts/winter_validation_data.json');

const NUCLEAR_AVAILABILITY = 0.80;
const YEAR = 2024;
const SCENARIO = 'Holistic Transition';

// --- Build zone capacity (built plants only, 2024) ---
const plantsTNUoS = loadJSON('public/data/plants_tnuos.json');
const zoneCapacity = {};
for (const plant of plantsTNUoS) {
  if (!plant.zone_id || !plant.plant_type) continue;
  if (plant.status !== 'Built' || plant.mw_connected <= 0) continue;
  if (plant.plant_type.includes('Demand') || plant.plant_type.includes('Reactive') || plant.plant_type.includes('Substation')) continue;
  if (!zoneCapacity[plant.zone_id]) zoneCapacity[plant.zone_id] = {};
  zoneCapacity[plant.zone_id][plant.plant_type] =
    (zoneCapacity[plant.zone_id][plant.plant_type] || 0) + plant.mw_connected;
}

// Also get zone fallback from zones_tnuos
const zoneFallback = {};
for (const [zid, zdata] of Object.entries(zonesTNUoS)) {
  zoneFallback[zid] = zdata.generation_by_type || {};
}

// Zone demand shares (from zones_tnuos demand_mw_by_year 2024)
const zoneDemandShares = {};
let totalBaseDemand = 0;
for (const [zid, zdata] of Object.entries(zonesTNUoS)) {
  const d = zdata.demand_mw_by_year?.[String(YEAR)] || 0;
  zoneDemandShares[zid] = d;
  totalBaseDemand += d;
}
// Normalize to shares
for (const zid of Object.keys(zoneDemandShares)) {
  zoneDemandShares[zid] /= totalBaseDemand;
}

// IC capacity per zone
const IC_CAPACITY = validationData.metadata.ic_capacity_mw;
const TOTAL_IC_CAPACITY = Object.values(IC_CAPACITY).reduce((s, v) => s + v, 0);

// --- For each real historical hour, run the engine ---
const links = getLinksForYear(linksByYear, YEAR);
const records = validationData.records;

console.log('=== Correlated Boundary Flow Validation ===');
console.log(`Year: ${YEAR} | Season: winter | Scenario: ${SCENARIO}`);
console.log(`Samples: ${records.length} real ERA5+NESO hours`);
console.log('');

const flowSamples = {}; // { boundaryId: [signedFlow, ...] }
let scenarioCount = 0;
let errorCount = 0;

for (const record of records) {
  try {
    const zoneGen = {};
    const zoneDemand = {};

    // Distribute national demand to zones by share
    for (const [zid, share] of Object.entries(zoneDemandShares)) {
      zoneDemand[zid] = record.tsd_mw * share;
    }

    // Build generation per zone from real weather
    for (const [zid, zdata] of Object.entries(zonesTNUoS)) {
      const genByType = {};
      const cap = zoneCapacity[zid] || {};
      const fb = zoneFallback[zid] || {};
      const allTypes = new Set([...Object.keys(cap), ...Object.keys(fb)]);

      for (const plantType of allTypes) {
        if (plantType.includes('Demand') || plantType.includes('Reactive') || plantType.includes('Substation')) continue;

        let mw = cap[plantType] || fb[plantType]?.built_mw || 0;
        if (mw <= 0) continue;

        // Skip interconnectors (handled separately with real data)
        if (plantType === 'Interconnector') continue;

        // Apply REAL weather CFs from this specific hour
        let gen = 0;
        if (plantType.includes('Wind')) {
          const cf = record.wind_cf[zid] || 0;
          gen = mw * cf;
        } else if (plantType.includes('Solar') || plantType.includes('PV')) {
          const cf = record.solar_cf[zid] || 0;
          gen = mw * cf;
        } else if (plantType.includes('Nuclear')) {
          gen = mw * NUCLEAR_AVAILABILITY;
        } else {
          gen = mw; // thermal at full capacity (merit order will dispatch)
        }

        genByType[plantType] = gen;
      }

      zoneGen[zid] = genByType;
    }

    // Calculate national wind CF for merit order blend
    let windWeightedCF = 0, windTotalCap = 0;
    for (const [zid, types] of Object.entries(zoneCapacity)) {
      for (const [pt, mw] of Object.entries(types)) {
        if (pt.includes('Wind')) {
          const cf = record.wind_cf[zid] || 0;
          windWeightedCF += cf * mw;
          windTotalCap += mw;
        }
      }
    }
    const nationalWindCF = windTotalCap > 0 ? windWeightedCF / windTotalCap : 0.25;

    // Merit order dispatch
    const meritResult = applyMeritOrder(zoneGen, zoneDemand, {}, nationalWindCF);

    // Build injections: dispatched gen + REAL IC imports - demand
    const injections = {};
    const icByZone = record.ic_by_zone || {};

    for (const zid of Object.keys(zonesTNUoS)) {
      const dispatched = Object.values(meritResult.adjustedGeneration[zid] || {}).reduce((s, v) => s + v, 0);
      const icImport = icByZone[zid] || 0;
      const demand = zoneDemand[zid] || 0;
      injections[zid] = dispatched + icImport - demand;
    }

    // Solve DC power flow
    const { flows } = solveDCPF(links, injections, 'GZ18');

    // Record boundary flows (signed)
    for (const [name, b] of Object.entries(boundaryMapping.boundary_links)) {
      if (!b.crossing_links || b.crossing_links.length === 0) continue;
      let netFlow = 0;
      for (const linkId of b.crossing_links) {
        netFlow += flows[linkId] || 0;
      }
      if (!flowSamples[name]) flowSamples[name] = [];
      flowSamples[name].push(netFlow);
    }

    scenarioCount++;
  } catch (e) {
    errorCount++;
  }
}

console.log(`Completed: ${scenarioCount} scenarios, ${errorCount} errors\n`);

// --- Compute percentiles and compare ---
function percentile(arr, p) {
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

const validateBoundaries = ['B6F', 'B7aF', 'B9', 'SW1', 'B1aF', 'B2F', 'B3', 'B4F', 'B5', 'SC2'];

console.log('=== VALIDATION RESULTS ===');
console.log('Boundary | Our P25 | NESO P25 | P25 Err | Our P75 | NESO P75 | P75 Err | Status');
console.log('-'.repeat(95));

const results = [];

for (const name of validateBoundaries) {
  const samples = flowSamples[name];
  if (!samples || samples.length === 0) { console.log(`${name}: NO DATA`); continue; }

  const capData = etysCapabilities.boundaries?.[name]?.fes24?.[SCENARIO];
  const nesoP25 = capData?.['25pc']?.[String(YEAR)];
  const nesoP75 = capData?.['75pc']?.[String(YEAR)];
  if (nesoP25 === undefined || nesoP75 === undefined) { console.log(`${name}: NO NESO DATA`); continue; }

  const ourP25 = Math.round(percentile(samples, 25));
  const ourP75 = Math.round(percentile(samples, 75));

  const denomP25 = Math.max(Math.abs(nesoP25), 1);
  const denomP75 = Math.max(Math.abs(nesoP75), 1);
  const errP25 = Math.round((ourP25 - nesoP25) / denomP25 * 100);
  const errP75 = Math.round((ourP75 - nesoP75) / denomP75 * 100);

  let status;
  if (Math.abs(errP25) <= 30 && Math.abs(errP75) <= 30) status = 'GOOD';
  else if (Math.abs(errP25) <= 50 || Math.abs(errP75) <= 50) status = 'FAIR';
  else status = 'POOR';

  const row = { name, ourP25, nesoP25, errP25, ourP75, nesoP75, errP75, status };
  results.push(row);

  console.log(
    `${name.padEnd(6)} | ${String(ourP25).padStart(7)} | ${String(nesoP25).padStart(8)} | ${(errP25 >= 0 ? '+' : '') + errP25 + '%'}`.padEnd(52) +
    `| ${String(ourP75).padStart(7)} | ${String(nesoP75).padStart(8)} | ${(errP75 >= 0 ? '+' : '') + errP75 + '%'}`.padEnd(37) +
    `| ${status}`
  );
}

console.log('');
console.log('=== SUMMARY ===');
const good = results.filter(r => r.status === 'GOOD').length;
const fair = results.filter(r => r.status === 'FAIR').length;
const poor = results.filter(r => r.status === 'POOR').length;
console.log(`Good: ${good}/${results.length} | Fair: ${fair}/${results.length} | Poor: ${poor}/${results.length}`);

// Compare against independent grid results
console.log('\n=== COMPARISON: Independent Grid vs Correlated ERA5 ===');
const indepResults = {
  B6F:  { p25: 1042, p75: 5877 },
  B7aF: { p25: 1391, p75: 4601 },
  B9:   { p25: 1437, p75: 2190 },
  SW1:  { p25: 690,  p75: 3357 },
  B1aF: { p25: 3044, p75: 4706 },
  B2F:  { p25: 2899, p75: 4949 },
  B3:   { p25: -584, p75: -412 },
  B4F:  { p25: 889,  p75: 1767 },
  B5:   { p25: -2367,p75: -531 },
  SC2:  { p25: 319,  p75: 895  },
};

for (const r of results) {
  const ind = indepResults[r.name];
  if (!ind) continue;
  const p25Change = r.ourP25 - ind.p25;
  const p75Change = r.ourP75 - ind.p75;
  console.log(`${r.name.padEnd(6)} | P25: ${ind.p25} → ${r.ourP25} (${p25Change >= 0 ? '+' : ''}${p25Change}) | P75: ${ind.p75} → ${r.ourP75} (${p75Change >= 0 ? '+' : ''}${p75Change})`);
}

console.log('\n=== JSON ===');
console.log(JSON.stringify(results, null, 2));
