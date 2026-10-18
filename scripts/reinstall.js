const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

console.log('🗑️  Cleaning dependencies...');

// Both packages reinstall from their committed lockfiles, which stay untouched.
const rootDir = path.resolve(__dirname, '..');
const packageDirs = [rootDir, path.join(rootDir, 'supporting-probes')];

for (const dir of packageDirs) {
  fs.rmSync(path.join(dir, 'node_modules'), { recursive: true, force: true });
}

console.log('✨ Clean complete. Installing from the lockfiles...');

// Execute install inheriting the console colors
try {
  for (const dir of packageDirs) {
    execSync('npm ci', { stdio: 'inherit', cwd: dir });
  }
} catch (error) {
  process.exit(1);
}

// Run the critical/high audit gate after the dependency refresh.
try {
  execSync('npm run audit:ci', { stdio: 'inherit', cwd: rootDir });
} catch (error) {
  process.exit(1);
}
