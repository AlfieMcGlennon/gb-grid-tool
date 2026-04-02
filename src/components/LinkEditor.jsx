import { useState, useMemo } from 'react'
import { ALL_ZONES } from '../config/constants'
import './LinkEditor.css'

/**
 * LinkEditor - Edit transmission links between zones
 *
 * Features:
 * - Add new links between any two zones
 * - Upgrade existing link capacity
 * - Remove links (for contingency analysis)
 * - All edits stored in session state
 */

export default function LinkEditor({
  existingLinks,
  linkEdits,
  onAddLink,
  onModifyLink,
  onRemoveLink,
  onRestoreLink,
  onClose
}) {
  const [activeTab, setActiveTab] = useState('existing'); // 'existing' | 'add'
  const [fromZone, setFromZone] = useState('GZ1');
  const [toZone, setToZone] = useState('GZ2');
  const [capacityMW, setCapacityMW] = useState('');
  const [reactance, setReactance] = useState('0.05');
  const [error, setError] = useState(null);
  const [filter, setFilter] = useState('');

  // Get all edits (added, modified, removed)
  const { added = [], removed = [], modified = {} } = linkEdits || {};

  // Filter existing links
  const filteredLinks = useMemo(() => {
    if (!existingLinks) return [];
    return existingLinks.filter(link => {
      const searchTerm = filter.toLowerCase();
      return link.id.toLowerCase().includes(searchTerm) ||
             link.from.toLowerCase().includes(searchTerm) ||
             link.to.toLowerCase().includes(searchTerm);
    });
  }, [existingLinks, filter]);

  // Check if a link is removed
  const isRemoved = (linkId) => removed.includes(linkId);

  // Check if a link is modified
  const isModified = (linkId) => !!modified[linkId];

  // Handle adding a new link
  const handleAddLink = () => {
    setError(null);

    if (fromZone === toZone) {
      setError('Cannot create a link from a zone to itself');
      return;
    }

    const capacity = parseFloat(capacityMW);
    if (isNaN(capacity) || capacity <= 0) {
      setError('Please enter a valid capacity (> 0 MW)');
      return;
    }

    const x = parseFloat(reactance);
    if (isNaN(x) || x <= 0 || x > 1) {
      setError('Please enter a valid reactance (0.01 - 1.0 pu)');
      return;
    }

    // Check if link already exists
    const linkId = `${fromZone}-${toZone}`;
    const reverseId = `${toZone}-${fromZone}`;
    const existingLink = existingLinks?.find(l => l.id === linkId || l.id === reverseId);
    const addedLink = added.find(l => l.id === linkId || l.id === reverseId);

    if (existingLink || addedLink) {
      setError(`A link between ${fromZone} and ${toZone} already exists`);
      return;
    }

    const newLink = {
      id: linkId,
      from: fromZone,
      to: toZone,
      capacity_mw: capacity,
      x_equivalent: x,
      isUserAdded: true,
      createdAt: new Date().toISOString()
    };

    onAddLink(newLink);

    // Reset form
    setCapacityMW('');
    setReactance('0.05');
  };

  // Handle modifying an existing link
  const handleModifyLink = (linkId, newCapacity) => {
    const capacity = parseFloat(newCapacity);
    if (isNaN(capacity) || capacity <= 0) return;
    onModifyLink(linkId, { capacity_mw: capacity });
  };

  // Calculate total capacity stats
  const totalExisting = existingLinks?.reduce((sum, l) => sum + (l.capacity_mw || 0), 0) || 0;
  const totalAdded = added.reduce((sum, l) => sum + (l.capacity_mw || 0), 0);
  const totalRemoved = removed.reduce((sum, id) => {
    const link = existingLinks?.find(l => l.id === id);
    return sum + (link?.capacity_mw || 0);
  }, 0);
  const totalModifiedDelta = Object.entries(modified).reduce((sum, [id, mods]) => {
    const link = existingLinks?.find(l => l.id === id);
    const originalCapacity = link?.capacity_mw || 0;
    const newCapacity = mods.capacity_mw || originalCapacity;
    return sum + (newCapacity - originalCapacity);
  }, 0);

  const netChange = totalAdded - totalRemoved + totalModifiedDelta;

  return (
    <div className="link-editor">
      <div className="link-editor-header">
        <div>
          <h2>Edit Transmission Links</h2>
          <p className="link-editor-subtitle">
            Modify network topology for scenario testing
          </p>
        </div>
        <button className="close-button" onClick={onClose}>×</button>
      </div>

      {/* Summary stats */}
      <div className="link-editor-summary">
        <div className="summary-stat">
          <span className="stat-value">{existingLinks?.length || 0}</span>
          <span className="stat-label">Base Links</span>
        </div>
        <div className="summary-stat added">
          <span className="stat-value">+{added.length}</span>
          <span className="stat-label">Added</span>
        </div>
        <div className="summary-stat removed">
          <span className="stat-value">-{removed.length}</span>
          <span className="stat-label">Removed</span>
        </div>
        <div className="summary-stat modified">
          <span className="stat-value">{Object.keys(modified).length}</span>
          <span className="stat-label">Modified</span>
        </div>
        <div className={`summary-stat net ${netChange >= 0 ? 'positive' : 'negative'}`}>
          <span className="stat-value">
            {netChange >= 0 ? '+' : ''}{netChange.toLocaleString()} MW
          </span>
          <span className="stat-label">Net Change</span>
        </div>
      </div>

      {/* Tabs */}
      <div className="link-editor-tabs">
        <button
          className={`tab-button ${activeTab === 'existing' ? 'active' : ''}`}
          onClick={() => setActiveTab('existing')}
        >
          Existing Links ({filteredLinks.length})
        </button>
        <button
          className={`tab-button ${activeTab === 'add' ? 'active' : ''}`}
          onClick={() => setActiveTab('add')}
        >
          Add New Link
        </button>
      </div>

      <div className="link-editor-content">
        {activeTab === 'existing' && (
          <>
            {/* Filter */}
            <div className="link-filter">
              <input
                type="text"
                className="filter-input"
                placeholder="Filter by zone (e.g. GZ11)"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              />
            </div>

            {/* User-added links */}
            {added.length > 0 && (
              <div className="link-section">
                <h3 className="section-title">User Added Links</h3>
                <div className="links-list">
                  {added.map(link => (
                    <div key={link.id} className="link-item added">
                      <div className="link-info">
                        <div className="link-id">{link.id}</div>
                        <div className="link-details">
                          {link.capacity_mw.toLocaleString()} MW • x={link.x_equivalent.toFixed(3)} pu
                        </div>
                      </div>
                      <button
                        className="remove-link-btn"
                        onClick={() => onRemoveLink(link.id, true)}
                        title="Remove"
                      >
                        ×
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Existing links */}
            <div className="link-section">
              <h3 className="section-title">
                Base Network Links
                {removed.length > 0 && (
                  <span className="removed-count">{removed.length} removed</span>
                )}
              </h3>
              <div className="links-list">
                {filteredLinks.map(link => {
                  const linkRemoved = isRemoved(link.id);
                  const linkMod = modified[link.id];
                  const displayCapacity = linkMod?.capacity_mw ?? link.capacity_mw;

                  return (
                    <div
                      key={link.id}
                      className={`link-item ${linkRemoved ? 'removed' : ''} ${linkMod ? 'modified' : ''}`}
                    >
                      <div className="link-info">
                        <div className="link-id">
                          {link.id}
                          {linkRemoved && <span className="removed-badge">REMOVED</span>}
                          {linkMod && <span className="modified-badge">MODIFIED</span>}
                        </div>
                        <div className="link-details">
                          <input
                            type="number"
                            className="capacity-input"
                            value={displayCapacity}
                            onChange={(e) => handleModifyLink(link.id, e.target.value)}
                            disabled={linkRemoved}
                            min="0"
                            step="100"
                          />
                          <span className="capacity-unit">MW</span>
                          {linkMod && (
                            <span className="original-capacity">
                              (was {link.capacity_mw.toLocaleString()})
                            </span>
                          )}
                        </div>
                      </div>
                      <div className="link-actions">
                        {linkRemoved ? (
                          <button
                            className="restore-btn"
                            onClick={() => onRestoreLink(link.id)}
                            title="Restore link"
                          >
                            Restore
                          </button>
                        ) : (
                          <button
                            className="remove-link-btn"
                            onClick={() => onRemoveLink(link.id)}
                            title="Remove link"
                          >
                            ×
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </>
        )}

        {activeTab === 'add' && (
          <div className="add-link-form">
            <div className="form-row">
              <label className="form-label">From Zone</label>
              <select
                className="form-select"
                value={fromZone}
                onChange={(e) => setFromZone(e.target.value)}
              >
                {ALL_ZONES.map(zone => (
                  <option key={zone} value={zone}>{zone}</option>
                ))}
              </select>
            </div>

            <div className="form-row">
              <label className="form-label">To Zone</label>
              <select
                className="form-select"
                value={toZone}
                onChange={(e) => setToZone(e.target.value)}
              >
                {ALL_ZONES.map(zone => (
                  <option key={zone} value={zone}>{zone}</option>
                ))}
              </select>
            </div>

            <div className="form-row">
              <label className="form-label">Capacity (MW)</label>
              <input
                type="number"
                className="form-input"
                value={capacityMW}
                onChange={(e) => setCapacityMW(e.target.value)}
                placeholder="e.g. 3000"
                min="0"
                max="20000"
                step="100"
              />
            </div>

            <div className="form-row">
              <label className="form-label">Reactance (pu)</label>
              <input
                type="number"
                className="form-input"
                value={reactance}
                onChange={(e) => setReactance(e.target.value)}
                placeholder="e.g. 0.05"
                min="0.01"
                max="1"
                step="0.01"
              />
              <span className="form-hint">
                Typical: 0.02-0.10 pu for major interconnectors
              </span>
            </div>

            {error && (
              <div className="form-error">{error}</div>
            )}

            <button
              className="add-link-btn"
              onClick={handleAddLink}
              disabled={!capacityMW || !reactance}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
              Add Link
            </button>

            {/* Info */}
            <div className="link-editor-info">
              <p>
                <strong>Note:</strong> Added links participate in DC power flow.
                Lower reactance means more power flows through the link.
              </p>
              <p>
                Typical values: HVDC links ~0.02-0.05 pu, AC overhead lines ~0.05-0.15 pu
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
