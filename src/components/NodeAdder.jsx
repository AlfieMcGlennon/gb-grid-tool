import { useState } from 'react'
import './NodeAdder.css'

/**
 * NodeAdder - Add hypothetical generation nodes to zones
 *
 * Features:
 * - Select plant type from dropdown
 * - Enter capacity in MW
 * - Optional name for the node
 * - Node participates in dispatch
 * - Stored in session state
 */

const PLANT_TYPES = [
  { value: 'Wind Offshore', label: 'Wind Offshore', color: '#3b82f6' },
  { value: 'Wind Onshore', label: 'Wind Onshore', color: '#60a5fa' },
  { value: 'Solar', label: 'Solar', color: '#fbbf24' },
  { value: 'Nuclear', label: 'Nuclear', color: '#a855f7' },
  { value: 'CCGT', label: 'CCGT (Gas)', color: '#f97316' },
  { value: 'OCGT', label: 'OCGT (Peaker)', color: '#ef4444' },
  { value: 'Hydro', label: 'Hydro', color: '#06b6d4' },
  { value: 'Pump Storage', label: 'Pumped Storage', color: '#0891b2' },
  { value: 'Biomass', label: 'Biomass', color: '#84cc16' },
  { value: 'Battery', label: 'Battery Storage', color: '#8b5cf6' },
  { value: 'Other', label: 'Other', color: '#6b7280' }
];

export default function NodeAdder({
  zoneId,
  addedNodes,
  onAddNode,
  onRemoveNode,
  onClose
}) {
  const [plantType, setPlantType] = useState('Wind Offshore');
  const [capacity, setCapacity] = useState('');
  const [nodeName, setNodeName] = useState('');
  const [error, setError] = useState(null);
  const [showDuplicateWarning, setShowDuplicateWarning] = useState(false);

  // Filter nodes for this zone
  const zoneNodes = (addedNodes || []).filter(n => n.zoneId === zoneId);

  // Actually add the node (after validation and optional duplicate confirmation)
  const doAddNode = (capacityMW) => {
    const newNode = {
      id: `user_${Date.now()}`,
      zoneId,
      plantType,
      capacityMW,
      name: nodeName.trim() || `Hypothetical ${plantType}`,
      createdAt: new Date().toISOString()
    };

    onAddNode(newNode);
    setShowDuplicateWarning(false);

    // Reset form
    setCapacity('');
    setNodeName('');
  };

  // Handle add node
  const handleAdd = () => {
    setError(null);
    setShowDuplicateWarning(false);

    const capacityMW = parseFloat(capacity);
    if (isNaN(capacityMW) || capacityMW <= 0) {
      setError('Please enter a valid capacity (> 0 MW)');
      return;
    }

    if (capacityMW > 10000) {
      setError('Maximum capacity is 10,000 MW');
      return;
    }

    // Check for duplicate
    const isDuplicate = addedNodes?.some(
      n => n.plantType === plantType && n.capacityMW === capacityMW && n.zoneId === zoneId
    );

    if (isDuplicate) {
      setShowDuplicateWarning(true);
      return;
    }

    doAddNode(capacityMW);
  };

  // Get plant type config
  const getPlantConfig = (type) => {
    return PLANT_TYPES.find(p => p.value === type) || PLANT_TYPES[PLANT_TYPES.length - 1];
  };

  // Calculate total added capacity
  const totalAdded = zoneNodes.reduce((sum, n) => sum + n.capacityMW, 0);

  return (
    <div className="node-adder">
      <div className="node-adder-header">
        <div>
          <h2>Add Generation - {zoneId}</h2>
          <p className="node-adder-subtitle">
            Add hypothetical generation to test scenarios
          </p>
        </div>
        <button className="close-button" onClick={onClose}>×</button>
      </div>

      <div className="node-adder-content">
        {/* Add New Node Form */}
        <div className="add-form">
          <div className="form-row">
            <label className="form-label">Plant Type</label>
            <select
              className="form-select"
              value={plantType}
              onChange={(e) => setPlantType(e.target.value)}
            >
              {PLANT_TYPES.map(type => (
                <option key={type.value} value={type.value}>
                  {type.label}
                </option>
              ))}
            </select>
          </div>

          <div className="form-row">
            <label className="form-label">Capacity (MW)</label>
            <input
              type="number"
              className="form-input"
              value={capacity}
              onChange={(e) => setCapacity(e.target.value)}
              placeholder="e.g. 1000"
              min="0"
              max="10000"
              step="100"
            />
          </div>

          <div className="form-row">
            <label className="form-label">Name (optional)</label>
            <input
              type="text"
              className="form-input"
              value={nodeName}
              onChange={(e) => setNodeName(e.target.value)}
              placeholder="e.g. East Anglia Hub"
              maxLength={50}
            />
          </div>

          {error && (
            <div className="form-error">{error}</div>
          )}

          {showDuplicateWarning && (
            <div className="duplicate-warning">
              <p>A node with the same type and capacity already exists in this zone. Add anyway?</p>
              <div className="duplicate-warning-buttons">
                <button
                  className="duplicate-confirm-btn"
                  onClick={() => doAddNode(parseFloat(capacity))}
                >
                  Yes, Add
                </button>
                <button
                  className="duplicate-cancel-btn"
                  onClick={() => setShowDuplicateWarning(false)}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          {!showDuplicateWarning && (
            <button
              className="add-node-btn"
              onClick={handleAdd}
              disabled={!capacity}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
              Add Generation
            </button>
          )}
        </div>

        {/* Existing Added Nodes */}
        {zoneNodes.length > 0 && (
          <div className="added-nodes">
            <h3 className="added-nodes-title">
              Added to {zoneId}
              <span className="added-total">{totalAdded.toLocaleString()} MW total</span>
            </h3>
            <div className="nodes-list">
              {zoneNodes.map(node => {
                const config = getPlantConfig(node.plantType);
                return (
                  <div key={node.id} className="node-item">
                    <div
                      className="node-type-indicator"
                      style={{ backgroundColor: config.color }}
                    />
                    <div className="node-info">
                      <div className="node-name">{node.name}</div>
                      <div className="node-details">
                        {config.label} • {node.capacityMW.toLocaleString()} MW
                      </div>
                    </div>
                    <button
                      className="remove-node-btn"
                      onClick={() => onRemoveNode(node.id)}
                      title="Remove"
                    >
                      ×
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Info */}
        <div className="node-adder-info">
          <p>
            Added generation participates in dispatch and power flow calculations.
            Wind and solar output is scaled by current weather percentiles.
          </p>
        </div>
      </div>
    </div>
  );
}
