import { useState, useEffect } from 'react'
import { useDebouncedLocal } from '../hooks/useDebouncedLocal'
import './ControlPanel.css'

export default function ControlPanel({
  calculating,
  year,
  season,
  windPercentile,
  solarPercentile,
  demandPercentile,
  fuelToggles,
  dispatchMode,
  interconnectorImport,
  zoneMode,
  onZoneModeChange,
  colorBlindMode,
  onYearChange,
  onSeasonChange,
  onWindPercentileChange,
  onSolarPercentileChange,
  onDemandPercentileChange,
  onFuelToggleChange,
  onDispatchModeChange,
  onInterconnectorImportChange,
  dynamicIC,
  onDynamicICChange,
  reinforcementsEnabled,
  onReinforcementsChange,
  resolvedICImport,
  onColorBlindModeChange,
  onOpenContingency,
  onOpenScenarioManager,
  onOpenLinkEditor,
  onBoundaryClick,
  availableFuelTypes,
  powerFlowResults,
  // Changes tracking
  plantEdits,
  addedNodes,
  linkEdits,
  plants,  // For looking up plant names by ID
  onReset,
  onRemovePlantEdit,
  onRemoveAddedNode,
  onRemoveLinkEdit
}) {
  // Helper to look up plant name from ID
  const getPlantName = (plantId) => {
    if (!plants) return plantId;
    const plant = plants.find(p => (p.project_id || p.project) === plantId);
    return plant?.project || plantId.slice(0, 20);
  };
  const [localYear, setLocalYear] = useDebouncedLocal(year, onYearChange);
  const [localWindPercentile, setLocalWindPercentile] = useDebouncedLocal(windPercentile, onWindPercentileChange);
  const [localSolarPercentile, setLocalSolarPercentile] = useDebouncedLocal(solarPercentile, onSolarPercentileChange);
  const [localDemandPercentile, setLocalDemandPercentile] = useDebouncedLocal(demandPercentile, onDemandPercentileChange);
  const [localInterconnectorImport, setLocalInterconnectorImport] = useDebouncedLocal(interconnectorImport, onInterconnectorImportChange);

  // Collapsible section state
  const [fuelTogglesExpanded, setFuelTogglesExpanded] = useState(false);
  const [changesExpanded, setChangesExpanded] = useState(false);
  const [showResetConfirm, setShowResetConfirm] = useState(false);

  // Calculate change counts
  const plantEditCount = plantEdits ? Object.keys(plantEdits).length : 0;
  const addedNodeCount = addedNodes ? addedNodes.length : 0;
  const linkAddedCount = linkEdits?.added?.length || 0;
  const linkRemovedCount = linkEdits?.removed?.length || 0;
  const linkModifiedCount = linkEdits?.modified ? Object.keys(linkEdits.modified).length : 0;
  const totalLinkChanges = linkAddedCount + linkRemovedCount + linkModifiedCount;
  const hasChanges = plantEditCount > 0 || addedNodeCount > 0 || totalLinkChanges > 0;

  // Handle reset confirmation
  const handleResetConfirm = () => {
    onReset?.();
    setShowResetConfirm(false);
  };

  const seasons = ['Winter', 'Spring', 'Summer', 'Autumn', 'Annual'];

  return (
    <div className="control-panel">
      {/* Reset Confirmation Dialog */}
      {showResetConfirm && (
        <div className="reset-confirm-overlay">
          <div className="reset-confirm-dialog">
            <p>Reset all changes? This will clear plant edits, hypothetical generation, link edits, and restore default scenario settings.</p>
            <div className="reset-confirm-buttons">
              <button className="reset-confirm-cancel" onClick={() => setShowResetConfirm(false)}>
                Cancel
              </button>
              <button className="reset-confirm-ok" onClick={handleResetConfirm}>
                Reset All
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Header with Reset Button */}
      <div className="control-panel-header">
        {calculating && <span className="calculating-indicator" title="Recalculating...">&#x27F3;</span>}
        <button
          className="reset-button"
          onClick={() => setShowResetConfirm(true)}
          title="Reset all changes and restore defaults"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
            <path d="M3 3v5h5" />
          </svg>
          Reset
        </button>
      </div>

      {/* Active Changes Summary - only shown when changes exist */}
      {hasChanges && (
        <div className="control-section changes-section">
          <h3
            className="control-section-title collapsible changes-title"
            onClick={() => setChangesExpanded(!changesExpanded)}
            role="button"
            tabIndex={0}
            aria-expanded={changesExpanded}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setChangesExpanded(!changesExpanded); } }}
          >
            <span className="collapse-icon">{changesExpanded ? '▼' : '▶'}</span>
            <span className="changes-badge">
              {plantEditCount + addedNodeCount + totalLinkChanges} Changes
            </span>
          </h3>
          {changesExpanded && (
            <div className="changes-list">
              {/* Plant Edits */}
              {plantEditCount > 0 && (
                <div className="changes-group">
                  <div className="changes-group-header">
                    {plantEditCount} plant{plantEditCount !== 1 ? 's' : ''} modified
                  </div>
                  {Object.entries(plantEdits).map(([plantId, edit]) => (
                    <div key={plantId} className="change-item">
                      <span className="change-name" title={plantId}>
                        {getPlantName(plantId)}
                      </span>
                      <button
                        className="change-remove"
                        onClick={() => onRemovePlantEdit?.(plantId)}
                        title="Remove edit"
                      >
                        ×
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {/* Added Nodes */}
              {addedNodeCount > 0 && (
                <div className="changes-group">
                  <div className="changes-group-header">
                    {addedNodeCount} node{addedNodeCount !== 1 ? 's' : ''} added
                  </div>
                  {addedNodes.map((node, idx) => (
                    <div key={node.id || idx} className="change-item">
                      <span className="change-name">
                        {node.name || `${node.plantType} @ ${node.zoneId}`}
                      </span>
                      <button
                        className="change-remove"
                        onClick={() => onRemoveAddedNode?.(node.id || idx)}
                        title="Remove node"
                      >
                        ×
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {/* Link Edits */}
              {totalLinkChanges > 0 && (
                <div className="changes-group">
                  <div className="changes-group-header">
                    {linkAddedCount > 0 && `${linkAddedCount} added`}
                    {linkAddedCount > 0 && (linkRemovedCount > 0 || linkModifiedCount > 0) && ', '}
                    {linkRemovedCount > 0 && `${linkRemovedCount} removed`}
                    {linkRemovedCount > 0 && linkModifiedCount > 0 && ', '}
                    {linkModifiedCount > 0 && `${linkModifiedCount} modified`}
                  </div>
                  {linkEdits?.added?.map((link, idx) => (
                    <div key={`add-${link.id || idx}`} className="change-item">
                      <span className="change-name change-added">+ {link.id || `${link.from}-${link.to}`}</span>
                      <button
                        className="change-remove"
                        onClick={() => onRemoveLinkEdit?.('added', link.id || idx)}
                        title="Remove"
                      >
                        ×
                      </button>
                    </div>
                  ))}
                  {linkEdits?.removed?.map((linkId, idx) => (
                    <div key={`rem-${linkId}`} className="change-item">
                      <span className="change-name change-removed">- {linkId}</span>
                      <button
                        className="change-remove"
                        onClick={() => onRemoveLinkEdit?.('removed', linkId)}
                        title="Restore"
                      >
                        ×
                      </button>
                    </div>
                  ))}
                  {linkEdits?.modified && Object.entries(linkEdits.modified).map(([linkId, mods]) => (
                    <div key={`mod-${linkId}`} className="change-item">
                      <span className="change-name change-modified">~ {linkId}</span>
                      <button
                        className="change-remove"
                        onClick={() => onRemoveLinkEdit?.('modified', linkId)}
                        title="Revert"
                      >
                        ×
                      </button>
                    </div>
                  ))}
                </div>
              )}

              <button
                className="clear-all-changes"
                onClick={() => setShowResetConfirm(true)}
              >
                Clear All Changes
              </button>
            </div>
          )}
        </div>
      )}

      <div className="control-section">
        <h3 className="control-section-title">Scenario Parameters</h3>

        {/* Year Slider */}
        <div className="control-group">
          <label className="control-label">
            Year: <span className="control-value">{localYear}</span>
          </label>
          <input
            type="range"
            min="2024"
            max="2035"
            step="1"
            value={localYear}
            onChange={(e) => setLocalYear(Number(e.target.value))}
            className="year-slider"
          />
          <div className="year-labels">
            <span>2024</span>
            <span>2030</span>
            <span>2035</span>
          </div>
          {localYear > 2024 && (
            <label className="dynamic-ic-toggle">
              <input
                type="checkbox"
                checked={reinforcementsEnabled}
                onChange={(e) => onReinforcementsChange(e.target.checked)}
              />
              Include planned reinforcements
            </label>
          )}
        </div>

        {/* Season Selector */}
        <div className="control-group">
          <label className="control-label">Season</label>
          <select
            value={season}
            onChange={(e) => onSeasonChange(e.target.value)}
            className="control-select"
          >
            {seasons.map(s => (
              <option key={s} value={s.toLowerCase()}>{s}</option>
            ))}
          </select>
        </div>

        {/* Zone Scheme Toggle */}
        <div className="control-group">
          <label className="control-label">Zone Scheme</label>
          <div className="zone-scheme-toggle">
            <button
              className={`toggle-button ${zoneMode === 'tnuos' ? 'active' : ''}`}
              onClick={() => onZoneModeChange('tnuos')}
            >
              TNUoS (27)
            </button>
            <button
              className={`toggle-button ${zoneMode === 'flop' ? 'active' : ''}`}
              onClick={() => onZoneModeChange('flop')}
            >
              FLOP (82)
            </button>
          </div>
        </div>

        {/* Dispatch Mode Toggle */}
        <div className="control-group">
          <label className="control-label">Dispatch Mode</label>
          <div className="zone-scheme-toggle">
            <button
              className={`toggle-button ${dispatchMode === 'simple' ? 'active' : ''}`}
              onClick={() => onDispatchModeChange('simple')}
            >
              Simple
            </button>
            <button
              className={`toggle-button ${dispatchMode === 'merit-order' ? 'active' : ''}`}
              onClick={() => onDispatchModeChange('merit-order')}
            >
              Merit Order
            </button>
            <button
              className={`toggle-button ${dispatchMode === 'lopf' ? 'active' : ''}`}
              onClick={() => onDispatchModeChange('lopf')}
            >
              LOPF
            </button>
          </div>
          {dispatchMode === 'lopf' && (
            <span className="control-hint" style={{ fontSize: '0.7rem', opacity: 0.7, marginTop: '2px', display: 'block' }}>
              Network-constrained economic dispatch
            </span>
          )}
        </div>
      </div>

      <div className="control-section">
        <h3 className="control-section-title">Weather & Demand</h3>

        {/* Wind Percentile Slider */}
        <div className="control-group">
          <label className="control-label">
            Wind: <span className="control-value">p{localWindPercentile}</span>
            <span className="percentile-desc">
              {localWindPercentile <= 15 ? '(calm)' :
               localWindPercentile <= 35 ? '(light)' :
               localWindPercentile <= 65 ? '(typical)' :
               localWindPercentile <= 85 ? '(strong)' : '(gale)'}
            </span>
          </label>
          <input
            type="range"
            min="1"
            max="99"
            step="1"
            value={localWindPercentile}
            onChange={(e) => setLocalWindPercentile(Number(e.target.value))}
            className="percentile-slider"
          />
          <div className="slider-labels">
            <span>Calm</span>
            <span>Typical</span>
            <span>Gale</span>
          </div>
        </div>

        {/* Solar Percentile Slider */}
        <div className="control-group">
          <label className="control-label">
            Solar: <span className="control-value">p{localSolarPercentile}</span>
            <span className="percentile-desc">
              {localSolarPercentile <= 15 ? '(overcast)' :
               localSolarPercentile <= 35 ? '(cloudy)' :
               localSolarPercentile <= 65 ? '(typical)' :
               localSolarPercentile <= 85 ? '(bright)' : '(clear sky)'}
            </span>
          </label>
          <input
            type="range"
            min="1"
            max="99"
            step="1"
            value={localSolarPercentile}
            onChange={(e) => setLocalSolarPercentile(Number(e.target.value))}
            className="percentile-slider"
          />
          <div className="slider-labels">
            <span>Overcast</span>
            <span>Typical</span>
            <span>Clear</span>
          </div>
        </div>

        {/* Demand Percentile Slider */}
        <div className="control-group">
          <label className="control-label">
            Demand: <span className="control-value">p{localDemandPercentile}</span>
            <span className="percentile-desc">
              {localDemandPercentile <= 15 ? '(low)' :
               localDemandPercentile <= 35 ? '(quiet)' :
               localDemandPercentile <= 65 ? '(typical)' :
               localDemandPercentile <= 85 ? '(busy)' : '(peak)'}
            </span>
          </label>
          <input
            type="range"
            min="1"
            max="99"
            step="1"
            value={localDemandPercentile}
            onChange={(e) => setLocalDemandPercentile(Number(e.target.value))}
            className="percentile-slider"
          />
          <div className="slider-labels">
            <span>Low</span>
            <span>Typical</span>
            <span>Peak</span>
          </div>
        </div>

        {/* Interconnector Import */}
        <div className="control-group">
          <label className="control-label">
            Imports: <span className="control-value">
              {dynamicIC ? `${resolvedICImport ?? '...'}%` : `${localInterconnectorImport}%`}
            </span>
            <span className="percentile-desc">
              {dynamicIC ? '(NESO historic)' :
               localInterconnectorImport <= 20 ? '(exporting)' :
               localInterconnectorImport <= 45 ? '(low import)' :
               localInterconnectorImport <= 75 ? '(typical)' : '(max import)'}
            </span>
          </label>
          <label className="dynamic-ic-toggle">
            <input
              type="checkbox"
              checked={dynamicIC}
              onChange={(e) => onDynamicICChange(e.target.checked)}
            />
            Dynamic (from NESO data)
          </label>
          {!dynamicIC && (
            <>
              <input
                type="range"
                min="0"
                max="100"
                step="5"
                value={localInterconnectorImport}
                onChange={(e) => setLocalInterconnectorImport(Number(e.target.value))}
                className="percentile-slider"
              />
              <div className="slider-labels">
                <span>Export</span>
                <span>Typical</span>
                <span>Max Import</span>
              </div>
            </>
          )}
        </div>
      </div>

      {/* Top Stressed Boundaries */}
      {powerFlowResults && powerFlowResults.boundaryUtilisation && (() => {
        // Filter out boundaries with 0% or negligible utilisation
        const stressedBoundaries = Object.entries(powerFlowResults.boundaryUtilisation)
          .filter(([, data]) => data.utilisation_pct > 5)
          .sort((a, b) => b[1].utilisation_pct - a[1].utilisation_pct)
          .slice(0, 3);

        return (
          <div className="control-section">
            <h3 className="control-section-title">Most Stressed</h3>
            <div className="stressed-boundaries">
              {stressedBoundaries.length === 0 ? (
                <p className="control-info">No boundaries stressed</p>
              ) : (
                stressedBoundaries.map(([id, data]) => (
                  <div
                    key={id}
                    className={`stressed-item ${data.utilisation_pct > 100 ? 'constrained' : ''}`}
                    onClick={() => onBoundaryClick?.(id)}
                    style={{ cursor: 'pointer' }}
                    title="Click to view boundary details"
                  >
                    <span className="stressed-boundary">{id}</span>
                    <span className="stressed-value">
                      {data.utilisation_pct > 100 ? 'CONSTRAINED ' : ''}
                      {data.utilisation_pct.toFixed(0)}%
                    </span>
                  </div>
                ))
              )}
            </div>
          </div>
        );
      })()}

      {/* N-1 Contingency Analysis */}
      <div className="control-section">
        <h3 className="control-section-title">Security Analysis</h3>
        <button
          className="analysis-button"
          onClick={onOpenContingency}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M13 10V3L4 14h7v7l9-11h-7z" />
          </svg>
          Run N-1 Analysis
        </button>
        <p className="control-info">
          Test network security by removing each link and checking for overloads
        </p>
      </div>

      {/* Network Topology Editor */}
      <div className="control-section">
        <h3 className="control-section-title">Network Topology</h3>
        <button
          className="scenario-button"
          onClick={onOpenLinkEditor}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <line x1="4" y1="6" x2="20" y2="6" />
            <line x1="4" y1="12" x2="20" y2="12" />
            <line x1="4" y1="18" x2="20" y2="18" />
            <circle cx="8" cy="6" r="2" fill="currentColor" />
            <circle cx="16" cy="12" r="2" fill="currentColor" />
            <circle cx="10" cy="18" r="2" fill="currentColor" />
          </svg>
          Edit Network Links
        </button>
        <p className="control-info">
          Add, remove, or modify transmission links
        </p>
      </div>

      <div className="control-section">
        <h3
          className="control-section-title collapsible"
          onClick={() => setFuelTogglesExpanded(!fuelTogglesExpanded)}
          role="button"
          tabIndex={0}
          aria-expanded={fuelTogglesExpanded}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setFuelTogglesExpanded(!fuelTogglesExpanded); } }}
        >
          <span className="collapse-icon">{fuelTogglesExpanded ? '▼' : '▶'}</span>
          Fuel Types {availableFuelTypes && `(${availableFuelTypes.length})`}
        </h3>
        {fuelTogglesExpanded && (
          <div className="fuel-toggles">
            {availableFuelTypes && availableFuelTypes.map(fuelType => (
              <label key={fuelType} className="fuel-toggle-label">
                <input
                  type="checkbox"
                  checked={fuelToggles[fuelType] !== false}
                  onChange={(e) => onFuelToggleChange(fuelType, e.target.checked)}
                  className="fuel-checkbox"
                />
                <span className="fuel-name">{fuelType}</span>
              </label>
            ))}
          </div>
        )}
      </div>

      {/* Scenario Export/Import */}
      <div className="control-section">
        <h3 className="control-section-title">Scenario</h3>
        <button
          className="scenario-button"
          onClick={onOpenScenarioManager}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
            <polyline points="17,8 12,3 7,8" />
            <line x1="12" y1="3" x2="12" y2="15" />
          </svg>
          Export / Import
        </button>
        <p className="control-info">
          Save or load scenario configurations
        </p>
      </div>

      {/* Color Blind Mode Toggle */}
      <div className="control-section">
        <label className="colorblind-toggle-label">
          <input
            type="checkbox"
            checked={colorBlindMode}
            onChange={(e) => onColorBlindModeChange(e.target.checked)}
            className="colorblind-checkbox"
          />
          <span className="colorblind-label-text">Color blind mode</span>
        </label>
        <p className="control-info">Uses blue-orange instead of green-red</p>
      </div>
    </div>
  );
}
