import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { contentFingerprint } from '../src/inputs.mjs';

// Preserve existing cache keys, including collation and duplicate-file counts.
function previousFingerprint(identities) {
  const files = [];
  const visit = identity => {
    if (identity[0] === 'file') files.push([true, identity[1]]);
    else if (identity[0] === 'missing') files.push([false, null]);
    else if (identity[0] === 'directory') { files.push([true, null]); identity[1].forEach(([, child]) => visit(child)); }
    else if (identity[0] === 'symlink') visit(identity[2]);
    else if (identity[0] === 'cycle') files.push([true, null]);
    else throw new TypeError('Unknown file identity');
  };
  identities.forEach(visit);
  files.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b), 'en'));
  return createHash('sha256').update(JSON.stringify(files)).digest('hex');
}

test('optimized fingerprints retain prior keys for mixed trees, missing files and duplicate content', () => {
  const fixtures = [[], [['missing']], [['directory', []]], [
    ['directory', [['a', ['file', 'same']], ['b', ['file', 'same']], ['c', ['missing']]]],
    ['symlink', 'ignored-target', ['directory', [['x', ['file', 'á']], ['y', ['file', 'a']]]]],
    ['cycle', 'ignored-path'], ['file', 'quoted"\\\nvalue'], ['file', '漢字'],
  ]];
  for (const fixture of fixtures) assert.equal(contentFingerprint(fixture), previousFingerprint(fixture));
  assert.notEqual(contentFingerprint([['file', 'same']]), contentFingerprint([['file', 'same'], ['file', 'same']]));
});

test('optimized fingerprints retain prior keys across deterministic varied inventories', () => {
  for (let seed = 0; seed < 32; seed++) {
    const identities = Array.from({ length: 128 }, (_, index) => index % 11 === 0 ? ['missing']
      : ['file', createHash('sha256').update(`${seed}:${index % (seed + 1)}`).digest('hex')]);
    if (seed % 2) identities.reverse();
    assert.equal(contentFingerprint(identities), previousFingerprint(identities));
  }
});


test('canonical digest records retain exact legacy collation at every hexadecimal boundary', () => {
  const hashes = [];
  for (const first of '0123456789abcdef') for (const last of '0123456789abcdef') hashes.push(first + '0'.repeat(62) + last);
  const identities = [ ['missing'], ['directory', []], ['cycle', 'ignored'], ...hashes.reverse().map(hash => ['file', hash]) ];
  assert.equal(contentFingerprint(identities), previousFingerprint(identities));
  identities.push(['file', 'A'.repeat(64)], ['file', 'á'.repeat(64)], ['file', '\u0000'.repeat(64)]);
  assert.equal(contentFingerprint(identities), previousFingerprint(identities), 'mixed general records keep legacy Unicode collation');
});

test('canonical fingerprints preserve repeated roots, nested cycles and missing multiplicity', () => {
  const shared = ['directory', [['z', ['file', 'f'.repeat(64)]], ['a', ['file', '0'.repeat(64)]],
    ['missing', ['missing']], ['nested', ['directory', [['loop', ['cycle', '/ignored']]]]]]];
  const roots = [shared, ['file', 'a'.repeat(64)], shared, ['symlink', 'ignored', shared], ['missing']];
  assert.equal(contentFingerprint(roots), previousFingerprint(roots));
  assert.notEqual(contentFingerprint(roots), contentFingerprint(roots.slice(1)));
  assert.equal(contentFingerprint(roots.reverse()), previousFingerprint(roots));
});
