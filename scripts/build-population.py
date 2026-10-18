#!/usr/bin/env python3
"""Recover real 2020 census counts and aggregate them to an aligned 5km grid.

Install the two pinned packages listed in population-manifest.json first. Example:
  python3 -m pip install pmtiles==3.8.1 mapbox-vector-tile==2.2.0
  python3 scripts/build-population.py --download

The input mirror warns about duplicated records near source tile boundaries.
Only its unclustered maximum zoom is used; duplicates are resolved by the original
250m geographic mesh, with mismatching population values treated as an error.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import math
from pathlib import Path
from urllib.request import urlopen


PROJECT_ROOT = Path(__file__).resolve().parent.parent
MANIFEST_PATH = PROJECT_ROOT / 'data-sources' / 'population-manifest.json'
WORK_DIRECTORY = PROJECT_ROOT / 'work' / 'data-sources' / 'population'


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def geographic_point(z: int, x: int, y: int, px: int, py: int, extent: int) -> tuple[float, float]:
    longitude = (x + px / extent) / 2**z * 360 - 180
    latitude = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * (y + py / extent) / 2**z))))
    return longitude, latitude


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input', type=Path, default=WORK_DIRECTORY / 'population-points.pmtiles')
    parser.add_argument('--output', type=Path, default=WORK_DIRECTORY / 'population-5km.csv')
    parser.add_argument('--report', type=Path, default=WORK_DIRECTORY / 'population-build-report.json')
    parser.add_argument('--download', action='store_true', help='Download the pinned public GitHub mirror if input is missing.')
    args = parser.parse_args()
    manifest = json.loads(MANIFEST_PATH.read_text())

    if not args.input.exists():
        require(args.download, f'Input is missing: {args.input}; use --download or --input.')
        args.input.parent.mkdir(parents=True, exist_ok=True)
        # Keep inherited networking and TLS verification; do not bypass proxies.
        with urlopen(manifest['downloadUrl'], timeout=60) as response:
            args.input.write_bytes(response.read())

    raw = args.input.read_bytes()
    require(len(raw) == manifest['downloadBytes'], 'Source byte count differs from the pinned manifest.')
    raw_sha = hashlib.sha256(raw).hexdigest()
    require(raw_sha == manifest['downloadSha256'], 'Source SHA256 differs from the pinned manifest.')

    try:
        import mapbox_vector_tile
        from pmtiles.reader import MmapSource, Reader, all_tiles
    except ImportError as error:
        raise SystemExit('Install pmtiles==3.8.1 and mapbox-vector-tile==2.2.0 before running this script.') from error

    source_cells: dict[tuple[int, int], int] = {}
    raw_feature_count = 0
    raw_population = 0
    tile_count = 0
    with args.input.open('rb') as stream:
        source = MmapSource(stream)
        header = Reader(source).header()
        require(header['max_zoom'] == manifest['sourceMaxZoom'], 'Unexpected source maximum zoom.')
        for (zoom, x, y), data in all_tiles(source):
            if zoom != manifest['sourceMaxZoom']:
                continue
            tile_count += 1
            tile = mapbox_vector_tile.decode(data, default_options={'y_coord_down': True})
            layer = tile['population']
            extent = layer['extent']
            for feature in layer['features']:
                require(feature['geometry']['type'] == 'Point', 'Unexpected non-point source geometry.')
                require(not feature['properties'].get('clustered', False), 'Clustered records are not valid source cells.')
                population = feature['properties']['population']
                require(isinstance(population, int) and population > 0, 'Expected positive integer census population.')
                px, py = feature['geometry']['coordinates']
                longitude, latitude = geographic_point(zoom, x, y, px, py, extent)
                latitude_index = math.floor(latitude * 480)
                longitude_index = math.floor(longitude * 320)
                key = (latitude_index, longitude_index)
                if key in source_cells:
                    require(source_cells[key] == population, f'Conflicting population values in 250m source cell {key}.')
                else:
                    source_cells[key] = population
                raw_feature_count += 1
                raw_population += population

    require(raw_feature_count == manifest['sourceRawFeaturesAtMaxZoom'], 'Unexpected number of decoded source features.')
    require(len(source_cells) == manifest['uniqueSourceCells'], 'Unexpected number of unique source cells.')
    national_population = sum(source_cells.values())
    require(national_population == manifest['nationalPopulation'], 'National total differs from the 2020 census.')

    grid = manifest['grid']
    aggregated: dict[tuple[int, int], int] = {}
    for (latitude_index, longitude_index), population in source_cells.items():
        ix = longitude_index // 20 - grid['west'] * grid['longitudeDivisionsPerDegree']
        iy = latitude_index // 20 - grid['south'] * grid['latitudeDivisionsPerDegree']
        require(0 <= ix < grid['columns'] and 0 <= iy < grid['rows'], 'A national census cell falls outside the output bounds.')
        key = (ix, iy)
        aggregated[key] = aggregated.get(key, 0) + population
    require(len(aggregated) == grid['populatedCells'], 'Unexpected number of populated output cells.')
    require(sum(aggregated.values()) == national_population, 'Aggregation lost population.')

    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open('w', newline='') as stream:
        writer = csv.writer(stream, lineterminator='\n')
        writer.writerow(grid['csvColumns'])
        for (ix, iy), population in sorted(aggregated.items(), key=lambda item: (item[0][1], item[0][0])):
            writer.writerow((ix, iy, population))
    output_sha = hashlib.sha256(args.output.read_bytes()).hexdigest()
    require(args.output.stat().st_size == grid['csvBytes'], 'Derived CSV byte count differs from the manifest.')
    require(output_sha == grid['csvSha256'], 'Derived CSV SHA256 differs from the manifest.')

    report = {
        'sourceSha256': raw_sha,
        'sourceBytes': len(raw),
        'sourceTilesAtMaxZoom': tile_count,
        'sourceFeaturesAtMaxZoom': raw_feature_count,
        'rawPopulationBeforeDeduplication': raw_population,
        'uniqueSourceCells': len(source_cells),
        'duplicatesRemoved': raw_feature_count - len(source_cells),
        'conflictingSourceCells': 0,
        'nationalPopulation': national_population,
        'outputPopulatedCells': len(aggregated),
        'outputBytes': args.output.stat().st_size,
        'outputSha256': output_sha,
        'grid': grid,
    }
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({key: value for key, value in report.items() if key != 'grid'}, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
