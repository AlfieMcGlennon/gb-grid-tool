#!/usr/bin/env python3
"""
Build NESO's exact 28-zone reduced model from official zone definitions.
Chain: Substation → Minor FLOP → NESO 28-zone.
Compute inter-zone reactances by aggregating substation-level network.
"""
import json, numpy as np, sys, io, pandas as pd
from collections import defaultdict
from scipy.sparse import lil_matrix
from scipy.sparse.linalg import splu

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

def load(p):
    with open(p) as f: return json.load(f)

# NESO 28-zone definitions from GB Reduced Model Release Note
NESO_28_ZONES = {
    'Z01': ['F6', 'E8', 'E7', 'E1'],
    'Z02': ['B2', 'B1'],
    'Z03': ['C4', 'C7', 'C8', 'C9'],
    'Z04': ['H1', 'H2', 'H6'],
    'Z05': ['G1', 'G5', 'G6', 'G7'],
    'Z06': ['B3', 'B4', 'D6'],
    'Z07': ['A8'],
    'Z08': ['A1', 'A4', 'A7'],
    'Z09': ['A3', 'A6', 'A9'],
    'Z10': ['C1', 'C2', 'C3'],
    'Z11': ['C5', 'C6', 'J8'],
    'Z12': ['J1', 'J2', 'J3', 'J5'],
    'Z13': ['D4', 'D5', 'J4', 'J6', 'J7', 'L8'],
    'Z14': ['L3', 'L7'],
    'Z15': ['L1', 'L2', 'L5'],
    'Z16': ['K1', 'K2', 'K4', 'K5', 'K6'],
    'Z17': ['P3'],
    'Z18': ['M4', 'M5', 'M6', 'M7', 'M8'],
    'Z19': ['N2', 'N4', 'N5', 'N6', 'N7', 'N8'],
    'Z20': ['N1', 'N3'],
    'Z21': ['R4', 'R5', 'R6'],  # SLACK BUS
    'Z22': ['P1', 'P2', 'P4', 'P5', 'P6'],
    'Z23': ['P7', 'P8'],
    'Z24': ['Q2', 'Q4', 'Q5', 'Q6', 'Q7', 'Q8'],
    'Z25': ['S6'],
    'Z26': ['S5'],
    'Z27': ['T3', 'T4'],
    'Z28': ['T1', 'T5', 'T2', 'T6'],
}

# Invert: Minor FLOP → NESO 28 zone
flop_to_neso28 = {}
for neso_zone, flop_zones in NESO_28_ZONES.items():
    for fz in flop_zones:
        flop_to_neso28[fz] = neso_zone

print(f'NESO 28-zone model: {len(NESO_28_ZONES)} zones')
print(f'Minor FLOP zones mapped: {len(flop_to_neso28)}')

# Load substation → Minor FLOP mapping
flop_map = load('scripts/network_to_flop_official.json')
sub_to_flop = flop_map['sub_to_flop']

# Build substation → NESO 28-zone
sub_to_neso28 = {}
unmapped_flops = set()
for sub, flop in sub_to_flop.items():
    if flop == 'UNKNOWN':
        sub_to_neso28[sub] = 'UNKNOWN'
        continue
    neso = flop_to_neso28.get(flop)
    if neso:
        sub_to_neso28[sub] = neso
    else:
        unmapped_flops.add(flop)
        sub_to_neso28[sub] = 'UNKNOWN'

print(f'Substations mapped to NESO 28: {sum(1 for v in sub_to_neso28.values() if v != "UNKNOWN")}')
print(f'Unmapped Minor FLOP zones: {sorted(unmapped_flops)}')

# Load network
net = load('docs/substation/substation_network.json')
nodes = net['node_ids']
branches = net['branches']

# Build 28-zone admittance matrix
neso_zones = sorted(NESO_28_ZONES.keys())
n28 = len(neso_zones)
zi = {z: i for i, z in enumerate(neso_zones)}

B28 = lil_matrix((n28, n28))
branch_data_28 = []
inter_zone_branches = defaultdict(list)

for br in branches:
    z1 = sub_to_neso28.get(br['sub1'])
    z2 = sub_to_neso28.get(br['sub2'])
    if not z1 or not z2 or z1 == 'UNKNOWN' or z2 == 'UNKNOWN' or z1 == z2:
        continue
    fi, fj = zi.get(z1), zi.get(z2)
    if fi is None or fj is None:
        continue
    x_pu = br['x_pct'] / 100.0
    if x_pu <= 0:
        continue
    b = 1.0 / x_pu
    B28[fi, fj] -= b
    B28[fj, fi] -= b
    B28[fi, fi] += b
    B28[fj, fj] += b
    branch_data_28.append((fi, fj, b, br['sub1'], br['sub2'], z1, z2))
    key = tuple(sorted([z1, z2]))
    inter_zone_branches[key].append(br)

print(f'\nInter-zone branches: {len(branch_data_28)}')
print(f'Unique zone pairs: {len(inter_zone_branches)}')

# Compute equivalent reactances per zone pair
links_28 = []
for (z1, z2), brs in sorted(inter_zone_branches.items()):
    total_admittance = sum(1.0 / (br['x_pct'] / 100.0) for br in brs if br['x_pct'] > 0)
    x_eq = (100.0 / total_admittance) if total_admittance > 0 else 999
    total_rating = sum(br['rating_mva'] for br in brs)
    links_28.append({
        'id': f'{z1}-{z2}',
        'from': z1,
        'to': z2,
        'x_equivalent': round(x_eq, 6),
        'capacity_mw': round(total_rating),
        'n_circuits': len(brs)
    })

print(f'NESO 28-zone links: {len(links_28)}')

# Also map substations to TNUoS zones for cross-reference
sub_to_tnuos = {c: d['zone'] for c, d in load('public/data/substation_zone_mapping.json')['substations'].items()}

# Build NESO28 → TNUoS zone mapping (which TNUoS zones does each NESO zone contain?)
neso28_to_tnuos = defaultdict(set)
for sub, neso in sub_to_neso28.items():
    if neso == 'UNKNOWN': continue
    tnuos = sub_to_tnuos.get(sub)
    if tnuos:
        neso28_to_tnuos[neso].add(tnuos)

print(f'\n=== NESO 28 → TNUoS ZONE MAPPING ===')
for nz in sorted(neso28_to_tnuos.keys()):
    tnuos = sorted(neso28_to_tnuos[nz])
    print(f'  {nz}: {tnuos}')

# Build boundary crossing map for NESO 28 zones
boundary_mapping = load('public/data/boundary_link_mapping.json')
boundary_crossings_28 = {}

for bname, bdata in boundary_mapping.get('boundary_links', {}).items():
    north_tnuos = set(bdata.get('north_zones', []))
    south_tnuos = set(bdata.get('south_zones', []))
    if not bdata.get('crossing_links'):
        continue

    # Map TNUoS north/south to NESO 28 zones
    north_neso = set()
    south_neso = set()
    for sub, neso in sub_to_neso28.items():
        if neso == 'UNKNOWN': continue
        tnuos = sub_to_tnuos.get(sub)
        if tnuos in north_tnuos: north_neso.add(neso)
        elif tnuos in south_tnuos: south_neso.add(neso)

    # Find branches crossing between north and south
    crossings = []
    for bi, (fi, fj, b, s1, s2, z1, z2) in enumerate(branch_data_28):
        if z1 in north_neso and z2 in south_neso:
            crossings.append((bi, 1))
        elif z1 in south_neso and z2 in north_neso:
            crossings.append((bi, -1))

    if crossings:
        boundary_crossings_28[bname] = crossings

print(f'\nBoundaries with NESO 28 crossings: {len(boundary_crossings_28)}')

# Save everything
output = {
    'zone_definitions': NESO_28_ZONES,
    'sub_to_neso28': sub_to_neso28,
    'links': links_28,
    'boundary_crossings': {bn: [(bi, d) for bi, d in cx] for bn, cx in boundary_crossings_28.items()},
    'slack_zone': 'Z21',
    'neso28_to_tnuos': {k: sorted(v) for k, v in neso28_to_tnuos.items()},
    'metadata': {
        'source': 'GB Reduced Model Release Note, NESO 2024',
        'n_zones': 28,
        'n_links': len(links_28),
        'n_branches': len(branch_data_28),
    }
}

with open('scripts/neso28_model.json', 'w') as f:
    json.dump(output, f, indent=2)

print(f'\nSaved to scripts/neso28_model.json')

# Show links
print(f'\n=== NESO 28-ZONE LINKS ===')
for l in sorted(links_28, key=lambda x: x['id']):
    print(f"  {l['id']}: x={l['x_equivalent']:.4f}%, cap={l['capacity_mw']} MW, {l['n_circuits']} circuits")
