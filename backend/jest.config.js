/** @type {import('ts-jest').JestConfigWithTsJest} */
const fs = require('fs');
const path = require('path');

// Custom resolver: strips .js from relative imports, tries .ts first
// This is needed because the source uses TypeScript with explicit .js extensions (ESM style)
// but ts-jest needs to resolve .ts files.

module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/__tests__/**/*.test.ts'],
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json', 'node'],
  resolver: '<rootDir>/jest.resolver.js',
  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        tsconfig: {
          module: 'commonjs',
          moduleResolution: 'node',
          esModuleInterop: true,
          strict: false,
          skipLibCheck: true,
          typeRoots: [
            './node_modules/@types',
          ],
        },
        diagnostics: {
          // Test-time type diagnostics suppressed here; the authoritative
          // type gate is `tsc --noEmit` (project tsconfig), run separately.
          // 2322/2345 added for router imports: ts-jest's relaxed tsconfig
          // (strict:false, moduleResolution:node) mis-infers Zod `.default()`
          // output types as all-optional, which the real compiler resolves
          // correctly. See modules/staff-schedule/__tests__/auditTransaction.
          ignoreCodes: [2307, 2304, 2582, 2580, 2339, 2322, 2345],
        },
      },
    ],
  },
  testTimeout: 10000,
  modulePaths: [
    '<rootDir>/node_modules',
  ],
};
