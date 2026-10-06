import { readFile, writeFile } from 'node:fs/promises';
import { join, isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readV8Reports, mapV8CoveragePaths } from './coverage-paths.mjs';
import { inside } from './util.mjs';

const artifacts = JSON.parse(await readFile(process.env.PROJECT_CHECKS_COVERAGE_MANIFEST, 'utf8'));
const root = process.env.PROJECT_CHECKS_COVERAGE_ROOT;
let sequence = 0;
for (const artifact of artifacts) {
  const reports = readV8Reports(await readFile(artifact));
  if (root) await mapV8CoveragePaths(reports, path => {
    const file = resolve(root, path);
    if (isAbsolute(path) || !inside(root, file)) throw new Error('Covered source escapes its project root');
    return pathToFileURL(file).href;
  });
  for (const report of reports) {
    await writeFile(join(process.env.NODE_V8_COVERAGE, `coverage-${process.pid}-1000000000000-${sequence++}.json`), JSON.stringify(report));
  }
}
