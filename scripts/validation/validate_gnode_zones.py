#!/usr/bin/env python3
"""Validate using Gnode-level zones (303 zones) vs NESO boundary flows."""
import json, numpy as np, sys, io, time
from scipy.sparse import lil_matrix
from scipy.sparse.linalg import splu
from collections import defaultdict, deque

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

def load(p):
    with open(p) as f: return json.load(f)

sub_network = load('docs/substation/substation_network.json')
sub_injections = load('docs/substation/substation_injections.json')
sub_zone_map = load('public/data/substation_zone_mapping.json')
gnode_map = load('scripts/network_to_gnode.json')
boundary_mapping = load('public/data/boundary_link_mapping.json')
etys_caps = load('public/data/etys_capabilities.json')
validation_data = load('scripts/winter_validation_data.json')

YEAR = 2024; NUCLEAR_AVAIL = 0.80; IC_PCT = 65; SCENARIO = 'Holistic Transition'

nodes = sub_network['node_ids']
branches = sub_network['branches']
node_to_idx = {n: i for i, n in enumerate(nodes)}
sub_to_gnode = gnode_map['sub_to_gnode']
sub_to_tnuos = {code: data['zone'] for code, data in sub_zone_map['substations'].items()}

# Build Gnode-level network
gnode_zones = sorted(set(v for v in sub_to_gnode.values() if v != 'UNKNOWN'))
n_gz = len(gnode_zones)
gz_to_idx = {z: i for i, z in enumerate(gnode_zones)}

B = lil_matrix((n_gz, n_gz))
branch_data = []

for br in branches:
    gz1 = sub_to_gnode.get(br['sub1'])
    gz2 = sub_to_gnode.get(br['sub2'])
    if not gz1 or not gz2 or gz1 == 'UNKNOWN' or gz2 == 'UNKNOWN': continue
    if gz1 == gz2: continue
    fi, fj = gz_to_idx.get(gz1), gz_to_idx.get(gz2)
    if fi is None or fj is None: continue
    x_pu = br['x_pct'] / 100.0
    if x_pu <= 0: continue
    b = 1.0 / x_pu
    B[fi, fj] -= b; B[fj, fi] -= b
    B[fi, fi] += b; B[fj, fj] += b
    branch_data.append((fi, fj, b, br['sub1'], br['sub2'], gz1, gz2))

# Connected component
adj = defaultdict(set)
for fi, fj, *_ in branch_data:
    adj[fi].add(fj); adj[fj].add(fi)
visited = set(); queue = deque([0]); visited.add(0)
while queue:
    cur = queue.popleft()
    for nb in adj[cur]:
        if nb not in visited: visited.add(nb); queue.append(nb)

active = sorted(visited)
active_set = set(active)
active_map = {old: new for new, old in enumerate(active)}
m = len(active)

B_act = lil_matrix((m, m))
act_branches = []
for fi, fj, b, s1, s2, gz1, gz2 in branch_data:
    if fi not in active_set or fj not in active_set: continue
    ai, aj = active_map[fi], active_map[fj]
    B_act[ai, aj] -= b; B_act[aj, ai] -= b
    B_act[ai, ai] += b; B_act[aj, aj] += b
    act_branches.append((ai, aj, b, s1, s2, gz1, gz2))

# Slack: GZ18 area
slack_candidates = []
for code, gz in sub_to_gnode.items():
    tnuos = sub_to_tnuos.get(code)
    if tnuos == 'GZ18' and gz != 'UNKNOWN':
        fi = gz_to_idx.get(gz)
        if fi is not None and fi in active_set:
            slack_candidates.append(active_map[fi])
slack = max(set(slack_candidates), key=lambda x: len(adj.get(x, set()))) if slack_candidates else 0

mask = [i for i in range(m) if i != slack]
B_red = B_act.tocsc()[np.ix_(mask, mask)].tocsc()
lu = splu(B_red)

print(f'Gnode model: {m} active zones, {len(act_branches)} branches')

# Boundary crossings
boundary_crossings = {}
for bname, bdata in boundary_mapping.get('boundary_links', {}).items():
    north_tnuos = set(bdata.get('north_zones', []))
    south_tnuos = set(bdata.get('south_zones', []))
    if not bdata.get('crossing_links'): continue

    north_gz = set()
    south_gz = set()
    for code, gz in sub_to_gnode.items():
        tnuos = sub_to_tnuos.get(code)
        if tnuos in north_tnuos: north_gz.add(gz)
        elif tnuos in south_tnuos: south_gz.add(gz)

    crossings = []
    for bi, (ai, aj, b, s1, s2, gz1, gz2) in enumerate(act_branches):
        if gz1 in north_gz and gz2 in south_gz: crossings.append((bi, 1))
        elif gz1 in south_gz and gz2 in north_gz: crossings.append((bi, -1))

    if crossings:
        boundary_crossings[bname] = crossings

print(f'Boundaries mapped: {len(boundary_crossings)}')

# Generation and demand data
sub_gen = sub_injections.get('generation_by_substation', {})
sub_dem = sub_injections.get('demand_by_substation', {})
total_dem = sum(sub_dem.values())
sub_dem_shares = {k: v / total_dem for k, v in sub_dem.items()}

# Run validation
records = validation_data['records'][:2000]
print(f'Running {len(records)} scenarios...')

flow_samples = defaultdict(list)
t0 = time.time()
ok = 0

for ri, record in enumerate(records):
    if ri % 500 == 0 and ri > 0:
        print(f'  {ri}/{len(records)} ({ri/(time.time()-t0):.0f}/s)')
    try:
        P = np.zeros(m)

        for sub_code, gen_types in sub_gen.items():
            gz = sub_to_gnode.get(sub_code)
            if not gz or gz == 'UNKNOWN': continue
            fi = gz_to_idx.get(gz)
            if fi is None or fi not in active_set: continue
            ai = active_map[fi]
            tnuos = sub_to_tnuos.get(sub_code)
            total = 0
            for pt, mw in gen_types.items():
                if 'Interconnector' in pt: total += mw * IC_PCT / 100
                elif 'Wind' in pt: total += mw * record['wind_cf'].get(tnuos, 0)
                elif 'Solar' in pt or 'PV' in pt: total += mw * record['solar_cf'].get(tnuos, 0)
                elif 'Nuclear' in pt: total += mw * NUCLEAR_AVAIL
                elif any(x in pt for x in ['Demand', 'Reactive', 'Substation']): continue
                else: total += mw
            P[ai] += total / 100.0

        for sub_code, share in sub_dem_shares.items():
            gz = sub_to_gnode.get(sub_code)
            if not gz or gz == 'UNKNOWN': continue
            fi = gz_to_idx.get(gz)
            if fi is None or fi not in active_set: continue
            ai = active_map[fi]
            P[ai] -= record['tsd_mw'] * share / 100.0

        P_red = P[mask]
        theta = np.zeros(m)
        theta_red = lu.solve(P_red)
        for idx, full_idx in enumerate(mask):
            theta[full_idx] = theta_red[idx]

        branch_flows = np.zeros(len(act_branches))
        for bi, (ai, aj, b, *_) in enumerate(act_branches):
            branch_flows[bi] = (theta[ai] - theta[aj]) * b * 100.0

        for bname, crossings in boundary_crossings.items():
            total = sum(branch_flows[bi] * d for bi, d in crossings)
            flow_samples[bname].append(total)

        ok += 1
    except: pass

print(f'Done: {ok}/{len(records)} in {time.time()-t0:.1f}s')

def pctile(arr, p):
    s = sorted(arr)
    idx = (p/100) * (len(s)-1)
    lo, hi = int(idx), min(int(idx)+1, len(s)-1)
    return s[lo] + (s[hi]-s[lo]) * (idx-lo)

boundaries = ['B6F', 'B7aF', 'B9', 'SW1', 'B1aF', 'B2F', 'B3', 'B4F', 'B5', 'SC2']
print(f'\n=== GNODE 303-ZONE MODEL vs NESO ===')
print(f'{"Bound":>6} | {"p25":>8} | {"NESO":>8} | {"Err":>6} | {"p75":>8} | {"NESO":>8} | {"Err":>6} | St')
print('-'*75)

good = fair = poor = 0
for bname in boundaries:
    samples = flow_samples.get(bname)
    if not samples or len(samples) < 10: print(f'{bname:>6} | NO DATA'); continue
    cap = etys_caps.get('boundaries',{}).get(bname,{}).get('fes24',{}).get(SCENARIO,{})
    nP25 = cap.get('25pc',{}).get(str(YEAR))
    nP75 = cap.get('75pc',{}).get(str(YEAR))
    if nP25 is None or nP75 is None: continue
    oP25 = round(pctile(samples, 25)); oP75 = round(pctile(samples, 75))
    e25 = round((oP25-nP25)/max(abs(nP25),1)*100)
    e75 = round((oP75-nP75)/max(abs(nP75),1)*100)
    if abs(e25)<=30 and abs(e75)<=30: st='GOOD'; good+=1
    elif abs(e25)<=50 or abs(e75)<=50: st='FAIR'; fair+=1
    else: st='POOR'; poor+=1
    print(f'{bname:>6} | {oP25:>8} | {nP25:>8} | {e25:>+5}% | {oP75:>8} | {nP75:>8} | {e75:>+5}% | {st}')

print(f'\nGnode summary: Good {good} | Fair {fair} | Poor {poor}')
