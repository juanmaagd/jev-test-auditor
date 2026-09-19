export function isOutsideRootRelative(relativeResult: string): boolean {
  const normalized = relativeResult.replaceAll('\\', '/');
  return normalized === '..'
    || normalized.startsWith('../')
    || normalized.startsWith('/')
    || /^[A-Za-z]:\//u.test(normalized);
}
