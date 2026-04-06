import { readFileSync } from 'fs';
import { solveDCPF } from '../src/engine/dcPowerFlow.js';
import { getLinksForYear } from '../src/engine/networkBuilder.js';
import { applyMeritOrder } from '../src/engine/meritOrder.js';
import { computeDynamicIC } from '../src/engine/scenarioRunner.js';
import { getInterpolatedPercentile } from '../src/utils/percentiles.js';

function loadJSON(p) { return JSON.parse(readFileSync(p, 'utf-8')); }

const zonesTNUoS = loadJSON('public/data/zones_tnuos.json');
const linksByYear = loadJSON('public/data/links_tnuos_by_year.json');
const boundaryMapping = loadJSON('public/data/boundary_link_mapping.json');
const etysCapabilities = loadJSON('public/data/etys_capabilities.json');
const plantsTNUoS = loadJSON('public/data/plants_tnuos.json');
const climatology = loadJSON('public/data/climatology.json');
const demandClimatology = loadJSON('public/data/demand_climatology.json');
const icLookup = loadJSON('public/data/ic_lookup.json');

const YEAR = 2024, SEASON = 'winter', SCENARIO = 'Holistic Transition';
const NUCLEAR_AVAIL = 0.80;

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

function runValidation(name, getIC) {
  const flowSamples = {};
  let ok = 0;

  for (const windPct of percentiles) {
    for (const demPct of percentiles) {
      try {
        const icPct = getIC(windPct, demPct);
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
            if (pt === 'Interconnector') {
              icByZone[z] = (icByZone[z] || 0) + mw * icPct / 100;
              continue;
            }
            let gen = 0;
            if (pt.includes('Wind') && zc) {
              gen = mw * getInterpolatedPercentile(zc.wind_cf?.[SEASON]?.percentiles || zc.wind_cf?.[SEASON] || {}, windPct);
            } else if ((pt.includes('Solar') || pt.includes('PV')) && zc) {
              const sd = zc.solar_cf?.[SEASON];
              if (sd) gen = mw * getInterpolatedPercentile(sd.percentiles || sd || {}, 50) * (sd.daylight_fraction || 1);
            } else if (pt.includes('Nuclear')) { gen = mw * NUCLEAR_AVAIL; }
            else { gen = mw; }
            genByType[pt] = gen;
          }
          zoneGen[z] = genByType;
        }

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
          inj[z] = disp + (icByZone[z] || 0) - (zoneDemand[z] || 0);
        }

        const { flows } = solveDCPF(links, inj, 'GZ18');
        for (const [bname, b] of Object.entries(boundaryMapping.boundary_links)) {
          if (!b.crossing_links?.length) continue;
          let net = 0;
          for (const lid of b.crossing_links) net += flows[lid] || 0;
          if (!flowSamples[bname]) flowSamples[bname] = [];
          flowSamples[bname].push(net);
        }
        ok++;
      } catch (e) {}
    }
  }
  return { flowSamples, ok };
}

function pctile(arr, p) {
  const s = [...arr].sort((a, b) => a - b);
  const i = (p / 100) * (s.length - 1);
  const lo = Math.floor(i), hi = Math.ceil(i);
  return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (i - lo);
}

function printResults(name, flowSamples, ok) {
  const boundaries = ['B6F', 'B7aF', 'B9', 'SW1', 'B1aF', 'B2F', 'B3', 'B4F', 'B5', 'SC2'];
  console.log(`\n=== ${name} (${ok} scenarios) ===`);
  console.log('Bound  | Our P25 | NESO P25 | P25err | Our P75 | NESO P75 | P75err | Status');
  console.log('-'.repeat(85));

  let good = 0, fair = 0, poor = 0;
  const rows = [];
  for (const bname of boundaries) {
    const samples = flowSamples[bname];
    if (!samples?.length) continue;
    const cap = etysCapabilities.boundaries?.[bname]?.fes24?.[SCENARIO];
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

    rows.push({ bname, oP25, nP25, e25, oP75, nP75, e75, status });
    console.log(
      bname.padEnd(6) + ' | ' + String(oP25).padStart(7) + ' | ' + String(nP25).padStart(8) + ' | ' +
      ((e25>=0?'+':'') + e25 + '%').padStart(7) + ' | ' +
      String(oP75).padStart(7) + ' | ' + String(nP75).padStart(8) + ' | ' +
      ((e75>=0?'+':'') + e75 + '%').padStart(7) + ' | ' + status
    );
  }
  console.log(`Summary: Good ${good} | Fair ${fair} | Poor ${poor}`);
  return rows;
}

console.log('Running 3-way validation comparison (361 scenarios each)...');

const r1 = runValidation('Fixed 65%', () => 65);
const r2 = runValidation('Dynamic IC', (w, d) => computeDynamicIC(w, d, icLookup));
const r3 = runValidation('Fixed 17%', () => 17);

const rows1 = printResults('Fixed 65% (old default)', r1.flowSamples, r1.ok);
const rows2 = printResults('Dynamic IC (NESO lookup)', r2.flowSamples, r2.ok);
const rows3 = printResults('Fixed 17% (real mean)', r3.flowSamples, r3.ok);

// Side-by-side comparison
console.log('\n=== SIDE-BY-SIDE P75 ERROR ===');
console.log('Bound  | 65% err | Dynamic err | 17% err | Best');
console.log('-'.repeat(55));
for (let i = 0; i < rows1.length; i++) {
  const r = [rows1[i], rows2[i], rows3[i]];
  const errs = r.map(x => Math.abs(x.e75));
  const best = ['65%', 'Dynamic', '17%'][errs.indexOf(Math.min(...errs))];
  console.log(
    r[0].bname.padEnd(6) + ' | ' +
    ((r[0].e75>=0?'+':'') + r[0].e75 + '%').padStart(7) + ' | ' +
    ((r[1].e75>=0?'+':'') + r[1].e75 + '%').padStart(11) + ' | ' +
    ((r[2].e75>=0?'+':'') + r[2].e75 + '%').padStart(7) + ' | ' + best
  );
}
