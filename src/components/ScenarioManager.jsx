import { useState, useRef } from 'react'
import './ScenarioManager.css'

/**
 * ScenarioManager - Export and import scenario configurations
 *
 * Features:
 * - Export current scenario as JSON (download or clipboard)
 * - Import scenario from JSON file
 * - Exports full state to ensure exact reproduction on import
 * - URL sharing for small scenarios (<2KB)
 */

// Default values used when importing scenarios with missing fields
const DEFAULTS = {
  year: 2024,
  scenario: 'Holistic Transition',
  season: 'winter',
  dispatchMode: 'simple',
  windPercentile: 50,
  solarPercentile: 50,
  demandPercentile: 75,
  interconnectorImport: 65
};

export default function ScenarioManager({
  // Current scenario state
  year,
  season,
  dispatchMode,
  windPercentile,
  solarPercentile,
  demandPercentile,
  interconnectorImport,
  fuelToggles,
  plantEdits,
  addedNodes,
  linkEdits,
  // Callbacks to apply imported scenario
  onImport,
  onClose
}) {
  // Always use ETYS 2024 Holistic Transition
  const scenario = 'Holistic Transition';
  const [importText, setImportText] = useState('');
  const [importError, setImportError] = useState(null);
  const [exportStatus, setExportStatus] = useState(null);
  const fileInputRef = useRef(null);

  // Build scenario JSON for export - includes ALL state for exact reproduction
  const buildScenarioJSON = () => {
    const scenarioData = {
      version: '1.0',
      name: `Scenario ${new Date().toLocaleDateString()}`,
      created: new Date().toISOString(),
      // Always include all base parameters for exact reproduction
      base: {
        year,
        scenario,
        season,
        dispatchMode
      },
      // Always include all slider values
      sliders: {
        windPercentile,
        solarPercentile,
        demandPercentile,
        interconnectorImport
      }
    };

    // Fuel toggles - include full state (both enabled and disabled)
    if (fuelToggles && Object.keys(fuelToggles).length > 0) {
      scenarioData.fuelToggles = { ...fuelToggles };
    }

    // Plant edits
    if (plantEdits && Object.keys(plantEdits).length > 0) {
      scenarioData.plantEdits = plantEdits;
    }

    // Added nodes
    if (addedNodes && addedNodes.length > 0) {
      scenarioData.addedNodes = addedNodes;
    }

    // Link edits
    if (linkEdits && (
      linkEdits.added?.length > 0 ||
      linkEdits.removed?.length > 0 ||
      Object.keys(linkEdits.modified || {}).length > 0
    )) {
      scenarioData.linkEdits = linkEdits;
    }

    return scenarioData;
  };

  // Export to clipboard
  const handleCopyToClipboard = async () => {
    try {
      const scenarioData = buildScenarioJSON();
      const json = JSON.stringify(scenarioData, null, 2);
      await navigator.clipboard.writeText(json);
      setExportStatus({ type: 'success', message: 'Copied to clipboard!' });
      setTimeout(() => setExportStatus(null), 3000);
    } catch (err) {
      setExportStatus({ type: 'error', message: 'Failed to copy' });
    }
  };

  // Export as file download
  const handleDownload = () => {
    try {
      const scenarioData = buildScenarioJSON();
      const json = JSON.stringify(scenarioData, null, 2);
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `gb-grid-scenario-${year}-${scenario.replace(/\s+/g, '-').toLowerCase()}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      setExportStatus({ type: 'success', message: 'Downloaded!' });
      setTimeout(() => setExportStatus(null), 3000);
    } catch (err) {
      setExportStatus({ type: 'error', message: 'Download failed' });
    }
  };

  // Copy share URL (base64 encoded, if small enough)
  const handleCopyURL = async () => {
    try {
      const scenarioData = buildScenarioJSON();
      const json = JSON.stringify(scenarioData);

      if (json.length > 2000) {
        setExportStatus({ type: 'error', message: 'Scenario too large for URL. Use Copy JSON instead.' });
        return;
      }

      const base64 = btoa(json);
      const url = `${window.location.origin}${window.location.pathname}?scenario=${base64}`;

      await navigator.clipboard.writeText(url);
      setExportStatus({ type: 'success', message: `URL copied (${json.length} bytes)` });
      setTimeout(() => setExportStatus(null), 3000);
    } catch (err) {
      setExportStatus({ type: 'error', message: 'Failed to copy URL' });
    }
  };

  // Parse and validate imported JSON
  const parseImportedScenario = (jsonText) => {
    try {
      const data = JSON.parse(jsonText);

      // Validate structure
      if (!data.version) {
        throw new Error('Invalid scenario file: missing version');
      }

      // Build imported scenario with defaults
      const imported = {
        year: data.base?.year ?? DEFAULTS.year,
        scenario: data.base?.scenario ?? DEFAULTS.scenario,
        season: data.base?.season ?? DEFAULTS.season,
        dispatchMode: data.base?.dispatchMode ?? DEFAULTS.dispatchMode,
        windPercentile: data.sliders?.windPercentile ?? DEFAULTS.windPercentile,
        solarPercentile: data.sliders?.solarPercentile ?? DEFAULTS.solarPercentile,
        demandPercentile: data.sliders?.demandPercentile ?? DEFAULTS.demandPercentile,
        interconnectorImport: data.sliders?.interconnectorImport ?? DEFAULTS.interconnectorImport,
        fuelToggles: data.fuelToggles || {},
        plantEdits: data.plantEdits || {},
        addedNodes: data.addedNodes || [],
        linkEdits: data.linkEdits || { added: [], removed: [], modified: {} }
      };

      return imported;
    } catch (err) {
      throw new Error(`Parse error: ${err.message}`);
    }
  };

  // Handle text area import
  const handleImportFromText = () => {
    setImportError(null);
    try {
      const imported = parseImportedScenario(importText);
      onImport(imported);
      setImportText('');
      onClose();
    } catch (err) {
      setImportError(err.message);
    }
  };

  // Handle file upload
  const handleFileUpload = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setImportError(null);
    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const text = event.target?.result;
        const imported = parseImportedScenario(text);
        onImport(imported);
        onClose();
      } catch (err) {
        setImportError(err.message);
      }
    };
    reader.onerror = () => {
      setImportError('Failed to read file');
    };
    reader.readAsText(file);
  };

  // Calculate current scenario size
  const scenarioJSON = buildScenarioJSON();
  const scenarioSize = JSON.stringify(scenarioJSON).length;
  const canShareURL = scenarioSize <= 2000;

  return (
    <div className="scenario-manager">
      <div className="scenario-manager-header">
        <div>
          <h2>Scenario Manager</h2>
          <p className="scenario-manager-subtitle">Export or import scenario configurations</p>
        </div>
        <button className="close-button" onClick={onClose}>×</button>
      </div>

      <div className="scenario-manager-content">
        {/* Export Section */}
        <div className="manager-section">
          <h3 className="manager-section-title">Export Scenario</h3>
          <p className="manager-section-desc">
            Save your current settings to share or reload later.
            File size: <strong>{scenarioSize} bytes</strong>
          </p>

          <div className="export-buttons">
            <button className="export-btn primary" onClick={handleCopyToClipboard}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
              </svg>
              Copy JSON
            </button>
            <button className="export-btn" onClick={handleDownload}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
                <polyline points="7,10 12,15 17,10" />
                <line x1="12" y1="15" x2="12" y2="3" />
              </svg>
              Download
            </button>
            <button
              className={`export-btn ${!canShareURL ? 'disabled' : ''}`}
              onClick={handleCopyURL}
              disabled={!canShareURL}
              title={!canShareURL ? 'Scenario too large for URL (max 2KB)' : 'Copy shareable URL'}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71" />
                <path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71" />
              </svg>
              Copy URL
            </button>
          </div>

          {exportStatus && (
            <div className={`status-message ${exportStatus.type}`}>
              {exportStatus.message}
            </div>
          )}
        </div>

        {/* Import Section */}
        <div className="manager-section">
          <h3 className="manager-section-title">Import Scenario</h3>
          <p className="manager-section-desc">
            Load a previously saved scenario configuration.
          </p>

          <div className="import-options">
            <button
              className="import-file-btn"
              onClick={() => fileInputRef.current?.click()}
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
                <polyline points="14,2 14,8 20,8" />
                <line x1="12" y1="18" x2="12" y2="12" />
                <line x1="9" y1="15" x2="15" y2="15" />
              </svg>
              Upload JSON File
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".json,application/json"
              onChange={handleFileUpload}
              style={{ display: 'none' }}
            />
          </div>

          <div className="import-paste">
            <label className="paste-label">Or paste JSON here:</label>
            <textarea
              className="import-textarea"
              value={importText}
              onChange={(e) => setImportText(e.target.value)}
              placeholder='{"version": "1.0", "base": {"year": 2028}, ...}'
              rows={6}
            />
            <button
              className="import-btn"
              onClick={handleImportFromText}
              disabled={!importText.trim()}
            >
              Import
            </button>
          </div>

          {importError && (
            <div className="status-message error">
              {importError}
            </div>
          )}
        </div>

        {/* Current Scenario Preview */}
        <div className="manager-section">
          <h3 className="manager-section-title">Current Configuration</h3>
          <div className="config-preview">
            <pre>{JSON.stringify(scenarioJSON, null, 2)}</pre>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Check URL for scenario parameter on page load
 */
export function loadScenarioFromURL() {
  try {
    const params = new URLSearchParams(window.location.search);
    const scenarioB64 = params.get('scenario');

    if (!scenarioB64) return null;

    const json = atob(scenarioB64);
    const data = JSON.parse(json);

    if (!data.version) return null;

    return {
      year: data.base?.year ?? DEFAULTS.year,
      scenario: data.base?.scenario ?? DEFAULTS.scenario,
      season: data.base?.season ?? DEFAULTS.season,
      dispatchMode: data.base?.dispatchMode ?? DEFAULTS.dispatchMode,
      windPercentile: data.sliders?.windPercentile ?? DEFAULTS.windPercentile,
      solarPercentile: data.sliders?.solarPercentile ?? DEFAULTS.solarPercentile,
      demandPercentile: data.sliders?.demandPercentile ?? DEFAULTS.demandPercentile,
      interconnectorImport: data.sliders?.interconnectorImport ?? DEFAULTS.interconnectorImport,
      fuelToggles: data.fuelToggles || {},
      plantEdits: data.plantEdits || {},
      addedNodes: data.addedNodes || [],
      linkEdits: data.linkEdits || { added: [], removed: [], modified: {} }
    };
  } catch (err) {
    console.warn('Failed to load scenario from URL:', err);
    return null;
  }
}
