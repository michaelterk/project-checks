import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';

const artifacts = JSON.parse(await readFile(process.env.PROJECT_CHECKS_COVERAGE_MANIFEST, 'utf8'));
let sequence = 0;
for (const artifact of artifacts) for (const report of JSON.parse(gunzipSync(await readFile(artifact)))) {
  await writeFile(join(process.env.NODE_V8_COVERAGE, `coverage-${process.pid}-1000000000000-${sequence++}.json`), JSON.stringify(report));
}
