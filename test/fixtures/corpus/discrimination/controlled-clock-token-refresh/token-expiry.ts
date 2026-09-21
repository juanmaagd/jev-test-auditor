export interface TokenRecord {
  readonly expiresAt: number;
}

export function isTokenExpired(token: TokenRecord, now: number): boolean {
  return now >= token.expiresAt;
}
