#!/usr/bin/env python3
"""Join real census counts, GSI-derived elevations and Natural Earth coast masks.

Run --coast-only, then build-population.py and build-elevation.py, then this script
without --coast-only. Requires NumPy and Shapely 2.1+. The pinned Natural Earth
source downloads from public GitHub if absent.
Outputs are reproducible compact JSON; raw sources remain in ignored work/.
"""

from __future__ import annotations

import argparse
import base64
import csv
import gzip
import hashlib
import json
import math
from pathlib import Path
import sys
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parents[1]
TOOLS = ROOT / 'work' / 'data-tools'
if TOOLS.exists():
    sys.path.insert(0, str(TOOLS))

try:
    import numpy as np
    import shapely
    from shapely.geometry import shape
except ImportError as error:
    raise SystemExit('Install data dependencies: python3 -m pip install numpy shapely==2.1.2') from error

SOURCE_URL = 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/v5.1.2/geojson/ne_10m_admin_0_countries.geojson'
SOURCE_SHA256 = '239eec57ac17f100a11e2536cffc56752c318b50ae765b0918ff7aab4ce8f255'
GRID = {'west': 122, 'south': 20, 'lonStep': 1 / 16, 'latStep': 1 / 24, 'width': 512, 'height': 648, 'maskSize': 16}
EXPECTED_POPULATION = 126_146_099


def require(condition, message):
    if not condition:
        raise ValueError(message)


def sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def compact_write(path, document):
    path.parent.mkdir(parents=True, exist_ok=True)
    content = json.dumps(document, ensure_ascii=False, separators=(',', ':'), allow_nan=False).encode()
    path.write_bytes(content)
    return {'bytes': len(content), 'gzipBytes': len(gzip.compress(content, mtime=0)), 'sha256': hashlib.sha256(content).hexdigest()}


def round_coordinates(value):
    if isinstance(value, list):
        return [round_coordinates(item) for item in value]
    return round(value, 6)


def coastline(args):
    if not args.countries.exists():
        args.countries.parent.mkdir(parents=True, exist_ok=True)
        with urlopen(SOURCE_URL, timeout=60) as response:
            args.countries.write_bytes(response.read())
    require(sha256(args.countries) == SOURCE_SHA256, 'Natural Earth source SHA256 differs from pinned v5.1.2 data.')
    countries = json.loads(args.countries.read_text())
    features = [feature for feature in countries['features'] if feature['properties'].get('ADM0_A3') == 'JPN']
    require(len(features) == 1, 'Expected exactly one Japan feature in the pinned Natural Earth source.')
    geometry = {'type': features[0]['geometry']['type'], 'coordinates': round_coordinates(features[0]['geometry']['coordinates'])}
    coast = shape(geometry)
    require(coast.geom_type in ('Polygon', 'MultiPolygon') and coast.is_valid and not coast.is_empty, 'Invalid Japan coastline.')
    # The elevation aggregation must use this same polygon source and precision.
    if args.coastline.exists():
        previous = json.loads(args.coastline.read_text())
        previous_geometry = previous.get('geometry', previous)
        require(previous_geometry == geometry, 'Input coastline differs from the pinned Natural Earth Japan geometry.')
    else:
        args.coastline.parent.mkdir(parents=True, exist_ok=True)
        args.coastline.write_text(json.dumps({'type': 'Feature', 'properties': {'name': 'Japan', 'source': 'Natural Earth', 'version': '5.1.2'}, 'geometry': geometry}, ensure_ascii=False, separators=(',', ':')))
    shapely.prepare(coast)
    return coast, geometry


def read_csv(path):
    with path.open(newline='') as stream:
        rows = list(csv.DictReader(stream))
    indexed = {}
    for row in rows:
        ix, iy = int(row['ix']), int(row['iy'])
        require(0 <= ix < GRID['width'] and 0 <= iy < GRID['height'], f'Out-of-bounds input cell: {path}, {ix}, {iy}')
        identifier = iy * GRID['width'] + ix
        require(identifier not in indexed, f'Duplicate input cell: {path}, {identifier}')
        indexed[identifier] = row
    return indexed


def cell_fractions(coast):
    identifiers = np.arange(GRID['width'] * GRID['height'])
    x = GRID['west'] + identifiers % GRID['width'] * GRID['lonStep']
    y = GRID['south'] + identifiers // GRID['width'] * GRID['latStep']
    boxes = shapely.box(x, y, x + GRID['lonStep'], y + GRID['latStep'])
    touched = shapely.intersects(coast, boxes)
    fractions = np.zeros(len(identifiers))
    fractions[touched] = np.clip(shapely.area(shapely.intersection(coast, boxes[touched])) / (GRID['lonStep'] * GRID['latStep']), 0, 1)
    return fractions


def make_masks(coast, identifiers):
    identifiers = np.array(identifiers, dtype=np.int64)
    ix, iy = identifiers % GRID['width'], identifiers // GRID['width']
    offsets = (np.arange(GRID['maskSize']) + 0.5) / GRID['maskSize']
    longitudes = GRID['west'] + (ix[:, None, None] + offsets[None, None, :]) * GRID['lonStep']
    latitudes = GRID['south'] + (iy[:, None, None] + offsets[None, :, None]) * GRID['latStep']
    samples = shapely.contains_xy(coast, longitudes, latitudes)
    packed = np.packbits(samples, axis=2, bitorder='little')
    return {int(identifier): packed[index].tobytes() for index, identifier in enumerate(identifiers)}


def expected_dem_samples(coast, identifier):
    """Count source zoom9 pixel centres on land, including missing source tiles."""
    ix, iy = identifier % GRID['width'], identifier // GRID['width']
    west, south = GRID['west'] + ix * GRID['lonStep'], GRID['south'] + iy * GRID['latStep']
    east, north = west + GRID['lonStep'], south + GRID['latStep']
    pixels = 2**9 * 256
    mercator_y = lambda latitude: (1 - math.asinh(math.tan(math.radians(latitude))) / math.pi) / 2 * pixels
    x0, x1 = math.ceil((west + 180) / 360 * pixels - 0.5), math.ceil((east + 180) / 360 * pixels - 0.5)
    y0, y1 = math.ceil(mercator_y(north) - 0.5), math.ceil(mercator_y(south) - 0.5)
    longitudes = (np.arange(x0, x1) + 0.5) / pixels * 360 - 180
    latitudes = np.degrees(np.arctan(np.sinh(np.pi * (1 - 2 * (np.arange(y0, y1) + 0.5) / pixels))))
    return int(shapely.contains_xy(coast, longitudes[None, :], latitudes[:, None]).sum())


def number(row, key):
    return None if not row or row[key] == '' else float(row[key])


def point_lookup(longitude, latitude, cells_by_id, masks, coast):
    ix = math.floor((longitude - GRID['west']) / GRID['lonStep'])
    iy = math.floor((latitude - GRID['south']) / GRID['latStep'])
    identifier = iy * GRID['width'] + ix
    sub_x = min(15, max(0, math.floor(((longitude - GRID['west']) / GRID['lonStep'] - ix) * 16)))
    sub_y = min(15, max(0, math.floor(((latitude - GRID['south']) / GRID['latStep'] - iy) * 16)))
    mask = masks.get(identifier, bytes(32))
    return {'id': identifier, 'ix': ix, 'iy': iy, 'cell': cells_by_id.get(identifier), 'coastContainsPoint': bool(shapely.contains_xy(coast, longitude, latitude)), 'landMaskContainsPoint': bool(mask[sub_y * 2 + sub_x // 8] & (1 << (sub_x % 8)))}


def build(args):
    coast, coast_geometry = coastline(args)
    population = read_csv(args.population)
    terrain = read_csv(args.terrain)
    population_manifest = json.loads((ROOT / 'data-sources/population-manifest.json').read_text())
    terrain_metadata = json.loads(args.terrain.with_suffix('.metadata.json').read_text())
    require(sha256(args.population) == population_manifest['grid']['csvSha256'], 'Population CSV SHA256 differs from the verified source manifest.')
    require(sha256(args.terrain) == terrain_metadata['csvSha256'], 'Terrain CSV SHA256 differs from its build metadata.')
    require(sha256(args.coastline) == terrain_metadata['coastlineSha256'], 'Terrain CSV was generated with a different coastline.')
    require(sum(int(row['population']) for row in population.values()) == EXPECTED_POPULATION, 'Population total differs from official 2020 census.')
    fractions = cell_fractions(coast)
    positive_coast = set(map(int, np.flatnonzero(fractions > 0)))
    identifiers = sorted(positive_coast | set(population))
    masks = make_masks(coast, identifiers)
    cells = []
    quality_counts = {str(code): 0 for code in range(4)}
    all_zero_count = 0
    valid_expected_samples = 0
    valid_available_samples = 0
    for identifier in identifiers:
        row = terrain.get(identifier)
        pop = int(population[identifier]['population']) if identifier in population else 0
        status = row['coverageStatus'] if row else None
        require(status in (None, 'sampled', 'sampled-all-zero', 'coast-only-no-samples', 'outside-coast-nonzero'), f'Unexpected terrain status {status}.')
        if pop > 0 and fractions[identifier] == 0:
            quality = 3
        elif status == 'sampled-all-zero':
            quality = 1
        elif status == 'sampled':
            quality = 0
        else:
            quality = 2
        if status == 'sampled-all-zero':
            all_zero_count += 1
        if quality == 0:
            mean, maximum, relief = (number(row, key) for key in ('meanElevationM', 'maxElevationM', 'reliefM'))
            require(None not in (mean, maximum, relief), 'Available terrain is missing a height.')
            expected = expected_dem_samples(coast, identifier)
            available = int(row['sampleCount'])
            require(expected > 0 and available > 0, 'Available DEM has no expected or actual samples.')
            require(available <= expected + 1, 'Available DEM samples exceed expected land pixel centres.')
            coverage = min(1000, round(available / expected * 1000))
            valid_expected_samples += expected
            valid_available_samples += available
        else:
            mean, maximum, relief, coverage = None, None, None, 0
        fraction = number(row, 'landFraction') if row else None
        if fraction is None:
            fraction = sum(byte.bit_count() for byte in masks[identifier]) / 256
        land_permille = min(1000, max(0, round(fraction * 1000)))
        encoded_mask = base64.b64encode(masks[identifier]).decode('ascii')
        cells.append([identifier, pop, mean, maximum, relief, land_permille, coverage, encoded_mask, quality])
        quality_counts[str(quality)] += 1

    require(all_zero_count == 93, 'Expected 93 ambiguous all-zero DEM cells in the pinned input.')
    require(sum(cell[1] for cell in cells) == EXPECTED_POPULATION, 'Combined mesh lost population.')
    document = {'version': 1, 'populationYear': 2020, 'totalPopulation': EXPECTED_POPULATION, 'grid': GRID, 'cells': cells}
    mesh_stats = compact_write(args.output, document)
    coastline_stats = compact_write(args.coast_output, coast_geometry)
    by_id = {cell[0]: cell for cell in cells}
    city_coordinates = {'札幌': [141.35, 43.06], '青森': [140.74, 40.82], '仙台': [140.87, 38.27], '新潟': [139.02, 37.92], '東京': [139.70, 35.69], '名古屋': [136.91, 35.18], '金沢': [136.65, 36.56], '大阪': [135.50, 34.69], '神戸': [135.18, 34.69], '広島': [132.46, 34.39], '高松': [134.04, 34.34], '福岡': [130.40, 33.59], '熊本': [130.71, 32.80], '鹿児島': [130.56, 31.60], '那覇': [127.68, 26.21]}
    report = {
        'cellCount': len(cells), 'landCells': len(positive_coast), 'populationCells': len(population),
        'populationOnlyCells': len(set(population) - positive_coast),
        'populationOutsideCoast': sum(cell[1] for cell in cells if cell[8] == 3),
        'discardedOutsideCoastTerrainCells': len(set(terrain) - set(identifiers)),
        'nationalPopulation': sum(cell[1] for cell in cells), 'qualityCounts': quality_counts,
        'ambiguousAllZeroCells': all_zero_count,
        'availableDemSamples': valid_available_samples, 'expectedDemLandSamples': valid_expected_samples,
        'partialCoverageCells': sum(1 for cell in cells if cell[8] == 0 and cell[6] < 1000),
        'meanElevationRange': [min(cell[2] for cell in cells if cell[2] is not None), max(cell[2] for cell in cells if cell[2] is not None)],
        'maximumPixelElevationM': max(cell[3] for cell in cells if cell[3] is not None),
        'meshOutput': mesh_stats, 'coastlineOutput': coastline_stats,
        'samples': {name: point_lookup(lon, lat, by_id, masks, coast) for name, (lon, lat) in city_coordinates.items()},
        'fuji': point_lookup(138.7274, 35.3606, by_id, masks, coast),
        'dependencies': {'numpy': np.__version__, 'shapely': shapely.__version__},
    }
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    manifest = {
        'schemaVersion': 1, 'generator': 'scripts/build-game-mesh.py',
        'command': 'python3 scripts/build-game-mesh.py', 'grid': GRID,
        'populationManifest': 'data-sources/population-manifest.json',
        'elevationManifest': 'data-sources/elevation-manifest.json',
        'inputs': {'populationCsvSha256': sha256(args.population), 'terrainCsvSha256': sha256(args.terrain), 'coastlineFeatureSha256': sha256(args.coastline)},
        'coastline': {'dataset': 'Natural Earth 1:10m Admin 0 Countries', 'version': '5.1.2', 'countryFilter': "ADM0_A3 = 'JPN'", 'url': SOURCE_URL, 'sha256': SOURCE_SHA256, 'license': 'Public domain', 'licenseUrl': 'https://www.naturalearthdata.com/about/terms-of-use/', 'processing': 'Retain the Japan geometry including interior rings; round geographic coordinates to 6 decimal places; strip all source properties.'},
        'landMask': {'size': 16, 'bytesPerCell': 32, 'encoding': 'Base64; row0 is south, column0 is west; each row is 2 bytes, little-endian bits, x0 in least-significant bit.', 'sampling': 'Natural Earth polygon contains test at the centres of 16x16 subcells; holes are preserved.', 'landFraction': 'Rounded permille of actual polygon intersection area from the terrain CSV; mask fraction if unavailable.'},
        'demQualityCodes': {'0': 'Available sampled DEM including genuine zero and negative pixel values.', '1': 'All sampled DEM pixels were zero: ambiguous source fill; heights are null and coverage is 0.', '2': 'Missing DEM or no land pixel centre samples: heights are null and coverage is 0.', '3': 'Census population exists outside the generalized Natural Earth coastline: preserve population; heights are null and coverage is 0.'},
        'demCoverage': 'Available land source-pixel centres divided by expected land source-pixel centres at zoom9, rounded to permille. Ambiguous or missing cells have 0 coverage.',
        'missingValuePolicy': 'Never replace unavailable elevation with zero. Omit nonzero DEM outside Japan coastline unless needed to preserve census population.',
        'outputs': {'src/data/japan-mesh.json': mesh_stats, 'src/data/coastline.json': coastline_stats},
        'statistics': {key: value for key, value in report.items() if key not in ('samples', 'fuji', 'meshOutput', 'coastlineOutput')},
    }
    args.manifest.parent.mkdir(parents=True, exist_ok=True)
    args.manifest.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({key: value for key, value in report.items() if key != 'samples'}, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--population', type=Path, default=ROOT / 'work/data-sources/population/population-5km.csv')
    parser.add_argument('--terrain', type=Path, default=ROOT / 'work/data-sources/elevation/terrain-5km.csv')
    parser.add_argument('--countries', type=Path, default=ROOT / 'work/data-sources/coastline/countries.geojson')
    parser.add_argument('--coastline', type=Path, default=ROOT / 'work/data-sources/coastline/japan.geojson')
    parser.add_argument('--output', type=Path, default=ROOT / 'src/data/japan-mesh.json')
    parser.add_argument('--coast-output', type=Path, default=ROOT / 'src/data/coastline.json')
    parser.add_argument('--report', type=Path, default=ROOT / 'work/data-sources/game-mesh-build-report.json')
    parser.add_argument('--manifest', type=Path, default=ROOT / 'data-sources/game-mesh-manifest.json')
    parser.add_argument('--coast-only', action='store_true', help='Fetch/verify and extract Japan coastline before the elevation build.')
    args = parser.parse_args()
    if args.coast_only:
        _, geometry = coastline(args)
        result = compact_write(args.coast_output, geometry)
        print(json.dumps({'sourceUrl': SOURCE_URL, 'sourceSha256': SOURCE_SHA256, 'coastlineInput': str(args.coastline), 'geometryOutput': str(args.coast_output), **result}, indent=2))
    else:
        build(args)
