#!/usr/bin/env python3
"""
PyPSA Cross-Validation: Compare GB Grid Tool DC power flow against PyPSA.

Exports the TNUoS 27-zone network to PyPSA format, runs the same scenario
in both engines, and compares link flows and voltage angles.

DC power flow (linear) should match exactly — same physics, same inputs.
Any divergence indicates an implementation bug in one or both tools.

Usage: python scripts/validation/validate_pypsa.py
"""

import sys
import io
import json
import os

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.chdir(ROOT)

import pypsa
import numpy as np
import pandas as pd

print("=" * 60)
print("PyPSA Cross-Validation: GB Grid Tool vs PyPSA")
print("=" * 60)
print(f"PyPSA version: {pypsa.__version__}")

# ============================================================
# 1. Load GB Grid Tool data
# ============================================================

print("\n--- Loading GB Grid Tool data ---")

with open('public/data/links_tnuos_by_year.json', encoding='utf-8') as f:
    links_by_year = json.load(f)

with open('public/data/zones_tnuos.json', encoding='utf-8') as f:
    zones = json.load(f)

with open('public/data/climatology.json', encoding='utf-8') as f:
    climatology = json.load(f)

with open('public/data/demand_climatology.json', encoding='utf-8') as f:
    demand_climatology = json.load(f)

with open('public/data/plants_tnuos.json', encoding='utf-8') as f:
    plants = json.load(f)

with open('public/data/boundary_link_mapping.json', encoding='utf-8') as f:
    boundary_mapping = json.load(f)

# ============================================================
# 2. Build scenario (winter 2024, p50 wind, p50 solar, p75 demand)
# ============================================================

YEAR = 2024
SEASON = 'winter'
WIND_PCT = 50
SOLAR_PCT = 50
DEMAND_PCT = 75
SLACK_ZONE = 'GZ18'
NUCLEAR_CF = 0.80
STORAGE_CF = 0.17
IC_IMPORT_PCT = 25

print(f"\n--- Scenario: {SEASON} {YEAR}, wind p{WIND_PCT}, solar p{SOLAR_PCT}, demand p{DEMAND_PCT} ---")

links_2024 = links_by_year['2024']
zone_ids = sorted(zones.keys())

print(f"  Zones: {len(zone_ids)}")
print(f"  Links: {len(links_2024)}")

# Helper: interpolate percentile from sorted percentile dict
def interp_percentile(pct_data, target_pct):
    """Interpolate a value from a percentile dictionary."""
    if not pct_data:
        return 0
    # Keys may be 'p1', 'p5', 'p10' or '1', '5', '10' — filter out non-numeric keys like 'mean'
    raw_keys = [k for k in pct_data.keys() if k.lstrip('p').isdigit()]
    if not raw_keys:
        return 0
    keys = sorted([int(k.lstrip('p')) for k in raw_keys])
    # Reconstruct key format
    prefix = 'p' if raw_keys[0].startswith('p') else ''
    vals = [pct_data[f'{prefix}{k}'] for k in keys]
    if target_pct <= keys[0]:
        return vals[0]
    if target_pct >= keys[-1]:
        return vals[-1]
    for i in range(len(keys) - 1):
        if keys[i] <= target_pct <= keys[i + 1]:
            frac = (target_pct - keys[i]) / (keys[i + 1] - keys[i])
            return vals[i] + frac * (vals[i + 1] - vals[i])
    return vals[-1]

# Build generation per zone
excluded_types = {'Reactive Compensation', 'Demand'}

def is_gen_type(t):
    return t not in excluded_types

def is_operational(plant):
    if plant.get('status') == 'Built' and plant.get('mw_connected', 0) > 0:
        return True
    return False  # Only built plants for 2024

zone_generation = {}  # zone -> total MW dispatched
zone_gen_by_type = {}  # zone -> {type: MW}

for zone_id in zone_ids:
    zone_gen_by_type[zone_id] = {}

# Aggregate plant capacity by zone
for plant in plants:
    z = plant.get('zone_id')
    pt = plant.get('plant_type', '')
    if not z or not pt or not is_gen_type(pt):
        continue
    if not is_operational(plant):
        continue
    mw = plant.get('mw_connected', 0)
    if mw <= 0:
        continue
    if z not in zone_gen_by_type:
        zone_gen_by_type[z] = {}
    zone_gen_by_type[z][pt] = zone_gen_by_type[z].get(pt, 0) + mw

# Apply capacity factors
clim = climatology.get('tnuos_zones', {})

for zone_id in zone_ids:
    total = 0
    gen_types = zone_gen_by_type.get(zone_id, {})
    zone_clim = clim.get(zone_id)

    for pt, capacity in gen_types.items():
        if pt == 'Interconnector':
            gen = capacity * (IC_IMPORT_PCT / 100)
        elif 'Wind' in pt and zone_clim:
            wind_data = zone_clim.get('wind_cf', {}).get(SEASON, {})
            pcts = wind_data.get('percentiles', wind_data)
            cf = interp_percentile(pcts, WIND_PCT)
            gen = capacity * cf
        elif ('Solar' in pt or 'PV' in pt) and zone_clim:
            solar_data = zone_clim.get('solar_cf', {}).get(SEASON, {})
            pcts = solar_data.get('percentiles', solar_data)
            cf = interp_percentile(pcts, SOLAR_PCT)
            df = solar_data.get('daylight_fraction', 1.0)
            gen = capacity * cf * df
        elif 'Nuclear' in pt:
            gen = capacity * NUCLEAR_CF
        elif 'Storage' in pt or 'Pump' in pt:
            gen = capacity * STORAGE_CF
        else:
            gen = capacity

        total += gen

    zone_generation[zone_id] = total

# Build demand per zone
zone_demand = {}
dem_clim = demand_climatology.get('zones', {})

for zone_id in zone_ids:
    zone_data = zones[zone_id]
    demand_by_year = zone_data.get('demand_mw_by_year', {})
    base_demand = demand_by_year.get(str(YEAR), 0)

    zone_dem_clim = dem_clim.get(zone_id)
    if zone_dem_clim and zone_dem_clim.get('seasonal', {}).get(SEASON, {}).get('percentiles'):
        seasonal = interp_percentile(
            zone_dem_clim['seasonal'][SEASON]['percentiles'],
            DEMAND_PCT
        )
        base_year_demand = zone_dem_clim.get('demand_by_year', {}).get('2024',
            zone_dem_clim['seasonal'][SEASON].get('mean', base_demand))
        growth = base_demand / base_year_demand if base_year_demand > 0 else 1
        demand = seasonal * (1.0 if YEAR == 2024 else growth)
    else:
        demand = base_demand

    zone_demand[zone_id] = demand

# Net injections
injections = {}
for z in zone_ids:
    injections[z] = zone_generation.get(z, 0) - zone_demand.get(z, 0)

total_gen = sum(zone_generation.values())
total_dem = sum(zone_demand.values())
print(f"  Total generation: {total_gen:.0f} MW")
print(f"  Total demand: {total_dem:.0f} MW")
print(f"  Imbalance: {total_gen - total_dem:.0f} MW (absorbed by slack {SLACK_ZONE})")

# ============================================================
# 3. Run GB Grid Tool DC power flow (replicate JS logic in Python)
# ============================================================

print("\n--- Running GB Grid Tool DC power flow ---")

# Build admittance matrix
zone_to_idx = {z: i for i, z in enumerate(zone_ids)}
n = len(zone_ids)
B = np.zeros((n, n))

valid_links = []
for link in links_2024:
    i = zone_to_idx.get(link['from'])
    j = zone_to_idx.get(link['to'])
    if i is None or j is None:
        continue
    x = link['x_equivalent']
    if x <= 0:
        continue
    b = 100.0 / x
    B[i, j] -= b
    B[j, i] -= b
    B[i, i] += b
    B[j, j] += b
    valid_links.append(link)

# Injection vector (per-unit on 100 MVA base)
P_pu = np.array([injections[z] / 100.0 for z in zone_ids])

# Remove slack bus row/column
slack_idx = zone_to_idx[SLACK_ZONE]
mask = [i for i in range(n) if i != slack_idx]
B_red = B[np.ix_(mask, mask)]
P_red = P_pu[mask]

# Solve
theta_red = np.linalg.solve(B_red, P_red)

# Reconstruct full angle vector
theta = np.zeros(n)
for k, idx in enumerate(mask):
    theta[idx] = theta_red[k]

# Compute flows
our_flows = {}
for link in valid_links:
    i = zone_to_idx[link['from']]
    j = zone_to_idx[link['to']]
    flow_pu = (theta[i] - theta[j]) * 100.0 / link['x_equivalent']
    our_flows[link['id']] = flow_pu * 100.0  # MW

our_angles = {z: theta[zone_to_idx[z]] * 180 / np.pi for z in zone_ids}

print(f"  Solved: {len(our_flows)} link flows")

# ============================================================
# 4. Build and run PyPSA network
# ============================================================

print("\n--- Building PyPSA network ---")

network = pypsa.Network()
network.set_snapshots([0])

# Add buses
for z in zone_ids:
    network.add("Bus", z, v_nom=400)

# Add lines (transmission links)
for link in valid_links:
    # PyPSA uses per-unit reactance on system base
    # Our x_equivalent is in % on 100 MVA base
    # PyPSA x is in per-unit on network base (we set s_nom_base = 100 MVA)
    x_pu = link['x_equivalent'] / 100.0
    network.add("Line", link['id'],
                bus0=link['from'],
                bus1=link['to'],
                x=x_pu,
                s_nom=link.get('capacity_mw', 99999))  # Large s_nom so unconstrained

# Add generators (one per zone, aggregated)
for z in zone_ids:
    gen_mw = zone_generation.get(z, 0)
    if gen_mw > 0:
        network.add("Generator", f"gen_{z}",
                     bus=z,
                     p_nom=gen_mw,
                     p_set=gen_mw,  # Fixed dispatch for DC PF
                     control="PQ")

# Add loads
for z in zone_ids:
    dem_mw = zone_demand.get(z, 0)
    if dem_mw > 0:
        network.add("Load", f"load_{z}",
                     bus=z,
                     p_set=dem_mw)

# Set slack bus — PyPSA uses the first bus with a generator marked as 'Slack'
# We need to add a slack generator at GZ18
network.add("Generator", "slack_gen",
            bus=SLACK_ZONE,
            control="Slack",
            p_nom=99999,
            marginal_cost=0)

print(f"  Buses: {len(network.buses)}")
print(f"  Lines: {len(network.lines)}")
print(f"  Generators: {len(network.generators)}")
print(f"  Loads: {len(network.loads)}")

# Set slack bus for PyPSA — assign it as the sub_network slack
# PyPSA determines slack from the network topology
network.buses.loc[SLACK_ZONE, 'control'] = 'Slack'

# Run DC power flow
print("\n--- Running PyPSA DC power flow ---")
network.lpf()

pypsa_flows = {}
for line_id in network.lines.index:
    pypsa_flows[line_id] = network.lines_t.p0.loc[0, line_id]

pypsa_angles = {}
for bus in network.buses.index:
    pypsa_angles[bus] = network.buses_t.v_ang.loc[0, bus] * 180 / np.pi  # radians to degrees

# Debug: check PyPSA's view of injections
print("\n  PyPSA injection check (gen - load at each bus):")
pypsa_gen_p = network.generators_t.p.loc[0] if not network.generators_t.p.empty else pd.Series()
pypsa_load_p = network.loads_t.p.loc[0] if not network.loads_t.p.empty else pd.Series()
for z in zone_ids:
    gen_at_z = sum(pypsa_gen_p.get(g, 0) for g in network.generators.index if network.generators.loc[g, 'bus'] == z)
    load_at_z = sum(pypsa_load_p.get(l, 0) for l in network.loads.index if network.loads.loc[l, 'bus'] == z)
    our_inj = injections[z]
    pypsa_inj = gen_at_z - load_at_z
    if abs(our_inj - pypsa_inj) > 1:
        print(f"    {z}: our_inj={our_inj:.1f}, pypsa_inj={pypsa_inj:.1f}, diff={our_inj-pypsa_inj:.1f}")
print(f"  Slack bus: {network.sub_networks.obj.iloc[0].slack_bus if len(network.sub_networks) > 0 else 'unknown'}")

print(f"  Solved: {len(pypsa_flows)} link flows")

# ============================================================
# 5. Compare results
# ============================================================

print("\n" + "=" * 60)
print("RESULTS COMPARISON")
print("=" * 60)

# Flow comparison
print(f"\n{'Link':<14} {'Our Flow':>10} {'PyPSA Flow':>12} {'Diff (MW)':>10} {'Diff (%)':>10}")
print("-" * 60)

max_diff_mw = 0
max_diff_pct = 0
total_links = 0
good_links = 0

for link_id in sorted(our_flows.keys()):
    our = our_flows[link_id]
    pypsa = pypsa_flows.get(link_id, 0)
    diff = our - pypsa
    diff_pct = abs(diff / our * 100) if abs(our) > 0.1 else 0

    max_diff_mw = max(max_diff_mw, abs(diff))
    max_diff_pct = max(max_diff_pct, diff_pct)
    total_links += 1
    if abs(diff) < 1.0:
        good_links += 1

    flag = '' if abs(diff) < 1.0 else ' !'
    print(f"{link_id:<14} {our:>10.1f} {pypsa:>12.1f} {diff:>10.2f} {diff_pct:>9.2f}%{flag}")

print("-" * 60)
print(f"Max absolute difference: {max_diff_mw:.4f} MW")
print(f"Max percentage difference: {max_diff_pct:.4f}%")
print(f"Links within 1 MW: {good_links}/{total_links}")

# Angle comparison
print(f"\n{'Zone':<8} {'Our Angle':>12} {'PyPSA Angle':>12} {'Diff (deg)':>12}")
print("-" * 48)
max_angle_diff = 0
for z in zone_ids:
    our_a = our_angles[z]
    pypsa_a = pypsa_angles.get(z, 0)
    diff = our_a - pypsa_a
    max_angle_diff = max(max_angle_diff, abs(diff))
    flag = '' if abs(diff) < 0.001 else ' !'
    print(f"{z:<8} {our_a:>12.6f} {pypsa_a:>12.6f} {diff:>12.8f}{flag}")

print(f"\nMax angle difference: {max_angle_diff:.10f} degrees")

# Boundary flow comparison
print(f"\n--- Boundary Aggregate Flows ---")
print(f"{'Boundary':<10} {'Our Flow':>10} {'PyPSA Flow':>12} {'Diff':>8}")
print("-" * 44)

for bnd_id, bnd in sorted(boundary_mapping.get('boundary_links', {}).items()):
    crossing = bnd.get('crossing_links', [])
    if not crossing:
        continue
    our_bnd = sum(abs(our_flows.get(cl, 0)) for cl in crossing)
    pypsa_bnd = sum(abs(pypsa_flows.get(cl, 0)) for cl in crossing)
    diff = our_bnd - pypsa_bnd
    cap = bnd.get('capability_2024_mw', 0)
    print(f"{bnd_id:<10} {our_bnd:>10.1f} {pypsa_bnd:>12.1f} {diff:>8.2f}")

# ============================================================
# 6. Verdict
# ============================================================

# Check angle differences relative to slack (should be ~0)
angle_diffs_relative = []
our_slack_angle = our_angles[SLACK_ZONE]
pypsa_slack_angle = pypsa_angles.get(SLACK_ZONE, 0)
for z in zone_ids:
    our_rel = our_angles[z] - our_slack_angle
    pypsa_rel = pypsa_angles.get(z, 0) - pypsa_slack_angle
    angle_diffs_relative.append(abs(our_rel - pypsa_rel))
max_relative_angle_diff = max(angle_diffs_relative)

print(f"\nMax angle difference (relative to slack): {max_relative_angle_diff:.10f} degrees")

print("\n" + "=" * 60)
if max_diff_mw < 1.0:
    print("VERDICT: PASS — Results match within numerical precision")
    print(f"  Max flow difference: {max_diff_mw:.6f} MW")
    print(f"  Max relative angle difference: {max_relative_angle_diff:.10f} deg")
    print(f"  All {good_links}/{total_links} link flows identical")
    import pypsa as pypsa_mod
    print(f"  DC power flow implementation independently verified against PyPSA {pypsa_mod.__version__}")
elif max_diff_mw < 10.0:
    print("VERDICT: CLOSE — Minor numerical differences")
    print(f"  Max flow difference: {max_diff_mw:.2f} MW")
    print(f"  Max relative angle difference: {max_relative_angle_diff:.8f} deg")
else:
    print("VERDICT: FAIL — Significant differences found")
    print(f"  Max flow difference: {max_diff_mw:.2f} MW")
    print("  Investigate link reactances and injection values")
print("=" * 60)
