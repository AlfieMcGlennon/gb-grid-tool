# GB Grid Scenario Tool

Interactive client-side tool for stress-testing and scenario planning on the GB electricity transmission grid. Explore power flows, boundary constraints, and network topology from 2024-2035 using real NESO/ETYS data combined with ERA5 weather climatology.

**[Live Demo](https://yourusername.github.io/gb-grid-tool/)**

![GB Grid Scenario Tool Screenshot](docs/screenshot.png)

## Features

- **Year slider (2024-2035)** - Watch planned reinforcements appear on the network
- **FES/CP30 scenarios** - Compare different generation and demand futures
- **Weather stress testing** - Adjust wind, solar, and demand percentiles from ERA5 climatology
- **Fuel type toggles** - Test "what if all gas retires?" scenarios
- **Plant editing** - Modify individual plant output, retire plants, change commissioning dates
- **Add hypothetical generation** - Place new wind farms, solar, or nuclear anywhere
- **Edit transmission links** - Add, upgrade, or remove transmission capacity
- **N-1 contingency analysis** - Test network security by removing each link
- **Merit order dispatch** - Compare simple dispatch vs economic dispatch
- **Scenario export/import** - Save and share scenario configurations

## Built With

- **React 18** + **Vite** - Fast, modern frontend
- **Leaflet** + **react-leaflet** - Interactive maps
- **DC Power Flow Engine** - 27-node Gaussian elimination solver (<1ms)
- **No backend** - All computation runs client-side in your browser

## Data Sources

All data from publicly available sources:

| Data | Source | Licence |
|------|--------|---------|
| Network topology, TEC Register, GSP demand | NESO ETYS 2024 | OGL v3 |
| Zone boundaries, boundary geometry | NESO GIS Portal | OGL v3 |
| Boundary capabilities | NESO ETYS Boundary Charts | OGL v3 |
| Wind/solar/temperature climatology | ECMWF ERA5 (1991-2024) | C3S |
| Historic demand | NESO TSD (2009-2025) | OGL v3 |

Contains NESO data © Crown copyright, used under the Open Government Licence v3.0.
Contains modified Copernicus Climate Change Service information.

## Development

```bash
npm install          # Install dependencies
npm run dev          # Dev server on localhost:5173
npm run build        # Production build to dist/
npm run preview      # Preview production build
```

## Methodology

The tool implements a standard DC power flow approximation at 27-node (TNUoS zone) resolution, following NESO's published GB Reduced Model methodology. Key assumptions:

- Flat voltage magnitude (|V| = 1.0 pu)
- Small angle differences (sin θ ≈ θ)
- Negligible resistance (R ≈ 0), lossless transmission
- Reactances from ETYS Appendix B parallel combination

This is the same approximation NESO uses for boundary transfer analysis. See the Data & Sources page in the tool for full methodology and validation results.

## Known Limitations

- DC approximation drops reactive power and losses (~3%)
- 27-node resolution cannot see internal zone congestion
- 4 edge boundaries (B0, NW1, NW2, SC3) have no cross-zone link
- Simplified dispatch does not account for NESO balancing actions

## Licence

MIT License. See [LICENSE](LICENSE) for details.

Data licences apply to the underlying datasets - see Data Sources above.
