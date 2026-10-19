import { existsSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

export function resetSourceURL(file, directory = process.env.RESET_SOURCE_DIR) {
  if (!directory || !isAbsolute(directory)) throw new Error('Set RESET_SOURCE_DIR to an absolute RESET checkout directory');
  if (!existsSync(directory) || !statSync(directory).isDirectory()) throw new Error('RESET_SOURCE_DIR must name an existing RESET checkout directory');
  const target = resolve(directory, file), inside = relative(directory, target);
  if (isAbsolute(inside) || inside === '..' || inside.startsWith('..' + sep)) throw new Error('RESET source file must be inside RESET_SOURCE_DIR');
  if (!existsSync(target) || !statSync(target).isFile()) throw new Error(`RESET_SOURCE_DIR is missing ${file}`);
  return pathToFileURL(target);
}
