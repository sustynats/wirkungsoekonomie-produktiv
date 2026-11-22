"""Patch only newsletter wiring/privacy in the exact currently active Pages artifact."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tarfile

REPOSITORY = 'sustynats/wirkungsoekonomie-produktiv'
ORIGIN = 'https://130.162.217.58.sslip.io'
VERSION = '20261119-smtp-repair'
PARAGRAPHS = (
    ('Für den technischen Betrieb des Wirkungsportals', 'Für den technischen Betrieb des Wirkungsportals'),
    ('Nach erfolgreicher Newsletter-Bestätigung', 'Der bestehende Newsletter-Bestätigungsweg'),
)


def api(route):
    return json.loads(subprocess.check_output(['gh', 'api', f'repos/{REPOSITORY}/{route}']))


def active():
    for deployment in api('deployments?environment=github-pages&per_page=100'):
        statuses = api(f"deployments/{deployment['id']}/statuses")
        if statuses and statuses[0]['state'] == 'success':
            match = re.search(r'/actions/runs/(\d+)/', statuses[0].get('log_url', ''))
            if not match:
                raise ValueError('Active deployment source run is unavailable')
            return deployment, int(match[1])
    raise ValueError('No active production deployment')


def paragraph(html, start):
    matches = re.findall(r'<p\b[^>]*>' + re.escape(start) + r'[\s\S]*?</p>', html)
    if len(matches) != 1:
        raise ValueError('Expected privacy paragraph is missing or ambiguous: ' + start)
    return matches[0]


def patch_html(html, *, privacy_source=None):
    result = re.sub(
        r'(<script\b[^>]*\bsrc=["\'][^"\']*assets/js/newsletter\.js)(?:\?v=[^"\']*)?(["\'])',
        lambda m: m[1] + '?v=' + VERSION + m[2], html)

    def section(match):
        return re.sub(r'data-api-origin=["\']https://(?:parlament\.wirkungsoekonomie\.de|woek-parlament\.vercel\.app)["\']',
                      'data-api-origin="' + ORIGIN + '"', match[0])
    result = re.sub(r'<section\b(?=[^>]*\bdata-woek-newsletter(?:\s|>))[^>]*>', section, result)
    if privacy_source is not None:
        for old_start, new_start in PARAGRAPHS:
            result = result.replace(paragraph(result, old_start), paragraph(privacy_source, new_start), 1)
    return result


def inventory(directory):
    return {str(p.relative_to(directory)): hashlib.file_digest(p.open('rb'), 'sha256').hexdigest()
            for p in sorted(directory.rglob('*')) if p.is_file()}


def main():
    if os.environ['GITHUB_REPOSITORY'] != REPOSITORY:
        raise ValueError('Wrong production repository')
    temp = Path(os.environ['RUNNER_TEMP']) / 'newsletter-release'
    if '--verify-baseline' in os.sys.argv:
        proof = json.loads((temp / 'proof.json').read_text())
        if active()[0]['id'] != proof['baselineDeployment']:
            raise ValueError('Production changed; rebuild the candidate against the new baseline')
        print('Active baseline is unchanged')
        return
    temp.mkdir()
    deployment, run_id = active()
    run = api(f'actions/runs/{run_id}')
    if run['conclusion'] != 'success' or run['head_sha'] != deployment['sha']:
        raise ValueError('Active deployment and successful artifact source differ')
    artifacts = [a for a in api(f'actions/runs/{run_id}/artifacts')['artifacts']
                 if a['name'] == 'github-pages' and not a['expired']]
    if len(artifacts) != 1 or not re.fullmatch(r'sha256:[0-9a-f]{64}', artifacts[0].get('digest', '')):
        raise ValueError('No unambiguous immutable live artifact')
    artifact = artifacts[0]
    archive = temp / 'baseline.zip'
    with archive.open('wb') as output:
        subprocess.run(['gh', 'api', f'repos/{REPOSITORY}/actions/artifacts/{artifact["id"]}/zip'], stdout=output, check=True)
    # Reuse the existing production archive digest/path/link/domain validation.
    spec = importlib.util.spec_from_file_location('pages_republication', Path(__file__).with_name('prepare-pages-republication.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    module.verify_archive(archive, artifact, temp)
    output = temp / 'public'
    output.mkdir()
    with tarfile.open(temp / 'artifact.tar') as pages:
        pages.extractall(output, filter='data')
    archive.unlink()
    (temp / 'artifact.tar').unlink()
    before = inventory(output)
    if not {'assets/js/newsletter.js', 'datenschutz.html'}.issubset(before):
        raise ValueError('Newsletter source files are missing in the active artifact')
    privacy_source = Path('datenschutz.html').read_text()
    html_changes = []
    for p in sorted(output.rglob('*.html')):
        relative = str(p.relative_to(output))
        original = p.read_bytes()
        updated = patch_html(original.decode('utf-8'), privacy_source=privacy_source if relative == 'datenschutz.html' else None).encode('utf-8')
        if updated != original:
            p.write_bytes(updated)
            html_changes.append(relative)
    shutil.copyfile('assets/js/newsletter.js', output / 'assets/js/newsletter.js')
    after = inventory(output)
    allowed = set(html_changes) | {'assets/js/newsletter.js'}
    changed = {p for p in set(before) | set(after) if before.get(p) != after.get(p)}
    if set(after) != set(before) or not changed <= allowed:
        raise ValueError('Unexpected file additions, deletions or changes')
    proof = {'commit': os.environ['GITHUB_SHA'], 'baselineDeployment': deployment['id'],
             'baselineCommit': deployment['sha'], 'baselineRun': run_id,
             'artifactDigest': artifact['digest'], 'changedFiles': sorted(changed),
             'unchangedFiles': len(before) - len(changed), 'addedFiles': [], 'deletedFiles': [],
             'allowedHtmlEdits': ['newsletter script cache key', 'newsletter API origin', 'two newsletter privacy paragraphs'],
             'outsideAllowedChanges': []}
    (temp / 'proof.json').write_text(json.dumps(proof, indent=2) + '\n')
    with Path(os.environ['GITHUB_STEP_SUMMARY']).open('a') as summary:
        summary.write('### Newsletter repair\n\nExact active artifact retained. Only newsletter wiring and its privacy disclosure changed.\n\n'
                      + f'Changed files: {len(changed)}; identical files: {proof["unchangedFiles"]}. No additions or deletions.\n')
    print(json.dumps({k: v for k, v in proof.items() if k != 'changedFiles'}))


if __name__ == '__main__':
    main()
