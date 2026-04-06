import { useState, useMemo } from 'react'
import './PlantEditor.css'

/**
 * PlantEditor - Edit individual power plants within a zone
 *
 * Features:
 * - List of plants with search/filter
 * - Output slider (0-100% of installed capacity)
 * - Status toggle (Built, Retired, Under Construction)
 * - Commissioning year picker
 * - Session overlay for edits (not persisted to data files)
 */
export default function PlantEditor({
  zoneId,
  plantsData,
  plantEdits,
  onPlantEdit,
  onClose
}) {
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [typeFilter, setTypeFilter] = useState('all');
  const [expandedPlant, setExpandedPlant] = useState(null);

  // Filter plants for this zone
  const zonePlants = useMemo(() => {
    if (!plantsData || !zoneId) return [];
    return plantsData
      .filter(p => p.zone_id === zoneId)
      .map(p => ({
        ...p,
        // Apply any existing edits
        ...plantEdits?.[p.project_id || p.project]
      }));
  }, [plantsData, zoneId, plantEdits]);

  // Get unique statuses and types for filters
  const statuses = useMemo(() => {
    const set = new Set(zonePlants.map(p => p.status));
    return ['all', ...Array.from(set).sort()];
  }, [zonePlants]);

  const plantTypes = useMemo(() => {
    const set = new Set(zonePlants.map(p => p.plant_type));
    return ['all', ...Array.from(set).sort()];
  }, [zonePlants]);

  // Apply filters
  const filteredPlants = useMemo(() => {
    return zonePlants.filter(plant => {
      const matchesSearch = !searchTerm ||
        plant.project?.toLowerCase().includes(searchTerm.toLowerCase()) ||
        plant.plant_type?.toLowerCase().includes(searchTerm.toLowerCase());
      const matchesStatus = statusFilter === 'all' || plant.status === statusFilter;
      const matchesType = typeFilter === 'all' || plant.plant_type === typeFilter;
      return matchesSearch && matchesStatus && matchesType;
    });
  }, [zonePlants, searchTerm, statusFilter, typeFilter]);

  // Calculate zone summary with edits applied
  const zoneSummary = useMemo(() => {
    let originalMW = 0;
    let editedMW = 0;
    let nEdits = 0;

    for (const plant of zonePlants) {
      const baseMW = plant.mw_connected || 0;
      originalMW += baseMW;

      const plantId = plant.project_id || plant.project;
      const edit = plantEdits?.[plantId];

      if (edit) {
        nEdits++;
        if (edit.status === 'Retired') {
          editedMW += 0;
        } else if (edit.outputPct !== undefined) {
          editedMW += baseMW * (edit.outputPct / 100);
        } else {
          editedMW += baseMW;
        }
      } else {
        editedMW += baseMW;
      }
    }

    return { originalMW, editedMW, nEdits };
  }, [zonePlants, plantEdits]);

  // Handle plant edit
  const handleEdit = (plant, field, value) => {
    const plantId = plant.project_id || plant.project;
    const existingEdit = plantEdits?.[plantId] || {};

    onPlantEdit(plantId, {
      ...existingEdit,
      [field]: value,
      _plantType: plant.plant_type,
      _baseMW: plant.mw_connected || plant.mw_total || 0
    });
  };

  // Reset a single plant's edits
  const handleResetPlant = (plant) => {
    const plantId = plant.project_id || plant.project;
    onPlantEdit(plantId, null);
  };

  // Get effective status for a plant (edited or original)
  const getEffectiveStatus = (plant) => {
    const plantId = plant.project_id || plant.project;
    const edit = plantEdits?.[plantId];
    return edit?.status || plant.status;
  };

  // Get effective output percentage
  const getEffectiveOutput = (plant) => {
    const plantId = plant.project_id || plant.project;
    const edit = plantEdits?.[plantId];
    if (edit?.status === 'Retired') return 0;
    return edit?.outputPct ?? 100;
  };

  // Check if a plant has been edited
  const hasEdit = (plant) => {
    const plantId = plant.project_id || plant.project;
    return !!plantEdits?.[plantId];
  };

  return (
    <div className="plant-editor">
      <div className="plant-editor-header">
        <div className="plant-editor-title">
          <h2>Edit Plants - {zoneId}</h2>
          <p className="plant-editor-subtitle">
            {zonePlants.length} plants, {zoneSummary.originalMW.toFixed(0)} MW installed
          </p>
        </div>
        <button className="close-button" onClick={onClose}>×</button>
      </div>

      {/* Zone Summary with Edits */}
      {zoneSummary.nEdits > 0 && (
        <div className="plant-editor-summary">
          <div className="summary-stat">
            <span className="summary-label">Edits</span>
            <span className="summary-value">{zoneSummary.nEdits}</span>
          </div>
          <div className="summary-stat">
            <span className="summary-label">Original</span>
            <span className="summary-value">{zoneSummary.originalMW.toFixed(0)} MW</span>
          </div>
          <div className="summary-stat">
            <span className="summary-label">After Edits</span>
            <span className="summary-value" style={{
              color: zoneSummary.editedMW < zoneSummary.originalMW ? '#f97316' : '#22c55e'
            }}>
              {zoneSummary.editedMW.toFixed(0)} MW
            </span>
          </div>
        </div>
      )}

      {/* Filters */}
      <div className="plant-editor-filters">
        <input
          type="text"
          className="plant-search"
          placeholder="Search plants..."
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
        />
        <select
          className="plant-filter"
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
        >
          {statuses.map(s => (
            <option key={s} value={s}>{s === 'all' ? 'All Statuses' : s}</option>
          ))}
        </select>
        <select
          className="plant-filter"
          value={typeFilter}
          onChange={(e) => setTypeFilter(e.target.value)}
        >
          {plantTypes.map(t => (
            <option key={t} value={t}>{t === 'all' ? 'All Types' : t}</option>
          ))}
        </select>
      </div>

      {/* Plants List */}
      <div className="plant-editor-list">
        {filteredPlants.length === 0 ? (
          <div className="plant-editor-empty">
            No plants match the current filters
          </div>
        ) : (
          filteredPlants.map((plant, idx) => {
            const plantId = plant.project_id || plant.project;
            const isExpanded = expandedPlant === plantId;
            const effectiveStatus = getEffectiveStatus(plant);
            const effectiveOutput = getEffectiveOutput(plant);
            const isEdited = hasEdit(plant);
            const baseMW = plant.mw_connected || plant.mw_total || 0;
            const effectiveMW = effectiveStatus === 'Retired' ? 0 : baseMW * (effectiveOutput / 100);

            return (
              <div
                key={plantId || idx}
                className={`plant-editor-item ${isExpanded ? 'expanded' : ''} ${isEdited ? 'edited' : ''}`}
              >
                {/* Plant Header - Click to expand */}
                <div
                  className="plant-editor-item-header"
                  onClick={() => setExpandedPlant(isExpanded ? null : plantId)}
                >
                  <div className="plant-item-info">
                    <div className="plant-item-name">
                      {plant.project}
                      {isEdited && <span className="edit-badge">edited</span>}
                    </div>
                    <div className="plant-item-meta">
                      <span className="plant-item-type">{plant.plant_type}</span>
                      <span className={`plant-item-status ${effectiveStatus?.toLowerCase().replace(/\s+/g, '-')}`}>
                        {effectiveStatus}
                      </span>
                    </div>
                  </div>
                  <div className="plant-item-power">
                    <span className={`plant-item-mw ${effectiveMW < baseMW ? 'reduced' : ''}`}>
                      {effectiveMW.toFixed(0)} MW
                    </span>
                    {effectiveMW < baseMW && (
                      <span className="plant-item-base-mw">/ {baseMW.toFixed(0)}</span>
                    )}
                  </div>
                  <span className="expand-icon">{isExpanded ? '▼' : '▶'}</span>
                </div>

                {/* Expanded Edit Panel */}
                {isExpanded && (
                  <div className="plant-editor-controls">
                    {/* Status Toggle */}
                    <div className="control-group">
                      <label className="control-label">Status</label>
                      <div className="status-buttons">
                        {['Built', 'Under Construction', 'Retired'].map(status => (
                          <button
                            key={status}
                            className={`status-btn ${effectiveStatus === status ? 'active' : ''}`}
                            onClick={() => handleEdit(plant, 'status', status)}
                          >
                            {status}
                          </button>
                        ))}
                      </div>
                    </div>

                    {/* Output Slider */}
                    {effectiveStatus !== 'Retired' && (
                      <div className="control-group">
                        <label className="control-label">
                          Output: {effectiveOutput}% ({effectiveMW.toFixed(0)} MW)
                        </label>
                        <input
                          type="range"
                          className="output-slider"
                          min="0"
                          max="100"
                          value={effectiveOutput}
                          onChange={(e) => handleEdit(plant, 'outputPct', Number(e.target.value))}
                        />
                        <div className="slider-labels">
                          <span>0%</span>
                          <span>50%</span>
                          <span>100%</span>
                        </div>
                      </div>
                    )}

                    {/* Commissioning Year (for non-built) */}
                    {plant.status !== 'Built' && effectiveStatus !== 'Retired' && (
                      <div className="control-group">
                        <label className="control-label">Commissioning Year</label>
                        <select
                          className="commissioning-select"
                          value={plantEdits?.[plantId]?.commissioningYear || plant.commissioning_year || ''}
                          onChange={(e) => handleEdit(plant, 'commissioningYear', Number(e.target.value))}
                        >
                          <option value="">Original</option>
                          {[2024, 2025, 2026, 2027, 2028, 2029, 2030, 2031, 2032, 2033, 2034, 2035].map(y => (
                            <option key={y} value={y}>{y}</option>
                          ))}
                        </select>
                      </div>
                    )}

                    {/* Reset Button */}
                    {isEdited && (
                      <button
                        className="reset-plant-btn"
                        onClick={() => handleResetPlant(plant)}
                      >
                        Reset to Original
                      </button>
                    )}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
