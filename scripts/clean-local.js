const fs = require('fs');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..');
const targets = [
  'reports/local',
  'logs/local',
  'supporting-probes/results/local',
  'data',
  'dist',
];

const removed = [];

for (const relTarget of targets) {
  const absTarget = path.resolve(projectRoot, relTarget);
  const relFromRoot = path.relative(projectRoot, absTarget);

  if (relFromRoot.startsWith('..') || path.isAbsolute(relFromRoot)) {
    console.error(`Skipping unsafe path outside project root: ${absTarget}`);
    continue;
  }

  if (fs.existsSync(absTarget)) {
    fs.rmSync(absTarget, { recursive: true, force: true });
    removed.push(relTarget);
  }
}

if (removed.length === 0) {
  console.log('nothing to clean');
} else {
  for (const rel of removed) {
    console.log(`removed: ${rel}`);
  }
}
