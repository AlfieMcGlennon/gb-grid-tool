import './NationalSummary.css'

/**
 * NationalSummary - Shows national generation/demand/balance at a glance
 * Also displays warnings for invalid or extreme scenarios
 * Includes a dynamic narrative summarising the scenario
 */
export default function NationalSummary({
  powerFlowResults,
  fuelToggles,
  year,
  season,
  windPercentile,
  demandPercentile
}) {
  if (!powerFlowResults || !powerFlowResults.validationInfo) {
    return null;
  }

  const { totalGeneration, totalDemand, boundariesOver80pct, nationalWindCF } = powerFlowResults.validationInfo;
  const windCurtailment = powerFlowResults.dispatchDetails?.windCurtailment;
  const balance = totalGeneration - totalDemand;
  const isDeficit = balance < 0;

  // Format numbers with thousands separator
  const formatMW = (mw) => Math.round(mw).toLocaleString('en-GB');

  // Generate dynamic narrative sentence
  const generateNarrative = () => {
    // Describe wind conditions
    let windDesc;
    if (windPercentile <= 15) windDesc = 'calm';
    else if (windPercentile <= 35) windDesc = 'light';
    else if (windPercentile <= 65) windDesc = 'typical';
    else if (windPercentile <= 85) windDesc = 'strong';
    else windDesc = 'gale-force';

    // Describe demand
    let demandDesc;
    if (demandPercentile <= 15) demandDesc = 'low';
    else if (demandPercentile <= 35) demandDesc = 'below-average';
    else if (demandPercentile <= 65) demandDesc = 'typical';
    else if (demandPercentile <= 85) demandDesc = 'elevated';
    else demandDesc = 'peak';

    // Describe season
    const seasonName = season ? season.charAt(0).toUpperCase() + season.slice(1) : 'Winter';

    // Describe balance situation
    let balanceDesc;
    const balancePct = Math.abs(balance) / totalDemand * 100;
    if (isDeficit) {
      if (balancePct > 20) balanceDesc = 'significant generation shortfall requiring imports or load shedding';
      else if (balancePct > 5) balanceDesc = 'modest generation shortfall';
      else balanceDesc = 'near-balanced supply';
    } else {
      if (balancePct > 20) balanceDesc = 'substantial generation surplus available for export';
      else if (balancePct > 5) balanceDesc = 'comfortable generation headroom';
      else balanceDesc = 'near-balanced supply';
    }

    // Describe network stress
    const criticalCount = (boundariesOver80pct || []).filter(b => b.utilisation_pct > 100).length;
    const stressedCount = (boundariesOver80pct || []).filter(b => b.utilisation_pct > 80 && b.utilisation_pct <= 100).length;
    let networkDesc = '';
    if (criticalCount > 0) {
      networkDesc = ` with ${criticalCount} constrained ${criticalCount > 1 ? 'boundaries' : 'boundary'}`;
    } else if (stressedCount > 0) {
      networkDesc = ` with ${stressedCount} stressed ${stressedCount > 1 ? 'boundaries' : 'boundary'}`;
    }

    // Describe curtailment if active
    let curtailmentDesc = '';
    if (windCurtailment?.isCurtailed) {
      if (windCurtailment.windCurtailedMW > 0 && windCurtailment.solarCurtailedMW > 0) {
        curtailmentDesc = ` Wind and solar curtailed to balance.`;
      } else if (windCurtailment.windCurtailedMW > 0) {
        curtailmentDesc = ` Wind curtailed ${windCurtailment.curtailmentPct.toFixed(0)}% to balance.`;
      }
    }

    return `${seasonName} ${year} with ${windDesc} winds and ${demandDesc} demand shows ${balanceDesc}${networkDesc}.${curtailmentDesc}`;
  };

  // Check for warning conditions
  const warnings = [];

  // Curtailment info (not a warning, just informational)
  if (windCurtailment?.isCurtailed) {
    let curtailmentMsg = '';
    if (windCurtailment.windCurtailedMW > 0 && windCurtailment.solarCurtailedMW > 0) {
      curtailmentMsg = `Wind curtailed ${formatMW(windCurtailment.windCurtailedMW)} MW, solar curtailed ${formatMW(windCurtailment.solarCurtailedMW)} MW to balance supply.`;
    } else if (windCurtailment.windCurtailedMW > 0) {
      curtailmentMsg = `Wind curtailed by ${formatMW(windCurtailment.windCurtailedMW)} MW (${windCurtailment.curtailmentPct.toFixed(0)}%) to balance supply.`;
    } else if (windCurtailment.solarCurtailedMW > 0) {
      curtailmentMsg = `Solar curtailed by ${formatMW(windCurtailment.solarCurtailedMW)} MW to balance supply.`;
    }
    if (curtailmentMsg) {
      warnings.push({
        type: 'info',
        message: curtailmentMsg
      });
    }
  }

  // No generation warning
  if (totalGeneration < 100) {
    warnings.push({
      type: 'error',
      message: 'No generation dispatching. Enable fuel types in controls.'
    });
  }

  // Large deficit warning (> 30% of demand)
  if (isDeficit && Math.abs(balance) > totalDemand * 0.3) {
    warnings.push({
      type: 'warning',
      message: `Large deficit (${formatMW(Math.abs(balance))} MW). In reality, load shedding would occur.`
    });
  }

  // Boundaries over 100%
  const criticalBoundaries = (boundariesOver80pct || []).filter(b => b.utilisation_pct > 100);
  if (criticalBoundaries.length > 0) {
    const plural = criticalBoundaries.length > 1;
    warnings.push({
      type: 'warning',
      message: `${criticalBoundaries.length} ${plural ? 'boundaries exceed' : 'boundary exceeds'} 100% capability. Network constraints would curtail flows.`
    });
  }

  const narrative = generateNarrative();

  return (
    <div className="national-summary-container">
      {warnings.length > 0 && (
        <div className="scenario-warnings">
          {warnings.map((w, i) => (
            <div key={i} className={`warning-badge ${w.type}`}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                {w.type === 'error' ? (
                  <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0zM12 9v4m0 4h.01" />
                ) : w.type === 'info' ? (
                  <>
                    <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2z" />
                    <path d="M12 16v-4m0-4h.01" />
                  </>
                ) : (
                  <>
                    <circle cx="12" cy="12" r="10" />
                    <path d="M12 8v4m0 4h.01" />
                  </>
                )}
              </svg>
              <span>{w.message}</span>
            </div>
          ))}
        </div>
      )}
      <div className="national-summary">
        <div className="summary-item">
          <span className="summary-label">Generation:</span>
          <span className="summary-value">{formatMW(totalGeneration)} MW</span>
        </div>
        <div className="summary-divider">|</div>
        <div className="summary-item">
          <span className="summary-label">Demand:</span>
          <span className="summary-value">{formatMW(totalDemand)} MW</span>
        </div>
        <div className="summary-divider">|</div>
        <div className="summary-item">
          <span className="summary-label">Balance:</span>
          <span className={`summary-value ${isDeficit ? 'deficit' : 'surplus'}`}>
            {isDeficit ? '' : '+'}{formatMW(balance)} MW
            <span className="summary-status">
              {isDeficit ? '(deficit)' : '(surplus)'}
            </span>
          </span>
        </div>
      </div>
      <div className="scenario-narrative">
        {narrative}
      </div>
    </div>
  );
}
