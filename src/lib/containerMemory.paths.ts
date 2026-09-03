/**
 * Where the kernel exposes the container's memory accounting. Separated from
 * the reader so tests can point it at a directory they control — the real
 * paths are not writable, and a test that mocked `fs` instead would be
 * testing its own mock rather than the parsing.
 */
export const V2_ROOT = '/sys/fs/cgroup';
export const V1_ROOT = '/sys/fs/cgroup/memory';
