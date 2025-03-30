/** @type {import('ts-jest').JestConfigWithTsJest} */
export default {
    preset: 'ts-jest/presets/default-esm', // Use ESM preset for ts-jest
    testEnvironment: 'node',
    extensionsToTreatAsEsm: ['.ts'],
    moduleNameMapper: {
        // Handle '.js' extension in imports for ES Modules
        '^(\\.{1,2}/.*)\\.js$': '$1',
        // Handle virtual tool modules
        '^../../dist/tools/(.+)\\.js$': '<rootDir>/tests/mocks/tools/$1.ts',
    },
    transform: {
        // Handle TypeScript files
        '^.+\\.tsx?$': ['ts-jest', {
            useESM: true,
            isolatedModules: true // Fix the warning about hybrid module kind
        }],
    },
    // Allow virtual modules in tests
    modulePathIgnorePatterns: ['<rootDir>/dist/'],
    // Add any other Jest configurations needed below
    // verbose: true, // Optional: for more detailed test output
};
