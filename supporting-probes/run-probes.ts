import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { PROBE_IDENTITIES, PROBE_RUN_ID_PATTERN, type ProbeLanguage } from './ts/probe-config';
import { buildLaunchFailureFindings, type ProbeOutcome, getNodePackageVersion, writeProbeResultForRunId } from './ts/result-builder';

type Suite = 'ts' | 'all';

type ProbeConfigBase = {
  name: string;
  language: ProbeLanguage;
  library: string;
  resolveLibraryVersion: () => string;
  resolveRuntimeVersion: () => string;
  extraEnv?: Record<string, string>;
};

type ProbeConfig =
  | (ProbeConfigBase & { run: (env: NodeJS.ProcessEnv) => { status: number | null; stdout: string; stderr: string }; command?: never; args?: never })
  | (ProbeConfigBase & { command: string; args: string[]; run?: never });

function parseSuite(argv: string[]): Suite {
  const suiteArg = argv.find((arg) => arg.startsWith('--suite='));
  if (!suiteArg) {
    throw new Error('Missing required --suite=ts|all flag');
  }
  const value = suiteArg.slice('--suite='.length);
  if (value !== 'ts' && value !== 'all') {
    throw new Error(`Invalid suite '${value}'. Use --suite=ts or --suite=all.`);
  }
  return value;
}

function quoteIfNeeded(arg: string): string {
  if (process.platform !== 'win32') return arg;
  if (!/[\s"\\]/.test(arg)) return arg;
  // MSDN CommandLineToArgvW-compatible quoting: double backslashes before a
  // double-quote or at end-of-string, then escape double-quotes.
  let result = '';
  let backslashCount = 0;
  for (const ch of arg) {
    if (ch === '\\') {
      backslashCount++;
    } else if (ch === '"') {
      result += '\\'.repeat(backslashCount * 2) + '\\"';
      backslashCount = 0;
    } else {
      result += '\\'.repeat(backslashCount) + ch;
      backslashCount = 0;
    }
  }
  result += '\\'.repeat(backslashCount * 2);
  return `"${result}"`;
}

function runCommand(command: string, args: string[], options?: { env?: NodeJS.ProcessEnv; quiet?: boolean }) {
  const isWin = process.platform === 'win32';
  const result = spawnSync(command, isWin ? args.map(quoteIfNeeded) : args, {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: options?.env ?? process.env,
    shell: isWin,
  });

  if (result.error && !result.stderr.trim()) {
    result.stderr = String(result.error);
  }

  if (!options?.quiet) {
    if (result.stdout) {
      process.stdout.write(result.stdout);
    }
    if (result.stderr) {
      process.stderr.write(result.stderr);
    }
  }

  return result;
}

function commandWorks(command: string, args: string[]) {
  const result = runCommand(command, args, { quiet: true });
  return result.status === 0;
}

function detectPythonCommand(): string | null {
  if (commandWorks('python3', ['--version'])) {
    return 'python3';
  }
  if (commandWorks('python', ['--version'])) {
    return 'python';
  }
  return null;
}

function checkPrerequisites(suite: Suite): { ok: true; pythonCommand: string | null } | { ok: false; message: string } {
  const missing: Array<{ name: string; install: string }> = [];

  if (!commandWorks('node', ['--version'])) {
    missing.push({ name: 'node', install: 'https://nodejs.org/en/download/' });
  }

  let pythonCommand: string | null = null;

  if (suite === 'all') {
    pythonCommand = detectPythonCommand();
    if (!pythonCommand) {
      missing.push({ name: 'python3', install: 'https://www.python.org/downloads/' });
    }

    if (!commandWorks('ruby', ['--version'])) {
      missing.push({ name: 'ruby', install: 'https://www.ruby-lang.org/en/downloads/' });
    }

    if (!commandWorks('java', ['-version'])) {
      missing.push({ name: 'java', install: 'https://adoptium.net/temurin/releases/' });
    }

    if (!commandWorks('dotnet', ['--version'])) {
      missing.push({ name: 'dotnet', install: 'https://dotnet.microsoft.com/download' });
    }
  }

  if (missing.length > 0) {
    const lines = [`Missing prerequisites for probe:${suite}:`];
    for (const item of missing) {
      lines.push(`  - ${item.name} (install: ${item.install})`);
    }
    if (suite === 'all') {
      lines.push("Use 'npm run probe:ts' instead to run only the TypeScript probes.");
    }
    return { ok: false, message: lines.join('\n') };
  }

  return { ok: true, pythonCommand };
}

function getGitShortSha(): string {
  const result = runCommand('git', ['rev-parse', '--short=7', 'HEAD'], { quiet: true });
  const raw = (result.stdout ?? '').trim();
  return /^[0-9a-fA-F]{7}$/.test(raw) ? raw.toLowerCase() : 'nogit';
}

function buildRunId(now: Date): string {
  const y = now.getUTCFullYear().toString();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  const d = String(now.getUTCDate()).padStart(2, '0');
  const hh = String(now.getUTCHours()).padStart(2, '0');
  const mm = String(now.getUTCMinutes()).padStart(2, '0');
  const ss = String(now.getUTCSeconds()).padStart(2, '0');
  return `${y}${m}${d}-${hh}${mm}${ss}-${getGitShortSha()}`;
}

function pythonRuntimeVersion(command: string): string {
  const result = runCommand(command, ['-c', 'import platform; print(platform.python_version())'], { quiet: true });
  return (result.stdout ?? '').trim() || 'unknown';
}

function rubyRuntimeVersion(): string {
  const result = runCommand('ruby', ['-e', 'puts RUBY_VERSION'], { quiet: true });
  return (result.stdout ?? '').trim() || 'unknown';
}

function javaRuntimeVersion(): string {
  const result = runCommand('java', ['-version'], { quiet: true });
  const first = (result.stderr ?? '').split('\n').find((line) => line.trim().length > 0);
  return first?.replace(/"/g, '').trim() ?? 'unknown';
}

function dotnetRuntimeVersion(): string {
  const result = runCommand('dotnet', ['--version'], { quiet: true });
  return (result.stdout ?? '').trim() || 'unknown';
}

function sqlalchemyVersion(command: string): string {
  const result = runCommand(command, ['-c', 'import sqlalchemy; print(sqlalchemy.__version__)'], { quiet: true });
  return (result.stdout ?? '').trim() || 'unknown';
}

function activeRecordVersion(): string {
  const result = runCommand('ruby', ['-e', 'require "active_record"; puts ActiveRecord::VERSION::STRING'], { quiet: true });
  return (result.stdout ?? '').trim() || 'unknown';
}

function hibernateVersionFromPom(): string {
  const pomPath = path.join(process.cwd(), 'pom.xml');
  if (!fs.existsSync(pomPath)) {
    return 'unknown';
  }

  const pomText = fs.readFileSync(pomPath, 'utf8');
  const match = pomText.match(/<artifactId>hibernate-core<\/artifactId>\s*<version>([^<]+)<\/version>/m);
  return match?.[1]?.trim() ?? 'unknown';
}

function efCoreVersionFromCsproj(): string {
  const csprojPath = path.join(process.cwd(), 'EfCoreTest.csproj');
  if (!fs.existsSync(csprojPath)) {
    return 'unknown';
  }

  const xml = fs.readFileSync(csprojPath, 'utf8');
  const match = xml.match(/PackageReference Include="Microsoft\.EntityFrameworkCore" Version="([^"]+)"/m);
  return match?.[1]?.trim() ?? 'unknown';
}

function defineProbes(pythonCommand: string): { ts: ProbeConfig[]; all: ProbeConfig[] } {
  const tsProbes: ProbeConfig[] = [
    {
      name: PROBE_IDENTITIES.typeorm.probe,
      language: PROBE_IDENTITIES.typeorm.language,
      library: PROBE_IDENTITIES.typeorm.library,
      command: 'npx',
      args: ['tsx', 'typeorm-test.ts'],
      resolveLibraryVersion: () => getNodePackageVersion('typeorm'),
      resolveRuntimeVersion: () => process.version,
    },
    {
      name: PROBE_IDENTITIES.sequelize.probe,
      language: PROBE_IDENTITIES.sequelize.language,
      library: PROBE_IDENTITIES.sequelize.library,
      command: 'npx',
      args: ['tsx', 'sequelize-test.ts'],
      resolveLibraryVersion: () => getNodePackageVersion('sequelize'),
      resolveRuntimeVersion: () => process.version,
    },
    {
      name: PROBE_IDENTITIES.mikroorm.probe,
      language: PROBE_IDENTITIES.mikroorm.language,
      library: PROBE_IDENTITIES.mikroorm.library,
      command: 'npx',
      args: ['tsx', 'mikroorm-test.ts'],
      resolveLibraryVersion: () => getNodePackageVersion('@mikro-orm/core'),
      resolveRuntimeVersion: () => process.version,
    },
    {
      name: PROBE_IDENTITIES.prisma.probe,
      language: PROBE_IDENTITIES.prisma.language,
      library: PROBE_IDENTITIES.prisma.library,
      run: (env) => {
        const steps: Array<[string, string[]]> = [
          ['npx', ['prisma', 'db', 'push', '--schema=prisma/schema.prisma', '--skip-generate']],
          ['npx', ['prisma', 'generate', '--schema=prisma/schema.prisma']],
          ['npx', ['tsx', 'prisma-test.ts']],
        ];
        let last = { status: 0 as number | null, stdout: '', stderr: '' };
        for (const [cmd, args] of steps) {
          const r = runCommand(cmd, args, { env });
          last = { status: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
          if ((r.status ?? -1) !== 0) return last;
        }
        return last;
      },
      resolveLibraryVersion: () => getNodePackageVersion('@prisma/client'),
      resolveRuntimeVersion: () => process.version,
    },
    {
      name: PROBE_IDENTITIES.mongoose.probe,
      language: PROBE_IDENTITIES.mongoose.language,
      library: PROBE_IDENTITIES.mongoose.library,
      command: 'npx',
      args: ['tsx', 'mongoose-test.ts'],
      resolveLibraryVersion: () => getNodePackageVersion('mongoose'),
      resolveRuntimeVersion: () => process.version,
    },
  ];

  const allProbes: ProbeConfig[] = [
    ...tsProbes,
    {
      name: PROBE_IDENTITIES.sqlalchemy.probe,
      language: PROBE_IDENTITIES.sqlalchemy.language,
      library: PROBE_IDENTITIES.sqlalchemy.library,
      command: pythonCommand,
      args: ['test_sqlalchemy.py'],
      resolveLibraryVersion: () => sqlalchemyVersion(pythonCommand),
      resolveRuntimeVersion: () => pythonRuntimeVersion(pythonCommand),
    },
    {
      name: PROBE_IDENTITIES.activerecord.probe,
      language: PROBE_IDENTITIES.activerecord.language,
      library: PROBE_IDENTITIES.activerecord.library,
      command: 'ruby',
      args: ['test_activerecord.rb'],
      resolveLibraryVersion: () => activeRecordVersion(),
      resolveRuntimeVersion: () => rubyRuntimeVersion(),
    },
    {
      name: PROBE_IDENTITIES.hibernate.probe,
      language: PROBE_IDENTITIES.hibernate.language,
      library: PROBE_IDENTITIES.hibernate.library,
      run: (env) => {
        const mvnResult = runCommand('mvn', ['-q', 'dependency:build-classpath', '-Dmdep.outputFile=.hibernate-classpath'], { env });
        if ((mvnResult.status ?? -1) !== 0) {
          return { status: mvnResult.status ?? -1, stdout: mvnResult.stdout ?? '', stderr: mvnResult.stderr ?? '' };
        }
        const classpathFile = path.join(process.cwd(), '.hibernate-classpath');
        let classpath: string;
        try {
          classpath = fs.readFileSync(classpathFile, 'utf8').trim();
        } catch (err) {
          return { status: 1, stdout: '', stderr: `Failed to read .hibernate-classpath: ${String(err)}` };
        }
        const javacResult = runCommand('javac', ['-cp', classpath, 'Main.java'], { env });
        if ((javacResult.status ?? -1) !== 0) {
          return { status: javacResult.status ?? -1, stdout: javacResult.stdout ?? '', stderr: javacResult.stderr ?? '' };
        }
        const sep = path.delimiter;
        const javaResult = runCommand('java', ['-cp', `.${sep}${classpath}`, 'Main'], { env });
        return { status: javaResult.status ?? -1, stdout: javaResult.stdout ?? '', stderr: javaResult.stderr ?? '' };
      },
      resolveLibraryVersion: () => hibernateVersionFromPom(),
      resolveRuntimeVersion: () => javaRuntimeVersion(),
    },
    {
      name: PROBE_IDENTITIES.efcore.probe,
      language: PROBE_IDENTITIES.efcore.language,
      library: PROBE_IDENTITIES.efcore.library,
      run: (env) => {
        const restoreResult = runCommand('dotnet', ['restore', 'EfCoreTest.csproj'], { env });
        if ((restoreResult.status ?? -1) !== 0) {
          return { status: restoreResult.status ?? -1, stdout: restoreResult.stdout ?? '', stderr: restoreResult.stderr ?? '' };
        }
        const runResult = runCommand('dotnet', ['run', '--project', 'EfCoreTest.csproj'], { env });
        return { status: runResult.status ?? -1, stdout: runResult.stdout ?? '', stderr: runResult.stderr ?? '' };
      },
      resolveLibraryVersion: () => efCoreVersionFromCsproj(),
      resolveRuntimeVersion: () => dotnetRuntimeVersion(),
    },
  ];

  return { ts: tsProbes, all: allProbes };
}

function writeFallbackResult(runId: string, probe: ProbeConfig, detail: string): void {
  const findings = buildLaunchFailureFindings(detail);

  writeProbeResultForRunId(runId, {
    probe: probe.name,
    language: probe.language,
    library: probe.library,
    libraryVersion: probe.resolveLibraryVersion(),
    runtimeVersion: probe.resolveRuntimeVersion(),
    findings,
  }, {
    outcomeOverride: 'PROBE_LAUNCH_FAIL',
  });
}

type ParsedProbeResult = {
  outcome: string;
  findings: {
    fetch?: { result: string };
    hydration: { result: string };
    queryGate: { result: string };
    smartCheck: { result: string };
    serialize: { result: string };
  };
};

function readProbeResult(filePath: string): ParsedProbeResult {
  const raw = fs.readFileSync(filePath, 'utf8');
  return JSON.parse(raw) as ParsedProbeResult;
}

function printSummary(runId: string, probes: ProbeConfig[]): void {
  // `outcome` is the overall acyclic verdict; the per-stage columns (fetch/queryGate/
  // smartCheck/serialize) show how it was reached. There is no separate `hydration`
  // column — it was identical to `outcome` for every non-launch-failure row.
  const headers = ['probe', 'outcome', 'fetch', 'queryGate', 'smartCheck', 'serialize'];
  const rows = probes.map((probe) => {
    const filePath = path.join(process.cwd(), 'results', 'local', runId, `${probe.name}.json`);
    const parsed = readProbeResult(filePath);
    const hydrationFailed = parsed.findings.hydration.result === 'FAIL';
    const serializeCell = hydrationFailed ? 'SERIALIZE_SKIPPED' : parsed.findings.serialize.result;
    const fetchCell = parsed.findings.fetch?.result ?? 'n/a';
    const outcome = parsed.outcome;
    const outcomeCell: ProbeOutcome | string =
      outcome === 'PROBE_LAUNCH_FAIL'
        ? `${outcome} (probe did not launch)`
        : outcome === 'PASS'
          ? 'ACYCLIC_PASS'
          : 'ACYCLIC_FAIL';
    return [
      probe.name,
      outcomeCell,
      fetchCell,
      parsed.findings.queryGate.result,
      parsed.findings.smartCheck.result,
      serializeCell,
    ];
  });

  const widths = headers.map((header, idx) => Math.max(header.length, ...rows.map((row) => row[idx].length)));
  const formatRow = (row: string[]) => row.map((cell, idx) => cell.padEnd(widths[idx], ' ')).join(' | ');

  console.log('');
  console.log(`PROBE_RUN_ID=${runId}`);
  console.log(formatRow(headers));
  console.log(widths.map((w) => '-'.repeat(w)).join('-|-'));
  for (const row of rows) {
    console.log(formatRow(row));
  }

  console.log('');
  console.log('ACYCLIC_PASS requires queryGate=PASS, smartCheck=PASS, serialize=SERIALIZE_PASS (and fetch=OK when present).');
  console.log('The stage columns are independent measurements, so a passing gate can sit next to the');
  console.log('failure that decides the row -- e.g. smartCheck=PASS with queryGate=FAIL is the N+1');
  console.log('signature: the topology is correct but was assembled via per-edge lazy queries, which is');
  console.log('not schema-driven eager hydration.');
}

function main(): number {
  const suite = parseSuite(process.argv.slice(2));
  const prereq = checkPrerequisites(suite);
  if (!prereq.ok) {
    console.error(prereq.message);
    return 1;
  }

  const runId = buildRunId(new Date());
  process.env.PROBE_RUN_ID = runId;

  const outputDir = path.join(process.cwd(), 'results', 'local', runId);
  fs.mkdirSync(outputDir, { recursive: true });

  const probeSets = defineProbes(prereq.pythonCommand ?? 'python3');
  const probes = suite === 'ts' ? probeSets.ts : probeSets.all;

  for (const probe of probes) {
    console.log(`\n=== Running ${probe.name} ===`);
    const env = { ...process.env, PROBE_RUN_ID: runId, ...(probe.extraEnv ?? {}) };
    const result = probe.run
      ? probe.run(env)
      : runCommand(probe.command, probe.args, { env });

    const outputPath = path.join(outputDir, `${probe.name}.json`);
    if (!fs.existsSync(outputPath)) {
      const detail = [result.stderr?.trim(), result.stdout?.trim()].filter(Boolean).join('\n').trim() || `Probe exited with code ${result.status ?? -1}`;
      writeFallbackResult(runId, probe, detail);
    }
  }

  printSummary(runId, probes);

  const missing = probes.filter((probe) => !fs.existsSync(path.join(outputDir, `${probe.name}.json`)));
  if (missing.length > 0) {
    console.error(`Missing JSON outputs: ${missing.map((probe) => probe.name).join(', ')}`);
    return 1;
  }

  return 0;
}

process.exitCode = main();
