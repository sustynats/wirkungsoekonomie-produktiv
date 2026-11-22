#!/usr/bin/env python3
"""Package the authorised corrected labels as v2, preserving both supplied sets.

Requires Pillow. Example:
  python3 scripts/werteadvent/prepare-supplied-v2.py \
    --original-source /path/to/WerteAdvent_2026_24_Comic_Icons \
    --corrected-labels /path/to/WerteAdvent_Icons_korrigiert

Only repository copies of labelled PNGs, their WebP previews and the checksum
inventory change. Both supplied source directories and every v1 release file
are read-only inputs. This script never publishes or overwrites a v1 release.
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import shutil
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[2]


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def inventory(paths: list[Path]) -> dict[str, str]:
    return {str(p): digest(p) for p in sorted(paths) if p.is_file()}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--original-source', required=True, type=Path)
    parser.add_argument('--corrected-labels', required=True, type=Path)
    parser.add_argument('--assets', type=Path, default=ROOT / 'assets/werteadvent-2026')
    parser.add_argument('--v1-release', type=Path, default=ROOT / 'output/werteadvent-2026-release')
    parser.add_argument('--release', type=Path, default=ROOT / 'output/werteadvent-2026-release-v2')
    args = parser.parse_args()
    manifest = json.loads((args.original_source / 'manifest.json').read_text())
    assert [r['day'] for r in manifest] == list(range(1, 25))
    expected_labels = {Path(row['with_label']).name for row in manifest}
    actual_labels = {p.name for p in args.corrected_labels.glob('*.png')}
    if actual_labels != expected_labels:
        raise ValueError(f'Corrected labels do not match the 24-day manifest: {sorted(actual_labels ^ expected_labels)}')
    for row in manifest:
        for source in [args.original_source / row['with_label'], args.original_source / row['without_label'],
                       args.corrected_labels / Path(row['with_label']).name]:
            with Image.open(source) as im:
                assert im.size == (720, 720) and im.mode == 'RGBA', source
                assert im.getchannel('A').getextrema()[0] == 0, source
    if args.release.resolve() == args.v1_release.resolve():
        raise ValueError('v2 output must differ from the immutable v1 release directory')
    for source_dir in [args.original_source, args.corrected_labels]:
        if args.release.resolve().is_relative_to(source_dir.resolve()):
            raise ValueError('Never write release files into an original source directory')
    protected = list(args.original_source.rglob('*')) + list(args.corrected_labels.rglob('*'))
    protected += list(args.v1_release.rglob('*'))
    protected += list((args.assets / 'icons/Ohne_Beschriftung').glob('*.png'))
    protected += list(args.assets.glob('thumbnail-*.webp'))
    protected += [args.assets / 'sharepic.png', args.assets / 'qr-code.png']
    before = inventory(protected)
    spec = importlib.util.spec_from_file_location('werteadvent_assets', Path(__file__).with_name('prepare-assets.py'))
    helper = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(helper)
    args.release.mkdir(parents=True, exist_ok=True)
    copied_labels = []
    for row in manifest:
        source = args.corrected_labels / Path(row['with_label']).name
        destination = args.assets / 'icons' / row['with_label']
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, destination)
        assert source.read_bytes() == destination.read_bytes()
        helper.save_labelled_preview(source, args.assets / f'labelled-{row["day"]:02d}.webp',
                                     preserve_supplied_layout=True)
        copied_labels.append({'day': row['day'], 'file': row['with_label'], 'sha256': digest(destination)})
    asset_inventory = [{'path': f'icons/{row[key]}', 'sha256': digest(args.assets / 'icons' / row[key])}
                       for row in manifest for key in ['with_label', 'without_label']]
    (args.assets / 'original-sha256.json').write_text(json.dumps(asset_inventory, ensure_ascii=False, indent=2) + '\n')
    readme = args.release / 'README_v2.txt'
    readme.write_text(
        'Werte-Advent 2026 - Icon-Set, Version 2\n\n'
        'Die 24 beschrifteten PNGs stammen aus dem neu bereitgestellten korrigierten Icon-Set.\n'
        'Der zuvor zu grosse Abstand zwischen Motiv und Beschriftung wurde in dieser gelieferten Fassung korrigiert.\n'
        'Diese PNG-Dateien werden unveraendert uebernommen: 720 x 720 Pixel, transparenter RGBA-Hintergrund.\n'
        'Die Zuordnung von Tagen, Werten und Kategorien bleibt unveraendert.\n\n'
        'Die 24 unbeschrifteten Originale bleiben unveraendert. Das unbeschriftete ZIP,\n'
        'die 24 Hochformat-Vorlagen und das Konzept-PDF sind identische Kopien der ersten Version.\n'
        'Die urspruenglich bereitgestellten Dateien und die erste Veroeffentlichung bleiben erhalten.\n'
        'manifest.json enthaelt weiterhin die verbindliche Tageszuordnung.\n', encoding='utf-8')
    labels = [(args.corrected_labels / Path(row['with_label']).name, row['with_label']) for row in manifest]
    unlabelled = [(args.original_source / row['without_label'], row['without_label']) for row in manifest]
    metadata = [(args.original_source / name, name) for name in ['manifest.json', 'README.txt']]
    metadata.append((readme, 'README_v2.txt'))
    helper.package(args.release / 'WerteAdvent_2026_Icons_mit_Beschriftung_v2.zip', labels + metadata)
    helper.package(args.release / 'WerteAdvent_2026_24_Comic_Icons_v2.zip', labels + unlabelled + metadata)
    unchanged_files = ['WerteAdvent_2026_Icons_ohne_Beschriftung.zip',
                       'WerteAdvent_2026_Hochformat_Vorlagen.zip', 'WerteAdvent_2026_Konzept.pdf']
    for name in unchanged_files:
        shutil.copyfile(args.v1_release / name, args.release / name)
        assert (args.v1_release / name).read_bytes() == (args.release / name).read_bytes()
    after = inventory([Path(name) for name in before])
    if before != after:
        raise ValueError('A protected input or immutable v1 file changed')
    release_files = [p for p in sorted(args.release.iterdir()) if p.is_file() and p.name != 'sha256sums.txt']
    (args.release / 'sha256sums.txt').write_text(''.join(f'{digest(p)}  {p.name}\n' for p in release_files))
    print(json.dumps({'version': 2, 'corrected_labels': copied_labels,
                      'protected_files_unchanged': len(before),
                      'release_files': [{'name': p.name, 'sha256': digest(p), 'bytes': p.stat().st_size} for p in release_files]},
                     ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
