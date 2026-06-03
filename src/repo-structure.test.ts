import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

// ---------------------------------------------------------------------------
// Repository-structure invariants
//
// These tests assert properties of the repository layout that must hold on
// every checkout and every CI run — regardless of whether a release has
// occurred, `npm run generate` has been run, or any benchmark has executed.
//
// Do NOT add tests here that depend on runtime-generated output (data/,
// reports/local/, logs/local/) or on post-release reference artifacts
// (reports/reference/v1/, etc.).  Those are either gitignored by design or
// created by the release workflow, not by `npm test`.
// ---------------------------------------------------------------------------

const ROOT = path.resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// Required documentation files
// ---------------------------------------------------------------------------

describe('repo-structure — required docs', () => {
  it('root README.md exists', () => {
    assert.ok(fs.existsSync(path.join(ROOT, 'README.md')), 'root README.md must exist');
  });

  it('supporting-probes/README.md exists', () => {
    assert.ok(
      fs.existsSync(path.join(ROOT, 'supporting-probes', 'README.md')),
      'supporting-probes/README.md must exist'
    );
  });

  it('AGENTS.md exists', () => {
    assert.ok(fs.existsSync(path.join(ROOT, 'AGENTS.md')), 'AGENTS.md must exist');
  });

  it('analysis/EXPERIMENT_ANALYSIS.md exists', () => {
    assert.ok(
      fs.existsSync(path.join(ROOT, 'analysis', 'EXPERIMENT_ANALYSIS.md')),
      'analysis/EXPERIMENT_ANALYSIS.md must exist'
    );
  });

  it('analysis/ECOSYSTEM_RESEARCH.md exists', () => {
    assert.ok(
      fs.existsSync(path.join(ROOT, 'analysis', 'ECOSYSTEM_RESEARCH.md')),
      'analysis/ECOSYSTEM_RESEARCH.md must exist'
    );
  });
});

// ---------------------------------------------------------------------------
// Reference directory layout
//
// Each reference/ dir must contain exactly a .gitkeep marker before any
// release has been made.  No markdown files belong here — document reference
// rules in the root README instead.  Version subdirectories (v1/, v2/, …)
// are written exclusively by the release workflow.
//
// Versioned structure invariant (AGENTS.md §6):
//   - Versions 1 through (major - 1) are already released → their vK/ dirs
//     must be present in all three reference directories.
//   - The current in-development version (vMajor/) must NOT be pre-created.
//   - All three reference directories must always hold an identical set of
//     version subdirectories (no partial releases).
// ---------------------------------------------------------------------------

describe('repo-structure — reference directory layout', () => {
  const referenceDirs = [
    path.join(ROOT, 'reports', 'reference'),
    path.join(ROOT, 'logs', 'reference'),
    path.join(ROOT, 'supporting-probes', 'results', 'reference'),
  ];

  for (const refDir of referenceDirs) {
    const label = path.relative(ROOT, refDir);

    it(`${label}/.gitkeep exists`, () => {
      assert.ok(
        fs.existsSync(path.join(refDir, '.gitkeep')),
        `${label}/.gitkeep must exist to keep the directory tracked by git`
      );
    });

    it(`no *.md files in ${label}/`, () => {
      const mdFiles = fs.readdirSync(refDir).filter((e) => e.endsWith('.md'));
      assert.deepEqual(
        mdFiles,
        [],
        `${label}/ must not contain any markdown files (mainly concerned about README.md, but no *.md belongs here) — document reference rules in the root README instead`
      );
    });
  }
});

// ---------------------------------------------------------------------------
// Reference directory versioned structure
// ---------------------------------------------------------------------------

describe('repo-structure — reference directory versioned structure', () => {
  const referenceDirs = [
    path.join(ROOT, 'reports', 'reference'),
    path.join(ROOT, 'logs', 'reference'),
    path.join(ROOT, 'supporting-probes', 'results', 'reference'),
  ];

  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as {
    version: string;
  };
  const majorVersion = parseInt(pkg.version.split('.')[0], 10);

  // All released versions (1 through major-1) must be present in every reference dir.
  for (let k = 1; k < majorVersion; k++) {
    for (const refDir of referenceDirs) {
      const label = path.relative(ROOT, refDir);
      it(`${label}/v${k}/ exists (released at v${k}.0.0)`, () => {
        assert.ok(
          fs.existsSync(path.join(refDir, `v${k}`)),
          `${label}/v${k}/ must exist — it was created by the v${k}.0.0 release workflow and is immutable`
        );
      });
    }
  }

  // The current in-development version's directory must not be pre-created.
  for (const refDir of referenceDirs) {
    const label = path.relative(ROOT, refDir);
    it(`${label}/v${majorVersion}/ is not pre-created (written by release workflow only)`, () => {
      assert.ok(
        !fs.existsSync(path.join(refDir, `v${majorVersion}`)),
        `${label}/v${majorVersion}/ must not exist yet — it will be created by the v${majorVersion}.0.0 release workflow, not pre-created manually`
      );
    });
  }

  // All three reference directories must contain the same set of version subdirectories.
  it('version subdirectories are consistent across all three reference dirs', () => {
    const versionSets = referenceDirs.map((refDir) => {
      const label = path.relative(ROOT, refDir);
      const versions = fs
        .readdirSync(refDir)
        .filter((e) => /^v\d+$/.test(e))
        .sort();
      return { label, versions };
    });
    const [first, ...rest] = versionSets;
    for (const other of rest) {
      assert.deepEqual(
        other.versions,
        first.versions,
        `version dirs in ${other.label}/ (${other.versions.length > 0 ? other.versions.join(', ') : 'none'}) must match those in ${first.label}/ (${first.versions.length > 0 ? first.versions.join(', ') : 'none'})`
      );
    }
  });
});

// ---------------------------------------------------------------------------
// package.json invariants
// ---------------------------------------------------------------------------

describe('repo-structure — package.json', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as {
    version: string;
    scripts: Record<string, string>;
  };

  const requiredScripts = [
    'build',
    'lint',
    'test',
    'generate',
    'generate:force',
    'experiment',
    'experiment:force',
    'clean',
  ];

  for (const script of requiredScripts) {
    it(`scripts.${script} is defined`, () => {
      assert.ok(
        Object.prototype.hasOwnProperty.call(pkg.scripts, script),
        `package.json must define the "${script}" script`
      );
    });
  }

  it('version follows major-version-only semver (X.0.0)', () => {
    assert.match(
      pkg.version,
      /^\d+\.0\.0$/,
      `package.json version "${pkg.version}" must be major-version-only (X.0.0); minor/patch releases are not used in this repo`
    );
  });
});

// ---------------------------------------------------------------------------
// tsconfig.json invariants
// ---------------------------------------------------------------------------

describe('repo-structure — tsconfig.json', () => {
  const tsconfig = JSON.parse(fs.readFileSync(path.join(ROOT, 'tsconfig.json'), 'utf8')) as {
    compilerOptions: Record<string, unknown>;
  };

  it('strict: true is set', () => {
    assert.equal(
      tsconfig.compilerOptions.strict,
      true,
      'tsconfig.json must have strict: true'
    );
  });
});
