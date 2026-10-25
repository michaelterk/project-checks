import { dirname, join, matchesGlob, relative, resolve } from 'node:path';
import { defaultDirectoryIgnore } from './config.mjs';
import { inside, slash } from './util.mjs';

// Cache path/rule decisions only; callers still obtain fresh filesystem metadata.

// Necessary conditions avoid parsing globs that cannot match; Node decides the rest.
function globRules(patterns) {
  const rules = patterns.map(pattern => {
    const simple = process.platform !== 'win32' && !/[\\{}[\]()!+@]/.test(pattern)
      && !pattern.split('/').some(part => part === '.' || part === '..');
    return { pattern,
      required: simple ? pattern.split('/').filter(part => part && !/[*?]/.test(part)) : [],
      suffix: simple ? /^\*\*\/\*(\.[a-zA-Z0-9_-]+)$/.exec(pattern)?.[1] : undefined };
  });
  return id => {
    const segments = new Set(id.split('/'));
    return rules.some(({ pattern, required, suffix }) => (!suffix || id.endsWith(suffix))
      && required.every(part => segments.has(part)) && matchesGlob(id, pattern));
  };
}

export function directoryExclusions(config, root, cache) {
  const { directories = [], files = [] } = config.directoryIgnore ?? defaultDirectoryIgnore;
  const ancestors = [];
  for (let file = root; inside(config.root, file); file = dirname(file)) {
    ancestors.push(slash(relative(config.root, file)));
    if (file === config.root) break;
  }
  const explicit = ancestors.some(id => directories.some(pattern => matchesGlob(id, pattern)));
  const patterns = explicit ? [...files] : [...directories, ...files];
  const key = JSON.stringify([config.root, patterns]);
  let values = cache?.get(key);
  if (!values) { values = new Map(); cache?.set(key, values); }
  const matches = globRules(patterns);
  return file => {
    if (values.has(file)) return values.get(file);
    const excluded = matches(slash(relative(config.root, file)));
    values.set(file, excluded);
    return excluded;
  };
}

export function inputExclusions(config, cache) {
  const key = JSON.stringify([config.root, config.cacheDirectory, config.ignore]);
  let values = cache.get(key);
  if (!values) cache.set(key, values = new Map());
  const literals = new Set(), patterns = [];
  for (const pattern of config.ignore) {
    if (process.platform !== 'win32' && !/[*?{}()[\]\\!+@]/.test(pattern)
      && pattern === slash(relative(config.root, resolve(config.root, pattern)))) literals.add(pattern);
    else patterns.push(pattern);
  }
  const matches = globRules(patterns);
  return file => {
    if (values.has(file)) return values.get(file);
    const id = slash(relative(config.root, file));
    const value = inside(config.cacheDirectory, file) || literals.has(id) || matches(id);
    values.set(file, value);
    return value;
  };
}

export function filterInputDirectory({ file, logical, names, root, config, excludedFiles }, caches) {
  const exclude = inputExclusions(config, caches.exclusions);
  const directoryExcluded = directoryExclusions(config, root, caches.directories);
  const excluded = excludedFiles instanceof Set ? excludedFiles : new Set(excludedFiles), kept = [];
  for (let index = 0; index < names.length; index++) {
    const physical = join(file, names[index]), path = join(logical, names[index]);
    if (!inside(config.cacheDirectory, physical) && !exclude(path) && !directoryExcluded(path)
      && !excluded.has(path) && !excluded.has(physical)) kept.push(index);
  }
  return kept;
}
