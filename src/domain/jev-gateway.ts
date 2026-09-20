/**
 * The Jev evaluation gateway port (Phase 4, task P4-2): pure domain types —
 * the port contract itself, the normalized {@link JevEvaluation} result, and
 * the typed error union a `JevGatewayPort` implementation may throw. No Node
 * imports, no adapter imports: this file only describes the contract the
 * HTTP adapter (`src/adapters/jev-http-gateway.ts`) implements, so switching
 * that adapter for another transport later never touches callers of this
 * port (Phase 4 Scope: "Keep the gateway behind a port so switching to
 * `@typesafe-ai/sdk` later is a one-adapter change").
 *
 * `AbortController`/`AbortSignal` are ambient globals (via `@types/node`'s
 * bundled fetch typings), not a Node-specific import, so referencing them
 * here does not cross the domain/adapter boundary `test/architecture-boundary.test.ts`
 * enforces.
 */
import type { JevRequest } from './jev-request.js';

export interface JevUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

/** A `noul` answer exactly as the verified provider contract returns it. */
export interface JevRawNoulAnswer {
  readonly type: 'noul';
  readonly noul: number;
}

/** A `score` answer exactly as the verified provider contract returns it. */
export interface JevRawScoreAnswer {
  readonly type: 'score';
  readonly score: number;
  readonly legend: Readonly<Record<string, string>>;
  readonly probabilities: Readonly<Record<string, number>>;
  readonly confidence: number;
}

export type JevRawAnswer = JevRawNoulAnswer | JevRawScoreAnswer;

/**
 * A normalized `noul` answer. `probability` is `raw.noul` under its own
 * name, matching how a `score` answer's fields are already named for direct
 * use; `raw` is kept so a later phase (classification, P4-3) can recompute
 * policy from the untouched provider answer without another call (Phase 4
 * acceptance criteria).
 */
export interface JevNoulAnswer {
  readonly type: 'noul';
  readonly probability: number;
  readonly raw: JevRawNoulAnswer;
}

export interface JevScoreAnswer {
  readonly type: 'score';
  readonly score: number;
  readonly legend: Readonly<Record<string, string>>;
  readonly probabilities: Readonly<Record<string, number>>;
  readonly confidence: number;
  readonly raw: JevRawScoreAnswer;
}

export type JevAnswer = JevNoulAnswer | JevScoreAnswer;

/**
 * The normalized result of evaluating one {@link JevRequest}. `answers` is
 * keyed by the same question ids the request sent (`request.questions`'
 * keys), one entry per requested question — never fewer, never an id the
 * request did not ask for (see `src/adapters/jev-http-gateway.ts`'s response
 * validation). `modelMatchesPin` is reported, not thrown: Phase 4 Scope
 * requires a model mismatch to be "reported, never hidden," so a caller
 * decides what to do with a mismatch rather than losing the response to a
 * thrown error.
 */
export interface JevEvaluation {
  readonly requestedModel: string;
  readonly respondedModel: string;
  readonly modelMatchesPin: boolean;
  readonly answers: Readonly<Record<string, JevAnswer>>;
  readonly usage: JevUsage;
  /** Total HTTP attempts made for this evaluation, including the first (never zero for a completed evaluation). */
  readonly attempts: number;
  /**
   * Wall-clock milliseconds for the whole `evaluate()` call, measured around every internal
   * attempt AND every backoff wait between them (Phase 6, task P6-1) — so a genuinely slow
   * provider (one attempt, but a long round trip) reads differently from one that answered fast
   * but was retried after a 429/529 (several fast attempts, a long total because of the backoff
   * waits in between). See {@link attemptLatenciesMs} for the per-attempt breakdown that tells
   * those two cases apart. Never used as a throttle signal — see `runEvaluation`'s own doc
   * (`src/application/audit.ts`) for why that stays derived exclusively from `attempts`/the typed
   * error kind, never from a wall-clock heuristic.
   *
   * Optional, not because a live gateway call ever omits it (`src/adapters/jev-http-gateway.ts`
   * always measures it), but because a `JevEvaluation` reconstructed from a store row written
   * before this field existed (a v2-schema `attempts` row, migrated forward to v3 without this
   * data ever having been captured) has no latency to report — see
   * `src/adapters/sqlite-audit-store.ts`'s `loadAttempt`.
   */
  readonly latencyMs?: number;
  /**
   * One wall-clock millisecond duration per HTTP attempt actually made, in the order those
   * attempts happened — always the same length as {@link attempts}. Each entry covers exactly one
   * `attemptOnce` call (`src/adapters/jev-http-gateway.ts`): the request, and reading its whole
   * response body, but never a backoff wait (those are only reflected in {@link latencyMs}, the
   * whole-call total). Optional for the same reason `latencyMs` is — see that field's own doc.
   */
  readonly attemptLatenciesMs?: readonly number[];
}

export interface JevGatewayEvaluateOptions {
  readonly signal?: AbortSignal;
}

export interface JevGatewayPort {
  evaluate(request: JevRequest, options?: JevGatewayEvaluateOptions): Promise<JevEvaluation>;
}

export type JevGatewayErrorCode =
  | 'configuration'
  | 'timeout'
  | 'abort'
  | 'auth'
  | 'request'
  | 'rate-limit'
  | 'overloaded'
  | 'response';

/**
 * Common base for every typed gateway error. `attempts` is the total number
 * of HTTP attempts made before this error was thrown (0 when no attempt was
 * ever made, e.g. a missing API key or a caller signal that was already
 * aborted before the first attempt started).
 *
 * Deliberately never accepts the API key, or anything derived from it, as a
 * constructor argument: the hard secret-hygiene requirement ("the key must
 * never appear in an error message, `toString`, `JSON.stringify` ... or any
 * log") is enforced by construction here, not by best-effort scrubbing —
 * there is simply no code path through which a key could reach any of these
 * messages. `src/adapters/jev-http-gateway.ts` still redacts server-echoed
 * text before it reaches {@link JevRequestError}, as defense in depth against
 * a provider that echoes the `Authorization` header back in a 422 body.
 */
abstract class JevGatewayErrorBase extends Error {
  abstract readonly code: JevGatewayErrorCode;
  readonly attempts: number;

  protected constructor(message: string, attempts: number) {
    super(message);
    this.attempts = attempts;
    this.name = new.target.name;
  }
}

/** Thrown synchronously by `createJevHttpGateway`, before any request, when no non-blank API key is available. */
export class JevConfigurationError extends JevGatewayErrorBase {
  readonly code = 'configuration' as const;

  constructor(message: string) {
    super(message, 0);
  }
}

/** The request (including any retries already spent) did not complete within `timeoutMs`. Not retried. */
export class JevTimeoutError extends JevGatewayErrorBase {
  readonly code = 'timeout' as const;
  readonly timeoutMs: number;

  constructor(timeoutMs: number, attempts: number) {
    super(`Jev request timed out after ${timeoutMs}ms (attempt ${attempts}).`, attempts);
    this.timeoutMs = timeoutMs;
  }
}

/** The caller's own `AbortSignal` fired. Not retried. */
export class JevAbortError extends JevGatewayErrorBase {
  readonly code = 'abort' as const;

  constructor(attempts: number) {
    super('The Jev evaluation request was aborted by the caller.', attempts);
  }
}

/** HTTP 401: the API key was rejected. Deliberately never echoes any server-provided text, so there is nothing to redact. */
export class JevAuthError extends JevGatewayErrorBase {
  readonly code = 'auth' as const;

  constructor(attempts: number) {
    super('TypeSafe rejected the API key as invalid (401).', attempts);
  }
}

/** HTTP 422: the request body failed validation. `field` and the message text are the server's own words, already redacted by the adapter — never the request body we sent. */
export class JevRequestError extends JevGatewayErrorBase {
  readonly code = 'request' as const;
  readonly field: string | undefined;

  constructor(attempts: number, serverMessage: string, field?: string) {
    super(
      field === undefined
        ? `Jev rejected the request as invalid (422): ${serverMessage}`
        : `Jev rejected the request as invalid (422) for field "${field}": ${serverMessage}`,
      attempts,
    );
    this.field = field;
  }
}

/** HTTP 429, retryable; thrown only once bounded retries are exhausted. */
export class JevRateLimitError extends JevGatewayErrorBase {
  readonly code = 'rate-limit' as const;

  constructor(attempts: number) {
    super(`Jev rate limit exceeded (429) after ${attempts} attempt(s).`, attempts);
  }
}

/** HTTP 529, retryable; thrown only once bounded retries are exhausted. */
export class JevOverloadedError extends JevGatewayErrorBase {
  readonly code = 'overloaded' as const;

  constructor(attempts: number) {
    super(`Jev is temporarily overloaded (529) after ${attempts} attempt(s).`, attempts);
  }
}

/**
 * Every other failure: an unexpected non-2xx status, a response that could
 * not be parsed as JSON, or a response whose shape does not strictly match
 * the verified provider contract (missing/extra/malformed answers, a
 * non-finite number, a `probabilities` map that is not all finite numbers).
 * `questionId` names the offending question when the failure is
 * answer-specific; never invents a value for a field that could not be
 * validated.
 */
export class JevResponseError extends JevGatewayErrorBase {
  readonly code = 'response' as const;
  readonly status: number | undefined;
  readonly questionId: string | undefined;

  constructor(message: string, attempts: number, details: { readonly status?: number; readonly questionId?: string } = {}) {
    super(message, attempts);
    this.status = details.status;
    this.questionId = details.questionId;
  }
}

export type JevGatewayError =
  | JevConfigurationError
  | JevTimeoutError
  | JevAbortError
  | JevAuthError
  | JevRequestError
  | JevRateLimitError
  | JevOverloadedError
  | JevResponseError;
