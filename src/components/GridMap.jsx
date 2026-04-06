import { MapContainer, TileLayer, GeoJSON, Marker } from 'react-leaflet'
import { useRef, useMemo } from 'react'
import L from 'leaflet'
import * as turf from '@turf/turf'
import { getUtilisationColour, getUtilisationWeight, getInjectionColour, getInjectionOpacity } from '../utils/colours'
import LinkLayer from './LinkLayer'
import MapLegend from './MapLegend'

export default function GridMap({ data, powerFlowResults, selectedZone, selectedBoundary, year, zoneMode = 'tnuos', colorBlindMode = false, onZoneClick, onBoundaryClick }) {
  const mapRef = useRef(null);

  // GB centre and zoom to fit entire country
  const center = [54.5, -3.5];
  const zoom = 6;

  // Select zone boundaries based on zone mode
  const activeZoneBoundaries = zoneMode === 'flop' ? data.zoneBoundariesFLOP : data.zoneBoundariesTNUoS;

  // Extract zone centroids for flow arrows
  const zoneCentroids = useMemo(() => {
    const centroids = {};
    if (activeZoneBoundaries) {
      activeZoneBoundaries.features.forEach(feature => {
        const { id, centroid_lat, centroid_lon } = feature.properties;
        if (centroid_lat && centroid_lon) {
          centroids[id] = { lat: centroid_lat, lon: centroid_lon };
        }
      });
    }
    return centroids;
  }, [activeZoneBoundaries]);

  // Get links for current year and zone mode
  const currentLinks = useMemo(() => {
    if (zoneMode === 'flop') {
      return data.linksFLOP || [];
    }
    if (!data.linksTNUoSByYear) return [];
    const yearKey = String(year);
    return data.linksTNUoSByYear[yearKey] || data.linksTNUoSByYear['2024'] || [];
  }, [data.linksTNUoSByYear, data.linksFLOP, year, zoneMode]);

  // Clip ETYS boundaries to GB coastline to prevent lines extending into sea
  const clippedBoundaries = useMemo(() => {
    if (!data.etysBoundaries || !data.gbCoastline) return data.etysBoundaries;

    try {
      // Create a union of all coastline polygons for clipping mask
      const coastlinePolygon = turf.union(...data.gbCoastline.features);

      const clippedFeatures = data.etysBoundaries.features
        .map(feature => {
          try {
            const clipped = turf.lineIntersect(feature, coastlinePolygon);
            if (clipped.features.length > 0) {
              // Reconstruct as LineString from intersection points
              return feature; // Keep original for now if intersection is complex
            }
            return feature;
          } catch (e) {
            return feature; // Keep original on error
          }
        })
        .filter(Boolean);

      return {
        type: 'FeatureCollection',
        features: clippedFeatures
      };
    } catch (e) {
      console.warn('Boundary clipping failed, using original boundaries:', e);
      return data.etysBoundaries;
    }
  }, [data.etysBoundaries, data.gbCoastline]);

  // Style for coastline (thin grey outline)
  const coastlineStyle = {
    color: '#52525b',
    weight: 1,
    fill: false,
    opacity: 0.3
  };

  // Style for TNUoS zone polygons - colored by net injection (Phase 2)
  const zoneStyle = (feature) => {
    const zoneId = feature.properties.id;
    const isSelected = selectedZone && zoneId === selectedZone;

    // Get net injection for this zone from power flow results
    let fillColor = '#2a2a35'; // Default dark
    let fillOpacity = 0.2;

    if (powerFlowResults && powerFlowResults.zoneInjections) {
      const netInjection = powerFlowResults.zoneInjections[zoneId] || 0;
      fillColor = getInjectionColour(netInjection, colorBlindMode);
      fillOpacity = isSelected ? 0.6 : getInjectionOpacity(netInjection);
    }

    return {
      color: isSelected ? '#ffb000' : '#2a2a35',
      weight: isSelected ? 2.5 : 1,
      fillColor: isSelected ? 'rgba(255, 176, 0, 0.15)' : fillColor,
      fillOpacity,
      opacity: 0.8
    };
  };

  // Style for ETYS boundaries - colored by utilisation (Phase 2)
  const boundaryStyle = (feature) => {
    const boundaryId = feature.properties.id;
    const isSelected = selectedBoundary && boundaryId === selectedBoundary;

    // Default subtle style for light theme
    let color = '#52525b';
    let weight = 3; // Increased from 1 for better clickability
    let opacity = 0.5;
    let dashArray = '5, 5';

    // Get utilisation for this boundary from power flow results
    if (powerFlowResults && powerFlowResults.boundaryUtilisation) {
      // Map boundary geo_id to capability name using cap_name_map
      const activeBoundaryMapping = zoneMode === 'flop' ? data.boundaryLinkMappingFLOP : data.boundaryLinkMapping;
      const capNameMap = activeBoundaryMapping?.cap_name_map || {};
      const capName = capNameMap[boundaryId] || boundaryId;
      const boundaryUtil = powerFlowResults.boundaryUtilisation[capName];

      if (boundaryUtil) {
        color = getUtilisationColour(boundaryUtil.utilisation_pct, colorBlindMode);
        weight = Math.max(getUtilisationWeight(boundaryUtil.utilisation_pct), 3); // Min weight 3 for clickability
        opacity = 0.9;
        dashArray = '0'; // Solid line when utilisation is calculated
      }
    }

    // Override for selection
    if (isSelected) {
      color = '#ffb000';
      weight = weight + 2;
      opacity = 1;
      dashArray = '0';
    }

    return {
      color,
      weight,
      opacity,
      dashArray
    };
  };

  // Create custom icon for zone labels
  const createZoneLabelIcon = (zoneId) => {
    const fontSize = zoneMode === 'flop' ? '9px' : '11px';
    return L.divIcon({
      className: 'zone-label',
      html: `<span style="
        font-size: ${fontSize};
        font-weight: 600;
        color: #ffb000;
        font-family: 'JetBrains Mono', monospace;
        text-shadow: 0 0 4px #0a0a0f, 0 0 4px #0a0a0f, 0 0 4px #0a0a0f;
        pointer-events: none;
        white-space: nowrap;
      ">${zoneId}</span>`,
      iconSize: [40, 20],
      iconAnchor: [20, 10]
    });
  };

  // Handle zone click
  const onEachZoneFeature = (feature, layer) => {
    const zoneId = feature.properties.id;

    layer.on({
      click: () => {
        onZoneClick(zoneId);
      },
      mouseover: (e) => {
        const layer = e.target;
        if (!selectedZone || selectedZone !== zoneId) {
          layer.setStyle({
            weight: 2,
            opacity: 0.8,
            fillOpacity: 0.5
          });
        }
      },
      mouseout: (e) => {
        const layer = e.target;
        if (!selectedZone || selectedZone !== zoneId) {
          layer.setStyle(zoneStyle(feature));
        }
      }
    });

    // Add tooltip with zone name and net injection
    const netInjection = powerFlowResults?.zoneInjections?.[zoneId] || 0;
    const injectionLabel = netInjection > 100 ? 'Export' : netInjection < -100 ? 'Import' : 'Balanced';
    const injectionMW = Math.abs(netInjection).toFixed(0);

    layer.bindTooltip(
      `<div style="font-weight: 600; color: #ffb000;">${zoneId}</div>
       <div style="font-size: 12px; color: #71717a;">${feature.properties.name || 'TNUoS Zone'}</div>
       <div style="font-size: 11px; color: #d4d4d8; margin-top: 2px;">${injectionLabel}: ${injectionMW} MW</div>`,
      {
        permanent: false,
        direction: 'center',
        className: 'zone-tooltip'
      }
    );
  };

  // Handle ETYS boundary click and tooltip
  const onEachBoundaryFeature = (feature, layer) => {
    const boundaryId = feature.properties.id;

    layer.on({
      click: (e) => {
        L.DomEvent.stopPropagation(e);
        onBoundaryClick(boundaryId);
      },
      mouseover: (e) => {
        const layer = e.target;
        if (!selectedBoundary || selectedBoundary !== boundaryId) {
          const currentStyle = boundaryStyle(feature);
          layer.setStyle({
            weight: currentStyle.weight + 1,
            opacity: 1
          });
        }
      },
      mouseout: (e) => {
        const layer = e.target;
        if (!selectedBoundary || selectedBoundary !== boundaryId) {
          layer.setStyle(boundaryStyle(feature));
        }
      }
    });

    // Get utilisation for tooltip
    const activeBoundaryMappingTooltip = zoneMode === 'flop' ? data.boundaryLinkMappingFLOP : data.boundaryLinkMapping;
    const capNameMap = activeBoundaryMappingTooltip?.cap_name_map || {};
    const capName = capNameMap[boundaryId] || boundaryId;
    const boundaryUtil = powerFlowResults?.boundaryUtilisation?.[capName];

    let tooltipContent = `<div style="font-weight: 600; color: #ffb000;">Boundary ${boundaryId}</div>`;

    if (boundaryUtil) {
      tooltipContent += `<div style="font-size: 12px; color: #d4d4d8; margin-top: 2px;">
        ${boundaryUtil.utilisation_pct.toFixed(1)}% utilisation
      </div>`;
      tooltipContent += `<div style="font-size: 11px; color: #71717a;">
        ${boundaryUtil.flow_mw.toFixed(0)} / ${boundaryUtil.capability_mw.toFixed(0)} MW
      </div>`;
    } else {
      tooltipContent += `<div style="font-size: 12px; color: #71717a;">ETYS Transmission Boundary</div>`;
    }

    layer.bindTooltip(tooltipContent, {
      permanent: false,
      direction: 'center'
    });
  };

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      <MapContainer
        center={center}
        zoom={zoom}
        ref={mapRef}
        style={{ width: '100%', height: '100%' }}
        zoomControl={true}
      >
      <TileLayer
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>'
        url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
        subdomains="abcd"
        maxZoom={20}
        opacity={0.6}
      />

      {/* GB Coastline - base layer */}
      <GeoJSON
        data={data.gbCoastline}
        style={coastlineStyle}
      />

      {/* Zone Polygons (27 TNUoS zones) */}
      <GeoJSON
        data={activeZoneBoundaries}
        style={zoneStyle}
        onEachFeature={onEachZoneFeature}
        key={`${zoneMode}-${selectedZone}`} // Force re-render when selection or zone mode changes
      />

      {/* Flow Arrows - power flow runs on TNUoS zones */}
      {powerFlowResults && (
        <LinkLayer
          links={currentLinks}
          flows={powerFlowResults.flows}
          thermalUtilisation={powerFlowResults.thermalUtilisation}
          zoneCentroids={zoneCentroids}
          colorBlindMode={colorBlindMode}
        />
      )}

      {/* ETYS Boundary Lines - clipped to coastline */}
      <GeoJSON
        data={clippedBoundaries}
        style={boundaryStyle}
        onEachFeature={onEachBoundaryFeature}
        key={selectedBoundary}
      />

      {/* Zone Labels at centroids */}
      {activeZoneBoundaries.features.map(feature => {
        const { centroid_lat, centroid_lon, id } = feature.properties;
        if (centroid_lat && centroid_lon) {
          return (
            <Marker
              key={id}
              position={[centroid_lat, centroid_lon]}
              icon={createZoneLabelIcon(id)}
              interactive={false}
            />
          );
        }
        return null;
      })}
      </MapContainer>

      {/* Map Legend overlay */}
      <MapLegend colorBlindMode={colorBlindMode} />
    </div>
  );
}
