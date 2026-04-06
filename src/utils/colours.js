// Utilisation to colour mapping for boundaries and zones
// Light professional theme - softer, muted colours
// Supports color blind mode (blue-orange) and standard mode (green-red)

/**
 * Get colour for boundary utilisation percentage
 * Standard: Green → Lime → Amber → Orange → Red (muted for light theme)
 * Color blind: Blue → Yellow → Orange
 *
 * @param {number} utilisationPct - Utilisation percentage (0-100+)
 * @param {boolean} colorBlindMode - Use color blind friendly palette
 * @returns {string} Hex colour code
 */
export function getUtilisationColour(utilisationPct, colorBlindMode = false) {
  if (colorBlindMode) {
    // Blue-orange scale for color blind users
    if (utilisationPct < 40) {
      return '#3b82f6'; // Blue-500 (0-40%)
    } else if (utilisationPct < 60) {
      return '#60a5fa'; // Blue-400 (40-60%)
    } else if (utilisationPct < 75) {
      return '#f59e0b'; // Amber-500 (60-75%)
    } else if (utilisationPct < 85) {
      return '#ea580c'; // Orange-600 (75-85%)
    } else {
      return '#dc2626'; // Red-600 (85%+)
    }
  } else {
    // Muted green-red scale for light theme
    if (utilisationPct < 40) {
      return '#22c55e'; // Green-500 (0-40%)
    } else if (utilisationPct < 60) {
      return '#84cc16'; // Lime-500 (40-60%)
    } else if (utilisationPct < 75) {
      return '#f59e0b'; // Amber-500 (60-75%)
    } else if (utilisationPct < 85) {
      return '#f97316'; // Orange-500 (75-85%)
    } else if (utilisationPct < 100) {
      return '#ef4444'; // Red-500 (85-100%)
    } else {
      return '#dc2626'; // Red-600 (>100%)
    }
  }
}

/**
 * Get line weight for boundary based on utilisation
 *
 * @param {number} utilisationPct - Utilisation percentage (0-100+)
 * @returns {number} Line weight in pixels
 */
export function getUtilisationWeight(utilisationPct) {
  if (utilisationPct < 40) {
    return 2;
  } else if (utilisationPct < 60) {
    return 2.5;
  } else if (utilisationPct < 75) {
    return 3;
  } else if (utilisationPct < 85) {
    return 3.5;
  } else {
    return 4; // Heavy line for high utilisation
  }
}

/**
 * Get colour for zone net injection
 * Standard: Green = export, Red = import, Grey = balanced (muted for light theme)
 * Color blind: Blue = export, Orange = import, Grey = balanced
 *
 * @param {number} netInjectionMW - Net injection in MW (generation - demand)
 * @param {boolean} colorBlindMode - Use color blind friendly palette
 * @returns {string} Hex colour code
 */
export function getInjectionColour(netInjectionMW, colorBlindMode = false) {
  if (colorBlindMode) {
    // Blue-orange scale for color blind users
    if (netInjectionMW > 100) {
      return '#3b82f6'; // Blue-500 (export/surplus)
    } else if (netInjectionMW < -100) {
      return '#ea580c'; // Orange-600 (import/deficit)
    } else {
      return '#94a3b8'; // Slate-400 (balanced)
    }
  } else {
    // Softer green-red scale for light theme
    if (netInjectionMW > 100) {
      return '#22c55e'; // Green-500 (export/surplus)
    } else if (netInjectionMW < -100) {
      return '#ef4444'; // Red-500 (import/deficit)
    } else {
      return '#52525b'; // Zinc-600 (balanced)
    }
  }
}

/**
 * Get opacity for zone based on injection magnitude
 * Slightly lower opacities for light theme to avoid overwhelming
 *
 * @param {number} netInjectionMW - Net injection in MW
 * @returns {number} Opacity (0-1)
 */
export function getInjectionOpacity(netInjectionMW) {
  const magnitude = Math.abs(netInjectionMW);

  if (magnitude < 100) {
    return 0.12; // Very faint for balanced
  } else if (magnitude < 500) {
    return 0.20;
  } else if (magnitude < 1000) {
    return 0.28;
  } else if (magnitude < 2000) {
    return 0.35;
  } else {
    return 0.42; // Moderate for large imbalances
  }
}
