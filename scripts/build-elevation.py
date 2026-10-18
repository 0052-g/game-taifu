#!/usr/bin/env python3
"""Aggregate pinned GSI-derived elevation tiles onto the game's JIS-compatible 5km grid.

Requires Python 3.10+, NumPy, Pillow, Shapely 2.1+, and curl only when downloading.
Install data tools with: python -m pip install numpy Pillow 'shapely>=2.1'

Example:
  python scripts/build-elevation.py --download \
    --coastline work/data-sources/coastline/japan.geojson \
    --output work/data-sources/elevation/terrain-5km.csv

Without --coastline, this is an explicitly unmasked nonzero-height inspection export;
it cannot distinguish land from sea and should not be used for game terrain.
"""

from __future__ import annotations

import argparse
import concurrent.futures
import csv
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
# The managed development workspace keeps optional data tools outside the app.
LOCAL_TOOLS = ROOT / 'work' / 'data-tools'
if LOCAL_TOOLS.exists():
    sys.path.insert(0, str(LOCAL_TOOLS))

try:
    import numpy as np
    from PIL import Image
    import shapely
except ImportError as error:
    raise SystemExit("Install data dependencies: python -m pip install numpy Pillow 'shapely>=2.1'") from error


def load_geometry(path: Path):
    document = json.loads(path.read_text())
    if document.get('type') == 'FeatureCollection':
        geometry = shapely.union_all([shapely.geometry.shape(f['geometry']) for f in document['features']])
    elif document.get('type') == 'Feature':
        geometry = shapely.geometry.shape(document['geometry'])
    else:
        geometry = shapely.geometry.shape(document)
    if geometry.is_empty or not shapely.is_valid(geometry):
        raise ValueError('Coastline must be a nonempty valid Polygon or MultiPolygon.')
    shapely.prepare(geometry)
    return geometry


def ensure_tiles(manifest, folder: Path, download: bool):
    def ensure(tile):
        relative = tile['path']
        if not re.fullmatch(r'9/\d+/\d+\.png', relative):
            raise ValueError(f'Unexpected tile path: {relative}')
        path = folder / relative
        if not path.exists():
            if not download:
                raise FileNotFoundError(f'{path} is missing; pass --download to retrieve pinned tiles.')
            path.parent.mkdir(parents=True, exist_ok=True)
            temporary = path.with_suffix('.part')
            subprocess.run([
                'curl', '--fail', '--silent', '--show-error', '--location', '--retry', '2',
                '--max-time', '40', '-o', str(temporary), manifest['downloadBase'] + relative,
            ], check=True)
            temporary.replace(path)
        data = path.read_bytes()
        if len(data) != tile['size'] or hashlib.sha256(data).hexdigest() != tile['sha256']:
            raise ValueError(f'Checksum mismatch: {path}')
        return path

    with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
        return list(pool.map(ensure, manifest['tiles']))


def build(args):
    manifest = json.loads(args.manifest.read_text())
    grid = manifest['grid']
    columns, rows = grid['columns'], grid['rows']
    size = columns * rows
    coast = load_geometry(args.coastline) if args.coastline else None
    paths = ensure_tiles(manifest, args.tiles_dir, args.download)
    count = np.zeros(size, dtype=np.int64)
    zero_count = np.zeros(size, dtype=np.int64)
    raw_nonzero_count = np.zeros(size, dtype=np.int64)
    height_sum = np.zeros(size, dtype=np.float64)
    minimum = np.full(size, np.inf)
    maximum = np.full(size, -np.inf)

    for path, tile in zip(paths, manifest['tiles']):
        zoom, tile_x, tile_y = map(int, tile['path'].removesuffix('.png').split('/'))
        rgba = np.asarray(Image.open(path).convert('RGBA'), dtype=np.int32)
        height = -10_000 + (rgba[:, :, 0] * 65_536 + rgba[:, :, 1] * 256 + rgba[:, :, 2]) * 0.1
        n = 2 ** zoom
        pixel_x = tile_x + (np.arange(256) + 0.5) / 256
        pixel_y = tile_y + (np.arange(256) + 0.5) / 256
        longitudes = pixel_x / n * 360 - 180
        latitudes = np.degrees(np.arctan(np.sinh(np.pi * (1 - 2 * pixel_y / n))))
        longitude, latitude = np.meshgrid(longitudes, latitudes)
        ix = np.floor((longitude - grid['west']) / grid['longitudeStep']).astype(int)
        iy = np.floor((latitude - grid['south']) / grid['latitudeStep']).astype(int)
        in_grid = (ix >= 0) & (ix < columns) & (iy >= 0) & (iy < rows) & (rgba[:, :, 3] > 0)
        nonzero = height != 0
        flat = iy * columns + ix
        np.add.at(raw_nonzero_count, flat[in_grid & nonzero], 1)
        if coast is None:
            selected = in_grid & nonzero
        else:
            selected = in_grid & shapely.contains_xy(coast, longitude, latitude)
        cells, samples = flat[selected], height[selected]
        np.add.at(count, cells, 1)
        np.add.at(zero_count, cells, samples == 0)
        np.add.at(height_sum, cells, samples)
        np.minimum.at(minimum, cells, samples)
        np.maximum.at(maximum, cells, samples)

    land_fraction = np.full(size, np.nan)
    if coast is not None:
        # Polygon area ratios in geographic coordinates are sufficient within each
        # small cell; the ratio uses identical units for the numerator/denominator.
        indices = np.arange(size)
        x = grid['west'] + (indices % columns) * grid['longitudeStep']
        y = grid['south'] + (indices // columns) * grid['latitudeStep']
        boxes = shapely.box(x, y, x + grid['longitudeStep'], y + grid['latitudeStep'])
        touched = shapely.intersects(coast, boxes)
        land_fraction[:] = 0
        land_fraction[touched] = np.clip(
            shapely.area(shapely.intersection(coast, boxes[touched]))
            / (grid['longitudeStep'] * grid['latitudeStep']), 0, 1,
        )
        included = (land_fraction > 0) | (count > 0) | (raw_nonzero_count > 0)
    else:
        included = raw_nonzero_count > 0

    args.output.parent.mkdir(parents=True, exist_ok=True)
    status_counts = {}
    with args.output.open('w', newline='') as stream:
        writer = csv.writer(stream)
        writer.writerow([
            'ix', 'iy', 'meanElevationM', 'maxElevationM', 'reliefM', 'sampleCount',
            'minElevationM', 'zeroSampleCount', 'nonzeroSampleCount', 'landFraction',
            'rawNonzeroSampleCount', 'coverageStatus',
        ])
        for index in np.flatnonzero(included):
            samples = int(count[index])
            if coast is None:
                status = 'unmasked-nonzero'
            elif samples:
                status = 'sampled-all-zero' if zero_count[index] == samples else 'sampled'
            elif land_fraction[index] > 0:
                status = 'coast-only-no-samples'
            else:
                status = 'outside-coast-nonzero'
            status_counts[status] = status_counts.get(status, 0) + 1
            writer.writerow([
                index % columns, index // columns,
                f'{height_sum[index] / samples:.1f}' if samples else '',
                f'{maximum[index]:.1f}' if samples else '',
                f'{maximum[index] - minimum[index]:.1f}' if samples else '',
                samples, f'{minimum[index]:.1f}' if samples else '',
                int(zero_count[index]), samples - int(zero_count[index]),
                f'{land_fraction[index]:.6f}' if coast is not None else '',
                int(raw_nonzero_count[index]), status,
            ])

    summary = {
        'grid': grid,
        'manifestSha256': hashlib.sha256(args.manifest.read_bytes()).hexdigest(),
        'coastlineSha256': hashlib.sha256(args.coastline.read_bytes()).hexdigest() if args.coastline else None,
        'sourceRepository': manifest['sourceRepository'],
        'sourceCommit': manifest['commit'],
        'sourceZoom': manifest['zoom'],
        'tileCount': len(paths),
        'sourceBytes': sum(tile['size'] for tile in manifest['tiles']),
        'outputCells': int(included.sum()),
        'landSampleCount': int(count.sum()),
        'coverageStatuses': status_counts,
        'csvSha256': hashlib.sha256(args.output.read_bytes()).hexdigest(),
        'aggregation': 'Arithmetic mean, min, max, and max-minus-min of available zoom9 pixel centres inside the coastline; includes genuine zero and negative samples. No missing elevation is filled.',
        'missing': 'Empty elevation values are missing. sampled-all-zero is explicitly flagged because original tile zero cannot distinguish real zero from fill. outside-coast-nonzero flags coastline generalization differences.',
        'maxMeaning': 'Maximum resampled zoom9 pixel elevation, not the maximum of the original approximately 10m DEM.',
        'dependencies': {'numpy': np.__version__, 'shapely': shapely.__version__},
    }
    args.output.with_suffix('.metadata.json').write_text(json.dumps(summary, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps(summary, ensure_ascii=False))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--manifest', type=Path, default=ROOT / 'data-sources/elevation-manifest.json')
    parser.add_argument('--tiles-dir', type=Path, default=ROOT / 'work/data-sources/elevation/tiles')
    parser.add_argument('--coastline', type=Path, help='Actual WGS84 Polygon/MultiPolygon or GeoJSON Feature/FeatureCollection.')
    parser.add_argument('--output', type=Path, default=ROOT / 'work/data-sources/elevation/terrain-5km.csv')
    parser.add_argument('--download', action='store_true', help='Download missing pinned tiles and verify every SHA-256.')
    build(parser.parse_args())
