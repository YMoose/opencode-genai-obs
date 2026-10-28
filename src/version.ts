/**
 * @fileoverview Shared instrumentation-scope version. One constant so the traces/metrics/logs
 * scopes cannot drift apart; bumped together with package.json at release (no dynamic linkage —
 * the dependency-closure test keeps imports to node:* builtins and relative paths only).
 */
export const PLUGIN_VERSION = "0.1.0"
