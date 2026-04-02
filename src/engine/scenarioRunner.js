// Scenario runner - combines generation, demand, and network to run power flow

import { solveDCPF } from './dcPowerFlow.js';
import { getLinksForYear, applyUserEdits } from './networkBuilder.js';
import { applyMeritOrder } from './meritOrder.js';
import { getInterpolatedPercentile } from '../utils/percentiles.js';

/**
 * Nuclear availability factor - typical fleet-wide availability
 * UK nuclear fleet averages ~80% availability accounting for:
 * - Planned outages (refuelling, maintenance)
 * - Unplanned outages (technical issues)
 * Source: EDF Energy annual reports, validated against 4,840 MW output vs 6,050 MW capacity
 */
const NUCLEAR_AVAILABILITY_FACTOR = 0.80;

/**
 * Known major project commission years
 * Used for data-driven generation projection when commissioning_year not in plant data
 * Sources: NESO, developer announcements, BEIS/DESNZ
 */
const KNOWN_COMMISSIONS = {
  // Offshore Wind - major projects with known commission dates
  'Dogger Bank Project C': 2026,           // 1,200 MW
  'Hornsea Power Station 3': 2027,         // 2,852 MW (split across phases)
  'Hornsea Power Station 4': 2028,         // 2,600 MW (target)
  'Dogger Bank D Offshore Wind Farm': 2029, // 1,450 MW
  'East Anglia THREE': 2030,               // 1,400 MW
  'Dogger Bank South East': 2031,          // 1,850 MW combined
  'Dogger Bank South West': 2032,          // 1,850 MW combined
  'Moray West Extension': 2033,            // 900 MW
  // Note: Dogger Bank A & B already marked "Built" in data

  // Nuclear - Hinkley Point C (if it ever gets built)
  'Hinkley Point C': 2030,                 // 3,340 MW (optimistic)

  // Sizewell C
  'Sizewell C': 2034,                      // 3,340 MW
};

/**
 * Nuclear plant decommission years
 * Hardcoded because these are firm closures not in plant data
 */
const NUCLEAR_DECOMMISSIONS = {
  'Torness': 2028,           // GZ11, 1,250 MW - confirmed closure
  'Heysham Power Station': 2028,  // GZ14, 2,363 MW (Heysham 2) - confirmed closure
  // Hinkley Point B: already 0 MW in data (closed 2022)
  // Hunterston B: already closed (2022)
};

/**
 * Plant types that are NOT generation and should be excluded
 * These should never contribute to generation totals
 */
const NON_GENERATION_TYPES = [
  'Demand',
  'Reactive Compensation',
  'Substation'
];

/**
 * Check if a plant type is actual generation (not demand/reactive/etc)
 */
function isGenerationType(plantType) {
  if (!plantType) return false;
  return !NON_GENERATION_TYPES.some(nonGen => plantType.includes(nonGen));
}

/**
 * Estimate commission year for plants without explicit dates
 * Uses a hash of project name to spread plants across years within each status band
 * This produces gradual year-on-year capacity growth rather than step changes
 *
 * Status breakdown from plants_tnuos.json:
 * - Built: 91,726 MW (baseline)
 * - Under Construction: 4,002 MW → spread 2025-2027
 * - Consents Approved: 46,674 MW → spread 2027-2030
 * - Awaiting Consents: 58,491 MW → spread 2028-2032
 * - Scoping: 558,201 MW → never (unless in KNOWN_COMMISSIONS)
 */
function estimateCommissionYear(plant) {
  const status = plant.status;
  const name = plant.project || '';

  // Deterministic hash of project name for consistent year assignment
  const hash = [...name].reduce((sum, ch) => sum + ch.charCodeAt(0), 0);

  // Under Construction / Commissioning - spread across 2025-2027
  if (status === 'Under Construction' || status === 'Commissioning') {
    return 2025 + (hash % 3);  // 2025, 2026, or 2027
  }

  // Consents Approved - spread across 2027-2030
  if (status === 'Consents Approved') {
    return 2027 + (hash % 4);  // 2027, 2028, 2029, or 2030
  }

  // Awaiting Consents - spread across 2028-2032
  if (status === 'Awaiting Consents') {
    return 2028 + (hash % 5);  // 2028, 2029, 2030, 2031, or 2032
  }

  // Scoping - NEVER operational unless in KNOWN_COMMISSIONS
  // Only ~5% of Scoping projects ever get built
  // Named exceptions are handled via KNOWN_COMMISSIONS lookup
  if (status === 'Scoping') {
    return 9999;  // Never operational by default
  }

  // Default: not operational
  return 9999;
}

/**
 * Check if a plant is operational in the given year
 * Uses status field and known commission/decommission dates
 */
function isPlantOperational(plant, year) {
  const projectName = plant.project;
  const plantType = plant.plant_type || '';

  // Exclude non-generation plant types entirely
  if (!isGenerationType(plantType)) {
    return false;
  }

  // Check for decommissioning (nuclear closures) - MUST CHECK FIRST
  if (plantType === 'Nuclear') {
    const decommissionYear = NUCLEAR_DECOMMISSIONS[projectName];
    if (decommissionYear && year >= decommissionYear) {
      return false;
    }
  }

  // Currently built plants are operational (unless decommissioned above)
  if (plant.status === 'Built' && plant.mw_connected > 0) {
    return true;
  }

  // Check known future commissions (allows specific Scoping projects)
  if (KNOWN_COMMISSIONS[projectName]) {
    return year >= KNOWN_COMMISSIONS[projectName];
  }

  // For other plants, estimate based on status
  const estimatedYear = estimateCommissionYear(plant);
  return year >= estimatedYear;
}

/**
 * Build per-zone generation and demand from plant data, climatology, and user edits.
 *
 * @returns {{ yearFilteredCapacity, zoneGenerationByType, zoneDemand, interconnectorByZone, totalInterconnectorImport, debugTotals }}
 */
function buildZoneGeneration({
  data, year, season, windPercentile, solarPercentile, demandPercentile,
  interconnectorImport, fuelToggles, plantEdits, addedNodes
}) {
  const zoneGenerationByType = {};
  const zoneDemand = {};

  const climatology = data.climatology?.tnuos_zones || {};
  const demandClimatology = data.demandClimatology?.zones || {};

  let totalInterconnectorImport = 0;
  const interconnectorByZone = {};

  // DEBUG totals
  let debugTotalBuiltCapacity = 0;
  let debugTotalWindCapacity = 0;
  let debugTotalSolarCapacity = 0;
  let debugTotalNuclearCapacity = 0;
  let debugTotalBaseDemand = 0;

  // Aggregate plant capacities by zone and type for the selected year
  const plants = data.plantsTNUoS || [];
  const yearFilteredCapacity = {};
  const hasPlantData = {};

  for (const plant of plants) {
    const zoneId = plant.zone_id;
    const plantType = plant.plant_type;

    if (!zoneId || !plantType) continue;
    if (!isGenerationType(plantType)) continue;

    if (!hasPlantData[zoneId]) hasPlantData[zoneId] = {};
    hasPlantData[zoneId][plantType] = true;

    if (!isPlantOperational(plant, year)) continue;

    if (!yearFilteredCapacity[zoneId]) {
      yearFilteredCapacity[zoneId] = {};
    }

    const capacity = plant.mw_connected > 0 ? plant.mw_connected : plant.mw_total;
    yearFilteredCapacity[zoneId][plantType] =
      (yearFilteredCapacity[zoneId][plantType] || 0) + capacity;
  }

  // Calculate generation for each zone using filtered capacities
  for (const [zoneId, zoneData] of Object.entries(data.zonesTNUoS)) {
    const genByType = {};
    const zoneCapacity = yearFilteredCapacity[zoneId] || {};
    const zoneFallback = zoneData.generation_by_type || {};

    const allTypes = new Set([
      ...Object.keys(zoneCapacity),
      ...Object.keys(zoneFallback)
    ]);

    for (const plantType of allTypes) {
      if (!isGenerationType(plantType)) continue;

      let capacity;
      if (hasPlantData[zoneId]?.[plantType]) {
        capacity = zoneCapacity[plantType] || 0;
      } else {
        capacity = zoneFallback[plantType]?.built_mw || 0;
      }

      debugTotalBuiltCapacity += capacity;
      if (plantType.includes('Wind')) debugTotalWindCapacity += capacity;
      if (plantType.includes('Solar') || plantType.includes('PV')) debugTotalSolarCapacity += capacity;
      if (plantType.includes('Nuclear')) debugTotalNuclearCapacity += capacity;

      if (plantType === 'Interconnector') {
        const importMW = capacity * (interconnectorImport / 100);
        interconnectorByZone[zoneId] = (interconnectorByZone[zoneId] || 0) + importMW;
        totalInterconnectorImport += importMW;
        genByType[plantType] = importMW;
        continue;
      }

      if (fuelToggles[plantType] === false) {
        genByType[plantType] = 0;
        continue;
      }

      let generation = 0;
      const zoneClimate = climatology[zoneId];

      if (plantType.includes('Wind') && zoneClimate) {
        const windCF = getInterpolatedPercentile(
          zoneClimate.wind_cf?.[season]?.percentiles || zoneClimate.wind_cf?.[season],
          windPercentile
        );
        generation = capacity * windCF;
      } else if ((plantType.includes('Solar') || plantType.includes('PV')) && zoneClimate) {
        const solarData = zoneClimate.solar_cf?.[season];
        if (solarData) {
          const solarCF = getInterpolatedPercentile(
            solarData.percentiles || solarData,
            solarPercentile
          );
          const daylightFraction = solarData.daylight_fraction || 1.0;
          generation = capacity * solarCF * daylightFraction;
        }
      } else if (plantType.includes('Nuclear')) {
        generation = capacity * NUCLEAR_AVAILABILITY_FACTOR;
      } else {
        generation = capacity;
      }

      genByType[plantType] = generation;
    }

    zoneGenerationByType[zoneId] = genByType;
  }

  // Apply plant edits
  if (plantEdits && Object.keys(plantEdits).length > 0) {
    applyPlantEditsToGeneration(
      zoneGenerationByType,
      data.plantsTNUoS || [],
      plantEdits,
      fuelToggles,
      data.climatology?.tnuos_zones || {},
      season,
      windPercentile,
      solarPercentile,
      year
    );
  }

  // Apply hypothetical (user-added) generation nodes
  if (addedNodes && addedNodes.length > 0) {
    applyAddedNodesToGeneration(
      zoneGenerationByType,
      addedNodes,
      fuelToggles,
      data.climatology?.tnuos_zones || {},
      season,
      windPercentile,
      solarPercentile
    );
  }

  // Demand calculation for each zone
  for (const [zoneId, zoneData] of Object.entries(data.zonesTNUoS)) {
    const demandByYear = zoneData.demand_mw_by_year || {};
    let baseDemand = demandByYear[String(year)];

    if (baseDemand === undefined) {
      const availableYears = Object.keys(demandByYear).map(Number).sort((a, b) => a - b);
      const closestYear = availableYears.reduce((prev, curr) =>
        Math.abs(curr - year) < Math.abs(prev - year) ? curr : prev
      , availableYears[0] || 2024);
      baseDemand = demandByYear[String(closestYear)] || 0;
    }

    debugTotalBaseDemand += baseDemand;

    let demand = baseDemand;
    const zoneDemanClimate = demandClimatology[zoneId];
    if (zoneDemanClimate?.seasonal?.[season]?.percentiles) {
      demand = getInterpolatedPercentile(
        zoneDemanClimate.seasonal[season].percentiles,
        demandPercentile
      );
    }

    zoneDemand[zoneId] = demand;
  }

  return {
    yearFilteredCapacity,
    zoneGenerationByType,
    zoneDemand,
    interconnectorByZone,
    totalInterconnectorImport,
    debugTotals: {
      builtCapacity: debugTotalBuiltCapacity,
      windCapacity: debugTotalWindCapacity,
      solarCapacity: debugTotalSolarCapacity,
      nuclearCapacity: debugTotalNuclearCapacity,
      baseDemand: debugTotalBaseDemand
    }
  };
}

/**
 * Apply post-dispatch curtailment of wind/solar to balance supply = demand.
 *
 * @param {Object} meritResult - Result from applyMeritOrder (adjustedGeneration, national, etc.)
 * @param {Object} zoneGeneration - Total generation per zone (modified in place)
 * @param {Object} zoneDemand - Demand per zone
 * @returns {{ zoneGeneration, windCurtailment }}
 */
function applyCurtailment(meritResult, zoneGeneration, zoneDemand) {
  const totalGenBeforeCurtailment = Object.values(zoneGeneration).reduce((sum, v) => sum + v, 0);
  const totalDemandForCurtailment = Object.values(zoneDemand).reduce((sum, v) => sum + v, 0);

  console.group('🔄 POST-DISPATCH CURTAILMENT CHECK');
  console.log('Total Generation (incl. interconnectors):', totalGenBeforeCurtailment.toFixed(0), 'MW');
  console.log('Total Demand:', totalDemandForCurtailment.toFixed(0), 'MW');
  console.log('Excess:', (totalGenBeforeCurtailment - totalDemandForCurtailment).toFixed(0), 'MW');

  let windCurtailment;

  if (totalGenBeforeCurtailment > totalDemandForCurtailment) {
    let excess = totalGenBeforeCurtailment - totalDemandForCurtailment;

    let totalWind = 0;
    let totalSolar = 0;
    for (const [zoneId, genByType] of Object.entries(meritResult.adjustedGeneration)) {
      for (const [plantType, mw] of Object.entries(genByType)) {
        if (plantType.includes('Wind')) totalWind += mw;
        else if (plantType.includes('Solar') || plantType.includes('PV')) totalSolar += mw;
      }
    }

    console.log('Wind available for curtailment:', totalWind.toFixed(0), 'MW');
    console.log('Solar available for curtailment:', totalSolar.toFixed(0), 'MW');

    let windCurtailed = 0;
    let solarCurtailed = 0;

    if (totalWind > 0 && excess > 0) {
      windCurtailed = Math.min(excess, totalWind);
      const windFactor = 1 - (windCurtailed / totalWind);
      excess -= windCurtailed;

      for (const [zoneId, genByType] of Object.entries(meritResult.adjustedGeneration)) {
        for (const plantType of Object.keys(genByType)) {
          if (plantType.includes('Wind')) {
            const reduction = genByType[plantType] * (1 - windFactor);
            genByType[plantType] *= windFactor;
            zoneGeneration[zoneId] -= reduction;
          }
        }
      }
      console.log('⚡ Wind curtailed:', windCurtailed.toFixed(0), 'MW');
    }

    if (totalSolar > 0 && excess > 0) {
      solarCurtailed = Math.min(excess, totalSolar);
      const solarFactor = 1 - (solarCurtailed / totalSolar);
      excess -= solarCurtailed;

      for (const [zoneId, genByType] of Object.entries(meritResult.adjustedGeneration)) {
        for (const plantType of Object.keys(genByType)) {
          if (plantType.includes('Solar') || plantType.includes('PV')) {
            const reduction = genByType[plantType] * (1 - solarFactor);
            genByType[plantType] *= solarFactor;
            zoneGeneration[zoneId] -= reduction;
          }
        }
      }
      console.log('⚡ Solar curtailed:', solarCurtailed.toFixed(0), 'MW');
    }

    windCurtailment = {
      curtailedMW: windCurtailed + solarCurtailed,
      windCurtailedMW: windCurtailed,
      solarCurtailedMW: solarCurtailed,
      curtailmentPct: totalWind > 0 ? (windCurtailed / totalWind) * 100 : 0,
      originalWindMW: totalWind,
      originalSolarMW: totalSolar,
      isCurtailed: (windCurtailed + solarCurtailed) > 0
    };

    const newTotalGen = Object.values(zoneGeneration).reduce((sum, v) => sum + v, 0);
    meritResult.national.generation = newTotalGen;
    meritResult.national.imbalance = newTotalGen - totalDemandForCurtailment;

    console.log('✅ After curtailment - Generation:', newTotalGen.toFixed(0), 'MW, Balance:', (newTotalGen - totalDemandForCurtailment).toFixed(0), 'MW');

    if (excess > 0) {
      console.warn('⚠️ Remaining excess:', excess.toFixed(0), 'MW (nuclear/hydro/biomass/interconnectors cannot be curtailed)');
    }
  } else {
    console.log('✅ No curtailment needed - generation <= demand');
    windCurtailment = {
      curtailedMW: 0, windCurtailedMW: 0, solarCurtailedMW: 0,
      curtailmentPct: 0, originalWindMW: 0, originalSolarMW: 0, isCurtailed: false
    };
  }
  console.groupEnd();

  return { zoneGeneration, windCurtailment };
}

/**
 * Run a complete power flow scenario
 *
 * @param {Object} params - Scenario parameters
 * @param {Object} params.data - All loaded data (zones, links, boundaries, etc.)
 * @param {number} params.year - Year to simulate (default: 2024)
 * @param {string} params.scenario - FES/CP30 scenario name
 * @param {string} params.season - Season for weather (default: 'winter')
 * @param {number} params.windPercentile - Wind percentile 1-99 (default: 50)
 * @param {number} params.solarPercentile - Solar percentile 1-99 (default: 50)
 * @param {number} params.demandPercentile - Demand percentile 1-99 (default: 75)
 * @param {Object} params.fuelToggles - Which fuel types are enabled
 * @param {string} params.dispatchMode - 'simple' or 'merit-order' (default: 'simple')
 * @param {number} params.interconnectorImport - Interconnector import % (0-100, default: 65)
 * @param {Object} params.userEdits - User modifications to plants/links (Phase 6)
 * @param {Object} params.plantEdits - Plant edits: { plantId: { status, outputPct, ... } }
 * @param {Array} params.addedNodes - Hypothetical generation nodes: [{ zoneId, plantType, capacityMW }, ...]
 * @param {Object} params.linkEdits - Link edits: { added: [], removed: [], modified: {} }
 * @returns {Object} { flows, angles, boundaryUtilisation, thermalUtilisation, zoneInjections, validationInfo }
 */
export function runScenario(params) {
  const {
    data,
    year = 2024,
    scenario = 'Holistic Transition',
    season = 'winter',
    windPercentile = 50,
    solarPercentile = 50,
    demandPercentile = 75,
    fuelToggles = {},
    dispatchMode = 'simple',
    interconnectorImport = 65,  // Default 65% import (typical for GB)
    userEdits = null,
    plantEdits = {},
    addedNodes = [],
    linkEdits = { added: [], removed: [], modified: {} }
  } = params;

  // Get network links for this year and apply edits
  const baseLinks = getLinksForYear(data.linksTNUoSByYear, year);
  let links = applyUserEdits(baseLinks, userEdits);

  // Apply link edits (added, removed, modified)
  links = applyLinkEdits(links, linkEdits);

  // Build per-zone generation and demand
  const zoneInjections = {};
  const {
    yearFilteredCapacity,
    zoneGenerationByType,
    zoneDemand,
    interconnectorByZone,
    totalInterconnectorImport,
    debugTotals
  } = buildZoneGeneration({
    data, year, season, windPercentile, solarPercentile, demandPercentile,
    interconnectorImport, fuelToggles, plantEdits, addedNodes
  });

  // Calculate national wind CF for blended dispatch
  const nationalWindCF = calculateNationalWindCFFromGeneration(
    zoneGenerationByType,
    data.climatology,
    season,
    windPercentile
  );

  // DEBUG: Log capacity totals before dispatch
  console.group(`🔍 GENERATION & DEMAND DEBUG (Year: ${year})`);
  console.log('Year-Scaled Capacity:', {
    total: debugTotals.builtCapacity.toFixed(0) + ' MW',
    wind: debugTotals.windCapacity.toFixed(0) + ' MW',
    solar: debugTotals.solarCapacity.toFixed(0) + ' MW',
    nuclear: debugTotals.nuclearCapacity.toFixed(0) + ' MW'
  });
  console.log('Total Base Demand (from zones for ' + year + '):', debugTotals.baseDemand.toFixed(0) + ' MW');
  console.log('Interconnector Import:', totalInterconnectorImport.toFixed(0) + ' MW', `(${interconnectorImport}%)`);
  console.log('National Wind CF:', (nationalWindCF * 100).toFixed(1) + '%');
  console.log('Dispatch Mode:', dispatchMode);
  console.log('Year:', year, '| Season:', season, '| Wind p' + windPercentile, '| Solar p' + solarPercentile, '| Demand p' + demandPercentile);

  // Apply merit order dispatch if enabled
  let zoneGeneration = {}; // Total generation per zone
  let dispatchDetails = null;

  if (dispatchMode === 'merit-order') {
    const meritResult = applyMeritOrder(zoneGenerationByType, zoneDemand, fuelToggles, nationalWindCF);
    dispatchDetails = meritResult;

    // Sum generation per zone from dispatched amounts
    for (const [zoneId, genByType] of Object.entries(meritResult.adjustedGeneration)) {
      zoneGeneration[zoneId] = Object.values(genByType).reduce((sum, v) => sum + v, 0);
    }

    // Add interconnector imports to zone generation
    for (const [zoneId, importMW] of Object.entries(interconnectorByZone)) {
      zoneGeneration[zoneId] = (zoneGeneration[zoneId] || 0) + importMW;
    }

    // POST-DISPATCH CURTAILMENT: curtail wind/solar to balance supply = demand
    const curtailmentResult = applyCurtailment(meritResult, zoneGeneration, zoneDemand);
    zoneGeneration = curtailmentResult.zoneGeneration;
    dispatchDetails.windCurtailment = curtailmentResult.windCurtailment;

    // DEBUG: Log merit order dispatch results
    console.log('Merit Order Dispatch Results:', {
      nationalDemand: dispatchDetails.national.demand.toFixed(0) + ' MW',
      nationalGeneration: dispatchDetails.national.generation.toFixed(0) + ' MW',
      mustRun: dispatchDetails.national.mustRun.toFixed(0) + ' MW',
      flexible: dispatchDetails.national.dispatched.toFixed(0) + ' MW',
      interconnectors: totalInterconnectorImport.toFixed(0) + ' MW',
      imbalance: dispatchDetails.national.imbalance.toFixed(0) + ' MW',
      blendFactor: (dispatchDetails.blendFactor * 100).toFixed(0) + '% national'
    });
  } else {
    // Simple dispatch: sum all generation as-is
    for (const [zoneId, genByType] of Object.entries(zoneGenerationByType)) {
      zoneGeneration[zoneId] = Object.values(genByType).reduce((sum, v) => sum + v, 0);
    }

    // DEBUG: Log simple dispatch totals
    const totalGen = Object.values(zoneGeneration).reduce((sum, v) => sum + v, 0);
    const totalDemand = Object.values(zoneDemand).reduce((sum, v) => sum + v, 0);
    console.log('Simple Dispatch Results:', {
      totalGeneration: totalGen.toFixed(0) + ' MW',
      totalDemand: totalDemand.toFixed(0) + ' MW',
      imbalance: (totalGen - totalDemand).toFixed(0) + ' MW'
    });
  }
  console.groupEnd();

  // Net injection = generation - demand per zone
  for (const zoneId of Object.keys(data.zonesTNUoS)) {
    const generation = zoneGeneration[zoneId] || 0;
    const demand = zoneDemand[zoneId] || 0;
    zoneInjections[zoneId] = generation - demand;
  }

  // Run DC power flow
  const powerFlowResult = solveDCPF(links, zoneInjections, "GZ18");
  const { flows, angles, slackAbsorption, slackZone } = powerFlowResult;

  // Compute boundary utilisation
  const boundaryUtilisation = computeBoundaryUtilisation(
    flows,
    data.boundaryLinkMapping,
    data.etysCapabilities,
    year,
    scenario
  );

  // Compute thermal utilisation (link-level)
  const thermalUtilisation = computeThermalUtilisation(flows, links);

  // Validation info for console logging
  const validationInfo = {
    totalGeneration: Object.values(zoneGeneration).reduce((sum, v) => sum + v, 0),
    totalDemand: Object.values(zoneDemand).reduce((sum, v) => sum + v, 0),
    slackAbsorption,
    slackZone,
    numLinksWithFlow: Object.values(flows).filter(f => Math.abs(f) > 0.1).length,
    topBoundaryUtilisations: Object.entries(boundaryUtilisation)
      .map(([id, data]) => ({ id, ...data }))
      .sort((a, b) => b.utilisation_pct - a.utilisation_pct)
      .slice(0, 5),
    boundariesOver80pct: Object.entries(boundaryUtilisation)
      .filter(([_, data]) => data.utilisation_pct > 80)
      .map(([id, data]) => ({ id, ...data })),
    interconnectorImport: totalInterconnectorImport,
    nationalWindCF
  };

  return {
    flows,
    angles,
    boundaryUtilisation,
    thermalUtilisation,
    zoneInjections,
    zoneGeneration,
    zoneGenerationByType,
    zoneDemand,
    dispatchDetails,
    validationInfo
  };
}

/**
 * Calculate national average wind CF from current generation mix
 * This is used to determine dispatch blend (national vs local-first)
 */
function calculateNationalWindCFFromGeneration(zoneGenerationByType, climatology, season, windPercentile) {
  let totalWindOutput = 0;
  let totalWindCapacity = 0;

  for (const [zoneId, genByType] of Object.entries(zoneGenerationByType)) {
    // Sum wind output (already weather-scaled)
    const windOnshore = genByType['Wind Onshore'] || 0;
    const windOffshore = genByType['Wind Offshore'] || 0;
    totalWindOutput += windOnshore + windOffshore;

    // Get installed wind capacity for this zone
    // Note: genByType already has weather-adjusted values, so we need to back-calculate capacity
    // or use the climatology directly
  }

  // Get average CF from climatology across zones
  if (climatology?.tnuos_zones) {
    let weightedCF = 0;
    let totalWeight = 0;

    for (const [zoneId, zoneClimate] of Object.entries(climatology.tnuos_zones)) {
      const windCFData = zoneClimate.wind_cf?.[season];
      if (windCFData) {
        const cf = getInterpolatedPercentileSimple(windCFData, windPercentile);
        // Weight by zone's typical wind output
        const zoneWind = (zoneGenerationByType[zoneId]?.['Wind Onshore'] || 0) +
                        (zoneGenerationByType[zoneId]?.['Wind Offshore'] || 0);
        if (zoneWind > 0) {
          weightedCF += cf * zoneWind;
          totalWeight += zoneWind;
        }
      }
    }

    if (totalWeight > 0) {
      return weightedCF / totalWeight;
    }
  }

  // Fallback: estimate from percentile
  // p10 ≈ 0.05, p50 ≈ 0.30, p90 ≈ 0.65
  return 0.05 + (windPercentile / 100) * 0.6;
}

/**
 * Simple percentile lookup (handles both nested and flat structures)
 */
function getInterpolatedPercentileSimple(data, percentile) {
  const key = `p${percentile}`;
  if (data?.percentiles?.[key] !== undefined) return data.percentiles[key];
  if (data?.[key] !== undefined) return data[key];
  return data?.mean || 0.25;
}

/**
 * Compute boundary capability utilisation
 * For each ETYS boundary, sum flows across its crossing links and divide by capability
 *
 * @param {Object} flows - Link flows from power flow: { "GZ1-GZ2": 123.4, ... }
 * @param {Object} boundaryMapping - Boundary link mapping data
 * @param {Object} etysCapabilities - ETYS capabilities by year and scenario
 * @param {number} year - Year for capability lookup
 * @param {string} scenario - Scenario name for capability lookup
 * @returns {Object} { boundaryId: { flow_mw, capability_mw, utilisation_pct }, ... }
 */
function computeBoundaryUtilisation(flows, boundaryMapping, etysCapabilities, year, scenario) {
  const result = {};

  if (!boundaryMapping || !boundaryMapping.boundary_links) {
    return result;
  }

  // Determine if this is a FES or CP30 scenario
  const fesScenarios = ['Holistic Transition', 'Electric Engagement', 'Hydrogen Evolution'];
  const isFES = fesScenarios.includes(scenario);
  const scenarioGroup = isFES ? 'fes24' : 'cp30';

  for (const [capName, boundary] of Object.entries(boundaryMapping.boundary_links)) {
    // Sum absolute flows across all crossing links
    const totalFlow = (boundary.crossing_links || []).reduce((sum, linkId) => {
      return sum + Math.abs(flows[linkId] || 0);
    }, 0);

    // Get capability for this year and scenario from etys_capabilities.json
    let capability = 0;

    if (etysCapabilities && etysCapabilities.boundaries && etysCapabilities.boundaries[capName]) {
      const boundaryData = etysCapabilities.boundaries[capName];
      const scenarioData = boundaryData[scenarioGroup];

      if (scenarioData && scenarioData[scenario]) {
        const capabilityByYear = scenarioData[scenario].Capability;
        capability = capabilityByYear[String(year)] || 0;
      }
    }

    // Fallback to capability_2024_mw if dynamic lookup fails
    if (capability === 0) {
      capability = boundary.capability_2024_mw || 0;
    }

    result[capName] = {
      flow_mw: totalFlow,
      capability_mw: capability,
      utilisation_pct: capability > 0 ? (totalFlow / capability) * 100 : 0,
      crossing_links: boundary.crossing_links || [],
      north_zones: boundary.north_zones || [],
      south_zones: boundary.south_zones || []
    };
  }

  return result;
}

/**
 * Compute thermal utilisation for each link
 *
 * @param {Object} flows - Link flows from power flow: { "GZ1-GZ2": 123.4, ... }
 * @param {Array} links - Network links with capacity_mw
 * @returns {Object} { linkId: { flow_mw, capacity_mw, utilisation_pct }, ... }
 */
function computeThermalUtilisation(flows, links) {
  const result = {};

  for (const link of links) {
    const flow = Math.abs(flows[link.id] || 0);
    const capacity = link.capacity_mw || 0;

    result[link.id] = {
      flow_mw: flow,
      capacity_mw: capacity,
      utilisation_pct: capacity > 0 ? (flow / capacity) * 100 : 0,
      from: link.from,
      to: link.to
    };
  }

  return result;
}

/**
 * Apply plant edits to zone generation
 *
 * Modifies zoneGenerationByType in place based on plant edits.
 * Each plant edit specifies: status (Built/Retired), outputPct (0-100), etc.
 *
 * @param {Object} zoneGenerationByType - { GZ1: { Wind: 100, CCGT: 200 }, ... } - MODIFIED IN PLACE
 * @param {Array} plants - Array of plant data from plants_tnuos.json
 * @param {Object} plantEdits - { plantId: { status, outputPct, _plantType, _baseMW }, ... }
 * @param {Object} fuelToggles - Which fuel types are enabled
 * @param {Object} climatology - Weather data by zone
 * @param {string} season - Current season
 * @param {number} windPercentile - Wind percentile
 * @param {number} solarPercentile - Solar percentile
 * @param {number} year - Current year for capacity scaling
 */
function applyPlantEditsToGeneration(
  zoneGenerationByType,
  plants,
  plantEdits,
  fuelToggles,
  climatology,
  season,
  windPercentile,
  solarPercentile,
  year = 2024
) {
  for (const [plantId, edit] of Object.entries(plantEdits)) {
    // Find the plant in the plants array
    const plant = plants.find(p => (p.project_id || p.project) === plantId);
    if (!plant) continue;

    const zoneId = plant.zone_id;
    const plantType = plant.plant_type;
    // Use plant's actual capacity (no artificial scaling)
    const baseMW = plant.mw_connected || plant.mw_total || 0;

    if (!zoneId || !plantType || !zoneGenerationByType[zoneId]) continue;

    // Skip if fuel type is disabled (already 0 in generation)
    if (fuelToggles[plantType] === false) continue;

    // Calculate original plant contribution (with weather scaling)
    let originalContribution = 0;
    const zoneClimate = climatology[zoneId];

    if (plantType.includes('Wind') && zoneClimate) {
      const windCF = getInterpolatedPercentileSimple(
        zoneClimate.wind_cf?.[season],
        windPercentile
      );
      originalContribution = baseMW * windCF;
    } else if ((plantType.includes('Solar') || plantType.includes('PV')) && zoneClimate) {
      const solarData = zoneClimate.solar_cf?.[season];
      if (solarData) {
        const solarCF = getInterpolatedPercentileSimple(solarData, solarPercentile);
        const daylightFraction = solarData.daylight_fraction || 1.0;
        originalContribution = baseMW * solarCF * daylightFraction;
      }
    } else if (plantType.includes('Nuclear')) {
      // Nuclear: apply 80% availability factor
      originalContribution = baseMW * NUCLEAR_AVAILABILITY_FACTOR;
    } else {
      // Thermal/Hydro/Other: full output
      originalContribution = baseMW;
    }

    // Calculate edited contribution
    let editedContribution = 0;

    if (edit.status === 'Retired') {
      // Retired plants produce nothing
      editedContribution = 0;
    } else {
      // Apply output percentage
      const outputPct = edit.outputPct ?? 100;
      editedContribution = originalContribution * (outputPct / 100);
    }

    // Apply the delta
    const delta = editedContribution - originalContribution;
    zoneGenerationByType[zoneId][plantType] =
      (zoneGenerationByType[zoneId][plantType] || 0) + delta;

    // Ensure non-negative
    if (zoneGenerationByType[zoneId][plantType] < 0) {
      zoneGenerationByType[zoneId][plantType] = 0;
    }
  }
}

/**
 * Apply user-added hypothetical generation nodes to zone generation
 *
 * @param {Object} zoneGenerationByType - { GZ1: { Wind: 100, CCGT: 200 }, ... } - MODIFIED IN PLACE
 * @param {Array} addedNodes - [{ zoneId, plantType, capacityMW, name }, ...]
 * @param {Object} fuelToggles - Which fuel types are enabled
 * @param {Object} climatology - Weather data by zone
 * @param {string} season - Current season
 * @param {number} windPercentile - Wind percentile
 * @param {number} solarPercentile - Solar percentile
 */
function applyAddedNodesToGeneration(
  zoneGenerationByType,
  addedNodes,
  fuelToggles,
  climatology,
  season,
  windPercentile,
  solarPercentile
) {
  for (const node of addedNodes) {
    const { zoneId, plantType, capacityMW } = node;

    if (!zoneId || !plantType || !capacityMW) continue;

    // Skip if fuel type is disabled
    if (fuelToggles[plantType] === false) continue;

    // Ensure zone exists in generation tracking
    if (!zoneGenerationByType[zoneId]) {
      zoneGenerationByType[zoneId] = {};
    }

    // Calculate generation with weather scaling
    let generation = 0;
    const zoneClimate = climatology[zoneId];

    if (plantType.includes('Wind') && zoneClimate) {
      const windCF = getInterpolatedPercentileSimple(
        zoneClimate.wind_cf?.[season],
        windPercentile
      );
      generation = capacityMW * windCF;
    } else if ((plantType.includes('Solar') || plantType.includes('PV')) && zoneClimate) {
      const solarData = zoneClimate.solar_cf?.[season];
      if (solarData) {
        const solarCF = getInterpolatedPercentileSimple(solarData, solarPercentile);
        const daylightFraction = solarData.daylight_fraction || 1.0;
        generation = capacityMW * solarCF * daylightFraction;
      }
    } else {
      // Thermal/Nuclear/Hydro/Battery/Other: full output (CF=1.0)
      generation = capacityMW;
    }

    // Add to zone generation by type
    zoneGenerationByType[zoneId][plantType] =
      (zoneGenerationByType[zoneId][plantType] || 0) + generation;
  }
}

/**
 * Apply user link edits to the network
 *
 * @param {Array} links - Base network links
 * @param {Object} linkEdits - { added: [], removed: [], modified: {} }
 * @returns {Array} Modified links array
 */
function applyLinkEdits(links, linkEdits) {
  if (!linkEdits) return links;

  const { added = [], removed = [], modified = {} } = linkEdits;

  // Start with base links
  let result = [...links];

  // Remove links
  if (removed.length > 0) {
    result = result.filter(link => !removed.includes(link.id));
  }

  // Modify links
  for (const [linkId, mods] of Object.entries(modified)) {
    const linkIndex = result.findIndex(l => l.id === linkId);
    if (linkIndex !== -1) {
      result[linkIndex] = {
        ...result[linkIndex],
        ...mods
      };
    }
  }

  // Add new links
  for (const newLink of added) {
    // Ensure the link has required fields
    result.push({
      id: newLink.id,
      from: newLink.from,
      to: newLink.to,
      capacity_mw: newLink.capacity_mw || 0,
      x_equivalent: newLink.x_equivalent || 0.05,
      isUserAdded: true
    });
  }

  return result;
}
