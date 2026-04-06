// Merit order dispatch - Wind-dependent blended dispatch
// Blends between national and local-first dispatch based on wind CF

/**
 * Merit order priority (lowest to highest marginal cost)
 */
const MERIT_ORDER_PRIORITY = {
  'Wind Onshore': { priority: 1, mustRun: true, name: 'Wind', minStablePct: 0 },
  'Wind Offshore': { priority: 1, mustRun: true, name: 'Wind', minStablePct: 0 },
  'Solar': { priority: 2, mustRun: true, name: 'Solar', minStablePct: 0 },
  'Solar/PV': { priority: 2, mustRun: true, name: 'Solar', minStablePct: 0 },
  'PV Array (Photo Voltaic/solar)': { priority: 2, mustRun: true, name: 'Solar', minStablePct: 0 },
  'Nuclear': { priority: 3, mustRun: true, name: 'Nuclear', minStablePct: 50 },
  'Hydro': { priority: 4, mustRun: false, name: 'Hydro', minStablePct: 0 },
  'Pump Storage': { priority: 4, mustRun: false, name: 'Hydro', minStablePct: 0 },
  'Biomass': { priority: 5, mustRun: false, name: 'Biomass', minStablePct: 40 },
  'CCGT (Combined Cycle Gas Turbine)': { priority: 6, mustRun: false, name: 'CCGT', minStablePct: 50 },
  'CCGT': { priority: 6, mustRun: false, name: 'CCGT', minStablePct: 50 },
  'OCGT (Open Cycle Gas Turbine)': { priority: 7, mustRun: false, name: 'OCGT', minStablePct: 20 },
  'OCGT': { priority: 7, mustRun: false, name: 'OCGT', minStablePct: 20 },
  // Interconnectors are handled separately - not in merit order stack
  'Interconnector': { priority: 0, mustRun: false, name: 'Interconnector', isInterconnector: true, minStablePct: 0 }
};

// Wind CF thresholds for dispatch blending (from ERA5 distribution analysis)
const WIND_CF_NATIONAL_THRESHOLD = 0.35;  // Above this: full national dispatch
const WIND_CF_LOCAL_THRESHOLD = 0.15;     // Below this: full local-first dispatch

/**
 * Apply wind-dependent blended merit order dispatch
 *
 * CRITICAL: This dispatches generation using a blend between two modes:
 * - High wind (CF >= 0.35): National dispatch - cheapest generation dispatched first nationally
 * - Low wind (CF <= 0.15): Local-first dispatch - zones fill local demand before exporting
 * - Middle: Linear blend between the two
 *
 * Note: Final curtailment (if generation > demand) happens in scenarioRunner.js
 * AFTER interconnectors are added. This function only does merit-order dispatch.
 *
 * @param {Object} zoneGenerationByType - Generation by zone and type: { GZ1: { Wind: 100, CCGT: 200 }, ... }
 * @param {Object} zoneDemand - Demand per zone: { GZ1: 150, ... }
 * @param {Object} fuelToggles - Which fuel types are enabled: { Wind: true, CCGT: false, ... }
 * @param {number} nationalWindCF - National average wind capacity factor (0-1)
 * @returns {Object} { adjustedGeneration, dispatchInfo, national, blendFactor }
 */
export function applyMeritOrder(zoneGenerationByType, zoneDemand, fuelToggles, nationalWindCF = 0.25) {
  // Calculate blend factor: 0 = local-first, 1 = national
  let blendFactor;
  if (nationalWindCF >= WIND_CF_NATIONAL_THRESHOLD) {
    blendFactor = 1.0;  // Full national dispatch
  } else if (nationalWindCF <= WIND_CF_LOCAL_THRESHOLD) {
    blendFactor = 0.0;  // Full local-first dispatch
  } else {
    // Linear interpolation between thresholds
    blendFactor = (nationalWindCF - WIND_CF_LOCAL_THRESHOLD) /
                  (WIND_CF_NATIONAL_THRESHOLD - WIND_CF_LOCAL_THRESHOLD);
  }

  // Get both dispatch results
  const nationalResult = dispatchNational(zoneGenerationByType, zoneDemand, fuelToggles);
  const localResult = dispatchLocalFirst(zoneGenerationByType, zoneDemand, fuelToggles);

  // Blend the results
  const blendedGeneration = blendDispatch(
    nationalResult.dispatched,
    localResult.dispatched,
    blendFactor,
    Object.keys(zoneGenerationByType),
    zoneDemand
  );

  // Calculate national demand
  const nationalDemand = Object.values(zoneDemand).reduce((sum, d) => sum + d, 0);

  // Calculate zone generation totals and dispatch info
  const zoneGeneration = {};
  const dispatchInfo = {};

  for (const zoneId of Object.keys(zoneGenerationByType)) {
    const genByType = blendedGeneration[zoneId] || {};
    const demand = zoneDemand[zoneId] || 0;
    const generation = Object.values(genByType).reduce((sum, v) => sum + v, 0);
    const netInjection = generation - demand;

    zoneGeneration[zoneId] = generation;

    // Calculate must-run and flexible for this zone
    let zoneMustRun = 0;
    let zoneFlexible = 0;
    const plantStatus = {};

    for (const [plantType, dispatchedMW] of Object.entries(genByType)) {
      const priorityInfo = MERIT_ORDER_PRIORITY[plantType];
      if (priorityInfo?.mustRun) {
        zoneMustRun += dispatchedMW;
        plantStatus[plantType] = 'must-run';
      } else {
        zoneFlexible += dispatchedMW;
        const available = zoneGenerationByType[zoneId]?.[plantType] || 0;
        plantStatus[plantType] = dispatchedMW >= available * 0.99 ? 'fully-dispatched' : 'partially-dispatched';
      }
    }

    dispatchInfo[zoneId] = {
      demand,
      generation,
      netInjection,
      mustRun: zoneMustRun,
      flexible: zoneFlexible,
      plantStatus,
      isExporting: netInjection > 100,
      isImporting: netInjection < -100
    };
  }

  // Calculate national totals
  const nationalGeneration = Object.values(zoneGeneration).reduce((sum, g) => sum + g, 0);
  const nationalMustRun = Object.values(dispatchInfo).reduce((sum, z) => sum + z.mustRun, 0);
  const nationalFlexible = Object.values(dispatchInfo).reduce((sum, z) => sum + z.flexible, 0);

  return {
    adjustedGeneration: blendedGeneration,
    dispatchInfo,
    national: {
      demand: nationalDemand,
      generation: nationalGeneration,
      mustRun: nationalMustRun,
      dispatched: nationalFlexible,
      imbalance: nationalGeneration - nationalDemand,
      unmetDemand: Math.max(0, nationalDemand - nationalGeneration)
    },
    blendFactor,
    windCF: nationalWindCF,
    dispatchMode: blendFactor > 0.5 ? 'national-biased' : 'local-biased'
  };
}

/**
 * National dispatch - all generation ranked nationally by merit order
 * Cheapest dispatched first until national demand met
 * Produces large inter-zonal flows as Scotland's wind displaces England's gas
 */
function dispatchNational(zoneGenerationByType, zoneDemand, fuelToggles) {
  const nationalDemand = Object.values(zoneDemand).reduce((sum, d) => sum + d, 0);

  // Collect all generation into a national merit stack
  const nationalStack = [];

  for (const [zoneId, genByType] of Object.entries(zoneGenerationByType)) {
    for (const [plantType, capacity] of Object.entries(genByType)) {
      if (fuelToggles[plantType] === false) continue;
      if (capacity <= 0) continue;

      const priorityInfo = MERIT_ORDER_PRIORITY[plantType];
      if (!priorityInfo || priorityInfo.isInterconnector) continue;

      nationalStack.push({
        zoneId,
        plantType,
        capacity,
        priority: priorityInfo.priority,
        mustRun: priorityInfo.mustRun
      });
    }
  }

  // Sort by merit order priority
  nationalStack.sort((a, b) => a.priority - b.priority);

  // Dispatch must-run first, then flexible in order
  const dispatched = {};
  let nationalMustRun = 0;
  let nationalRemaining = nationalDemand;

  // Initialize all zones
  for (const zoneId of Object.keys(zoneGenerationByType)) {
    dispatched[zoneId] = {};
  }

  // Dispatch must-run generation (wind, solar, nuclear)
  for (const gen of nationalStack.filter(g => g.mustRun)) {
    dispatched[gen.zoneId][gen.plantType] = gen.capacity;
    nationalMustRun += gen.capacity;
  }

  nationalRemaining = nationalDemand - nationalMustRun;

  // Dispatch flexible generation in merit order with MSL enforcement
  // If remaining demand < MSL for a unit, either dispatch at MSL (accepting oversupply)
  // or skip to a smaller/more flexible unit
  for (const gen of nationalStack.filter(g => !g.mustRun)) {
    if (nationalRemaining <= 0) break;

    const priorityInfo = MERIT_ORDER_PRIORITY[gen.plantType];
    const minStablePct = priorityInfo?.minStablePct || 0;
    const minStableMW = gen.capacity * (minStablePct / 100);

    if (minStableMW > 0 && nationalRemaining < minStableMW) {
      // Remaining demand is below this unit's MSL.
      // Skip it — a smaller or more flexible unit may fit.
      // (In reality this unit would either stay off or run at MSL with excess curtailed)
      continue;
    }

    // Dispatch between MSL and capacity
    const dispatchAmount = Math.min(gen.capacity, Math.max(minStableMW, nationalRemaining));
    dispatched[gen.zoneId][gen.plantType] = dispatchAmount;
    nationalRemaining -= dispatchAmount;
  }

  return { dispatched, mustRun: nationalMustRun, flexible: Math.max(0, nationalDemand - nationalMustRun) };
}

/**
 * Local-first dispatch - zones fill local demand before exporting
 * Must-run dispatches everywhere, then flexible fills local gap first
 * Produces smaller inter-zonal flows
 */
function dispatchLocalFirst(zoneGenerationByType, zoneDemand, fuelToggles) {
  const dispatched = {};

  // First pass: dispatch must-run everywhere and calculate local gaps
  const zoneGaps = {};
  let totalMustRun = 0;

  for (const [zoneId, genByType] of Object.entries(zoneGenerationByType)) {
    dispatched[zoneId] = {};
    let zoneMustRun = 0;

    for (const [plantType, capacity] of Object.entries(genByType)) {
      if (fuelToggles[plantType] === false) continue;
      if (capacity <= 0) continue;

      const priorityInfo = MERIT_ORDER_PRIORITY[plantType];
      if (!priorityInfo || priorityInfo.isInterconnector) continue;

      if (priorityInfo.mustRun) {
        dispatched[zoneId][plantType] = capacity;
        zoneMustRun += capacity;
      }
    }

    totalMustRun += zoneMustRun;
    const demand = zoneDemand[zoneId] || 0;
    zoneGaps[zoneId] = demand - zoneMustRun;  // Positive = needs more, negative = surplus
  }

  // Second pass: dispatch flexible to fill local gaps first
  for (const [zoneId, genByType] of Object.entries(zoneGenerationByType)) {
    let localGap = Math.max(0, zoneGaps[zoneId]);
    if (localGap <= 0) continue;

    // Get flexible generation for this zone, sorted by priority
    const localFlexible = [];
    for (const [plantType, capacity] of Object.entries(genByType)) {
      if (fuelToggles[plantType] === false) continue;
      if (capacity <= 0) continue;

      const priorityInfo = MERIT_ORDER_PRIORITY[plantType];
      if (!priorityInfo || priorityInfo.mustRun || priorityInfo.isInterconnector) continue;

      localFlexible.push({ plantType, capacity, priority: priorityInfo.priority });
    }

    localFlexible.sort((a, b) => a.priority - b.priority);

    // Fill local gap with MSL enforcement
    for (const gen of localFlexible) {
      if (localGap <= 0) break;

      const priorityInfo = MERIT_ORDER_PRIORITY[gen.plantType];
      const minStableMW = gen.capacity * ((priorityInfo?.minStablePct || 0) / 100);

      if (minStableMW > 0 && localGap < minStableMW) {
        continue; // Skip — local gap too small for this unit's MSL
      }

      const dispatchAmount = Math.min(gen.capacity, Math.max(minStableMW, localGap));
      dispatched[zoneId][gen.plantType] = dispatchAmount;
      localGap -= dispatchAmount;
      zoneGaps[zoneId] -= dispatchAmount;
    }
  }

  // Third pass: if there's still unmet demand, dispatch remaining flexible nationally
  let totalUnmet = Object.values(zoneGaps).reduce((sum, g) => sum + Math.max(0, g), 0);

  if (totalUnmet > 0) {
    // Collect remaining flexible capacity
    const remainingFlexible = [];
    for (const [zoneId, genByType] of Object.entries(zoneGenerationByType)) {
      for (const [plantType, capacity] of Object.entries(genByType)) {
        if (fuelToggles[plantType] === false) continue;

        const priorityInfo = MERIT_ORDER_PRIORITY[plantType];
        if (!priorityInfo || priorityInfo.mustRun || priorityInfo.isInterconnector) continue;

        const alreadyDispatched = dispatched[zoneId][plantType] || 0;
        const remaining = capacity - alreadyDispatched;

        if (remaining > 0) {
          remainingFlexible.push({
            zoneId,
            plantType,
            remaining,
            priority: priorityInfo.priority
          });
        }
      }
    }

    remainingFlexible.sort((a, b) => a.priority - b.priority);

    // Dispatch remaining to meet national shortfall with MSL
    for (const gen of remainingFlexible) {
      if (totalUnmet <= 0) break;

      const priorityInfo = MERIT_ORDER_PRIORITY[gen.plantType];
      const minStablePct = priorityInfo?.minStablePct || 0;
      // For units already partially dispatched, MSL is already met
      const alreadyOn = (dispatched[gen.zoneId]?.[gen.plantType] || 0) > 0;
      const minMW = alreadyOn ? 0 : gen.remaining * (minStablePct / 100);

      if (minMW > 0 && totalUnmet < minMW) {
        continue; // Skip — not enough unmet demand for this unit's MSL
      }

      const dispatchAmount = Math.min(gen.remaining, Math.max(minMW, totalUnmet));
      dispatched[gen.zoneId][gen.plantType] =
        (dispatched[gen.zoneId][gen.plantType] || 0) + dispatchAmount;
      totalUnmet -= dispatchAmount;
    }
  }

  return { dispatched, mustRun: totalMustRun };
}

/**
 * Blend two dispatch results based on blend factor
 * @param {Object} national - National dispatch result { zoneId: { plantType: MW } }
 * @param {Object} local - Local-first dispatch result
 * @param {number} blendFactor - 0 = pure local, 1 = pure national
 * @param {Array} zoneIds - All zone IDs
 * @param {Object} zoneDemand - Demand per zone: { GZ1: 150, ... }
 * @returns {Object} Blended dispatch { zoneId: { plantType: MW } }
 */
function blendDispatch(national, local, blendFactor, zoneIds, zoneDemand) {
  const blended = {};

  for (const zoneId of zoneIds) {
    blended[zoneId] = {};
    const nationalZone = national[zoneId] || {};
    const localZone = local[zoneId] || {};

    // Get all plant types from both dispatches
    const allPlantTypes = new Set([
      ...Object.keys(nationalZone),
      ...Object.keys(localZone)
    ]);

    for (const plantType of allPlantTypes) {
      const nationalMW = nationalZone[plantType] || 0;
      const localMW = localZone[plantType] || 0;

      // Linear blend
      blended[zoneId][plantType] = nationalMW * blendFactor + localMW * (1 - blendFactor);
    }
  }

  // Post-blend normalization: ensure total generation matches total demand
  // Blending can introduce small mismatches; scale flexible generation to correct
  let totalBlendedGen = 0;
  let totalDemand = 0;
  let totalFlexible = 0;

  for (const zoneId of zoneIds) {
    for (const [plantType, mw] of Object.entries(blended[zoneId] || {})) {
      totalBlendedGen += mw;
      const priorityInfo = MERIT_ORDER_PRIORITY[plantType];
      if (priorityInfo && !priorityInfo.mustRun && !priorityInfo.isInterconnector) {
        totalFlexible += mw;
      }
    }
    totalDemand += (zoneDemand[zoneId] || 0);
  }

  const mismatch = totalBlendedGen - totalDemand;
  if (Math.abs(mismatch) > 0.1 && totalFlexible > 0) {
    // Scale all flexible (non-must-run) generation proportionally to match demand
    const scaleFactor = Math.max(0, (totalFlexible - mismatch) / totalFlexible);
    for (const zoneId of zoneIds) {
      for (const [plantType, mw] of Object.entries(blended[zoneId] || {})) {
        const priorityInfo = MERIT_ORDER_PRIORITY[plantType];
        if (priorityInfo && !priorityInfo.mustRun && !priorityInfo.isInterconnector) {
          blended[zoneId][plantType] = mw * scaleFactor;
        }
      }
    }
  }

  return blended;
}

