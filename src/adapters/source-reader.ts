import { lstat, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import type { SourceReadRequest } from '../domain/audit.js';
import { isOutsideRootRelative } from './containment.js';

function normalizeRelativePath(path: string): string {
  return path.replaceAll('\\', '/');
}

function validateRepositoryRelativePath(path: string): string {
  const normalized = normalizeRelativePath(path);
  if (
    normalized.length === 0
    || normalized.startsWith('/')
    || normalized.startsWith('//')
    || /^[A-Za-z]:/u.test(normalized)
    || normalized.includes('\0')
    || normalized.split('/').every((segment) => segment === '' || segment === '.')
    || normalized.split('/').some((segment) => segment === '..')
  ) {
    throw new RangeError(`Source path must stay inside the repository root: ${path}`);
  }
  return normalized;
}

export async function readSourceFile(request: SourceReadRequest): Promise<string> {
  const requestedRoot = resolve(request.rootDir);
  if ((await lstat(requestedRoot)).isSymbolicLink()) {
    throw new RangeError(`Source root must not be a symlink: ${request.rootDir}`);
  }
  const rootDir = await realpath(requestedRoot);
  const repositoryRelativePath = validateRepositoryRelativePath(request.repositoryRelativePath);
  const candidate = resolve(rootDir, ...repositoryRelativePath.split('/'));
  const relativeCandidate = relative(rootDir, candidate);
  if (isAbsolute(relativeCandidate) || isOutsideRootRelative(relativeCandidate)) {
    throw new RangeError(`Source path must stay inside the repository root: ${request.repositoryRelativePath}`);
  }
  const resolvedCandidate = await realpath(candidate);
  const resolvedRelative = relative(rootDir, resolvedCandidate);
  if (isAbsolute(resolvedRelative) || isOutsideRootRelative(resolvedRelative)) {
    throw new RangeError(`Source path must stay inside the repository root: ${request.repositoryRelativePath}`);
  }
  return readFile(resolvedCandidate, 'utf8');
}
