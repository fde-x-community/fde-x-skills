import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const skillRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const scriptsRoot = join(skillRoot, 'scripts');
const testRoot = realpathSync(join(skillRoot, 'tests'));

function pythonCommand() {
  const candidates = [process.env.PYTHON, process.platform === 'win32' ? 'python' : 'python3', 'python'].filter(Boolean);
  for (const executable of candidates) {
    const result = spawnSync(executable, ['--version'], { encoding: 'utf8' });
    if (result.status === 0) return executable;
  }
  throw new Error('Python 3 is required to run the existing run_list entry point');
}

const python = pythonCommand();

function withRequest(request, check) {
  const work = mkdtempSync(join(testRoot, '.run-list-'));
  const input = join(work, 'request.json');
  const output = join(work, 'output');
  writeFileSync(input, JSON.stringify(request), 'utf8');
  try {
    const result = spawnSync(python, ['-m', 'skill.run_list', '--input', input, '--output', output, '--dry-run'], {
      cwd: scriptsRoot,
      encoding: 'utf8',
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    });
    check({ result, output });
  } finally {
    const resolved = realpathSync(work);
    assert.ok(resolved.startsWith(testRoot + sep), 'Temporary test directory escaped tests/');
    rmSync(resolved, { recursive: true, force: true });
  }
}

test('known official product resolves without collecting or creating output', () => {
  withRequest({ products: [{ merchant: 'Vooglam', product: 'Okinawa', market: 'US' }] }, ({ result, output }) => {
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const data = JSON.parse(result.stdout.trim());
    assert.equal(data.status, 'resolved');
    assert.equal(data.products[0].url, 'https://www.vooglam.com/goods-detail/9999');
    assert.ok(Array.isArray(data.runtime_issues));
    assert.equal(existsSync(output), false);
  });
});

test('unknown product stops for clarification instead of choosing a search result', () => {
  withRequest({ products: [{ merchant: 'Vooglam', product: 'UnverifiedExampleModel', market: 'US' }] }, ({ result, output }) => {
    assert.equal(result.status, 2, result.stderr || result.stdout);
    const data = JSON.parse(readFileSync(join(output, 'clarification.json'), 'utf8'));
    assert.equal(data.status, 'needs_clarification');
    assert.equal(data.questions.length, 1);
    assert.match(data.questions[0].reason, /官网链接/);
    assert.equal(existsSync(join(output, 'dashboard')), false);
  });
});

test('unsupported market fails before collection', () => {
  withRequest({ products: [{ merchant: 'Vooglam', product: 'Okinawa', market: 'UK' }] }, ({ result, output }) => {
    assert.notEqual(result.status, 0);
    assert.match(result.stderr + result.stdout, /Vooglam.*US/);
    assert.equal(existsSync(output), false);
  });
});
