/**
 * Global Jest setup. Forces the logger to silent during tests unless
 * explicitly overridden by setting LOG_LEVEL in the test's own env.
 */
process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? 'silent'
process.env.NODE_ENV = 'test'
