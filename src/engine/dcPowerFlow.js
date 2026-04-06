// DC Power Flow solver using Gaussian elimination with partial pivoting
// Solves for voltage angles and link flows on the GB transmission network

/**
 * Solve DC power flow equations: B·θ = P
 *
 * @param {Array} links - Network links with {id, from, to, x_equivalent}
 * @param {Object} injections - Net power injection per zone (MW): {GZ1: 100, GZ2: -50, ...}
 * @param {string} slackZone - Slack bus zone ID (default: GZ18, London/Thames Valley)
 * @returns {Object} { flows: {linkId: flowMW}, angles: {zoneId: angleDeg}, slackAbsorption: MW }
 */
export function solveDCPF(links, injections, slackZone = "GZ18") {
  // Get all unique zone IDs from injections
  const zones = Object.keys(injections).sort();
  const nZones = zones.length;

  if (nZones === 0) {
    throw new Error("No zones provided in injections");
  }

  // Create zone index mapping
  const zoneToIdx = {};
  zones.forEach((zone, idx) => {
    zoneToIdx[zone] = idx;
  });

  // Build 27×27 bus admittance matrix B (susceptance matrix)
  const B = Array(nZones).fill(0).map(() => Array(nZones).fill(0));

  for (const link of links) {
    const i = zoneToIdx[link.from];
    const j = zoneToIdx[link.to];

    if (i === undefined || j === undefined) {
      console.warn(`Link ${link.id} references unknown zone(s): ${link.from}, ${link.to}`);
      continue;
    }

    // Susceptance b_ij = 1 / x_pu where x_pu = x_percent / 100
    // x_equivalent is stored as percentage (e.g., 1.4523 = 1.4523%)
    // Convert to per-unit: x_pu = x_percent / 100
    const b_ij = 100.0 / link.x_equivalent;

    // Fill admittance matrix
    B[i][j] -= b_ij;  // Off-diagonal (negative)
    B[j][i] -= b_ij;  // Off-diagonal (symmetric)
    B[i][i] += b_ij;  // Diagonal (sum of susceptances)
    B[j][j] += b_ij;  // Diagonal (sum of susceptances)
  }

  // Convert injections from MW to per-unit (100 MVA base)
  const P_pu = zones.map(zone => injections[zone] / 100.0);

  // Remove slack bus row and column to get 26×26 system
  const slackIdx = zoneToIdx[slackZone];
  if (slackIdx === undefined) {
    throw new Error(`Slack zone ${slackZone} not found in injections`);
  }

  const B_reduced = [];
  const P_reduced = [];
  const reducedToFull = []; // Maps reduced index to full index

  for (let i = 0; i < nZones; i++) {
    if (i === slackIdx) continue;

    const row = [];
    for (let j = 0; j < nZones; j++) {
      if (j === slackIdx) continue;
      row.push(B[i][j]);
    }
    B_reduced.push(row);
    P_reduced.push(P_pu[i]);
    reducedToFull.push(i);
  }

  // Solve B_reduced · θ_reduced = P_reduced using Gaussian elimination
  const theta_reduced = gaussianElimination(B_reduced, P_reduced);

  // Reconstruct full angle vector (slack bus angle = 0)
  const theta_pu = Array(nZones).fill(0);
  theta_reduced.forEach((angle, idx) => {
    theta_pu[reducedToFull[idx]] = angle;
  });

  // Convert angles from radians to degrees for output
  const angles = {};
  zones.forEach((zone, idx) => {
    angles[zone] = theta_pu[idx] * (180 / Math.PI);
  });

  // Compute flows on each link: flow_ij = (θ_i - θ_j) / x_pu
  // where x_pu = x_percent / 100
  const flows = {};
  for (const link of links) {
    const i = zoneToIdx[link.from];
    const j = zoneToIdx[link.to];

    if (i === undefined || j === undefined) continue;

    // Flow in per-unit: divide by x_pu = x_percent / 100, equivalent to multiply by 100/x_percent
    const flow_pu = (theta_pu[i] - theta_pu[j]) * 100.0 / link.x_equivalent;

    // Convert to MW (100 MVA base)
    flows[link.id] = flow_pu * 100.0;
  }

  // Calculate slack bus absorption from solved power flows
  // Sum all flows on links connected to slack zone (positive = flow into slack)
  let slackAbsorption = 0;
  for (const link of links) {
    if (link.from === slackZone) {
      // Flow leaving slack zone (positive flow = from→to, so negative for slack)
      slackAbsorption -= flows[link.id] || 0;
    } else if (link.to === slackZone) {
      // Flow entering slack zone
      slackAbsorption += flows[link.id] || 0;
    }
  }

  return {
    flows,
    angles,
    slackAbsorption,
    slackZone
  };
}

/**
 * Gaussian elimination with partial pivoting
 * Solves A·x = b for x
 *
 * @param {Array<Array<number>>} A - Coefficient matrix (modified in-place)
 * @param {Array<number>} b - Right-hand side vector (modified in-place)
 * @returns {Array<number>} Solution vector x
 */
function gaussianElimination(A, b) {
  const n = A.length;

  if (n === 0 || A[0].length !== n || b.length !== n) {
    throw new Error("Invalid matrix dimensions for Gaussian elimination");
  }

  // Make copies to avoid modifying input
  const M = A.map(row => [...row]);
  const rhs = [...b];

  // Forward elimination with partial pivoting
  for (let k = 0; k < n - 1; k++) {
    // Find pivot (largest absolute value in column k, rows k to n-1)
    let maxRow = k;
    let maxVal = Math.abs(M[k][k]);

    for (let i = k + 1; i < n; i++) {
      if (Math.abs(M[i][k]) > maxVal) {
        maxVal = Math.abs(M[i][k]);
        maxRow = i;
      }
    }

    // Swap rows if needed
    if (maxRow !== k) {
      [M[k], M[maxRow]] = [M[maxRow], M[k]];
      [rhs[k], rhs[maxRow]] = [rhs[maxRow], rhs[k]];
    }

    // Check for singular matrix
    if (Math.abs(M[k][k]) < 1e-12) {
      throw new Error(`DC power flow failed: near-singular matrix at row ${k} — network may be disconnected. Check that all zones have at least one transmission link.`);
    }

    // Eliminate column k in rows below
    for (let i = k + 1; i < n; i++) {
      const factor = M[i][k] / M[k][k];
      for (let j = k + 1; j < n; j++) {
        M[i][j] -= factor * M[k][j];
      }
      rhs[i] -= factor * rhs[k];
      M[i][k] = 0; // Explicitly zero out
    }
  }

  // Back substitution
  const x = Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let sum = 0;
    for (let j = i + 1; j < n; j++) {
      sum += M[i][j] * x[j];
    }
    x[i] = (rhs[i] - sum) / M[i][i];
  }

  return x;
}
