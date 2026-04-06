import './MapLegend.css'

/**
 * MapLegend - Discrete color swatches for zones and boundaries
 */
export default function MapLegend({ colorBlindMode = false }) {
  // Color swatches based on mode
  const zoneColors = colorBlindMode
    ? {
        export: '#3b82f6',    // blue-500
        balanced: '#9ca3af',  // gray-400
        import: '#f97316'     // orange-500
      }
    : {
        export: '#22c55e',    // green-500
        balanced: '#52525b',  // zinc-600
        import: '#ef4444'     // red-500
      };

  const boundaryColors = colorBlindMode
    ? [
        { label: '<40%', color: '#3b82f6' },      // blue-500
        { label: '40-60%', color: '#60a5fa' },    // blue-400
        { label: '60-75%', color: '#fbbf24' },    // yellow-400
        { label: '75-85%', color: '#fb923c' },    // orange-400
        { label: '85%+', color: '#f97316' }       // orange-500
      ]
    : [
        { label: '<40%', color: '#22c55e' },      // green-500
        { label: '40-60%', color: '#84cc16' },    // lime-500
        { label: '60-75%', color: '#f59e0b' },    // amber-500
        { label: '75-85%', color: '#f97316' },    // orange-500
        { label: '85-100%', color: '#ef4444' },   // red-500
        { label: '>100%', color: '#dc2626' }      // red-600
      ];

  return (
    <div className="map-legend">
      <div className="legend-section">
        <div className="legend-title">Zones</div>
        <div className="legend-swatches">
          <div className="legend-swatch-item">
            <span className="swatch" style={{ backgroundColor: zoneColors.export }}></span>
            <span className="swatch-label">Export</span>
          </div>
          <div className="legend-swatch-item">
            <span className="swatch" style={{ backgroundColor: zoneColors.balanced }}></span>
            <span className="swatch-label">Balanced</span>
          </div>
          <div className="legend-swatch-item">
            <span className="swatch" style={{ backgroundColor: zoneColors.import }}></span>
            <span className="swatch-label">Import</span>
          </div>
        </div>
      </div>

      <div className="legend-section">
        <div className="legend-title">Boundaries</div>
        <div className="legend-swatches">
          {boundaryColors.map(({ label, color }) => (
            <div key={label} className="legend-swatch-item">
              <span className="swatch" style={{ backgroundColor: color }}></span>
              <span className="swatch-label">{label}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
