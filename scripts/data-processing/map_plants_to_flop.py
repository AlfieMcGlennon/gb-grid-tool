#!/usr/bin/env python3
"""
Map plants from plants_tnuos.json to FLOP zones.

Adds a 'flop_zone_id' field to each plant using a multi-stage matching approach:
  1. Exact substation name match (connection_site contains substation name)
  2. 4-char code prefix match from connection_site words
  3. Fuzzy: first N chars of connection_site word matches substation name prefix
  4. Fallback: distribute by TNUoS zone -> FLOP zone mapping (proportional by built_mw)

Outputs updated plants_tnuos.json with flop_zone_id added.
"""

import sys
import io
import json
import os
from collections import defaultdict

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.chdir(ROOT)

# Load data
with open('public/data/substation_zone_mapping.json') as f:
    subs = json.load(f)['substations']

with open('scripts/network_to_flop_official.json') as f:
    flop_map = json.load(f)
sub_to_flop = flop_map['sub_to_flop']

with open('public/data/plants_tnuos.json', encoding='utf-8') as f:
    plants = json.load(f)

with open('public/data/zones_flop.json') as f:
    zones_flop = json.load(f)

print(f"Loaded: {len(plants)} plants, {len(subs)} substations, {len(sub_to_flop)} FLOP mappings")

# Build lookup structures
name_to_code = {}  # UPPERCASE substation name -> 4-char code
code_to_name = {}
for code, info in subs.items():
    name = info.get('name', '').upper().strip()
    if name:
        name_to_code[name] = code
        code_to_name[code] = name

# Build TNUoS zone -> FLOP zones mapping (for fallback)
# Use zones_flop to find which FLOP zones map to each TNUoS zone, weighted by built_mw
tnuos_to_flop_zones = defaultdict(list)  # tnuos_zone -> [(flop_zone, built_mw), ...]
for fz_id, fz_data in zones_flop.items():
    primary = fz_data.get('primary_tnuos_zone', '')
    built = fz_data.get('total_built_mw', 0)
    if primary:
        tnuos_to_flop_zones[primary].append((fz_id, built))

# For fallback: pick the largest FLOP zone (by built_mw) in the TNUoS zone
tnuos_to_primary_flop = {}
for tz, flop_list in tnuos_to_flop_zones.items():
    if flop_list:
        # Sort by built_mw descending, pick first
        best = max(flop_list, key=lambda x: x[1])
        tnuos_to_primary_flop[tz] = best[0]

# Matching functions
def match_by_name(site_upper):
    """Try to find a substation whose name is contained in the connection site."""
    best_match = None
    best_len = 0
    for name, code in name_to_code.items():
        if len(name) < 3:
            continue
        if name in site_upper:
            if len(name) > best_len:
                best_len = len(name)
                best_match = code
    return best_match

def match_by_code(site_upper):
    """Try extracting 4-char codes from site name words."""
    words = site_upper.replace('/', ' ').replace('-', ' ').replace('(', ' ').replace(')', ' ').split()
    for w in words:
        w4 = w[:4]
        if len(w4) == 4 and w4.isalpha() and w4 in sub_to_flop:
            return w4
    return None

def match_fuzzy(site_upper):
    """Try fuzzy prefix matching: first word of site vs substation names."""
    words = site_upper.replace('/', ' ').replace('-', ' ').replace('(', ' ').replace(')', ' ').split()
    if not words:
        return None

    # Try matching first significant word (skip voltage/type suffixes)
    skip = {'132KV', '275KV', '400KV', 'GSP', 'SUBSTATION', 'OFFSHORE', 'ONSHORE', 'WIND', 'FARM', 'SOLAR'}

    for w in words:
        if w in skip or len(w) < 3:
            continue
        # Check if any substation name starts with this word
        for name, code in name_to_code.items():
            if name.startswith(w) and code in sub_to_flop:
                return code
        # Check if this word starts with any substation name
        for name, code in name_to_code.items():
            if len(name) >= 4 and w.startswith(name) and code in sub_to_flop:
                return code

    return None

# Map each plant
stats = {'name': 0, 'code': 0, 'fuzzy': 0, 'tnuos_fallback': 0, 'no_zone': 0}

for plant in plants:
    site = (plant.get('connection_site') or '').strip()
    site_upper = site.upper()
    tnuos_zone = plant.get('zone_id', '')

    flop_zone = None

    # Stage 1: substation name match
    if site_upper:
        code = match_by_name(site_upper)
        if code and code in sub_to_flop:
            flop_zone = sub_to_flop[code]
            stats['name'] += 1

    # Stage 2: 4-char code extraction
    if not flop_zone and site_upper:
        code = match_by_code(site_upper)
        if code:
            flop_zone = sub_to_flop[code]
            stats['code'] += 1

    # Stage 3: fuzzy prefix match
    if not flop_zone and site_upper:
        code = match_fuzzy(site_upper)
        if code:
            flop_zone = sub_to_flop[code]
            stats['fuzzy'] += 1

    # Stage 4: fallback to TNUoS zone -> primary FLOP zone
    if not flop_zone and tnuos_zone:
        flop_zone = tnuos_to_primary_flop.get(tnuos_zone)
        if flop_zone:
            stats['tnuos_fallback'] += 1

    if not flop_zone:
        stats['no_zone'] += 1

    plant['flop_zone_id'] = flop_zone or ''

# Verify
print(f"\nMapping results:")
print(f"  Name match:      {stats['name']}")
print(f"  Code match:      {stats['code']}")
print(f"  Fuzzy match:     {stats['fuzzy']}")
print(f"  TNUoS fallback:  {stats['tnuos_fallback']}")
print(f"  No zone:         {stats['no_zone']}")
print(f"  Total mapped:    {sum(v for k,v in stats.items() if k != 'no_zone')}/{len(plants)}")

# Check built plants coverage
built_mapped = sum(1 for p in plants if p.get('status') == 'Built' and p.get('mw_connected', 0) > 0 and p.get('flop_zone_id'))
built_total = sum(1 for p in plants if p.get('status') == 'Built' and p.get('mw_connected', 0) > 0)
built_mw_mapped = sum(p.get('mw_connected', 0) for p in plants if p.get('status') == 'Built' and p.get('mw_connected', 0) > 0 and p.get('flop_zone_id'))
built_mw_total = sum(p.get('mw_connected', 0) for p in plants if p.get('status') == 'Built' and p.get('mw_connected', 0) > 0)
print(f"\n  Built plants mapped: {built_mapped}/{built_total}")
print(f"  Built MW mapped: {built_mw_mapped:.0f}/{built_mw_total:.0f} ({built_mw_mapped/built_mw_total*100:.1f}%)")

# Validate: compare FLOP aggregated capacity with zones_flop.json
flop_agg = defaultdict(lambda: defaultdict(float))
for p in plants:
    fz = p.get('flop_zone_id', '')
    pt = p.get('plant_type', '')
    if not fz or not pt:
        continue
    if p.get('status') == 'Built' and p.get('mw_connected', 0) > 0:
        flop_agg[fz][pt] += p['mw_connected']

total_plant_mw = sum(sum(types.values()) for types in flop_agg.values())
total_zone_mw = sum(z.get('total_built_mw', 0) for z in zones_flop.values())
print(f"\n  Plant-based FLOP built capacity: {total_plant_mw:.0f} MW")
print(f"  Zone-based FLOP built capacity:  {total_zone_mw:.0f} MW")
print(f"  Ratio: {total_plant_mw/total_zone_mw:.2f}")

# Save
with open('public/data/plants_tnuos.json', 'w', encoding='utf-8') as f:
    json.dump(plants, f, indent=2, ensure_ascii=False)

print(f"\nSaved updated plants_tnuos.json with flop_zone_id field")
