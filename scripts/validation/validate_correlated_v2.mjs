import { readFileSync } from 'fs';
import { solveDCPF } from '../src/engine/dcPowerFlow.js';
import { getLinksForYear } from '../src/engine/networkBuilder.js';
import { applyMeritOrder } from '../src/engine/meritOrder.js';

function loadJSON(path) { return JSON.parse(readFileSync(path, 'utf-8')); }

const zonesTNUoS = loadJSON('public/data/zones_tnuos.json');
const linksByYear = loadJSON('public/data/links_tnuos_by_year.json');
const boundaryMapping = loadJSON('public/data/boundary_link_mapping.json');
const etysCapabilities = loadJSON('public/data/etys_capabilities.json');
const plantsTNUoS = loadJSON('public/data/plants_tnuos.json');
const validationData = loadJSON('scripts/winter_validation_data.json');

const YEAR = 2024;
const SCENARIO = 'Holistic Transition';
const NUCLEAR_AVAILABILITY = 0.80;
const IC_IMPORT_PCT = 65;

const zoneCapacity = {};
for (const plant of plantsTNUoS) {
  if (!plant.zone_id || !plant.plant_type) continue;
  if (plant.status !== 'Built' || plant.mw_connected <= 0) continue;
  if (plant.plant_type.includes('Demand') || plant.plant_type.includes('Reactive') || plant.plant_type.includes('Substation')) continue;
  if (!zoneCapacity[plant.zone_id]) zoneCapacity[plant.zone_id] = {};
  zoneCapacity[plant.zone_id][plant.plant_type] =
    (zoneCapacity[plant.zone_id][plant.plant_type] || 0) + plant.mw_connected;
}
const zoneFallback = {};
for (const [zid, zdata] of Object.entries(zonesTNUoS)) {
  zoneFallback[zid] = zdata.generation_by_type || {};
}

const zoneDemandShares = {};
let totalBaseDemand = 0;
for (const [zid, zdata] of Object.entries(zonesTNUoS)) {
  const d = zdata.demand_mw_by_year?.[String(YEAR)] || 0;
  zoneDemandShares[zid] = d;
  totalBaseDemand += d;
}
for (const zid of Object.keys(zoneDemandShares)) {
  zoneDemandShares[zid] /= totalBaseDemand;
}

const links = getLinksForYear(linksByYear, YEAR);
const records = validationData.records;

console.log('=== Correlated Validation v2 (real weather+demand, tool IC at ' + IC_IMPORT_PCT + '%) ===');
console.log('Samples: ' + records.length);

const flowSamples = {};
let ok = 0, errCnt = 0;

for (const record of records) {
  try {
    const zoneGen = {};
    const zoneDemand = {};
    const icByZone = {};

    for (const [zid, share] of Object.entries(zoneDemandShares)) {
      zoneDemand[zid] = record.tsd_mw * share;
    }

    for (const [zid, zdata] of Object.entries(zonesTNUoS)) {
      const genByType = {};
      const cap = zoneCapacity[zid] || {};
      const fb = zoneFallback[zid] || {};
      const allTypes = new Set([...Object.keys(cap), ...Object.keys(fb)]);

      for (const plantType of allTypes) {
        if (plantType.includes('Demand') || plantType.includes('Reactive') || plantType.includes('Substation')) continue;
        let mw = cap[plantType] || fb[plantType]?.built_mw || 0;
        if (mw <= 0) continue;

        if (plantType === 'Interconnector') {
          const importMW = mw * (IC_IMPORT_PCT / 100);
          icByZone[zid] = (icByZone[zid] || 0) + importMW;
          continue;
        }

        let gen = 0;
        if (plantType.includes('Wind')) {
          gen = mw * (record.wind_cf[zid] || 0);
        } else if (plantType.includes('Solar') || plantType.includes('PV')) {
          gen = mw * (record.solar_cf[zid] || 0);
        } else if (plantType.includes('Nuclear')) {
          gen = mw * NUCLEAR_AVAILABILITY;
        } else {
          gen = mw;
        }
        genByType[plantType] = gen;
      }
      zoneGen[zid] = genByType;
    }

    let wCF = 0, wCap = 0;
    for (const [zid, types] of Object.entries(zoneCapacity)) {
      for (const [pt, mw] of Object.entries(types)) {
        if (pt.includes('Wind')) { wCF += (record.wind_cf[zid] || 0) * mw; wCap += mw; }
      }
    }
    const natWindCF = wCap > 0 ? wCF / wCap : 0.25;

    const meritResult = applyMeritOrder(zoneGen, zoneDemand, {}, natWindCF);

    const injections = {};
    for (const zid of Object.keys(zonesTNUoS)) {
      const dispatched = Object.values(meritResult.adjustedGeneration[zid] || {}).reduce((s, v) => s + v, 0);
      injections[zid] = dispatched + (icByZone[zid] || 0) - (zoneDemand[zid] || 0);
    }

    const { flows } = solveDCPF(links, injections, 'GZ18');

    for (const [name, b] of Object.entries(boundaryMapping.boundary_links)) {
      if (!b.crossing_links?.length) continue;
      let net = 0;
      for (const lid of b.crossing_links) net += flows[lid] || 0;
      if (!flowSamples[name]) flowSamples[name] = [];
      flowSamples[name].push(net);
    }
    ok++;
  } catch (e) { errCnt++; }
}

console.log('Done: ' + ok + ' ok, ' + errCnt + ' errors\n');

function pct(arr, p) {
  const s = [...arr].sort((a, b) => a - b);
  const i = (p / 100) * (s.length - 1);
  const lo = Math.floor(i), hi = Math.ceil(i);
  return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (i - lo);
}

const boundaries = ['B6F', 'B7aF', 'B9', 'SW1', 'B1aF', 'B2F', 'B3', 'B4F', 'B5', 'SC2'];
const indep = { B6F:{p25:1042,p75:5877}, B7aF:{p25:1391,p75:4601}, B9:{p25:1437,p75:2190}, SW1:{p25:690,p75:3357}, B1aF:{p25:3044,p75:4706}, B2F:{p25:2899,p75:4949}, 'B3':{p25:-584,p75:-412}, B4F:{p25:889,p75:1767}, B5:{p25:-2367,p75:-531}, SC2:{p25:319,p75:895} };

console.log('Bound  | Our P25 | NESO P25 | P25err | Our P75 | NESO P75 | P75err | Status | vs Indep');
console.log('-'.repeat(105));

let good=0, fair=0, poor=0;
const results = [];

for (const name of boundaries) {
  const samples = flowSamples[name];
  if (!samples?.length) continue;
  const capData = etysCapabilities.boundaries?.[name]?.fes24?.[SCENARIO];
  const nP25 = capData?.['25pc']?.[String(YEAR)];
  const nP75 = capData?.['75pc']?.[String(YEAR)];
  if (nP25 === undefined || nP75 === undefined) continue;

  const oP25 = Math.round(pct(samples, 25));
  const oP75 = Math.round(pct(samples, 75));
  const e25 = Math.round((oP25 - nP25) / Math.max(Math.abs(nP25), 1) * 100);
  const e75 = Math.round((oP75 - nP75) / Math.max(Math.abs(nP75), 1) * 100);

  let status;
  if (Math.abs(e25) <= 30 && Math.abs(e75) <= 30) { status = 'GOOD'; good++; }
  else if (Math.abs(e25) <= 50 || Math.abs(e75) <= 50) { status = 'FAIR'; fair++; }
  else { status = 'POOR'; poor++; }

  const ind = indep[name];
  const indE25 = Math.round((ind.p25 - nP25) / Math.max(Math.abs(nP25), 1) * 100);
  const indE75 = Math.round((ind.p75 - nP75) / Math.max(Math.abs(nP75), 1) * 100);
  const p25b = Math.abs(e25) < Math.abs(indE25) ? 'better' : Math.abs(e25) > Math.abs(indE25) ? 'worse' : 'same';
  const p75b = Math.abs(e75) < Math.abs(indE75) ? 'better' : Math.abs(e75) > Math.abs(indE75) ? 'worse' : 'same';

  results.push({ name, ourP25: oP25, nesoP25: nP25, errP25: e25, ourP75: oP75, nesoP75: nP75, errP75: e75, status });

  console.log(
    name.padEnd(6) + ' | ' + String(oP25).padStart(7) + ' | ' + String(nP25).padStart(8) + ' | ' +
    ((e25>=0?'+':'') + e25 + '%').padStart(7) + ' | ' +
    String(oP75).padStart(7) + ' | ' + String(nP75).padStart(8) + ' | ' +
    ((e75>=0?'+':'') + e75 + '%').padStart(7) + ' | ' +
    status.padEnd(5) + ' | P25:' + p25b + ' P75:' + p75b
  );
}

console.log('\nSummary: Good ' + good + ' | Fair ' + fair + ' | Poor ' + poor);
console.log('\nJSON:');
console.log(JSON.stringify(results, null, 2));
