import { readFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { dirname, join, resolve } from 'node:path';

export function cpuCapacity() {
  if (process.platform !== 'linux') return availableParallelism();
  const list = readFileSync('/proc/self/status', 'utf8').match(/^Cpus_allowed_list:\s*(.+)$/m)?.[1];
  if (!list) throw new Error('Could not detect CPU affinity');
  return list.split(',').reduce((count, range) => {
    const [first, last = first] = range.split('-').map(Number);
    return count + last - first + 1;
  }, 0);
}

export function cpuLimit({ read = readFileSync } = {}) {
  if (process.platform !== 'linux') return { cpus: Infinity, ownedScope: false };
  const membership = read('/proc/self/cgroup', 'utf8');
  const group = membership.match(/^0::(\/[^\n]*)$/m)?.[1];
  if (!group) throw new Error('CPU quota requires Linux cgroup v2');
  const ownedScope = group.split('/').some(name => /^project-checks-[0-9a-f-]+\.scope$/.test(name));
  const root = '/sys/fs/cgroup';
  let directory = resolve(root, `.${group}`);
  if (directory !== root && !directory.startsWith(`${root}/`)) throw new Error('Invalid cgroup membership');
  let cpus = Infinity;
  while (true) {
    let value;
    try { value = read(join(directory, 'cpu.max'), 'utf8'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (value !== undefined) {
      const fields = value.trim().split(/\s+/);
      const [maximum, period] = fields;
      if (fields.length !== 2 || !/^[1-9]\d*$/.test(period) || !(maximum === 'max' || /^[1-9]\d*$/.test(maximum))) throw new Error('Malformed kernel CPU quota');
      if (maximum !== 'max') cpus = Math.min(cpus, Number(maximum) / Number(period));
    }
    if (directory === root) break;
    directory = dirname(directory);
  }
  return { cpus, ownedScope };
}
