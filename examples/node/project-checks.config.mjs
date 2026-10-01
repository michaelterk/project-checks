export default {
  testDirectory: 'test',
  inputs: ['src', 'package.json', 'package-lock.json', 'node_modules', 'test/helpers'],
  resources: { maxWorkers: 4 },
};
