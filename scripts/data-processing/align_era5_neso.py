#!/usr/bin/env python3
"""
Align ERA5 zone weather timeseries with NESO half-hourly demand and interconnector data.
Produces a JSON file of ~65k winter hourly records for correlated JS validation.

Output: scripts/winter_validation_data.json
"""

import numpy as np
import pandas as pd
import json
import os
from pathlib import Path

ROOT = Path(__file__).parent.parent
NPZ_PATH = ROOT / "docs" / "validate" / "era5_zone_timeseries.npz"
NESO_DIR = ROOT / "docs" / "validate" / "neso"
OUTPUT_PATH = ROOT / "scripts" / "winter_validation_data.json"

# Zone order must match the NPZ file
# Interconnector mapping: NESO CSV column → zone_id
IC_ZONE_MAP = {
    "IFA_FLOW": "GZ26",
    "IFA2_FLOW": "GZ26",
    "BRITNED_FLOW": "GZ24",
    "MOYLE_FLOW": "GZ10",
    "EAST_WEST_FLOW": "GZ19",
    "NEMO_FLOW": "GZ26",
    "NSL_FLOW": "GZ13",
    "ELECLINK_FLOW": "GZ26",
    "VIKING_FLOW": "GZ15",
    "GREENLINK_FLOW": "GZ19",
}

# Total built IC capacity per zone (for computing import percentage)
IC_CAPACITY = {
    "GZ26": 5000,  # IFA + IFA2 + Nemo + ElecLink
    "GZ24": 1000,  # BritNed
    "GZ10": 500,   # Moyle
    "GZ19": 500,   # East-West
    "GZ13": 1400,  # NSL
    "GZ15": 1400,  # Viking
}

def load_neso_csvs():
    """Load all NESO demand CSVs into a single DataFrame with hourly timestamps."""
    frames = []
    for year in range(2009, 2026):
        path = NESO_DIR / f"neso_demand_{year}.csv"
        if not path.exists():
            print(f"  Skipping {path.name} (not found)")
            continue
        df = pd.read_csv(path)
        # Convert settlement date + period to datetime
        # Period 1 = 00:00-00:30, Period 2 = 00:30-01:00, etc.
        df["datetime"] = pd.to_datetime(df["SETTLEMENT_DATE"], format="mixed", dayfirst=True)
        df["datetime"] += pd.to_timedelta((df["SETTLEMENT_PERIOD"] - 1) * 30, unit="m")
        frames.append(df)
        print(f"  Loaded {path.name}: {len(df)} rows")

    neso = pd.concat(frames, ignore_index=True)
    neso = neso.sort_values("datetime").reset_index(drop=True)

    # Resample to hourly (average of two half-hours)
    neso["hour"] = neso["datetime"].dt.floor("h")

    # Aggregate: mean for flows/demand, max for capacity
    agg_cols = {
        "TSD": "mean",
        "EMBEDDED_WIND_GENERATION": "mean",
        "EMBEDDED_SOLAR_GENERATION": "mean",
    }

    # Add IC flow columns (mean of two half-hours)
    for col in IC_ZONE_MAP.keys():
        if col in neso.columns:
            agg_cols[col] = "mean"

    hourly = neso.groupby("hour").agg(agg_cols).reset_index()
    hourly["timestamp_str"] = hourly["hour"].dt.strftime("%Y-%m-%d %H:%M")

    print(f"  Hourly records: {len(hourly)}")
    return hourly


def main():
    print("=== Loading ERA5 NPZ ===")
    npz = np.load(NPZ_PATH, allow_pickle=True)
    zone_ids = list(npz["zone_ids"])
    wind_cf = npz["wind_cf"]      # (140240, 27)
    solar_cf = npz["solar_cf"]    # (140240, 27)
    months = npz["months"]        # (140240,)
    timestamps = npz["timestamp_strs"]  # (140240,)

    n_hours = len(timestamps)
    print(f"  ERA5: {n_hours} hours, {len(zone_ids)} zones")
    print(f"  Time range: {timestamps[0]} to {timestamps[-1]}")
    print(f"  Zone order: {zone_ids[:5]}...")

    print("\n=== Loading NESO CSVs ===")
    neso = load_neso_csvs()

    # Build lookup: timestamp_str → row
    print("\n=== Aligning timestamps ===")
    neso_lookup = {}
    for _, row in neso.iterrows():
        neso_lookup[row["timestamp_str"]] = row

    # Winter months: Oct-Mar (matching our tool's "winter" season)
    winter_months = {10, 11, 12, 1, 2, 3}

    records = []
    matched = 0
    unmatched = 0

    for i in range(n_hours):
        month = int(months[i])
        if month not in winter_months:
            continue

        ts = str(timestamps[i])
        neso_row = neso_lookup.get(ts)

        if neso_row is None or pd.isna(neso_row.get("TSD", np.nan)):
            unmatched += 1
            continue

        # Extract wind/solar CFs for all 27 zones
        w_cf = wind_cf[i]  # (27,)
        s_cf = solar_cf[i]  # (27,)

        # National demand
        tsd = float(neso_row["TSD"])
        if tsd <= 0 or np.isnan(tsd):
            unmatched += 1
            continue

        # Embedded generation (reduces net transmission demand)
        emb_wind = float(neso_row.get("EMBEDDED_WIND_GENERATION", 0) or 0)
        emb_solar = float(neso_row.get("EMBEDDED_SOLAR_GENERATION", 0) or 0)

        # Interconnector flows per zone (positive = import to GB)
        ic_by_zone = {}
        total_ic = 0
        for col, zone in IC_ZONE_MAP.items():
            raw = neso_row.get(col, 0)
            flow = 0 if (raw is None or (isinstance(raw, float) and np.isnan(raw))) else float(raw)
            if zone not in ic_by_zone:
                ic_by_zone[zone] = 0
            ic_by_zone[zone] += flow
            total_ic += flow

        record = {
            "ts": ts,
            "month": month,
            "tsd_mw": round(tsd, 1),
            "emb_wind_mw": round(emb_wind, 1),
            "emb_solar_mw": round(emb_solar, 1),
            "total_ic_mw": round(total_ic, 1),
            "ic_by_zone": {z: round(v, 1) for z, v in ic_by_zone.items() if abs(v) > 0.1},
            "wind_cf": {zone_ids[j]: round(float(w_cf[j]), 5) for j in range(27)},
            "solar_cf": {zone_ids[j]: round(float(s_cf[j]), 5) for j in range(27)},
        }
        records.append(record)
        matched += 1

    print(f"  Winter hours matched: {matched}")
    print(f"  Winter hours unmatched: {unmatched}")

    # Stats
    tsds = [r["tsd_mw"] for r in records]
    ics = [r["total_ic_mw"] for r in records]
    winds = [np.mean(list(r["wind_cf"].values())) for r in records]

    print(f"\n=== STATS ===")
    print(f"  Demand: min={min(tsds):.0f}, max={max(tsds):.0f}, mean={np.mean(tsds):.0f} MW")
    print(f"  IC import: min={min(ics):.0f}, max={max(ics):.0f}, mean={np.mean(ics):.0f} MW")
    print(f"  Avg wind CF: min={min(winds):.3f}, max={max(winds):.3f}, mean={np.mean(winds):.3f}")

    # Wind-demand correlation
    corr = np.corrcoef(winds, tsds)[0, 1]
    print(f"  Wind-demand correlation: {corr:.3f}")

    # Wind-IC correlation
    corr_ic = np.corrcoef(winds, ics)[0, 1]
    print(f"  Wind-IC correlation: {corr_ic:.3f}")

    # Save
    output = {
        "metadata": {
            "description": "Aligned ERA5 weather + NESO demand/IC data for winter validation",
            "era5_range": f"{timestamps[0]} to {timestamps[-1]}",
            "season": "winter (Oct-Mar)",
            "n_records": len(records),
            "zone_ids": zone_ids,
            "ic_zone_map": IC_ZONE_MAP,
            "ic_capacity_mw": IC_CAPACITY,
        },
        "records": records,
    }

    with open(OUTPUT_PATH, "w") as f:
        json.dump(output, f)

    file_size = os.path.getsize(OUTPUT_PATH) / 1024 / 1024
    print(f"\n=== OUTPUT ===")
    print(f"  Saved to: {OUTPUT_PATH}")
    print(f"  Size: {file_size:.1f} MB")
    print(f"  Records: {len(records)}")


if __name__ == "__main__":
    main()
