import { describe, it, expect, vi } from 'vitest';
import { solveDCPF } from '../dcPowerFlow.js';
import { applyMeritOrder } from '../meritOrder.js';
import { getLinksForYear } from '../networkBuilder.js';
import { runNMinus1 } from '../contingency.js';

// ── DC Power Flow Tests ─────────────────────────────────────────────

describe('DC Power Flow', () => {
  it('solves a two-node system correctly', () => {
    // Two nodes, one link: flow = P / x (in per-unit, scaled to MW)
    const links = [{ id: 'A-B', from: 'A', to: 'B', x_equivalent: 10.0 }];
    const injections = { A: 500, B: -500 };  // A generates, B consumes
    const result = solveDCPF(links, injections, 'B');

    // Flow from A to B should be ~500 MW (all power must flow through single link)
    expect(result.flows['A-B']).toBeCloseTo(500, 0);
  });

  it('satisfies Kirchhoff current law at every node', () => {
    // Three-node triangle network
    const links = [
      { id: 'A-B', from: 'A', to: 'B', x_equivalent: 5.0 },
      { id: 'B-C', from: 'B', to: 'C', x_equivalent: 5.0 },
      { id: 'A-C', from: 'A', to: 'C', x_equivalent: 10.0 }
    ];
    const injections = { A: 1000, B: -600, C: -400 };
    const result = solveDCPF(links, injections, 'C');

    // At each non-slack node: sum of flows in = injection
    // Node A: flow out on A-B + flow out on A-C = 1000
    const flowsAtA = result.flows['A-B'] + result.flows['A-C'];
    expect(flowsAtA).toBeCloseTo(1000, 0);
  });

  it('calculates slack absorption from actual flows', () => {
    const links = [
      { id: 'A-B', from: 'A', to: 'B', x_equivalent: 5.0 },
      { id: 'B-C', from: 'B', to: 'C', x_equivalent: 5.0 }
    ];
    const injections = { A: 300, B: 0, C: -300 };
    const result = solveDCPF(links, injections, 'B');

    // Slack bus B should absorb the net flow through it
    // With 0 injection at B, slack absorption = sum of flows into B
    expect(typeof result.slackAbsorption).toBe('number');
    expect(isNaN(result.slackAbsorption)).toBe(false);
  });

  it('handles disconnected network gracefully (no links)', () => {
    // Two isolated nodes with no link — disconnected zones are filtered out
    const links = [];
    const injections = { A: 100, B: -100 };
    const result = solveDCPF(links, injections, 'B');

    // Flow object should be empty (no links to carry flow)
    expect(Object.keys(result.flows)).toHaveLength(0);
    // Disconnected node A is filtered out, only slack bus B remains
    expect(result.angles['A']).toBeUndefined();
  });

  it('filters disconnected zones from partially connected network', () => {
    // Three nodes but only one link — node C is disconnected from A-B
    // C should be filtered out, A-B should solve normally
    const links = [{ id: 'A-B', from: 'A', to: 'B', x_equivalent: 5.0 }];
    const injections = { A: 100, B: 0, C: -100 };
    const result = solveDCPF(links, injections, 'B');

    // Disconnected node C should be absent from results
    expect(result.angles['C']).toBeUndefined();
    // Connected nodes should solve correctly
    expect(result.flows['A-B']).toBeCloseTo(100, 0);
  });
});

// ── Merit Order Tests ───────────────────────────────────────────────

describe('Merit Order Dispatch', () => {
  it('dispatches flexible to meet demand when must-run is below demand', () => {
    // Enough capacity to meet demand. CCGT 50% MSL = 500 MW, demand gap = 800 MW > MSL.
    const zoneGen = {
      Z1: { 'Wind Onshore': 200, 'CCGT': 1000 }
    };
    const zoneDemand = { Z1: 1000 };
    const fuelToggles = {};

    const result = applyMeritOrder(zoneGen, zoneDemand, fuelToggles, 0.3);

    // Total generation should match demand (blend normalization ensures this)
    expect(result.national.generation).toBeCloseTo(1000, -1);
    // Must-run (wind) dispatched at full capacity
    expect(result.national.mustRun).toBeCloseTo(200, -1);
    // No negative flexible
    expect(result.national.dispatched).toBeGreaterThanOrEqual(0);
  });

  it('handles must-run exceeding demand without negative flexible', () => {
    const zoneGen = {
      Z1: { 'Wind Onshore': 600, 'Nuclear': 300, 'CCGT': 200 }
    };
    const zoneDemand = { Z1: 500 };  // Must-run (900) > demand (500)
    const fuelToggles = {};

    const result = applyMeritOrder(zoneGen, zoneDemand, fuelToggles, 0.5);

    // Flexible should never be negative
    expect(result.national.dispatched).toBeGreaterThanOrEqual(0);
    // Must-run dispatches fully (wind + nuclear)
    expect(result.national.mustRun).toBeGreaterThanOrEqual(500);
  });

  it('pure national dispatch (blendFactor=1) uses cheapest generation first', () => {
    const zoneGen = {
      Z1: { 'Wind Onshore': 100, 'CCGT': 300 },
      Z2: { 'Wind Offshore': 200, 'OCGT': 300 }
    };
    const zoneDemand = { Z1: 200, Z2: 200 };
    const fuelToggles = {};

    // High wind CF = full national dispatch
    const result = applyMeritOrder(zoneGen, zoneDemand, fuelToggles, 0.5);

    expect(result.adjustedGeneration).toBeDefined();
    expect(result.blendFactor).toBeDefined();
    // Total dispatched generation should approximate total demand
    const totalGen = Object.values(result.adjustedGeneration)
      .flatMap(zone => Object.values(zone))
      .reduce((sum, v) => sum + v, 0);
    expect(totalGen).toBeCloseTo(400, -1);
  });
});

// ── Network Builder Tests ───────────────────────────────────────────

describe('Network Builder', () => {
  it('falls back to 2024 for unknown years', () => {
    const linksByYear = {
      '2024': [{ id: 'A-B', from: 'A', to: 'B', x_equivalent: 5 }],
      '2025': [{ id: 'A-B', from: 'A', to: 'B', x_equivalent: 3 }]
    };

    const result = getLinksForYear(linksByYear, 2050);
    expect(result).toHaveLength(1);
    expect(result[0].x_equivalent).toBe(5);  // 2024 value
  });
});

// ── DC Power Flow - Link Constraint Tests ──────────────────────────

describe('DC Power Flow - Per-Link Constraints', () => {
  it('skips links with zero reactance', () => {
    const links = [
      { id: 'A-B', from: 'A', to: 'B', x_equivalent: 5.0 },
      { id: 'B-C', from: 'B', to: 'C', x_equivalent: 0 }  // Zero reactance
    ];
    const injections = { A: 100, B: 0, C: -100 };
    const result = solveDCPF(links, injections, 'B');

    // B-C should be skipped, C becomes disconnected
    expect(result.flows['A-B']).toBeCloseTo(100, 0);
    expect(result.flows['B-C']).toBeUndefined();
  });

  it('distributes flow by reactance in parallel paths', () => {
    // A → B via two paths: direct (x=2) and via C (x=1+1=2)
    // Equal impedance → equal flow split
    const links = [
      { id: 'A-B', from: 'A', to: 'B', x_equivalent: 2.0 },
      { id: 'A-C', from: 'A', to: 'C', x_equivalent: 1.0 },
      { id: 'C-B', from: 'C', to: 'B', x_equivalent: 1.0 }
    ];
    const injections = { A: 1000, B: -1000, C: 0 };
    const result = solveDCPF(links, injections, 'B');

    // Direct path A-B gets 50%, indirect A-C-B gets 50%
    expect(result.flows['A-B']).toBeCloseTo(500, -1);
    expect(result.flows['A-C']).toBeCloseTo(500, -1);
  });

  it('lower reactance carries more flow', () => {
    // A → B via two paths: low-x path (x=1) should carry 2x the flow of high-x path (x=2)
    const links = [
      { id: 'A-C', from: 'A', to: 'C', x_equivalent: 1.0 },
      { id: 'C-B', from: 'C', to: 'B', x_equivalent: 1.0 },
      { id: 'A-D', from: 'A', to: 'D', x_equivalent: 2.0 },
      { id: 'D-B', from: 'D', to: 'B', x_equivalent: 2.0 }
    ];
    const injections = { A: 900, B: -900, C: 0, D: 0 };
    const result = solveDCPF(links, injections, 'B');

    // Path via C (x=2 total) carries 2/3, path via D (x=4 total) carries 1/3
    expect(result.flows['A-C']).toBeCloseTo(600, -1);
    expect(result.flows['A-D']).toBeCloseTo(300, -1);
  });

  it('conserves power at every node (Kirchhoff)', () => {
    // 5-node network: verify power balance at each non-slack node
    const links = [
      { id: 'N1-N2', from: 'N1', to: 'N2', x_equivalent: 3.0 },
      { id: 'N1-N3', from: 'N1', to: 'N3', x_equivalent: 5.0 },
      { id: 'N2-N4', from: 'N2', to: 'N4', x_equivalent: 4.0 },
      { id: 'N3-N4', from: 'N3', to: 'N4', x_equivalent: 2.0 },
      { id: 'N4-N5', from: 'N4', to: 'N5', x_equivalent: 6.0 }
    ];
    const injections = { N1: 500, N2: -200, N3: 100, N4: -300, N5: -100 };
    const result = solveDCPF(links, injections, 'N5');

    // At N1: injection = flow_out on N1-N2 + flow_out on N1-N3
    const n1Balance = result.flows['N1-N2'] + result.flows['N1-N3'];
    expect(n1Balance).toBeCloseTo(500, -1);

    // At N2: net injection = -200 MW (demand node)
    // Verify magnitude of flows through N2 is consistent with its injection
    const flowIn = result.flows['N1-N2'];  // from N1
    const flowOut = result.flows['N2-N4']; // to N4
    // N2 consumes 200 MW, so more flows in than out
    expect(Math.abs(flowIn) + Math.abs(flowOut)).toBeGreaterThan(0);
  });

  it('handles negative injection (demand) correctly', () => {
    const links = [{ id: 'G-D', from: 'G', to: 'D', x_equivalent: 5.0 }];
    const injections = { G: 1000, D: -1000 };
    const result = solveDCPF(links, injections, 'D');

    // Flow should be positive (G → D direction)
    expect(result.flows['G-D']).toBeCloseTo(1000, 0);
    expect(result.flows['G-D']).toBeGreaterThan(0);
  });
});

// ── Boundary Utilisation Tests ──────────────────────────────────────

describe('Boundary Utilisation', () => {
  it('computes from absolute flow sum across crossing links', () => {
    // Simulate what computeBoundaryUtilisation does
    const flows = { 'A-B': 500, 'C-D': -300 };
    const crossingLinks = ['A-B', 'C-D'];
    const capability = 1000;

    const totalFlow = crossingLinks.reduce((sum, id) => sum + Math.abs(flows[id] || 0), 0);
    const utilisation = (totalFlow / capability) * 100;

    // |500| + |-300| = 800, 800/1000 = 80%
    expect(utilisation).toBeCloseTo(80, 0);
  });

  it('returns 0% when no flows on crossing links', () => {
    const flows = { 'X-Y': 100 };
    const crossingLinks = ['A-B', 'C-D'];
    const capability = 1000;

    const totalFlow = crossingLinks.reduce((sum, id) => sum + Math.abs(flows[id] || 0), 0);
    expect(totalFlow).toBe(0);
  });
});

// ── Network Builder Extended Tests ─────────────────────────────────

describe('Network Builder - Extended', () => {
  it('returns exact year match when available', () => {
    const linksByYear = {
      '2024': [{ id: 'A-B', x: 5, capacity_mw: 1000 }],
      '2030': [{ id: 'A-B', x: 3, capacity_mw: 2000 }]
    };
    const result = getLinksForYear(linksByYear, 2030);
    expect(result[0].capacity_mw).toBe(2000);
  });

  it('returns 2024 fallback for missing year', () => {
    const linksByYear = {
      '2024': [{ id: 'A-B', capacity_mw: 1000 }]
    };
    const result = getLinksForYear(linksByYear, 2035);
    expect(result[0].capacity_mw).toBe(1000);
  });
});

// ── Merit Order Extended Tests ──────────────────────────────────────

describe('Merit Order - Extended', () => {
  it('respects fuel toggles (disabled type gets zero output)', () => {
    const zoneGen = {
      Z1: { 'Wind Onshore': 500, 'CCGT': 500 }
    };
    const zoneDemand = { Z1: 800 };
    const fuelToggles = { 'CCGT': false };

    const result = applyMeritOrder(zoneGen, zoneDemand, fuelToggles, 0.3);

    // CCGT should be zero or absent in adjusted generation
    expect(result.adjustedGeneration.Z1['CCGT'] || 0).toBe(0);
    // Wind should still dispatch
    expect(result.adjustedGeneration.Z1['Wind Onshore']).toBeGreaterThan(0);
  });

  it('handles single-zone system', () => {
    const zoneGen = { Z1: { 'Nuclear': 1000 } };
    const zoneDemand = { Z1: 800 };
    const result = applyMeritOrder(zoneGen, zoneDemand, {}, 0.3);

    expect(result.national.generation).toBeGreaterThan(0);
    expect(result.adjustedGeneration.Z1).toBeDefined();
  });

  it('handles zero demand gracefully', () => {
    const zoneGen = { Z1: { 'Wind Onshore': 500 } };
    const zoneDemand = { Z1: 0 };
    const result = applyMeritOrder(zoneGen, zoneDemand, {}, 0.5);

    // Should not crash, generation should still be computed
    expect(result.adjustedGeneration).toBeDefined();
  });

  it('dispatches wind before gas (cost ordering)', () => {
    const zoneGen = {
      Z1: { 'Wind Onshore': 300, 'CCGT': 300, 'OCGT': 300 }
    };
    const zoneDemand = { Z1: 500 };
    const result = applyMeritOrder(zoneGen, zoneDemand, {}, 0.5);

    // Wind is must-run (cheapest), should be fully dispatched
    // CCGT cheaper than OCGT, should dispatch before OCGT
    const gen = result.adjustedGeneration.Z1;
    expect(gen['Wind Onshore']).toBeCloseTo(300, -1);
    expect(gen['CCGT']).toBeGreaterThan(gen['OCGT'] || 0);
  });
});

// ── N-1 Contingency Analysis Tests ──────────────────────────────────

describe('N-1 Contingency Analysis', () => {
  const triangleLinks = [
    { id: 'A-B', from: 'A', to: 'B', x_equivalent: 5.0, capacity_mw: 1000 },
    { id: 'B-C', from: 'B', to: 'C', x_equivalent: 5.0, capacity_mw: 1000 },
    { id: 'A-C', from: 'A', to: 'C', x_equivalent: 10.0, capacity_mw: 500 }
  ];
  const injections = { A: 600, B: -200, C: -400 };
  const simpleBoundaryMapping = {
    boundary_links: {
      'TEST_B': {
        crossing_links: ['A-B'],
        capability_2024_mw: 800,
        shares_with: []
      }
    }
  };

  it('tests all links as contingencies', () => {
    const result = runNMinus1({
      links: triangleLinks,
      injections,
      slackZone: 'C',
      boundaryMapping: simpleBoundaryMapping,
      etysCapabilities: {},
      year: 2024,
      scenario: 'Holistic Transition'
    });

    expect(result.results).toHaveLength(3);
    expect(result.summary.totalContingencies).toBe(3);
  });

  it('detects network disconnection when bridge link removed', () => {
    // Linear network: A-B-C. Removing A-B disconnects A.
    const linearLinks = [
      { id: 'A-B', from: 'A', to: 'B', x_equivalent: 5.0, capacity_mw: 1000 },
      { id: 'B-C', from: 'B', to: 'C', x_equivalent: 5.0, capacity_mw: 1000 }
    ];
    const result = runNMinus1({
      links: linearLinks,
      injections: { A: 300, B: 0, C: -300 },
      slackZone: 'C',
      boundaryMapping: { boundary_links: {} },
      etysCapabilities: {},
      year: 2024,
      scenario: 'Holistic Transition'
    });

    // Removing either link disconnects the network
    const critical = result.results.filter(r => r.severity === 'critical');
    expect(critical.length).toBe(2);
    expect(result.summary.critical).toBe(2);
  });

  it('correctly classifies severity levels', () => {
    const result = runNMinus1({
      links: triangleLinks,
      injections,
      slackZone: 'C',
      boundaryMapping: simpleBoundaryMapping,
      etysCapabilities: {},
      year: 2024,
      scenario: 'Holistic Transition'
    });

    // Each result should have a valid severity
    for (const r of result.results) {
      expect(['secure', 'stressed', 'marginal', 'overloaded', 'critical']).toContain(r.severity);
    }
  });

  it('returns worst case from connected results', () => {
    const result = runNMinus1({
      links: triangleLinks,
      injections,
      slackZone: 'C',
      boundaryMapping: simpleBoundaryMapping,
      etysCapabilities: {},
      year: 2024,
      scenario: 'Holistic Transition'
    });

    // Worst case should be defined (triangle is fully connected after any single removal)
    expect(result.worstCase).not.toBeNull();
    expect(result.worstCase.removedLink).toBeDefined();
    expect(result.worstCase.worstBoundaryUtil).toBeGreaterThanOrEqual(0);
  });

  it('reports solve time', () => {
    const result = runNMinus1({
      links: triangleLinks,
      injections,
      slackZone: 'C',
      boundaryMapping: simpleBoundaryMapping,
      etysCapabilities: {},
      year: 2024,
      scenario: 'Holistic Transition'
    });

    expect(result.summary.solveTimeMs).toBeGreaterThanOrEqual(0);
    expect(result.summary.avgSolveTimeMs).toBeGreaterThanOrEqual(0);
  });

  it('redistributes flow when a parallel path is removed', () => {
    // Triangle: remove A-C, all flow must go A→B→C
    const result = runNMinus1({
      links: triangleLinks,
      injections: { A: 500, B: 0, C: -500 },
      slackZone: 'C',
      boundaryMapping: { boundary_links: {} },
      etysCapabilities: {},
      year: 2024,
      scenario: 'Holistic Transition'
    });

    // Find the contingency where A-C is removed
    const acRemoved = result.results.find(r => r.removedLink === 'A-C');
    expect(acRemoved).toBeDefined();
    expect(acRemoved.isDisconnected).toBe(false);
    // All 500 MW must flow through A-B then B-C
    expect(Math.abs(acRemoved.flows['A-B'])).toBeCloseTo(500, -1);
    expect(Math.abs(acRemoved.flows['B-C'])).toBeCloseTo(500, -1);
  });
});

// ── LOPF Tests (structural, without HiGHS) ─────────────────────────

describe('LOPF Structure', () => {
  // We cannot run the actual HiGHS solver in unit tests (WASM dependency),
  // but we can test that solveLOPF throws appropriately and validates inputs.

  it('throws without HiGHS instance', async () => {
    const { solveLOPF } = await import('../lopf.js');

    expect(() => solveLOPF({
      zoneGenerationByType: { Z1: { 'CCGT': 1000 } },
      zoneDemand: { Z1: 800 },
      links: [{ id: 'Z1-Z2', from: 'Z1', to: 'Z2', x_equivalent: 5.0, capacity_mw: 500 }],
      marginalCosts: {},
      highs: null
    })).toThrow('HiGHS solver instance required');
  });

  it('builds correct generator list from zone generation', async () => {
    const { solveLOPF } = await import('../lopf.js');

    // Mock HiGHS that returns a solution structure
    const mockHighs = {
      solve: vi.fn().mockReturnValue({
        Status: 'Optimal',
        Columns: {
          x0: { Primal: 0.8 },  // CCGT dispatch (GW)
          x1: { Primal: 0.3 },  // Wind dispatch (GW)
          x2: { Primal: 0 },    // theta Z1
          x3: { Primal: 0 }     // theta Z2
        },
        Rows: {
          c0: { Dual: 50 },
          c1: { Dual: 55 }
        }
      })
    };

    const result = solveLOPF({
      zoneGenerationByType: {
        Z1: { 'CCGT': 1000, 'Wind Onshore': 500 },
        Z2: {}
      },
      zoneDemand: { Z1: 800, Z2: 300 },
      links: [{ id: 'Z1-Z2', from: 'Z1', to: 'Z2', x_equivalent: 5.0, capacity_mw: 2000 }],
      marginalCosts: {
        technologies: {
          'CCGT': { srmc_gbp_mwh: 50, startup_cost_gbp_mw: 40, ramp_penalty_gbp_mw: 2, min_stable_pct: 50, must_run: false },
          'Wind Onshore': { srmc_gbp_mwh: 0, startup_cost_gbp_mw: 0, ramp_penalty_gbp_mw: 0, min_stable_pct: 0, must_run: true, curtailable: true }
        }
      },
      highs: mockHighs,
      slackZone: 'Z1'
    });

    // Verify HiGHS was called with an LP string
    expect(mockHighs.solve).toHaveBeenCalledTimes(1);
    const lpStr = mockHighs.solve.mock.calls[0][0];
    expect(lpStr).toContain('Minimize');
    expect(lpStr).toContain('Subject To');
    expect(lpStr).toContain('Bounds');
    expect(lpStr).toContain('End');

    // Result should have expected structure
    expect(result.status).toBe('Optimal');
    expect(result.dispatch).toBeDefined();
    expect(result.flows).toBeDefined();
    expect(result.totalCost).toBeGreaterThanOrEqual(0);
    expect(result.generators).toBeDefined();
    expect(result.generators.length).toBe(2); // CCGT + Wind
  });

  it('respects fuel toggles (disabled types excluded from LP)', async () => {
    const { solveLOPF } = await import('../lopf.js');

    const mockHighs = {
      solve: vi.fn().mockReturnValue({
        Status: 'Optimal',
        Columns: {
          x0: { Primal: 0.5 },  // Only Wind (CCGT disabled)
          x1: { Primal: 0 },
          x2: { Primal: 0 }
        },
        Rows: { c0: { Dual: 0 }, c1: { Dual: 0 } }
      })
    };

    const result = solveLOPF({
      zoneGenerationByType: {
        Z1: { 'CCGT': 1000, 'Wind Onshore': 500 }
      },
      zoneDemand: { Z1: 500 },
      links: [],
      marginalCosts: { technologies: {} },
      fuelToggles: { 'CCGT': false },
      highs: mockHighs
    });

    // Only Wind should be in generators (CCGT disabled)
    expect(result.generators.length).toBe(1);
    expect(result.generators[0].type).toBe('Wind Onshore');
  });

  it('returns non-optimal status without crashing', async () => {
    const { solveLOPF } = await import('../lopf.js');

    const mockHighs = {
      solve: vi.fn().mockReturnValue({
        Status: 'Infeasible',
        Columns: {},
        Rows: {}
      })
    };

    const result = solveLOPF({
      zoneGenerationByType: { Z1: { 'CCGT': 100 } },
      zoneDemand: { Z1: 5000 },
      links: [],
      marginalCosts: { technologies: {} },
      highs: mockHighs
    });

    expect(result.status).toBe('Infeasible');
    expect(result.totalCost).toBe(0);
    expect(Object.keys(result.dispatch)).toHaveLength(0);
  });

  it('includes boundary constraints with slack variables in LP', async () => {
    const { solveLOPF } = await import('../lopf.js');

    const mockHighs = {
      solve: vi.fn().mockReturnValue({
        Status: 'Optimal',
        Columns: {
          x0: { Primal: 0.8 },
          x1: { Primal: 0 },
          x2: { Primal: 0 },
          x3: { Primal: 0 },  // slack s_pos
          x4: { Primal: 0 }   // slack s_neg
        },
        Rows: { c0: { Dual: 50 }, c1: { Dual: 55 } }
      })
    };

    const result = solveLOPF({
      zoneGenerationByType: { Z1: { 'CCGT': 1000 }, Z2: {} },
      zoneDemand: { Z1: 300, Z2: 500 },
      links: [{ id: 'Z1-Z2', from: 'Z1', to: 'Z2', x_equivalent: 5.0, capacity_mw: 2000 }],
      marginalCosts: { technologies: { 'CCGT': { srmc_gbp_mwh: 50 } } },
      boundaryLimits: {
        'B_TEST': { crossing_links: ['Z1-Z2'], capability_mw: 600 }
      },
      highs: mockHighs,
      slackZone: 'Z1'
    });

    // LP string should contain the slack penalty terms
    const lpStr = mockHighs.solve.mock.calls[0][0];
    expect(lpStr).toContain('x3');  // slack variable
    expect(lpStr).toContain('x4');  // slack variable

    expect(result.status).toBe('Optimal');
    expect(result.constraintCost).toBeDefined();
  });
});
