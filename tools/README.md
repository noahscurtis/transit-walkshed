Precompute Isochrones
=====================

This folder contains a small script to precompute Mapbox isochrones for stop
locations and write a combined GeoJSON. Precomputing isochrones server-side
(or once during a build step) avoids heavy client-side requests and improves
user experience.

Quick start
-----------

1. Install the requirements (create a virtualenv if you like):

```bash
cd /Users/turner/Geog328/transit-walkshed
pip install -r tools/requirements.txt
```

2. Run the script with your Mapbox token (or set the MAPBOX_ACCESS_TOKEN env var):

```bash
python tools/precompute_isochrones.py --token YOUR_MAPBOX_TOKEN
```

Default behavior:
- Reads all GeoJSON files in `assets/data/stops/`.
- Caches per-stop responses in `assets/isochrones/cache/` so the run is resumable.
- Writes combined output to `assets/isochrones/isochrones_{profile}_{minutes}.geojson`.

Options:
- `--profile` : `walking|cycling|driving` (default: `walking`)
- `--minutes` : contour minutes (default: 10)
- `--delay`   : seconds to wait between requests (default: 0.35)
- `--force`   : ignore cached responses and re-fetch everything

Notes and safety
----------------
- The script respects simple exponential backoff on 429 responses.
- Do not commit your Mapbox token to source control. Prefer using environment
  variables in automated runs.
- If you have many stops, consider increasing `--delay` to be gentler on the
  Mapbox API and avoid rate limiting.

If you want, I can also:
- Add a small Node.js variant if you prefer Node-based tooling.
- Extend the script to split output by region or to simplify polygons.
