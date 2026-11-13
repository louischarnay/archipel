// Injection tokens for the two values that are not classes.
export const CONFIG = Symbol('archipel.config');
export const RESTART = Symbol('archipel.restart');

// Reopens the whole platform after a database switch; null when the caller cannot restart.
export type Restart = (() => unknown) | null;
