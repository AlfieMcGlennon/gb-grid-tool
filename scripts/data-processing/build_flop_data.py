#!/usr/bin/env python3
"""
Build FLOP zone data files for the GB Grid Tool.

Reads substation-level data and aggregates to ~60 Minor FLOP zones,
producing 4 output JSON/GeoJSON files in public/data/.
"""

import sys
import io
import json
import csv
import os
from collections import defaultdict

# Windows encoding fix
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

# Paths (relative to repo root)
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.chdir(ROOT)

# --- Load inputs ---

with open('scripts/network_to_flop_official.json', 'r', encoding='utf-8') as f:
    flop_official = json.load(f)
sub_to_flop = flop_official['sub_to_flop']
unique_flops = flop_official['unique_flops']

with open('docs/substation/substation_injections.json', 'r', encoding='utf-8') as f:
    injections = json.load(f)
gen_by_sub = injections['generation_by_substation']
demand_by_sub = injections['demand_by_substation']

with open('public/data/substation_zone_mapping.json', 'r', encoding='utf-8') as f:
    zone_mapping = json.load(f)
substations = zone_mapping['substations']

with open('docs/substation/substation_network.json', 'r', encoding='utf-8') as f:
    network = json.load(f)
branches = network['branches']

with open('public/data/boundary_link_mapping.json', 'r', encoding='utf-8') as f:
    boundary_data = json.load(f)
boundary_links_orig = boundary_data['boundary_links']
cap_name_map = boundary_data['cap_name_map']

# GSP GeoJSON
with open('docs/flop/gsp_regions_20251204/Proj_4326/GSP_regions_4326_20251204.geojson', 'r', encoding='utf-8') as f:
    gsp_geojson = json.load(f)

# FES CSV - GSP ID -> Minor FLOP
gsp_to_flop = {}
with open('docs/flop/fes2022_regional_breakdown_gsp_info.csv', 'r', encoding='latin-1') as f:
    reader = csv.DictReader(f)
    for row in reader:
        gsp_id = row['GSP ID'].strip()
        minor_flop = row['Minor FLOP'].strip()
        if minor_flop:
            gsp_to_flop[gsp_id] = minor_flop

print(f"Loaded: {len(sub_to_flop)} sub->FLOP mappings, {len(unique_flops)} FLOP zones")
print(f"  {len(gen_by_sub)} subs with generation, {len(demand_by_sub)} subs with demand")
print(f"  {len(substations)} substations with zone/coords")
print(f"  {len(branches)} network branches")
print(f"  {len(gsp_to_flop)} GSP->FLOP mappings")
print(f"  {len(gsp_geojson['features'])} GSP polygons")

# --- Build sub -> FLOP lookup with coordinates ---

# Group substations by FLOP zone
flop_subs = defaultdict(list)  # flop_zone -> [sub_code, ...]
for sub_code, flop_zone in sub_to_flop.items():
    flop_subs[flop_zone].append(sub_code)

# ============================================================
# 1. zones_flop.json
# ============================================================
print("\n--- Building zones_flop.json ---")

zones_flop = {}
for flop_zone in sorted(unique_flops):
    subs = flop_subs.get(flop_zone, [])

    # Aggregate generation by type
    gen_by_type = defaultdict(lambda: {'built_mw': 0.0, 'n_projects': 0})
    for sub in subs:
        if sub in gen_by_sub:
            for plant_type, mw in gen_by_sub[sub].items():
                gen_by_type[plant_type]['built_mw'] += mw
                gen_by_type[plant_type]['n_projects'] += 1

    # Round MW values
    gen_by_type_clean = {}
    for ptype, vals in sorted(gen_by_type.items()):
        gen_by_type_clean[ptype] = {
            'built_mw': round(vals['built_mw'], 1),
            'n_projects': vals['n_projects']
        }

    # Aggregate demand
    demand_mw = sum(demand_by_sub.get(sub, 0) for sub in subs)

    # Total built MW
    total_built_mw = sum(v['built_mw'] for v in gen_by_type_clean.values())

    # TNUoS zones and coordinates
    tnuos_zones_list = []
    lats = []
    lons = []
    tnuos_zone_counts = defaultdict(int)

    for sub in subs:
        if sub in substations:
            info = substations[sub]
            tz = info.get('zone', '')
            if tz:
                tnuos_zones_list.append(tz)
                tnuos_zone_counts[tz] += 1
            lat = info.get('lat')
            lon = info.get('lon')
            if lat is not None and lon is not None:
                lats.append(lat)
                lons.append(lon)

    tnuos_zones = sorted(set(tnuos_zones_list))
    primary_tnuos_zone = max(tnuos_zone_counts, key=tnuos_zone_counts.get) if tnuos_zone_counts else ""

    centroid_lat = round(sum(lats) / len(lats), 4) if lats else 0
    centroid_lon = round(sum(lons) / len(lons), 4) if lons else 0

    zones_flop[flop_zone] = {
        'generation_by_type': gen_by_type_clean,
        'demand_mw': round(demand_mw, 1),
        'total_built_mw': round(total_built_mw, 1),
        'tnuos_zones': tnuos_zones,
        'primary_tnuos_zone': primary_tnuos_zone,
        'n_substations': len(subs),
        'centroid_lat': centroid_lat,
        'centroid_lon': centroid_lon
    }

with open('public/data/zones_flop.json', 'w', encoding='utf-8') as f:
    json.dump(zones_flop, f, indent=2, ensure_ascii=False)

total_gen = sum(z['total_built_mw'] for z in zones_flop.values())
total_dem = sum(z['demand_mw'] for z in zones_flop.values())
print(f"  {len(zones_flop)} FLOP zones")
print(f"  Total generation: {total_gen:.0f} MW, Total demand: {total_dem:.0f} MW")
print(f"  Zones with generation: {sum(1 for z in zones_flop.values() if z['total_built_mw'] > 0)}")
print(f"  Zones with demand: {sum(1 for z in zones_flop.values() if z['demand_mw'] > 0)}")

# ============================================================
# 2. links_flop.json
# ============================================================
print("\n--- Building links_flop.json ---")

# Group branches by FLOP zone pair (skip same-zone)
link_data = defaultdict(lambda: {'x_values': [], 'ratings': []})

for branch in branches:
    sub1 = branch['sub1']
    sub2 = branch['sub2']
    flop1 = sub_to_flop.get(sub1)
    flop2 = sub_to_flop.get(sub2)

    if flop1 is None or flop2 is None:
        continue
    if flop1 == flop2:
        continue

    # Alphabetically sorted pair
    pair = tuple(sorted([flop1, flop2]))
    link_id = f"{pair[0]}-{pair[1]}"

    link_data[link_id]['x_values'].append(branch['x_pct'])
    link_data[link_id]['ratings'].append(branch['rating_mva'])

links_flop = []
for link_id, data in sorted(link_data.items()):
    parts = link_id.split('-')

    # Parallel reactance: x_eq = 100 / sum(100/x_i)
    x_values = data['x_values']
    inv_sum = sum(100.0 / x for x in x_values if x > 0)
    x_eq = 100.0 / inv_sum if inv_sum > 0 else 999.0

    # Sum ratings for capacity
    capacity_mw = sum(data['ratings'])

    links_flop.append({
        'id': link_id,
        'from': parts[0],
        'to': parts[1],
        'x_equivalent': round(x_eq, 4),
        'capacity_mw': round(capacity_mw, 1),
        'n_circuits': len(x_values),
        'carrier': 'AC'
    })

with open('public/data/links_flop.json', 'w', encoding='utf-8') as f:
    json.dump(links_flop, f, indent=2, ensure_ascii=False)

print(f"  {len(links_flop)} inter-FLOP links")
print(f"  Total capacity: {sum(l['capacity_mw'] for l in links_flop):.0f} MVA")
print(f"  Circuits range: {min(l['n_circuits'] for l in links_flop)}-{max(l['n_circuits'] for l in links_flop)}")

# ============================================================
# 3. zone_boundaries_flop.geojson
# ============================================================
print("\n--- Building zone_boundaries_flop.geojson ---")

try:
    from shapely.geometry import shape, mapping
    from shapely.ops import unary_union
    HAS_SHAPELY = True
except ImportError:
    HAS_SHAPELY = False
    print("  WARNING: shapely not available, using convex hull fallback for all zones")

# Build GSP ID -> FLOP mapping from CSV
# The GeoJSON 'GSPs' field needs to match CSV 'GSP ID'
gsp_geojson_to_flop = {}
for feature in gsp_geojson['features']:
    gsp_name = feature['properties']['GSPs']
    # Try matching directly and with common suffixes
    if gsp_name in gsp_to_flop:
        gsp_geojson_to_flop[gsp_name] = gsp_to_flop[gsp_name]
    else:
        # Try finding a match by prefix (GSP GeoJSON may use shorter names)
        for csv_id, flop in gsp_to_flop.items():
            # Strip suffix like _P, _1, _C, 1 etc from CSV ID to match GeoJSON
            csv_base = csv_id.split('_')[0].rstrip('0123456789')
            gsp_base = gsp_name.split('_')[0].rstrip('0123456789')
            if csv_base and gsp_base and csv_base == gsp_base:
                gsp_geojson_to_flop[gsp_name] = flop
                break

print(f"  Matched {len(gsp_geojson_to_flop)}/{len(gsp_geojson['features'])} GSP polygons to FLOP zones")

# Group GSP polygons by FLOP zone
flop_polygons = defaultdict(list)
if HAS_SHAPELY:
    for feature in gsp_geojson['features']:
        gsp_name = feature['properties']['GSPs']
        flop_zone = gsp_geojson_to_flop.get(gsp_name)
        if flop_zone:
            try:
                geom = shape(feature['geometry'])
                if geom.is_valid:
                    flop_polygons[flop_zone].append(geom)
                else:
                    geom = geom.buffer(0)
                    if geom.is_valid:
                        flop_polygons[flop_zone].append(geom)
            except Exception as e:
                print(f"  WARNING: Could not parse geometry for GSP {gsp_name}: {e}")

# Build GeoJSON features
features = []
zones_from_dissolve = 0
zones_from_hull = 0

for flop_zone in sorted(unique_flops):
    centroid_lat = zones_flop[flop_zone]['centroid_lat']
    centroid_lon = zones_flop[flop_zone]['centroid_lon']

    properties = {
        'id': flop_zone,
        'name': flop_zone,
        'centroid_lat': centroid_lat,
        'centroid_lon': centroid_lon
    }

    geometry = None

    if HAS_SHAPELY and flop_zone in flop_polygons and len(flop_polygons[flop_zone]) > 0:
        try:
            dissolved = unary_union(flop_polygons[flop_zone])
            if dissolved.is_valid and not dissolved.is_empty:
                geometry = mapping(dissolved)
                zones_from_dissolve += 1
        except Exception as e:
            print(f"  WARNING: dissolve failed for {flop_zone}: {e}")

    # Fallback: convex hull from substation points
    if geometry is None:
        subs = flop_subs.get(flop_zone, [])
        points = []
        for sub in subs:
            if sub in substations:
                lat = substations[sub].get('lat')
                lon = substations[sub].get('lon')
                if lat is not None and lon is not None:
                    points.append((lon, lat))

        if len(points) >= 3:
            if HAS_SHAPELY:
                from shapely.geometry import MultiPoint
                hull = MultiPoint(points).convex_hull
                geometry = mapping(hull)
            else:
                # Very simple convex hull fallback without shapely
                # Just use bounding box
                min_lon = min(p[0] for p in points)
                max_lon = max(p[0] for p in points)
                min_lat = min(p[1] for p in points)
                max_lat = max(p[1] for p in points)
                geometry = {
                    'type': 'Polygon',
                    'coordinates': [[
                        [min_lon, min_lat], [max_lon, min_lat],
                        [max_lon, max_lat], [min_lon, max_lat],
                        [min_lon, min_lat]
                    ]]
                }
            zones_from_hull += 1
        elif len(points) == 2:
            # Line between two points - buffer slightly
            if HAS_SHAPELY:
                from shapely.geometry import LineString
                line = LineString(points)
                buffered = line.buffer(0.01)
                geometry = mapping(buffered)
            else:
                geometry = {
                    'type': 'Polygon',
                    'coordinates': [[
                        [points[0][0]-0.01, points[0][1]-0.01],
                        [points[1][0]+0.01, points[1][1]-0.01],
                        [points[1][0]+0.01, points[1][1]+0.01],
                        [points[0][0]-0.01, points[0][1]+0.01],
                        [points[0][0]-0.01, points[0][1]-0.01]
                    ]]
                }
            zones_from_hull += 1
        elif len(points) == 1:
            # Single point - buffer
            if HAS_SHAPELY:
                from shapely.geometry import Point
                pt = Point(points[0])
                buffered = pt.buffer(0.05)
                geometry = mapping(buffered)
            else:
                lon, lat = points[0]
                geometry = {
                    'type': 'Polygon',
                    'coordinates': [[
                        [lon-0.05, lat-0.05], [lon+0.05, lat-0.05],
                        [lon+0.05, lat+0.05], [lon-0.05, lat+0.05],
                        [lon-0.05, lat-0.05]
                    ]]
                }
            zones_from_hull += 1
        else:
            print(f"  WARNING: No geometry for FLOP zone {flop_zone} (no substations with coords)")
            continue

    features.append({
        'type': 'Feature',
        'properties': properties,
        'geometry': geometry
    })

geojson_out = {
    'type': 'FeatureCollection',
    'features': features
}

with open('public/data/zone_boundaries_flop.geojson', 'w', encoding='utf-8') as f:
    json.dump(geojson_out, f, ensure_ascii=False)

print(f"  {len(features)} zone polygons written")
print(f"  From GSP dissolve: {zones_from_dissolve}, From convex hull: {zones_from_hull}")

# ============================================================
# 4. boundary_link_mapping_flop.json
# ============================================================
print("\n--- Building boundary_link_mapping_flop.json ---")

# Build TNUoS zone -> set of FLOP zones mapping (via substations)
tnuos_to_flops = defaultdict(set)
for sub_code, flop_zone in sub_to_flop.items():
    if sub_code in substations:
        tz = substations[sub_code].get('zone', '')
        if tz:
            tnuos_to_flops[tz].add(flop_zone)

# Build FLOP zone -> set of TNUoS zones (with counts for tie-breaking)
flop_to_tnuos_counts = defaultdict(lambda: defaultdict(int))
for sub_code, flop_zone in sub_to_flop.items():
    if sub_code in substations:
        tz = substations[sub_code].get('zone', '')
        if tz:
            flop_to_tnuos_counts[flop_zone][tz] += 1

# Build set of all FLOP link IDs for quick lookup
flop_link_set = set()
for link in links_flop:
    flop_link_set.add(link['id'])

boundary_links_flop = {}

for bnd_name, bnd_data in boundary_links_orig.items():
    north_tnuos = set(bnd_data['north_zones'])
    south_tnuos = set(bnd_data['south_zones'])

    # Skip edge boundaries with no zones on one side
    if not north_tnuos or not south_tnuos:
        # Still include them for completeness
        boundary_links_flop[bnd_name] = {
            'geo_id': bnd_data['geo_id'],
            'north_zones': [],
            'south_zones': sorted(set(
                fz for tz in south_tnuos for fz in tnuos_to_flops.get(tz, set())
            )) if south_tnuos else [],
            'crossing_links': [],
            'capability_2024_mw': bnd_data['capability_2024_mw'],
            'shares_with': bnd_data.get('shares_with', []),
            'resolution_status': bnd_data.get('resolution_status', ''),
            'resolution_note': bnd_data.get('resolution_note', '')
        }
        continue

    # Assign each FLOP zone to north or south
    # A FLOP zone is "north" if most of its substations are in north TNUoS zones
    all_relevant_flops = set()
    for tz in north_tnuos | south_tnuos:
        all_relevant_flops.update(tnuos_to_flops.get(tz, set()))

    north_flops = set()
    south_flops = set()

    for fz in all_relevant_flops:
        tnuos_counts = flop_to_tnuos_counts[fz]
        north_count = sum(tnuos_counts.get(tz, 0) for tz in north_tnuos)
        south_count = sum(tnuos_counts.get(tz, 0) for tz in south_tnuos)

        if north_count >= south_count:
            north_flops.add(fz)
        else:
            south_flops.add(fz)

    # Find crossing links: FLOP links that go between north and south FLOP zones
    crossing_links = []
    for link in links_flop:
        f = link['from']
        t = link['to']
        if (f in north_flops and t in south_flops) or (f in south_flops and t in north_flops):
            crossing_links.append(link['id'])

    boundary_links_flop[bnd_name] = {
        'geo_id': bnd_data['geo_id'],
        'north_zones': sorted(north_flops),
        'south_zones': sorted(south_flops),
        'crossing_links': sorted(crossing_links),
        'capability_2024_mw': bnd_data['capability_2024_mw'],
        'shares_with': bnd_data.get('shares_with', []),
        'resolution_status': bnd_data.get('resolution_status', ''),
        'resolution_note': bnd_data.get('resolution_note', '')
    }

output = {
    'metadata': {
        'description': 'ETYS boundary to FLOP zonal link mapping',
        'method': 'Mapped from TNUoS boundary definitions via substation FLOP assignments',
        'source_mapping': 'boundary_link_mapping.json (TNUoS level)'
    },
    'boundary_links': boundary_links_flop,
    'cap_name_map': cap_name_map
}

with open('public/data/boundary_link_mapping_flop.json', 'w', encoding='utf-8') as f:
    json.dump(output, f, indent=2, ensure_ascii=False)

n_with_links = sum(1 for b in boundary_links_flop.values() if b['crossing_links'])
print(f"  {len(boundary_links_flop)} boundaries mapped")
print(f"  {n_with_links} boundaries with crossing links")
print(f"  Boundaries without crossing links: {[k for k, v in boundary_links_flop.items() if not v['crossing_links']]}")

# ============================================================
# Summary
# ============================================================
print("\n=== SUMMARY ===")
print(f"  zones_flop.json:                {len(zones_flop)} zones, {os.path.getsize('public/data/zones_flop.json')//1024} KB")
print(f"  links_flop.json:                {len(links_flop)} links, {os.path.getsize('public/data/links_flop.json')//1024} KB")
print(f"  zone_boundaries_flop.geojson:   {len(features)} polygons, {os.path.getsize('public/data/zone_boundaries_flop.geojson')//1024} KB")
print(f"  boundary_link_mapping_flop.json: {len(boundary_links_flop)} boundaries, {os.path.getsize('public/data/boundary_link_mapping_flop.json')//1024} KB")
print("\nDone!")
