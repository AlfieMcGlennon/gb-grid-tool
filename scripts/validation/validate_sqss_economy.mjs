#!/usr/bin/env node
/**
 * SQSS Economy Planned Transfer Validation
 *
 * Replicates NESO's SQSS Appendix E methodology:
 * - Nuclear/CCS: DT = 0.85 of registered capacity
 * - Wind/wave/tidal: DT = 0.70 of registered capacity
 * - Pumped storage: DT = 0.50 of registered capacity
 * - Interconnectors importing: DT = 1.0
 * - OCGTs: non-contributory (excluded)
 * - All remaining plant: scaled uniformly so total = ACS peak demand
 *
 * This is a DETERMINISTIC calculation — no percentile sampling.
 * Should closely match NESO's Economy Required Transfer values.
 */

import { readFileSync } from 'fs';
import { solveDCPF } from '../src/engine/dcPowerFlow.js';
import { getLinksForYear } from '../src/engine/networkBuilder.js';

function loadJSON(p) { return JSON.parse(readFileSync(p, 'utf-8')); }

const zonesTNUoS = loadJSON('public/data/zones_tnuos.json');
const linksByYear = loadJSON('public/data/links_tnuos_by_year.json');
const boundaryMapping = loadJSON('public/data/boundary_link_mapping.json');
const etysCapabilities = loadJSON('public/data/etys_capabilities.json');
const plantsTNUoS = loadJSON('public/data/plants_tnuos.json');

const YEAR = 2024;
const SCENARIO = 'Holistic Transition';

// SQSS Economy scaling factors (Appendix E)
const SQSS_DT = {
  nuclear: 0.85,
  wind: 0.70,
  pumped_storage: 0.50,
  interconnector: 1.0,
  // OCGTs: excluded (non-contributory)
  // All other: variably scaled to balance demand
};

// ACS peak demand for 2024 (from zones_tnuos total)
let totalRegisteredCapacity = 0;
let directlyScaledOutput = 0;

// Classify and scale generation per zone
const zoneGenByType = {};
const zoneDemand = {};

// First pass: compute directly scaled output and classify all plant
const zoneDirectlyScaled = {};
const zoneVariablyScaled = {}; // registered capacity of variable plants per zone
let totalVariableCapacity = 0;

// Get zone capacities from built plants
const zoneCap = {};
for (const p of plantsTNUoS) {
  if (!p.zone_id || !p.plant_type || p.status !== 'Built' || p.mw_connected <= 0) continue;
  if (p.plant_type.includes('Demand') || p.plant_type.includes('Reactive') || p.plant_type.includes('Substation')) continue;
  if (!zoneCap[p.zone_id]) zoneCap[p.zone_id] = {};
  zoneCap[p.zone_id][p.plant_type] = (zoneCap[p.zone_id][p.plant_type] || 0) + p.mw_connected;
}

// Also use zone fallback for types not in plant data
const zoneFB = {};
for (const [z, d] of Object.entries(zonesTNUoS)) {
  zoneFB[z] = d.generation_by_type || {};
}

for (const [zoneId, zdata] of Object.entries(zonesTNUoS)) {
  const cap = zoneCap[zoneId] || {};
  const fb = zoneFB[zoneId] || {};
  const allTypes = new Set([...Object.keys(cap), ...Object.keys(fb)]);

  zoneDirectlyScaled[zoneId] = 0;
  zoneVariablyScaled[zoneId] = 0;
  zoneGenByType[zoneId] = {};

  for (const pt of allTypes) {
    if (pt.includes('Demand') || pt.includes('Reactive') || pt.includes('Substation')) continue;
    let mw = cap[pt] || fb[pt]?.built_mw || 0;
    if (mw <= 0) continue;

    // Classify per SQSS Appendix E
    if (pt.includes('OCGT') || pt.includes('Open Cycle')) {
      // E.1.1: Non-contributory — excluded entirely
      zoneGenByType[zoneId][pt] = 0;
      continue;
    }

    if (pt.includes('Nuclear')) {
      // E.3.1: DT = 0.85
      const output = mw * SQSS_DT.nuclear;
      zoneGenByType[zoneId][pt] = output;
      zoneDirectlyScaled[zoneId] += output;
      directlyScaledOutput += output;
    } else if (pt.includes('Wind') || pt.includes('Wave') || pt.includes('Tidal')) {
      // E.3.2: DT = 0.70
      const output = mw * SQSS_DT.wind;
      zoneGenByType[zoneId][pt] = output;
      zoneDirectlyScaled[zoneId] += output;
      directlyScaledOutput += output;
    } else if (pt.includes('Pump Storage') || pt.includes('Pumped')) {
      // E.3.3: DT = 0.50
      const output = mw * SQSS_DT.pumped_storage;
      zoneGenByType[zoneId][pt] = output;
      zoneDirectlyScaled[zoneId] += output;
      directlyScaledOutput += output;
    } else if (pt === 'Interconnector') {
      // E.3.4: DT = 1.0 (importing)
      const output = mw * SQSS_DT.interconnector;
      zoneGenByType[zoneId][pt] = output;
      zoneDirectlyScaled[zoneId] += output;
      directlyScaledOutput += output;
    } else {
      // E.1.3/E.5: Variably scaled — will be scaled later
      zoneVariablyScaled[zoneId] += mw;
      totalVariableCapacity += mw;
      totalRegisteredCapacity += mw;
      // Store raw capacity, will apply scaling factor below
      zoneGenByType[zoneId][pt] = mw; // placeholder — will be multiplied by S
    }
  }

  // Demand from zones_tnuos for this year
  const d = zdata.demand_mw_by_year?.[String(YEAR)] || 0;
  zoneDemand[zoneId] = d;
}

// ACS peak demand = total zone demand
const acsPeakDemand = Object.values(zoneDemand).reduce((s, v) => s + v, 0);

// E.5: Variable scaling factor S
// Total variable output = ACS peak demand - directly scaled output
const requiredVariableOutput = acsPeakDemand - directlyScaledOutput;
const S = totalVariableCapacity > 0 ? requiredVariableOutput / totalVariableCapacity : 0;

console.log('=== SQSS Economy Planned Transfer ===');
console.log(`Year: ${YEAR}`);
console.log(`ACS Peak Demand: ${acsPeakDemand.toFixed(0)} MW`);
console.log(`Directly Scaled Output: ${directlyScaledOutput.toFixed(0)} MW`);
console.log(`  Nuclear (DT=0.85): ${Object.values(zoneGenByType).reduce((s, z) => s + Object.entries(z).filter(([k]) => k.includes('Nuclear')).reduce((ss, [, v]) => ss + v, 0), 0).toFixed(0)} MW`);
console.log(`  Wind (DT=0.70): ${Object.values(zoneGenByType).reduce((s, z) => s + Object.entries(z).filter(([k]) => k.includes('Wind')).reduce((ss, [, v]) => ss + v, 0), 0).toFixed(0)} MW`);
console.log(`  Pumped Storage (DT=0.50): ${Object.values(zoneGenByType).reduce((s, z) => s + Object.entries(z).filter(([k]) => k.includes('Pump')).reduce((ss, [, v]) => ss + v, 0), 0).toFixed(0)} MW`);
console.log(`  Interconnectors (DT=1.0): ${Object.values(zoneGenByType).reduce((s, z) => s + Object.entries(z).filter(([k]) => k === 'Interconnector').reduce((ss, [, v]) => ss + v, 0), 0).toFixed(0)} MW`);
console.log(`Required Variable Output: ${requiredVariableOutput.toFixed(0)} MW`);
console.log(`Total Variable Capacity: ${totalVariableCapacity.toFixed(0)} MW`);
console.log(`Variable Scaling Factor (S): ${S.toFixed(4)}`);
console.log('');

// Apply variable scaling factor
for (const [zoneId, genByType] of Object.entries(zoneGenByType)) {
  for (const [pt, mw] of Object.entries(genByType)) {
    // Check if this is a variably-scaled type (not directly scaled, not excluded)
    if (pt.includes('Nuclear') || pt.includes('Wind') || pt.includes('Wave') || pt.includes('Tidal') ||
        pt.includes('Pump') || pt === 'Interconnector' ||
        pt.includes('OCGT') || pt.includes('Open Cycle')) {
      continue; // Already scaled or excluded
    }
    // Apply S to variable plant
    zoneGenByType[zoneId][pt] = mw * S;
  }
}

// Build injections
const injections = {};
let totalGen = 0;
for (const zoneId of Object.keys(zonesTNUoS)) {
  const gen = Object.values(zoneGenByType[zoneId] || {}).reduce((s, v) => s + v, 0);
  const dem = zoneDemand[zoneId] || 0;
  injections[zoneId] = gen - dem;
  totalGen += gen;
}

console.log(`Total Generation: ${totalGen.toFixed(0)} MW`);
console.log(`Total Demand: ${acsPeakDemand.toFixed(0)} MW`);
console.log(`Balance: ${(totalGen - acsPeakDemand).toFixed(0)} MW`);
console.log('');

// Solve DC power flow
const links = getLinksForYear(linksByYear, YEAR);
const { flows } = solveDCPF(links, injections, 'GZ18');

// Compute boundary flows (same as tool)
function computeBoundaryFlows(flows) {
  const result = {};
  // Build effective capabilities (max of shared group)
  const rawCaps = {};
  for (const [name, b] of Object.entries(boundaryMapping.boundary_links)) {
    const capData = etysCapabilities.boundaries?.[name]?.fes24?.[SCENARIO];
    rawCaps[name] = capData?.Capability?.[String(YEAR)] || b.capability_2024_mw || 0;
  }
  const effCaps = { ...rawCaps };
  for (const [name, b] of Object.entries(boundaryMapping.boundary_links)) {
    if (b.shares_with?.length > 0) {
      const group = [rawCaps[name], ...b.shares_with.map(p => rawCaps[p] || 0)];
      effCaps[name] = Math.max(...group);
    }
  }

  for (const [name, b] of Object.entries(boundaryMapping.boundary_links)) {
    if (!b.crossing_links?.length) continue;
    let netFlow = 0;
    for (const lid of b.crossing_links) netFlow += flows[lid] || 0;
    const cap = effCaps[name];
    result[name] = {
      flow: netFlow,
      abs_flow: Math.abs(netFlow),
      capability: cap,
      utilisation: cap > 0 ? (Math.abs(netFlow) / cap * 100) : 0
    };
  }
  return result;
}

const bf = computeBoundaryFlows(flows);

// Compare against NESO Economy RT
const validateBoundaries = ['B6F', 'B7aF', 'B9', 'SW1', 'B1aF', 'B2F', 'B3', 'B4F', 'B5', 'SC2'];

console.log('=== SQSS Economy RT vs NESO Economy RT ===');
console.log('Bound  | Our Flow | NESO Econ RT | Error  | Capability | Util%  | Status');
console.log('-'.repeat(85));

let good = 0, fair = 0, poor = 0;

for (const name of validateBoundaries) {
  const b = bf[name];
  if (!b) { console.log(`${name}: NO DATA`); continue; }

  const capData = etysCapabilities.boundaries?.[name]?.fes24?.[SCENARIO];
  const econRT = capData?.['Economy RT']?.[String(YEAR)];
  const p25 = capData?.['25pc']?.[String(YEAR)];
  const p75 = capData?.['75pc']?.[String(YEAR)];

  // Compare our flow against Economy RT
  const ourFlow = Math.round(b.flow);
  let err = '—';
  let status = '—';

  if (econRT !== undefined && econRT !== null) {
    const errPct = Math.round((ourFlow - econRT) / Math.max(Math.abs(econRT), 1) * 100);
    err = (errPct >= 0 ? '+' : '') + errPct + '%';
    if (Math.abs(errPct) <= 30) { status = 'GOOD'; good++; }
    else if (Math.abs(errPct) <= 50) { status = 'FAIR'; fair++; }
    else { status = 'POOR'; poor++; }
  }

  console.log(
    name.padEnd(6) + ' | ' +
    String(ourFlow).padStart(8) + ' | ' +
    String(econRT ?? '—').padStart(12) + ' | ' +
    String(err).padStart(6) + ' | ' +
    String(Math.round(b.capability)).padStart(10) + ' | ' +
    (b.utilisation.toFixed(1) + '%').padStart(6) + ' | ' +
    status
  );
}

console.log(`\nSummary: Good ${good} | Fair ${fair} | Poor ${poor}`);

// Also show comparison against p25/p75
console.log('\n=== For reference: SQSS Economy flow vs NESO p25/p75 range ===');
console.log('Bound  | Our Flow | NESO p25 | NESO p75 | In range?');
console.log('-'.repeat(60));

for (const name of validateBoundaries) {
  const b = bf[name];
  if (!b) continue;
  const capData = etysCapabilities.boundaries?.[name]?.fes24?.[SCENARIO];
  const p25 = capData?.['25pc']?.[String(YEAR)];
  const p75 = capData?.['75pc']?.[String(YEAR)];
  if (p25 === undefined || p75 === undefined) continue;

  const ourFlow = Math.round(b.flow);
  const inRange = ourFlow >= Math.min(p25, p75) && ourFlow <= Math.max(p25, p75);
  const nearRange = ourFlow >= Math.min(p25, p75) * 0.7 && ourFlow <= Math.max(p25, p75) * 1.3;

  console.log(
    name.padEnd(6) + ' | ' +
    String(ourFlow).padStart(8) + ' | ' +
    String(p25).padStart(8) + ' | ' +
    String(p75).padStart(8) + ' | ' +
    (inRange ? 'YES' : nearRange ? 'NEAR' : 'NO')
  );
}
