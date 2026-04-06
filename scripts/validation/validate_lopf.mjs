/**
 * Validate LOPF dispatch against NESO boundary flows.
 * Compares merit order vs LOPF at 27-zone resolution.
 */
import { readFileSync } from 'fs';
import { createRequire } from 'module';
import { solveDCPF } from '../src/engine/dcPowerFlow.js';
import { getLinksForYear } from '../src/engine/networkBuilder.js';
import { applyMeritOrder } from '../src/engine/meritOrder.js';
import { solveLOPF } from '../src/engine/lopf.js';
import { getInterpolatedPercentile } from '../src/utils/percentiles.js';

const require = createRequire(import.meta.url);

function loadJSON(p) { return JSON.parse(readFileSync(p, 'utf-8')); }

const zonesTNUoS = loadJSON('public/data/zones_tnuos.json');
const linksByYear = loadJSON('public/data/links_tnuos_by_year.json');
const boundaryMapping = loadJSON('public/data/boundary_link_mapping.json');
const etysCapabilities = loadJSON('public/data/etys_capabilities.json');
const plantsTNUoS = loadJSON('public/data/plants_tnuos.json');
const climatology = loadJSON('public/data/climatology.json');
const demandClimatology = loadJSON('public/data/demand_climatology.json');
const marginalCosts = loadJSON('public/data/marginal_costs.json');

const YEAR = 2024, SEASON = 'winter', SCENARIO = 'Holistic Transition';
const NUCLEAR_AVAIL = 0.80, IC_PCT = 65;

// Zone capacities
const zoneCap = {};
for (const p of plantsTNUoS) {
  if (!p.zone_id || !p.plant_type || p.status !== 'Built' || p.mw_connected <= 0) continue;
  if (p.plant_type.includes('Demand') || p.plant_type.includes('Reactive') || p.plant_type.includes('Substation')) continue;
  if (!zoneCap[p.zone_id]) zoneCap[p.zone_id] = {};
  zoneCap[p.zone_id][p.plant_type] = (zoneCap[p.zone_id][p.plant_type] || 0) + p.mw_connected;
}
const zoneFB = {};
for (const [z, d] of Object.entries(zonesTNUoS)) zoneFB[z] = d.generation_by_type || {};
const demClimZones = demandClimatology.zones || {};
const climZones = climatology.tnuos_zones || {};
const links = getLinksForYear(linksByYear, YEAR);

// Build boundary limits for LOPF
const boundaryLimits = {};
for (const [name, b] of Object.entries(boundaryMapping.boundary_links)) {
  if (!b.crossing_links?.length) continue;
  // Get effective capability (max of shared group)
  let cap = 0;
  const capData = etysCapabilities.boundaries?.[name]?.fes24?.[SCENARIO];
  if (capData?.Capability?.[String(YEAR)]) {
    cap = capData.Capability[String(YEAR)];
  } else {
    cap = b.capability_2024_mw || 0;
  }
  if (b.shares_with?.length > 0) {
    for (const peer of b.shares_with) {
      const peerCap = etysCapabilities.boundaries?.[peer]?.fes24?.[SCENARIO]?.Capability?.[String(YEAR)] || 0;
      cap = Math.max(cap, peerCap);
    }
  }
  if (cap > 0) {
    boundaryLimits[name] = { crossing_links: b.crossing_links, capability_mw: cap };
  }
}

// Load HiGHS
console.log('Loading HiGHS WASM...');
let highs;
try {
  const highsModule = require('highs');
  highs = await highsModule({
    locateFile: (file) => require.resolve(`highs/build/${file}`)
  });
  console.log('HiGHS loaded successfully');
} catch (e) {
  console.error('Failed to load HiGHS:', e.message);
  console.log('Trying alternative import...');
  try {
    const Highs = (await import('highs')).default;
    highs = await Highs();
    console.log('HiGHS loaded via ESM');
  } catch (e2) {
    console.error('HiGHS unavailable:', e2.message);
    process.exit(1);
  }
}

const percentiles = [5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60, 65, 70, 75, 80, 85, 90, 95];

function buildGenDem(windPct, demPct) {
  const zoneGen = {}, zoneDemand = {};

  for (const [z, zdata] of Object.entries(zonesTNUoS)) {
    const genByType = {};
    const cap = zoneCap[z] || {};
    const fb = zoneFB[z] || {};
    const allTypes = new Set([...Object.keys(cap), ...Object.keys(fb)]);
    const zc = climZones[z];

    for (const pt of allTypes) {
      if (pt.includes('Demand') || pt.includes('Reactive') || pt.includes('Substation')) continue;
      let mw = cap[pt] || fb[pt]?.built_mw || 0;
      if (mw <= 0) continue;

      if (pt === 'Interconnector') {
        genByType[pt] = mw * IC_PCT / 100;
        continue;
      }

      let gen = 0;
      if (pt.includes('Wind') && zc) {
        gen = mw * getInterpolatedPercentile(zc.wind_cf?.[SEASON]?.percentiles || zc.wind_cf?.[SEASON] || {}, windPct);
      } else if ((pt.includes('Solar') || pt.includes('PV')) && zc) {
        const sd = zc.solar_cf?.[SEASON];
        if (sd) gen = mw * getInterpolatedPercentile(sd.percentiles || sd || {}, 50) * (sd.daylight_fraction || 1);
      } else if (pt.includes('Nuclear')) {
        gen = mw * NUCLEAR_AVAIL;
      } else {
        gen = mw;
      }
      genByType[pt] = gen;
    }
    zoneGen[z] = genByType;

    let baseDem = zdata.demand_mw_by_year?.[String(YEAR)] || 0;
    const zdc = demClimZones[z];
    if (zdc?.seasonal?.[SEASON]?.percentiles && zdc.seasonal[SEASON]?.mean) {
      const sp = getInterpolatedPercentile(zdc.seasonal[SEASON].percentiles, demPct);
      const sm = zdc.seasonal[SEASON].mean;
      if (sm > 0) baseDem = baseDem * (sp / sm);
    }
    zoneDemand[z] = baseDem;
  }
  return { zoneGen, zoneDemand };
}

function boundaryFlows(flows) {
  const r = {};
  for (const [name, b] of Object.entries(boundaryMapping.boundary_links)) {
    if (!b.crossing_links?.length) continue;
    r[name] = b.crossing_links.reduce((s, lid) => s + (flows[lid] || 0), 0);
  }
  return r;
}

function pctile(arr, p) {
  const s = [...arr].sort((a, b) => a - b);
  const i = (p / 100) * (s.length - 1);
  const lo = Math.floor(i), hi = Math.ceil(i);
  return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (i - lo);
}

// Run LOPF validation
console.log(`\nRunning ${percentiles.length * percentiles.length} scenarios...`);

const flowsLOPF = {};
const flowsMerit = {};
let lopfOk = 0, meritOk = 0, lopfFail = 0;

for (const windPct of percentiles) {
  for (const demPct of percentiles) {
    const { zoneGen, zoneDemand } = buildGenDem(windPct, demPct);

    // LOPF dispatch
    try {
      const lopfResult = solveLOPF({
        zoneGenerationByType: zoneGen,
        zoneDemand,
        links,
        marginalCosts,
        fuelToggles: {},
        boundaryLimits,
        slackZone: 'GZ18',
        highs
      });

      if (lopfResult.status === 'Optimal') {
        const bf = boundaryFlows(lopfResult.flows);
        for (const [name, flow] of Object.entries(bf)) {
          if (!flowsLOPF[name]) flowsLOPF[name] = [];
          flowsLOPF[name].push(flow);
        }
        lopfOk++;
      } else {
        lopfFail++;
      }
    } catch (e) {
      lopfFail++;
    }

    // Merit order dispatch (for comparison)
    try {
      let wCF = 0, wCap = 0;
      for (const [z, types] of Object.entries(zoneCap)) {
        for (const [pt, mw] of Object.entries(types)) {
          if (pt.includes('Wind')) {
            wCF += getInterpolatedPercentile(climZones[z]?.wind_cf?.[SEASON]?.percentiles || {}, windPct) * mw;
            wCap += mw;
          }
        }
      }
      const natWCF = wCap > 0 ? wCF / wCap : 0.25;
      const merit = applyMeritOrder(zoneGen, zoneDemand, {}, natWCF);

      const inj = {};
      for (const z of Object.keys(zonesTNUoS)) {
        const disp = Object.values(merit.adjustedGeneration[z] || {}).reduce((s, v) => s + v, 0);
        inj[z] = disp + (zoneGen[z]?.['Interconnector'] || 0) - (zoneDemand[z] || 0);
      }
      const { flows } = solveDCPF(links, inj, 'GZ18');
      const bf = boundaryFlows(flows);
      for (const [name, flow] of Object.entries(bf)) {
        if (!flowsMerit[name]) flowsMerit[name] = [];
        flowsMerit[name].push(flow);
      }
      meritOk++;
    } catch (e) {}
  }
}

console.log(`LOPF: ${lopfOk} ok, ${lopfFail} failed`);
console.log(`Merit: ${meritOk} ok`);

// Results
const boundaries = ['B6F', 'B7aF', 'B9', 'SW1', 'B1aF', 'B2F', 'B3', 'B4F', 'B5', 'SC2'];

function printResults(name, flowSamples) {
  console.log(`\n=== ${name} ===`);
  console.log('Bound  | Our P25 | NESO P25 | P25err | Our P75 | NESO P75 | P75err | Status');
  console.log('-'.repeat(85));
  let good = 0, fair = 0, poor = 0;
  for (const bn of boundaries) {
    const samples = flowSamples[bn];
    if (!samples?.length) continue;
    const cap = etysCapabilities.boundaries?.[bn]?.fes24?.[SCENARIO];
    const nP25 = cap?.['25pc']?.[String(YEAR)];
    const nP75 = cap?.['75pc']?.[String(YEAR)];
    if (nP25 == null || nP75 == null) continue;
    const oP25 = Math.round(pctile(samples, 25));
    const oP75 = Math.round(pctile(samples, 75));
    const e25 = Math.round((oP25 - nP25) / Math.max(Math.abs(nP25), 1) * 100);
    const e75 = Math.round((oP75 - nP75) / Math.max(Math.abs(nP75), 1) * 100);
    let status;
    if (Math.abs(e25) <= 30 && Math.abs(e75) <= 30) { status = 'GOOD'; good++; }
    else if (Math.abs(e25) <= 50 || Math.abs(e75) <= 50) { status = 'FAIR'; fair++; }
    else { status = 'POOR'; poor++; }
    console.log(bn.padEnd(6) + ' | ' + String(oP25).padStart(7) + ' | ' + String(nP25).padStart(8) + ' | ' +
      ((e25>=0?'+':'') + e25 + '%').padStart(7) + ' | ' + String(oP75).padStart(7) + ' | ' + String(nP75).padStart(8) + ' | ' +
      ((e75>=0?'+':'') + e75 + '%').padStart(7) + ' | ' + status);
  }
  console.log(`Summary: Good ${good} | Fair ${fair} | Poor ${poor}`);
}

printResults('LOPF (network-constrained dispatch)', flowsLOPF);
printResults('Merit Order (unconstrained dispatch)', flowsMerit);

// Side-by-side
console.log('\n=== P75 COMPARISON ===');
console.log('Bound  | Merit p75 err | LOPF p75 err | Winner');
console.log('-'.repeat(55));
for (const bn of boundaries) {
  const mSamples = flowsMerit[bn] || [];
  const lSamples = flowsLOPF[bn] || [];
  if (!mSamples.length || !lSamples.length) continue;
  const cap = etysCapabilities.boundaries?.[bn]?.fes24?.[SCENARIO];
  const nP75 = cap?.['75pc']?.[String(YEAR)];
  if (!nP75) continue;
  const mP75 = Math.round(pctile(mSamples, 75));
  const lP75 = Math.round(pctile(lSamples, 75));
  const mErr = Math.round((mP75 - nP75) / Math.max(Math.abs(nP75), 1) * 100);
  const lErr = Math.round((lP75 - nP75) / Math.max(Math.abs(nP75), 1) * 100);
  const winner = Math.abs(lErr) < Math.abs(mErr) ? 'LOPF' : Math.abs(mErr) < Math.abs(lErr) ? 'Merit' : 'Tie';
  console.log(bn.padEnd(6) + ' | ' + ((mErr>=0?'+':'') + mErr + '%').padStart(13) + ' | ' + ((lErr>=0?'+':'') + lErr + '%').padStart(12) + ' | ' + winner);
}
