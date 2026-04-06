# GB Grid Scenario Tool

Interactive client-side tool for stress-testing and scenario planning on the GB electricity transmission grid. Explore power flows, boundary constraints, and network topology from 2024-2035 using real NESO/ETYS data combined with ERA5 weather climatology.

**[Live Demo](https://alfiemcglennon.github.io/gb-grid-tool/)**

![GB Grid Scenario Tool](docs/screenshots/Final/Screenshot%202026-04-06%20132226.png)

## Features

- **Two zone schemes** — Toggle between 27 TNUoS zones and 82 FLOP zones for different resolution/accuracy trade-offs
- **Three dispatch modes** — Simple (all generation runs), Merit Order (demand-matched with MSL constraints), LOPF (network-constrained economic dispatch via HiGHS LP solver)
- **Year slider (2024-2035)** — Watch planned reinforcements appear on the network
- **Reinforcement toggle** — Disable planned network upgrades to see how constraints build
- **Weather stress testing** — Adjust wind, solar, and demand percentiles from ERA5 climatology (1991-2024)
- **Dynamic interconnector imports** — Lookup from 70,000 aligned ERA5+NESO historic hours
- **Fuel type toggles** — Test "what if all gas retires?" scenarios
- **Plant editing** — Modify individual plant output, retire plants, change commissioning dates
- **Add hypothetical generation** — Place new wind farms, solar, or nuclear anywhere
- **Edit transmission links** — Add, upgrade, or remove transmission capacity
- **N-1 contingency analysis** — Test network security by removing each link
- **Scenario export/import** — Save and share scenario configurations

## Built With

- **React 18** + **Vite** — Fast, modern frontend
- **Leaflet** + **react-leaflet** — Interactive maps with SCADA control room theme
- **DC Power Flow Engine** — Gaussian elimination solver (<1ms at 27 nodes, <5ms at 82 nodes)
- **HiGHS** — WASM LP solver for network-constrained economic dispatch (LOPF)
- **No backend** — All computation runs client-side in your browser

## Data Sources

All data from publicly available sources:

| Data | Source | Licence |
|------|--------|---------|
| Network topology, TEC Register, GSP demand | NESO ETYS 2024 | OGL v3 |
| Zone boundaries, boundary geometry | NESO GIS Portal | OGL v3 |
| Boundary capabilities | NESO ETYS Boundary Charts | OGL v3 |
| FLOP zone definitions | NESO FES Regional Breakdown | OGL v3 |
| GSP region boundaries | NESO GIS Portal | OGL v3 |
| Wind/solar/temperature climatology | ECMWF ERA5 (1991-2024) | C3S |
| Historic demand + interconnector flows | NESO TSD (2009-2025) | OGL v3 |

Contains NESO data © Crown copyright, used under the Open Government Licence v3.0.
Contains modified Copernicus Climate Change Service information, 2024.

## Validation

Validated against NESO's published ETYS boundary transfer percentiles across 16+ configurations (4 network resolutions, 2 flow methods, 2 IC assumptions, 2 time periods):

- **B6F (Scotland-England)**: p75 flow within **2%** of NESO at 27-zone resolution
- **84-zone FLOP model**: 6 of 10 independent boundaries within FAIR threshold (mean |p75 error| 68%)
- **Root cause of remaining gap**: dispatch methodology (NESO uses PLEXOS SCED with boundary flow limits; this tool uses DC power flow with impedance-based distribution)

See the Data & Methodology page in the tool and [docs/METHODOLOGY.md](docs/METHODOLOGY.md) for full validation details.

## Development

```bash
npm install          # Install dependencies
npm run dev          # Dev server on localhost:5173
npm run build        # Production build to dist/
npm run test         # Run engine unit tests
npm run preview      # Preview production build
```

## Methodology

The tool implements standard DC power flow at two resolutions:

- **27 TNUoS generation zones** — geographically defined charging zones
- **82 FLOP zones** — electrically defined zones matching NESO's internal boundary analysis resolution

Three dispatch modes offer different fidelity levels: simple (no demand matching), merit order (priority-based with minimum stable level constraints), and LOPF (linear optimal power flow minimising system cost subject to boundary constraints).

Full methodology, validation results, and known limitations are documented in [docs/METHODOLOGY.md](docs/METHODOLOGY.md) and in the tool's Data & Methodology page.

## Licence

MIT License. See [LICENSE](LICENSE) for details.

Data licences apply to the underlying datasets — see Data Sources above.
