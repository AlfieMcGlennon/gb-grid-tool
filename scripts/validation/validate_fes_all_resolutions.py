#!/usr/bin/env python3
"""
Validate with FES embedded generation across all 4 network resolutions.
Embedded gen reduces net demand at each GSP/zone, matching NESO's approach.
"""
import json, numpy as np, sys, io, time
from scipy.sparse import lil_matrix
from scipy.sparse.linalg import splu
from collections import defaultdict, deque

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

def load(p):
    with open(p) as f: return json.load(f)

# Load all data
plants = load('public/data/plants_tnuos.json')
zones_tnuos = load('public/data/zones_tnuos.json')
links24 = load('public/data/links_tnuos_by_year.json').get('2024', [])
boundary_mapping = load('public/data/boundary_link_mapping.json')
etys_caps = load('public/data/etys_capabilities.json')
sub_network = load('docs/substation/substation_network.json')
sub_injections = load('docs/substation/substation_injections.json')
sub_zone_map = load('public/data/substation_zone_mapping.json')
flop_official = load('scripts/network_to_flop_official.json')
validation_data = load('scripts/winter_validation_data.json')
fes_embedded = load('scripts/fes_embedded_generation.json')

# FES FLOP mapping for embedded gen
import pandas as pd
fes_flop_csv = pd.read_csv('docs/flop/fes2022_regional_breakdown_gsp_info.csv', encoding='latin-1')
gsp_to_flop = {str(row['GSP ID']): row['Minor FLOP'] for _, row in fes_flop_csv.iterrows() if pd.notna(row['Minor FLOP'])}
# Also by name
for _, row in fes_flop_csv.iterrows():
    if pd.notna(row['Minor FLOP']):
        gsp_to_flop[str(row['Name'])] = row['Minor FLOP']

YEAR = 2024; NA = 0.80; IC = 65; SC = 'Holistic Transition'

# Winter CFs for embedded generation
EMB_CF = {'Solar': 0.05, 'Wind Onshore': 0.30, 'Wind Offshore': 0.30, 'CHP': 0.60,
           'Gas Engine': 0.30, 'CCGT': 0.50, 'OCGT': 0.10, 'Biomass': 0.70,
           'Waste': 0.80, 'Diesel': 0.05, 'Renewable Engine': 0.50, 'Hydro': 0.40}

sub_to_tnuos = {c: d['zone'] for c, d in sub_zone_map['substations'].items()}
sub_to_flop = flop_official['sub_to_flop']

# Compute embedded generation output per zone type
def compute_embedded_by_zone(zone_type):
    """Aggregate embedded gen output to zones."""
    emb_by_zone = defaultdict(float)
    for gsp, types in fes_embedded['embedded_by_gsp'].items():
        zone = None
        if zone_type == 'FLOP':
            zone = gsp_to_flop.get(gsp)
        if not zone:
            # Try substation code match
            code = gsp.replace(' ', '')[:4].upper()
            if code in sub_zone_map['substations']:
                if zone_type == 'TNUoS':
                    zone = sub_to_tnuos.get(code)
                elif zone_type == 'FLOP':
                    zone = sub_to_flop.get(code)
        if not zone and zone_type == 'TNUoS':
            for sc, sd in sub_zone_map['substations'].items():
                if gsp.upper() in sd.get('name', '').upper():
                    zone = sd['zone']
                    break
        if zone:
            for pt, mw in types.items():
                if pt == 'battery_mw': continue
                cf = EMB_CF.get(pt, 0.3)
                emb_by_zone[zone] += mw * cf
    return dict(emb_by_zone)

emb_tnuos = compute_embedded_by_zone('TNUoS')
emb_flop = compute_embedded_by_zone('FLOP')
print(f'Embedded gen mapped: TNUoS={sum(emb_tnuos.values()):.0f} MW, FLOP={sum(emb_flop.values()):.0f} MW')

# ============================================================
# 27-NODE TNUoS MODEL
# ============================================================
def solve_27node(injections, links):
    zones = sorted(injections.keys())
    n = len(zones); z2i = {z:i for i,z in enumerate(zones)}
    B = np.zeros((n,n))
    for l in links:
        i,j = z2i.get(l['from']), z2i.get(l['to'])
        if i is None or j is None: continue
        b = 100/l['x_equivalent']
        B[i,j]-=b; B[j,i]-=b; B[i,i]+=b; B[j,j]+=b
    P = np.array([injections[z]/100 for z in zones])
    sl = z2i.get('GZ18',0)
    mask = [i for i in range(n) if i!=sl]
    try:
        theta_r = np.linalg.solve(B[np.ix_(mask,mask)], P[mask])
    except: return {}
    theta = np.zeros(n)
    for i,fi in enumerate(mask): theta[fi] = theta_r[i]
    flows = {}
    for l in links:
        i,j = z2i.get(l['from']),z2i.get(l['to'])
        if i is None or j is None: continue
        flows[l['id']] = (theta[i]-theta[j])*100/l['x_equivalent']*100
    return flows

def boundary_flows_27(flows):
    r = {}
    for bn, bd in boundary_mapping.get('boundary_links',{}).items():
        if not bd.get('crossing_links'): continue
        r[bn] = sum(flows.get(lid,0) for lid in bd['crossing_links'])
    return r

# ============================================================
# SUBSTATION-LEVEL MODEL BUILDER (for FLOP and full 674)
# ============================================================
nodes = sub_network['node_ids']
branches = sub_network['branches']
node_to_idx = {n:i for i,n in enumerate(nodes)}

def build_zonal_model(sub_to_zone_map, zone_name=''):
    """Build sparse DC power flow model at any zonal aggregation."""
    zone_list = sorted(set(v for v in sub_to_zone_map.values() if v!='UNKNOWN'))
    nz = len(zone_list); zi = {z:i for i,z in enumerate(zone_list)}

    B = lil_matrix((nz,nz)); bd = []
    for br in branches:
        z1,z2 = sub_to_zone_map.get(br['sub1']),sub_to_zone_map.get(br['sub2'])
        if not z1 or not z2 or z1=='UNKNOWN' or z2=='UNKNOWN' or z1==z2: continue
        fi,fj = zi.get(z1),zi.get(z2)
        if fi is None or fj is None: continue
        x = br['x_pct']/100
        if x<=0: continue
        b = 1/x; B[fi,fj]-=b; B[fj,fi]-=b; B[fi,fi]+=b; B[fj,fj]+=b
        bd.append((fi,fj,b,br['sub1'],br['sub2'],z1,z2))

    # Connected component
    adj = defaultdict(set)
    for fi,fj,*_ in bd: adj[fi].add(fj); adj[fj].add(fi)
    vis=set(); q=deque([0]); vis.add(0)
    while q:
        c=q.popleft()
        for n in adj[c]:
            if n not in vis: vis.add(n); q.append(n)
    act=sorted(vis); aset=set(act); amap={o:n for n,o in enumerate(act)}; m=len(act)

    Ba=lil_matrix((m,m)); ab=[]
    for fi,fj,b,s1,s2,z1,z2 in bd:
        if fi not in aset or fj not in aset: continue
        ai,aj=amap[fi],amap[fj]
        Ba[ai,aj]-=b; Ba[aj,ai]-=b; Ba[ai,ai]+=b; Ba[aj,aj]+=b
        ab.append((ai,aj,b,s1,s2,z1,z2))

    # Slack
    gz18_zones = set()
    for c in nodes:
        tz = sub_to_tnuos.get(c)
        fz = sub_to_zone_map.get(c)
        if tz=='GZ18' and fz and fz!='UNKNOWN':
            fi=zi.get(fz)
            if fi is not None and fi in aset: gz18_zones.add(amap[fi])
    sl = max(gz18_zones, key=lambda x:len(adj.get(x,set()))) if gz18_zones else 0

    mask=[i for i in range(m) if i!=sl]
    Br=Ba.tocsc()[np.ix_(mask,mask)].tocsc()
    lu=splu(Br)

    # Boundary crossings
    bc={}
    for bn,bdata in boundary_mapping.get('boundary_links',{}).items():
        ntz=set(bdata.get('north_zones',[])); stz=set(bdata.get('south_zones',[]))
        if not bdata.get('crossing_links'): continue
        nf=set(); sf=set()
        for c,fz in sub_to_zone_map.items():
            tz=sub_to_tnuos.get(c)
            if tz in ntz: nf.add(fz)
            elif tz in stz: sf.add(fz)
        cx=[]
        for bi,(ai,aj,b,s1,s2,z1,z2) in enumerate(ab):
            if z1 in nf and z2 in sf: cx.append((bi,1))
            elif z1 in sf and z2 in nf: cx.append((bi,-1))
        if cx: bc[bn]=cx

    return {'m':m, 'ab':ab, 'mask':mask, 'lu':lu, 'bc':bc, 'zi':zi, 'amap':amap, 'aset':aset, 'zone_list':zone_list}

# Build FLOP model
print('Building FLOP model...')
flop_model = build_zonal_model(sub_to_flop, 'FLOP')
print(f'  FLOP: {flop_model["m"]} zones, {len(flop_model["ab"])} branches')

# Sub generation and demand
sub_gen = sub_injections.get('generation_by_substation', {})
sub_dem = sub_injections.get('demand_by_substation', {})
td = sum(sub_dem.values()); sds = {k:v/td for k,v in sub_dem.items()}

# Zone capacities for 27-node
zone_cap = defaultdict(lambda: defaultdict(float))
for p in plants:
    if not p.get('zone_id') or not p.get('plant_type') or p.get('status')!='Built' or p.get('mw_connected',0)<=0: continue
    pt = p['plant_type']
    if any(x in pt for x in ['Demand','Reactive','Substation']): continue
    zone_cap[p['zone_id']][pt] += p['mw_connected']

# ============================================================
# RUN VALIDATION
# ============================================================
records = validation_data['records'][:2000]
boundaries = ['B6F','B7aF','B9','SW1','B1aF','B2F','B3','B4F','B5','SC2']

def pctile(arr,p):
    s=sorted(arr); i=(p/100)*(len(s)-1); l=int(i); h=min(l+1,len(s)-1)
    return s[l]+(s[h]-s[l])*(i-l)

def run_27node_validation(use_embedded):
    """Run 27-node validation with optional embedded gen subtraction."""
    fs = defaultdict(list)
    for r in records:
        try:
            inj = {}
            for z in zones_tnuos:
                gen = 0
                for pt,mw in zone_cap.get(z,{}).items():
                    if pt=='Interconnector': gen+=mw*IC/100; continue
                    if 'Wind' in pt: gen+=mw*r['wind_cf'].get(z,0)
                    elif 'Solar' in pt or 'PV' in pt: gen+=mw*r['solar_cf'].get(z,0)
                    elif 'Nuclear' in pt: gen+=mw*NA
                    else: gen+=mw

                dem_share = zones_tnuos[z].get('demand_mw_by_year',{}).get(str(YEAR),0)/47940
                dem = r['tsd_mw'] * dem_share

                # Subtract embedded generation from demand
                if use_embedded:
                    dem -= emb_tnuos.get(z, 0)
                    dem = max(0, dem)

                inj[z] = gen - dem

            flows = solve_27node(inj, links24)
            bf = boundary_flows_27(flows)
            for bn in bf: fs[bn].append(bf[bn])
        except: pass
    return fs

def run_substation_validation(model, sub_zone_map_dict, emb_zones, use_embedded):
    """Run substation-level validation at any zonal resolution."""
    fs = defaultdict(list)
    m = model['m']; ab = model['ab']; mask = model['mask']; lu = model['lu']
    bc = model['bc']; zi = model['zi']; amap = model['amap']; aset = model['aset']

    for r in records:
        try:
            P = np.zeros(m)
            for sc,gt in sub_gen.items():
                fz = sub_zone_map_dict.get(sc)
                if not fz or fz=='UNKNOWN': continue
                fi = zi.get(fz)
                if fi is None or fi not in aset: continue
                ai = amap[fi]; tz = sub_to_tnuos.get(sc); tot=0
                for pt,mw in gt.items():
                    if 'Interconnector' in pt: tot+=mw*IC/100
                    elif 'Wind' in pt: tot+=mw*r['wind_cf'].get(tz,0)
                    elif 'Solar' in pt or 'PV' in pt: tot+=mw*r['solar_cf'].get(tz,0)
                    elif 'Nuclear' in pt: tot+=mw*NA
                    elif any(x in pt for x in ['Demand','Reactive','Substation']): continue
                    else: tot+=mw
                P[ai]+=tot/100

            for sc,sh in sds.items():
                fz = sub_zone_map_dict.get(sc)
                if not fz or fz=='UNKNOWN': continue
                fi = zi.get(fz)
                if fi is None or fi not in aset: continue
                ai = amap[fi]
                dem = r['tsd_mw']*sh
                if use_embedded:
                    dem -= emb_zones.get(fz, 0) * sh * td  # Scale embedded by this sub's share
                    dem = max(0, dem)
                P[ai] -= dem/100

            Pr=P[mask]; th=np.zeros(m); tr=lu.solve(Pr)
            for i,fi in enumerate(mask): th[fi]=tr[i]
            bf_arr=np.zeros(len(ab))
            for bi,(ai,aj,b,*_) in enumerate(ab): bf_arr[bi]=(th[ai]-th[aj])*b*100
            for bn,cx in bc.items():
                fs[bn].append(sum(bf_arr[bi]*d for bi,d in cx))
        except: pass
    return fs

def print_results(name, fs):
    print(f'\n=== {name} ===')
    print(f'{"B":>6}|{"p25":>8}|{"NESO":>8}|{"Err":>7}|{"p75":>8}|{"NESO":>8}|{"Err":>7}|St')
    print('-'*65)
    g=f=p=0; results=[]
    for bn in boundaries:
        s=fs.get(bn)
        if not s or len(s)<10: continue
        cp=etys_caps.get('boundaries',{}).get(bn,{}).get('fes24',{}).get(SC,{})
        n25=cp.get('25pc',{}).get(str(YEAR)); n75=cp.get('75pc',{}).get(str(YEAR))
        if n25 is None or n75 is None: continue
        o25=round(pctile(s,25)); o75=round(pctile(s,75))
        e25=round((o25-n25)/max(abs(n25),1)*100); e75=round((o75-n75)/max(abs(n75),1)*100)
        if abs(e25)<=30 and abs(e75)<=30: st='GOOD'; g+=1
        elif abs(e25)<=50 or abs(e75)<=50: st='FAIR'; f+=1
        else: st='POOR'; p+=1
        results.append((bn,o25,n25,e25,o75,n75,e75,st))
        print(f'{bn:>6}|{o25:>8}|{n25:>8}|{e25:>+6}%|{o75:>8}|{n75:>8}|{e75:>+6}%|{st}')
    print(f'Summary: Good {g} | Fair {f} | Poor {p}')
    return results

# Run all validations
print(f'\nRunning {len(records)} scenarios...')
t0 = time.time()

# 27-node without embedded
r1 = run_27node_validation(False)
print_results('27-zone TNUoS (no embedded)', r1)

# 27-node with embedded
r2 = run_27node_validation(True)
print_results('27-zone TNUoS + FES embedded', r2)

# FLOP without embedded
r3 = run_substation_validation(flop_model, sub_to_flop, {}, False)
print_results('84-zone FLOP (no embedded)', r3)

# FLOP with embedded
r4 = run_substation_validation(flop_model, sub_to_flop, emb_flop, True)
print_results('84-zone FLOP + FES embedded', r4)

print(f'\nTotal time: {time.time()-t0:.1f}s')
