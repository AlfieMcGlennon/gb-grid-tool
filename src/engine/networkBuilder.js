// Network builder - get links for a specific year from time-varying network data

/**
 * Get network links for a specific year
 *
 * @param {Object} linksByYear - Links indexed by year: { "2024": [...], "2025": [...], ... }
 * @param {number|string} year - Year to retrieve links for
 * @returns {Array} Array of link objects for the specified year
 */
export function getLinksForYear(linksByYear, year) {
  const yearKey = String(year);

  // Try exact year match first
  if (linksByYear[yearKey]) {
    return linksByYear[yearKey];
  }

  // Fall back to 2024 if year not found
  console.warn(`Links for year ${year} not found, falling back to 2024`);
  return linksByYear["2024"] || [];
}

/**
 * Apply user edits to a base link set
 * Future Phase 6 feature - currently returns base links unchanged
 *
 * @param {Array} baseLinks - Base link array from getLinksForYear
 * @param {Object} userEdits - User modifications: { added: [], removed: [], modified: {} }
 * @returns {Array} Modified link array
 */
export function applyUserEdits(baseLinks, userEdits = {}) {
  if (!userEdits || Object.keys(userEdits).length === 0) {
    return baseLinks;
  }

  let links = [...baseLinks];

  // Remove user-deleted links (Phase 6)
  if (userEdits.removed && userEdits.removed.length > 0) {
    const removedSet = new Set(userEdits.removed);
    links = links.filter(link => !removedSet.has(link.id));
  }

  // Modify existing links (Phase 6)
  if (userEdits.modified) {
    links = links.map(link => {
      const mods = userEdits.modified[link.id];
      return mods ? { ...link, ...mods } : link;
    });
  }

  // Add user-added links (Phase 6)
  if (userEdits.added && userEdits.added.length > 0) {
    links = [...links, ...userEdits.added];
  }

  return links;
}
