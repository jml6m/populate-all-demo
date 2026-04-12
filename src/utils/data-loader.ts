import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import YAML from 'yaml';

import { Manifest } from '../types';

// Resolve the src/ directory regardless of whether this module lives in src/ or src/utils/
const srcDir = path.resolve(__dirname, '..');

// Validates that a value is a safe single-segment path component (no slashes, dots-only names,
// or other traversal characters).
const SAFE_PATH_SEGMENT = /^[a-z0-9_-]+$/i;
export function assertSafePathSegment(value: string, label: string): void {
  if (!SAFE_PATH_SEGMENT.test(value)) {
    throw new Error(`Unsafe ${label} value "${value}": must match ${SAFE_PATH_SEGMENT.source}`);
  }
}

export function getDataDir(): string {
  const defaultDir = path.resolve(srcDir, '../data');
  const configPath = path.resolve(srcDir, 'generate-config.json');

  try {
    const rawConfig = fs.readFileSync(configPath, 'utf8');
    const parsed = JSON.parse(rawConfig) as { outputDir?: unknown };
    if (typeof parsed.outputDir === 'string' && parsed.outputDir.trim() !== '') {
      return path.resolve(srcDir, parsed.outputDir);
    }
  } catch (err) {
    console.warn(
      `[data-loader] Could not read generate-config.json at "${configPath}"; falling back to default data dir. (${err instanceof Error ? err.message : String(err)})`
    );
  }

  return defaultDir;
}

export function loadManifest(): Manifest {
  const dataDir = getDataDir();
  const manifestPath = path.resolve(dataDir, 'manifest.json');
  const raw = fs.readFileSync(manifestPath, 'utf8');
  return JSON.parse(raw) as Manifest;
}

export function loadYaml(filename: string): unknown {
  const dataDir = getDataDir();
  const filePath = path.resolve(dataDir, filename);
  // Guard against path traversal: the relative path from dataDir must not escape
  // upward (i.e. start with '..') and must not be absolute.
  const relative = path.relative(dataDir, filePath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Path "${filePath}" is outside the data directory`);
  }
  const fileContent = fs.readFileSync(filePath, 'utf8');

  // Validate content hash embedded in filename against the actual file content
  const basename = path.basename(filename, '.yaml');
  const parts = basename.split('.');
  if (parts.length !== 2) {
    throw new Error(`Invalid benchmark filename "${filename}": expected "<name>.<hash>.yaml" format.`);
  }
  const embeddedContentHash = parts[1];
  const actualHash = crypto.createHash('sha256').update(fileContent).digest('hex').slice(0, 8);
  if (actualHash !== embeddedContentHash) {
    throw new Error(`Content hash mismatch for "${filename}": expected ${embeddedContentHash}, got ${actualHash}. File may have been tampered with.`);
  }

  // Disabling maxAliasCount (using hashes to verify files instead)
  return YAML.parse(fileContent, { maxAliasCount: -1 });
}
