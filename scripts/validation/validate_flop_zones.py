#!/usr/bin/env python3
"""
Build 90-zone FLOP model and validate against NESO boundary flows.
Compares: 27-zone TNUoS model vs ~90-zone FLOP model vs NESO published values.
"""
import json, numpy as np, sys, io, time
from scipy.sparse import lil_matrix
from scipy.sparse.linalg import splu
from collections import defaultdict, deque

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

# Load data
def load(p):
    with open(p) as f: return json.load(f)

zones_tnuos = load('public/data/zones_tnuos.json')
links24 = load('public/data/links_tnuos_by_year.json').get('2024', [])
boundary_mapping = load('public/data/boundary_link_mapping.json')
etys_caps = load('public/data/etys_capabilities.json')
plants = load('public/data/plants_tnuos.json')
climatology = load('public/data/climatology.json')
sub_network = load('docs/substation/substation_network.json')
sub_injections = load('docs/substation/substation_injections.json')
sub_zone_map = load('public/data/substation_zone_mapping.json')
flop_mapping = load('scripts/flop_zone_mapping.json')
validation_data = load('scripts/winter_validation_data.json')

YEAR = 2024
NUCLEAR_AVAIL = 0.80
IC_PCT = 65
SCENARIO = 'Holistic Transition'

nodes = sub_network['node_ids']
branches = sub_network['branches']
node_to_idx = {n: i for i, n in enumerate(nodes)}

# Build substation -> FLOP zone mapping
sub_to_flop = {}
for flop_zone, codes in flop_mapping.items():
    for code in codes:
        sub_to_flop[code] = flop_zone

# For unmapped substations, use TNUoS zone as fallback
sub_to_tnuos = {code: data['zone'] for code, data in sub_zone_map['substations'].items()}
for code in nodes:
    if code not in sub_to_flop:
        tnuos = sub_to_tnuos.get(code)
        if tnuos:
            sub_to_flop[code] = f'TNUoS_{tnuos}'  # Prefix to distinguish

flop_zones = sorted(set(sub_to_flop.values()))
print(f'FLOP zones: {len(flop_zones)} (incl TNUoS fallbacks for unmapped subs)')
print(f'Substations mapped to FLOP: {sum(1 for c in nodes if c in sub_to_flop)}/{len(nodes)}')

# Build FLOP-level network (aggregate branches by FLOP zone pair)
n_flop = len(flop_zones)
flop_to_idx = {z: i for i, z in enumerate(flop_zones)}

# Build admittance matrix
B_flop = lil_matrix((n_flop, n_flop))
flop_branch_data = []  # (i, j, b, sub1, sub2, fz1, fz2)

for br in branches:
    i_old = node_to_idx.get(br['sub1'])
    j_old = node_to_idx.get(br['sub2'])
    if i_old is None or j_old is None: continue
    fz1 = sub_to_flop.get(br['sub1'])
    fz2 = sub_to_flop.get(br['sub2'])
    if not fz1 or not fz2: continue
    if fz1 == fz2: continue  # Internal branch

    fi = flop_to_idx[fz1]
    fj = flop_to_idx[fz2]
    x_pu = br['x_pct'] / 100.0
    if x_pu <= 0: continue
    b = 1.0 / x_pu
    B_flop[fi, fj] -= b
    B_flop[fj, fi] -= b
    B_flop[fi, fi] += b
    B_flop[fj, fj] += b
    flop_branch_data.append((fi, fj, b, br['sub1'], br['sub2'], fz1, fz2))

# Find connected component
adj = defaultdict(set)
for fi, fj, *_ in flop_branch_data:
    adj[fi].add(fj)
    adj[fj].add(fi)

visited = set()
queue = deque([0])
visited.add(0)
while queue:
    cur = queue.popleft()
    for nb in adj[cur]:
        if nb not in visited:
            visited.add(nb)
            queue.append(nb)

active = sorted(visited)
active_set = set(active)
active_map = {old: new for new, old in enumerate(active)}
m = len(active)

# Rebuild B for active only
B_active = lil_matrix((m, m))
active_branches = []
for fi, fj, b, s1, s2, fz1, fz2 in flop_branch_data:
    if fi not in active_set or fj not in active_set: continue
    ai, aj = active_map[fi], active_map[fj]
    B_active[ai, aj] -= b
    B_active[aj, ai] -= b
    B_active[ai, ai] += b
    B_active[aj, aj] += b
    active_branches.append((ai, aj, b, s1, s2, fz1, fz2))

# Slack: find FLOP zone containing GZ18 substations (most connected)
gz18_flop_zones = set()
for code, data in sub_zone_map['substations'].items():
    if data.get('zone') == 'GZ18' and code in sub_to_flop:
        fz = sub_to_flop[code]
        fi = flop_to_idx.get(fz)
        if fi is not None and fi in active_set:
            gz18_flop_zones.add(active_map[fi])

slack = max(gz18_flop_zones, key=lambda x: len(adj.get(x, set()))) if gz18_flop_zones else 0

mask = [i for i in range(m) if i != slack]
B_red = B_active.tocsc()[np.ix_(mask, mask)].tocsc()
lu = splu(B_red)

print(f'Active FLOP nodes: {m}, branches: {len(active_branches)}')
print(f'Slack FLOP zone: {flop_zones[active[slack]]}')

# Build boundary crossing map for FLOP zones
# For each boundary, find branches that cross between its north/south FLOP zones
boundary_flop_crossings = {}
for bname, bdata in boundary_mapping.get('boundary_links', {}).items():
    north_tnuos = set(bdata.get('north_zones', []))
    south_tnuos = set(bdata.get('south_zones', []))
    crossing_links = bdata.get('crossing_links', [])
    if not crossing_links: continue

    # Map TNUoS north/south to FLOP zones
    north_flop = set()
    south_flop = set()
    for code, fz in sub_to_flop.items():
        tnuos = sub_to_tnuos.get(code)
        if tnuos in north_tnuos: north_flop.add(fz)
        elif tnuos in south_tnuos: south_flop.add(fz)

    # Find branches crossing between north and south FLOP zones
    crossings = []
    for bi, (ai, aj, b, s1, s2, fz1, fz2) in enumerate(active_branches):
        if (fz1 in north_flop and fz2 in south_flop):
            crossings.append((bi, 1))  # +1 = north to south
        elif (fz1 in south_flop and fz2 in north_flop):
            crossings.append((bi, -1))  # -1 = south to north

    if crossings:
        boundary_flop_crossings[bname] = crossings

print(f'Boundaries with FLOP crossings: {len(boundary_flop_crossings)}')

# Substation generation and demand
sub_gen = sub_injections.get('generation_by_substation', {})
sub_dem = sub_injections.get('demand_by_substation', {})
total_sub_dem = sum(sub_dem.values())
sub_dem_shares = {k: v / total_sub_dem for k, v in sub_dem.items()}

# Run validation on sampled data
records = validation_data['records'][:2000]  # Use 2000 for speed
print(f'\nRunning {len(records)} scenarios on FLOP model...')

flow_samples = defaultdict(list)
t0 = time.time()
ok = 0

for ri, record in enumerate(records):
    if ri % 500 == 0 and ri > 0:
        print(f'  {ri}/{len(records)} ({ri/(time.time()-t0):.0f}/s)')

    try:
        # Build FLOP-level injections
        P = np.zeros(m)

        # Generation at each substation
        for sub_code, gen_types in sub_gen.items():
            fz = sub_to_flop.get(sub_code)
            if not fz: continue
            fi = flop_to_idx.get(fz)
            if fi is None or fi not in active_set: continue
            ai = active_map[fi]

            tnuos = sub_to_tnuos.get(sub_code)
            total = 0
            for pt, mw in gen_types.items():
                if 'Interconnector' in pt:
                    total += mw * IC_PCT / 100
                elif 'Wind' in pt:
                    cf = record['wind_cf'].get(tnuos, 0)
                    total += mw * cf
                elif 'Solar' in pt or 'PV' in pt:
                    cf = record['solar_cf'].get(tnuos, 0)
                    total += mw * cf
                elif 'Nuclear' in pt:
                    total += mw * NUCLEAR_AVAIL
                elif any(x in pt for x in ['Demand', 'Reactive', 'Substation']):
                    continue
                else:
                    total += mw
            P[ai] += total / 100.0

        # Demand at each substation
        for sub_code, share in sub_dem_shares.items():
            fz = sub_to_flop.get(sub_code)
            if not fz: continue
            fi = flop_to_idx.get(fz)
            if fi is None or fi not in active_set: continue
            ai = active_map[fi]
            dem_mw = record['tsd_mw'] * share
            P[ai] -= dem_mw / 100.0

        # Solve
        P_red = P[mask]
        theta = np.zeros(m)
        theta_red = lu.solve(P_red)
        for idx, full_idx in enumerate(mask):
            theta[full_idx] = theta_red[idx]

        # Branch flows
        branch_flows = np.zeros(len(active_branches))
        for bi, (ai, aj, b, s1, s2, fz1, fz2) in enumerate(active_branches):
            branch_flows[bi] = (theta[ai] - theta[aj]) * b * 100.0

        # Boundary flows
        for bname, crossings in boundary_flop_crossings.items():
            total = sum(branch_flows[bi] * direction for bi, direction in crossings)
            flow_samples[bname].append(total)

        ok += 1
    except Exception as e:
        pass

elapsed = time.time() - t0
print(f'Done: {ok}/{len(records)} in {elapsed:.1f}s ({ok/elapsed:.0f}/s)')

# Compute percentiles and compare
def pctile(arr, p):
    s = sorted(arr)
    idx = (p / 100) * (len(s) - 1)
    lo, hi = int(idx), min(int(idx) + 1, len(s) - 1)
    return s[lo] + (s[hi] - s[lo]) * (idx - lo)

boundaries = ['B6F', 'B7aF', 'B9', 'SW1', 'B1aF', 'B2F', 'B3', 'B4F', 'B5', 'SC2']

print(f'\n=== FLOP 90-ZONE MODEL vs NESO ===')
print(f'{"Bound":>6} | {"FLOP p25":>8} | {"NESO p25":>8} | {"Err":>6} | {"FLOP p75":>8} | {"NESO p75":>8} | {"Err":>6} | Status')
print('-' * 80)

good, fair, poor = 0, 0, 0
results = []

for bname in boundaries:
    samples = flow_samples.get(bname)
    if not samples or len(samples) < 10:
        print(f'{bname:>6} | NO DATA')
        continue

    cap_data = etys_caps.get('boundaries', {}).get(bname, {}).get('fes24', {}).get(SCENARIO, {})
    nP25 = cap_data.get('25pc', {}).get(str(YEAR))
    nP75 = cap_data.get('75pc', {}).get(str(YEAR))
    if nP25 is None or nP75 is None:
        print(f'{bname:>6} | NO NESO DATA')
        continue

    oP25 = round(pctile(samples, 25))
    oP75 = round(pctile(samples, 75))
    e25 = round((oP25 - nP25) / max(abs(nP25), 1) * 100)
    e75 = round((oP75 - nP75) / max(abs(nP75), 1) * 100)

    if abs(e25) <= 30 and abs(e75) <= 30: status = 'GOOD'; good += 1
    elif abs(e25) <= 50 or abs(e75) <= 50: status = 'FAIR'; fair += 1
    else: status = 'POOR'; poor += 1

    results.append({'name': bname, 'p25': oP25, 'p75': oP75, 'e25': e25, 'e75': e75, 'status': status})
    print(f'{bname:>6} | {oP25:>8} | {nP25:>8} | {e25:>+5}% | {oP75:>8} | {nP75:>8} | {e75:>+5}% | {status}')

print(f'\nFLOP summary: Good {good} | Fair {fair} | Poor {poor}')

# Save
with open('scripts/flop_validation_results.json', 'w') as f:
    json.dump({'flop_zones': len(flop_zones), 'active': m, 'scenarios': ok, 'results': results}, f, indent=2)
