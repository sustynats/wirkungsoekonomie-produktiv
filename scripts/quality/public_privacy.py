#!/usr/bin/env python3
"""Fail closed on private filesystem references in source and delivered files.

Reports contain repository-relative filenames and finding classes only. Never
write the matched private value into a CI log or a public report.
"""
from __future__ import annotations

import argparse
import gzip
import html
import io
import json
import re
import subprocess
import sys
import zipfile
from pathlib import Path
from urllib.parse import unquote

HOME_PATH = re.compile(
    r"(?<![\w./])/(?:Users|home)/[A-Za-z0-9_.@-]+(?:/[^\s<>\"\x00]*)?"
    r"|[A-Z]:[\\/]+Users[\\/]+[A-Za-z0-9_.@-]+(?:[\\/][^\s<>\"\x00]*)?", re.I
)
FILE_URI = re.compile(r"\bfile:/+[A-Za-z0-9_~%.-][^\s<>`\"']*", re.I)
PRIVATE_MACHINE = re.compile(
    r"\b[A-Za-z0-9_.-]{1,64}@[A-Za-z0-9_.-]{1,253}\.(?:local|fritz\.box)\b"
    r"|\bMacBook(?:-Pro|-Air)?(?:-[A-Za-z0-9_.-]+)?\.(?:local|fritz\.box)\b", re.I
)
PRIVATE_ATTACHMENT = re.compile(r"/(?:private/)?tmp/codex-remote-attachments/[^\s<>\"']+")
TEMPORARY_PATH = re.compile(
    r"(?<![\w./])/(?:private/tmp|tmp|private/var|var/folders|Volumes)/[^\s<>`\"']+", re.I
)
OFFICE = {".docx", ".xlsx", ".pptx", ".odt", ".ods", ".odp"}
IMAGES = {".png", ".jpg", ".jpeg", ".webp", ".tif", ".tiff"}
MEDIA = {".mp3", ".mp4", ".m4a", ".wav", ".mov"}
CODE = {".py", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".sh", ".yml", ".yaml", ".patch"}
PUBLIC_AUTHORS = {"Natalie Weber", "Institut für Wirkungsökonomie", "Wirkungsökonomie", "Nats"}


def text_issues(value: str, *, source_code: bool = False) -> set[str]:
    value = str(value)
    for _ in range(2):
        value = html.unescape(unquote(value))
    value = value.replace("\\/", "/").replace("\\\\", "\\")
    found = set()
    if HOME_PATH.search(value):
        found.add("private-home-path")
    if PRIVATE_MACHINE.search(value):
        found.add("private-machine-identity")
    if PRIVATE_ATTACHMENT.search(value):
        found.add("private-attachment-path")
    if not source_code and TEMPORARY_PATH.search(value):
        found.add("local-temporary-path")
    # A source program can intentionally construct a local file URL. A literal
    # user home or attachment path is still forbidden by the independent rules.
    if not source_code and FILE_URI.search(value):
        found.add("local-file-uri")
    return found


def inspect_file(path: Path) -> set[str]:
    suffix = path.suffix.lower()
    findings = set()
    if suffix == ".pdf":
        import pymupdf

        with pymupdf.open(path) as document:
            if document.is_encrypted:
                raise ValueError("encrypted-pdf-cannot-be-verified")
            findings |= text_issues(json.dumps(document.metadata, ensure_ascii=False))
            findings |= text_issues(document.get_xml_metadata())
            for xref in range(1, document.xref_length()):
                obj = document.xref_object(xref, compressed=False)
                findings |= text_issues(obj)
                if document.xref_is_stream(xref) and re.search(
                    r"/Type\s*/Metadata|/Subtype\s*/XML", obj
                ):
                    findings |= text_issues(document.xref_stream(xref).decode("utf-8", "replace"))
            for page in document:
                findings |= text_issues(page.get_text())
                for link in page.get_links():
                    findings |= text_issues(json.dumps(link, default=str))
            for name in document.embfile_names():
                findings |= text_issues(json.dumps(document.embfile_info(name), ensure_ascii=False))
    elif suffix in OFFICE:
        import xml.etree.ElementTree as ET

        with zipfile.ZipFile(path) as archive:
            for name in archive.namelist():
                if name.endswith((".xml", ".rels", ".json", ".txt")):
                    value = archive.read(name).decode("utf-8", "replace")
                    findings |= text_issues(value)
                    if name == "docProps/core.xml":
                        for node in ET.fromstring(value).iter():
                            tag = node.tag.rsplit("}", 1)[-1]
                            if tag in {"creator", "lastModifiedBy"} and node.text and node.text.strip() not in PUBLIC_AUTHORS:
                                findings.add("unapproved-office-editor-identity")
                elif Path(name).suffix.lower() in IMAGES:
                    from PIL import Image

                    with Image.open(io.BytesIO(archive.read(name))) as image:
                        findings |= image_issues(image)
    elif suffix in IMAGES:
        from PIL import Image

        with Image.open(path) as image:
            findings |= image_issues(image)
    elif suffix == ".gz":
        findings |= text_issues(gzip.decompress(path.read_bytes()).decode("utf-8", "replace"))
    elif suffix in MEDIA:
        result = subprocess.run(
            ["ffprobe", "-v", "quiet", "-print_format", "json", "-show_format", "-show_streams", str(path)],
            capture_output=True, text=True, check=False,
        )
        if result.returncode:
            raise ValueError("media-metadata-cannot-be-verified")
        metadata = json.loads(result.stdout)
        # ffprobe adds the path supplied by this checker. It is not an embedded
        # metadata field and must not turn a private audit location into a leak.
        metadata.get("format", {}).pop("filename", None)
        encoded_metadata = json.dumps(metadata, ensure_ascii=False)
        findings |= text_issues(encoded_metadata)
        if re.search(r'com\.apple\.quicktime\.location|"location"\s*:', encoded_metadata, re.I):
            findings.add("media-location-metadata")
    else:
        data = path.read_bytes()
        if b"\x00" not in data[:8192]:
            findings |= text_issues(data.decode("utf-8", "replace"), source_code=suffix in CODE or path.name == "Dockerfile")
    return findings


def image_issues(image) -> set[str]:
    metadata = {str(k): v for k, v in image.info.items() if k != "icc_profile"}
    exif = image.getexif()
    metadata.update({f"exif:{k}": v for k, v in exif.items()})
    for ifd in (34665, 34853):
        nested = exif.get_ifd(ifd) if ifd in exif else {}
        if nested:
            metadata[f"ifd:{ifd}"] = nested
    # Interoperability is nested under Exif, not a top-level IFD. Pillow raises
    # KeyError if asked for an absent interoperability directory.
    if 40965 in metadata.get("ifd:34665", {}):
        metadata["ifd:40965"] = exif.get_ifd(40965)
    thumbnail = exif.get_ifd(1)
    if thumbnail:
        metadata["ifd:1"] = thumbnail
    findings = set()

    def inspect_value(value):
        if isinstance(value, bytes):
            # XP tags and EXIF UserComment can store UTF-16 rather than UTF-8.
            for payload in (value, value[8:]):
                for encoding in ("utf-8", "utf-16-le", "utf-16-be"):
                    findings.update(text_issues(payload.decode(encoding, "replace")))
        elif isinstance(value, dict):
            for item in value.values():
                inspect_value(item)
        elif isinstance(value, (list, tuple)):
            for item in value:
                inspect_value(item)
        else:
            findings.update(text_issues(str(value)))

    inspect_value(metadata)
    if 34853 in exif:
        findings.add("image-gps-metadata")
    return findings


def paths_for(root: Path, artifact: bool) -> list[Path]:
    if artifact:
        if not root.is_dir():
            raise ValueError("public-artifact-missing")
        return sorted(p for p in root.rglob("*") if p.is_file())
    output = subprocess.check_output(["git", "ls-files", "-z"], cwd=root)
    return [root / name.decode("utf-8") for name in output.split(b"\0") if name]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path("."))
    parser.add_argument("--artifact", action="store_true")
    parser.add_argument("--report", type=Path)
    args = parser.parse_args()
    root = args.root.resolve()
    failures = []
    checked = 0
    try:
        files = paths_for(root, args.artifact)
        for path in files:
            relative = path.relative_to(root).as_posix()
            if not path.is_file():
                failures.append({"path": relative, "issues": ["tracked-file-missing"]})
                continue
            try:
                findings = sorted(inspect_file(path))
            except Exception:
                findings = ["file-cannot-be-verified"]
            checked += 1
            if findings:
                failures.append({"path": relative, "issues": findings})
    except Exception:
        print(json.dumps({"status": "blocked", "error": "privacy-inventory-unavailable"}))
        return 1
    report = {"status": "blocked" if failures else "passed", "filesChecked": checked, "failures": failures}
    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"status": report["status"], "filesChecked": checked, "flaggedFiles": len(failures)}))
    for failure in failures[:40]:
        print(f"{failure['path']}: {', '.join(failure['issues'])}")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
