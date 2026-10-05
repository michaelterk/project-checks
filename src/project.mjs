import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig } from './config.mjs';
import { keys } from './util.mjs';

// A project selects named targets, expands nested owners and returns definitions
// for one runChecks invocation. Loading never launches commands or test workers.
export async function loadChecks(filename, { target = 'default', files, filters, cache, frameworkArgs, prefix = '', ancestors = [] } = {}) {
  const path = resolve(filename);
  if (ancestors.includes(path)) throw new Error(`Project include cycle: ${path}`);
  const directory = dirname(path);
  const projectSource = await readFile(path, 'utf8');
  const project = JSON.parse(projectSource);
  keys(project, ['checks', 'targets'], 'project');
  const wanted = Array.isArray(target) ? target : project.targets?.[target];
  if (!Array.isArray(wanted)) throw new Error(`Unknown check target: ${target}`);
  const selected = new Set(), visiting = new Set();
  function visit(id) {
    if (visiting.has(id)) throw new Error(`Check dependency cycle: ${id}`);
    if (selected.has(id)) return;
    const definition = project.checks?.[id];
    if (!definition) throw new Error(`Unknown check: ${id}`);
    keys(definition, ['config', 'fixture', 'command', 'cwd', 'env', 'dependsOn', 'project', 'target'], 'project check');
    visiting.add(id);
    for (const dependency of definition.dependsOn ?? []) visit(dependency);
    visiting.delete(id);
    selected.add(id);
  }
  wanted.forEach(visit);
  const groups = new Map();
  for (const id of selected) {
    const definition = project.checks[id];
    if (definition.project) {
      groups.set(id, await loadChecks(resolve(directory, definition.project), {
        target: definition.target, files, filters, cache, frameworkArgs, prefix: `${prefix}${id}/`, ancestors: [...ancestors, path],
      }));
    } else {
      const cwd = resolve(directory, definition.cwd ?? '.');
      const sources = new Map([[path, projectSource]]);
      const value = { verify: async () => { for (const [file, source] of sources) if (await readFile(file, 'utf8') !== source) throw new Error(`Check configuration changed: ${file}`); }, id: `${prefix}${id}`, dependsOn: [], ...(definition.command ? { command: definition.command, cwd, env: definition.env } : {
        config: async context => {
          let config = await loadConfig(resolve(directory, definition.config), { sources });
          if (definition.fixture) {
            const fixture = await import(pathToFileURL(resolve(directory, definition.fixture)));
            config = { ...config, ...await fixture.default(config, context) };
          }
          if (files?.length) config.files = files;
          if (filters?.length) config.filters = filters;
          if (cache !== undefined) config.cache = cache;
          if (frameworkArgs?.length && config.engine === 'playwright') config.frameworkArgs = frameworkArgs;
          return config;
        },
      }) };
      groups.set(id, [value]);
    }
  }
  for (const id of selected) {
    const dependencies = (project.checks[id].dependsOn ?? []).flatMap(dependency => groups.get(dependency).map(check => check.id));
    for (const check of groups.get(id)) {
      check.dependsOn = [...new Set([...(check.dependsOn ?? []), ...dependencies])];
      const verify = check.verify;
      check.verify = async () => {
        if (await readFile(path, 'utf8') !== projectSource) throw new Error(`Check configuration changed: ${path}`);
        await verify?.();
      };
    }
  }
  return [...groups.values()].flat();
}
