import { useState, useMemo } from 'react'
import { runNMinus1 } from '../engine/contingency.js'
import { getLinksForYear } from '../engine/networkBuilder.js'
import './ContingencyPanel.css'

/**
 * N-1 Contingency Analysis Panel
 *
 * Runs SQSS-style N-1 security assessment:
 * - Remove each link one at a time
 * - Re-solve power flow
 * - Identify worst boundary/link overloads
 * - Display ranked results
 */
export default function ContingencyPanel({
  data,
  powerFlowResults,
  year,
  scenario,
  onSelectContingency,
  onClose
}) {
  const [analysisResults, setAnalysisResults] = useState(null);
  const [isRunning, setIsRunning] = useState(false);
  const [selectedRow, setSelectedRow] = useState(null);
  const [filterSeverity, setFilterSeverity] = useState('all');
  const [showDetailTable, setShowDetailTable] = useState(false);

  // Get current network links
  const links = useMemo(() => {
    return getLinksForYear(data?.linksTNUoSByYear, year);
  }, [data, year]);

  // Run N-1 analysis
  const handleRunAnalysis = () => {
    if (!powerFlowResults || !links || links.length === 0) return;

    setIsRunning(true);
    setSelectedRow(null);

    // Use setTimeout to allow UI to update before heavy computation
    setTimeout(() => {
      const results = runNMinus1({
        links,
        injections: powerFlowResults.zoneInjections,
        slackZone: 'GZ18',
        boundaryMapping: data.boundaryLinkMapping,
        etysCapabilities: data.etysCapabilities,
        year,
        scenario
      });

      setAnalysisResults(results);
      setIsRunning(false);

      // Log summary
      console.group('N-1 Contingency Analysis');
      console.log('Summary:', results.summary);
      console.log('Worst case:', results.worstCase);
      console.groupEnd();
    }, 50);
  };

  // Filter results by severity
  const filteredResults = useMemo(() => {
    if (!analysisResults) return [];
    if (filterSeverity === 'all') return analysisResults.results;
    return analysisResults.results.filter(r => r.severity === filterSeverity);
  }, [analysisResults, filterSeverity]);

  // Handle row click
  const handleRowClick = (result, index) => {
    setSelectedRow(index);
    if (onSelectContingency) {
      onSelectContingency(result);
    }
  };

  // Get severity colour
  const getSeverityColor = (severity) => {
    switch (severity) {
      case 'secure': return '#22c55e';
      case 'stressed': return '#f59e0b';
      case 'marginal': return '#f97316';
      case 'overloaded': return '#ef4444';
      case 'critical': return '#dc2626';
      default: return '#71717a';
    }
  };

  return (
    <div className="contingency-panel">
      <div className="contingency-header">
        <div>
          <h2>N-1 Contingency Analysis</h2>
          <p className="contingency-subtitle">
            SQSS-style security assessment • {links.length} links
          </p>
        </div>
        <button className="close-button" onClick={onClose}>×</button>
      </div>

      <div className="contingency-content">
        {/* Run Analysis Button */}
        {!analysisResults && !isRunning && (
          <div className="contingency-intro">
            <div className="intro-icon">
              <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M13 10V3L4 14h7v7l9-11h-7z" />
              </svg>
            </div>
            <p className="intro-text">
              Test network security by removing each link one at a time and identifying
              which outages cause boundary or thermal overloads.
            </p>
            <button
              className="run-analysis-btn"
              onClick={handleRunAnalysis}
            >
              Run N-1 Analysis
            </button>
            <p className="intro-note">
              Tests {links.length} contingencies • ~{(links.length * 0.5).toFixed(0)}ms estimated
            </p>
          </div>
        )}

        {/* Running State */}
        {isRunning && (
          <div className="contingency-running">
            <div className="spinner" />
            <p>Analysing {links.length} contingencies...</p>
          </div>
        )}

        {/* Results */}
        {analysisResults && !isRunning && (
          <>
            {/* Summary Stats */}
            <div className="contingency-summary">
              <div className="summary-stat">
                <span className="stat-value" style={{ color: '#22c55e' }}>
                  {analysisResults.summary.secure}
                </span>
                <span className="stat-label">Secure</span>
              </div>
              <div className="summary-stat">
                <span className="stat-value" style={{ color: '#f59e0b' }}>
                  {analysisResults.summary.stressed}
                </span>
                <span className="stat-label">Stressed</span>
              </div>
              <div className="summary-stat">
                <span className="stat-value" style={{ color: '#f97316' }}>
                  {analysisResults.summary.marginal}
                </span>
                <span className="stat-label">Marginal</span>
              </div>
              <div className="summary-stat">
                <span className="stat-value" style={{ color: '#ef4444' }}>
                  {analysisResults.summary.overloaded}
                </span>
                <span className="stat-label">Overloaded</span>
              </div>
              <div className="summary-stat">
                <span className="stat-value" style={{ color: '#dc2626' }}>
                  {analysisResults.summary.critical}
                </span>
                <span className="stat-label">Critical</span>
              </div>
            </div>

            <div className="summary-time">
              Completed in {analysisResults.summary.solveTimeMs.toFixed(0)}ms
              ({analysisResults.summary.avgSolveTimeMs.toFixed(2)}ms per contingency)
            </div>

            {/* Worst Case Highlight */}
            {analysisResults.worstCase && (
              <div className="worst-case-box">
                <div className="worst-case-title">Worst Contingency</div>
                <div className="worst-case-detail">
                  <span className="worst-link">{analysisResults.worstCase.removedLink}</span>
                  <span className="worst-arrow">→</span>
                  <span className="worst-boundary">
                    {analysisResults.worstCase.worstBoundary}
                  </span>
                  <span
                    className="worst-util"
                    style={{ color: getSeverityColor(analysisResults.worstCase.severity) }}
                  >
                    {analysisResults.worstCase.worstBoundaryUtil.toFixed(1)}%
                  </span>
                </div>
              </div>
            )}

            {/* Grouped boundary summary */}
            <div className="boundary-group-summary">
              <h4 className="group-summary-title">Constraints by Boundary</h4>
              {(() => {
                // Group non-disconnected results by worstBoundary
                const groups = {};
                const connected = analysisResults.results.filter(r => !r.isDisconnected);
                for (const r of connected) {
                  if (!r.worstBoundary) continue;
                  if (!groups[r.worstBoundary]) {
                    groups[r.worstBoundary] = {
                      boundary: r.worstBoundary,
                      maxUtil: 0,
                      minUtil: Infinity,
                      count: 0,
                      worstLink: null
                    };
                  }
                  const g = groups[r.worstBoundary];
                  g.count++;
                  if (r.worstBoundaryUtil > g.maxUtil) {
                    g.maxUtil = r.worstBoundaryUtil;
                    g.worstLink = r.removedLink;
                  }
                  if (r.worstBoundaryUtil < g.minUtil) {
                    g.minUtil = r.worstBoundaryUtil;
                  }
                }

                const disconnectedCount = analysisResults.results.filter(r => r.isDisconnected).length;

                const sorted = Object.values(groups).sort((a, b) => b.maxUtil - a.maxUtil);

                return (
                  <>
                    {disconnectedCount > 0 && (
                      <div className="group-row group-critical">
                        <span className="group-boundary">Network Splits</span>
                        <span className="group-count">{disconnectedCount} contingencies</span>
                        <span className="group-severity" style={{color: getSeverityColor('critical')}}>CRITICAL</span>
                      </div>
                    )}
                    {sorted.map(g => (
                      <div key={g.boundary} className="group-row" style={{
                        borderLeft: `3px solid ${getSeverityColor(
                          g.maxUtil > 100 ? 'overloaded' : g.maxUtil > 90 ? 'marginal' : g.maxUtil > 80 ? 'stressed' : 'secure'
                        )}`
                      }}>
                        <div className="group-boundary-info">
                          <span className="group-boundary">{g.boundary}</span>
                          <span className="group-detail">
                            {g.maxUtil.toFixed(1)}%
                            {g.count > 1 && ` (${g.count} contingencies, ${g.minUtil.toFixed(1)}\u2013${g.maxUtil.toFixed(1)}%)`}
                          </span>
                        </div>
                        <span className="group-worst-trigger">
                          Worst: remove {g.worstLink}
                        </span>
                      </div>
                    ))}
                  </>
                );
              })()}
            </div>

            {/* Collapsible detail table toggle */}
            <div
              className="detail-table-toggle"
              role="button"
              tabIndex={0}
              aria-expanded={showDetailTable}
              onClick={() => setShowDetailTable(!showDetailTable)}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setShowDetailTable(!showDetailTable); } }}
            >
              {showDetailTable ? '\u25BC' : '\u25B6'} All Contingencies ({analysisResults.results.length})
            </div>

            {showDetailTable && (<>
            {/* Filter */}
            <div className="contingency-filter">
              <label>Filter:</label>
              <select
                value={filterSeverity}
                onChange={(e) => setFilterSeverity(e.target.value)}
              >
                <option value="all">All ({analysisResults.results.length})</option>
                <option value="critical">Critical ({analysisResults.summary.critical})</option>
                <option value="overloaded">Overloaded ({analysisResults.summary.overloaded})</option>
                <option value="marginal">Marginal ({analysisResults.summary.marginal})</option>
                <option value="stressed">Stressed ({analysisResults.summary.stressed})</option>
                <option value="secure">Secure ({analysisResults.summary.secure})</option>
              </select>
            </div>

            {/* Results Table */}
            <div className="contingency-table-container">
              <table className="contingency-table">
                <thead>
                  <tr>
                    <th>Link Removed</th>
                    <th>Worst Boundary</th>
                    <th>Util %</th>
                    <th>Severity</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredResults.map((result, idx) => (
                    <tr
                      key={result.removedLink}
                      className={`${selectedRow === idx ? 'selected' : ''} severity-${result.severity}`}
                      onClick={() => handleRowClick(result, idx)}
                    >
                      <td className="link-cell">
                        <span className="link-id">{result.removedLink}</span>
                        <span className="link-capacity">
                          {result.removedLinkCapacity?.toFixed(0)} MW
                        </span>
                      </td>
                      <td className="boundary-cell">
                        {result.isDisconnected ? (
                          <span className="disconnected">Network Splits</span>
                        ) : (
                          result.worstBoundary || '-'
                        )}
                      </td>
                      <td className="util-cell">
                        {result.isDisconnected ? (
                          <span className="infinity">∞</span>
                        ) : (
                          <span style={{ color: getSeverityColor(result.severity) }}>
                            {result.worstBoundaryUtil.toFixed(1)}%
                          </span>
                        )}
                      </td>
                      <td className="severity-cell">
                        <span
                          className="severity-badge"
                          style={{ backgroundColor: getSeverityColor(result.severity) }}
                        >
                          {result.severity}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            </>)}

            {/* Re-run button */}
            <button
              className="rerun-btn"
              onClick={handleRunAnalysis}
            >
              Re-run Analysis
            </button>
          </>
        )}
      </div>
    </div>
  );
}
