#!/usr/bin/env python3
"""
Build hybrid 137-zone model: FLOP zones split by TNUoS membership.
Every boundary has clean north/south separation.
Validate with DC power flow + net injection, 70k hours + 2013, dynamic IC.
"""
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
flop_official = load('scripts/network_to_flop_official.json')
boundary_mapping = load('public/data/boundary_link_mapping.json')
etys_caps = load('public/data/etys_capabilities.json')
validation_data = load('scripts/winter_validation_data.json')
ic_lookup = load('public/data/ic_lookup.json')

NA = 0.80; YEAR = 2024; SC = 'Holistic Transition'

sub_to_tnuos = {c: d['zone'] for c, d in sub_zone_map['substations'].items()}
sub_to_flop = flop_official['sub_to_flop']
nodes = sub_network['node_ids']
branches = sub_network['branches']
sub_gen = sub_injections.get('generation_by_substation', {})
sub_dem = sub_injections.get('demand_by_substation', {})
total_sub_dem = sum(sub_dem.values())
sub_dem_shares = {k: v / total_sub_dem for k, v in sub_dem.items()}

wind_cap_tnuos = defaultdict(float)
for sc, gt in sub_gen.items():
    tz = sub_to_tnuos.get(sc)
    if tz:
        for pt, mw in gt.items():
            if 'Wind' in pt: wind_cap_tnuos[tz] += mw

ic_wind_edges = ic_lookup['wind_bin_edges']
ic_dem_edges = ic_lookup['demand_bin_edges']
ic_grid = ic_lookup['lookup']
def get_dyn_ic(wcf, dem):
    wi = di = 0
    for i in range(len(ic_wind_edges)-1):
        if wcf >= ic_wind_edges[i] and wcf < ic_wind_edges[i+1]: wi = i; break
    for i in range(len(ic_dem_edges)-1):
        if dem >= ic_dem_edges[i] and dem < ic_dem_edges[i+1]: di = i; break
    for e in ic_grid:
        if e['wind_bin'] == wi and e['demand_bin'] == di: return max(0, e['ic_import_pct'])
    return 16

# ============================================================
# BUILD HYBRID ZONES: FLOP × TNUoS
# ============================================================
print('Building hybrid 137-zone model...')

# For each substation: hybrid zone = FLOP_TNUoS (e.g., S6_GZ10)
sub_to_hybrid = {}
for sub in nodes:
    flop = sub_to_flop.get(sub, 'UNKNOWN')
    tnuos = sub_to_tnuos.get(sub, 'UNKNOWN')
    if flop == 'UNKNOWN' or tnuos == 'UNKNOWN':
        sub_to_hybrid[sub] = 'UNKNOWN'
    else:
        sub_to_hybrid[sub] = f'{flop}_{tnuos}'

hybrid_zones = sorted(set(v for v in sub_to_hybrid.values() if v != 'UNKNOWN'))
nhz = len(hybrid_zones)
hzi = {z: i for i, z in enumerate(hybrid_zones)}

print(f'  Hybrid zones: {nhz}')

# Build admittance matrix
B_h = lil_matrix((nhz, nhz)); bd_h = []
for br in branches:
    z1 = sub_to_hybrid.get(br['sub1'])
    z2 = sub_to_hybrid.get(br['sub2'])
    if not z1 or not z2 or z1 == 'UNKNOWN' or z2 == 'UNKNOWN' or z1 == z2: continue
    fi, fj = hzi.get(z1), hzi.get(z2)
    if fi is None or fj is None: continue
    x = br['x_pct'] / 100
    if x <= 0: continue
    b = 1 / x
    B_h[fi,fj] -= b; B_h[fj,fi] -= b; B_h[fi,fi] += b; B_h[fj,fj] += b
    bd_h.append((fi, fj, b, br['sub1'], br['sub2'], z1, z2))

# Connected component
adj_h = defaultdict(set)
for fi,fj,*_ in bd_h: adj_h[fi].add(fj); adj_h[fj].add(fi)
vis = set(); q = deque([0]); vis.add(0)
while q:
    c = q.popleft()
    for n in adj_h[c]:
        if n not in vis: vis.add(n); q.append(n)
act_h = sorted(vis); aset_h = set(act_h); amap_h = {o: n for n, o in enumerate(act_h)}
mh = len(act_h)

Ba_h = lil_matrix((mh, mh)); ab_h = []
for fi,fj,b,s1,s2,z1,z2 in bd_h:
    if fi not in aset_h or fj not in aset_h: continue
    ai, aj = amap_h[fi], amap_h[fj]
    Ba_h[ai,aj] -= b; Ba_h[aj,ai] -= b; Ba_h[ai,ai] += b; Ba_h[aj,aj] += b
    ab_h.append((ai, aj, b, s1, s2, z1, z2))

# Slack: R5_GZ15 or similar NW England zone
sl_cands = []
for c in nodes:
    tz = sub_to_tnuos.get(c); hz = sub_to_hybrid.get(c)
    if hz and hz != 'UNKNOWN' and tz in ('GZ14', 'GZ15') and 'R' in hz:
        fi = hzi.get(hz)
        if fi is not None and fi in aset_h: sl_cands.append(amap_h[fi])
if not sl_cands:
    for c in nodes:
        hz = sub_to_hybrid.get(c)
        if hz and hz != 'UNKNOWN' and 'GZ18' in hz:
            fi = hzi.get(hz)
            if fi is not None and fi in aset_h: sl_cands.append(amap_h[fi])
sl_h = max(set(sl_cands), key=lambda x: len(adj_h.get(x, set()))) if sl_cands else 0

mask_h = [i for i in range(mh) if i != sl_h]
Br_h = Ba_h.tocsc()[np.ix_(mask_h, mask_h)].tocsc()
lu_h = splu(Br_h)

print(f'  Active: {mh} zones, {len(ab_h)} branches')
print(f'  Slack: zone index {sl_h}')

# Boundary crossings — now CLEAN because each hybrid zone is in exactly one TNUoS zone
bc_h = {}
bn_north_h = {}
for bname, bdata in boundary_mapping.get('boundary_links', {}).items():
    ntz = set(bdata.get('north_zones', []))
    stz = set(bdata.get('south_zones', []))
    if not bdata.get('crossing_links'): continue

    # Each hybrid zone's TNUoS component determines which side it's on
    north_hz = set()
    south_hz = set()
    for hz in hybrid_zones:
        parts = hz.rsplit('_', 1)
        if len(parts) == 2:
            tnuos_part = parts[1]
            if tnuos_part in ntz: north_hz.add(hz)
            elif tnuos_part in stz: south_hz.add(hz)

    # Verify: should be NO overlap
    overlap = north_hz & south_hz
    if overlap:
        print(f'  WARNING: {bname} has overlap: {overlap}')

    cx = []
    for bi, (ai, aj, b, s1, s2, z1, z2) in enumerate(ab_h):
        if z1 in north_hz and z2 in south_hz: cx.append((bi, 1))
        elif z1 in south_hz and z2 in north_hz: cx.append((bi, -1))
    if cx: bc_h[bname] = cx
    if north_hz: bn_north_h[bname] = north_hz

print(f'  Boundaries (DCPF): {len(bc_h)}')
print(f'  Boundaries (NetInj): {len(bn_north_h)}')

# Verify clean separation
clean_count = 0
for bname in bc_h:
    bdata = boundary_mapping['boundary_links'].get(bname, {})
    ntz = set(bdata.get('north_zones', []))
    stz = set(bdata.get('south_zones', []))
    north_hz = set(); south_hz = set()
    for hz in hybrid_zones:
        parts = hz.rsplit('_', 1)
        if len(parts) == 2:
            if parts[1] in ntz: north_hz.add(hz)
            elif parts[1] in stz: south_hz.add(hz)
    if not (north_hz & south_hz):
        clean_count += 1

print(f'  Clean boundaries (zero overlap): {clean_count}/{len(bc_h)}')

# ============================================================
# VALIDATION
# ============================================================
records = validation_data['records']
records_2013 = [r for r in records if r['ts'].startswith('2012-1') or r['ts'].startswith('2013')]
print(f'\nRecords: all={len(records)}, 2013={len(records_2013)}')

boundaries = ['B6F', 'B7aF', 'B9', 'SW1', 'B1aF', 'B2F', 'B3', 'B4F', 'B5', 'SC2']

def pctile(arr, p):
    s = sorted(arr); idx = (p/100)*(len(s)-1); lo = int(idx); hi = min(lo+1, len(s)-1)
    return s[lo] + (s[hi]-s[lo]) * (idx-lo)

def run_hybrid(recs, label):
    fs_dcpf = defaultdict(list)
    fs_netinj = defaultdict(list)
    ok = 0; t0 = time.time()

    for ri, r in enumerate(recs):
        if ri % 10000 == 0 and ri > 0:
            print(f'  {ri}/{len(recs)} ({ri/(time.time()-t0):.0f}/s)')
        try:
            wcf = 0; wc = 0
            for tz, cap in wind_cap_tnuos.items():
                wcf += cap * r['wind_cf'].get(tz, 0); wc += cap
            nat_wcf = wcf / wc if wc > 0 else 0.25
            ic_pct = get_dyn_ic(nat_wcf, r['tsd_mw'])

            P = np.zeros(mh)
            zinj = defaultdict(float)

            for sc, gt in sub_gen.items():
                hz = sub_to_hybrid.get(sc)
                if not hz or hz == 'UNKNOWN': continue
                fi = hzi.get(hz)
                if fi is None or fi not in aset_h: continue
                ai = amap_h[fi]; tz = sub_to_tnuos.get(sc); tot = 0
                for pt, mw in gt.items():
                    if 'Interconnector' in pt: tot += mw * ic_pct / 100
                    elif 'Wind' in pt: tot += mw * r['wind_cf'].get(tz, 0)
                    elif 'Solar' in pt or 'PV' in pt: tot += mw * r['solar_cf'].get(tz, 0)
                    elif 'Nuclear' in pt: tot += mw * NA
                    elif any(x in pt for x in ['Demand', 'Reactive', 'Substation']): continue
                    else: tot += mw
                P[ai] += tot / 100.0
                zinj[hz] += tot

            for sc, sh in sub_dem_shares.items():
                hz = sub_to_hybrid.get(sc)
                if not hz or hz == 'UNKNOWN': continue
                fi = hzi.get(hz)
                if fi is None or fi not in aset_h: continue
                dem = r['tsd_mw'] * sh
                P[amap_h[fi]] -= dem / 100.0
                zinj[hz] -= dem

            # DCPF
            Pr = P[mask_h]; th = np.zeros(mh); tr = lu_h.solve(Pr)
            for i, fi in enumerate(mask_h): th[fi] = tr[i]
            bf = np.zeros(len(ab_h))
            for bi, (ai, aj, b, *_) in enumerate(ab_h):
                bf[bi] = (th[ai] - th[aj]) * b * 100.0
            for bname, cx in bc_h.items():
                fs_dcpf[bname].append(sum(bf[bi] * d for bi, d in cx))

            # Net injection
            for bname, nhz in bn_north_h.items():
                fs_netinj[bname].append(sum(zinj.get(z, 0) for z in nhz))

            ok += 1
        except: pass

    elapsed = time.time() - t0
    print(f'  {label}: {ok}/{len(recs)} in {elapsed:.1f}s ({ok/elapsed:.0f}/s)')
    return fs_dcpf, fs_netinj, ok

def print_results(label, fs, ok):
    print(f'\n=== {label} ({ok} scenarios) ===')
    print(f'{"B":>6}|{"p25":>8}|{"NESO":>8}|{"Err":>7}|{"p75":>8}|{"NESO":>8}|{"Err":>7}|St')
    print('-' * 65)
    g = f = p = 0; errs = []
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
        errs.append(abs(e75))
        print(f'{bn:>6}|{o25:>8}|{n25:>8}|{e25:>+6}%|{o75:>8}|{n75:>8}|{e75:>+6}%|{st}')
    mean_err = np.mean(errs) if errs else 999
    print(f'Summary: Good {g} | Fair {f} | Poor {p} | Mean |p75 err|: {mean_err:.1f}%')

# Run all 4 configs
print('\n' + '='*80)
print('HYBRID 137-ZONE VALIDATION')
print('='*80)

dcpf_all, ni_all, ok1 = run_hybrid(records, 'Hybrid all years')
print_results('Hybrid 137-zone DCPF, Dynamic IC, ALL years', dcpf_all, ok1)
print_results('Hybrid 137-zone NetInj, Dynamic IC, ALL years', ni_all, ok1)

dcpf_13, ni_13, ok2 = run_hybrid(records_2013, 'Hybrid 2013')
print_results('Hybrid 137-zone DCPF, Dynamic IC, 2013 ONLY', dcpf_13, ok2)
print_results('Hybrid 137-zone NetInj, Dynamic IC, 2013 ONLY', ni_13, ok2)

# Save the model
output = {
    'hybrid_zones': hybrid_zones,
    'sub_to_hybrid': sub_to_hybrid,
    'n_zones': nhz,
    'n_active': mh,
    'method': 'FLOP zones split by TNUoS membership for clean boundary separation'
}
with open('scripts/hybrid_137_model.json', 'w') as f:
    json.dump(output, f, indent=2)
print(f'\nSaved model to scripts/hybrid_137_model.json')
