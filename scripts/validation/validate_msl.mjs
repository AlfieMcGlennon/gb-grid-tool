/**
 * Validate merit order WITH MSL constraints against NESO.
 * Compare against previous (no MSL) results.
 */
import { readFileSync } from 'fs';
import { solveDCPF } from '../src/engine/dcPowerFlow.js';
import { getLinksForYear } from '../src/engine/networkBuilder.js';
import { applyMeritOrder } from '../src/engine/meritOrder.js';
import { getInterpolatedPercentile } from '../src/utils/percentiles.js';

function loadJSON(p) { return JSON.parse(readFileSync(p, 'utf-8')); }

const zonesTNUoS = loadJSON('public/data/zones_tnuos.json');
const linksByYear = loadJSON('public/data/links_tnuos_by_year.json');
const boundaryMapping = loadJSON('public/data/boundary_link_mapping.json');
const etysCapabilities = loadJSON('public/data/etys_capabilities.json');
const plantsTNUoS = loadJSON('public/data/plants_tnuos.json');
const climatology = loadJSON('public/data/climatology.json');
const demandClimatology = loadJSON('public/data/demand_climatology.json');

const YEAR = 2024, SEASON = 'winter', SCENARIO = 'Holistic Transition';
const NUCLEAR_AVAIL = 0.80, IC_PCT = 65;

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
      if (pt === 'Interconnector') { genByType[pt] = mw * IC_PCT / 100; continue; }
      let gen = 0;
      if (pt.includes('Wind') && zc) gen = mw * getInterpolatedPercentile(zc.wind_cf?.[SEASON]?.percentiles || zc.wind_cf?.[SEASON] || {}, windPct);
      else if ((pt.includes('Solar') || pt.includes('PV')) && zc) {
        const sd = zc.solar_cf?.[SEASON];
        if (sd) gen = mw * getInterpolatedPercentile(sd.percentiles || sd || {}, 50) * (sd.daylight_fraction || 1);
      } else if (pt.includes('Nuclear')) gen = mw * NUCLEAR_AVAIL;
      else gen = mw;
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

function pctile(arr, p) {
  const s = [...arr].sort((a, b) => a - b);
  const i = (p / 100) * (s.length - 1);
  const lo = Math.floor(i), hi = Math.ceil(i);
  return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (i - lo);
}

// Run validation
console.log(`Running ${percentiles.length * percentiles.length} scenarios with MSL-enforced merit order...`);

const flowSamples = {};
let ok = 0;

for (const windPct of percentiles) {
  for (const demPct of percentiles) {
    try {
      const { zoneGen, zoneDemand } = buildGenDem(windPct, demPct);

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

      for (const [name, b] of Object.entries(boundaryMapping.boundary_links)) {
        if (!b.crossing_links?.length) continue;
        let net = 0;
        for (const lid of b.crossing_links) net += flows[lid] || 0;
        if (!flowSamples[name]) flowSamples[name] = [];
        flowSamples[name].push(net);
      }
      ok++;
    } catch (e) {}
  }
}

console.log(`Completed: ${ok} scenarios\n`);

// Previous results (without MSL) for comparison
const prevResults = {
  B6F:  { p25: 1042, e25: -12, p75: 5371, e75: -32 },
  B7aF: { p25: 1391, e25: -62, p75: 4304, e75: -61 },
  B9:   { p25: 1394, e25: -47, p75: 2087, e75: -78 },
  SW1:  { p25: 628,  e25: 288, p75: 2043, e75: 5 },
  B1aF: { p25: 2921, e25: 1222, p75: 4460, e75: 61 },
  B2F:  { p25: 2804, e25: 894, p75: 4498, e75: 28 },
  B3:   { p25: -534, e25: -553, p75: -381, e75: -217 },
  B4F:  { p25: 883,  e25: 14,  p75: 1621, e75: -69 },
  B5:   { p25: -1879,e25: -538, p75: -527, e75: -111 },
  SC2:  { p25: 328,  e25: 116, p75: 862,  e75: -71 },
};

const boundaries = ['B6F', 'B7aF', 'B9', 'SW1', 'B1aF', 'B2F', 'B3', 'B4F', 'B5', 'SC2'];

console.log('=== MERIT ORDER + MSL vs NESO ===');
console.log('Bound  | Our P25 | NESO P25 | P25err | Our P75 | NESO P75 | P75err | Status');
console.log('-'.repeat(85));

let good = 0, fair = 0, poor = 0;
const newResults = {};

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
  newResults[bn] = { p25: oP25, e25, p75: oP75, e75, status };
  console.log(bn.padEnd(6) + ' | ' + String(oP25).padStart(7) + ' | ' + String(nP25).padStart(8) + ' | ' +
    ((e25>=0?'+':'') + e25 + '%').padStart(7) + ' | ' + String(oP75).padStart(7) + ' | ' + String(nP75).padStart(8) + ' | ' +
    ((e75>=0?'+':'') + e75 + '%').padStart(7) + ' | ' + status);
}
console.log(`Summary: Good ${good} | Fair ${fair} | Poor ${poor}`);

// Comparison
console.log('\n=== IMPACT OF MSL ===');
console.log('Bound  | Old P75 err | New P75 err | Change | Old P25 err | New P25 err | Change');
console.log('-'.repeat(90));
for (const bn of boundaries) {
  const prev = prevResults[bn];
  const curr = newResults[bn];
  if (!prev || !curr) continue;
  const p75change = Math.abs(curr.e75) - Math.abs(prev.e75);
  const p25change = Math.abs(curr.e25) - Math.abs(prev.e25);
  const p75dir = p75change < 0 ? 'BETTER' : p75change > 0 ? 'WORSE' : 'SAME';
  const p25dir = p25change < 0 ? 'BETTER' : p25change > 0 ? 'WORSE' : 'SAME';
  console.log(
    bn.padEnd(6) + ' | ' +
    ((prev.e75>=0?'+':'') + prev.e75 + '%').padStart(11) + ' | ' +
    ((curr.e75>=0?'+':'') + curr.e75 + '%').padStart(11) + ' | ' +
    p75dir.padStart(6) + ' | ' +
    ((prev.e25>=0?'+':'') + prev.e25 + '%').padStart(11) + ' | ' +
    ((curr.e25>=0?'+':'') + curr.e25 + '%').padStart(11) + ' | ' +
    p25dir
  );
}
