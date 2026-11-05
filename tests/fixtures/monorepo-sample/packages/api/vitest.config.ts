import {defineConfig} from 'vitest/config';
// allowExternal matches absolute paths; override dot-directory defaults so
// coverage also works in Rio's disposable trees below .rio/cache.
export default defineConfig({test:{coverage:{provider:'v8',all:true,allowExternal:true,include:['**/src/**/*.ts'],exclude:['**/node_modules/**','**/*.test.ts'],reporter:['lcov']}}});
