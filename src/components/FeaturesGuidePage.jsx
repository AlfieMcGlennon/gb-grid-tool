import './FeaturesGuidePage.css'

const BASE = import.meta.env.BASE_URL + 'screenshots/';

function Screenshot({ src, alt, caption }) {
  return (
    <>
      <img
        className="guide-screenshot"
        src={BASE + src}
        alt={alt}
        loading="lazy"
      />
      {caption && <p className="guide-screenshot-caption">{caption}</p>}
    </>
  );
}

function ScreenshotPair({ left, right }) {
  return (
    <div className="guide-screenshot-pair">
      <img className="guide-screenshot" src={BASE + left.src} alt={left.alt} loading="lazy" />
      <img className="guide-screenshot" src={BASE + right.src} alt={right.alt} loading="lazy" />
    </div>
  );
}

export default function FeaturesGuidePage({ onClose, isMobile }) {
  return (
    <div className="features-guide-page">
      {!isMobile && (
        <div className="features-guide-header">
          <h1>Features & Guide</h1>
          <button className="close-button" onClick={onClose}>×</button>
        </div>
      )}

      <div className="features-guide-content">
        {/* Mobile banner */}
        {isMobile && (
          <div className="guide-mobile-banner">
            <h2>Desktop Application</h2>
            <p>
              This tool requires a desktop browser for the interactive map, control panel, and
              power flow engine. Below is a walkthrough of everything the tool can do — visit
              on a desktop or laptop for the full experience.
            </p>
          </div>
        )}

        {/* Intro */}
        <div className="guide-intro">
          <p>
            The GB Grid Scenario Tool lets you explore, stress-test, and modify the Great Britain
            electricity transmission network. Every calculation runs in your browser — no backend,
            no account required. This guide walks through each feature with screenshots.
          </p>
        </div>

        {/* 1. Overview */}
        <section className="guide-section">
          <h2><span className="guide-section-number">1</span>The Map View</h2>
          <p>
            On first load you see the GB transmission network: 27 TNUoS generation zones coloured by
            their power balance (green = exporting, red = importing), dashed boundary lines coloured
            by utilisation (green = headroom, red = constrained), and arrows showing the direction
            and magnitude of power flows between zones.
          </p>
          <p>
            The right-hand control panel sets the scenario parameters. The left-hand detail panel
            shows information about whatever you click on the map. The top bar summarises national
            generation vs demand.
          </p>
          <Screenshot
            src="map-overview.png"
            alt="Full application overview showing the GB transmission map with zones, boundaries, and power flow arrows"
            caption="The default view: 27 TNUoS zones, winter 2024, simple dispatch"
          />
        </section>

        {/* 2. Zone Schemes */}
        <section className="guide-section">
          <h2><span className="guide-section-number">2</span>Zone Scheme Toggle</h2>
          <p>
            Switch between two network resolutions using the toggle in the control panel:
          </p>
          <ul>
            <li>
              <strong>TNUoS (27 zones)</strong> — NESO's official generation charging zones. Best for
              the dominant B6F Scotland-England boundary. DC power flow runs on a 27×27 admittance matrix.
            </li>
            <li>
              <strong>FLOP (82 zones)</strong> — Higher-resolution model aggregated from substation data
              via GSP boundary grouping. Resolves intermediate Scottish boundaries (B4F, B5) that the
              27-zone model cannot see. Both models evolve with the year slider.
            </li>
          </ul>
          <ScreenshotPair
            left={{ src: 'map-overview.png', alt: 'Map in TNUoS 27-zone mode' }}
            right={{ src: 'zones-flop.png', alt: 'Map in FLOP 82-zone mode' }}
          />
          <p className="guide-screenshot-caption">Left: 27 TNUoS zones. Right: 82 FLOP zones — more granular, especially in Scotland.</p>
        </section>

        {/* 3. Year Slider */}
        <section className="guide-section">
          <h2><span className="guide-section-number">3</span>Year Slider & Reinforcements</h2>
          <p>
            Drag the year slider from 2024 to 2035 to see how the network evolves. As the year
            advances, planned transmission reinforcements from ETYS Appendix B come online — new
            links appear, ratings increase, and boundary capabilities grow. Total network capacity
            grows from ~267 GVA (2024) to ~408 GVA (2035).
          </p>
          <p>
            Toggle <strong>Reinforcements</strong> off to freeze the network at the 2024 baseline
            regardless of the selected year. This answers: "what if planned upgrades are delayed
            or cancelled? Which boundaries become critical?"
          </p>
          <ScreenshotPair
            left={{ src: 'map-overview.png', alt: 'Network in 2024 with current topology' }}
            right={{ src: 'year-2035.png', alt: 'Network in 2035 with all planned reinforcements' }}
          />
          <p className="guide-screenshot-caption">Left: 2024 baseline. Right: 2035 with full reinforcement programme.</p>
        </section>

        {/* 4. Weather Sliders */}
        <section className="guide-section">
          <h2><span className="guide-section-number">4</span>Season & Weather Sliders</h2>
          <p>
            Choose a season (Winter, Spring, Summer, Autumn, or Annual) and adjust three weather
            percentile sliders:
          </p>
          <ul>
            <li><strong>Wind</strong> — from calm (low percentile) to gale-force (high percentile)</li>
            <li><strong>Solar</strong> — from overcast to clear sky</li>
            <li><strong>Demand</strong> — from low demand to peak demand</li>
          </ul>
          <p>
            These percentiles are derived from 34 years of ERA5 reanalysis data (1991–2024) and
            16 years of NESO historic Transmission System Demand (2009–2025). Moving the sliders
            changes generation output and demand across all zones simultaneously, and the power
            flow recalculates in real time.
          </p>
          <Screenshot
            src="weather-sliders.png"
            alt="Control panel showing season selector and wind, solar, demand percentile sliders"
            caption="Weather controls: set the scenario's wind, solar, and demand conditions"
          />
        </section>

        {/* 5. Fuel Toggles */}
        <section className="guide-section">
          <h2><span className="guide-section-number">5</span>Fuel Type Toggles</h2>
          <p>
            Each generation type (wind, solar, nuclear, gas CCGT, gas OCGT, biomass, hydro,
            interconnectors, etc.) has a toggle switch. Turn off a fuel type to remove it from
            dispatch entirely — this lets you explore retirement scenarios like "what if all
            gas generation retires?" or "what happens without nuclear?"
          </p>
          <p>
            The map and power flow update immediately, showing how the remaining generation
            redistributes and which boundaries become stressed.
          </p>
          <Screenshot
            src="fuel-toggles.png"
            alt="Control panel fuel type toggle switches"
            caption="Fuel toggles in the control panel"
          />
          <Screenshot
            src="fuel-toggle-effect.png"
            alt="Map showing network impact after disabling gas generation"
            caption="Impact of disabling all gas generation — note the changed zone colours and boundary stress"
          />
        </section>

        {/* 6. Dispatch Modes */}
        <section className="guide-section">
          <h2><span className="guide-section-number">6</span>Dispatch Modes</h2>
          <p>
            Three dispatch modes are available, each progressively more realistic:
          </p>
          <ul>
            <li>
              <strong>Simple</strong> — All enabled generation runs at weather-determined output.
              No demand matching. Shows raw generation potential vs demand.
            </li>
            <li>
              <strong>Merit Order</strong> — Generation stacked by short-run marginal cost until
              demand is met. Wind and solar are must-run at £0/MWh, followed by nuclear, hydro,
              biomass, CCGT, and OCGT. Respects minimum stable levels.
            </li>
            <li>
              <strong>LOPF</strong> (Linear Optimal Power Flow) — Network-constrained economic
              dispatch using the HiGHS LP solver running in your browser. Minimises total
              generation cost subject to per-link thermal limits and boundary capability
              constraints. When constraints conflict, slack variables identify which boundaries
              cannot be resolved — showing the real constraint cost of the dispatch pattern.
            </li>
          </ul>
          <Screenshot
            src="dispatch-simple.png"
            alt="Map showing simple dispatch mode with all generation running"
            caption="Simple dispatch: everything runs, large surplus visible"
          />
          <Screenshot
            src="map-overview.png"
            alt="Map showing merit order dispatch with demand-matched generation"
            caption="Merit order: generation stacked by cost, balanced to demand"
          />
          <Screenshot
            src="dispatch-lopf.png"
            alt="Map showing LOPF dispatch with network-constrained flows"
            caption="LOPF: network-constrained optimal dispatch with per-link thermal limits"
          />
        </section>

        {/* 7. Interconnectors */}
        <section className="guide-section">
          <h2><span className="guide-section-number">7</span>Interconnector Controls</h2>
          <p>
            Nine GB interconnectors totalling ~8.4 GW are modelled as controllable imports.
            Two modes are available:
          </p>
          <ul>
            <li>
              <strong>Fixed</strong> — A slider sets total import from 0–100% of capacity. Default
              is 25%.
            </li>
            <li>
              <strong>Dynamic IC</strong> — Imports are looked up from a 5×5 wind × demand grid
              derived from 70,000 aligned ERA5 + NESO hours. Produces a realistic mean import of
              ~16% of capacity.
            </li>
          </ul>
          <Screenshot
            src="interconnector-controls.png"
            alt="Interconnector import slider and dynamic IC toggle"
            caption="Interconnector controls with fixed slider and dynamic toggle"
          />
        </section>

        {/* 8. Zone Detail */}
        <section className="guide-section">
          <h2><span className="guide-section-number">8</span>Zone Detail Panel</h2>
          <p>
            Click any zone on the map to open its detail panel on the left. This shows:
          </p>
          <ul>
            <li><strong>Power balance</strong> — net injection with exporting/importing/balanced status</li>
            <li><strong>Active generation breakdown</strong> — dispatched power by fuel type with capacity factor bars</li>
            <li><strong>Pipeline projects</strong> — upcoming generation with project counts and commissioning status</li>
            <li><strong>Individual plants</strong> — list of built plants (click to open the plant editor)</li>
            <li><strong>Demand forecast</strong> — demand projections for the selected year</li>
            <li><strong>Technical details</strong> — voltage angle, substation count, built capacity</li>
          </ul>
          <Screenshot
            src="zone-detail.png"
            alt="Detail panel showing zone information including generation breakdown and demand"
            caption="Zone detail panel for a Scottish generation zone"
          />
        </section>

        {/* 9. Boundary Detail */}
        <section className="guide-section">
          <h2><span className="guide-section-number">9</span>Boundary Detail Panel</h2>
          <p>
            Click any boundary line on the map to see its detail panel. This shows:
          </p>
          <ul>
            <li><strong>Boundary utilisation</strong> — the main metric, colour-coded from green (headroom) to red (constrained)</li>
            <li><strong>Power flow</strong> — flow MW, ETYS capability, thermal capacity, and security margin</li>
            <li><strong>Connected zones</strong> — the zone groups separated by this boundary (north and south)</li>
            <li><strong>Crossing links</strong> — individual transmission lines crossing the boundary with flow and thermal utilisation</li>
          </ul>
          <Screenshot
            src="boundary-detail.png"
            alt="Boundary detail panel showing utilisation, flow, and crossing links for B6F"
            caption="Boundary detail for B6F (Scotland-England) — the most important GB boundary"
          />
        </section>

        {/* 10. Plant Editor */}
        <section className="guide-section">
          <h2><span className="guide-section-number">10</span>Plant Editor</h2>
          <p>
            From a zone's detail panel, click any plant or the "Edit Plants" button to open the
            plant editor modal. Here you can:
          </p>
          <ul>
            <li><strong>Search and filter</strong> — find plants by name, filter by status or fuel type</li>
            <li><strong>Change status</strong> — toggle between Built, Under Construction, and Retired</li>
            <li><strong>Adjust output</strong> — slide from 0–200% of capacity to simulate partial output or hypothetical upgrades</li>
            <li><strong>Set commissioning year</strong> — for non-built plants, choose when they come online</li>
          </ul>
          <p>
            All edits persist during your session and feed directly into the power flow calculation.
            Reset individual plants or clear all edits at once.
          </p>
          <Screenshot
            src="plant-editor.png"
            alt="Plant editor modal showing searchable plant list with status and output controls"
            caption="Plant editor: search, filter, and modify individual generation projects"
          />
        </section>

        {/* 11. Node Adder */}
        <section className="guide-section">
          <h2><span className="guide-section-number">11</span>Adding Hypothetical Generation</h2>
          <p>
            Want to test "what if 3 GW of offshore wind connects into this zone?" Use the
            Add Generation button in any zone's detail panel. Choose a fuel type, enter the
            capacity in MW, and optionally give it a custom name.
          </p>
          <p>
            Added nodes participate fully in dispatch and power flow — you'll see their impact
            on zone colours, boundary utilisation, and the national summary immediately.
          </p>
          <Screenshot
            src="node-adder.png"
            alt="Node adder modal for adding hypothetical generation to a zone"
            caption="Adding 2,000 MW of hypothetical offshore wind to a zone"
          />
        </section>

        {/* 12. Link Editor */}
        <section className="guide-section">
          <h2><span className="guide-section-number">12</span>Network Topology Editor</h2>
          <p>
            Open the link editor from the control panel to modify the transmission network itself:
          </p>
          <ul>
            <li><strong>Edit existing links</strong> — change capacity ratings of any inter-zone link</li>
            <li><strong>Remove links</strong> — simulate outages or decommissioning</li>
            <li><strong>Add new links</strong> — create hypothetical transmission corridors between any two zones</li>
          </ul>
          <p>
            This lets you answer questions like "what if B6 capacity doubles?" or "what if a new
            subsea link connects Scotland directly to the Midlands?"
          </p>
          <Screenshot
            src="link-editor.png"
            alt="Link editor panel showing existing links and add new link form"
            caption="Network topology editor with link modification controls"
          />
        </section>

        {/* 13. Contingency */}
        <section className="guide-section">
          <h2><span className="guide-section-number">13</span>N-1 Contingency Analysis</h2>
          <p>
            The N-1 analysis tests network security by removing each transmission link in turn,
            re-solving the DC power flow, and recording the resulting boundary utilisations. This
            follows the SQSS methodology for identifying critical contingencies.
          </p>
          <p>
            Results are grouped by severity — secure, stressed, marginal, overloaded, and critical —
            with the worst contingency highlighted. You can see which links are most important to
            network security and which boundaries are most vulnerable.
          </p>
          <Screenshot
            src="contingency-panel.png"
            alt="N-1 contingency analysis panel showing severity rankings and worst contingencies"
            caption="N-1 contingency results: each link removed, worst overload recorded"
          />
        </section>

        {/* 14. Scenario Manager */}
        <section className="guide-section">
          <h2><span className="guide-section-number">14</span>Scenario Export & Import</h2>
          <p>
            Save your entire scenario configuration — including all plant edits, added nodes,
            link modifications, and slider settings — as a JSON file. Share scenarios with
            colleagues by exporting as a file, copying to clipboard, or generating a shareable URL
            (for scenarios under 2 KB).
          </p>
          <p>
            Import scenarios by uploading a JSON file or pasting JSON text directly. This lets you
            build up a library of test cases and share findings.
          </p>
          <Screenshot
            src="scenario-manager.png"
            alt="Scenario manager modal showing export and import options"
            caption="Scenario export/import: save and share your configurations"
          />
        </section>

        {/* 15. Legend & Accessibility */}
        <section className="guide-section">
          <h2><span className="guide-section-number">15</span>Colour Legend & Accessibility</h2>
          <p>
            The map legend shows what the zone and boundary colours mean:
          </p>
          <ul>
            <li><strong>Zones</strong> — green/blue (exporting), grey (balanced), red/orange (importing)</li>
            <li><strong>Boundaries</strong> — six-step utilisation scale from green (&lt;40%) to red (&gt;100%)</li>
          </ul>
          <p>
            A <strong>colour blind mode</strong> toggle in the control panel switches to a
            blue-to-orange palette for both zone and boundary colours, making the tool accessible
            to users with red-green colour vision deficiency.
          </p>
          <ScreenshotPair
            left={{ src: 'legend-normal.png', alt: 'Standard colour legend' }}
            right={{ src: 'legend-colourblind.png', alt: 'Colour blind mode legend' }}
          />
          <p className="guide-screenshot-caption">Left: standard palette. Right: colour blind mode (blue-orange).</p>
        </section>

        {/* Footer */}
        <div className="guide-footer">
          <p>
            All computation runs client-side in your browser — no data leaves your machine.
            <br />
            Data from NESO (OGL v3) and ECMWF ERA5 (C3S). Built with React, Vite, and Leaflet.
            <br />
            <a href="https://github.com/AlfieMcGlennon/gb-grid-tool" target="_blank" rel="noopener noreferrer">
              View source on GitHub
            </a>
          </p>
        </div>
      </div>
    </div>
  );
}
