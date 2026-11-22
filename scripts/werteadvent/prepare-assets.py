#!/usr/bin/env python3
"""Prepare the authorised original campaign graphics without redrawing icons.

Requires Pillow, fonttools[woff], qrcode. Example:
  python3 scripts/werteadvent/prepare-assets.py --source /path/to/icon-folder --pdf /path/to/concept.pdf
Refresh only compact labelled WebP previews without touching published originals or packages:
  python3 scripts/werteadvent/prepare-assets.py --source /path/to/icon-folder --labelled-only
Use --supplied-labels /path/to/corrected-labels with --labelled-only to preserve an
already corrected layout. For a new immutable v2 package use prepare-supplied-v2.py.
Output packages use deterministic ZIP metadata. Original PNG/PDF bytes are preserved.
"""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import shutil
import zipfile
from functools import lru_cache
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont, ImageOps

ROOT = Path(__file__).resolve().parents[2]
URL = 'https://wirkungsoekonomie.de/werteadvent/'
INK = '#19283f'
PAPER = '#fffdf8'
PALE = {'Mensch': '#ffe7e3', 'Planet': '#e1f3e9', 'Demokratie': '#e4effb'}
COLORS = {'Mensch': '#ba3b43', 'Planet': '#236a4e', 'Demokratie': '#225b8d'}
QUESTIONS = [
    'Ist jeder Mensch gleich viel wert?',
    'Muss ich jede Meinung teilen, um respektvoll zu sein?',
    'Wann haben andere für dich eingestanden?',
    'Was ist gerecht und was nur gleich?',
    'Wo endet meine Freiheit?',
    'Was gibt Menschen echte Sicherheit?',
    'Wie entsteht Vertrauen und wie geht es verloren?',
    'Sollte Gesundheit vom Geld abhängen?',
    'Hat jedes Kind dieselben Chancen?',
    'Wo erleben wir noch Ungleichbehandlung?',
    'Was gewinnen wir durch Unterschiede?',
    'Was sollten wir der nächsten Generation hinterlassen?',
    'Was bedeutet Verantwortung fürs Klima?',
    'Wie viel brauchen wir wirklich?',
    'Welchen Wert hat Natur unabhängig von ihrem Nutzen?',
    'Warum werfen wir Wertvolles weg?',
    'Wie gestalten wir die Energieversorgung der Zukunft?',
    'Sollte gutes Essen für alle möglich sein?',
    'Was bedeutet Demokratie im Alltag?',
    'Warum brauchen auch Mehrheiten Grenzen?',
    'Wie gehen wir mit anderen Meinungen um?',
    'Wer wird gehört und wer nicht?',
    'Wo endet unsere Verantwortung für andere?',
    'In welcher Welt wollen wir morgen leben?',
]


@lru_cache(maxsize=32)
def font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont:
    from fontTools.ttLib import TTFont
    path = ROOT / 'assets/fonts' / f'source-sans-3-{700 if bold else 400}.woff2'
    converted = TTFont(path)
    converted.flavor = None
    data = io.BytesIO()
    converted.save(data)
    data.seek(0)
    return ImageFont.truetype(data, size)


def text_lines(text: str, typeface: ImageFont.FreeTypeFont, width: int) -> list[str]:
    draw = ImageDraw.Draw(Image.new('RGB', (1, 1)))
    lines, current = [], ''
    for word in text.split():
        candidate = f'{current} {word}'.strip()
        if current and draw.textlength(candidate, font=typeface) > width:
            lines.append(current)
            current = word
        else:
            current = candidate
    if current:
        lines.append(current)
    return lines


def wrapped(draw: ImageDraw.ImageDraw, text: str, xy: tuple[int, int], typeface: ImageFont.FreeTypeFont,
            width: int, fill: str = INK, spacing: int = 10, centered: bool = False) -> int:
    x, y = xy
    line_height = typeface.size + spacing
    for line in text_lines(text, typeface, width):
        line_x = x + (width - draw.textlength(line, font=typeface)) / 2 if centered else x
        draw.text((line_x, y), line, font=typeface, fill=fill, stroke_width=0)
        y += line_height
    return y


def cleaned_source_icon(path: Path) -> Image.Image:
    im = Image.open(path).convert('RGBA')
    # Some supplied sheet cutouts retain a few pixels of a neighbouring icon.
    # Remove only those outlying fragments in derived graphics; downloads above
    # always retain the byte-for-byte original. Never reconstruct clipped artwork.
    day = int(path.name[:2])
    labelled = path.parent.name == 'Mit_Beschriftung'
    cleanup = ImageDraw.Draw(im)
    if day in [9, 10, 23]:
        cleanup.rectangle((465, 0, 719, 500), fill=(0, 0, 0, 0))
    if day == 23:
        cleanup.rectangle((0, 0, 719, 160 if labelled else 270), fill=(0, 0, 0, 0))
    if day == 24:
        cleanup.rectangle((0, 0, 719, 175 if labelled else 285), fill=(0, 0, 0, 0))
    return im


def icon(path: Path, size: tuple[int, int]) -> Image.Image:
    im = cleaned_source_icon(path)
    bbox = im.getchannel('A').point(lambda alpha: 255 if alpha >= 16 else 0).getbbox()
    if not bbox:
        raise ValueError(f'Empty icon: {path}')
    im = im.crop(bbox)
    return ImageOps.contain(im, size, method=Image.Resampling.LANCZOS)


def save_labelled_preview(source: Path, destination: Path, preserve_supplied_layout: bool = False) -> dict:
    """Move the complete original label nearer its motif; never redraw or trim text."""
    im = Image.open(source).convert('RGBA') if preserve_supplied_layout else cleaned_source_icon(source)
    alpha = im.getchannel('A')
    occupied_rows = [y for y in range(im.height) if alpha.crop((0, y, im.width, y + 1)).getbbox()]
    # The widest entirely transparent internal band separates the complete motif
    # from its original caption. Smaller gaps inside two-line captions stay intact.
    gaps = [(bottom - top - 1, top + 1, bottom)
            for top, bottom in zip(occupied_rows, occupied_rows[1:]) if bottom - top > 1]
    if not gaps and not preserve_supplied_layout:
        raise ValueError(f'No transparent motif/caption gap: {source}')
    gap, start, end = max(gaps) if gaps else (0, 0, 0)
    if preserve_supplied_layout:
        # A later authorised set already fixes the spacing. Preserve every pixel
        # in those source images and only resize the complete composition.
        compact = im
        target_gap = None
    else:
        if gap < 100:
            raise ValueError(f'Unexpected motif/caption spacing; inspect before changing: {source}')
        target_gap = 18
        compact = Image.new('RGBA', (im.width, im.height - gap + target_gap))
        compact.paste(im.crop((0, 0, im.width, start)), (0, 0))
        compact.paste(im.crop((0, end, im.width, im.height)), (0, start + target_gap))
        # Pixel-for-pixel checks before resizing prove no visible motif or caption
        # content was removed, including accents and both rows of long captions.
        assert compact.crop((0, 0, im.width, start)).tobytes() == im.crop((0, 0, im.width, start)).tobytes()
        assert compact.crop((0, start + target_gap, im.width, compact.height)).tobytes() == im.crop((0, end, im.width, im.height)).tobytes()
    bounds = compact.getchannel('A').getbbox()
    content = ImageOps.contain(compact.crop(bounds), (352, 352), method=Image.Resampling.LANCZOS)
    preview = Image.new('RGBA', (384, 384))
    preview.alpha_composite(content, ((384 - content.width) // 2, (384 - content.height) // 2))
    preview.save(destination, format='WEBP', quality=82, method=6, exact=True)
    return {'day': int(source.name[:2]), 'source_gap_px': gap, 'compact_gap_px': target_gap,
            'caption_preserved': True, 'supplied_layout_preserved': preserve_supplied_layout,
            'path': str(destination)}


def place(canvas: Image.Image, im: Image.Image, box: tuple[int, int, int, int]) -> None:
    x, y, w, h = box
    canvas.paste(im, (x + (w - im.width) // 2, y + (h - im.height) // 2), im)


def package(target: Path, files: list[tuple[Path, str]]) -> None:
    with zipfile.ZipFile(target, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for source, name in sorted(files, key=lambda x: x[1]):
            info = zipfile.ZipInfo(name, date_time=(2026, 11, 19, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            z.writestr(info, source.read_bytes(), compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, required=True)
    parser.add_argument('--pdf', type=Path)
    parser.add_argument('--labelled-only', action='store_true', help='Refresh only the 24 labelled WebP previews')
    parser.add_argument('--supplied-labels', type=Path,
                        help='Use already corrected labelled PNGs verbatim, with their supplied layout')
    parser.add_argument('--assets', type=Path, default=ROOT / 'assets/werteadvent-2026')
    parser.add_argument('--release', type=Path, default=ROOT / 'output/werteadvent-2026-release')
    args = parser.parse_args()
    if args.supplied_labels and not args.labelled_only:
        parser.error('Use prepare-supplied-v2.py to package corrected labels without changing v1 release files')
    manifest = json.loads((args.source / 'manifest.json').read_text())
    assert [r['day'] for r in manifest] == list(range(1, 25))
    assert len(QUESTIONS) == len(manifest)
    args.assets.mkdir(parents=True, exist_ok=True)
    if args.labelled_only:
        results = [save_labelled_preview(
            args.supplied_labels / Path(row['with_label']).name if args.supplied_labels else args.source / row['with_label'],
            args.assets / f'labelled-{row["day"]:02d}.webp', preserve_supplied_layout=args.supplied_labels is not None)
            for row in manifest]
        print(json.dumps({'labelled_previews': results}, ensure_ascii=False, indent=2))
        return
    if args.pdf is None:
        parser.error('--pdf is required unless --labelled-only is used')
    args.release.mkdir(parents=True, exist_ok=True)
    templates = args.release / 'hochformat-vorlagen'
    templates.mkdir(exist_ok=True)
    asset_inventory = []
    for row in manifest:
        day, category = row['day'], row['category']
        for key in ['with_label', 'without_label']:
            source = args.source / row[key]
            dest = args.assets / 'icons' / row[key]
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, dest)
            assert source.read_bytes() == dest.read_bytes()
            asset_inventory.append({'path': f'icons/{row[key]}', 'sha256': hashlib.sha256(dest.read_bytes()).hexdigest()})
        preview = Image.new('RGBA', (240, 240))
        place(preview, icon(args.source / row['without_label'], (208, 208)), (0, 0, 240, 240))
        preview.save(args.assets / f'thumbnail-{day:02d}.webp', format='WEBP', quality=88, method=4, exact=True)
        # The labelled preview is optional in the UI; the complete original remains downloadable.
        save_labelled_preview(args.source / row['with_label'], args.assets / f'labelled-{day:02d}.webp')
        canvas = Image.new('RGB', (1080, 1920), PAPER)
        d = ImageDraw.Draw(canvas)
        d.rectangle((0, 0, 1080, 20), fill=COLORS[category])
        d.text((90, 115), 'WERTE-ADVENT 2026', font=font(44, True), fill=INK)
        d.rounded_rectangle((90, 225, 990, 315), radius=25, fill=PALE[category], outline=INK, width=3)
        d.text((125, 242), f'{day:02d}. DEZEMBER 2026', font=font(40, True), fill=COLORS[category])
        category_type = font(34, True)
        d.text((955 - d.textlength(category, font=category_type), 250), category, font=category_type, fill=COLORS[category])
        place(canvas, icon(args.source / row['without_label'], (470, 440)), (240, 380, 600, 460))
        title_end = wrapped(d, row['value'], (85, 910), font(76, True), 910, spacing=8, centered=True)
        question_y = max(1135, title_end + 65)
        question_end = wrapped(d, QUESTIONS[day - 1], (115, question_y), font(49), 850, spacing=10, centered=True)
        hashtag_y = max(1465, question_end + 75)
        hashtag_font = font(52, True)
        hashtag = '#WerteAdvent'
        d.text(((1080 - d.textlength(hashtag, font=hashtag_font)) / 2, hashtag_y), hashtag, font=hashtag_font, fill=COLORS[category])
        # Open space below the hashtag leaves room for a creator's own branding.
        d.text((90, 1780), '24 Tage. 24 Werte. Deine Perspektive.', font=font(29), fill=INK)
        canvas.save(templates / f'WerteAdvent_2026_Tag_{day:02d}.png', optimize=True)
    for name in ['manifest.json']:
        shutil.copyfile(args.source / name, args.assets / 'icons' / name)
    (args.assets / 'original-sha256.json').write_text(json.dumps(asset_inventory, ensure_ascii=False, indent=2) + '\n')
    with_label = [(args.source / r['with_label'], r['with_label']) for r in manifest]
    without_label = [(args.source / r['without_label'], r['without_label']) for r in manifest]
    metadata = [(args.source / n, n) for n in ['manifest.json', 'README.txt']]
    package(args.release / 'WerteAdvent_2026_Icons_mit_Beschriftung.zip', with_label + metadata)
    package(args.release / 'WerteAdvent_2026_Icons_ohne_Beschriftung.zip', without_label + metadata)
    package(args.release / 'WerteAdvent_2026_24_Comic_Icons.zip', with_label + without_label + metadata)
    package(args.release / 'WerteAdvent_2026_Hochformat_Vorlagen.zip', [(p, p.name) for p in templates.glob('*.png')])
    shutil.copyfile(args.pdf, args.release / args.pdf.name)
    share = Image.new('RGB', (1200, 630), PAPER)
    d = ImageDraw.Draw(share)
    d.rectangle((0, 0, 400, 12), fill='#e96f70')
    d.rectangle((400, 0, 800, 12), fill='#4a9d7e')
    d.rectangle((800, 0, 1200, 12), fill='#4a8fbd')
    d.text((55, 53), '1.-24. DEZEMBER 2026 · TIKTOK', font=font(23, True), fill=INK)
    d.text((50, 106), 'WERTE-', font=font(84, True), fill=INK)
    d.text((50, 191), 'ADVENT 2026', font=font(69, True), fill=INK)
    d.text((55, 306), '24 Tage. 24 Werte.', font=font(39, True), fill=INK)
    d.text((55, 358), 'Hunderte Perspektiven.', font=font(34), fill=INK)
    d.rounded_rectangle((55, 438, 419, 505), radius=18, fill=INK)
    d.text((80, 446), '#WerteAdvent', font=font(36, True), fill='#ffffff')
    for index, row in enumerate(manifest):
        x, y = 641 + (index % 6) * 83, 108 + (index // 6) * 102
        d.rounded_rectangle((x, y, x + 75, y + 91), radius=12, fill=PALE[row['category']])
        place(share, icon(args.source / row['without_label'], (56, 55)), (x + 5, y + 6, 65, 57))
        num = f'{row["day"]:02d}'
        nf = font(20, True)
        d.text((x + (75 - d.textlength(num, font=nf)) / 2, y + 64), num, font=nf, fill=INK)
    d.text((55, 565), 'Mitmachen & weitersagen: wirkungsoekonomie.de/werteadvent/', font=font(25), fill=INK)
    share.save(args.assets / 'sharepic.png', optimize=True)
    import qrcode
    qr = qrcode.QRCode(version=None, error_correction=qrcode.constants.ERROR_CORRECT_M, box_size=16, border=4)
    qr.add_data(URL)
    qr.make(fit=True)
    qr.make_image(fill_color=INK, back_color='white').convert('RGB').save(args.assets / 'qr-code.png', optimize=True)
    print(json.dumps({'icons_original': len(asset_inventory), 'previews': 48, 'templates': 24,
                      'release_files': [p.name for p in args.release.iterdir() if p.is_file()],
                      'assets': str(args.assets), 'release': str(args.release)}, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
