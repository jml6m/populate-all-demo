// @ts-check
const eslint = require('@eslint/js');
const { defineConfig } = require('eslint/config');
const tseslint = require('typescript-eslint');
const unusedImports = require('eslint-plugin-unused-imports');

module.exports = defineConfig([
  {
    files: ['**/*.ts'],
    extends: [eslint.configs.recommended, ...tseslint.configs.recommended, ...tseslint.configs.stylistic],
    plugins: {
      'unused-imports': unusedImports,
    },
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: __dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-unnecessary-condition': 'warn',
      '@typescript-eslint/strict-boolean-expressions': ['warn', { allowString: false, allowNumber: false, allowNullableObject: true }],
      '@typescript-eslint/no-explicit-any': 'warn',

      // Better unused-vars handling with auto-fix support
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
      'unused-imports/no-unused-imports': 'error',
      'unused-imports/no-unused-vars': ['warn', { args: 'after-used', argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
]);
