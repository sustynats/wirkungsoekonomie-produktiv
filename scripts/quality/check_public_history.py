#!/usr/bin/env python3
"""Reject private pre-publication history and identifiers in public commit metadata."""
from __future__ import annotations
import argparse
import json
import subprocess
from pathlib import Path
from public_privacy import text_issues

MARKER = '.github/public-source-baseline.json'
GENERATION = '2026-11-22-privacy-reviewed'


def git(root: Path, *args: str) -> str:
    return subprocess.check_output(['git', *args], cwd=root, stderr=subprocess.DEVNULL, text=True)


def check(root: Path, ref: str = 'HEAD') -> set[str]:
    issues = set()
    try:
        commit = git(root, 'rev-parse', '--verify', ref + '^{commit}').strip()
        if git(root, 'rev-parse', '--is-shallow-repository').strip() != 'false':
            return {'history-incomplete'}
        roots = git(root, 'rev-list', '--max-parents=0', commit).splitlines()
        if len(roots) != 1:
            return {'unrelated-private-history'}
        marker = json.loads(git(root, 'show', roots[0] + ':' + MARKER))
        if marker.get('generation') != GENERATION:
            issues.add('unapproved-public-history-root')
        for metadata in git(root, 'log', '--format=%an%n%ae%n%cn%n%ce%n%B%x00', commit).split('\0'):
            if text_issues(metadata):
                issues.add('private-identifier-in-commit-metadata')
        for email in git(root, 'log', '--format=%ae%n%ce', commit).splitlines():
            approved = (email.endswith('@users.noreply.github.com')
                        or email in {'noreply@github.com', 'web-flow@github.com'}
                        or email.endswith('@example.org'))
            if not approved:
                issues.add('unapproved-commit-email')
    except (subprocess.CalledProcessError, json.JSONDecodeError):
        issues.add('unapproved-public-history-root')
    return issues


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=Path('.'))
    parser.add_argument('--ref', default='HEAD')
    args = parser.parse_args()
    issues = sorted(check(args.root.resolve(), args.ref))
    print(json.dumps({'status': 'blocked' if issues else 'passed', 'issues': issues}))
    return 1 if issues else 0


if __name__ == '__main__':
    raise SystemExit(main())
