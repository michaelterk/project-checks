export default {
  testDirectory: 'test',
  pattern: 'test_*.py',
  command: ['python3', '-m', 'unittest', '{file}'],
  inputs: ['calculator.py', 'test/__init__.py', 'test/helpers', 'requirements*.txt', 'pyproject.toml'],
  resources: { memoryMiBPerWorker: 256, maxWorkers: 4 },
};
