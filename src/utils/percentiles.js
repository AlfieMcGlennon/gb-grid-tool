// Percentile interpolation utilities

/**
 * Get percentile key (e.g., "p50")
 */
export function getPercentileKey(percentile) {
  return `p${percentile}`;
}

/**
 * Extract available percentiles from a data object
 * Looks for keys like "p1", "p5", "p10", etc.
 */
function extractAvailablePercentiles(percentileData) {
  if (!percentileData) return [];

  return Object.keys(percentileData)
    .filter(key => key.startsWith('p') && !isNaN(parseInt(key.slice(1))))
    .map(key => parseInt(key.slice(1)))
    .sort((a, b) => a - b);
}

/**
 * Get value from percentile data, with linear interpolation if exact percentile not available
 * Dynamically detects available percentiles from the data itself.
 *
 * @param {Object} percentileData - Object with percentile keys: { p10: 100, p50: 150, p90: 200 }
 * @param {number} percentile - Desired percentile (1-99)
 * @returns {number} Interpolated value
 */
export function getInterpolatedPercentile(percentileData, percentile) {
  if (!percentileData) return 0;

  // Check if exact percentile exists
  const key = getPercentileKey(percentile);
  if (percentileData[key] !== undefined) {
    return percentileData[key];
  }

  // Dynamically detect available percentiles from the data
  const availablePercentiles = extractAvailablePercentiles(percentileData);

  if (availablePercentiles.length === 0) {
    return 0;
  }

  // Find bounding percentiles for interpolation
  let lowerP = null;
  let upperP = null;

  for (const p of availablePercentiles) {
    if (p <= percentile) {
      lowerP = p;
    }
    if (p >= percentile && upperP === null) {
      upperP = p;
      break;
    }
  }

  // Edge cases
  if (lowerP === null) {
    return percentileData[getPercentileKey(availablePercentiles[0])] || 0;
  }
  if (upperP === null) {
    return percentileData[getPercentileKey(availablePercentiles[availablePercentiles.length - 1])] || 0;
  }
  if (lowerP === upperP) {
    return percentileData[getPercentileKey(lowerP)] || 0;
  }

  // Linear interpolation
  const lowerKey = getPercentileKey(lowerP);
  const upperKey = getPercentileKey(upperP);
  const lowerValue = percentileData[lowerKey];
  const upperValue = percentileData[upperKey];

  if (lowerValue === undefined || upperValue === undefined) {
    return 0;
  }

  const fraction = (percentile - lowerP) / (upperP - lowerP);
  return lowerValue + (upperValue - lowerValue) * fraction;
}
