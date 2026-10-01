import { execFileSync } from 'node:child_process';

export default {
  testDirectory: 'test',
  pattern: 'test_*.py',
  command: ['python3', '-m', 'unittest', '{file}'],
  inputs: ['calculator.py', 'test/__init__.py', 'test/helpers', 'requirements*.txt', 'pyproject.toml'],
  // Bind the installed interpreter to evidence; include your dependency
  // environment in inputs or this fingerprint when you add dependencies.
  fingerprint: () => execFileSync('python3', ['--version'], { encoding: 'utf8' }).trim(),
  resources: { memoryMiBPerWorker: 256, maxWorkers: 4 },
};
