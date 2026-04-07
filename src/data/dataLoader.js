// Fetch and cache all JSON/GeoJSON data files from public/data/
// All data loaded via Promise.all for parallel fetching

const DATA_BASE = '/gb-grid-tool/data';
const FETCH_TIMEOUT_MS = 15000;

/**
 * Fetch with timeout — rejects if the request takes longer than FETCH_TIMEOUT_MS.
 * Prevents the app hanging indefinitely on slow connections or CDN issues.
 */
function fetchWithTimeout(url) {
  return Promise.race([
    fetch(url).then(r => {
      if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
      return r.json();
    }),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`Timeout loading ${url} (${FETCH_TIMEOUT_MS / 1000}s)`)), FETCH_TIMEOUT_MS)
    )
  ]);
}

export async function loadAllData() {
  try {
    const [
      zoneBoundariesTNUoS,
      zoneBoundariesDNO,
      etysBoundaries,
      gbCoastline,
      linksTNUoS,
      linksTNUoSByYear,
      boundaryLinkMapping,
      zonesTNUoS,
      plantsTNUoS,
      demandByNode,
      climatology,
      demandClimatology,
      substationZoneMapping,
      etysCapabilities,
      icLookup,
      marginalCosts,
      zonesFLOP,
      linksFLOP,
      linksFLOPByYear,
      zoneBoundariesFLOP,
      boundaryLinkMappingFLOP
    ] = await Promise.all([
      fetchWithTimeout(`${DATA_BASE}/zone_boundaries_tnuos.geojson`),
      fetchWithTimeout(`${DATA_BASE}/zone_boundaries_dno.geojson`),
      fetchWithTimeout(`${DATA_BASE}/etys_boundaries.geojson`),
      fetchWithTimeout(`${DATA_BASE}/gb_coastline.geojson`),
      fetchWithTimeout(`${DATA_BASE}/links_tnuos.json`),
      fetchWithTimeout(`${DATA_BASE}/links_tnuos_by_year.json`),
      fetchWithTimeout(`${DATA_BASE}/boundary_link_mapping.json`),
      fetchWithTimeout(`${DATA_BASE}/zones_tnuos.json`),
      fetchWithTimeout(`${DATA_BASE}/plants_tnuos.json`),
      fetchWithTimeout(`${DATA_BASE}/demand_by_node.json`),
      fetchWithTimeout(`${DATA_BASE}/climatology.json`),
      fetchWithTimeout(`${DATA_BASE}/demand_climatology.json`),
      fetchWithTimeout(`${DATA_BASE}/substation_zone_mapping.json`),
      fetchWithTimeout(`${DATA_BASE}/etys_capabilities.json`),
      fetchWithTimeout(`${DATA_BASE}/ic_lookup.json`),
      fetchWithTimeout(`${DATA_BASE}/marginal_costs.json`),
      fetchWithTimeout(`${DATA_BASE}/zones_flop.json`),
      fetchWithTimeout(`${DATA_BASE}/links_flop.json`),
      fetchWithTimeout(`${DATA_BASE}/links_flop_by_year.json`),
      fetchWithTimeout(`${DATA_BASE}/zone_boundaries_flop.geojson`),
      fetchWithTimeout(`${DATA_BASE}/boundary_link_mapping_flop.json`)
    ]);

    return {
      zoneBoundariesTNUoS,
      zoneBoundariesDNO,
      etysBoundaries,
      gbCoastline,
      linksTNUoS,
      linksTNUoSByYear,
      boundaryLinkMapping,
      zonesTNUoS,
      plantsTNUoS,
      demandByNode,
      climatology,
      demandClimatology,
      substationZoneMapping,
      etysCapabilities,
      icLookup,
      marginalCosts,
      zonesFLOP,
      linksFLOP,
      linksFLOPByYear,
      zoneBoundariesFLOP,
      boundaryLinkMappingFLOP
    };
  } catch (error) {
    console.error('Error loading data:', error);
    throw new Error(`Failed to load data: ${error.message}`);
  }
}
