import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { loadAllData } from './data/dataLoader'
import { runScenario } from './engine/scenarioRunner'
import { useEscapeKey } from './hooks/useEscapeKey'
import GridMap from './components/GridMap'
import DetailPanel from './components/DetailPanel'
import ControlPanel from './components/ControlPanel'
import NationalSummary from './components/NationalSummary'
import ScenarioChangeSummary from './components/ScenarioChangeSummary'
import PlantEditor from './components/PlantEditor'
import ContingencyPanel from './components/ContingencyPanel'
import ScenarioManager from './components/ScenarioManager'
import NodeAdder from './components/NodeAdder'
import LinkEditor from './components/LinkEditor'
import DataSourcesPage from './components/DataSourcesPage'

function App() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [selectedZone, setSelectedZone] = useState(null);
  const [selectedBoundary, setSelectedBoundary] = useState(null);
  const [powerFlowResults, setPowerFlowResults] = useState(null);

  // Scenario parameters
  const [year, setYear] = useState(2024);
  const [season, setSeason] = useState('winter');
  // Always use "Holistic Transition" for ETYS boundary capabilities
  const scenario = 'Holistic Transition';

  // Phase 4: Weather and demand percentiles
  const [windPercentile, setWindPercentile] = useState(50);
  const [solarPercentile, setSolarPercentile] = useState(50);
  const [demandPercentile, setDemandPercentile] = useState(75);

  // Phase 4: Fuel toggles and dispatch mode
  const [fuelToggles, setFuelToggles] = useState({});
  const [dispatchMode, setDispatchMode] = useState('simple');
  const [availableFuelTypes, setAvailableFuelTypes] = useState([]);

  // Phase 4: Interconnector import percentage (0-100%) and dynamic mode
  const [interconnectorImport, setInterconnectorImport] = useState(65);
  const [dynamicIC, setDynamicIC] = useState(false);

  // Zone mode: 'tnuos' (27 zones) or 'flop' (82 zones)
  const [zoneMode, setZoneMode] = useState('tnuos');

  // Reinforcements toggle: when disabled, use 2024 baseline topology regardless of year
  const [reinforcementsEnabled, setReinforcementsEnabled] = useState(true);

  // Phase 5: Plant edits overlay (session-only, not persisted)
  // Structure: { [plantId]: { status, outputPct, commissioningYear, _plantType, _baseMW } }
  const [plantEdits, setPlantEdits] = useState({});

  // UI state: plant editor visibility
  const [plantEditorZone, setPlantEditorZone] = useState(null);

  // UI state: contingency panel visibility
  const [contingencyPanelOpen, setContingencyPanelOpen] = useState(false);

  // UI state: selected contingency (for map highlighting)
  const [selectedContingency, setSelectedContingency] = useState(null);

  // UI state: scenario manager visibility
  const [scenarioManagerOpen, setScenarioManagerOpen] = useState(false);

  // Phase 6: Hypothetical generation nodes added by user
  const [addedNodes, setAddedNodes] = useState([]);

  // UI state: node adder modal (null = closed, zoneId = open for that zone)
  const [nodeAdderZone, setNodeAdderZone] = useState(null);

  // Phase 6: Link edits (added, removed, modified)
  const [linkEdits, setLinkEdits] = useState({ added: [], removed: [], modified: {} });

  // Reset trigger - increment to force power flow recalculation after reset
  const [resetCounter, setResetCounter] = useState(0);

  // UI state: link editor visibility
  const [linkEditorOpen, setLinkEditorOpen] = useState(false);

  // UI state: data sources page visibility
  const [dataSourcesOpen, setDataSourcesOpen] = useState(false);

  // UI state: right panel collapse
  const [rightPanelCollapsed, setRightPanelCollapsed] = useState(false);

  // UI state: left panel open/closed
  const [leftPanelOpen, setLeftPanelOpen] = useState(false);

  // HiGHS solver instance (loaded once, used for LOPF dispatch)
  const highsRef = useRef(null);
  const [highsReady, setHighsReady] = useState(false);

  // UI state: calculating indicator
  const [calculating, setCalculating] = useState(false);

  // UI state: color blind mode
  const [colorBlindMode, setColorBlindMode] = useState(() => {
    const saved = localStorage.getItem('colorBlindMode');
    return saved === 'true';
  });

  // Save color blind mode preference
  useEffect(() => {
    localStorage.setItem('colorBlindMode', colorBlindMode);
  }, [colorBlindMode]);

  // Load HiGHS WASM solver on mount (for LOPF dispatch mode)
  // Loaded via script tag to bypass Vite's ESM transformation which breaks the Emscripten module
  useEffect(() => {
    const script = document.createElement('script');
    script.src = import.meta.env.BASE_URL + 'highs.js';
    script.async = true;
    script.onload = async () => {
      try {
        // The Emscripten module attaches itself as window.Module or returns from the IIFE
        const initFn = window.Module;
        if (typeof initFn === 'function') {
          const instance = await initFn({
            locateFile: (file) => file.endsWith('.wasm')
              ? import.meta.env.BASE_URL + 'highs.wasm'
              : import.meta.env.BASE_URL + file
          });
          if (instance && typeof instance.solve === 'function') {
            highsRef.current = instance;
            setHighsReady(true);
            console.log('HiGHS solver loaded successfully');
          } else {
            console.warn('HiGHS init returned object without solve()');
          }
        } else {
          console.warn('HiGHS script loaded but Module not a function:', typeof initFn);
        }
      } catch (err) {
        console.warn('HiGHS init failed:', err.message);
      }
    };
    script.onerror = () => {
      console.warn('Failed to load HiGHS script');
    };
    document.head.appendChild(script);

    return () => {
      // Cleanup on unmount
      if (script.parentNode) script.parentNode.removeChild(script);
    };
  }, []);

  // Handle Escape key to close modals (innermost first)
  const escapeModals = useMemo(() => [
    { isOpen: !!plantEditorZone, onClose: () => setPlantEditorZone(null) },
    { isOpen: !!nodeAdderZone, onClose: () => setNodeAdderZone(null) },
    { isOpen: linkEditorOpen, onClose: () => setLinkEditorOpen(false) },
    { isOpen: contingencyPanelOpen, onClose: () => { setContingencyPanelOpen(false); setSelectedContingency(null); } },
    { isOpen: scenarioManagerOpen, onClose: () => setScenarioManagerOpen(false) },
    { isOpen: dataSourcesOpen, onClose: () => setDataSourcesOpen(false) }
  ], [plantEditorZone, nodeAdderZone, linkEditorOpen, contingencyPanelOpen, scenarioManagerOpen, dataSourcesOpen]);
  useEscapeKey(escapeModals);

  // Run power flow scenario (memoized to avoid unnecessary recalculations)
  const runPowerFlow = useCallback((loadedData, params) => {
    const results = runScenario({
      data: loadedData,
      year: params.year,
      scenario: params.scenario,
      season: params.season,
      windPercentile: params.windPercentile,
      solarPercentile: params.solarPercentile,
      demandPercentile: params.demandPercentile,
      fuelToggles: params.fuelToggles,
      dispatchMode: params.dispatchMode,
      interconnectorImport: params.interconnectorImport,
      dynamicIC: params.dynamicIC,
      reinforcementsEnabled: params.reinforcementsEnabled,
      plantEdits: params.plantEdits,
      addedNodes: params.addedNodes,
      linkEdits: params.linkEdits,
      zoneMode: params.zoneMode,
      highs: params.dispatchMode === 'lopf' ? highsRef.current : null
    });

    setPowerFlowResults(results);

    // Console validation
    console.group(`🔌 Power Flow - Year ${params.year}, ${params.scenario}, ${params.season}, ${params.dispatchMode}`);
    console.log('Total Generation:', results.validationInfo.totalGeneration.toFixed(1), 'MW');
    console.log('Total Demand:', results.validationInfo.totalDemand.toFixed(1), 'MW');
    console.log('Slack Bus Absorption:', results.validationInfo.slackAbsorption.toFixed(1), 'MW');
    console.log('Weather: Wind p' + params.windPercentile + ', Solar p' + params.solarPercentile + ', Demand p' + params.demandPercentile);

    // Test: Verify B6F capability changes with year/scenario
    const b6fData = results.boundaryUtilisation['B6F'];
    if (b6fData) {
      console.log(`\n✓ B6F Capability Test: ${b6fData.capability_mw.toFixed(0)} MW at ${params.year} ${params.scenario}`);
      console.log(`  Expected: 7200 MW at 2024 Holistic Transition, 10200 MW at 2030 Holistic Transition`);
    }

    // Show dispatch details if merit order is active
    if (params.dispatchMode === 'merit-order' && results.dispatchDetails) {
      console.log('\nMerit Order Dispatch:');
      console.log('  National Generation:', results.dispatchDetails.national.generation.toFixed(1), 'MW');
      console.log('  National Demand:', results.dispatchDetails.national.demand.toFixed(1), 'MW');
      console.log('  Must-Run (Wind/Solar/Nuclear):', results.dispatchDetails.national.mustRun.toFixed(1), 'MW');
      console.log('  Dispatched (Flexible):', results.dispatchDetails.national.dispatched.toFixed(1), 'MW');
      console.log('  Imbalance:', results.dispatchDetails.national.imbalance.toFixed(1), 'MW');
    }

    console.log('\nTop 5 Boundary Utilisations:');
    console.table(results.validationInfo.topBoundaryUtilisations.map(b => ({
      Boundary: b.id,
      'Flow (MW)': b.flow_mw.toFixed(1),
      'Capability (MW)': b.capability_mw.toFixed(1),
      'Utilisation (%)': b.utilisation_pct.toFixed(1)
    })));

    if (results.validationInfo.boundariesOver80pct.length > 0) {
      console.warn(`⚠️ ${results.validationInfo.boundariesOver80pct.length} boundaries exceeding 80% utilisation`);
    } else {
      console.log('✅ No boundaries exceeding 80% utilisation');
    }

    // DEBUG: Link reactance and flow analysis
    console.group('\n⚡ Link Reactance & Flow Analysis');

    // Get current year links
    const yearKey = String(params.year);
    const currentLinks = loadedData.linksTNUoSByYear?.[yearKey] || loadedData.linksTNUoSByYear?.['2024'] || [];

    // Combine link data with flows
    const linkAnalysis = currentLinks.map(link => {
      const linkId = `${link.from}-${link.to}`;
      const flow = results.flows?.[linkId] || 0;
      return {
        linkId,
        from: link.from,
        to: link.to,
        x_equivalent: link.x_equivalent || 0,
        capacity_mw: link.capacity_mw || 0,
        flow_mw: flow,
        flow_magnitude: Math.abs(flow)
      };
    });

    // Sort by flow magnitude
    linkAnalysis.sort((a, b) => b.flow_magnitude - a.flow_magnitude);

    // Show top 10
    console.log('Top 10 Links by Flow Magnitude:');
    console.table(linkAnalysis.slice(0, 10).map(l => ({
      'Link': l.linkId,
      'Reactance (pu)': l.x_equivalent.toFixed(4),
      'Capacity (MW)': l.capacity_mw.toFixed(0),
      'Flow (MW)': l.flow_mw.toFixed(1),
      'Flow Mag (MW)': l.flow_magnitude.toFixed(1)
    })));

    // Show specific boundary links
    console.log('\n🎯 Key Boundary Links:');

    const keyLinks = [
      { id: 'GZ11-GZ12', name: 'B6 boundary', expectedX: 0.08 },
      { id: 'GZ12-GZ11', name: 'B6 boundary (reverse)', expectedX: 0.08 },
      { id: 'GZ16-GZ18', name: 'NW3/B8 boundary', expectedX: null },
      { id: 'GZ18-GZ16', name: 'NW3/B8 boundary (reverse)', expectedX: null },
      { id: 'GZ1-GZ3', name: 'B1a boundary', expectedX: null },
      { id: 'GZ3-GZ1', name: 'B1a boundary (reverse)', expectedX: null },
      { id: 'GZ1-GZ5', name: 'B1a boundary', expectedX: null },
      { id: 'GZ5-GZ1', name: 'B1a boundary (reverse)', expectedX: null }
    ];

    keyLinks.forEach(key => {
      const link = linkAnalysis.find(l => l.linkId === key.id);
      if (link) {
        let message = `${key.id} (${key.name}): x=${link.x_equivalent.toFixed(4)}, capacity=${link.capacity_mw.toFixed(0)} MW, flow=${link.flow_mw.toFixed(1)} MW`;
        if (key.expectedX) {
          const diff = Math.abs(link.x_equivalent - key.expectedX);
          if (diff > 0.02) {
            message += ` ⚠️ Expected ~${key.expectedX}, got ${link.x_equivalent.toFixed(4)}`;
          } else {
            message += ` ✓ Close to expected ${key.expectedX}`;
          }
        }
        console.log(message);
      } else {
        console.log(`${key.id} (${key.name}): NOT FOUND IN NETWORK`);
      }
    });

    // Compare B6 vs NW3 reactances
    const b6Link = linkAnalysis.find(l => l.linkId === 'GZ11-GZ12' || l.linkId === 'GZ12-GZ11');
    const nw3Link = linkAnalysis.find(l => l.linkId === 'GZ16-GZ18' || l.linkId === 'GZ18-GZ16');

    if (b6Link && nw3Link) {
      const ratio = b6Link.x_equivalent / nw3Link.x_equivalent;
      console.log(`\n📊 B6 vs NW3 Reactance Comparison:`);
      console.log(`  B6 (GZ11-GZ12): ${b6Link.x_equivalent.toFixed(4)} pu`);
      console.log(`  NW3 (GZ16-GZ18): ${nw3Link.x_equivalent.toFixed(4)} pu`);
      console.log(`  Ratio (B6/NW3): ${ratio.toFixed(2)}x`);
      if (ratio > 1.5) {
        console.warn(`  ⚠️ B6 reactance is ${ratio.toFixed(1)}x higher than NW3!`);
        console.warn(`  This causes power to route through NW3 instead of B6.`);
        console.warn(`  Check reactance calculation in data pipeline.`);
      } else if (ratio < 0.67) {
        console.log(`  ✓ B6 has lower reactance, power prefers B6 route`);
      } else {
        console.log(`  ✓ Reactances are similar, flows determined by injection pattern`);
      }
    }

    console.groupEnd();
    console.groupEnd();
  }, []);

  // Handle plant edits
  const handlePlantEdit = useCallback((plantId, editData) => {
    setPlantEdits(prev => {
      if (editData === null) {
        // Remove edit
        const { [plantId]: removed, ...rest } = prev;
        return rest;
      }
      return { ...prev, [plantId]: editData };
    });
  }, []);

  // Handle adding hypothetical nodes
  const handleAddNode = useCallback((node) => {
    setAddedNodes(prev => [...prev, node]);
  }, []);

  // Handle removing hypothetical nodes
  const handleRemoveNode = useCallback((nodeId) => {
    setAddedNodes(prev => prev.filter(n => n.id !== nodeId));
  }, []);

  // Handle adding a new link
  const handleAddLink = useCallback((link) => {
    setLinkEdits(prev => ({
      ...prev,
      added: [...prev.added, link]
    }));
  }, []);

  // Handle modifying an existing link
  const handleModifyLink = useCallback((linkId, modifications) => {
    setLinkEdits(prev => ({
      ...prev,
      modified: { ...prev.modified, [linkId]: modifications }
    }));
  }, []);

  // Handle removing a link
  const handleRemoveLink = useCallback((linkId, isUserAdded = false) => {
    if (isUserAdded) {
      // Remove from added list
      setLinkEdits(prev => ({
        ...prev,
        added: prev.added.filter(l => l.id !== linkId)
      }));
    } else {
      // Add to removed list
      setLinkEdits(prev => ({
        ...prev,
        removed: [...prev.removed, linkId]
      }));
    }
  }, []);

  // Handle restoring a removed link
  const handleRestoreLink = useCallback((linkId) => {
    setLinkEdits(prev => ({
      ...prev,
      removed: prev.removed.filter(id => id !== linkId),
      modified: (() => {
        const { [linkId]: _, ...rest } = prev.modified;
        return rest;
      })()
    }));
  }, []);

  // Load data on mount
  useEffect(() => {
    loadAllData()
      .then(loadedData => {
        setData(loadedData);

        // Extract available fuel types from zones data
        const fuelTypeSet = new Set();
        for (const zone of Object.values(loadedData.zonesTNUoS)) {
          if (zone.generation_by_type) {
            for (const fuelType of Object.keys(zone.generation_by_type)) {
              fuelTypeSet.add(fuelType);
            }
          }
        }
        const fuelTypes = Array.from(fuelTypeSet).sort();
        setAvailableFuelTypes(fuelTypes);

        // Initialize fuel toggles (all enabled by default)
        const initialToggles = {};
        for (const fuelType of fuelTypes) {
          initialToggles[fuelType] = true;
        }
        setFuelToggles(initialToggles);

        runPowerFlow(loadedData, {
          year,
          scenario,
          season,
          windPercentile,
          solarPercentile,
          demandPercentile,
          fuelToggles: initialToggles,
          dispatchMode,
          interconnectorImport,
          plantEdits: {},
          addedNodes: [],
          linkEdits: { added: [], removed: [], modified: {} },
          zoneMode
        });
        setLoading(false);
      })
      .catch(err => {
        setError(err.message);
        setLoading(false);
      });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Re-run power flow when any scenario parameter changes
  useEffect(() => {
    if (data && Object.keys(fuelToggles).length > 0) {
      setCalculating(true);
      setTimeout(() => {
        try {
          runPowerFlow(data, {
            year,
            scenario,  // Always "Holistic Transition"
            season,
            windPercentile,
            solarPercentile,
            demandPercentile,
            fuelToggles,
            dispatchMode,
            interconnectorImport,
            dynamicIC,
            reinforcementsEnabled,
            plantEdits,
            addedNodes,
            linkEdits,
            zoneMode
          });
        } finally {
          setCalculating(false);
        }
      }, 0);
    }
  }, [year, season, windPercentile, solarPercentile, demandPercentile, fuelToggles, dispatchMode, interconnectorImport, dynamicIC, reinforcementsEnabled, plantEdits, addedNodes, linkEdits, zoneMode, data, runPowerFlow, resetCounter, scenario]);

  if (loading) {
    return (
      <div className="loading-container">
        <p>Loading GB Grid data...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="error-container">
        <div>
          <p>Error loading data:</p>
          <p>{error}</p>
        </div>
      </div>
    );
  }

  // Left panel visibility - open if manually opened OR zone/boundary selected
  const leftPanelVisible = leftPanelOpen || selectedZone || selectedBoundary;

  return (
    <div className="app-container">
      {/* Plant Editor Modal */}
      {plantEditorZone && (
        <div className="plant-editor-modal" role="dialog" aria-modal="true" aria-label="Plant Editor">
          <div className="plant-editor-backdrop" onClick={() => setPlantEditorZone(null)} />
          <div className="plant-editor-container">
            <PlantEditor
              zoneId={plantEditorZone}
              plantsData={data.plantsTNUoS}
              plantEdits={plantEdits}
              onPlantEdit={handlePlantEdit}
              onClose={() => setPlantEditorZone(null)}
            />
          </div>
        </div>
      )}

      {/* N-1 Contingency Panel Modal */}
      {contingencyPanelOpen && (
        <div className="contingency-modal" role="dialog" aria-modal="true" aria-label="N-1 Contingency Analysis">
          <div className="contingency-backdrop" onClick={() => setContingencyPanelOpen(false)} />
          <div className="contingency-container">
            <ContingencyPanel
              data={data}
              powerFlowResults={powerFlowResults}
              year={year}
              scenario={scenario}
              onSelectContingency={setSelectedContingency}
              onClose={() => {
                setContingencyPanelOpen(false);
                setSelectedContingency(null);
              }}
            />
          </div>
        </div>
      )}

      {/* Scenario Manager Modal */}
      {scenarioManagerOpen && (
        <div className="scenario-manager-modal" role="dialog" aria-modal="true" aria-label="Scenario Manager">
          <div className="scenario-manager-backdrop" onClick={() => setScenarioManagerOpen(false)} />
          <div className="scenario-manager-container">
            <ScenarioManager
              year={year}
              season={season}
              dispatchMode={dispatchMode}
              windPercentile={windPercentile}
              solarPercentile={solarPercentile}
              demandPercentile={demandPercentile}
              interconnectorImport={interconnectorImport}
              fuelToggles={fuelToggles}
              plantEdits={plantEdits}
              addedNodes={addedNodes}
              linkEdits={linkEdits}
              onImport={(imported) => {
                // Apply imported scenario
                setYear(imported.year);
                setSeason(imported.season);
                setDispatchMode(imported.dispatchMode);
                setWindPercentile(imported.windPercentile);
                setSolarPercentile(imported.solarPercentile);
                setDemandPercentile(imported.demandPercentile);
                setInterconnectorImport(imported.interconnectorImport);
                // Merge fuel toggles (imported overrides)
                setFuelToggles(prev => ({
                  ...Object.fromEntries(Object.keys(prev).map(k => [k, true])),
                  ...imported.fuelToggles
                }));
                setPlantEdits(imported.plantEdits);
                // Apply addedNodes if present
                if (imported.addedNodes) {
                  setAddedNodes(imported.addedNodes);
                }
                // Apply linkEdits if present
                if (imported.linkEdits) {
                  setLinkEdits(imported.linkEdits);
                }
              }}
              onClose={() => setScenarioManagerOpen(false)}
            />
          </div>
        </div>
      )}

      {/* Node Adder Modal */}
      {nodeAdderZone && (
        <div className="plant-editor-modal" role="dialog" aria-modal="true" aria-label="Add Generation Node">
          <div className="plant-editor-backdrop" onClick={() => setNodeAdderZone(null)} />
          <div className="plant-editor-container">
            <NodeAdder
              zoneId={nodeAdderZone}
              addedNodes={addedNodes}
              onAddNode={handleAddNode}
              onRemoveNode={handleRemoveNode}
              onClose={() => setNodeAdderZone(null)}
            />
          </div>
        </div>
      )}

      {/* Link Editor Modal */}
      {linkEditorOpen && (
        <div className="plant-editor-modal" role="dialog" aria-modal="true" aria-label="Link Editor">
          <div className="plant-editor-backdrop" onClick={() => setLinkEditorOpen(false)} />
          <div className="plant-editor-container">
            <LinkEditor
              existingLinks={data.linksTNUoSByYear?.[String(year)] || data.linksTNUoSByYear?.['2024'] || []}
              linkEdits={linkEdits}
              onAddLink={handleAddLink}
              onModifyLink={handleModifyLink}
              onRemoveLink={handleRemoveLink}
              onRestoreLink={handleRestoreLink}
              onClose={() => setLinkEditorOpen(false)}
            />
          </div>
        </div>
      )}

      {/* Data Sources Page Modal */}
      {dataSourcesOpen && (
        <div className="data-sources-modal" role="dialog" aria-modal="true" aria-label="Data Sources and Methodology">
          <div className="data-sources-backdrop" onClick={() => setDataSourcesOpen(false)} />
          <div className="data-sources-container">
            <DataSourcesPage onClose={() => setDataSourcesOpen(false)} />
          </div>
        </div>
      )}

      <ScenarioChangeSummary
        powerFlowResults={powerFlowResults}
        params={{
          year,
          scenario,
          season,
          windPercentile,
          solarPercentile,
          demandPercentile,
          fuelToggles,
          dispatchMode
        }}
      />

      {/* Top bar - full width */}
      <div className="top-bar">
        <div className="top-bar-left">
          <div className="top-bar-logo">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="3" />
              <path d="M12 2v4m0 12v4M2 12h4m12 0h4" />
              <path d="M4.93 4.93l2.83 2.83m8.48 8.48l2.83 2.83M4.93 19.07l2.83-2.83m8.48-8.48l2.83-2.83" />
            </svg>
          </div>
          <div className="top-bar-title">
            <h1>GB Grid Scenario Tool</h1>
            <p>{zoneMode === 'flop' ? '82 FLOP Zones' : '27 TNUoS Zones'} • Year {year}</p>
          </div>
        </div>
        <nav className="top-bar-nav">
          <button
            className={`nav-link ${!dataSourcesOpen ? 'active' : ''}`}
            onClick={() => setDataSourcesOpen(false)}
          >
            Map
          </button>
          <button
            className={`nav-link ${dataSourcesOpen ? 'active' : ''}`}
            onClick={() => setDataSourcesOpen(true)}
          >
            Data & Sources
          </button>
        </nav>
        <div className="top-bar-summary">
          <NationalSummary
            powerFlowResults={powerFlowResults}
            fuelToggles={fuelToggles}
            year={year}
            season={season}
            windPercentile={windPercentile}
            demandPercentile={demandPercentile}
          />
        </div>
      </div>

      {/* Main content - 3 columns */}
      <div className="main-content">
        {/* Left panel - thin tab when closed, expands when opened */}
        <div className={`left-panel ${leftPanelVisible ? 'visible' : ''}`}>
          {!leftPanelVisible && (
            <>
              <button
                className="left-panel-toggle"
                onClick={() => setLeftPanelOpen(true)}
                aria-label="Open detail panel"
              >
                <span className="arrow">▶</span>
                Details
              </button>
              <span className="left-panel-hint">Click zone or boundary</span>
            </>
          )}
          {leftPanelVisible && (
            <DetailPanel
              selectedZone={selectedZone}
              selectedBoundary={selectedBoundary}
              zoneData={data.zonesTNUoS}
              boundaryData={data.boundaryLinkMapping}
              powerFlowResults={powerFlowResults}
              plantsData={data.plantsTNUoS}
              plantEdits={plantEdits}
              addedNodes={addedNodes}
              onOpenPlantEditor={(zoneId) => setPlantEditorZone(zoneId)}
              onOpenNodeAdder={(zoneId) => setNodeAdderZone(zoneId)}
              onBoundaryClick={(boundaryId) => {
                setSelectedBoundary(boundaryId);
                setSelectedZone(null);
              }}
              onClose={() => {
                setSelectedZone(null);
                setSelectedBoundary(null);
                setLeftPanelOpen(false);
              }}
            />
          )}
        </div>

        {/* Map - center */}
        <div className="map-container">
          <GridMap
            data={data}
            powerFlowResults={powerFlowResults}
            selectedZone={selectedZone}
            selectedBoundary={selectedBoundary}
            year={year}
            zoneMode={zoneMode}
            colorBlindMode={colorBlindMode}
            onZoneClick={(zoneId) => {
              setSelectedZone(zoneId);
              setSelectedBoundary(null);
              setLeftPanelOpen(true);
            }}
            onBoundaryClick={(boundaryId) => {
              setSelectedBoundary(boundaryId);
              setSelectedZone(null);
              setLeftPanelOpen(true);
            }}
          />
        </div>

        {/* Right panel - collapsible */}
        <div className={`right-panel ${rightPanelCollapsed ? 'collapsed' : ''}`}>
          <button
            className="right-panel-toggle"
            onClick={() => setRightPanelCollapsed(!rightPanelCollapsed)}
            aria-label={rightPanelCollapsed ? 'Expand panel' : 'Collapse panel'}
          >
            {rightPanelCollapsed ? '◀' : '▶'}
          </button>
          <ControlPanel
          calculating={calculating}
          year={year}
          season={season}
          zoneMode={zoneMode}
          onZoneModeChange={setZoneMode}
          windPercentile={windPercentile}
          solarPercentile={solarPercentile}
          demandPercentile={demandPercentile}
          fuelToggles={fuelToggles}
          dispatchMode={dispatchMode}
          interconnectorImport={interconnectorImport}
          availableFuelTypes={availableFuelTypes}
          powerFlowResults={powerFlowResults}
          colorBlindMode={colorBlindMode}
          onYearChange={setYear}
          onSeasonChange={setSeason}
          onWindPercentileChange={setWindPercentile}
          onSolarPercentileChange={setSolarPercentile}
          onDemandPercentileChange={setDemandPercentile}
          onFuelToggleChange={(fuelType, enabled) => {
            setFuelToggles(prev => ({ ...prev, [fuelType]: enabled }));
          }}
          onDispatchModeChange={setDispatchMode}
          onInterconnectorImportChange={setInterconnectorImport}
          dynamicIC={dynamicIC}
          onDynamicICChange={setDynamicIC}
          reinforcementsEnabled={reinforcementsEnabled}
          onReinforcementsChange={setReinforcementsEnabled}
          resolvedICImport={powerFlowResults?.resolvedICImport}
          onColorBlindModeChange={setColorBlindMode}
          onOpenContingency={() => setContingencyPanelOpen(true)}
          onOpenScenarioManager={() => setScenarioManagerOpen(true)}
          onOpenLinkEditor={() => setLinkEditorOpen(true)}
          onBoundaryClick={(boundaryId) => {
            setSelectedBoundary(boundaryId);
            setSelectedZone(null);
            setLeftPanelOpen(true);
          }}
          // Changes tracking
          plantEdits={plantEdits}
          addedNodes={addedNodes}
          linkEdits={linkEdits}
          plants={data?.plantsTNUoS}
          onReset={() => {
            // Reset all scenario parameters to defaults
            setYear(2024);
            setSeason('winter');
            setWindPercentile(50);
            setSolarPercentile(50);
            setDemandPercentile(75);
            setInterconnectorImport(65);
            setDynamicIC(false);
            setReinforcementsEnabled(true);
            setDispatchMode('simple');
            setZoneMode('tnuos');
            // Reset fuel toggles to all enabled (set each key to true)
            setFuelToggles(prev => Object.fromEntries(Object.keys(prev).map(k => [k, true])));
            // Clear all edits
            setPlantEdits({});
            setAddedNodes([]);
            setLinkEdits({ added: [], removed: [], modified: {} });
            // Force recalculation AFTER React has flushed all state updates
            setTimeout(() => {
              setResetCounter(c => c + 1);
            }, 100);
          }}
          onRemovePlantEdit={(plantId) => {
            setPlantEdits(prev => {
              const next = { ...prev };
              delete next[plantId];
              return next;
            });
          }}
          onRemoveAddedNode={(nodeId) => {
            setAddedNodes(prev => prev.filter((node, idx) => (node.id || idx) !== nodeId));
          }}
          onRemoveLinkEdit={(type, linkId) => {
            setLinkEdits(prev => {
              const next = { ...prev };
              if (type === 'added') {
                next.added = prev.added.filter((link, idx) => (link.id || idx) !== linkId);
              } else if (type === 'removed') {
                next.removed = prev.removed.filter(id => id !== linkId);
              } else if (type === 'modified') {
                const modified = { ...prev.modified };
                delete modified[linkId];
                next.modified = modified;
              }
              return next;
            });
          }}
        />
        </div>
      </div>
    </div>
  );
}

export default App;
