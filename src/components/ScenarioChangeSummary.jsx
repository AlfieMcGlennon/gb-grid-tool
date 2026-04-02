import { useState, useEffect } from 'react'
import './ScenarioChangeSummary.css'

/**
 * ScenarioChangeSummary - Shows impact of parameter changes
 * Displays a brief toast showing what changed and the effect
 */
export default function ScenarioChangeSummary({ powerFlowResults, params }) {
  const [message, setMessage] = useState(null);
  const [prevResults, setPrevResults] = useState(null);
  const [prevParams, setPrevParams] = useState(null);

  useEffect(() => {
    if (!powerFlowResults || !prevResults || !params || !prevParams) {
      setPrevResults(powerFlowResults);
      setPrevParams(params);
      return;
    }

    // Detect what changed
    const changes = [];
    if (params.year !== prevParams.year) {
      changes.push(`Year ${prevParams.year}→${params.year}`);
    }
    if (params.scenario !== prevParams.scenario) {
      changes.push(`Scenario changed`);
    }
    if (params.season !== prevParams.season) {
      changes.push(`Season ${prevParams.season}→${params.season}`);
    }
    if (params.windPercentile !== prevParams.windPercentile) {
      changes.push(`Wind p${prevParams.windPercentile}→p${params.windPercentile}`);
    }
    if (params.solarPercentile !== prevParams.solarPercentile) {
      changes.push(`Solar p${prevParams.solarPercentile}→p${params.solarPercentile}`);
    }
    if (params.demandPercentile !== prevParams.demandPercentile) {
      changes.push(`Demand p${prevParams.demandPercentile}→p${params.demandPercentile}`);
    }
    if (params.dispatchMode !== prevParams.dispatchMode) {
      changes.push(`Dispatch ${prevParams.dispatchMode}→${params.dispatchMode}`);
    }
    // Check fuel toggles
    const fuelChanged = Object.keys(params.fuelToggles || {}).some(
      fuel => params.fuelToggles[fuel] !== prevParams.fuelToggles?.[fuel]
    );
    if (fuelChanged) {
      changes.push('Fuel types changed');
    }

    if (changes.length === 0) {
      setPrevResults(powerFlowResults);
      setPrevParams(params);
      return;
    }

    // Calculate impacts
    const genDelta = powerFlowResults.validationInfo.totalGeneration - prevResults.validationInfo.totalGeneration;
    const demandDelta = powerFlowResults.validationInfo.totalDemand - prevResults.validationInfo.totalDemand;

    // Find most changed boundary
    let maxBoundaryChange = { id: '', delta: 0 };
    for (const [id, data] of Object.entries(powerFlowResults.boundaryUtilisation)) {
      const prevData = prevResults.boundaryUtilisation[id];
      if (prevData) {
        const delta = Math.abs(data.utilisation_pct - prevData.utilisation_pct);
        if (delta > maxBoundaryChange.delta) {
          maxBoundaryChange = { id, delta, from: prevData.utilisation_pct, to: data.utilisation_pct };
        }
      }
    }

    // Build message
    const changeText = changes[0]; // Show first change
    const impacts = [];

    if (Math.abs(genDelta) > 100) {
      impacts.push(`Generation ${genDelta > 0 ? '+' : ''}${(genDelta / 1000).toFixed(1)} GW`);
    }
    if (Math.abs(demandDelta) > 100) {
      impacts.push(`Demand ${demandDelta > 0 ? '+' : ''}${(demandDelta / 1000).toFixed(1)} GW`);
    }
    if (maxBoundaryChange.delta > 5) {
      impacts.push(
        `${maxBoundaryChange.id} ${maxBoundaryChange.from.toFixed(0)}%→${maxBoundaryChange.to.toFixed(0)}%`
      );
    }

    if (impacts.length > 0) {
      setMessage(`${changeText}: ${impacts.join(' | ')}`);

      // Auto-dismiss after 5 seconds
      const timer = setTimeout(() => setMessage(null), 5000);

      setPrevResults(powerFlowResults);
      setPrevParams(params);

      return () => clearTimeout(timer);
    } else {
      setPrevResults(powerFlowResults);
      setPrevParams(params);
    }
  }, [powerFlowResults, params, prevResults, prevParams]);

  if (!message) return null;

  return (
    <div className="scenario-change-summary" role="status" aria-live="polite">
      <div className="change-message">{message}</div>
      <button
        className="dismiss-button"
        onClick={() => setMessage(null)}
        aria-label="Dismiss"
      >
        ×
      </button>
    </div>
  );
}
