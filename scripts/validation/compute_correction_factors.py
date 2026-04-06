#!/usr/bin/env python3
"""
Compute boundary flow correction factors by comparing 646-node substation model
against 27-node zonal model on the same scenarios.

For each boundary: correction_ratio = substation_flow / zonal_flow
These ratios can be applied in the browser tool to improve accuracy.
"""

import json, numpy as np, time
from scipy.sparse import lil_matrix
from scipy.sparse.linalg import splu
from collections import deque
from pathlib import Path

ROOT = Path(__file__).parent.parent

# Load all data
def load(p): return json.load(open(ROOT / p))

zones_tnuos = load("public/data/zones_tnuos.json")
links_by_year = load("public/data/links_tnuos_by_year.json")
boundary_mapping = load("public/data/boundary_link_mapping.json")
etys_caps = load("public/data/etys_capabilities.json")
climatology = load("public/data/climatology.json")
plants = load("public/data/plants_tnuos.json")
sub_network = load("docs/substation/substation_network.json")
sub_injections = load("docs/substation/substation_injections.json")
sub_zone_map = load("docs/substation/substation_zone_mapping.json")
validation_data = load("scripts/winter_validation_data.json")

YEAR = 2024
NUCLEAR_AVAIL = 0.80
IC_IMPORT_PCT = 65

# ============================================================
# 27-NODE ZONAL MODEL (mirrors JS dcPowerFlow.js)
# ============================================================
def solve_27node(injections_by_zone, links):
    zones = sorted(injections_by_zone.keys())
    n = len(zones)
    z2i = {z: i for i, z in enumerate(zones)}

    B = np.zeros((n, n))
    for link in links:
        i, j = z2i.get(link['from']), z2i.get(link['to'])
        if i is None or j is None: continue
        b = 100.0 / link['x_equivalent']
        B[i, j] -= b; B[j, i] -= b
        B[i, i] += b; B[j, j] += b

    P = np.array([injections_by_zone[z] / 100.0 for z in zones])
    slack = z2i.get('GZ18', 0)

    # Remove slack
    mask = [i for i in range(n) if i != slack]
    B_red = B[np.ix_(mask, mask)]
    P_red = P[mask]

    theta = np.zeros(n)
    try:
        theta_red = np.linalg.solve(B_red, P_red)
    except np.linalg.LinAlgError:
        return {}
    for idx, full_idx in enumerate(mask):
        theta[full_idx] = theta_red[idx]

    flows = {}
    for link in links:
        i, j = z2i.get(link['from']), z2i.get(link['to'])
        if i is None or j is None: continue
        flow_pu = (theta[i] - theta[j]) * 100.0 / link['x_equivalent']
        flows[link['id']] = flow_pu * 100.0
    return flows


def boundary_flows_27node(flows):
    result = {}
    for name, b in boundary_mapping.get('boundary_links', {}).items():
        if not b.get('crossing_links'): continue
        total = sum(flows.get(lid, 0) for lid in b['crossing_links'])
        result[name] = total
    return result


# ============================================================
# 646-NODE SUBSTATION MODEL
# ============================================================
print("Building 646-node substation model...")
nodes = sub_network['node_ids']
branches = sub_network['branches']
node_to_idx = {n: i for i, n in enumerate(nodes)}
n_total = len(nodes)

# Find connected component
adj = {i: set() for i in range(n_total)}
for br in branches:
    i = node_to_idx.get(br['sub1'])
    j = node_to_idx.get(br['sub2'])
    if i is not None and j is not None:
        adj[i].add(j); adj[j].add(i)

visited = set()
queue = deque([0])
visited.add(0)
while queue:
    cur = queue.popleft()
    for nb in adj[cur]:
        if nb not in visited:
            visited.add(nb); queue.append(nb)

active_nodes = sorted(visited)
active_set = set(active_nodes)
active_idx = {old: new for new, old in enumerate(active_nodes)}
m = len(active_nodes)

# Build B matrix
B_sub = lil_matrix((m, m))
branch_data = []  # (i_active, j_active, b, sub1, sub2)
for br in branches:
    i_old = node_to_idx.get(br['sub1'])
    j_old = node_to_idx.get(br['sub2'])
    if i_old is None or j_old is None: continue
    if i_old not in active_set or j_old not in active_set: continue
    i, j = active_idx[i_old], active_idx[j_old]
    x_pu = br['x_pct'] / 100.0
    if x_pu <= 0: continue
    b = 1.0 / x_pu
    B_sub[i, j] -= b; B_sub[j, i] -= b
    B_sub[i, i] += b; B_sub[j, j] += b
    branch_data.append((i, j, b, br['sub1'], br['sub2']))

# Slack bus: find GZ18 substation with most connections
sub_to_zone = {}
for code, data in sub_zone_map.get('substations', {}).items():
    sub_to_zone[code] = data.get('zone')

slack_candidates = [(i, len(adj[old])) for old, i in active_idx.items()
                    if sub_to_zone.get(nodes[old]) == 'GZ18']
slack_sub = max(slack_candidates, key=lambda x: x[1])[0] if slack_candidates else 0

# Remove slack, LU factorize
mask_sub = [i for i in range(m) if i != slack_sub]
B_red_sub = B_sub.tocsc()[np.ix_(mask_sub, mask_sub)].tocsc()
lu = splu(B_red_sub)
print(f"  Active nodes: {m}, branches: {len(branch_data)}, slack: {nodes[active_nodes[slack_sub]]}")

# Boundary crossing: find branches that cross zone boundaries
boundary_branch_map = {}
for bname, bdata in boundary_mapping.get('boundary_links', {}).items():
    crossing = bdata.get('crossing_links', [])
    if not crossing: continue
    # Get zone pairs from crossing links
    zone_pairs = set()
    for lid in crossing:
        parts = lid.split('-')
        if len(parts) == 2:
            zone_pairs.add((parts[0], parts[1]))
            zone_pairs.add((parts[1], parts[0]))

    # Find branches connecting substations across these zone pairs
    # Store direction: +1 if sub1 is in north_zones, -1 if sub1 is in south_zones
    north_zones = set(bdata.get('north_zones', []))
    south_zones = set(bdata.get('south_zones', []))
    crossing_branches = []
    for bi, (i, j, b, s1, s2) in enumerate(branch_data):
        z1 = sub_to_zone.get(s1)
        z2 = sub_to_zone.get(s2)
        if z1 and z2 and (z1, z2) in zone_pairs:
            # Direction sign: +1 means branch goes north→south (positive = NESO convention)
            if z1 in north_zones and z2 in south_zones:
                direction = 1
            elif z1 in south_zones and z2 in north_zones:
                direction = -1
            else:
                direction = 1  # fallback
            crossing_branches.append((bi, z1, z2, direction))
    boundary_branch_map[bname] = crossing_branches

print(f"  Boundary crossings mapped: {sum(len(v) for v in boundary_branch_map.values())} branches across {len(boundary_branch_map)} boundaries")


def solve_substation(injections_by_sub):
    P = np.zeros(m)
    for sub_code, mw in injections_by_sub.items():
        old_idx = node_to_idx.get(sub_code)
        if old_idx is not None and old_idx in active_set:
            act_idx = active_idx[old_idx]
            P[act_idx] += mw / 100.0  # Per-unit

    P_red = P[mask_sub]
    theta = np.zeros(m)
    theta_red = lu.solve(P_red)
    for idx, full_idx in enumerate(mask_sub):
        theta[full_idx] = theta_red[idx]

    # Compute branch flows
    branch_flows = []
    for i, j, b, s1, s2 in branch_data:
        flow = (theta[i] - theta[j]) * b * 100.0  # MW
        branch_flows.append(flow)
    return branch_flows


def boundary_flows_substation(branch_flows):
    result = {}
    for bname, crossings in boundary_branch_map.items():
        # Use directional sign so positive = north→south (matches NESO and 27-node convention)
        total = sum(branch_flows[bi] * direction for bi, z1, z2, direction in crossings)
        result[bname] = total
    return result


# ============================================================
# BUILD GENERATION AND DEMAND FOR EACH SCENARIO
# ============================================================
# Zone capacities (built only, 2024)
zone_cap = {}
for p in plants:
    if not p.get('zone_id') or not p.get('plant_type'): continue
    if p.get('status') != 'Built' or p.get('mw_connected', 0) <= 0: continue
    pt = p['plant_type']
    if any(x in pt for x in ['Demand', 'Reactive', 'Substation']): continue
    z = p['zone_id']
    if z not in zone_cap: zone_cap[z] = {}
    zone_cap[z][pt] = zone_cap[z].get(pt, 0) + p['mw_connected']

# Zone demand shares
total_base_dem = sum(z.get('demand_mw_by_year', {}).get(str(YEAR), 0) for z in zones_tnuos.values())
zone_dem_shares = {zid: z.get('demand_mw_by_year', {}).get(str(YEAR), 0) / total_base_dem
                   for zid, z in zones_tnuos.items()}

# Substation generation data
sub_gen = sub_injections.get('generation_by_substation', {})

# Substation demand data — per-GSP demand from ETYS Appendix G
sub_dem = sub_injections.get('demand_by_substation', {})
total_sub_dem = sum(sub_dem.values())
sub_dem_shares = {k: v / total_sub_dem for k, v in sub_dem.items()} if total_sub_dem > 0 else {}
print(f"  Demand substations: {len(sub_dem)}, total: {total_sub_dem:.0f} MW")

# 27-node links for 2024
links_2024 = links_by_year.get('2024', links_by_year.get(2024, []))

# ============================================================
# RUN BOTH MODELS ON SAME SCENARIOS
# ============================================================
records = validation_data['records']
print(f"\nRunning {len(records)} scenarios through both models...")

flow_27 = {}   # {boundary: [flow1, flow2, ...]}
flow_sub = {}  # {boundary: [flow1, flow2, ...]}
t0 = time.time()

for ri, record in enumerate(records):
    if ri % 500 == 0 and ri > 0:
        elapsed = time.time() - t0
        rate = ri / elapsed
        print(f"  {ri}/{len(records)} ({rate:.0f}/s)")

    tsd = record['tsd_mw']

    # Build zonal generation and demand
    zone_gen = {}
    zone_demand = {}
    ic_by_zone = {}

    for zid in zones_tnuos:
        zone_demand[zid] = tsd * zone_dem_shares.get(zid, 0)

    for zid, caps in zone_cap.items():
        gen = {}
        for pt, mw in caps.items():
            if pt == 'Interconnector':
                ic_by_zone[zid] = ic_by_zone.get(zid, 0) + mw * IC_IMPORT_PCT / 100
                continue
            if 'Wind' in pt:
                cf = record['wind_cf'].get(zid, 0)
                gen[pt] = mw * cf
            elif 'Solar' in pt or 'PV' in pt:
                cf = record['solar_cf'].get(zid, 0)
                gen[pt] = mw * cf
            elif 'Nuclear' in pt:
                gen[pt] = mw * NUCLEAR_AVAIL
            else:
                gen[pt] = mw
        zone_gen[zid] = gen

    # Simple dispatch: total gen - demand per zone (skip merit order for speed)
    injections_27 = {}
    for zid in zones_tnuos:
        gen_total = sum(zone_gen.get(zid, {}).values())
        ic = ic_by_zone.get(zid, 0)
        dem = zone_demand.get(zid, 0)
        injections_27[zid] = gen_total + ic - dem

    # Solve 27-node
    flows_z = solve_27node(injections_27, links_2024)
    bf_z = boundary_flows_27node(flows_z)

    # Build substation injections
    sub_inj = {}
    # Generation: use substation_injections.json
    for sub_code, gen_types in sub_gen.items():
        zone = sub_to_zone.get(sub_code)
        if not zone: continue
        total = 0
        for pt, mw in gen_types.items():
            if 'Interconnector' in pt:
                total += mw * IC_IMPORT_PCT / 100
            elif 'Wind' in pt:
                cf = record['wind_cf'].get(zone, 0)
                total += mw * cf
            elif 'Solar' in pt or 'PV' in pt:
                cf = record['solar_cf'].get(zone, 0)
                total += mw * cf
            elif 'Nuclear' in pt:
                total += mw * NUCLEAR_AVAIL
            elif any(x in pt for x in ['Demand', 'Reactive', 'Substation']):
                continue
            else:
                total += mw
        sub_inj[sub_code] = sub_inj.get(sub_code, 0) + total

    # Demand: distribute national demand to substations by GSP demand shares
    for sub_code, share in sub_dem_shares.items():
        dem_mw = tsd * share
        sub_inj[sub_code] = sub_inj.get(sub_code, 0) - dem_mw

    # Solve substation
    branch_flows = solve_substation(sub_inj)
    bf_s = boundary_flows_substation(branch_flows)

    # Record
    for bname in bf_z:
        if bname not in flow_27: flow_27[bname] = []
        flow_27[bname].append(bf_z[bname])
    for bname in bf_s:
        if bname not in flow_sub: flow_sub[bname] = []
        flow_sub[bname].append(bf_s[bname])

elapsed = time.time() - t0
print(f"Done: {len(records)} scenarios in {elapsed:.1f}s ({len(records)/elapsed:.0f}/s)")

# ============================================================
# COMPUTE CORRECTION FACTORS
# ============================================================
print("\n=== CORRECTION FACTORS ===")
print(f"{'Boundary':>8} | {'27-node p25':>10} | {'Sub p25':>10} | {'27-node p75':>10} | {'Sub p75':>10} | {'Ratio p25':>10} | {'Ratio p75':>10} | {'Avg Ratio':>10}")
print("-" * 100)

corrections = {}
neso_scenario = 'Holistic Transition'
validate_boundaries = ['B6F', 'B7aF', 'B9', 'SW1', 'B1aF', 'B2F', 'B3', 'B4F', 'B5', 'SC2']

for bname in validate_boundaries:
    z = np.array(flow_27.get(bname, []))
    s = np.array(flow_sub.get(bname, []))

    if len(z) == 0 or len(s) == 0:
        print(f"{bname:>8} | NO DATA")
        continue

    # Use absolute values for ratio computation
    z_p25, z_p75 = np.percentile(z, 25), np.percentile(z, 75)
    s_p25, s_p75 = np.percentile(s, 25), np.percentile(s, 75)

    # Correction ratio: how much does the substation model differ from zonal?
    r_p25 = s_p25 / z_p25 if abs(z_p25) > 1 else 1.0
    r_p75 = s_p75 / z_p75 if abs(z_p75) > 1 else 1.0
    r_avg = (r_p25 + r_p75) / 2

    corrections[bname] = {
        "ratio_p25": round(r_p25, 3),
        "ratio_p75": round(r_p75, 3),
        "ratio_avg": round(r_avg, 3),
        "zonal_p25": round(z_p25),
        "zonal_p75": round(z_p75),
        "sub_p25": round(s_p25),
        "sub_p75": round(s_p75),
    }

    # NESO values
    cap_data = etys_caps.get('boundaries', {}).get(bname, {}).get('fes24', {}).get(neso_scenario, {})
    neso_p25 = cap_data.get('25pc', {}).get(str(YEAR), '?')
    neso_p75 = cap_data.get('75pc', {}).get(str(YEAR), '?')

    print(f"{bname:>8} | {z_p25:>10.0f} | {s_p25:>10.0f} | {z_p75:>10.0f} | {s_p75:>10.0f} | {r_p25:>10.3f} | {r_p75:>10.3f} | {r_avg:>10.3f}")

# Show what corrected 27-node would look like
print("\n=== CORRECTED 27-NODE vs NESO ===")
print(f"{'Boundary':>8} | {'27n p25':>8} | {'Corr p25':>9} | {'NESO p25':>9} | {'Err':>6} | {'27n p75':>8} | {'Corr p75':>9} | {'NESO p75':>9} | {'Err':>6} | Status")
print("-" * 110)

for bname in validate_boundaries:
    c = corrections.get(bname)
    if not c: continue

    cap_data = etys_caps.get('boundaries', {}).get(bname, {}).get('fes24', {}).get(neso_scenario, {})
    neso_p25 = cap_data.get('25pc', {}).get(str(YEAR))
    neso_p75 = cap_data.get('75pc', {}).get(str(YEAR))
    if neso_p25 is None or neso_p75 is None: continue

    corr_p25 = round(c['zonal_p25'] * c['ratio_p25'])
    corr_p75 = round(c['zonal_p75'] * c['ratio_p75'])

    err_p25 = round((corr_p25 - neso_p25) / max(abs(neso_p25), 1) * 100)
    err_p75 = round((corr_p75 - neso_p75) / max(abs(neso_p75), 1) * 100)

    if abs(err_p25) <= 30 and abs(err_p75) <= 30: status = 'GOOD'
    elif abs(err_p25) <= 50 or abs(err_p75) <= 50: status = 'FAIR'
    else: status = 'POOR'

    print(f"{bname:>8} | {c['zonal_p25']:>8} | {corr_p25:>9} | {neso_p25:>9} | {err_p25:>+5}% | {c['zonal_p75']:>8} | {corr_p75:>9} | {neso_p75:>9} | {err_p75:>+5}% | {status}")

# ============================================================
# 646-NODE STANDALONE VALIDATION AGAINST NESO
# ============================================================
print("\n=== 646-NODE SUBSTATION MODEL vs NESO ===")
print(f"{'Boundary':>8} | {'Sub p25':>8} | {'NESO p25':>9} | {'Err':>6} | {'Sub p75':>8} | {'NESO p75':>9} | {'Err':>6} | Status")
print("-" * 85)

sub_results = []
for bname in validate_boundaries:
    s = np.array(flow_sub.get(bname, []))
    if len(s) == 0: continue

    cap_data = etys_caps.get('boundaries', {}).get(bname, {}).get('fes24', {}).get(neso_scenario, {})
    neso_p25 = cap_data.get('25pc', {}).get(str(YEAR))
    neso_p75 = cap_data.get('75pc', {}).get(str(YEAR))
    if neso_p25 is None or neso_p75 is None: continue

    s_p25 = round(np.percentile(s, 25))
    s_p75 = round(np.percentile(s, 75))

    e25 = round((s_p25 - neso_p25) / max(abs(neso_p25), 1) * 100)
    e75 = round((s_p75 - neso_p75) / max(abs(neso_p75), 1) * 100)

    if abs(e25) <= 30 and abs(e75) <= 30: status = 'GOOD'
    elif abs(e25) <= 50 or abs(e75) <= 50: status = 'FAIR'
    else: status = 'POOR'

    sub_results.append({'name': bname, 'p25': s_p25, 'p75': s_p75, 'e25': e25, 'e75': e75, 'status': status})
    print(f"{bname:>8} | {s_p25:>8} | {neso_p25:>9} | {e25:>+5}% | {s_p75:>8} | {neso_p75:>9} | {e75:>+5}% | {status}")

good_s = sum(1 for r in sub_results if r['status'] == 'GOOD')
fair_s = sum(1 for r in sub_results if r['status'] == 'FAIR')
poor_s = sum(1 for r in sub_results if r['status'] == 'POOR')
print(f"\n646-node summary: Good {good_s} | Fair {fair_s} | Poor {poor_s}")

# Side-by-side comparison
print("\n=== SIDE-BY-SIDE: 27-NODE vs 646-NODE vs NESO ===")
print(f"{'Boundary':>8} | {'27n p25':>8} | {'646n p25':>9} | {'NESO p25':>9} | {'27n p75':>8} | {'646n p75':>9} | {'NESO p75':>9} | 27n | 646n")
print("-" * 105)

for bname in validate_boundaries:
    z = np.array(flow_27.get(bname, []))
    s = np.array(flow_sub.get(bname, []))
    if len(z) == 0 or len(s) == 0: continue

    cap_data = etys_caps.get('boundaries', {}).get(bname, {}).get('fes24', {}).get(neso_scenario, {})
    neso_p25 = cap_data.get('25pc', {}).get(str(YEAR))
    neso_p75 = cap_data.get('75pc', {}).get(str(YEAR))
    if neso_p25 is None or neso_p75 is None: continue

    z_p25, z_p75 = round(np.percentile(z, 25)), round(np.percentile(z, 75))
    s_p25, s_p75 = round(np.percentile(s, 25)), round(np.percentile(s, 75))

    ze25 = round((z_p25 - neso_p25) / max(abs(neso_p25), 1) * 100)
    ze75 = round((z_p75 - neso_p75) / max(abs(neso_p75), 1) * 100)
    se25 = round((s_p25 - neso_p25) / max(abs(neso_p25), 1) * 100)
    se75 = round((s_p75 - neso_p75) / max(abs(neso_p75), 1) * 100)

    z_status = 'GOOD' if abs(ze25)<=30 and abs(ze75)<=30 else 'FAIR' if abs(ze25)<=50 or abs(ze75)<=50 else 'POOR'
    s_status = 'GOOD' if abs(se25)<=30 and abs(se75)<=30 else 'FAIR' if abs(se25)<=50 or abs(se75)<=50 else 'POOR'

    print(f"{bname:>8} | {z_p25:>8} | {s_p25:>9} | {neso_p25:>9} | {z_p75:>8} | {s_p75:>9} | {neso_p75:>9} | {z_status:<4} | {s_status}")

# Save
output = {"corrections": corrections, "sub_validation": sub_results}
with open(ROOT / "scripts" / "correction_factors.json", "w") as f:
    json.dump(output, f, indent=2)
print("\nSaved to scripts/correction_factors.json")
