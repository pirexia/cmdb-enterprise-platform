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
  moduleNameMapper: {
    // Resolve supertest from jest-tools when not in local node_modules
    '^supertest$': '/tmp/jest-tools/node_modules/supertest',
    '^supertest/(.*)$': '/tmp/jest-tools/node_modules/supertest/$1',
  },
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
            '/tmp/jest-tools/node_modules/@types',
            './node_modules/@types',
          ],
        },
        diagnostics: {
          ignoreCodes: [2307, 2304, 2582, 2580, 2339],
        },
      },
    ],
  },
  testTimeout: 10000,
  modulePaths: [
    '<rootDir>/node_modules',
    '/tmp/jest-tools/node_modules',
  ],
};
