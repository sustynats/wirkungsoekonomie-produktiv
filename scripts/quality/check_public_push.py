#!/usr/bin/env python3
"""Check outgoing commit history and every new blob before Git uploads it."""
from __future__ import annotations
import json
import subprocess
import sys
import tempfile
from pathlib import Path
from check_public_history import check
from public_privacy import inspect_file


def verify(root: Path, updates: str) -> set[str]:
    issues = set()
    seen = set()
    for update in updates.splitlines():
        _, local, _, remote = update.split()
        if set(local) == {'0'}:
            continue
        issues.update(check(root, local))
        if issues:
            continue
        revisions = [local]
        if set(remote) != {'0'}:
            revisions.append('^' + remote)
        try:
            objects = subprocess.check_output(
                ['git', 'rev-list', '--objects', *revisions], cwd=root, text=True
            ).splitlines()
            with tempfile.TemporaryDirectory(prefix='public-push-check-') as folder:
                for entry in objects:
                    oid, _, name = entry.partition(' ')
                    if oid in seen:
                        continue
                    seen.add(oid)
                    kind = subprocess.check_output(['git', 'cat-file', '-t', oid], cwd=root, text=True).strip()
                    if kind != 'blob':
                        continue
                    candidate = Path(folder) / (Path(name).name or 'source.txt')
                    candidate.write_bytes(subprocess.check_output(['git', 'cat-file', 'blob', oid], cwd=root))
                    try:
                        issues.update(inspect_file(candidate))
                    finally:
                        candidate.unlink()
        except Exception:
            issues.add('outgoing-source-cannot-be-verified')
    return issues


if __name__ == '__main__':
    root = Path(subprocess.check_output(['git', 'rev-parse', '--show-toplevel'], text=True).strip())
    findings = sorted(verify(root, sys.stdin.read()))
    print(json.dumps({'status': 'blocked' if findings else 'passed', 'issues': findings}))
    raise SystemExit(1 if findings else 0)
