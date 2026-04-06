#!/usr/bin/env python3
"""
ROUND ROBIN: Every combination of resolution × method × IC × time period × MSL
Systematic comparison to find the best overall configuration.
"""
import json, numpy as np, sys, io, time
from scipy.sparse import lil_matrix
from scipy.sparse.linalg import splu
from collections import defaultdict, deque

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

def load(p):
    with open(p) as f: return json.load(f)

# Load all data
sub_network = load('docs/substation/substation_network.json')
sub_injections = load('docs/substation/substation_injections.json')
sub_zone_map = load('public/data/substation_zone_mapping.json')
flop_official = load('scripts/network_to_flop_official.json')
zones_tnuos = load('public/data/zones_tnuos.json')
links24 = load('public/data/links_tnuos_by_year.json').get('2024', [])
boundary_mapping = load('public/data/boundary_link_mapping.json')
etys_caps = load('public/data/etys_capabilities.json')
plants = load('public/data/plants_tnuos.json')
validation_data = load('scripts/winter_validation_data.json')
ic_lookup = load('public/data/ic_lookup.json')
dem_clim = load('public/data/demand_climatology.json')

NA = 0.80; YEAR = 2024; SC = 'Holistic Transition'
MSL_FACTORS = {'Nuclear': 0.50, 'CCGT': 0.50, 'CCGT (Combined Cycle Gas Turbine)': 0.50,
               'OCGT': 0.20, 'OCGT (Open Cycle Gas Turbine)': 0.20, 'Biomass': 0.40}

sub_to_tnuos = {c: d['zone'] for c, d in sub_zone_map['substations'].items()}
sub_to_flop = flop_official['sub_to_flop']
nodes = sub_network['node_ids']
branches = sub_network['branches']
sub_gen = sub_injections.get('generation_by_substation', {})
sub_dem = sub_injections.get('demand_by_substation', {})
total_sub_dem = sum(sub_dem.values())
sub_dem_shares = {k: v / total_sub_dem for k, v in sub_dem.items()}

# Zone capacities for 27-node
zone_cap = defaultdict(lambda: defaultdict(float))
for p in plants:
    if not p.get('zone_id') or not p.get('plant_type') or p.get('status') != 'Built' or p.get('mw_connected', 0) <= 0: continue
    pt = p['plant_type']
    if any(x in pt for x in ['Demand', 'Reactive', 'Substation']): continue
    zone_cap[p['zone_id']][pt] += p['mw_connected']

# Zone demand shares
zone_dem_mean = {}; total_dm = 0
for z, zd in (dem_clim.get('zones') or {}).items():
    m = zd.get('seasonal', {}).get('winter', {}).get('mean', 0)
    zone_dem_mean[z] = m; total_dm += m
zone_dem_shares = {z: m / total_dm for z, m in zone_dem_mean.items()} if total_dm > 0 else {}

# Wind capacity by TNUoS zone
wind_cap_tnuos = defaultdict(float)
for sc, gt in sub_gen.items():
    tz = sub_to_tnuos.get(sc)
    if tz:
        for pt, mw in gt.items():
            if 'Wind' in pt: wind_cap_tnuos[tz] += mw

# Dynamic IC
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
# BUILD FLOP MODEL
# ============================================================
fzones = sorted(set(v for v in sub_to_flop.values() if v != 'UNKNOWN'))
nfz = len(fzones); fzi = {z: i for i, z in enumerate(fzones)}
B_flop = lil_matrix((nfz, nfz)); bd_flop = []
for br in branches:
    z1, z2 = sub_to_flop.get(br['sub1']), sub_to_flop.get(br['sub2'])
    if not z1 or not z2 or z1 == 'UNKNOWN' or z2 == 'UNKNOWN' or z1 == z2: continue
    fi, fj = fzi.get(z1), fzi.get(z2)
    if fi is None or fj is None: continue
    x = br['x_pct'] / 100;
    if x <= 0: continue
    b = 1/x; B_flop[fi,fj] -= b; B_flop[fj,fi] -= b; B_flop[fi,fi] += b; B_flop[fj,fj] += b
    bd_flop.append((fi, fj, b, br['sub1'], br['sub2'], z1, z2))
adj_f = defaultdict(set)
for fi,fj,*_ in bd_flop: adj_f[fi].add(fj); adj_f[fj].add(fi)
vis=set();q=deque([0]);vis.add(0)
while q:
    c=q.popleft()
    for n in adj_f[c]:
        if n not in vis: vis.add(n); q.append(n)
act_f=sorted(vis);aset_f=set(act_f);amap_f={o:n for n,o in enumerate(act_f)};mf=len(act_f)
Ba_f=lil_matrix((mf,mf));ab_f=[]
for fi,fj,b,s1,s2,z1,z2 in bd_flop:
    if fi not in aset_f or fj not in aset_f: continue
    ai,aj=amap_f[fi],amap_f[fj]
    Ba_f[ai,aj]-=b;Ba_f[aj,ai]-=b;Ba_f[ai,ai]+=b;Ba_f[aj,aj]+=b
    ab_f.append((ai,aj,b,s1,s2,z1,z2))
sl_f_cands=[]
for c in nodes:
    tz=sub_to_tnuos.get(c);fz=sub_to_flop.get(c)
    if fz and fz!='UNKNOWN' and fz in ('R4','R5','R6'):
        fi=fzi.get(fz)
        if fi is not None and fi in aset_f: sl_f_cands.append(amap_f[fi])
sl_f=max(set(sl_f_cands),key=lambda x:len(adj_f.get(x,set()))) if sl_f_cands else 0
mask_f=[i for i in range(mf) if i!=sl_f]
lu_f=splu(Ba_f.tocsc()[np.ix_(mask_f,mask_f)].tocsc())

# FLOP boundary crossings
bc_f={}
bn_north_flop={}
for bname,bdata in boundary_mapping.get('boundary_links',{}).items():
    ntz=set(bdata.get('north_zones',[]));stz=set(bdata.get('south_zones',[]))
    if not bdata.get('crossing_links'): continue
    nf=set();sf=set()
    for c,fz in sub_to_flop.items():
        tz=sub_to_tnuos.get(c)
        if tz in ntz: nf.add(fz)
        elif tz in stz: sf.add(fz)
    cx=[]
    for bi,(ai,aj,b,s1,s2,z1,z2) in enumerate(ab_f):
        if z1 in nf and z2 in sf: cx.append((bi,1))
        elif z1 in sf and z2 in nf: cx.append((bi,-1))
    if cx: bc_f[bname]=cx
    if nf: bn_north_flop[bname]=nf

print(f'FLOP: {mf} zones, {len(ab_f)} branches')

# ============================================================
# RECORDS
# ============================================================
records = validation_data['records']
records_2013 = [r for r in records if r['ts'].startswith('2012-1') or r['ts'].startswith('2013')]
print(f'Records: all={len(records)}, 2013={len(records_2013)}')

boundaries = ['B6F','B7aF','B9','SW1','B1aF','B2F','B3','B4F','B5','SC2']

def pctile(arr,p):
    s=sorted(arr);idx=(p/100)*(len(s)-1);lo=int(idx);hi=min(lo+1,len(s)-1)
    return s[lo]+(s[hi]-s[lo])*(idx-lo)

def score(fs):
    g=f=p=0;errs=[]
    for bn in boundaries:
        s=fs.get(bn)
        if not s or len(s)<10: continue
        cp=etys_caps.get('boundaries',{}).get(bn,{}).get('fes24',{}).get(SC,{})
        n25=cp.get('25pc',{}).get(str(YEAR));n75=cp.get('75pc',{}).get(str(YEAR))
        if n25 is None or n75 is None: continue
        o25=round(pctile(s,25));o75=round(pctile(s,75))
        e25=round((o25-n25)/max(abs(n25),1)*100);e75=round((o75-n75)/max(abs(n75),1)*100)
        if abs(e25)<=30 and abs(e75)<=30: g+=1
        elif abs(e25)<=50 or abs(e75)<=50: f+=1
        else: p+=1
        errs.append(abs(e75))
    return g,f,p,np.mean(errs) if errs else 999

def get_per_boundary(fs):
    res={}
    for bn in boundaries:
        s=fs.get(bn)
        if not s or len(s)<10: continue
        cp=etys_caps.get('boundaries',{}).get(bn,{}).get('fes24',{}).get(SC,{})
        n25=cp.get('25pc',{}).get(str(YEAR));n75=cp.get('75pc',{}).get(str(YEAR))
        if n25 is None or n75 is None: continue
        o75=round(pctile(s,75));e75=round((o75-n75)/max(abs(n75),1)*100)
        res[bn]=e75
    return res

# ============================================================
# RUN ALL CONFIGURATIONS
# ============================================================
def run_27(recs, ic_mode):
    fs=defaultdict(list)
    for r in recs:
        try:
            wcf=0;wc=0
            for tz,cap in wind_cap_tnuos.items():
                wcf+=cap*r['wind_cf'].get(tz,0);wc+=cap
            nat_wcf=wcf/wc if wc>0 else 0.25
            ic_pct=get_dyn_ic(nat_wcf,r['tsd_mw']) if ic_mode=='dynamic' else 65

            inj={}
            for z in zones_tnuos:
                gen=0
                for pt,mw in zone_cap.get(z,{}).items():
                    if pt=='Interconnector': gen+=mw*ic_pct/100;continue
                    if 'Wind' in pt: gen+=mw*r['wind_cf'].get(z,0)
                    elif 'Solar' in pt or 'PV' in pt: gen+=mw*r['solar_cf'].get(z,0)
                    elif 'Nuclear' in pt: gen+=mw*NA
                    else: gen+=mw
                dem=r['tsd_mw']*zone_dem_shares.get(z,0)
                inj[z]=gen-dem

            zones_s=sorted(inj.keys());n=len(zones_s);z2i={z:i for i,z in enumerate(zones_s)}
            B27=np.zeros((n,n))
            for l in links24:
                i,j=z2i.get(l['from']),z2i.get(l['to'])
                if i is None or j is None: continue
                b=100/l['x_equivalent'];B27[i,j]-=b;B27[j,i]-=b;B27[i,i]+=b;B27[j,j]+=b
            P=np.array([inj[z]/100 for z in zones_s])
            sl=z2i.get('GZ18',0);mask27=[i for i in range(n) if i!=sl]
            theta_r=np.linalg.solve(B27[np.ix_(mask27,mask27)],P[mask27])
            theta=np.zeros(n)
            for i,fi in enumerate(mask27): theta[fi]=theta_r[i]
            flows={}
            for l in links24:
                i,j=z2i.get(l['from']),z2i.get(l['to'])
                if i is None or j is None: continue
                flows[l['id']]=(theta[i]-theta[j])*100/l['x_equivalent']*100
            for bn,bd in boundary_mapping.get('boundary_links',{}).items():
                if not bd.get('crossing_links'): continue
                fs[bn].append(sum(flows.get(lid,0) for lid in bd['crossing_links']))
        except: pass
    return fs

def run_27_netinj(recs, ic_mode):
    fs=defaultdict(list)
    bn_north_tnuos={}
    for bname,bdata in boundary_mapping.get('boundary_links',{}).items():
        ntz=set(bdata.get('north_zones',[]))
        if bdata.get('crossing_links') and ntz: bn_north_tnuos[bname]=ntz
    for r in recs:
        try:
            wcf=0;wc=0
            for tz,cap in wind_cap_tnuos.items():
                wcf+=cap*r['wind_cf'].get(tz,0);wc+=cap
            nat_wcf=wcf/wc if wc>0 else 0.25
            ic_pct=get_dyn_ic(nat_wcf,r['tsd_mw']) if ic_mode=='dynamic' else 65
            zinj={}
            for z in zones_tnuos:
                gen=0
                for pt,mw in zone_cap.get(z,{}).items():
                    if pt=='Interconnector': gen+=mw*ic_pct/100;continue
                    if 'Wind' in pt: gen+=mw*r['wind_cf'].get(z,0)
                    elif 'Solar' in pt or 'PV' in pt: gen+=mw*r['solar_cf'].get(z,0)
                    elif 'Nuclear' in pt: gen+=mw*NA
                    else: gen+=mw
                dem=r['tsd_mw']*zone_dem_shares.get(z,0)
                zinj[z]=gen-dem
            for bname,ntz in bn_north_tnuos.items():
                fs[bname].append(sum(zinj.get(z,0) for z in ntz))
        except: pass
    return fs

def run_flop_dcpf(recs, ic_mode):
    fs=defaultdict(list)
    for r in recs:
        try:
            wcf=0;wc=0
            for tz,cap in wind_cap_tnuos.items():
                wcf+=cap*r['wind_cf'].get(tz,0);wc+=cap
            nat_wcf=wcf/wc if wc>0 else 0.25
            ic_pct=get_dyn_ic(nat_wcf,r['tsd_mw']) if ic_mode=='dynamic' else 65
            P=np.zeros(mf)
            for sc,gt in sub_gen.items():
                fz=sub_to_flop.get(sc)
                if not fz or fz=='UNKNOWN': continue
                fi=fzi.get(fz)
                if fi is None or fi not in aset_f: continue
                ai=amap_f[fi];tz=sub_to_tnuos.get(sc);tot=0
                for pt,mw in gt.items():
                    if 'Interconnector' in pt: tot+=mw*ic_pct/100
                    elif 'Wind' in pt: tot+=mw*r['wind_cf'].get(tz,0)
                    elif 'Solar' in pt or 'PV' in pt: tot+=mw*r['solar_cf'].get(tz,0)
                    elif 'Nuclear' in pt: tot+=mw*NA
                    elif any(x in pt for x in ['Demand','Reactive','Substation']): continue
                    else: tot+=mw
                P[ai]+=tot/100
            for sc,sh in sub_dem_shares.items():
                fz=sub_to_flop.get(sc)
                if not fz or fz=='UNKNOWN': continue
                fi=fzi.get(fz)
                if fi is None or fi not in aset_f: continue
                P[amap_f[fi]]-=r['tsd_mw']*sh/100
            Pr=P[mask_f];th=np.zeros(mf);tr=lu_f.solve(Pr)
            for i,fi in enumerate(mask_f): th[fi]=tr[i]
            bf=np.zeros(len(ab_f))
            for bi,(ai,aj,b,*_) in enumerate(ab_f): bf[bi]=(th[ai]-th[aj])*b*100
            for bname,cx in bc_f.items():
                fs[bname].append(sum(bf[bi]*d for bi,d in cx))
        except: pass
    return fs

def run_flop_netinj(recs, ic_mode):
    fs=defaultdict(list)
    for r in recs:
        try:
            wcf=0;wc=0
            for tz,cap in wind_cap_tnuos.items():
                wcf+=cap*r['wind_cf'].get(tz,0);wc+=cap
            nat_wcf=wcf/wc if wc>0 else 0.25
            ic_pct=get_dyn_ic(nat_wcf,r['tsd_mw']) if ic_mode=='dynamic' else 65
            zinj=defaultdict(float)
            for sc,gt in sub_gen.items():
                fz=sub_to_flop.get(sc)
                if not fz or fz=='UNKNOWN': continue
                tz=sub_to_tnuos.get(sc)
                for pt,mw in gt.items():
                    if 'Interconnector' in pt: zinj[fz]+=mw*ic_pct/100
                    elif 'Wind' in pt: zinj[fz]+=mw*r['wind_cf'].get(tz,0)
                    elif 'Solar' in pt or 'PV' in pt: zinj[fz]+=mw*r['solar_cf'].get(tz,0)
                    elif 'Nuclear' in pt: zinj[fz]+=mw*NA
                    elif any(x in pt for x in ['Demand','Reactive','Substation']): continue
                    else: zinj[fz]+=mw
            for sc,sh in sub_dem_shares.items():
                fz=sub_to_flop.get(sc)
                if not fz or fz=='UNKNOWN': continue
                zinj[fz]-=r['tsd_mw']*sh
            for bname,nz in bn_north_flop.items():
                fs[bname].append(sum(zinj.get(z,0) for z in nz))
        except: pass
    return fs

# ============================================================
# RUN EVERYTHING
# ============================================================
configs = []
t0 = time.time()

for period_name, recs in [('All years', records), ('2013 only', records_2013)]:
    for ic_mode in ['65%', 'dynamic']:
        for res_name, run_dc, run_ni in [
            ('27-zone', run_27, run_27_netinj),
            ('84-FLOP', run_flop_dcpf, run_flop_netinj)
        ]:
            for method in ['DCPF', 'NetInj']:
                label = f'{res_name} {method} {ic_mode}IC {period_name}'
                print(f'Running: {label}...')
                if method == 'DCPF':
                    fs = run_dc(recs, 'dynamic' if ic_mode == 'dynamic' else '65')
                else:
                    fs = run_ni(recs, 'dynamic' if ic_mode == 'dynamic' else '65')
                g, f, p, mean_err = score(fs)
                per_b = get_per_boundary(fs)
                configs.append({
                    'label': label, 'g': g, 'f': f, 'p': p,
                    'mean_err': mean_err, 'per_boundary': per_b
                })

elapsed = time.time() - t0
print(f'\nTotal: {elapsed:.0f}s')

# ============================================================
# RESULTS TABLE
# ============================================================
# Sort by mean error
configs.sort(key=lambda c: c['mean_err'])

print(f'\n{"="*120}')
print(f'ROUND ROBIN RESULTS — SORTED BY MEAN |p75 ERROR|')
print(f'{"="*120}')
print(f'{"Rank":>4} | {"Configuration":<45} | {"G":>2} {"F":>2} {"P":>2} | {"Mean":>5} | {"B6F":>5} {"B7a":>5} {"B9":>5} {"SW1":>5} {"B1a":>5} {"B2F":>5} {"B3":>5} {"B4F":>5} {"B5":>5} {"SC2":>5}')
print('-' * 120)

for i, c in enumerate(configs):
    pb = c['per_boundary']
    vals = [pb.get(bn, '—') for bn in boundaries]
    val_strs = []
    for v in vals:
        if isinstance(v, (int, float)):
            val_strs.append(f'{v:>+4}%' if abs(v) < 1000 else f'{v//100:>+3}x')
        else:
            val_strs.append(f'{"—":>5}')

    print(f'{i+1:>4} | {c["label"]:<45} | {c["g"]:>2} {c["f"]:>2} {c["p"]:>2} | {c["mean_err"]:>4.0f}% | {" ".join(val_strs)}')

# Best per boundary
print(f'\n{"="*80}')
print(f'BEST CONFIGURATION PER BOUNDARY')
print(f'{"="*80}')
for bn in boundaries:
    best = min(configs, key=lambda c: abs(c['per_boundary'].get(bn, 9999)))
    err = best['per_boundary'].get(bn, '?')
    print(f'  {bn:<6}: {best["label"]:<45} ({err:>+4}%)')
