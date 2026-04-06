#!/usr/bin/env python3
"""
Comprehensive validation: 4 resolutions × 2 time periods (all years + 2013 only)
Uses corrected demand (seasonal percentiles directly from demand_climatology).
"""
import json, numpy as np, sys, io, time
from scipy.sparse import lil_matrix
from scipy.sparse.linalg import splu
from collections import defaultdict, deque

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

def load(p):
    with open(p) as f: return json.load(f)

# Load all data
zones_tnuos = load('public/data/zones_tnuos.json')
links24 = load('public/data/links_tnuos_by_year.json').get('2024', [])
boundary_mapping = load('public/data/boundary_link_mapping.json')
etys_caps = load('public/data/etys_capabilities.json')
plants = load('public/data/plants_tnuos.json')
sub_network = load('docs/substation/substation_network.json')
sub_injections = load('docs/substation/substation_injections.json')
sub_zone_map = load('public/data/substation_zone_mapping.json')
flop_official = load('scripts/network_to_flop_official.json')
validation_data = load('scripts/winter_validation_data.json')

NA = 0.80; IC = 65; YEAR = 2024; SC = 'Holistic Transition'

sub_to_tnuos = {c: d['zone'] for c, d in sub_zone_map['substations'].items()}
sub_to_flop = flop_official['sub_to_flop']

# Zone capacities for 27-node
zone_cap = defaultdict(lambda: defaultdict(float))
for p in plants:
    if not p.get('zone_id') or not p.get('plant_type') or p.get('status') != 'Built' or p.get('mw_connected', 0) <= 0: continue
    pt = p['plant_type']
    if any(x in pt for x in ['Demand', 'Reactive', 'Substation']): continue
    zone_cap[p['zone_id']][pt] += p['mw_connected']

# Zone demand shares from demand_climatology (use mean as share basis)
dem_clim = load('public/data/demand_climatology.json')
zone_dem_mean = {}
total_dem_mean = 0
for z, zdata in (dem_clim.get('zones') or {}).items():
    m = zdata.get('seasonal', {}).get('winter', {}).get('mean', 0)
    zone_dem_mean[z] = m
    total_dem_mean += m
zone_dem_shares = {z: m / total_dem_mean for z, m in zone_dem_mean.items()} if total_dem_mean > 0 else {}

# Sub generation and demand
sub_gen = sub_injections.get('generation_by_substation', {})
sub_dem = sub_injections.get('demand_by_substation', {})
total_sub_dem = sum(sub_dem.values())
sub_dem_shares = {k: v / total_sub_dem for k, v in sub_dem.items()}

nodes = sub_network['node_ids']
branches = sub_network['branches']
node_to_idx = {n: i for i, n in enumerate(nodes)}

# ============================================================
# 27-NODE MODEL
# ============================================================
def solve_27(injections):
    zones = sorted(injections.keys())
    n = len(zones); z2i = {z: i for i, z in enumerate(zones)}
    B = np.zeros((n, n))
    for l in links24:
        i, j = z2i.get(l['from']), z2i.get(l['to'])
        if i is None or j is None: continue
        b = 100 / l['x_equivalent']
        B[i,j] -= b; B[j,i] -= b; B[i,i] += b; B[j,j] += b
    P = np.array([injections[z] / 100 for z in zones])
    sl = z2i.get('GZ18', 0)
    mask = [i for i in range(n) if i != sl]
    try: theta_r = np.linalg.solve(B[np.ix_(mask, mask)], P[mask])
    except: return {}
    theta = np.zeros(n)
    for i, fi in enumerate(mask): theta[fi] = theta_r[i]
    flows = {}
    for l in links24:
        i, j = z2i.get(l['from']), z2i.get(l['to'])
        if i is None or j is None: continue
        flows[l['id']] = (theta[i] - theta[j]) * 100 / l['x_equivalent'] * 100
    return flows

def bf_27(flows):
    r = {}
    for bn, bd in boundary_mapping.get('boundary_links', {}).items():
        if not bd.get('crossing_links'): continue
        r[bn] = sum(flows.get(lid, 0) for lid in bd['crossing_links'])
    return r

# ============================================================
# SUBSTATION-LEVEL MODEL BUILDER
# ============================================================
def build_model(sub_to_zone_map):
    fzones = sorted(set(v for v in sub_to_zone_map.values() if v != 'UNKNOWN'))
    nfz = len(fzones); fzi = {z: i for i, z in enumerate(fzones)}
    B = lil_matrix((nfz, nfz)); bd = []
    for br in branches:
        z1, z2 = sub_to_zone_map.get(br['sub1']), sub_to_zone_map.get(br['sub2'])
        if not z1 or not z2 or z1 == 'UNKNOWN' or z2 == 'UNKNOWN' or z1 == z2: continue
        fi, fj = fzi.get(z1), fzi.get(z2)
        if fi is None or fj is None: continue
        x = br['x_pct'] / 100
        if x <= 0: continue
        b = 1 / x; B[fi,fj] -= b; B[fj,fi] -= b; B[fi,fi] += b; B[fj,fj] += b
        bd.append((fi, fj, b, br['sub1'], br['sub2'], z1, z2))

    adj = defaultdict(set)
    for fi, fj, *_ in bd: adj[fi].add(fj); adj[fj].add(fi)
    vis = set(); q = deque([0]); vis.add(0)
    while q:
        c = q.popleft()
        for n in adj[c]:
            if n not in vis: vis.add(n); q.append(n)
    act = sorted(vis); aset = set(act); amap = {o: n for n, o in enumerate(act)}; m = len(act)

    Ba = lil_matrix((m, m)); ab = []
    for fi, fj, b, s1, s2, z1, z2 in bd:
        if fi not in aset or fj not in aset: continue
        ai, aj = amap[fi], amap[fj]
        Ba[ai,aj] -= b; Ba[aj,ai] -= b; Ba[ai,ai] += b; Ba[aj,aj] += b
        ab.append((ai, aj, b, s1, s2, z1, z2))

    gz18 = set()
    for c in nodes:
        tz = sub_to_tnuos.get(c); fz = sub_to_zone_map.get(c)
        if tz == 'GZ18' and fz and fz != 'UNKNOWN':
            fi = fzi.get(fz)
            if fi is not None and fi in aset: gz18.add(amap[fi])
    sl = max(gz18, key=lambda x: len(adj.get(x, set()))) if gz18 else 0

    mask = [i for i in range(m) if i != sl]
    Br = Ba.tocsc()[np.ix_(mask, mask)].tocsc()
    lu = splu(Br)

    bc = {}
    for bn, bdata in boundary_mapping.get('boundary_links', {}).items():
        ntz = set(bdata.get('north_zones', [])); stz = set(bdata.get('south_zones', []))
        if not bdata.get('crossing_links'): continue
        nf = set(); sf = set()
        for c, fz in sub_to_zone_map.items():
            tz = sub_to_tnuos.get(c)
            if tz in ntz: nf.add(fz)
            elif tz in stz: sf.add(fz)
        cx = []
        for bi, (ai, aj, b, s1, s2, z1, z2) in enumerate(ab):
            if z1 in nf and z2 in sf: cx.append((bi, 1))
            elif z1 in sf and z2 in nf: cx.append((bi, -1))
        if cx: bc[bn] = cx

    return {'m': m, 'ab': ab, 'mask': mask, 'lu': lu, 'bc': bc, 'fzi': fzi, 'amap': amap, 'aset': aset}

# Build FLOP model
print('Building models...')
flop_model = build_model(sub_to_flop)
print(f'  FLOP: {flop_model["m"]} zones')

# ============================================================
# RUN VALIDATION
# ============================================================
records = validation_data['records']  # All 5000 subsampled

# Filter for 2013 calendar year (Oct 2012 - Mar 2013 + Oct 2013 - Mar 2014)
records_2013 = [r for r in records if r['ts'].startswith('2012-1') or r['ts'].startswith('2013')]

print(f'Total records: {len(records)}')
print(f'2013 records: {len(records_2013)}')

def run_27node(recs, label):
    fs = defaultdict(list)
    ok = 0
    for r in recs:
        try:
            inj = {}
            for z in zones_tnuos:
                gen = 0
                for pt, mw in zone_cap.get(z, {}).items():
                    if pt == 'Interconnector': gen += mw * IC / 100; continue
                    if 'Wind' in pt: gen += mw * r['wind_cf'].get(z, 0)
                    elif 'Solar' in pt or 'PV' in pt: gen += mw * r['solar_cf'].get(z, 0)
                    elif 'Nuclear' in pt: gen += mw * NA
                    else: gen += mw
                # Use real TSD demand distributed by zone shares
                dem = r['tsd_mw'] * zone_dem_shares.get(z, 0)
                inj[z] = gen - dem
            flows = solve_27(inj)
            bf = bf_27(flows)
            for bn in bf: fs[bn].append(bf[bn])
            ok += 1
        except: pass
    return fs, ok

def run_sub_model(recs, model, sub_zone_map_dict, label):
    fs = defaultdict(list)
    m = model['m']; ab = model['ab']; mask = model['mask']; lu = model['lu']
    bc = model['bc']; fzi = model['fzi']; amap = model['amap']; aset = model['aset']
    ok = 0
    for r in recs:
        try:
            P = np.zeros(m)
            for sc, gt in sub_gen.items():
                fz = sub_zone_map_dict.get(sc)
                if not fz or fz == 'UNKNOWN': continue
                fi = fzi.get(fz)
                if fi is None or fi not in aset: continue
                ai = amap[fi]; tz = sub_to_tnuos.get(sc); tot = 0
                for pt, mw in gt.items():
                    if 'Interconnector' in pt: tot += mw * IC / 100
                    elif 'Wind' in pt: tot += mw * r['wind_cf'].get(tz, 0)
                    elif 'Solar' in pt or 'PV' in pt: tot += mw * r['solar_cf'].get(tz, 0)
                    elif 'Nuclear' in pt: tot += mw * NA
                    elif any(x in pt for x in ['Demand', 'Reactive', 'Substation']): continue
                    else: tot += mw
                P[ai] += tot / 100
            for sc, sh in sub_dem_shares.items():
                fz = sub_zone_map_dict.get(sc)
                if not fz or fz == 'UNKNOWN': continue
                fi = fzi.get(fz)
                if fi is None or fi not in aset: continue
                P[amap[fi]] -= r['tsd_mw'] * sh / 100
            Pr = P[mask]; th = np.zeros(m); tr = lu.solve(Pr)
            for i, fi in enumerate(mask): th[fi] = tr[i]
            bf_arr = np.zeros(len(ab))
            for bi, (ai, aj, b, *_) in enumerate(ab): bf_arr[bi] = (th[ai] - th[aj]) * b * 100
            for bn, cx in bc.items():
                fs[bn].append(sum(bf_arr[bi] * d for bi, d in cx))
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
    g = f = p = 0
    for bn in boundaries:
        s = fs.get(bn)
        if not s or len(s) < 10: continue
        cp = etys_caps.get('boundaries', {}).get(bn, {}).get('fes24', {}).get(SC, {})
        n25 = cp.get('25pc', {}).get(str(YEAR)); n75 = cp.get('75pc', {}).get(str(YEAR))
        if n25 is None or n75 is None: continue
        o25 = round(pctile(s, 25)); o75 = round(pctile(s, 75))
        e25 = round((o25-n25)/max(abs(n25),1)*100); e75 = round((o75-n75)/max(abs(n75),1)*100)
        if abs(e25)<=30 and abs(e75)<=30: st='GOOD'; g+=1
        elif abs(e25)<=50 or abs(e75)<=50: st='FAIR'; f+=1
        else: st='POOR'; p+=1
        print(f'{bn:>6}|{o25:>8}|{n25:>8}|{e25:>+6}%|{o75:>8}|{n75:>8}|{e75:>+6}%|{st}')
    print(f'Summary: Good {g} | Fair {f} | Poor {p}')

# Run all combinations
t0 = time.time()

# 27-node: all years
fs, ok = run_27node(records, '27-zone all')
print_results('27-zone, all years, real NESO TSD', fs, ok)

# 27-node: 2013 only
fs13, ok13 = run_27node(records_2013, '27-zone 2013')
print_results('27-zone, 2013 ONLY, real NESO TSD', fs13, ok13)

# FLOP: all years
fs_f, ok_f = run_sub_model(records, flop_model, sub_to_flop, 'FLOP all')
print_results('84-zone FLOP, all years, real NESO TSD', fs_f, ok_f)

# FLOP: 2013 only
fs_f13, ok_f13 = run_sub_model(records_2013, flop_model, sub_to_flop, 'FLOP 2013')
print_results('84-zone FLOP, 2013 ONLY, real NESO TSD', fs_f13, ok_f13)

elapsed = time.time() - t0
print(f'\nTotal time: {elapsed:.1f}s')

# Summary comparison
print(f'\n=== SUMMARY: B6F p75 error across all configurations ===')
for label, fs_data in [('27-zone all yrs', fs), ('27-zone 2013', fs13), ('FLOP all yrs', fs_f), ('FLOP 2013', fs_f13)]:
    s = fs_data.get('B6F', [])
    if len(s) < 10: continue
    o75 = round(pctile(s, 75))
    e75 = round((o75 - 7889) / 7889 * 100)
    print(f'  {label:<20}: B6F p75 = {o75:>6} MW ({e75:>+4}%)')
