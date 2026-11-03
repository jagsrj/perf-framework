// The shared drive: a folder (often a mounted network share) holding test scripts, their data
// files and JMeter plugins, so they don't have to be uploaded through the browser.
//
//   <PERF_SHARED_DIR>/scripts/<test>/checkout.jmx   + any CSV / data files next to it
//   <PERF_SHARED_DIR>/plugins/*.jar                 JMeter plugins and their dependency jars
//
// When a run starts, the script's folder and the selected plugins are copied into the run's
// bundle (results/<run-id>/bundle). That snapshot is what local containers mount and what remote
// load generators download, so later edits on the drive never change a run in progress.

import { cp, lstat, mkdir, readdir, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { httpError } from './http.js';

const SKIP = new Set(['.git', '.svn', 'node_modules', '.DS_Store']);

export function sharedPaths(config) {
  return {
    root: config.sharedDir,
    scripts: path.join(config.sharedDir, 'scripts'),
    plugins: path.join(config.sharedDir, 'plugins')
  };
}

// Resolve a user-supplied relative path inside `base`, refusing anything that escapes it
// (including through symbolic links).
export async function resolveInside(base, relativePath, what = 'file') {
  if (typeof relativePath !== 'string' || !relativePath.trim() || relativePath.includes('\0')) {
    throw httpError(400, `A ${what} path is required.`);
  }
  const normalised = path.normalize(relativePath.trim()).replace(/^([/\\])+/, '');
  const candidate = path.resolve(base, normalised);
  const relative = path.relative(base, candidate);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw httpError(400, `The ${what} path must be inside the shared drive.`);
  }
  let real;
  try {
    real = await realpath(candidate);
  } catch {
    throw httpError(404, `The ${what} "${relativePath}" was not found on the shared drive.`);
  }
  const realBase = await realpath(base);
  const realRelative = path.relative(realBase, real);
  if (realRelative.startsWith('..') || path.isAbsolute(realRelative)) {
    throw httpError(400, `The ${what} path must be inside the shared drive.`);
  }
  return { absolute: real, relative: relative.split(path.sep).join('/') };
}

async function walk(dir, base, { maxEntries = 5000 } = {}) {
  const found = [];
  async function visit(current) {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      if (SKIP.has(entry.name) || found.length >= maxEntries) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(full);
      else if (entry.isFile()) {
        const info = await stat(full);
        found.push({ path: path.relative(base, full).split(path.sep).join('/'), sizeBytes: info.size });
      }
    }
  }
  await visit(dir);
  return found;
}

// Lists the scripts (each with the files that travel with it) and the plugin jars.
export async function listShared(config) {
  const { scripts, plugins } = sharedPaths(config);
  const scriptFiles = await walk(scripts, scripts);
  const jmxFiles = scriptFiles.filter((file) => file.path.toLowerCase().endsWith('.jmx'));
  const result = {
    configured: Boolean(config.sharedDir),
    scripts: jmxFiles.map((jmx) => {
      const folder = path.posix.dirname(jmx.path);
      const prefix = folder === '.' ? '' : `${folder}/`;
      const bundled = scriptFiles.filter(
        (file) => file.path.startsWith(prefix) && file.path !== jmx.path && !file.path.toLowerCase().endsWith('.jmx')
      );
      return {
        path: jmx.path,
        folder: folder === '.' ? '' : folder,
        dataFiles: bundled.map((file) => file.path.slice(prefix.length)),
        bundleBytes: jmx.sizeBytes + bundled.reduce((sum, file) => sum + file.sizeBytes, 0)
      };
    }),
    plugins: (await walk(plugins, plugins)).filter((file) => file.path.toLowerCase().endsWith('.jar'))
  };
  result.scripts.sort((a, b) => a.path.localeCompare(b.path));
  result.plugins.sort((a, b) => a.path.localeCompare(b.path));
  return result;
}

export async function validateSharedSelection(config, { sharedScript, plugins = [] }) {
  const { scripts, plugins: pluginRoot } = sharedPaths(config);
  let script = null;
  if (sharedScript !== null && sharedScript !== undefined) {
    if (!String(sharedScript).toLowerCase().endsWith('.jmx'))
      throw httpError(400, 'The shared script must be a .jmx file.');
    script = (await resolveInside(scripts, sharedScript, 'script')).relative;
  }
  const resolvedPlugins = [];
  for (const plugin of plugins) {
    if (!String(plugin).toLowerCase().endsWith('.jar')) throw httpError(400, `Plugin "${plugin}" is not a .jar file.`);
    resolvedPlugins.push((await resolveInside(pluginRoot, plugin, 'plugin')).relative);
  }
  return { sharedScript: script, plugins: [...new Set(resolvedPlugins)] };
}

async function folderBytes(dir) {
  return (await walk(dir, dir, { maxEntries: Infinity })).reduce((sum, file) => sum + file.sizeBytes, 0);
}

// Copies a shared script's folder and the selected plugins into bundleDir.
// Returns the bundle-relative JMX path and the plugin folder (or null).
export async function snapshotSharedBundle(config, { sharedScript, plugins = [] }, bundleDir) {
  const { scripts, plugins: pluginRoot } = sharedPaths(config);
  const script = await resolveInside(scripts, sharedScript, 'script');
  const sourceFolder = path.dirname(script.absolute);
  const limit = config.maxBundleBytes;
  const size = await folderBytes(sourceFolder);
  if (size > limit) {
    throw httpError(
      400,
      `The script folder is ${Math.ceil(size / 1048576)} MB, over the ${Math.floor(limit / 1048576)} MB bundle limit. ` +
        'Keep each test in its own folder or raise PERF_MAX_BUNDLE_MB.'
    );
  }
  await mkdir(bundleDir, { recursive: true });
  await cp(sourceFolder, bundleDir, {
    recursive: true,
    dereference: true,
    filter: (source) => !SKIP.has(path.basename(source))
  });
  const pluginDir = await copyPlugins(pluginRoot, plugins, bundleDir);
  return { jmxPath: path.join(bundleDir, path.basename(script.absolute)), pluginDir };
}

export async function copyPlugins(pluginRoot, plugins, bundleDir) {
  if (!plugins.length) return null;
  const pluginDir = path.join(bundleDir, 'plugins');
  await mkdir(pluginDir, { recursive: true });
  for (const plugin of plugins) {
    const resolved = await resolveInside(pluginRoot, plugin, 'plugin');
    const info = await lstat(resolved.absolute);
    if (!info.isFile() && !info.isSymbolicLink()) throw httpError(400, `Plugin "${plugin}" is not a file.`);
    await cp(resolved.absolute, path.join(pluginDir, path.basename(resolved.absolute)));
  }
  return pluginDir;
}

export async function readSharedScript(config, relativePath) {
  const script = await resolveInside(sharedPaths(config).scripts, relativePath, 'script');
  return readFile(script.absolute, 'utf8');
}
