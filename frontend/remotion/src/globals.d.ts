// Make webpack-env's require.context ambient declaration visible to the
// TypeScript language server (some IDEs do not auto-load @types/webpack-env
// even when the package is in devDependencies). tsc picks it up either way;
// this file just keeps the editor in sync.
/// <reference types="webpack-env" />
