/**
 * Linear Optimal Power Flow (LOPF) using HiGHS WASM solver
 *
 * Solves: minimise Σ(generator_output × effective_cost)
 * subject to:
 *   - Power balance at each node (gen - demand = net injection)
 *   - DC power flow: flow_ij = (θ_i - θ_j) / x_ij
 *   - Generator limits: min_stable ≤ p_g ≤ p_max
 *   - Boundary flow limits (ETYS capabilities, optional)
 *   - Slack bus: θ_slack = 0
 *
 * The effective cost includes:
 *   - Short-run marginal cost (fuel + carbon + VOM)
 *   - Start-up cost approximation (amortised over assumed 8-hour run)
 *   - Ramp penalty (linear cost adder per MW dispatched)
 *
 * Returns: optimal dispatch, flows, nodal prices (LP duals), constraint costs
 */

/**
 * Solve LOPF dispatch
 *
 * @param {Object} params
 * @param {Object} params.zoneGenerationByType - { zoneId: { plantType: maxMW } }
 * @param {Object} params.zoneDemand - { zoneId: demandMW }
 * @param {Array}  params.links - Network links with { id, from, to, x_equivalent, capacity_mw }
 * @param {Object} params.marginalCosts - Technology cost data from marginal_costs.json
 * @param {Object} params.fuelToggles - { plantType: boolean }
 * @param {Object} [params.boundaryLimits] - Optional: { boundaryId: { crossing_links, capability_mw } }
 * @param {string} [params.slackZone] - Slack bus zone (default: GZ18)
 * @param {Object} [params.highs] - HiGHS solver instance
 * @returns {Object} { dispatch, flows, nodalPrices, totalCost, constraintCost, status }
 */
export function solveLOPF(params) {
  const {
    zoneGenerationByType,
    zoneDemand,
    links,
    marginalCosts,
    fuelToggles = {},
    boundaryLimits = null,
    slackZone = 'GZ18',
    highs = null
  } = params;

  if (!highs) {
    throw new Error('HiGHS solver instance required. Load with: const highs = await highsInit()');
  }

  // Include ALL zones with generation OR demand — zones with only demand are transit/sink
  // nodes that must be in the LP for correct flow modelling
  const zoneSet = new Set([
    ...Object.keys(zoneGenerationByType),
    ...Object.keys(zoneDemand)
  ]);
  const zones = [...zoneSet].sort();
  const nZones = zones.length;
  const zoneIdx = {};
  zones.forEach((z, i) => { zoneIdx[z] = i; });

  // ============================================================
  // Build generator list with costs
  // ============================================================
  const generators = [];
  const START_HOURS = 8; // Amortise start-up cost over assumed 8-hour run

  for (const [zoneId, genByType] of Object.entries(zoneGenerationByType)) {
    for (const [plantType, maxMW] of Object.entries(genByType)) {
      if (fuelToggles[plantType] === false) continue;
      if (maxMW <= 0) continue;

      const costData = marginalCosts?.technologies?.[plantType];
      const srmc = costData?.srmc_gbp_mwh ?? 50; // Default to mid-range if unknown
      const startupPerMW = (costData?.startup_cost_gbp_mw ?? 0) / START_HOURS;
      const rampPenalty = costData?.ramp_penalty_gbp_mw ?? 0;
      const minStablePct = costData?.min_stable_pct ?? 0;
      const mustRun = costData?.must_run ?? false;
      const curtailable = costData?.curtailable ?? true;

      // Effective cost = SRMC + amortised startup + ramp penalty
      const effectiveCost = srmc + startupPerMW + rampPenalty;

      const minMW = mustRun ? maxMW * (minStablePct / 100) : 0;
      const maxDispatch = curtailable ? maxMW : maxMW; // Must-run non-curtailable dispatches at max

      generators.push({
        id: `${zoneId}_${plantType}`,
        zoneId,
        plantType,
        maxMW: maxDispatch,
        minMW: mustRun && !curtailable ? maxMW * (minStablePct / 100) : 0,
        cost: effectiveCost,
        mustRun,
        curtailable
      });
    }
  }

  // Sort by cost for reporting
  generators.sort((a, b) => a.cost - b.cost);

  const nGens = generators.length;

  // ============================================================
  // Build LP problem for HiGHS
  // Variables: p_g (generator outputs), θ_n (voltage angles)
  // ============================================================

  // Variable indices
  // [0..nGens-1]: generator outputs (p_g) in GW
  // [nGens..nGens+nZones-1]: voltage angles (θ_n) in radians
  // [nGens+nZones..]: slack variables for boundary constraints (in GW)
  // Note: nVars updated after boundary constraints are built (need nSlacks count)
  const genOffset = 0;
  const thetaOffset = nGens;

  // Angle bounds: slack bus = 0, others free
  const slackIdx = zoneIdx[slackZone];

  // ============================================================
  // Constraints
  // ============================================================
  // 1. Power balance at each node: Σp_g(at node) - demand = Σflows(leaving node)
  //    gen_MW - Σ b×100 × (θ_i - θ_j) = demand_MW
  //    where b = 100/x_equivalent, and ×100 converts per-unit to MW on 100 MVA base
  //
  // 2. Boundary flow limits (with slack variables for feasibility):
  //    Σ flow across crossing links + s_pos - s_neg ≤ capability
  //    s_pos, s_neg ≥ 0, penalised at 10000 GBP/MWh in objective
  //
  // SCALING: All MW values divided by 1000 (work in GW) to keep coefficients
  // reasonable for the LP solver. Results are scaled back to MW at the end.

  const GW_SCALE = 1000; // Divide MW by this to get GW
  const SLACK_PENALTY = 10000 / GW_SCALE; // 10000 GBP/MWh, scaled to GW units (10,000,000 per GW)

  const constraints2 = [];

  for (let n = 0; n < nZones; n++) {
    const zoneId = zones[n];
    const demand = (zoneDemand[zoneId] || 0) / GW_SCALE; // Convert MW to GW

    const row = {};
    // Generators contribute (scaled to GW via variable bounds, see below)
    for (let g = 0; g < nGens; g++) {
      if (generators[g].zoneId === zoneId) {
        row[genOffset + g] = 1.0;
      }
    }

    // DC power flow in GW: flow = b × 100 × (θ_i - θ_j) MW → divide by GW_SCALE
    // bGW = 100 / x_equivalent * 100 / GW_SCALE
    for (const link of links) {
      const i = zoneIdx[link.from];
      const j = zoneIdx[link.to];
      if (i === undefined || j === undefined) continue;

      const bGW = 100.0 / link.x_equivalent * 100.0 / GW_SCALE;

      if (n === i) {
        row[thetaOffset + i] = (row[thetaOffset + i] || 0) - bGW;
        row[thetaOffset + j] = (row[thetaOffset + j] || 0) + bGW;
      } else if (n === j) {
        row[thetaOffset + i] = (row[thetaOffset + i] || 0) + bGW;
        row[thetaOffset + j] = (row[thetaOffset + j] || 0) - bGW;
      }
    }

    constraints2.push({ row, lower: demand, upper: demand });
  }

  // Per-link thermal flow limits (standard DC-OPF formulation)
  // Constraint: -capacity ≤ b × (θ_i - θ_j) ≤ capacity for each link
  // No slack variables — these are hard constraints (the LP redispatches to respect them)
  for (const link of links) {
    const i = zoneIdx[link.from];
    const j = zoneIdx[link.to];
    if (i === undefined || j === undefined) continue;
    if (!link.capacity_mw || link.capacity_mw <= 0) continue;

    const bGW = 100.0 / link.x_equivalent * 100.0 / GW_SCALE;
    const capGW = link.capacity_mw / GW_SCALE;

    const row = {};
    row[thetaOffset + i] = bGW;
    row[thetaOffset + j] = -bGW;

    constraints2.push({ row, lower: -capGW, upper: capGW });
  }

  // Boundary flow limits with slack variables for feasibility
  // Slack variable indices start after generators and angles
  let nSlacks = 0;
  const slackOffset = nGens + nZones;
  const slackInfo = []; // Track which slacks belong to which boundary

  if (boundaryLimits) {
    for (const [boundaryId, limit] of Object.entries(boundaryLimits)) {
      if (!limit.crossing_links || !limit.capability_mw) continue;

      const cap = limit.capability_mw / GW_SCALE; // Convert to GW
      const row = {};

      for (const linkId of limit.crossing_links) {
        const link = links.find(l => l.id === linkId);
        if (!link) continue;

        const i = zoneIdx[link.from];
        const j = zoneIdx[link.to];
        if (i === undefined || j === undefined) continue;

        const bGW = 100.0 / link.x_equivalent * 100.0 / GW_SCALE;

        // Flow on this link = bGW × (θ_i - θ_j)
        row[thetaOffset + i] = (row[thetaOffset + i] || 0) + bGW;
        row[thetaOffset + j] = (row[thetaOffset + j] || 0) - bGW;
      }

      // Add slack variables: flow + s_pos - s_neg ≤ cap, flow + s_pos - s_neg ≥ -cap
      // s_pos index = slackOffset + nSlacks*2, s_neg index = slackOffset + nSlacks*2 + 1
      const sPosIdx = slackOffset + nSlacks * 2;
      const sNegIdx = slackOffset + nSlacks * 2 + 1;
      slackInfo.push({ boundaryId, sPosIdx, sNegIdx });

      // Constraint: flow + s_pos - s_neg ∈ [-cap, cap]
      const rowWithSlack = { ...row };
      rowWithSlack[sPosIdx] = 1.0;
      rowWithSlack[sNegIdx] = -1.0;
      constraints2.push({ row: rowWithSlack, lower: -cap, upper: cap });

      nSlacks++;
    }
  }

  // ============================================================
  // Now that we know nSlacks, build variable arrays
  // ============================================================
  const nVars = nGens + nZones + nSlacks * 2;

  // Objective: minimise Σ(p_g × cost_g) + SLACK_PENALTY × (s_pos + s_neg)
  // Generator costs are in GBP/MWh but generators are in GW, so cost per GW = cost × GW_SCALE
  const colCost = new Array(nVars).fill(0);
  for (let g = 0; g < nGens; g++) {
    colCost[genOffset + g] = generators[g].cost * GW_SCALE; // GBP/MWh × 1000 = GBP per GW·h
  }
  // Slack variable costs (very high penalty to discourage boundary violations)
  for (const { sPosIdx, sNegIdx } of slackInfo) {
    colCost[sPosIdx] = SLACK_PENALTY * GW_SCALE; // 10,000,000 per GW
    colCost[sNegIdx] = SLACK_PENALTY * GW_SCALE;
  }

  // Variable bounds
  const colLower = new Array(nVars).fill(-Infinity);
  const colUpper = new Array(nVars).fill(Infinity);

  // Generator bounds in GW: minMW/1000 ≤ p_g ≤ maxMW/1000
  for (let g = 0; g < nGens; g++) {
    colLower[genOffset + g] = generators[g].minMW / GW_SCALE;
    colUpper[genOffset + g] = generators[g].maxMW / GW_SCALE;
  }

  // Angle bounds: slack bus = 0, others free
  for (let n = 0; n < nZones; n++) {
    colLower[thetaOffset + n] = (n === slackIdx) ? 0 : -Math.PI;
    colUpper[thetaOffset + n] = (n === slackIdx) ? 0 : Math.PI;
  }

  // Slack variable bounds: s ≥ 0
  for (const { sPosIdx, sNegIdx } of slackInfo) {
    colLower[sPosIdx] = 0;
    colLower[sNegIdx] = 0;
    // Upper bound is Infinity (default)
  }

  // ============================================================
  // Format for HiGHS LP string
  // ============================================================
  let lpStr = 'Minimize\n obj: ';
  const objTerms = [];
  for (let v = 0; v < nVars; v++) {
    if (colCost[v] !== 0) {
      objTerms.push(`${colCost[v] >= 0 ? '+' : ''}${colCost[v]} x${v}`);
    }
  }
  lpStr += objTerms.join(' ') + '\n';

  lpStr += 'Subject To\n';
  for (let c = 0; c < constraints2.length; c++) {
    const con = constraints2[c];
    const terms = [];
    for (const [varIdx, coeff] of Object.entries(con.row)) {
      if (coeff !== 0) {
        terms.push(`${coeff >= 0 ? '+' : ''}${coeff} x${varIdx}`);
      }
    }
    if (terms.length === 0) continue;

    if (con.lower === con.upper) {
      // Equality constraint
      lpStr += ` c${c}: ${terms.join(' ')} = ${con.lower}\n`;
    } else {
      // Range constraint: lower ≤ expr ≤ upper
      // HiGHS LP format doesn't support range directly, split into two
      if (con.lower > -1e10) {
        lpStr += ` c${c}lo: ${terms.join(' ')} >= ${con.lower}\n`;
      }
      if (con.upper < 1e10) {
        lpStr += ` c${c}hi: ${terms.join(' ')} <= ${con.upper}\n`;
      }
    }
  }

  lpStr += 'Bounds\n';
  for (let v = 0; v < nVars; v++) {
    if (colLower[v] === -Infinity && colUpper[v] === Infinity) {
      lpStr += ` x${v} free\n`;
    } else if (colLower[v] === -Infinity) {
      lpStr += ` -inf <= x${v} <= ${colUpper[v]}\n`;
    } else if (colUpper[v] === Infinity) {
      lpStr += ` ${colLower[v]} <= x${v}\n`;
    } else {
      lpStr += ` ${colLower[v]} <= x${v} <= ${colUpper[v]}\n`;
    }
  }

  lpStr += 'End\n';

  // ============================================================
  // Solve
  // ============================================================
  const solution = highs.solve(lpStr);

  if (solution.Status !== 'Optimal') {
    console.warn('LOPF solve status:', solution.Status);
    return {
      status: solution.Status,
      dispatch: {},
      flows: {},
      nodalPrices: {},
      totalCost: 0,
      constraintCost: 0,
      generators
    };
  }

  // ============================================================
  // Extract results (scale back from GW to MW)
  // ============================================================
  const colValues = solution.Columns;

  // Generator dispatch (convert GW back to MW)
  const dispatch = {};
  let totalCost = 0;
  for (let g = 0; g < nGens; g++) {
    const gen = generators[g];
    const outputGW = colValues[`x${genOffset + g}`]?.Primal ?? 0;
    const outputMW = outputGW * GW_SCALE;
    if (!dispatch[gen.zoneId]) dispatch[gen.zoneId] = {};
    dispatch[gen.zoneId][gen.plantType] = (dispatch[gen.zoneId][gen.plantType] || 0) + outputMW;
    totalCost += outputMW * gen.cost;
  }

  // Voltage angles (radians, no scaling needed)
  const angles = {};
  for (let n = 0; n < nZones; n++) {
    angles[zones[n]] = (colValues[`x${thetaOffset + n}`]?.Primal ?? 0) * (180 / Math.PI);
  }

  // Compute flows from angles (in MW)
  const flows = {};
  for (const link of links) {
    const i = zoneIdx[link.from];
    const j = zoneIdx[link.to];
    if (i === undefined || j === undefined) continue;

    const thetaI = colValues[`x${thetaOffset + i}`]?.Primal ?? 0;
    const thetaJ = colValues[`x${thetaOffset + j}`]?.Primal ?? 0;
    const flowMW = (thetaI - thetaJ) * 100.0 / link.x_equivalent * 100.0;
    flows[link.id] = flowMW;
  }

  // Compute constraint cost from slack variables
  let constraintCost = 0;
  const boundaryViolations = {};
  for (const { boundaryId, sPosIdx, sNegIdx } of slackInfo) {
    const sPosGW = colValues[`x${sPosIdx}`]?.Primal ?? 0;
    const sNegGW = colValues[`x${sNegIdx}`]?.Primal ?? 0;
    const violationMW = (sPosGW + sNegGW) * GW_SCALE;
    if (violationMW > 0.1) {
      boundaryViolations[boundaryId] = violationMW;
      constraintCost += violationMW * 10000; // SLACK_PENALTY in original MW terms
    }
  }
  if (Object.keys(boundaryViolations).length > 0) {
    console.warn('LOPF boundary violations (slack used):', boundaryViolations);
  }

  // Nodal prices from constraint duals (power balance constraints are equality, named c0..cN)
  const nodalPrices = {};
  for (let n = 0; n < nZones; n++) {
    const dualName = `c${n}`;
    // Dual is in GW-scaled cost units; convert back to GBP/MWh
    const dual = solution.Rows?.[dualName]?.Dual ?? 0;
    nodalPrices[zones[n]] = dual / GW_SCALE;
  }

  return {
    status: 'Optimal',
    dispatch,
    flows,
    angles,
    nodalPrices,
    totalCost,
    constraintCost,
    boundaryViolations,
    generators: generators.map(g => ({
      id: g.id,
      zone: g.zoneId,
      type: g.plantType,
      maxMW: g.maxMW,
      cost: g.cost,
      dispatched: dispatch[g.zoneId]?.[g.plantType] || 0
    }))
  };
}
