import assert from 'node:assert/strict';
import { join, matchesGlob } from 'node:path';
import test from 'node:test';
import { createSnapshotContext } from '../src/inputs.mjs';
import { temporary } from './helpers.mjs';

test('ignore prefilters preserve native glob results for simple and complex patterns', async t => {
  const root = await temporary(t), context = createSnapshotContext();
  t.after(() => context.close());
  const paths = ['file.py', 'file.nbc', '.file.nbc', 'nested/file.py', 'nested/file.nbc',
    '.hidden/file.nbc', 'nested/.cache/file', '.venv/a/__pycache__/file',
    'foo/bar/file', 'foo/baz/file', 'canción/file', 'literal[1]/file'];
  const patterns = ['**/.cache/**', '.venv/**/__pycache__/**', '**/*.nbc', '**/*.py',
    'foo/**', './foo/**', 'foo/../bar/**', 'foo/{bar,baz}/**', 'foo/+(bar|baz)/**',
    '**/[a-z]*', 'literal\\[1\\]/**', 'canción/**', '**/file.?y', '**'];
  for (const pattern of patterns) {
    const config = { root, cacheDirectory: join(root, '.cache'), ignore: [pattern] };
    const excluded = context.excluded(config);
    const directoryExcluded = context.directoryExcluded({ ...config, directoryIgnore: { files: [pattern] } }, root);
    for (const path of paths) {
      assert.equal(excluded(join(root, path)), matchesGlob(path, pattern), `${pattern}: ${path}`);
      assert.equal(directoryExcluded(join(root, path)), matchesGlob(path, pattern), `${pattern}: directory ${path}`);
    }
  }
});
