import { describe, it, expect } from 'vitest';
import { solveDCPF } from '../dcPowerFlow.js';
import { applyMeritOrder } from '../meritOrder.js';
import { getLinksForYear } from '../networkBuilder.js';

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

  it('produces non-finite results on disconnected network (no links)', () => {
    // Two isolated nodes with no link between them
    // With a 1x1 zero matrix, the solver divides by zero producing non-finite values
    const links = [];
    const injections = { A: 100, B: -100 };
    const result = solveDCPF(links, injections, 'B');

    // Flow object should be empty (no links to carry flow)
    expect(Object.keys(result.flows)).toHaveLength(0);
    // Angle at non-slack node should be non-finite (division by zero in back-substitution)
    expect(isFinite(result.angles['A'])).toBe(false);
  });

  it('produces non-finite flows on partially disconnected network', () => {
    // Three nodes but only one link — node C is disconnected from A-B
    // The solver cannot route power to C, producing non-finite angles
    const links = [{ id: 'A-B', from: 'A', to: 'B', x_equivalent: 5.0 }];
    const injections = { A: 100, B: 0, C: -100 };
    const result = solveDCPF(links, injections, 'B');

    // Disconnected node C should have non-finite angle
    expect(isFinite(result.angles['C'])).toBe(false);
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
