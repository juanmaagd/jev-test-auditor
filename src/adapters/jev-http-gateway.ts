/**
 * The TypeSafe HTTP gateway adapter (Phase 4, task P4-2): a hand-rolled
 * `fetch` client implementing `JevGatewayPort` (see `src/domain/jev-gateway.ts`)
 * against the verified provider contract (`odd/tasks/phase-4-jev-evaluation.md`):
 * `POST https://api.typesafe.ai/v1/systemone`, `Authorization: Bearer`,
 * `{ state, model, questions }`, answers keyed by question id, errors
 * 401/422/429/529, retry only 429/529 with exponential backoff honoring
 * `retry-after`.
 *
 * `fetch`, `sleep`, and `now` are all injectable so tests never touch the
 * network or a real clock (see `test/jev-http-gateway.test.ts`). This is
 * also the one file in `src/` allowed to call a bare `fetch(...)`
 * (`test/architecture-boundary.test.ts` forbids that everywhere else): the
 * local binding below always resolves to either the caller-injected `fetch`
 * or `globalThis.fetch` — never a new import of `node:http`/`node:https`/
 * `node:net`/`node:tls`/`undici`, which stays forbidden repository-wide.
 */
import {
  JevAbortError,
  JevAuthError,
  JevConfigurationError,
  JevOverloadedError,
  JevRateLimitError,
  JevRequestError,
  JevResponseError,
  JevTimeoutError,
  type JevAnswer,
  type JevEvaluation,
  type JevGatewayEvaluateOptions,
  type JevGatewayPort,
} from '../domain/jev-gateway.js';
import { canonicalizeJevRequest, type JevRequest } from '../domain/jev-request.js';

export type JevFetch = typeof globalThis.fetch;
export type JevSleep = (ms: number, signal?: AbortSignal) => Promise<void>;

export interface JevRetryConfig {
  readonly maxRetries: number;
  readonly initialBackoffMs: number;
  readonly maxBackoffMs: number;
  readonly random: () => number;
}

/** 60 seconds: generous enough for a single Jev call under normal load, per Phase 4 Decisions. */
export const DEFAULT_JEV_TIMEOUT_MS = 60_000;

/**
 * 3 retries (4 attempts total), full-jitter exponential backoff starting at
 * 500ms and capped at 30s: retries only ever happen for 429/529 (see
 * `evaluate` below), and this bound keeps a rate-limited or overloaded run
 * from stalling indefinitely while still giving the provider real room to
 * recover.
 */
export const DEFAULT_JEV_RETRY_CONFIG: JevRetryConfig = {
  maxRetries: 3,
  initialBackoffMs: 500,
  maxBackoffMs: 30_000,
  random: Math.random,
};

export const JEV_TYPESAFE_BASE_URL = 'https://api.typesafe.ai/v1/systemone';

export interface CreateJevHttpGatewayOptions {
  readonly apiKey?: string;
  readonly baseUrl?: string;
  readonly fetch?: JevFetch;
  readonly timeoutMs?: number;
  readonly retry?: Partial<JevRetryConfig>;
  readonly now?: () => number;
  readonly sleep?: JevSleep;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isPlainObject(value) && Object.values(value).every((entry) => typeof entry === 'string');
}

function isFiniteNumberRecord(value: unknown): value is Record<string, number> {
  return isPlainObject(value) && Object.values(value).every((entry) => isFiniteNumber(entry));
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Replaces every occurrence of `secret` in server-derived text with a fixed
 * marker before that text is ever allowed to reach an error message. The
 * realistic key-leak vector is not this adapter interpolating the key
 * itself (it never does — see `JevAuthError`/`JevRequestError` in
 * `src/domain/jev-gateway.ts`) but a provider echoing the `Authorization`
 * header back in an error body; this is the defense against that.
 */
function redact(text: string, secret: string): string {
  return secret.length === 0 ? text : text.split(secret).join('[redacted]');
}

/** Default `sleep`: a cancelable timer. Resolving on `signal` abort (never rejecting) lets a cancelled wait — a settled attempt's pending timeout race, or a caller abort during backoff — return promptly instead of running the full duration. */
function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

type AttemptOutcome =
  | { readonly kind: 'success'; readonly status: number; readonly headers: Headers; readonly bodyText: string }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'aborted' }
  | { readonly kind: 'network-error'; readonly error: unknown };

/**
 * Performs exactly one HTTP attempt end to end — including reading the
 * whole response body — under a single timeout/abort guard. The body read
 * happens *inside* this guarded region deliberately: aborting only after
 * headers arrive (a mistake this adapter does not make) would tear down the
 * body stream and turn every real success into a bogus "invalid JSON"
 * `JevResponseError`.
 *
 * Two independent `AbortController`s: `requestController` is the signal
 * actually passed to `fetchImpl`, and is aborted only by a genuine caller
 * abort or a real timeout — never as post-hoc cleanup, so a response that
 * already arrived is never torn down. `timerCancelController` exists solely
 * to cancel the pending timeout-wait `sleep` call once this attempt has
 * settled for any other reason, so a long `timeoutMs` never leaves a
 * dangling timer (or, on a pooled long-lived caller signal, a leaked
 * listener) behind it.
 */
async function attemptOnce(
  fetch: JevFetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
  sleepFn: JevSleep,
  callerSignal: AbortSignal | undefined,
): Promise<AttemptOutcome> {
  const requestController = new AbortController();
  const timerCancelController = new AbortController();
  const onCallerAbort = (): void => requestController.abort();
  if (callerSignal) {
    if (callerSignal.aborted) requestController.abort();
    else callerSignal.addEventListener('abort', onCallerAbort, { once: true });
  }

  let timedOut = false;
  const timeoutWait = sleepFn(timeoutMs, timerCancelController.signal).then(() => {
    if (!requestController.signal.aborted) {
      timedOut = true;
      requestController.abort();
    }
  });
  timeoutWait.catch(() => {});

  try {
    // The one reviewed bare `fetch(...)` call site in `src/` (see the module
    // doc above): `fetch` here is always the caller-injected implementation
    // or `globalThis.fetch`, as resolved by `createJevHttpGateway` and
    // threaded through as this parameter — never a new network-module import.
    const response = await fetch(url, { ...init, signal: requestController.signal });
    const bodyText = await response.text();
    return { kind: 'success', status: response.status, headers: response.headers, bodyText };
  } catch (error) {
    if (callerSignal?.aborted) return { kind: 'aborted' };
    if (timedOut) return { kind: 'timeout' };
    return { kind: 'network-error', error };
  } finally {
    timerCancelController.abort();
    if (callerSignal) callerSignal.removeEventListener('abort', onCallerAbort);
  }
}

/** Parses `retry-after` as either whole seconds or an HTTP-date, per the verified provider contract. Returns `undefined` when absent or unparseable, never negative. */
function parseRetryAfterMs(headerValue: string | null, nowFn: () => number): number | undefined {
  if (headerValue === null) return undefined;
  const trimmed = headerValue.trim();
  if (trimmed.length === 0) return undefined;
  if (/^\d+$/u.test(trimmed)) return Number(trimmed) * 1000;
  const parsedMs = Date.parse(trimmed);
  if (Number.isNaN(parsedMs)) return undefined;
  return Math.max(0, parsedMs - nowFn());
}

/** Full-jitter exponential backoff (AWS's `sleep = random_between(0, min(cap, base * 2**attempt))`), or the honored (and capped) `retry-after` when the provider sent one. */
function computeBackoffDelayMs(
  retryIndex: number,
  retryAfterMs: number | undefined,
  retry: JevRetryConfig,
): number {
  if (retryAfterMs !== undefined) return Math.min(retryAfterMs, retry.maxBackoffMs);
  const exponential = retry.initialBackoffMs * 2 ** retryIndex;
  const capped = Math.min(exponential, retry.maxBackoffMs);
  return retry.random() * capped;
}

function extractServerError(bodyText: string, apiKey: string): { readonly field: string | undefined; readonly message: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    parsed = undefined;
  }
  const record = isPlainObject(parsed) ? parsed : undefined;
  const nested = record && isPlainObject(record['error']) ? record['error'] : record;
  const rawField = nested && typeof nested['field'] === 'string' ? nested['field'] : undefined;
  const rawMessage = nested && typeof nested['message'] === 'string' ? nested['message'] : undefined;
  return {
    field: rawField === undefined ? undefined : redact(rawField, apiKey),
    message: rawMessage === undefined
      ? 'Jev rejected the request as invalid (422) with no field message.'
      : redact(rawMessage, apiKey),
  };
}

function normalizeAnswer(questionId: string, raw: unknown, attempts: number): JevAnswer {
  if (!isPlainObject(raw)) {
    throw new JevResponseError(`Jev answer for question "${questionId}" is not a JSON object.`, attempts, { questionId });
  }
  const type = raw['type'];
  if (type === 'noul') {
    const noul = raw['noul'];
    if (!isFiniteNumber(noul)) {
      throw new JevResponseError(`Jev answer for question "${questionId}" has a non-finite "noul" value.`, attempts, { questionId });
    }
    return { type: 'noul', probability: noul, raw: { type: 'noul', noul } };
  }
  if (type === 'score') {
    const score = raw['score'];
    const legend = raw['legend'];
    const probabilities = raw['probabilities'];
    const confidence = raw['confidence'];
    if (!isFiniteNumber(score)) {
      throw new JevResponseError(`Jev answer for question "${questionId}" has a non-finite "score" value.`, attempts, { questionId });
    }
    if (!isStringRecord(legend)) {
      throw new JevResponseError(`Jev answer for question "${questionId}" has an invalid "legend" map.`, attempts, { questionId });
    }
    if (!isFiniteNumberRecord(probabilities)) {
      throw new JevResponseError(`Jev answer for question "${questionId}" has a "probabilities" map that is not all finite numbers.`, attempts, { questionId });
    }
    if (!isFiniteNumber(confidence)) {
      throw new JevResponseError(`Jev answer for question "${questionId}" has a non-finite "confidence" value.`, attempts, { questionId });
    }
    return { type: 'score', score, legend, probabilities, confidence, raw: { type: 'score', score, legend, probabilities, confidence } };
  }
  throw new JevResponseError(`Jev answer for question "${questionId}" has an unknown type "${String(type)}".`, attempts, { questionId });
}

function parseSuccessBody(bodyText: string, request: JevRequest, attempts: number): JevEvaluation {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    throw new JevResponseError('Jev response body was not valid JSON.', attempts);
  }
  if (!isPlainObject(parsed)) {
    throw new JevResponseError('Jev response body must be a JSON object.', attempts);
  }
  const model = parsed['model'];
  const answers = parsed['answers'];
  const usage = parsed['usage'];
  if (typeof model !== 'string' || model.length === 0) {
    throw new JevResponseError('Jev response is missing a valid "model" field.', attempts);
  }
  if (!isPlainObject(answers)) {
    throw new JevResponseError('Jev response is missing a valid "answers" object.', attempts);
  }
  if (!isPlainObject(usage)) {
    throw new JevResponseError('Jev response is missing a valid "usage" object.', attempts);
  }
  const inputTokens = usage['input_tokens'];
  const outputTokens = usage['output_tokens'];
  if (!isFiniteNumber(inputTokens) || !isFiniteNumber(outputTokens)) {
    throw new JevResponseError('Jev response "usage" must carry finite input_tokens and output_tokens.', attempts);
  }

  const requestedQuestionIds = Object.keys(request.questions);
  const requestedIdSet = new Set(requestedQuestionIds);
  for (const answeredId of Object.keys(answers)) {
    if (!requestedIdSet.has(answeredId)) {
      throw new JevResponseError(
        `Jev response includes an answer for an unrequested question id "${answeredId}".`,
        attempts,
        { questionId: answeredId },
      );
    }
  }

  const normalizedAnswers: Record<string, JevAnswer> = {};
  for (const questionId of requestedQuestionIds) {
    const raw = answers[questionId];
    if (raw === undefined) {
      throw new JevResponseError(`Jev response is missing an answer for question "${questionId}".`, attempts, { questionId });
    }
    normalizedAnswers[questionId] = normalizeAnswer(questionId, raw, attempts);
  }

  return {
    requestedModel: request.model,
    respondedModel: model,
    modelMatchesPin: model === request.model,
    answers: normalizedAnswers,
    usage: { inputTokens, outputTokens },
    attempts,
  };
}

/**
 * Creates a {@link JevGatewayPort} backed by the verified TypeSafe HTTP
 * contract. Resolves the API key eagerly — from `options.apiKey`, else
 * `process.env.TYPESAFE_API_KEY` — and throws {@link JevConfigurationError}
 * immediately when it is missing or blank, before any request is ever
 * attempted. Because that check runs here, at construction, a caller must
 * only construct this gateway when evaluation is actually requested (Phase
 * 4 Scope: evaluation is opt-in; without it, no API key is required) —
 * constructing it unconditionally would turn every offline run into a
 * configuration error.
 */
export function createJevHttpGateway(options: CreateJevHttpGatewayOptions = {}): JevGatewayPort {
  const rawApiKey = options.apiKey ?? process.env['TYPESAFE_API_KEY'];
  const apiKey = rawApiKey?.trim() ?? '';
  if (apiKey.length === 0) {
    throw new JevConfigurationError(
      'TypeSafe API key is missing or blank. Set the TYPESAFE_API_KEY environment variable or pass { apiKey } explicitly.',
    );
  }

  const baseUrl = options.baseUrl ?? JEV_TYPESAFE_BASE_URL;
  const timeoutMs = options.timeoutMs ?? DEFAULT_JEV_TIMEOUT_MS;
  const retry: JevRetryConfig = { ...DEFAULT_JEV_RETRY_CONFIG, ...options.retry };
  const nowFn = options.now ?? Date.now;
  const sleepFn: JevSleep = options.sleep ?? defaultSleep;
  // Resolves to whichever `fetch` implementation the caller injected, or
  // `globalThis.fetch` otherwise — never a new network-module import. Passed
  // into `attemptOnce` below, whose own `fetch`-named parameter holds this
  // file's one reviewed bare `fetch(...)` call site (see the module doc).
  const fetch: JevFetch = options.fetch ?? globalThis.fetch;

  async function evaluate(request: JevRequest, evaluateOptions?: JevGatewayEvaluateOptions): Promise<JevEvaluation> {
    const callerSignal = evaluateOptions?.signal;
    if (callerSignal?.aborted) {
      throw new JevAbortError(0);
    }

    const requestBody = canonicalizeJevRequest(request);
    const init: RequestInit = {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: requestBody,
    };

    let attempts = 0;
    for (let retryIndex = 0; ; retryIndex += 1) {
      attempts += 1;
      const outcome = await attemptOnce(fetch, baseUrl, init, timeoutMs, sleepFn, callerSignal);

      if (outcome.kind === 'aborted') throw new JevAbortError(attempts);
      if (outcome.kind === 'timeout') throw new JevTimeoutError(timeoutMs, attempts);
      if (outcome.kind === 'network-error') {
        // Redacted like every other server/transport-derived string: a proxy or
        // an underlying HTTP client can echo request headers (including
        // `Authorization`) back into its own thrown error message.
        throw new JevResponseError(
          `Jev request failed before receiving a response: ${redact(messageOf(outcome.error), apiKey)}`,
          attempts,
        );
      }

      const { status, headers, bodyText } = outcome;

      if (status >= 200 && status < 300) {
        return parseSuccessBody(bodyText, request, attempts);
      }
      if (status === 401) {
        throw new JevAuthError(attempts);
      }
      if (status === 422) {
        const { field, message } = extractServerError(bodyText, apiKey);
        throw new JevRequestError(attempts, message, field);
      }
      if (status === 429 || status === 529) {
        if (retryIndex >= retry.maxRetries) {
          throw status === 429 ? new JevRateLimitError(attempts) : new JevOverloadedError(attempts);
        }
        const retryAfterMs = parseRetryAfterMs(headers.get('retry-after'), nowFn);
        const delayMs = computeBackoffDelayMs(retryIndex, retryAfterMs, retry);
        await sleepFn(delayMs, callerSignal);
        if (callerSignal?.aborted) throw new JevAbortError(attempts);
        continue;
      }
      throw new JevResponseError(`Jev responded with unexpected status ${status}.`, attempts, { status });
    }
  }

  return { evaluate };
}
