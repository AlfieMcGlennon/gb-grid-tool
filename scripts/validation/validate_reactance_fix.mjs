/**
 * Test impact of fixing GZ8-GZ9 reactance and adding missing GZ14-GZ16 link.
 * Runs same 361-scenario validation but with corrected network data.
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

const percentiles = [5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60, 65, 70, 75, 80, 85, 90, 95];

function runTest(label, linkModifier) {
  const baseLinks = getLinksForYear(linksByYear, YEAR);
  const links = linkModifier(baseLinks);
  const flowSamples = {};
  let ok = 0;

  for (const windPct of percentiles) {
    for (const demPct of percentiles) {
      try {
        const zoneGen = {}, zoneDemand = {}, icByZone = {};

        for (const [z, zdata] of Object.entries(zonesTNUoS)) {
          let baseDem = zdata.demand_mw_by_year?.[String(YEAR)] || 0;
          const zdc = demClimZones[z];
          if (zdc?.seasonal?.[SEASON]?.percentiles && zdc.seasonal[SEASON]?.mean) {
            const sp = getInterpolatedPercentile(zdc.seasonal[SEASON].percentiles, demPct);
            const sm = zdc.seasonal[SEASON].mean;
            if (sm > 0) baseDem = baseDem * (sp / sm);
          }
          zoneDemand[z] = baseDem;
        }

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
        for (const [z, types] of Object.entries(zoneCap)) {
          for (const [pt, mw] of Object.entries(types)) {
            if (pt.includes('Wind')) { wCF += getInterpolatedPercentile(climZones[z]?.wind_cf?.[SEASON]?.percentiles || {}, windPct) * mw; wCap += mw; }
          }
        }
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

  // Results
  function pct(arr, p) {
    const s = [...arr].sort((a, b) => a - b);
    const i = (p / 100) * (s.length - 1);
    const lo = Math.floor(i), hi = Math.ceil(i);
    return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (i - lo);
  }

  const boundaries = ['B6F', 'B7aF', 'B9', 'SW1', 'B1aF', 'B2F', 'B3', 'B4F', 'B5', 'SC2'];
  console.log(`\n=== ${label} (${ok} scenarios) ===`);
  console.log('Bound  | Our P25 | NESO P25 | P25err | Our P75 | NESO P75 | P75err | Status');
  console.log('-'.repeat(85));

  let good = 0, fair = 0, poor = 0;
  const rows = [];
  for (const name of boundaries) {
    const samples = flowSamples[name];
    if (!samples?.length) continue;
    const cap = etysCapabilities.boundaries?.[name]?.fes24?.[SCENARIO];
    const nP25 = cap?.['25pc']?.[String(YEAR)];
    const nP75 = cap?.['75pc']?.[String(YEAR)];
    if (nP25 == null || nP75 == null) continue;
    const oP25 = Math.round(pct(samples, 25));
    const oP75 = Math.round(pct(samples, 75));
    const e25 = Math.round((oP25 - nP25) / Math.max(Math.abs(nP25), 1) * 100);
    const e75 = Math.round((oP75 - nP75) / Math.max(Math.abs(nP75), 1) * 100);
    let status;
    if (Math.abs(e25) <= 30 && Math.abs(e75) <= 30) { status = 'GOOD'; good++; }
    else if (Math.abs(e25) <= 50 || Math.abs(e75) <= 50) { status = 'FAIR'; fair++; }
    else { status = 'POOR'; poor++; }
    rows.push({ name, oP25, nP25, e25, oP75, nP75, e75, status });
    console.log(name.padEnd(6) + ' | ' + String(oP25).padStart(7) + ' | ' + String(nP25).padStart(8) + ' | ' +
      ((e25>=0?'+':'') + e25 + '%').padStart(7) + ' | ' + String(oP75).padStart(7) + ' | ' + String(nP75).padStart(8) + ' | ' +
      ((e75>=0?'+':'') + e75 + '%').padStart(7) + ' | ' + status);
  }
  console.log(`Summary: Good ${good} | Fair ${fair} | Poor ${poor}`);
  return rows;
}

// Test 1: Current (baseline)
const baseline = runTest('BASELINE (current links)', links => links);

// Test 2: Fix GZ8-GZ9 reactance only
const fixGZ89 = runTest('FIX GZ8-GZ9 (x: 0.3651 -> 0.0912)', links => {
  return links.map(l => {
    if (l.id === 'GZ8-GZ9') return { ...l, x_equivalent: 0.0912 };
    return l;
  });
});

// Test 3: Fix GZ8-GZ9 + add GZ14-GZ16
const fixAll = runTest('FIX GZ8-GZ9 + ADD GZ14-GZ16', links => {
  const fixed = links.map(l => {
    if (l.id === 'GZ8-GZ9') return { ...l, x_equivalent: 0.0912 };
    return l;
  });
  // Add missing GZ14-GZ16 link
  fixed.push({
    id: 'GZ14-GZ16',
    from: 'GZ14',
    to: 'GZ16',
    x_equivalent: 0.1022,
    capacity_mw: 13319,
    n_circuits: 5,
    carrier: 'AC'
  });
  return fixed;
});

// Test 4: Fix GZ8-GZ9 + GZ14-GZ16 + add other significant missing links
const fixAllPlus = runTest('FIX + ALL MISSING >1GW LINKS', links => {
  const fixed = links.map(l => {
    if (l.id === 'GZ8-GZ9') return { ...l, x_equivalent: 0.0912 };
    if (l.id === 'GZ1-GZ5') return { ...l, x_equivalent: 0.1816 };
    return l;
  });
  fixed.push({ id: 'GZ14-GZ16', from: 'GZ14', to: 'GZ16', x_equivalent: 0.1022, capacity_mw: 13319, n_circuits: 5, carrier: 'AC' });
  fixed.push({ id: 'GZ20-GZ22', from: 'GZ20', to: 'GZ22', x_equivalent: 3.8063, capacity_mw: 2779, n_circuits: 1, carrier: 'AC' });
  fixed.push({ id: 'GZ18-GZ19', from: 'GZ18', to: 'GZ19', x_equivalent: 0.9555, capacity_mw: 1135, n_circuits: 1, carrier: 'AC' });
  fixed.push({ id: 'GZ11-GZ14', from: 'GZ11', to: 'GZ14', x_equivalent: 0.6311, capacity_mw: 338, n_circuits: 3, carrier: 'AC' });
  return fixed;
});

// Compare
console.log('\n=== COMPARISON: P75 Error ===');
console.log('Bound  | Baseline | Fix GZ8-9 | +GZ14-16 | +All miss | Best');
console.log('-'.repeat(70));
for (let i = 0; i < baseline.length; i++) {
  const b = baseline[i], f1 = fixGZ89[i], f2 = fixAll[i], f3 = fixAllPlus[i];
  const errs = [Math.abs(b.e75), Math.abs(f1.e75), Math.abs(f2.e75), Math.abs(f3.e75)];
  const labels = ['Base', 'GZ89', '+14-16', '+All'];
  const best = labels[errs.indexOf(Math.min(...errs))];
  console.log(
    b.name.padEnd(6) + ' | ' +
    ((b.e75>=0?'+':'') + b.e75 + '%').padStart(8) + ' | ' +
    ((f1.e75>=0?'+':'') + f1.e75 + '%').padStart(9) + ' | ' +
    ((f2.e75>=0?'+':'') + f2.e75 + '%').padStart(8) + ' | ' +
    ((f3.e75>=0?'+':'') + f3.e75 + '%').padStart(9) + ' | ' + best
  );
}
