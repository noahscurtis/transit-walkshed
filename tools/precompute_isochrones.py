#!/usr/bin/env python3
"""
Precompute Mapbox Isochrones for a set of stops and save as a combined GeoJSON.

Usage:
  python tools/precompute_isochrones.py --token YOUR_MAPBOX_TOKEN

By default it reads all GeoJSON files under `assets/data/stops/` and writes
combined output to `assets/isochrones/isochrones_{profile}_{minutes}.geojson`.

The script uses per-stop caching in `assets/isochrones/cache/` so it can resume
and avoid re-requesting isochrones already fetched.

Notes:
- Set MAPBOX_ACCESS_TOKEN environment variable or pass --token.
- Default behavior is conservative: sequential fetching with retries and
  exponential backoff on 429 responses.
"""

import argparse
import json
import os
import time
import math
from typing import List

import requests
from tqdm import tqdm


def find_stop_files(stops_dir: str) -> List[str]:
    files = []
    for name in os.listdir(stops_dir):
        if name.lower().endswith('.geojson'):
            files.append(os.path.join(stops_dir, name))
    return files


def load_features_from_files(files: List[str]):
    features = []
    for f in files:
        with open(f, 'r', encoding='utf-8') as fh:
            data = json.load(fh)
            if 'features' in data:
                features.extend(data['features'])
    return features


def normalize_coords(geom):
    # return (lon, lat) or None
    if not geom:
        return None
    coords = geom.get('coordinates')
    gtype = geom.get('type')
    if gtype == 'Point':
        return coords[0], coords[1]
    if gtype == 'MultiPoint' and isinstance(coords, list) and len(coords) > 0:
        # MultiPoint often [[lon, lat]] - take first
        first = coords[0]
        if isinstance(first, list) and len(first) >= 2:
            return first[0], first[1]
    # try other nested shapes
    if isinstance(coords, list):
        # try to unwrap nested arrays
        try:
            # coords like [[lon, lat]]
            if isinstance(coords[0], list) and isinstance(coords[0][0], (int, float)):
                return coords[0][0], coords[0][1]
        except Exception:
            pass
    return None


def ensure_dir(path):
    if not os.path.exists(path):
        os.makedirs(path, exist_ok=True)


def request_isochrone(session, url, max_retries=6):
    backoff = 1.0
    for attempt in range(max_retries):
        try:
            resp = session.get(url, timeout=30)
        except Exception as e:
            print(f"Request exception (attempt {attempt+1}): {e}")
            time.sleep(backoff)
            backoff = min(backoff * 2, 60)
            continue

        if resp.status_code == 200:
            return resp.json()
        if resp.status_code == 429:
            # rate limited - exponential backoff
            wait = backoff + (attempt * 0.5)
            print(f"Rate limited (429). Backing off {wait:.1f}s (attempt {attempt+1})")
            time.sleep(wait)
            backoff = min(backoff * 2, 60)
            continue
        # other server errors: try a few times then skip
        if 500 <= resp.status_code < 600:
            wait = backoff
            print(f"Server error {resp.status_code}. Waiting {wait:.1f}s (attempt {attempt+1})")
            time.sleep(wait)
            backoff = min(backoff * 2, 60)
            continue

        # non-retryable error
        print(f"Unexpected response {resp.status_code}: {resp.text}")
        return None

    print("Max retries reached for URL:", url)
    return None


def main():
    parser = argparse.ArgumentParser(description='Precompute Mapbox isochrones for stops')
    parser.add_argument('--token', help='Mapbox access token (or set MAPBOX_ACCESS_TOKEN env var)')
    parser.add_argument('--stops-dir', default='assets/data/stops', help='Directory containing stop GeoJSON files')
    parser.add_argument('--out-dir', default='assets/isochrones', help='Output directory for isochrones and cache')
    parser.add_argument('--profile', default='walking', choices=['walking', 'cycling', 'driving'], help='Mapbox profile')
    parser.add_argument('--minutes', default=10, type=int, help='Contour minutes')
    parser.add_argument('--delay', default=0.35, type=float, help='Delay between requests in seconds')
    parser.add_argument('--sequential', action='store_true', help='Force fully sequential requests (disable concurrency)')
    parser.add_argument('--force', action='store_true', help='Overwrite output if exists')
    args = parser.parse_args()

    token = args.token or os.environ.get('MAPBOX_ACCESS_TOKEN')
    if not token:
        print('Provide a Mapbox token via --token or set MAPBOX_ACCESS_TOKEN')
        return

    stops_dir = args.stops_dir
    out_dir = args.out_dir
    ensure_dir(out_dir)
    cache_dir = os.path.join(out_dir, 'cache')
    ensure_dir(cache_dir)

    files = find_stop_files(stops_dir)
    if not files:
        print('No stop GeoJSON files found in', stops_dir)
        return

    features = load_features_from_files(files)
    # extract stop points
    stops = []
    for i, f in enumerate(features):
        geom = f.get('geometry')
        coords = normalize_coords(geom)
        if not coords:
            continue
        lon, lat = coords
        try:
            lon = float(lon); lat = float(lat)
        except Exception:
            continue
        props = f.get('properties') or {}
        stops.append({'lon': lon, 'lat': lat, 'properties': props, 'source_index': i})

    print(f'Found {len(stops)} stops')

    combined = {'type': 'FeatureCollection', 'features': []}
    session = requests.Session()

    base = f'https://api.mapbox.com/isochrone/v1/mapbox/{args.profile}/'

    for s in tqdm(stops, desc='Stops'):
        lon = s['lon']; lat = s['lat']
        key = f'{lon}_{lat}_{args.profile}_{args.minutes}'.replace('.', '_').replace('-', 'm')
        cache_file = os.path.join(cache_dir, f'{key}.json')

        data = None
        if os.path.exists(cache_file) and not args.force:
            try:
                with open(cache_file, 'r', encoding='utf-8') as fh:
                    data = json.load(fh)
            except Exception:
                data = None

        if not data:
            url = f"{base}{lon},{lat}?contours_minutes={args.minutes}&polygons=true&access_token={token}"
            data = request_isochrone(session, url)
            if not data:
                # skip on persistent failure
                print(f"Skipping stop {lon},{lat} due to fetch errors")
                continue
            try:
                with open(cache_file, 'w', encoding='utf-8') as fh:
                    json.dump(data, fh)
            except Exception as e:
                print('Warning: could not write cache file', cache_file, e)

            time.sleep(args.delay)

        # take first polygon feature if present
        feat = None
        if isinstance(data, dict) and 'features' in data and len(data['features']) > 0:
            feat = data['features'][0]
        elif isinstance(data, dict) and 'type' in data and data.get('type') == 'FeatureCollection':
            if 'features' in data and data['features']:
                feat = data['features'][0]
        elif isinstance(data, dict) and data.get('type') == 'Feature':
            feat = data

        if not feat:
            print('No feature in isochrone response for', lon, lat)
            continue

        # attach origin stop info
        feat['properties'] = feat.get('properties', {})
        feat['properties']['_origin_lon'] = lon
        feat['properties']['_origin_lat'] = lat
        feat['properties']['_source_index'] = s['source_index']
        feat['properties']['_stop_properties'] = s['properties']

        combined['features'].append(feat)

    out_file = os.path.join(out_dir, f'isochrones_{args.profile}_{args.minutes}.geojson')
    try:
        with open(out_file, 'w', encoding='utf-8') as fh:
            json.dump(combined, fh)
        print('Wrote combined isochrones to', out_file)
    except Exception as e:
        print('Failed to write combined output', e)


if __name__ == '__main__':
    main()
