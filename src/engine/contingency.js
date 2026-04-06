// N-1 Contingency Analysis - SQSS-style security assessment
// For each link: remove it, re-solve DC power flow, identify worst overloads

import { solveDCPF } from './dcPowerFlow.js';

/**
 * Run N-1 contingency analysis
 *
 * For each link in the network:
 * 1. Remove the link temporarily
 * 2. Re-solve DC power flow with remaining links
 * 3. Record all boundary utilisations and link thermal utilisations
 * 4. Identify the worst-case overloads
 *
 * @param {Object} params - Analysis parameters
 * @param {Array} params.links - Network links with {id, from, to, x_equivalent, capacity_mw}
 * @param {Object} params.injections - Net power injection per zone (MW)
 * @param {string} params.slackZone - Slack bus zone ID
 * @param {Object} params.boundaryMapping - ETYS boundary → crossing links mapping
 * @param {Object} params.etysCapabilities - Boundary capabilities by year/scenario
 * @param {number} params.year - Year for capability lookup
 * @param {string} params.scenario - Scenario name
 * @returns {Object} { results, summary, worstCase }
 */
export function runNMinus1(params) {
  const {
    links,
    injections,
    slackZone = 'GZ18',
    boundaryMapping,
    etysCapabilities,
    year,
    scenario
  } = params;

  const results = [];
  const startTime = performance.now();

  // For each link, test its outage
  for (let i = 0; i < links.length; i++) {
    const removedLink = links[i];

    // Create reduced network (all links except the removed one)
    const reducedLinks = links.filter((_, idx) => idx !== i);

    // Check if network would become disconnected
    const isConnected = checkNetworkConnectivity(reducedLinks, Object.keys(injections));

    if (!isConnected) {
      // Network becomes disconnected - this is a critical contingency
      results.push({
        removedLink: removedLink.id,
        removedLinkFrom: removedLink.from,
        removedLinkTo: removedLink.to,
        removedLinkCapacity: removedLink.capacity_mw,
        isDisconnected: true,
        worstBoundary: null,
        worstBoundaryUtil: Infinity,
        worstLink: null,
        worstLinkUtil: Infinity,
        severity: 'critical',
        boundaryOverloads: [],
        linkOverloads: []
      });
      continue;
    }

    try {
      // Re-solve power flow with reduced network
      const { flows } = solveDCPF(reducedLinks, injections, slackZone);

      // Compute boundary utilisations
      const boundaryUtils = computeBoundaryUtilisation(
        flows,
        boundaryMapping,
        etysCapabilities,
        year,
        scenario
      );

      // Compute thermal utilisations
      const thermalUtils = computeThermalUtilisation(flows, reducedLinks);

      // Find worst boundary overload
      let worstBoundary = null;
      let worstBoundaryUtil = 0;
      const boundaryOverloads = [];

      for (const [boundaryId, data] of Object.entries(boundaryUtils)) {
        if (data.utilisation_pct > worstBoundaryUtil) {
          worstBoundaryUtil = data.utilisation_pct;
          worstBoundary = boundaryId;
        }
        if (data.utilisation_pct > 100) {
          boundaryOverloads.push({
            id: boundaryId,
            utilisation: data.utilisation_pct,
            flow: data.flow_mw,
            capability: data.capability_mw
          });
        }
      }

      // Find worst link overload
      let worstLink = null;
      let worstLinkUtil = 0;
      const linkOverloads = [];

      for (const [linkId, data] of Object.entries(thermalUtils)) {
        if (data.utilisation_pct > worstLinkUtil) {
          worstLinkUtil = data.utilisation_pct;
          worstLink = linkId;
        }
        if (data.utilisation_pct > 100) {
          linkOverloads.push({
            id: linkId,
            utilisation: data.utilisation_pct,
            flow: data.flow_mw,
            capacity: data.capacity_mw
          });
        }
      }

      // Determine severity
      let severity = 'secure';
      if (worstBoundaryUtil > 100 || worstLinkUtil > 100) {
        severity = 'overloaded';
      } else if (worstBoundaryUtil > 90 || worstLinkUtil > 90) {
        severity = 'marginal';
      } else if (worstBoundaryUtil > 80 || worstLinkUtil > 80) {
        severity = 'stressed';
      }

      results.push({
        removedLink: removedLink.id,
        removedLinkFrom: removedLink.from,
        removedLinkTo: removedLink.to,
        removedLinkCapacity: removedLink.capacity_mw,
        isDisconnected: false,
        worstBoundary,
        worstBoundaryUtil,
        worstLink,
        worstLinkUtil,
        severity,
        boundaryOverloads,
        linkOverloads,
        flows,
        boundaryUtils,
        thermalUtils
      });
    } catch (err) {
      // Solver failed - likely singular matrix from disconnected network
      results.push({
        removedLink: removedLink.id,
        removedLinkFrom: removedLink.from,
        removedLinkTo: removedLink.to,
        removedLinkCapacity: removedLink.capacity_mw,
        isDisconnected: true,
        worstBoundary: null,
        worstBoundaryUtil: Infinity,
        worstLink: null,
        worstLinkUtil: Infinity,
        severity: 'critical',
        error: err.message,
        boundaryOverloads: [],
        linkOverloads: []
      });
    }
  }

  const endTime = performance.now();

  // Sort by worst boundary utilisation (descending)
  results.sort((a, b) => b.worstBoundaryUtil - a.worstBoundaryUtil);

  // Calculate summary statistics
  const summary = {
    totalContingencies: results.length,
    secure: results.filter(r => r.severity === 'secure').length,
    stressed: results.filter(r => r.severity === 'stressed').length,
    marginal: results.filter(r => r.severity === 'marginal').length,
    overloaded: results.filter(r => r.severity === 'overloaded').length,
    critical: results.filter(r => r.severity === 'critical').length,
    solveTimeMs: endTime - startTime,
    avgSolveTimeMs: (endTime - startTime) / links.length
  };

  // Find the single worst case (excluding disconnected networks)
  const connectedResults = results.filter(r => !r.isDisconnected);
  const worstCase = connectedResults.length > 0 ? connectedResults[0] : null;

  return {
    results,
    summary,
    worstCase
  };
}

/**
 * Check if network remains connected after removing a link
 * Uses BFS to verify all zones are reachable
 *
 * @param {Array} links - Remaining links
 * @param {Array} zones - All zone IDs
 * @returns {boolean} True if network is connected
 */
function checkNetworkConnectivity(links, zones) {
  if (zones.length === 0) return true;
  if (links.length === 0) return zones.length <= 1;

  // Build adjacency list
  const adjacency = {};
  for (const zone of zones) {
    adjacency[zone] = [];
  }

  for (const link of links) {
    if (adjacency[link.from]) adjacency[link.from].push(link.to);
    if (adjacency[link.to]) adjacency[link.to].push(link.from);
  }

  // BFS from first zone
  const visited = new Set();
  const queue = [zones[0]];
  visited.add(zones[0]);

  while (queue.length > 0) {
    const current = queue.shift();
    for (const neighbor of adjacency[current] || []) {
      if (!visited.has(neighbor)) {
        visited.add(neighbor);
        queue.push(neighbor);
      }
    }
  }

  // Check if all zones are reachable
  return visited.size === zones.length;
}

/**
 * Compute boundary utilisation (simplified version for contingency)
 */
function computeBoundaryUtilisation(flows, boundaryMapping, etysCapabilities, year, scenario) {
  const result = {};

  if (!boundaryMapping || !boundaryMapping.boundary_links) {
    return result;
  }

  const fesScenarios = ['Holistic Transition', 'Electric Engagement', 'Hydrogen Evolution'];
  const isFES = fesScenarios.includes(scenario);
  const scenarioGroup = isFES ? 'fes24' : 'cp30';

  // First pass: compute raw capabilities
  const rawCapabilities = {};
  for (const [capName, boundary] of Object.entries(boundaryMapping.boundary_links)) {
    let capability = 0;
    if (etysCapabilities?.boundaries?.[capName]?.[scenarioGroup]?.[scenario]?.Capability) {
      capability = etysCapabilities.boundaries[capName][scenarioGroup][scenario].Capability[String(year)] || 0;
    }
    if (capability === 0) {
      capability = boundary.capability_2024_mw || 0;
    }
    rawCapabilities[capName] = capability;
  }

  // Effective capability: for shared boundaries, use max of the shared group
  // to avoid artificial inflation at 27-node resolution
  const effectiveCapabilities = { ...rawCapabilities };
  for (const [capName, boundary] of Object.entries(boundaryMapping.boundary_links)) {
    if (boundary.shares_with && boundary.shares_with.length > 0) {
      const groupCaps = [rawCapabilities[capName] || 0];
      for (const peer of boundary.shares_with) {
        if (rawCapabilities[peer] !== undefined) {
          groupCaps.push(rawCapabilities[peer]);
        }
      }
      effectiveCapabilities[capName] = Math.max(...groupCaps);
    }
  }

  for (const [capName, boundary] of Object.entries(boundaryMapping.boundary_links)) {
    const totalFlow = (boundary.crossing_links || []).reduce((sum, linkId) => {
      return sum + Math.abs(flows[linkId] || 0);
    }, 0);

    const capability = effectiveCapabilities[capName];

    result[capName] = {
      flow_mw: totalFlow,
      capability_mw: capability,
      utilisation_pct: capability > 0 ? (totalFlow / capability) * 100 : 0
    };
  }

  return result;
}

/**
 * Compute thermal utilisation for each link
 */
function computeThermalUtilisation(flows, links) {
  const result = {};

  for (const link of links) {
    const flow = Math.abs(flows[link.id] || 0);
    const capacity = link.capacity_mw || 0;

    result[link.id] = {
      flow_mw: flow,
      capacity_mw: capacity,
      utilisation_pct: capacity > 0 ? (flow / capacity) * 100 : 0
    };
  }

  return result;
}

/**
 * Get a human-readable summary of N-1 results
 */
export function formatNMinus1Summary(analysis) {
  const { summary, worstCase } = analysis;

  let text = `N-1 Analysis: ${summary.totalContingencies} contingencies tested in ${summary.solveTimeMs.toFixed(0)}ms\n`;
  text += `  Secure: ${summary.secure} | Stressed: ${summary.stressed} | Marginal: ${summary.marginal}\n`;
  text += `  Overloaded: ${summary.overloaded} | Critical: ${summary.critical}\n`;

  if (worstCase) {
    text += `\nWorst case: Remove ${worstCase.removedLink}\n`;
    text += `  → ${worstCase.worstBoundary} reaches ${worstCase.worstBoundaryUtil.toFixed(1)}%\n`;
    if (worstCase.boundaryOverloads.length > 0) {
      text += `  → ${worstCase.boundaryOverloads.length} boundary overload(s)\n`;
    }
  }

  return text;
}
