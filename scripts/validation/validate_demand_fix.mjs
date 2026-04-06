/**
 * Validate with corrected demand baseline.
 * Previous: demand = ACS_peak × (seasonal_pct / seasonal_mean) → 34% too high
 * Fixed: demand = seasonal_pct directly (absolute MW from historic TSD)
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

// First verify demand levels
console.log('=== DEMAND VERIFICATION ===');
for (const dp of [25, 50, 75, 95]) {
  let total = 0;
  for (const [z, zdata] of Object.entries(zonesTNUoS)) {
    const zdc = demClimZones[z];
    if (zdc?.seasonal?.winter?.percentiles) {
      total += getInterpolatedPercentile(zdc.seasonal.winter.percentiles, dp);
    }
  }
  console.log('  Demand p' + dp + ': ' + total.toFixed(0) + ' MW');
}
console.log('  (Real NESO TSD: p25=29805, p50=35578, p75=41582, p95=49042)\n');

// Run validation
const flowSamples = {};
let ok = 0;

for (const windPct of percentiles) {
  for (const demPct of percentiles) {
    try {
      const zoneGen = {}, zoneDemand = {}, icByZone = {};

      // FIXED demand: use seasonal percentile directly
      for (const [z, zdata] of Object.entries(zonesTNUoS)) {
        const zdc = demClimZones[z];
        if (zdc?.seasonal?.winter?.percentiles) {
          zoneDemand[z] = getInterpolatedPercentile(zdc.seasonal.winter.percentiles, demPct);
        } else {
          zoneDemand[z] = zdata.demand_mw_by_year?.['2024'] || 0;
        }
      }

      // Generation (same as before)
      for (const [z] of Object.entries(zonesTNUoS)) {
        const genByType = {};
        const cap = zoneCap[z] || {};
        const fb = zoneFB[z] || {};
        const allTypes = new Set([...Object.keys(cap), ...Object.keys(fb)]);
        const zc = climZones[z];
        for (const pt of allTypes) {
          if (pt.includes('Demand') || pt.includes('Reactive') || pt.includes('Substation')) continue;
          let mw = cap[pt] || fb[pt]?.built_mw || 0;
          if (mw <= 0) continue;
          if (pt === 'Interconnector') { icByZone[z] = (icByZone[z] || 0) + mw * IC_PCT / 100; continue; }
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
      }

      let wCF = 0, wCap = 0;
      for (const [z, types] of Object.entries(zoneCap))
        for (const [pt, mw] of Object.entries(types))
          if (pt.includes('Wind')) { wCF += getInterpolatedPercentile(climZones[z]?.wind_cf?.[SEASON]?.percentiles || {}, windPct) * mw; wCap += mw; }

      const merit = applyMeritOrder(zoneGen, zoneDemand, {}, wCap > 0 ? wCF / wCap : 0.25);

      const inj = {};
      for (const z of Object.keys(zonesTNUoS)) {
        const disp = Object.values(merit.adjustedGeneration[z] || {}).reduce((s, v) => s + v, 0);
        inj[z] = disp + (icByZone[z] || 0) - (zoneDemand[z] || 0);
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

console.log('Completed: ' + ok + ' scenarios\n');

function pctile(arr, p) {
  const s = [...arr].sort((a, b) => a - b);
  const i = (p / 100) * (s.length - 1);
  const lo = Math.floor(i), hi = Math.ceil(i);
  return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (i - lo);
}

const boundaries = ['B6F', 'B7aF', 'B9', 'SW1', 'B1aF', 'B2F', 'B3', 'B4F', 'B5', 'SC2'];

// Previous results for comparison
const prev = {
  B6F:  { e25: -12, e75: -32 },
  B7aF: { e25: -62, e75: -61 },
  B9:   { e25: -47, e75: -78 },
  SW1:  { e25: 288, e75: 5 },
  B1aF: { e25: 1222, e75: 61 },
  B2F:  { e25: 894, e75: 28 },
  B3:   { e25: -553, e75: -217 },
  B4F:  { e25: 14, e75: -69 },
  B5:   { e25: -538, e75: -111 },
  SC2:  { e25: 116, e75: -71 },
};

console.log('=== DEMAND-FIXED VALIDATION vs NESO ===');
console.log('Bound  | Our P25 | NESO P25 | P25err | Our P75 | NESO P75 | P75err | Status | vs Old');
console.log('-'.repeat(95));

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

  const p = prev[bn];
  const p75dir = Math.abs(e75) < Math.abs(p.e75) ? 'BETTER' : Math.abs(e75) > Math.abs(p.e75) ? 'WORSE' : 'SAME';

  console.log(
    bn.padEnd(6) + ' | ' + String(oP25).padStart(7) + ' | ' + String(nP25).padStart(8) + ' | ' +
    ((e25>=0?'+':'') + e25 + '%').padStart(7) + ' | ' + String(oP75).padStart(7) + ' | ' + String(nP75).padStart(8) + ' | ' +
    ((e75>=0?'+':'') + e75 + '%').padStart(7) + ' | ' + status.padEnd(5) + ' | ' + p75dir
  );
}
console.log('\nSummary: Good ' + good + ' | Fair ' + fair + ' | Poor ' + poor);
console.log('(Previous: Good 0 | Fair 5 | Poor 5)');
