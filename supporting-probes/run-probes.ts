import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildOutcome, getNodePackageVersion, writeProbeResultForRunId } from './ts/result-builder';

type Suite = 'ts' | 'all';
type ProbeLanguage = 'typescript' | 'python' | 'ruby' | 'java' | 'csharp';

type ProbeConfig = {
  name: string;
  language: ProbeLanguage;
  library: string;
  command: string;
  args: string[];
  resolveLibraryVersion: () => string;
  resolveRuntimeVersion: () => string;
  extraEnv?: Record<string, string>;
};

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

function runCommand(command: string, args: string[], options?: { env?: NodeJS.ProcessEnv; quiet?: boolean }) {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: options?.env ?? process.env,
  });

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
  if (!commandWorks('npx', ['--version'])) {
    missing.push({ name: 'npx', install: 'https://nodejs.org/en/download/' });
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
      name: 'typeorm',
      language: 'typescript',
      library: 'TypeORM',
      command: 'npx',
      args: ['tsx', 'typeorm-test.ts'],
      resolveLibraryVersion: () => getNodePackageVersion('typeorm'),
      resolveRuntimeVersion: () => process.version,
    },
    {
      name: 'sequelize',
      language: 'typescript',
      library: 'Sequelize',
      command: 'npx',
      args: ['tsx', 'sequelize-test.ts'],
      resolveLibraryVersion: () => getNodePackageVersion('sequelize'),
      resolveRuntimeVersion: () => process.version,
    },
    {
      name: 'mikroorm',
      language: 'typescript',
      library: 'MikroORM',
      command: 'npx',
      args: ['tsx', 'mikroorm-test.ts'],
      resolveLibraryVersion: () => getNodePackageVersion('@mikro-orm/core'),
      resolveRuntimeVersion: () => process.version,
    },
    {
      name: 'prisma',
      language: 'typescript',
      library: 'Prisma',
      command: 'bash',
      args: ['-lc', 'npx prisma db push --schema=prisma/schema.prisma --skip-generate && npx prisma generate --schema=prisma/schema.prisma && npx tsx prisma-test.ts'],
      resolveLibraryVersion: () => getNodePackageVersion('@prisma/client'),
      resolveRuntimeVersion: () => process.version,
    },
    {
      name: 'mongoose',
      language: 'typescript',
      library: 'Mongoose',
      command: 'npx',
      args: ['tsx', 'mongoose-test.ts'],
      resolveLibraryVersion: () => getNodePackageVersion('mongoose'),
      resolveRuntimeVersion: () => process.version,
    },
  ];

  const allProbes: ProbeConfig[] = [
    ...tsProbes,
    {
      name: 'sqlalchemy',
      language: 'python',
      library: 'SQLAlchemy',
      command: pythonCommand,
      args: ['test_sqlalchemy.py'],
      resolveLibraryVersion: () => sqlalchemyVersion(pythonCommand),
      resolveRuntimeVersion: () => pythonRuntimeVersion(pythonCommand),
    },
    {
      name: 'activerecord',
      language: 'ruby',
      library: 'ActiveRecord',
      command: 'ruby',
      args: ['test_activerecord.rb'],
      resolveLibraryVersion: () => activeRecordVersion(),
      resolveRuntimeVersion: () => rubyRuntimeVersion(),
    },
    {
      name: 'hibernate',
      language: 'java',
      library: 'Hibernate',
      command: 'bash',
      args: ['-lc', 'mvn -q dependency:build-classpath -Dmdep.outputFile=.hibernate-classpath && javac -cp "$(cat .hibernate-classpath)" Main.java && java -cp ".:$(cat .hibernate-classpath)" Main'],
      resolveLibraryVersion: () => hibernateVersionFromPom(),
      resolveRuntimeVersion: () => javaRuntimeVersion(),
    },
    {
      name: 'efcore',
      language: 'csharp',
      library: 'EF Core',
      command: 'bash',
      args: ['-lc', 'dotnet restore EfCoreTest.csproj && dotnet run --project EfCoreTest.csproj'],
      resolveLibraryVersion: () => efCoreVersionFromCsproj(),
      resolveRuntimeVersion: () => dotnetRuntimeVersion(),
    },
  ];

  return { ts: tsProbes, all: allProbes };
}

function writeFallbackResult(runId: string, probe: ProbeConfig, detail: string): void {
  const findings = {
    hydration: { result: 'FAIL' as const, detail },
    queryGate: { result: 'FAIL' as const, detail },
    smartCheck: { result: 'FAIL' as const, detail },
    serialize: { result: 'SERIALIZE_FAIL_OTHER' as const, detail },
  };

  writeProbeResultForRunId(runId, {
    probe: probe.name,
    language: probe.language,
    library: probe.library,
    libraryVersion: probe.resolveLibraryVersion(),
    runtimeVersion: probe.resolveRuntimeVersion(),
    outcome: buildOutcome(findings),
    findings,
  });
}

function readOutcomeCell(filePath: string, key: 'outcome' | 'hydration' | 'queryGate' | 'smartCheck' | 'serialize'): string {
  const raw = fs.readFileSync(filePath, 'utf8');
  const parsed = JSON.parse(raw) as {
    outcome: string;
    findings: {
      hydration: { result: string };
      queryGate: { result: string };
      smartCheck: { result: string };
      serialize: { result: string };
    };
  };

  switch (key) {
    case 'outcome':
      return parsed.outcome;
    case 'hydration':
      return parsed.findings.hydration.result;
    case 'queryGate':
      return parsed.findings.queryGate.result;
    case 'smartCheck':
      return parsed.findings.smartCheck.result;
    case 'serialize':
      return parsed.findings.serialize.result;
    default:
      return 'UNKNOWN';
  }
}

function printSummary(runId: string, probes: ProbeConfig[]): void {
  const headers = ['probe', 'outcome', 'hydration', 'queryGate', 'smartCheck', 'serialize'];
  const rows = probes.map((probe) => {
    const filePath = path.join(process.cwd(), 'results', 'local', runId, `${probe.name}.json`);
    return [
      probe.name,
      readOutcomeCell(filePath, 'outcome'),
      readOutcomeCell(filePath, 'hydration'),
      readOutcomeCell(filePath, 'queryGate'),
      readOutcomeCell(filePath, 'smartCheck'),
      readOutcomeCell(filePath, 'serialize'),
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
    const result = runCommand(probe.command, probe.args, {
      env: {
        ...process.env,
        PROBE_RUN_ID: runId,
        ...(probe.extraEnv ?? {}),
      },
    });

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
