import { createHash } from 'node:crypto';
import { isAbsolute, relative, sep } from 'node:path';

export const digest = value => createHash('sha256').update(value).digest('hex');
export const slash = value => value.split(sep).join('/');
export const inside = (root, file) => {
  const name = relative(root, file);
  return name !== '..' && !name.startsWith(`..${sep}`) && !isAbsolute(name);
};

export function integer(value, label, minimum = 1) {
  if (!Number.isSafeInteger(value) || value < minimum) throw new TypeError(`${label} must be an integer >= ${minimum}`);
  return value;
}

export function inputLimit(value) {
  if (!Number.isSafeInteger(value) || value < 1) {
    const received = value === null ? 'null' : `${typeof value} ${typeof value === 'string' ? JSON.stringify(value) : String(value)}`;
    throw new TypeError(`inputConcurrency must be a positive safe integer; received ${received}`);
  }
  return value;
}

export function text(value, label) {
  if (typeof value !== 'string' || !value.length || value.includes('\0')) throw new TypeError(`${label} must be a nonempty string without NUL characters`);
  return value;
}

export function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  return value;
}

export function keys(value, allowed, label) {
  object(value, label);
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new TypeError(`Unknown ${label} option: ${key}`);
}

export function command(value) {
  if (!Array.isArray(value) || !value.length) throw new TypeError('command must be a nonempty argument array');
  text(value[0], 'command executable');
  for (const argument of value.slice(1)) {
    if (typeof argument !== 'string' || argument.includes('\0')) throw new TypeError('command arguments must be strings without NUL characters');
  }
  return value;
}
