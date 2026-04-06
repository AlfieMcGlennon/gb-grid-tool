import { Polyline, Marker } from 'react-leaflet'
import L from 'leaflet'
import { getUtilisationColour } from '../utils/colours'

/**
 * Calculate bearing (angle) between two points in degrees
 */
function calculateBearing(start, end) {
  const lat1 = start.lat * Math.PI / 180;
  const lat2 = end.lat * Math.PI / 180;
  const dLon = (end.lon - start.lon) * Math.PI / 180;

  const y = Math.sin(dLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);

  let bearing = Math.atan2(y, x) * 180 / Math.PI;
  return (bearing + 360) % 360;
}

/**
 * Create an arrow icon pointing in the given direction
 */
function createArrowIcon(color, rotation, size = 10) {
  return L.divIcon({
    className: 'flow-arrow',
    html: `<svg width="${size}" height="${size}" viewBox="0 0 10 10" style="transform: rotate(${rotation}deg);">
      <polygon points="5,0 10,10 5,7 0,10" fill="${color}" stroke="${color}" stroke-width="0.5"/>
    </svg>`,
    iconSize: [size, size],
    iconAnchor: [size/2, size/2]
  });
}

/**
 * Get point along line at given fraction (0-1)
 */
function interpolatePoint(start, end, fraction) {
  return {
    lat: start.lat + (end.lat - start.lat) * fraction,
    lon: start.lon + (end.lon - start.lon) * fraction
  };
}

/**
 * LinkLayer - Renders flow arrows between zone centroids
 * Shows direction and magnitude of power flows with arrowheads
 */
export default function LinkLayer({ links, flows, thermalUtilisation, zoneCentroids, colorBlindMode = false }) {
  if (!flows || !thermalUtilisation || !zoneCentroids) {
    return null;
  }

  // Filter to links with significant flow (> 50 MW) to avoid clutter
  const significantLinks = links.filter(link => {
    const flow = Math.abs(flows[link.id] || 0);
    return flow > 50;
  });

  return (
    <>
      {significantLinks.map(link => {
        const fromCentroid = zoneCentroids[link.from];
        const toCentroid = zoneCentroids[link.to];

        if (!fromCentroid || !toCentroid) {
          return null;
        }

        const flow = flows[link.id] || 0;
        const util = thermalUtilisation[link.id];

        if (!util) {
          return null;
        }

        // Determine direction: positive flow = from → to, negative = to → from
        const start = flow >= 0 ? fromCentroid : toCentroid;
        const end = flow >= 0 ? toCentroid : fromCentroid;

        // Arrow thickness proportional to |flow|
        const absFlow = Math.abs(flow);
        let weight;
        if (absFlow < 200) {
          weight = 1;
        } else if (absFlow < 500) {
          weight = 2;
        } else if (absFlow < 1000) {
          weight = 3;
        } else if (absFlow < 2000) {
          weight = 4;
        } else if (absFlow < 3000) {
          weight = 5;
        } else {
          weight = 6;
        }

        // Color by thermal utilisation
        const color = getUtilisationColour(util.utilisation_pct, colorBlindMode);

        const positions = [
          [start.lat, start.lon],
          [end.lat, end.lon]
        ];

        const tooltipContent = `${link.id}: ${absFlow.toFixed(0)} MW (${util.utilisation_pct.toFixed(1)}%)`;

        // Calculate bearing for arrow direction
        const bearing = calculateBearing(start, end);
        // Adjust rotation: SVG arrow points up (0°), bearing is from north clockwise
        // We need to rotate the arrow to point in the flow direction
        const rotation = bearing - 90;

        // Arrow size based on flow magnitude
        const arrowSize = weight < 3 ? 8 : weight < 5 ? 10 : 12;

        // Place arrow at 70% along the line (closer to destination)
        const arrowPos = interpolatePoint(start, end, 0.7);

        return (
          <Polyline
            key={link.id}
            positions={positions}
            color={color}
            weight={weight}
            opacity={0.9}
            dashArray="0"
            pane="overlayPane"
            eventHandlers={{
              mouseover: (e) => {
                e.target.bindTooltip(tooltipContent, { sticky: true }).openTooltip();
              },
              mouseout: (e) => {
                e.target.closeTooltip();
              }
            }}
          />
        );
      })}

      {/* Arrowheads along each flow line */}
      {significantLinks.map(link => {
        const fromCentroid = zoneCentroids[link.from];
        const toCentroid = zoneCentroids[link.to];

        if (!fromCentroid || !toCentroid) {
          return null;
        }

        const flow = flows[link.id] || 0;
        const util = thermalUtilisation[link.id];

        if (!util) {
          return null;
        }

        const start = flow >= 0 ? fromCentroid : toCentroid;
        const end = flow >= 0 ? toCentroid : fromCentroid;
        const color = getUtilisationColour(util.utilisation_pct, colorBlindMode);

        // Calculate bearing for arrow direction
        const bearing = calculateBearing(start, end);
        const rotation = bearing - 90;

        // Arrow size based on flow magnitude
        const absFlow = Math.abs(flow);
        const arrowSize = absFlow < 500 ? 8 : absFlow < 2000 ? 10 : 12;

        // Place arrow at 65% along the line (closer to destination)
        const arrowPos = interpolatePoint(start, end, 0.65);

        return (
          <Marker
            key={`arrow-${link.id}`}
            position={[arrowPos.lat, arrowPos.lon]}
            icon={createArrowIcon(color, rotation, arrowSize)}
            interactive={false}
          />
        );
      })}
    </>
  );
}
