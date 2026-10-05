import { writeFile } from 'node:fs/promises';
export default async function* coverageReporter(events) {
  for await (const event of events) {
    if (event.type === 'test:coverage') await writeFile(process.env.PROJECT_CHECKS_COVERAGE_REPORT, JSON.stringify(event.data.summary));
  }
}
