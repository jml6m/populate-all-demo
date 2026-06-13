// scripts/reinstall.js
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

console.log('🗑️  Cleaning dependencies...');

// Paths relative to this script
const rootDir = path.resolve(__dirname, '..');
const nodeModules = path.join(rootDir, 'node_modules');
const lockFile = path.join(rootDir, 'package-lock.json');

// Force remove directory
if (fs.existsSync(nodeModules)) {
  fs.rmSync(nodeModules, { recursive: true, force: true });
}

// Force remove lock file
if (fs.existsSync(lockFile)) {
  fs.rmSync(lockFile, { force: true });
}

console.log('✨ Clean complete. Installing fresh dependencies...');

// Execute install inheriting the console colors
try {
  execSync('npm install', { stdio: 'inherit', cwd: rootDir });
} catch (error) {
  process.exit(1);
}

// Run the critical/high audit gate after the dependency refresh.
try {
  execSync('npm run audit:ci', { stdio: 'inherit', cwd: rootDir });
} catch (error) {
  process.exit(1);
}
