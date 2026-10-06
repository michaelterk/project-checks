import { readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

const membership = value => value.match(/^0::(\/[^\n]*)$/m)?.[1];
const gone = error => ['ENOENT', 'ESRCH'].includes(error.code);

// Observe only this runner's quota scope, including child cgroups. These
// best-effort readings never participate in resource admission decisions.
export function createProcessSampler({ platform = process.platform, read = readFileSync, list = readdirSync } = {}) {
  let scope, group;
  try {
    if (platform !== 'linux') return () => null;
    group = membership(read('/proc/self/cgroup', 'utf8'));
    if (!group || group.split('/').some(part => ['.', '..'].includes(part))) return () => null;
    scope = resolve('/sys/fs/cgroup', `.${group}`);
    while (scope !== '/sys/fs/cgroup' && !/^project-checks-[0-9a-f-]+\.scope$/.test(basename(scope))) scope = dirname(scope);
    if (scope === '/sys/fs/cgroup') return () => null;
    group = scope.slice('/sys/fs/cgroup'.length);
  } catch { return () => null; }

  return () => {
    try {
      const groups = [scope], pids = new Set();
      for (let index = 0; index < groups.length; index++) {
        let value, entries;
        try {
          value = read(join(groups[index], 'cgroup.procs'), 'utf8');
          entries = list(groups[index], { withFileTypes: true });
        } catch (error) {
          if (index && gone(error)) continue;
          throw error;
        }
        // Bound diagnostic work; an incomplete inventory is unavailable.
        if (value.length > 131072) return null;
        for (const pid of value.trim().split(/\s+/).filter(Boolean)) {
          if (!/^[1-9]\d*$/.test(pid)) return null;
          pids.add(pid);
          if (pids.size > 8192) return null;
        }
        for (const entry of entries) if (entry.isDirectory() && !entry.isSymbolicLink()) {
          groups.push(join(groups[index], entry.name));
          if (groups.length > 128) return null;
        }
      }
      let total = pids.size, runnable = 0, statesAvailable = true;
      for (const pid of pids) {
        try {
          const currentGroup = membership(read(`/proc/${pid}/cgroup`, 'utf8'));
          if (!currentGroup) return null;
          if (currentGroup !== group && !currentGroup.startsWith(`${group}/`)) { total--; continue; }
          const stat = read(`/proc/${pid}/stat`, 'utf8');
          const end = stat.lastIndexOf(') ');
          if (stat.length > 65536 || !stat.startsWith(`${pid} (`) || end < 0 || !/^[A-Za-z] /.test(stat.slice(end + 2))) {
            statesAvailable = false;
          } else if (stat[end + 2] === 'R') runnable++;
        } catch (error) {
          if (gone(error)) total--;
          else statesAvailable = false;
        }
      }
      return { scope: group, total, runnable: statesAvailable ? runnable : null };
    } catch { return null; }
  };
}
