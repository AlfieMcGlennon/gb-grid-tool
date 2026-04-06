#!/usr/bin/env python3
"""
Validate NESO's exact 28-zone model against published boundary flows.
Two approaches:
  1. DC Power Flow (our method — impedance-based flow distribution)
  2. NESO-style (boundary limits only — unconstrained dispatch, no impedances)
Both on: all 70k winter hours + 2013 only
"""
import json, numpy as np, sys, io, time
from scipy.sparse import lil_matrix
from scipy.sparse.linalg import splu
from collections import defaultdict, deque

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

def load(p):
    with open(p) as f: return json.load(f)

# Load data
model = load('scripts/neso28_model.json')
sub_injections = load('docs/substation/substation_injections.json')
sub_zone_map = load('public/data/substation_zone_mapping.json')
boundary_mapping = load('public/data/boundary_link_mapping.json')
etys_caps = load('public/data/etys_capabilities.json')
validation_data = load('scripts/winter_validation_data.json')
sub_network = load('docs/substation/substation_network.json')

NA = 0.80; IC = 65; YEAR = 2024; SC = 'Holistic Transition'
SLACK = 'Z21'  # NESO's slack bus

sub_to_neso28 = model['sub_to_neso28']
sub_to_tnuos = {c: d['zone'] for c, d in sub_zone_map['substations'].items()}
links_28 = model['links']
neso_zones = sorted(model['zone_definitions'].keys())

# Sub generation and demand
sub_gen = sub_injections.get('generation_by_substation', {})
sub_dem = sub_injections.get('demand_by_substation', {})
total_sub_dem = sum(sub_dem.values())
sub_dem_shares = {k: v / total_sub_dem for k, v in sub_dem.items()}

# Build boundary crossings from substation-level branches
branches = sub_network['branches']
node_to_idx = {n: i for i, n in enumerate(sub_network['node_ids'])}

# Rebuild branch data at NESO 28-zone level
n28 = len(neso_zones)
zi = {z: i for i, z in enumerate(neso_zones)}

branch_data_28 = []
for br in branches:
    z1 = sub_to_neso28.get(br['sub1'])
    z2 = sub_to_neso28.get(br['sub2'])
    if not z1 or not z2 or z1 == 'UNKNOWN' or z2 == 'UNKNOWN' or z1 == z2: continue
    fi, fj = zi.get(z1), zi.get(z2)
    if fi is None or fj is None: continue
    x_pu = br['x_pct'] / 100.0
    if x_pu <= 0: continue
    b = 1.0 / x_pu
    branch_data_28.append((fi, fj, b, br['sub1'], br['sub2'], z1, z2))

# Build B matrix and LU factorize
B28 = lil_matrix((n28, n28))
for fi, fj, b, *_ in branch_data_28:
    B28[fi,fj] -= b; B28[fj,fi] -= b; B28[fi,fi] += b; B28[fj,fj] += b

slack_idx = zi[SLACK]
mask = [i for i in range(n28) if i != slack_idx]
B_red = B28.tocsc()[np.ix_(mask, mask)].tocsc()
lu = splu(B_red)

# Boundary crossings
bc = {}
for bname, bdata in boundary_mapping.get('boundary_links', {}).items():
    north_tnuos = set(bdata.get('north_zones', []))
    south_tnuos = set(bdata.get('south_zones', []))
    if not bdata.get('crossing_links'): continue
    north_neso = set()
    south_neso = set()
    for sub, neso in sub_to_neso28.items():
        if neso == 'UNKNOWN': continue
        tnuos = sub_to_tnuos.get(sub)
        if tnuos in north_tnuos: north_neso.add(neso)
        elif tnuos in south_tnuos: south_neso.add(neso)
    cx = []
    for bi, (fi, fj, b, s1, s2, z1, z2) in enumerate(branch_data_28):
        if z1 in north_neso and z2 in south_neso: cx.append((bi, 1))
        elif z1 in south_neso and z2 in north_neso: cx.append((bi, -1))
    if cx: bc[bname] = cx

print(f'NESO 28-zone model: {n28} zones, {len(branch_data_28)} branches, {len(bc)} boundaries')
print(f'Slack bus: {SLACK}')

# Split records by year
records = validation_data['records']
records_2013 = [r for r in records if r['ts'].startswith('2012-1') or r['ts'].startswith('2013')]
print(f'All records: {len(records)}, 2013: {len(records_2013)}')

def run_dcpf(recs, label):
    """Run DC power flow on NESO 28 zones."""
    fs = defaultdict(list)
    ok = 0
    for r in recs:
        try:
            P = np.zeros(n28)
            for sc, gt in sub_gen.items():
                neso = sub_to_neso28.get(sc)
                if not neso or neso == 'UNKNOWN': continue
                fi = zi.get(neso)
                if fi is None: continue
                tnuos = sub_to_tnuos.get(sc)
                tot = 0
                for pt, mw in gt.items():
                    if 'Interconnector' in pt: tot += mw * IC / 100
                    elif 'Wind' in pt: tot += mw * r['wind_cf'].get(tnuos, 0)
                    elif 'Solar' in pt or 'PV' in pt: tot += mw * r['solar_cf'].get(tnuos, 0)
                    elif 'Nuclear' in pt: tot += mw * NA
                    elif any(x in pt for x in ['Demand', 'Reactive', 'Substation']): continue
                    else: tot += mw
                P[fi] += tot / 100.0

            for sc, sh in sub_dem_shares.items():
                neso = sub_to_neso28.get(sc)
                if not neso or neso == 'UNKNOWN': continue
                fi = zi.get(neso)
                if fi is None: continue
                P[fi] -= r['tsd_mw'] * sh / 100.0

            P_red = P[mask]
            theta = np.zeros(n28)
            theta_red = lu.solve(P_red)
            for i, full_i in enumerate(mask): theta[full_i] = theta_red[i]

            bf = np.zeros(len(branch_data_28))
            for bi, (fi, fj, b, *_) in enumerate(branch_data_28):
                bf[bi] = (theta[fi] - theta[fj]) * b * 100.0

            for bname, cx in bc.items():
                fs[bname].append(sum(bf[bi] * d for bi, d in cx))
            ok += 1
        except: pass
    return fs, ok

def run_neso_style(recs, label):
    """NESO-style: just compute net injection per zone.
    Boundary flow = total net injection on one side.
    No impedances — this is how NESO's Plexos works."""
    fs = defaultdict(list)
    ok = 0

    # Build: for each boundary, which NESO zones are on the north side?
    boundary_north_zones = {}
    for bname, bdata in boundary_mapping.get('boundary_links', {}).items():
        north_tnuos = set(bdata.get('north_zones', []))
        if not bdata.get('crossing_links'): continue
        north_neso = set()
        for sub, neso in sub_to_neso28.items():
            if neso == 'UNKNOWN': continue
            tnuos = sub_to_tnuos.get(sub)
            if tnuos in north_tnuos: north_neso.add(neso)
        if north_neso:
            boundary_north_zones[bname] = north_neso

    for r in recs:
        try:
            # Compute net injection per zone
            zone_inj = defaultdict(float)

            for sc, gt in sub_gen.items():
                neso = sub_to_neso28.get(sc)
                if not neso or neso == 'UNKNOWN': continue
                tnuos = sub_to_tnuos.get(sc)
                for pt, mw in gt.items():
                    if 'Interconnector' in pt: zone_inj[neso] += mw * IC / 100
                    elif 'Wind' in pt: zone_inj[neso] += mw * r['wind_cf'].get(tnuos, 0)
                    elif 'Solar' in pt or 'PV' in pt: zone_inj[neso] += mw * r['solar_cf'].get(tnuos, 0)
                    elif 'Nuclear' in pt: zone_inj[neso] += mw * NA
                    elif any(x in pt for x in ['Demand', 'Reactive', 'Substation']): continue
                    else: zone_inj[neso] += mw

            for sc, sh in sub_dem_shares.items():
                neso = sub_to_neso28.get(sc)
                if not neso or neso == 'UNKNOWN': continue
                zone_inj[neso] -= r['tsd_mw'] * sh

            # For each boundary: flow = sum of net injections on north side
            # (everything generated north minus consumed north must flow south)
            for bname, north_zones in boundary_north_zones.items():
                flow = sum(zone_inj.get(z, 0) for z in north_zones)
                fs[bname].append(flow)
            ok += 1
        except: pass
    return fs, ok

def pctile(arr, p):
    s = sorted(arr); idx = (p/100)*(len(s)-1); lo = int(idx); hi = min(lo+1, len(s)-1)
    return s[lo] + (s[hi]-s[lo]) * (idx-lo)

boundaries = ['B6F', 'B7aF', 'B9', 'SW1', 'B1aF', 'B2F', 'B3', 'B4F', 'B5', 'SC2']

def print_results(label, fs, ok):
    print(f'\n=== {label} ({ok} scenarios) ===')
    print(f'{"B":>6}|{"p25":>8}|{"NESO":>8}|{"Err":>7}|{"p75":>8}|{"NESO":>8}|{"Err":>7}|St')
    print('-' * 65)
    g = f = p = 0; results = []
    for bn in boundaries:
        s = fs.get(bn)
        if not s or len(s) < 10: continue
        cp = etys_caps.get('boundaries',{}).get(bn,{}).get('fes24',{}).get(SC,{})
        n25 = cp.get('25pc',{}).get(str(YEAR)); n75 = cp.get('75pc',{}).get(str(YEAR))
        if n25 is None or n75 is None: continue
        o25 = round(pctile(s,25)); o75 = round(pctile(s,75))
        e25 = round((o25-n25)/max(abs(n25),1)*100); e75 = round((o75-n75)/max(abs(n75),1)*100)
        if abs(e25)<=30 and abs(e75)<=30: st='GOOD'; g+=1
        elif abs(e25)<=50 or abs(e75)<=50: st='FAIR'; f+=1
        else: st='POOR'; p+=1
        results.append((bn,o25,n25,e25,o75,n75,e75,st))
        print(f'{bn:>6}|{o25:>8}|{n25:>8}|{e25:>+6}%|{o75:>8}|{n75:>8}|{e75:>+6}%|{st}')
    print(f'Summary: Good {g} | Fair {f} | Poor {p}')
    mean_err = np.mean([abs(e75) for _,_,_,_,_,_,e75,_ in results]) if results else 0
    print(f'Mean |p75 error|: {mean_err:.1f}%')
    return results

# Run all 4 configurations
t0 = time.time()

fs1, ok1 = run_dcpf(records, 'NESO28 DC-PF all')
r1 = print_results('NESO 28-zone DC Power Flow, ALL years', fs1, ok1)

fs2, ok2 = run_dcpf(records_2013, 'NESO28 DC-PF 2013')
r2 = print_results('NESO 28-zone DC Power Flow, 2013 ONLY', fs2, ok2)

fs3, ok3 = run_neso_style(records, 'NESO28 LP-style all')
r3 = print_results('NESO 28-zone NESO-style (net injection), ALL years', fs3, ok3)

fs4, ok4 = run_neso_style(records_2013, 'NESO28 LP-style 2013')
r4 = print_results('NESO 28-zone NESO-style (net injection), 2013 ONLY', fs4, ok4)

elapsed = time.time() - t0
print(f'\nTotal time: {elapsed:.1f}s')

# Final summary
print(f'\n=== FINAL COMPARISON: B6F p75 ===')
for label, fs_data in [('NESO28 DCPF all', fs1), ('NESO28 DCPF 2013', fs2), ('NESO28 NetInj all', fs3), ('NESO28 NetInj 2013', fs4)]:
    s = fs_data.get('B6F', [])
    if len(s) < 10: continue
    o75 = round(pctile(s, 75))
    e75 = round((o75 - 7889) / 7889 * 100)
    o25 = round(pctile(s, 25))
    e25 = round((o25 - 1184) / 1184 * 100)
    print(f'  {label:<25}: p25={o25:>6} ({e25:>+4}%), p75={o75:>6} ({e75:>+4}%)')
