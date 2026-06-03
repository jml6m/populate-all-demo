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
// release has been made.  No README.md belongs here (those rules are in the
// root README), and no version subdirectory (v1/, v2/, …) should be
// pre-created — they are written by the release workflow only.
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

    it(`no README.md in ${label}/`, () => {
      assert.ok(
        !fs.existsSync(path.join(refDir, 'README.md')),
        `${label}/README.md must not exist — document reference rules in the root README instead`
      );
    });

    it(`no pre-created version subdirectories in ${label}/`, () => {
      const entries = fs.readdirSync(refDir);
      const versionDirs = entries.filter((e) => /^v\d+$/.test(e));
      assert.deepEqual(
        versionDirs,
        [],
        `${label}/ must not contain pre-created version dirs (${versionDirs.join(', ')}); they are created by the release workflow`
      );
    });
  }
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
