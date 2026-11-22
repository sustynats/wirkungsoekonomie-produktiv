import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

const root = fileURLToPath(new URL('../../', import.meta.url));
const workflow = fs.readFileSync(path.join(root, '.github/workflows/wirkungsticker-lagen.yml'), 'utf8');
const deploy = fs.readFileSync(path.join(root, '.github/workflows/deploy.yml'), 'utf8');

// Extract literal shell blocks only; a real YAML syntax check remains required.
function step(name) {
  const marker = '      - name: ' + name + '\n';
  const start = workflow.indexOf(marker);
  assert.ok(start >= 0, 'step exists: ' + name);
  assert.equal(workflow.indexOf(marker, start + 1), -1, 'unique step');
  const next = workflow.indexOf('\n      - name:', start + marker.length);
  const section = workflow.slice(start, next < 0 ? undefined : next);
  const run = section.indexOf('        run: |\n');
  assert.ok(run >= 0, 'literal run block');
  return section.slice(run + '        run: |\n'.length).split('\n').map(line => {
    assert.ok(!line || line.startsWith('          '), 'literal block indentation');
    return line.slice(10);
  }).join('\n').trimEnd();
}
function inline(name) {
  const found = [...step(name).matchAll(/node --input-type=module <<'NODE'\n([\s\S]*?)\nNODE/g)];
  assert.equal(found.length, 1, 'one inline Node block');
  return found[0][1];
}
function fixture(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lagen-workflow-'));
  try { return fn(dir); } finally { fs.rmSync(dir, {recursive: true, force: true}); }
}
function run(code, dir, {env = {}, now} = {}) {
  const clock = now ? 'const RealDate=Date;globalThis.Date=class extends RealDate{constructor(...args){super(...(args.length?args:[' + JSON.stringify(now) + ']));}};\n' : '';
  return spawnSync(process.execPath, ['--input-type=module'], {
    cwd: dir, input: clock + code, encoding: 'utf8',
    env: {...process.env, RUNNER_TEMP: dir, GITHUB_ENV: path.join(dir, 'env'),
      GITHUB_OUTPUT: path.join(dir, 'output'), ...env},
  });
}
function fakeWriter(dir, result) {
  fs.mkdirSync(path.join(dir, 'scripts/news'), {recursive: true});
  fs.writeFileSync(path.join(dir, 'scripts/news/lage-schreiben.mjs'),
    "import fs from 'node:fs';fs.writeFileSync('writer-invoked','yes');console.log(" + JSON.stringify(JSON.stringify(result)) + ');\n');
}
function fakeGit(dir, records) {
  const bin = path.join(dir, 'bin'); fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'git'), '#!/usr/bin/env node\n' +
    'const args=process.argv.slice(2);if(args[0]==="rev-parse"){console.log("a".repeat(40));}' +
    'else if(args[0]==="ls-files"||args[0]==="diff"){process.stdout.write(' + JSON.stringify(records.join('\0') + '\0') + ');}' +
    'else{process.exit(7);}\n', {mode: 0o700});
  return {PATH: bin + path.delimiter + process.env.PATH};
}

test('season selection accepts delayed runs and skips opposite-DST triggers before accessing the writer', () => {
  const cases = [
    ['2026-11-09T11:04:00Z', '4 5,11,17 * * *', true],
    ['2026-07-15T10:04:00Z', '4 4,10,16 * * *', true],
    ['2026-11-09T10:04:00Z', '4 4,10,16 * * *', false],
    ['2026-07-15T11:04:00Z', '4 5,11,17 * * *', false],
    ['2026-11-09T13:40:00Z', '4 5,11,17 * * *', true],
    ['2026-03-29T04:04:00Z', '4 4,10,16 * * *', true],
    ['2026-10-25T05:04:00Z', '4 5,11,17 * * *', true],
    ['2026-10-25T05:04:00Z', '4 4,10,16 * * *', false],
  ];
  for (const [now, schedule, expected] of cases) fixture(dir => {
    fakeWriter(dir, {status: 'ok', publication_needed: true});
    const result = run(inline('Check season and missing editions'), dir,
      {now, env: {EVENT_NAME: 'schedule', EVENT_SCHEDULE: schedule}});
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.readFileSync(path.join(dir, 'output'), 'utf8'), 'publication_needed=' + expected + '\n');
    assert.equal(fs.existsSync(path.join(dir, 'writer-invoked')), expected);
  });
});

test('manual publication checks due state and invalid due result cannot enable publication', () => {
  for (const value of [false, 'true']) fixture(dir => {
    fakeWriter(dir, {status: 'ok', publication_needed: value});
    const result = run(inline('Check season and missing editions'), dir,
      {now: '2026-11-09T15:50:00Z', env: {EVENT_NAME: 'workflow_dispatch', EVENT_SCHEDULE: ''}});
    assert.equal(fs.existsSync(path.join(dir, 'writer-invoked')), true);
    if (value === false) {
      assert.equal(result.status, 0, result.stderr);
      assert.equal(fs.readFileSync(path.join(dir, 'output'), 'utf8'), 'publication_needed=false\n');
    } else {
      assert.notEqual(result.status, 0);
      assert.equal(fs.existsSync(path.join(dir, 'output')), false);
    }
  });
});

test('midnight/no-change result stops downstream work and non-boolean changes fail closed', () => {
  for (const value of [false, true, 'true']) fixture(dir => {
    fakeWriter(dir, {status: value === false ? 'keine_lage_faellig' : 'ok', changed: value});
    const result = run(inline('Write missing editions of the current Berlin day'), dir);
    if (typeof value === 'boolean') {
      assert.equal(result.status, 0, result.stderr);
      assert.equal(fs.readFileSync(path.join(dir, 'output'), 'utf8'), 'changed=' + value + '\n');
    } else {
      assert.notEqual(result.status, 0);
      assert.equal(fs.existsSync(path.join(dir, 'output')), false);
    }
  });
});

test('canonical store guard allows edition edits and rejects changed or missing story bytes', () => fixture(dir => {
  const stores = path.join(dir, 'data/news'); fs.mkdirSync(stores, {recursive: true});
  fs.writeFileSync(path.join(stores, 'stories.json'), '{"fixture":true}');
  fs.writeFileSync(path.join(stores, 'lagen.json'), '{}');
  const env = fakeGit(dir, ['data/news/stories.json', 'data/news/lagen.json']);
  let result = run(inline('Record immutable canonical store bytes and base'), dir, {env});
  assert.equal(result.status, 0, result.stderr);
  fs.writeFileSync(path.join(stores, 'lagen.json'), '{"new":true}');
  result = run(inline('Verify canonical stores remain byte-identical'), dir, {env});
  assert.equal(result.status, 0, result.stderr);
  fs.writeFileSync(path.join(stores, 'stories.json'), '{"fixture":false}');
  result = run(inline('Verify canonical stores remain byte-identical'), dir, {env});
  assert.notEqual(result.status, 0); assert.match(result.stderr, /LAGEN_CANONICAL_STORE_CHANGED/);
  fs.unlinkSync(path.join(stores, 'stories.json'));
  result = run(inline('Verify canonical stores remain byte-identical'), dir, {env});
  assert.notEqual(result.status, 0);
}));

test('staged-file guard rejects canonical stores, app projections and unrelated changes', () => {
  const cases = [
    [['data/news/lagen.json', 'wirkungsticker/lage/2026-11-09-mittagslage/index.html'], true],
    [['data/news/lagen.json', 'data/news/stories.json'], false],
    [['data/news/lagen.json', 'wirkungsticker/data/app/feed.json.gz'], false],
    [['data/news/lagen.json', '.github/workflows/other.yml'], false],
    [['wirkungsticker/index.html'], false],
  ];
  for (const [records, valid] of cases) fixture(dir => {
    const result = run(inline('Commit and push only this publication'), dir, {env: fakeGit(dir, records)});
    assert.equal(result.status === 0, valid, result.stderr);
  });
});

test('embedded shell blocks parse without executing their commands', () => {
  for (const name of [
    'Check season and missing editions', 'Record immutable canonical store bytes and base',
    'Write missing editions of the current Berlin day', 'Verify canonical stores remain byte-identical',
    'Build and validate public edition output', 'Commit and push only this publication',
    'Publish the exact committed editions without push notifications',
  ]) {
    const result = spawnSync('bash', ['-n'], {input: step(name), encoding: 'utf8'});
    assert.equal(result.status, 0, result.stderr);
  }
});

test('publication excludes provider credentials and recovery and binds one silent release to its commit', () => {
  assert.doesNotMatch(workflow, /secrets\.|OPENAI_API_KEY|run-api\.mjs|sealed-raw-output|publish-git\.mjs|release-data\.mjs|import-approved-editorials|publish-push|WOEK_NEWS_NOW/);
  assert.match(workflow, /WOEK_NEWS_AI_ENABLED: "false"/);
  const command = step('Commit and push only this publication');
  assert.equal((command.match(/^git push /gm) || []).length, 1);
  assert.doesNotMatch(command, /^git (?:rebase|pull|reset) |--force/gm);
  assert.match(command, /test "\$\(git rev-parse FETCH_HEAD\)" = "\$LAGEN_SOURCE_BASE"/);
  assert.match(command, /check-git-size\.mjs --automatic --base="\$LAGEN_SOURCE_BASE" --head="\$PUBLISH_COMMIT"/);
  const publish = step('Publish the exact committed editions without push notifications');
  assert.equal((publish.match(/gh workflow run deploy\.yml/g) || []).length, 1);
  assert.match(publish, /-f "ticker_commit=\$TICKER_COMMIT" -f skip_ticker_notify=true/);
  assert.match(deploy, /skip_ticker_notify:\n(?:.*\n){0,4}        default: false\n        type: boolean/);
  assert.match(deploy, /notify-ticker:\n[\s\S]*?inputs\.skip_ticker_notify != true/);
});
