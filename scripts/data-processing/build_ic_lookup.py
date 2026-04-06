#!/usr/bin/env python3
"""Build IC import lookup table from aligned ERA5+NESO winter data."""

import json, numpy as np

with open('scripts/winter_validation_data.json') as f:
    data = json.load(f)

records = data['records']
IC_CAP = data['metadata']['ic_capacity_mw']
TOTAL_IC = sum(IC_CAP.values())

# Extract arrays
wind_cfs = []
demands = []
ic_imports = []
ic_pcts = []

for r in records:
    wf = np.mean(list(r['wind_cf'].values()))
    wind_cfs.append(wf)
    demands.append(r['tsd_mw'])
    ic_imports.append(r['total_ic_mw'])
    ic_pcts.append(r['total_ic_mw'] / TOTAL_IC * 100)

wind_cfs = np.array(wind_cfs)
demands = np.array(demands)
ic_imports = np.array(ic_imports)
ic_pcts = np.array(ic_pcts)

# Wind CF percentile mapping (what CF corresponds to each slider percentile)
wind_pct_map = {}
for p in range(5, 100, 5):
    wind_pct_map[str(p)] = round(float(np.percentile(wind_cfs, p)), 4)

# Demand percentile mapping
dem_pct_map = {}
for p in range(5, 100, 5):
    dem_pct_map[str(p)] = round(float(np.percentile(demands, p)), 0)

# 5x5 bin edges
wind_edges = [0] + [float(np.percentile(wind_cfs, p)) for p in [20, 40, 60, 80]] + [1.01]
dem_edges = [0] + [float(np.percentile(demands, p)) for p in [20, 40, 60, 80]] + [100000]

# Build lookup grid
lookup = []
for wi in range(5):
    for di in range(5):
        mask = ((wind_cfs >= wind_edges[wi]) & (wind_cfs < wind_edges[wi+1]) &
                (demands >= dem_edges[di]) & (demands < dem_edges[di+1]))
        subset_ic = ic_pcts[mask]
        ic_pct = float(subset_ic.mean()) if len(subset_ic) > 0 else float(ic_pcts.mean())
        ic_mw = float(ic_imports[mask].mean()) if len(subset_ic) > 0 else float(ic_imports.mean())

        lookup.append({
            'wind_bin': wi, 'demand_bin': di,
            'wind_range': [round(wind_edges[wi], 4), round(wind_edges[wi+1], 4)],
            'demand_range': [round(dem_edges[di]), round(dem_edges[di+1])],
            'ic_import_pct': round(ic_pct, 1),
            'ic_import_mw': round(ic_mw),
            'n': int(mask.sum())
        })

# Per-zone capacity shares
zone_shares = {z: round(c / TOTAL_IC, 4) for z, c in IC_CAP.items()}

output = {
    'metadata': {
        'description': 'Dynamic interconnector import lookup from NESO historic data (2009-2024)',
        'source': 'NESO half-hourly demand data aligned with ERA5 weather',
        'season': 'winter (Oct-Mar)',
        'total_ic_capacity_mw': TOTAL_IC,
        'ic_zones': IC_CAP,
        'records_used': len(records),
        'overall_mean_pct': round(float(ic_pcts.mean()), 1),
        'overall_mean_mw': round(float(ic_imports.mean())),
    },
    'wind_cf_percentiles': wind_pct_map,
    'demand_percentiles_mw': dem_pct_map,
    'wind_bin_edges': [round(e, 4) for e in wind_edges],
    'demand_bin_edges': [round(e) for e in dem_edges],
    'lookup': lookup,
    'per_zone_shares': zone_shares
}

with open('public/data/ic_lookup.json', 'w') as f:
    json.dump(output, f, indent=2)

print(f'Saved ic_lookup.json ({len(records)} winter hours)')
print(f'Overall IC: {output["metadata"]["overall_mean_pct"]}% ({output["metadata"]["overall_mean_mw"]} MW)')
print()
print(f'{"":>12} | {"Low dem":>8} | {"Q2 dem":>8} | {"Med dem":>8} | {"Q4 dem":>8} | {"High dem":>8}')
wl = ['Low wind', 'Q2 wind', 'Med wind', 'Q4 wind', 'High wind']
for wi in range(5):
    row = wl[wi].rjust(12) + ' |'
    for di in range(5):
        e = lookup[wi * 5 + di]
        row += f' {e["ic_import_pct"]:>6.1f}% |'
    print(row)
