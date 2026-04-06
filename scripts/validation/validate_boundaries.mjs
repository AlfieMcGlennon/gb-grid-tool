#!/usr/bin/env node
/**
 * Boundary Flow Validation Script
 *
 * Runs the tool's own engine across a grid of wind/demand percentiles,
 * collects boundary flows, computes our p25/p75, and compares against
 * NESO's published expected transfers from ETYS 2024.
 *
 * Usage: node scripts/validate_boundaries.mjs
 */

import { readFileSync } from 'fs';
import { solveDCPF } from '../src/engine/dcPowerFlow.js';
import { getLinksForYear } from '../src/engine/networkBuilder.js';
import { applyMeritOrder } from '../src/engine/meritOrder.js';
import { getInterpolatedPercentile } from '../src/utils/percentiles.js';

// --- Load data ---
function loadJSON(path) {
  return JSON.parse(readFileSync(path, 'utf-8'));
}

const zonesTNUoS = loadJSON('public/data/zones_tnuos.json');
const linksByYear = loadJSON('public/data/links_tnuos_by_year.json');
const boundaryMapping = loadJSON('public/data/boundary_link_mapping.json');
const etysCapabilities = loadJSON('public/data/etys_capabilities.json');
const climatology = loadJSON('public/data/climatology.json');
const demandClimatology = loadJSON('public/data/demand_climatology.json');
const plantsTNUoS = loadJSON('public/data/plants_tnuos.json');

const NUCLEAR_AVAILABILITY = 0.80;
const YEAR = 2024;
const SEASON = 'winter';
const SCENARIO = 'Holistic Transition';
const INTERCONNECTOR_IMPORT = 65; // %

// --- Simplified generation builder (mirrors scenarioRunner logic) ---
function buildGeneration(windPct, solarPct, demandPct) {
  const zoneGen = {};
  const zoneDemand = {};
  const climZones = climatology.tnuos_zones || {};
  const demClimZones = demandClimatology.zones || {};

  // Aggregate built plant capacity by zone and type
  const zoneCapacity = {};
  for (const plant of plantsTNUoS) {
    if (!plant.zone_id || !plant.plant_type) continue;
    if (plant.status !== 'Built' || plant.mw_connected <= 0) continue;
    if (plant.plant_type.includes('Demand') || plant.plant_type.includes('Reactive') || plant.plant_type.includes('Substation')) continue;

    if (!zoneCapacity[plant.zone_id]) zoneCapacity[plant.zone_id] = {};
    zoneCapacity[plant.zone_id][plant.plant_type] =
      (zoneCapacity[plant.zone_id][plant.plant_type] || 0) + plant.mw_connected;
  }

  for (const [zoneId, zoneData] of Object.entries(zonesTNUoS)) {
    const genByType = {};
    const capacity = zoneCapacity[zoneId] || {};
    const fallback = zoneData.generation_by_type || {};
    const zoneClimate = climZones[zoneId];

    // Merge plant capacity with zone fallback
    const allTypes = new Set([...Object.keys(capacity), ...Object.keys(fallback)]);

    for (const plantType of allTypes) {
      if (plantType.includes('Demand') || plantType.includes('Reactive') || plantType.includes('Substation')) continue;

      let cap = capacity[plantType] || fallback[plantType]?.built_mw || 0;
      if (cap <= 0) continue;

      // Interconnectors
      if (plantType === 'Interconnector') {
        genByType[plantType] = cap * (INTERCONNECTOR_IMPORT / 100);
        continue;
      }

      // Apply weather capacity factors
      let gen = 0;
      if (plantType.includes('Wind') && zoneClimate) {
        const cf = getInterpolatedPercentile(
          zoneClimate.wind_cf?.[SEASON]?.percentiles || zoneClimate.wind_cf?.[SEASON] || {},
          windPct
        );
        gen = cap * cf;
      } else if ((plantType.includes('Solar') || plantType.includes('PV')) && zoneClimate) {
        const solarData = zoneClimate.solar_cf?.[SEASON];
        if (solarData) {
          const cf = getInterpolatedPercentile(solarData.percentiles || solarData || {}, solarPct);
          gen = cap * cf * (solarData.daylight_fraction || 1.0);
        }
      } else if (plantType.includes('Nuclear')) {
        gen = cap * NUCLEAR_AVAILABILITY;
      } else {
        gen = cap;
      }

      genByType[plantType] = gen;
    }

    zoneGen[zoneId] = genByType;

    // Demand: year-scaled baseline * seasonal deviation ratio
    const demandByYear = zoneData.demand_mw_by_year || {};
    let baseDemand = demandByYear[String(YEAR)] || 0;
    const zdc = demClimZones[zoneId];
    if (zdc?.seasonal?.[SEASON]?.percentiles && zdc.seasonal[SEASON]?.mean) {
      const seasonalPct = getInterpolatedPercentile(zdc.seasonal[SEASON].percentiles, demandPct);
      const seasonalMean = zdc.seasonal[SEASON].mean;
      if (seasonalMean > 0) {
        baseDemand = baseDemand * (seasonalPct / seasonalMean);
      }
    }
    zoneDemand[zoneId] = baseDemand;
  }

  return { zoneGen, zoneDemand };
}

// --- Compute wind CF for merit order ---
function getNationalWindCF(windPct) {
  const climZones = climatology.tnuos_zones || {};
  let weightedCF = 0, totalWeight = 0;
  for (const [zoneId, zc] of Object.entries(climZones)) {
    const data = zc.wind_cf?.[SEASON];
    if (!data) continue;
    const cf = getInterpolatedPercentile(data.percentiles || data || {}, windPct);
    // Weight by zone built wind capacity
    let windCap = 0;
    for (const plant of plantsTNUoS) {
      if (plant.zone_id === zoneId && plant.status === 'Built' && plant.mw_connected > 0 && plant.plant_type?.includes('Wind')) {
        windCap += plant.mw_connected;
      }
    }
    if (windCap > 0) {
      weightedCF += cf * windCap;
      totalWeight += windCap;
    }
  }
  return totalWeight > 0 ? weightedCF / totalWeight : 0.05 + (windPct / 100) * 0.6;
}

// --- Compute boundary flows from DCPF result ---
function computeBoundaryFlows(flows) {
  const result = {};
  if (!boundaryMapping?.boundary_links) return result;

  // Build effective capabilities (max of shared group)
  const rawCaps = {};
  for (const [name, b] of Object.entries(boundaryMapping.boundary_links)) {
    const capData = etysCapabilities.boundaries?.[name]?.fes24?.[SCENARIO];
    rawCaps[name] = capData?.Capability?.[String(YEAR)] || b.capability_2024_mw || 0;
  }
  const effectiveCaps = { ...rawCaps };
  for (const [name, b] of Object.entries(boundaryMapping.boundary_links)) {
    if (b.shares_with?.length > 0) {
      const group = [rawCaps[name], ...b.shares_with.map(p => rawCaps[p] || 0)];
      effectiveCaps[name] = Math.max(...group);
    }
  }

  for (const [name, b] of Object.entries(boundaryMapping.boundary_links)) {
    if (!b.crossing_links || b.crossing_links.length === 0) continue;

    // Net directional flow (not absolute) to capture direction
    let netFlow = 0;
    for (const linkId of b.crossing_links) {
      netFlow += flows[linkId] || 0;
    }

    result[name] = {
      net_flow: netFlow,
      abs_flow: Math.abs(netFlow),
      capability: effectiveCaps[name]
    };
  }
  return result;
}

// --- Main validation ---
console.log('=== GB Grid Tool Boundary Flow Validation ===');
console.log(`Year: ${YEAR} | Season: ${SEASON} | Scenario: ${SCENARIO}`);
console.log(`Interconnector import: ${INTERCONNECTOR_IMPORT}%`);
console.log('');

const links = getLinksForYear(linksByYear, YEAR);

// Sample grid: wind p5-p95 step 5, demand p5-p95 step 5 = 19x19 = 361 scenarios
const percentiles = [5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60, 65, 70, 75, 80, 85, 90, 95];
const solarPct = 50; // Fix solar at median (winter solar is negligible)

const flowSamples = {}; // { boundaryId: [flow1, flow2, ...] }
let scenarioCount = 0;
let errorCount = 0;

console.log(`Running ${percentiles.length * percentiles.length} scenarios (${percentiles.length} wind × ${percentiles.length} demand)...`);

for (const windPct of percentiles) {
  for (const demandPct of percentiles) {
    try {
      const { zoneGen, zoneDemand } = buildGeneration(windPct, solarPct, demandPct);

      // Apply merit order dispatch
      const windCF = getNationalWindCF(windPct);
      const meritResult = applyMeritOrder(zoneGen, zoneDemand, {}, windCF);

      // Build injections: dispatched generation + interconnectors - demand
      const injections = {};
      for (const zoneId of Object.keys(zonesTNUoS)) {
        const dispatched = Object.values(meritResult.adjustedGeneration[zoneId] || {}).reduce((s, v) => s + v, 0);
        // Add interconnectors
        const icGen = zoneGen[zoneId]?.['Interconnector'] || 0;
        const demand = zoneDemand[zoneId] || 0;
        injections[zoneId] = dispatched + icGen - demand;
      }

      // Solve DC power flow
      const { flows } = solveDCPF(links, injections, 'GZ18');

      // Record boundary flows
      const bf = computeBoundaryFlows(flows);
      for (const [name, data] of Object.entries(bf)) {
        if (!flowSamples[name]) flowSamples[name] = [];
        flowSamples[name].push(data.net_flow);
      }

      scenarioCount++;
    } catch (e) {
      errorCount++;
    }
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

// Boundaries to validate (independent ones with NESO data)
const validateBoundaries = ['B6F', 'B7aF', 'B9', 'SW1', 'B1aF', 'B2F', 'B3', 'B4F', 'B5', 'SC2'];

console.log('=== VALIDATION RESULTS ===');
console.log('Boundary | Our P25 | NESO P25 | P25 Err | Our P75 | NESO P75 | P75 Err | Status');
console.log('-'.repeat(90));

const validationResults = [];

for (const name of validateBoundaries) {
  const samples = flowSamples[name];
  if (!samples || samples.length === 0) {
    console.log(`${name}: NO DATA`);
    continue;
  }

  const capData = etysCapabilities.boundaries?.[name]?.fes24?.[SCENARIO];
  const nesoP25 = capData?.['25pc']?.[String(YEAR)];
  const nesoP75 = capData?.['75pc']?.[String(YEAR)];

  if (nesoP25 === undefined || nesoP75 === undefined) {
    console.log(`${name}: NO NESO DATA`);
    continue;
  }

  // NESO values are SIGNED (negative = reverse flow direction)
  // Compare using signed flows to capture bidirectional boundaries correctly
  const ourP25 = Math.round(percentile(samples, 25));
  const ourP75 = Math.round(percentile(samples, 75));

  // Error calculation: use absolute NESO value as denominator to avoid division issues
  const denomP25 = Math.max(Math.abs(nesoP25), 1);
  const denomP75 = Math.max(Math.abs(nesoP75), 1);
  const errP25 = Math.round((ourP25 - nesoP25) / denomP25 * 100);
  const errP75 = Math.round((ourP75 - nesoP75) / denomP75 * 100);

  let status;
  if (Math.abs(errP25) <= 30 && Math.abs(errP75) <= 30) {
    status = 'GOOD';
  } else if (Math.abs(errP25) <= 50 || Math.abs(errP75) <= 50) {
    status = 'FAIR';
  } else {
    status = 'POOR';
  }

  const row = {
    name,
    ourP25,
    nesoP25,
    errP25,
    ourP75,
    nesoP75,
    errP75,
    status,
    sampleCount: samples.length,
    min: Math.round(Math.min(...samples)),
    max: Math.round(Math.max(...samples))
  };
  validationResults.push(row);

  console.log(
    `${name.padEnd(6)} | ${String(ourP25).padStart(7)} | ${String(row.nesoP25).padStart(8)} | ${(errP25 >= 0 ? '+' : '') + errP25 + '%'}`.padEnd(50) +
    ` | ${String(ourP75).padStart(7)} | ${String(row.nesoP75).padStart(8)} | ${(errP75 >= 0 ? '+' : '') + errP75 + '%'}`.padEnd(35) +
    ` | ${status}`
  );
}

console.log('');
console.log('=== SUMMARY ===');
const good = validationResults.filter(r => r.status === 'GOOD').length;
const fair = validationResults.filter(r => r.status === 'FAIR').length;
const poor = validationResults.filter(r => r.status === 'POOR').length;
console.log(`Good: ${good}/${validationResults.length} | Fair: ${fair}/${validationResults.length} | Poor: ${poor}/${validationResults.length}`);

// Output as JSON for DataSourcesPage update
console.log('\n=== JSON FOR DATASOURCESPAGE ===');
console.log(JSON.stringify(validationResults, null, 2));
