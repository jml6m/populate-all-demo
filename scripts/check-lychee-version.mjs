import { spawnSync } from 'node:child_process';

const requiredVersion = '0.24.2';
const binary = process.platform === 'win32' ? 'lychee.exe' : 'lychee';

const result = spawnSync(binary, ['--version'], {
  encoding: 'utf8',
});

if (result.error) {
  console.error(`Expected lychee v${requiredVersion} to match CI, but no lychee binary was found on PATH.`);
  console.error('Install it from the official release or via `cargo install lychee --locked --version 0.24.2`.');
  process.exit(1);
}

const versionText = `${result.stdout}\n${result.stderr}`;
const match = versionText.match(/v?(?<version>\d+\.\d+\.\d+)/);

if (result.status !== 0 || !match?.groups?.version) {
  console.error('Unable to determine the installed lychee version.');
  process.exit(1);
}

if (match.groups.version !== requiredVersion) {
  console.error(`Expected lychee v${requiredVersion} to match CI, found v${match.groups.version}.`);
  console.error('Install the pinned version from the official release or via `cargo install lychee --locked --version 0.24.2`.');
  process.exit(1);
}
