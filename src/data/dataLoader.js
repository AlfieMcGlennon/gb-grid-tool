// Fetch and cache all JSON/GeoJSON data files from public/data/
// All data loaded via Promise.all for parallel fetching

const DATA_BASE = '/gb-grid-tool/data';

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
      fetch(`${DATA_BASE}/zone_boundaries_tnuos.geojson`).then(r => r.json()),
      fetch(`${DATA_BASE}/zone_boundaries_dno.geojson`).then(r => r.json()),
      fetch(`${DATA_BASE}/etys_boundaries.geojson`).then(r => r.json()),
      fetch(`${DATA_BASE}/gb_coastline.geojson`).then(r => r.json()),
      fetch(`${DATA_BASE}/links_tnuos.json`).then(r => r.json()),
      fetch(`${DATA_BASE}/links_tnuos_by_year.json`).then(r => r.json()),
      fetch(`${DATA_BASE}/boundary_link_mapping.json`).then(r => r.json()),
      fetch(`${DATA_BASE}/zones_tnuos.json`).then(r => r.json()),
      fetch(`${DATA_BASE}/plants_tnuos.json`).then(r => r.json()),
      fetch(`${DATA_BASE}/demand_by_node.json`).then(r => r.json()),
      fetch(`${DATA_BASE}/climatology.json`).then(r => r.json()),
      fetch(`${DATA_BASE}/demand_climatology.json`).then(r => r.json()),
      fetch(`${DATA_BASE}/substation_zone_mapping.json`).then(r => r.json()),
      fetch(`${DATA_BASE}/etys_capabilities.json`).then(r => r.json()),
      fetch(`${DATA_BASE}/ic_lookup.json`).then(r => r.json()),
      fetch(`${DATA_BASE}/marginal_costs.json`).then(r => r.json()),
      fetch(`${DATA_BASE}/zones_flop.json`).then(r => r.json()),
      fetch(`${DATA_BASE}/links_flop.json`).then(r => r.json()),
      fetch(`${DATA_BASE}/links_flop_by_year.json`).then(r => r.json()),
      fetch(`${DATA_BASE}/zone_boundaries_flop.geojson`).then(r => r.json()),
      fetch(`${DATA_BASE}/boundary_link_mapping_flop.json`).then(r => r.json())
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
