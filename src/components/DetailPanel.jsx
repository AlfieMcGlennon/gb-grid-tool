import { useState } from 'react'
import './DetailPanel.css'

function BoundaryDetail({ boundaryId, boundaryData, powerFlowResults, onClose }) {
  const [crossingLinksExpanded, setCrossingLinksExpanded] = useState(true);

  // Find boundary in boundary_link_mapping using cap_name_map
  const capNameMap = boundaryData.cap_name_map || {};
  const mappedName = capNameMap[boundaryId] || boundaryId;
  const boundary = boundaryData.boundary_links?.[mappedName];

  // Get power flow data for this boundary
  const boundaryUtil = powerFlowResults?.boundaryUtilisation?.[mappedName];
  const thermalUtil = powerFlowResults?.thermalUtilisation;

  if (!boundary) {
    return (
      <div className="detail-panel">
        <div className="panel-header">
          <div>
            <h2>Boundary {boundaryId}</h2>
            <p className="zone-subtitle">ETYS Transmission Boundary</p>
          </div>
          <button className="close-button" onClick={onClose}>×</button>
        </div>
        <div className="panel-content">
          <p style={{ color: '#6b7280' }}>
            Boundary data not available. This may be an unmapped edge boundary (B0, NW1, NW2, SC3).
          </p>
        </div>
      </div>
    );
  }

  const { north_zones, south_zones, crossing_links, capability_2024_mw } = boundary;

  // Calculate total thermal capacity across crossing links
  const totalThermalCapacity = (crossing_links || []).reduce((sum, linkId) => {
    return sum + (thermalUtil?.[linkId]?.capacity_mw || 0);
  }, 0);

  return (
    <div className="detail-panel">
      <div className="panel-header">
        <div>
          <h2>Boundary {boundaryId}</h2>
          <p className="zone-subtitle">
            {mappedName !== boundaryId ? `(${mappedName}) ` : ''}ETYS Transmission Boundary
          </p>
        </div>
        <button className="close-button" onClick={onClose}>×</button>
      </div>

      <div className="panel-content">
        {/* Power Flow Stats */}
        {boundaryUtil ? (
          <>
            {/* Main utilisation display */}
            <div className="utilisation-hero">
              <div className="utilisation-value" style={{
                color: boundaryUtil.utilisation_pct > 85 ? '#ef4444' :
                       boundaryUtil.utilisation_pct > 75 ? '#f97316' :
                       boundaryUtil.utilisation_pct > 60 ? '#facc15' : '#22c55e'
              }}>
                {boundaryUtil.utilisation_pct.toFixed(1)}%
              </div>
              <div className="utilisation-label">Boundary Utilisation</div>
            </div>

            <div className="stats-grid">
              <div className="stat-card">
                <div className="stat-label">Power Flow</div>
                <div className="stat-value">{boundaryUtil.flow_mw.toFixed(0)} MW</div>
              </div>
              <div className="stat-card">
                <div className="stat-label">Capability</div>
                <div className="stat-value">{boundaryUtil.capability_mw.toFixed(0)} MW</div>
              </div>
              <div className="stat-card">
                <div className="stat-label">Thermal Capacity</div>
                <div className="stat-value">{totalThermalCapacity.toFixed(0)} MW</div>
              </div>
              <div className="stat-card">
                <div className="stat-label">Security Margin</div>
                <div className="stat-value">
                  {totalThermalCapacity > 0
                    ? ((totalThermalCapacity - boundaryUtil.capability_mw) / totalThermalCapacity * 100).toFixed(0)
                    : 0}%
                </div>
              </div>
            </div>

            {/* Utilisation Explanation */}
            <div className="info-box">
              <strong>Boundary vs Thermal:</strong> ETYS capability ({boundaryUtil.capability_mw.toFixed(0)} MW)
              includes N-1 security, voltage limits, and stability constraints.
              Thermal capacity ({totalThermalCapacity.toFixed(0)} MW) is raw conductor rating.
            </div>
          </>
        ) : (
          <div className="stats-grid">
            <div className="stat-card" style={{ gridColumn: '1 / -1' }}>
              <div className="stat-label">2024 Capability</div>
              <div className="stat-value">
                {capability_2024_mw ? `${capability_2024_mw.toLocaleString()} MW` : 'N/A'}
              </div>
            </div>
          </div>
        )}

        {/* North/South Zones */}
        <div className="section">
          <h3 className="section-title">Connected Zones</h3>
          <div className="boundary-zones">
            <div className="boundary-zone-group">
              <span className="boundary-zone-label">North:</span>
              <span className="boundary-zone-list">
                {north_zones?.join(', ') || 'N/A'}
              </span>
            </div>
            <div className="boundary-zone-group">
              <span className="boundary-zone-label">South:</span>
              <span className="boundary-zone-list">
                {south_zones?.join(', ') || 'N/A'}
              </span>
            </div>
          </div>
        </div>

        {/* Crossing Links with Flows and Thermal Utilisation */}
        {crossing_links && crossing_links.length > 0 && (
          <div className="section">
            <h3
              className="section-title collapsible"
              onClick={() => setCrossingLinksExpanded(!crossingLinksExpanded)}
              role="button"
              tabIndex={0}
              aria-expanded={crossingLinksExpanded}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setCrossingLinksExpanded(!crossingLinksExpanded); } }}
            >
              <span className="collapse-icon">{crossingLinksExpanded ? '▼' : '▶'}</span>
              Crossing Links ({crossing_links.length})
            </h3>
            {crossingLinksExpanded && (
              <div className="crossing-links-list">
                {crossing_links.map(linkId => {
                  const linkUtil = thermalUtil?.[linkId];
                  const thermalPct = linkUtil?.utilisation_pct || 0;
                  return (
                    <div key={linkId} className="crossing-link-item">
                      <div className="link-info">
                        <div className="link-id">{linkId}</div>
                        {linkUtil && (
                          <div className="link-capacity">
                            {linkUtil.capacity_mw.toFixed(0)} MW rated
                          </div>
                        )}
                      </div>
                      {linkUtil && (
                        <div className="link-stats">
                          <div className="link-flow">
                            {linkUtil.flow_mw.toFixed(0)} MW
                          </div>
                          <div className="link-thermal" style={{
                            color: thermalPct > 80 ? '#ef4444' :
                                   thermalPct > 60 ? '#f97316' :
                                   thermalPct > 40 ? '#facc15' : '#94a3b8'
                          }}>
                            {thermalPct.toFixed(1)}% thermal
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function ZoneDetail({ selectedZone, zone, powerFlowResults, plantsData, plantEdits, addedNodes, onOpenPlantEditor, onOpenNodeAdder, onClose }) {
  // Collapsible section state
  const [dispatchExpanded, setDispatchExpanded] = useState(true);
  const [pipelineExpanded, setPipelineExpanded] = useState(false);
  const [demandForecastExpanded, setDemandForecastExpanded] = useState(false);
  const [technicalExpanded, setTechnicalExpanded] = useState(false);
  const [plantsExpanded, setPlantsExpanded] = useState(false);
  const [addedNodesExpanded, setAddedNodesExpanded] = useState(true);

  // Get power flow data for this zone
  const netInjection = powerFlowResults?.zoneInjections?.[selectedZone] || 0;
  const generation = powerFlowResults?.zoneGeneration?.[selectedZone] || 0;
  const demand = powerFlowResults?.zoneDemand?.[selectedZone] || 0;
  const angle = powerFlowResults?.angles?.[selectedZone] || 0;
  const zoneGenByType = powerFlowResults?.zoneGenerationByType?.[selectedZone] || {};

  // Get base zone data
  const genByType = zone.generation_by_type || {};
  const totalBuilt = zone.total_built_mw || 0;
  const totalPipeline = zone.total_pipeline_mw || 0;

  // Get zone's plants from plants data
  const zonePlants = plantsData?.filter(p => p.zone_id === selectedZone) || [];
  const builtPlants = zonePlants.filter(p => p.status === 'Built' && p.mw_connected > 0);

  // Get hypothetical nodes for this zone
  const zoneAddedNodes = (addedNodes || []).filter(n => n.zoneId === selectedZone);
  const totalAddedMW = zoneAddedNodes.reduce((sum, n) => sum + n.capacityMW, 0);

  // Build dispatch breakdown: compare installed vs dispatched
  const dispatchBreakdown = [];
  for (const [plantType, typeData] of Object.entries(genByType)) {
    const installed = typeData.built_mw || 0;
    const dispatched = zoneGenByType[plantType] || 0;
    if (installed > 0 || dispatched > 0) {
      const cf = installed > 0 ? (dispatched / installed) : 0;
      dispatchBreakdown.push({
        type: plantType,
        installed,
        dispatched,
        cf,
        nProjects: typeData.n_projects || 0
      });
    }
  }
  // Sort by dispatched MW
  dispatchBreakdown.sort((a, b) => b.dispatched - a.dispatched);

  // Separate active (dispatched > 0) and inactive
  const activeDispatch = dispatchBreakdown.filter(d => d.dispatched > 0);
  const inactiveDispatch = dispatchBreakdown.filter(d => d.dispatched === 0 && d.installed > 0);

  // Get pipeline-only types
  const pipelineTypes = Object.entries(genByType)
    .filter(([_, data]) => data.built_mw === 0 && data.total_mw > 0)
    .sort((a, b) => b[1].total_mw - a[1].total_mw);

  // Determine zone status
  const isExporting = netInjection > 100;
  const isImporting = netInjection < -100;
  const statusText = isExporting ? 'Exporting' : isImporting ? 'Importing' : 'Balanced';
  const statusColor = isExporting ? '#22c55e' : isImporting ? '#ef4444' : '#94a3b8';

  return (
    <div className="detail-panel">
      <div className="panel-header">
        <div>
          <h2>{selectedZone}</h2>
          <p className="zone-subtitle">TNUoS Generation Zone</p>
        </div>
        <button className="close-button" onClick={onClose}>×</button>
      </div>

      <div className="panel-content">
        {/* Main Power Balance Display */}
        <div className="power-balance-hero">
          <div className="balance-status" style={{ color: statusColor }}>
            {statusText}: {Math.abs(netInjection).toFixed(0)} MW
          </div>
          <div className="balance-bar">
            <div className="balance-gen">
              <span className="balance-label">Generation</span>
              <span className="balance-value">{generation.toFixed(0)} MW</span>
            </div>
            <div className="balance-separator">→</div>
            <div className="balance-demand">
              <span className="balance-label">Demand</span>
              <span className="balance-value">{demand.toFixed(0)} MW</span>
            </div>
          </div>
        </div>

        {/* Dispatch Breakdown - Weather-adjusted */}
        {activeDispatch.length > 0 && (
          <div className="section">
            <h3
              className="section-title collapsible"
              onClick={() => setDispatchExpanded(!dispatchExpanded)}
              role="button"
              tabIndex={0}
              aria-expanded={dispatchExpanded}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setDispatchExpanded(!dispatchExpanded); } }}
            >
              <span className="collapse-icon">{dispatchExpanded ? '▼' : '▶'}</span>
              Active Generation ({generation.toFixed(0)} MW)
            </h3>
            {dispatchExpanded && (
              <div className="dispatch-list">
                {activeDispatch.map(d => (
                  <div key={d.type} className="dispatch-row">
                    <div className="dispatch-header">
                      <span className="dispatch-type">{d.type}</span>
                      <span className="dispatch-output">{d.dispatched.toFixed(0)} MW</span>
                    </div>
                    <div className="dispatch-details">
                      <div className="dispatch-bar-container">
                        <div
                          className="dispatch-bar"
                          style={{
                            width: `${Math.min(d.cf * 100, 100)}%`,
                            backgroundColor: d.cf >= 0.8 ? '#22c55e' :
                                           d.cf >= 0.5 ? '#facc15' :
                                           d.cf >= 0.2 ? '#fb923c' : '#94a3b8'
                          }}
                        />
                      </div>
                      <span className="dispatch-cf">
                        {(d.cf * 100).toFixed(0)}% of {d.installed.toFixed(0)} MW
                      </span>
                    </div>
                  </div>
                ))}
                {inactiveDispatch.length > 0 && (
                  <div className="inactive-note">
                    {inactiveDispatch.length} type(s) with {inactiveDispatch.reduce((s, d) => s + d.installed, 0).toFixed(0)} MW installed but not dispatching
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* Pipeline Projects */}
        {pipelineTypes.length > 0 && (
          <div className="section">
            <h3
              className="section-title collapsible"
              onClick={() => setPipelineExpanded(!pipelineExpanded)}
              role="button"
              tabIndex={0}
              aria-expanded={pipelineExpanded}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setPipelineExpanded(!pipelineExpanded); } }}
            >
              <span className="collapse-icon">{pipelineExpanded ? '▼' : '▶'}</span>
              Pipeline ({totalPipeline.toLocaleString()} MW)
            </h3>
            {pipelineExpanded && (
              <div className="gen-type-list">
                {pipelineTypes.map(([type, data]) => (
                  <div key={type} className="gen-type-row">
                    <div className="gen-type-info">
                      <span className="gen-type-name">{type}</span>
                      <span className="gen-type-count">{data.n_projects || 0} projects</span>
                    </div>
                    <div className="gen-type-capacity">
                      <div className="capacity-built">
                        {data.total_mw.toLocaleString()} MW
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Hypothetical Generation */}
        <div className="section">
          <h3
            className="section-title collapsible"
            onClick={() => setAddedNodesExpanded(!addedNodesExpanded)}
            role="button"
            tabIndex={0}
            aria-expanded={addedNodesExpanded}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setAddedNodesExpanded(!addedNodesExpanded); } }}
          >
            <span className="collapse-icon">{addedNodesExpanded ? '▼' : '▶'}</span>
            Hypothetical Generation
            {zoneAddedNodes.length > 0 && (
              <span className="added-count">{totalAddedMW.toLocaleString()} MW</span>
            )}
          </h3>
          {addedNodesExpanded && (
            <>
              {zoneAddedNodes.length > 0 && (
                <div className="added-nodes-list">
                  {zoneAddedNodes.map(node => (
                    <div key={node.id} className="added-node-row">
                      <span className="added-node-name">{node.name}</span>
                      <span className="added-node-details">
                        {node.plantType} • {node.capacityMW.toLocaleString()} MW
                      </span>
                    </div>
                  ))}
                </div>
              )}
              <button
                className="add-generation-btn"
                onClick={() => onOpenNodeAdder?.(selectedZone)}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <line x1="12" y1="5" x2="12" y2="19" />
                  <line x1="5" y1="12" x2="19" y2="12" />
                </svg>
                Add Generation
              </button>
            </>
          )}
        </div>

        {/* Individual Plants (first 10 built) */}
        {builtPlants.length > 0 && (
          <div className="section">
            <h3
              className="section-title collapsible"
              onClick={() => setPlantsExpanded(!plantsExpanded)}
              role="button"
              tabIndex={0}
              aria-expanded={plantsExpanded}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setPlantsExpanded(!plantsExpanded); } }}
            >
              <span className="collapse-icon">{plantsExpanded ? '▼' : '▶'}</span>
              Plants ({builtPlants.length} built)
              {Object.keys(plantEdits || {}).filter(id =>
                builtPlants.some(p => (p.project_id || p.project) === id)
              ).length > 0 && (
                <span className="edit-count">
                  {Object.keys(plantEdits || {}).filter(id =>
                    builtPlants.some(p => (p.project_id || p.project) === id)
                  ).length} edited
                </span>
              )}
            </h3>
            {plantsExpanded && (
              <>
                <div className="plants-list">
                  {builtPlants.slice(0, 10).map((plant, idx) => {
                    const plantId = plant.project_id || plant.project;
                    const edit = plantEdits?.[plantId];
                    const isEdited = !!edit;
                    const effectiveStatus = edit?.status || plant.status;
                    const effectiveOutput = edit?.status === 'Retired' ? 0 : (edit?.outputPct ?? 100);
                    const effectiveMW = plant.mw_connected * (effectiveOutput / 100);

                    return (
                      <div key={plantId || idx} className={`plant-row ${isEdited ? 'edited' : ''}`}>
                        <div className="plant-name">
                          {plant.project}
                          {isEdited && <span className="plant-edit-badge">edited</span>}
                        </div>
                        <div className="plant-details">
                          <span className={`plant-type ${effectiveStatus === 'Retired' ? 'retired' : ''}`}>
                            {plant.plant_type}
                          </span>
                          <span className={`plant-mw ${effectiveMW < plant.mw_connected ? 'reduced' : ''}`}>
                            {effectiveMW.toFixed(0)} MW
                            {effectiveMW < plant.mw_connected && (
                              <span className="plant-base-mw">/ {plant.mw_connected.toFixed(0)}</span>
                            )}
                          </span>
                        </div>
                      </div>
                    );
                  })}
                  {builtPlants.length > 10 && (
                    <div className="plants-more">
                      +{builtPlants.length - 10} more plants
                    </div>
                  )}
                </div>
                <button
                  className="edit-plants-btn"
                  onClick={() => onOpenPlantEditor?.(selectedZone)}
                >
                  Edit Plants
                </button>
              </>
            )}
          </div>
        )}

        {/* Demand Forecast */}
        {zone.demand_mw_by_year && (
          <div className="section">
            <h3
              className="section-title collapsible"
              onClick={() => setDemandForecastExpanded(!demandForecastExpanded)}
              role="button"
              tabIndex={0}
              aria-expanded={demandForecastExpanded}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setDemandForecastExpanded(!demandForecastExpanded); } }}
            >
              <span className="collapse-icon">{demandForecastExpanded ? '▼' : '▶'}</span>
              Demand Forecast
            </h3>
            {demandForecastExpanded && (
              <div className="demand-list">
                {Object.entries(zone.demand_mw_by_year)
                  .sort((a, b) => Number(a[0]) - Number(b[0]))
                  .slice(0, 5)
                  .map(([year, mw]) => (
                    <div key={year} className="demand-row">
                      <span className="demand-year">{year}</span>
                      <span className="demand-value">{mw.toLocaleString()} MW</span>
                    </div>
                  ))}
              </div>
            )}
          </div>
        )}

        {/* Technical Details */}
        <div className="section">
          <h3
            className="section-title collapsible"
            onClick={() => setTechnicalExpanded(!technicalExpanded)}
            role="button"
            tabIndex={0}
            aria-expanded={technicalExpanded}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setTechnicalExpanded(!technicalExpanded); } }}
          >
            <span className="collapse-icon">{technicalExpanded ? '▼' : '▶'}</span>
            Technical
          </h3>
          {technicalExpanded && (
            <div className="stats-grid">
              <div className="stat-card">
                <div className="stat-label">Voltage Angle</div>
                <div className="stat-value" style={{ fontSize: '16px' }}>{angle.toFixed(2)}°</div>
              </div>
              <div className="stat-card">
                <div className="stat-label">Substations</div>
                <div className="stat-value" style={{ fontSize: '16px' }}>{zone.n_substations || 0}</div>
              </div>
              <div className="stat-card">
                <div className="stat-label">Built Capacity</div>
                <div className="stat-value" style={{ fontSize: '16px' }}>{totalBuilt.toLocaleString()} MW</div>
              </div>
              <div className="stat-card">
                <div className="stat-label">Built Plants</div>
                <div className="stat-value" style={{ fontSize: '16px' }}>{builtPlants.length}</div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function WelcomeOverview({ powerFlowResults, zoneData, onBoundaryClick, onClose }) {
  // Calculate summary stats
  const totalGeneration = powerFlowResults?.validationInfo?.totalGeneration || 0;
  const totalDemand = powerFlowResults?.validationInfo?.totalDemand || 0;
  const numZones = Object.keys(zoneData || {}).length;
  const imbalance = totalGeneration - totalDemand;

  // Get top stressed boundaries
  const topBoundaries = powerFlowResults?.validationInfo?.topBoundaryUtilisations || [];

  // Count zones by net injection status
  const zoneInjections = powerFlowResults?.zoneInjections || {};
  const exportingZones = Object.values(zoneInjections).filter(v => v > 100).length;
  const importingZones = Object.values(zoneInjections).filter(v => v < -100).length;
  const balancedZones = numZones - exportingZones - importingZones;

  return (
    <div className="detail-panel">
      <div className="panel-header">
        <div>
          <h2>Overview</h2>
          <p className="zone-subtitle">GB Transmission Network</p>
        </div>
        <button className="close-button" onClick={onClose}>×</button>
      </div>

      <div className="panel-content">
        {/* National Balance */}
        <div className="welcome-hero">
          <div className="welcome-title">National Power Balance</div>
          <div className="welcome-balance">
            <div className="welcome-stat">
              <span className="stat-value" style={{ color: '#22c55e' }}>{(totalGeneration / 1000).toFixed(1)}</span>
              <span className="stat-unit">GW</span>
              <span className="stat-label">Generation</span>
            </div>
            <div className="welcome-arrow">→</div>
            <div className="welcome-stat">
              <span className="stat-value" style={{ color: '#f97316' }}>{(totalDemand / 1000).toFixed(1)}</span>
              <span className="stat-unit">GW</span>
              <span className="stat-label">Demand</span>
            </div>
          </div>
          <div className="welcome-imbalance" style={{
            color: Math.abs(imbalance) < 500 ? '#94a3b8' : imbalance > 0 ? '#22c55e' : '#ef4444'
          }}>
            {imbalance >= 0 ? '+' : ''}{(imbalance / 1000).toFixed(1)} GW {Math.abs(imbalance) < 500 ? 'balanced' : imbalance > 0 ? 'surplus' : 'deficit'}
          </div>
        </div>

        {/* Zone Summary */}
        <div className="section">
          <h3 className="section-title">Zone Summary</h3>
          <div className="welcome-zones">
            <div className="zone-chip exporting">
              <span className="chip-value">{exportingZones}</span>
              <span className="chip-label">Exporting</span>
            </div>
            <div className="zone-chip balanced">
              <span className="chip-value">{balancedZones}</span>
              <span className="chip-label">Balanced</span>
            </div>
            <div className="zone-chip importing">
              <span className="chip-value">{importingZones}</span>
              <span className="chip-label">Importing</span>
            </div>
          </div>
        </div>

        {/* Top Stressed Boundaries */}
        {topBoundaries.length > 0 && (
          <div className="section">
            <h3 className="section-title">Most Stressed Boundaries</h3>
            <div className="welcome-boundaries">
              {topBoundaries.slice(0, 5).map(b => (
                <div
                  key={b.id}
                  className={`boundary-row clickable ${b.utilisation_pct > 100 ? 'constrained' : ''}`}
                  onClick={() => onBoundaryClick?.(b.id)}
                  title="Click to view boundary details"
                >
                  <span className="boundary-name">{b.id}</span>
                  <div className="boundary-bar-container">
                    <div
                      className="boundary-bar"
                      style={{
                        width: `${Math.min(b.utilisation_pct, 100)}%`,
                        backgroundColor: b.utilisation_pct > 85 ? '#ef4444' :
                                        b.utilisation_pct > 75 ? '#f97316' :
                                        b.utilisation_pct > 60 ? '#facc15' : '#22c55e'
                      }}
                    />
                    {b.utilisation_pct > 100 && (
                      <div className="boundary-overflow" style={{
                        width: `${Math.min((b.utilisation_pct - 100) / 2, 50)}%`
                      }} />
                    )}
                  </div>
                  <span className="boundary-util" style={{
                    color: b.utilisation_pct > 100 ? '#dc2626' :
                           b.utilisation_pct > 85 ? '#ef4444' :
                           b.utilisation_pct > 75 ? '#f97316' :
                           b.utilisation_pct > 60 ? '#facc15' : '#94a3b8'
                  }}>
                    {b.utilisation_pct > 100 && <span className="constrained-label">!</span>}
                    {b.utilisation_pct.toFixed(0)}%
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Instructions */}
        <div className="welcome-instructions">
          <div className="instruction-item">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="10" />
              <path d="M8 12l2 2 4-4" />
            </svg>
            <span>Click a <strong>zone</strong> to view generation and demand</span>
          </div>
          <div className="instruction-item">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M4 6h16M4 12h16M4 18h16" />
            </svg>
            <span>Click a <strong>boundary line</strong> to view power flows</span>
          </div>
          <div className="instruction-item">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="3" />
              <path d="M12 2v4m0 12v4M2 12h4m12 0h4" />
            </svg>
            <span>Adjust <strong>controls</strong> on the right to change scenario</span>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function DetailPanel({ selectedZone, selectedBoundary, zoneData, boundaryData, powerFlowResults, plantsData, plantEdits, addedNodes, onOpenPlantEditor, onOpenNodeAdder, onBoundaryClick, onClose }) {
  // Show boundary detail if boundary is selected
  if (selectedBoundary && boundaryData) {
    return <BoundaryDetail
      boundaryId={selectedBoundary}
      boundaryData={boundaryData}
      powerFlowResults={powerFlowResults}
      onClose={onClose}
    />;
  }

  if (!selectedZone) {
    // Show welcome overview instead of empty state
    return <WelcomeOverview
      powerFlowResults={powerFlowResults}
      zoneData={zoneData}
      onBoundaryClick={onBoundaryClick}
      onClose={onClose}
    />;
  }

  const zone = zoneData[selectedZone];

  if (!zone) {
    return (
      <div className="detail-panel">
        <div className="panel-header">
          <h2>{selectedZone}</h2>
          <button className="close-button" onClick={onClose}>×</button>
        </div>
        <div className="panel-content">
          <p style={{ color: '#6b7280' }}>No data available for this zone</p>
        </div>
      </div>
    );
  }

  return <ZoneDetail
    selectedZone={selectedZone}
    zone={zone}
    powerFlowResults={powerFlowResults}
    plantsData={plantsData}
    plantEdits={plantEdits}
    addedNodes={addedNodes}
    onOpenPlantEditor={onOpenPlantEditor}
    onOpenNodeAdder={onOpenNodeAdder}
    onClose={onClose}
  />;
}
