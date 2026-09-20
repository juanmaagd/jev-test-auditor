import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  JevAbortError,
  JevAuthError,
  JevConfigurationError,
  JevRateLimitError,
  JevRequestError,
  JevResponseError,
  JevTimeoutError,
  type JevGatewayError,
} from '../src/domain/jev-gateway.js';
import type { JevRequest, JevState } from '../src/domain/jev-request.js';
import { canonicalizeJevRequest } from '../src/domain/jev-request.js';
import { JEV_MODEL_ID } from '../src/domain/rubric.js';
import type { TestCaseId } from '../src/domain/test-understanding.js';
import {
  createJevHttpGateway,
  DEFAULT_JEV_RETRY_CONFIG,
  DEFAULT_JEV_TIMEOUT_MS,
  JEV_TYPESAFE_BASE_URL,
  type JevFetch,
} from '../src/adapters/jev-http-gateway.js';

const API_KEY = 'sk-typesafe-test-secret-9f3e';

const sampleState: JevState = {
  testCaseId: 'tc:v1:sample' as TestCaseId,
  name: 'adds numbers',
  structuralAncestry: [{ kind: 'test', name: 'adds numbers' }],
  framework: 'vitest',
  repositoryRelativePath: 'a.test.ts',
  modifiers: [],
  fragments: [],
  denied: [],
  unresolved: [],
  omitted: [],
};

const sampleRequest: JevRequest = {
  state: sampleState,
  model: JEV_MODEL_ID,
  questions: {
    'dimension.applicable': { type: 'noul', instructions: 'Is there enough evidence?' },
    'dimension.quality': {
      type: 'score',
      instructions: 'How good?',
      criteria: ['Misleading', 'Weak', 'Acceptable', 'Strong'],
    },
  },
};

const validAnswers = {
  'dimension.applicable': { type: 'noul', noul: 0.87 },
  'dimension.quality': {
    type: 'score',
    score: 0.75,
    legend: { '0': 'Misleading', '1': 'Weak', '2': 'Acceptable', '3': 'Strong' },
    probabilities: { '0': 0.05, '1': 0.1, '2': 0.6, '3': 0.25 },
    confidence: 0.82,
  },
};

const validSuccessBody = {
  model: JEV_MODEL_ID,
  answers: validAnswers,
  usage: { input_tokens: 512, output_tokens: 0 },
};

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

/**
 * A `sleep` stub shared by every test that is not specifically about
 * timeout behavior. It never resolves the timeout-wait call (`ms ===
 * timeoutMs`) on its own — only via the signal it was given being aborted,
 * exactly like the real default `sleep` cancels a pending timer once an
 * attempt has already settled. This is deliberate: an `async () => {}`
 * stub would resolve the timeout race on the very first microtask, racing
 * against the stub fetch's own resolution non-deterministically. Every
 * other call (a retry backoff wait) resolves immediately; its `ms` is
 * still recorded so tests can assert on backoff bounds.
 */
function makeSleepStub(timeoutMs: number, calls: number[]): (ms: number, signal?: AbortSignal) => Promise<void> {
  return (ms: number, signal?: AbortSignal) => {
    if (ms !== timeoutMs) calls.push(ms);
    if (ms === timeoutMs) {
      return new Promise((resolve) => {
        if (signal?.aborted) {
          resolve();
          return;
        }
        signal?.addEventListener('abort', () => resolve(), { once: true });
      });
    }
    return Promise.resolve();
  };
}

const TIMEOUT_SENTINEL_MS = 54_321;

/** A `fetch` stub that never settles on its own — only when its `init.signal` is aborted, exactly like real `fetch` behaves once its request is aborted. Shared by every timeout/abort test so none of them rely on tick-ordering luck. */
function makeHangingFetch(): ReturnType<typeof vi.fn> {
  return vi.fn<JevFetch>().mockImplementation(
    (_url: string | URL | Request, init?: RequestInit) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        reject(new DOMException('The operation was aborted.', 'AbortError'));
      }, { once: true });
    }),
  );
}

function fixture(overrides: Parameters<typeof createJevHttpGateway>[0] = {}): {
  fetchMock: ReturnType<typeof vi.fn>;
  sleepCalls: number[];
  gateway: ReturnType<typeof createJevHttpGateway>;
} {
  const fetchMock = vi.fn<JevFetch>();
  const sleepCalls: number[] = [];
  const gateway = createJevHttpGateway({
    apiKey: API_KEY,
    fetch: fetchMock as unknown as JevFetch,
    timeoutMs: TIMEOUT_SENTINEL_MS,
    sleep: makeSleepStub(TIMEOUT_SENTINEL_MS, sleepCalls),
    now: () => 1_700_000_000_000,
    ...overrides,
  });
  return { fetchMock, sleepCalls, gateway };
}

let globalFetchSpy: ReturnType<typeof vi.fn>;
let originalFetch: typeof fetch;
let originalEnvKey: string | undefined;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  globalFetchSpy = vi.fn(() => {
    throw new Error('real network access is not allowed in tests');
  });
  globalThis.fetch = globalFetchSpy as unknown as typeof fetch;
  originalEnvKey = process.env['TYPESAFE_API_KEY'];
  delete process.env['TYPESAFE_API_KEY'];
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalEnvKey === undefined) {
    delete process.env['TYPESAFE_API_KEY'];
  } else {
    process.env['TYPESAFE_API_KEY'] = originalEnvKey;
  }
});

describe('createJevHttpGateway — configuration', () => {
  it('throws JevConfigurationError before any request when no api key is available', () => {
    expect(() => createJevHttpGateway({ fetch: vi.fn() as unknown as JevFetch })).toThrow(JevConfigurationError);
    expect(globalFetchSpy).not.toHaveBeenCalled();
  });

  it('throws JevConfigurationError when apiKey is blank', () => {
    expect(() => createJevHttpGateway({ apiKey: '   ', fetch: vi.fn() as unknown as JevFetch })).toThrow(
      JevConfigurationError,
    );
  });

  it('accepts an api key from TYPESAFE_API_KEY when no explicit apiKey option is given', async () => {
    process.env['TYPESAFE_API_KEY'] = API_KEY;
    const fetchMock = vi.fn<JevFetch>().mockResolvedValue(jsonResponse(200, validSuccessBody));
    const gateway = createJevHttpGateway({
      fetch: fetchMock as unknown as JevFetch,
      sleep: makeSleepStub(DEFAULT_JEV_TIMEOUT_MS, []),
    });

    await expect(gateway.evaluate(sampleRequest)).resolves.toMatchObject({ attempts: 1 });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)['Authorization']).toBe(`Bearer ${API_KEY}`);
  });

  it('exposes documented default timeout and retry constants', () => {
    expect(DEFAULT_JEV_TIMEOUT_MS).toBe(60_000);
    expect(DEFAULT_JEV_RETRY_CONFIG).toEqual({
      maxRetries: 3,
      initialBackoffMs: 500,
      maxBackoffMs: 30_000,
      random: Math.random,
    });
    expect(JEV_TYPESAFE_BASE_URL).toBe('https://api.typesafe.ai/v1/systemone');
  });
});

describe('evaluate — happy path', () => {
  it('resolves normalized noul and score answers, usage, and attempts', async () => {
    const { fetchMock, gateway } = fixture();
    fetchMock.mockResolvedValue(jsonResponse(200, validSuccessBody));

    const result = await gateway.evaluate(sampleRequest);

    expect(result).toEqual({
      requestedModel: JEV_MODEL_ID,
      respondedModel: JEV_MODEL_ID,
      modelMatchesPin: true,
      answers: {
        'dimension.applicable': {
          type: 'noul',
          probability: 0.87,
          raw: { type: 'noul', noul: 0.87 },
        },
        'dimension.quality': {
          type: 'score',
          score: 0.75,
          legend: { '0': 'Misleading', '1': 'Weak', '2': 'Acceptable', '3': 'Strong' },
          probabilities: { '0': 0.05, '1': 0.1, '2': 0.6, '3': 0.25 },
          confidence: 0.82,
          raw: validAnswers['dimension.quality'],
        },
      },
      usage: { inputTokens: 512, outputTokens: 0 },
      attempts: 1,
      // `fixture()`'s default `now` (line ~125) is a constant clock, so a single attempt's
      // wall-clock delta is deterministically 0 — see the "evaluate — latency measurement"
      // tests below for a clock that actually advances between calls.
      latencyMs: 0,
      attemptLatenciesMs: [0],
    });
    expect(globalFetchSpy).not.toHaveBeenCalled();
  });

  it('sends the exact canonical request bytes and required headers to the configured URL', async () => {
    const { fetchMock, gateway } = fixture();
    fetchMock.mockResolvedValue(jsonResponse(200, validSuccessBody));

    await gateway.evaluate(sampleRequest);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(JEV_TYPESAFE_BASE_URL);
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({
      Authorization: `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    });
    expect(init.body).toBe(canonicalizeJevRequest(sampleRequest));
  });

  it('reports a model mismatch instead of throwing', async () => {
    const { fetchMock, gateway } = fixture();
    fetchMock.mockResolvedValue(jsonResponse(200, { ...validSuccessBody, model: 'jev-1.12.0' }));

    const result = await gateway.evaluate(sampleRequest);

    expect(result.respondedModel).toBe('jev-1.12.0');
    expect(result.requestedModel).toBe(JEV_MODEL_ID);
    expect(result.modelMatchesPin).toBe(false);
  });

  it('falls back to globalThis.fetch when no fetch override is provided', async () => {
    globalFetchSpy.mockReset();
    globalFetchSpy.mockResolvedValue(jsonResponse(200, validSuccessBody));
    const gateway = createJevHttpGateway({
      apiKey: API_KEY,
      timeoutMs: TIMEOUT_SENTINEL_MS,
      sleep: makeSleepStub(TIMEOUT_SENTINEL_MS, []),
    });

    const result = await gateway.evaluate(sampleRequest);

    expect(result.attempts).toBe(1);
    expect(globalFetchSpy).toHaveBeenCalledTimes(1);
  });
});

describe('evaluate — status mapping', () => {
  it('maps 401 to JevAuthError without retrying, even when the body echoes the key', async () => {
    const { fetchMock, gateway } = fixture();
    fetchMock.mockResolvedValue(jsonResponse(401, { error: { message: `invalid key: ${API_KEY}` } }));

    const error = await gateway.evaluate(sampleRequest).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(JevAuthError);
    expect((error as JevAuthError).attempts).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    assertNeverLeaksKey(error as Error);
  });

  it('maps 422 to JevRequestError carrying the redacted field message, never the request body', async () => {
    const { fetchMock, gateway } = fixture();
    fetchMock.mockResolvedValue(
      jsonResponse(422, { error: { field: 'model', message: `model must be pinned (key was ${API_KEY})` } }),
    );

    const error = await gateway.evaluate(sampleRequest).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(JevRequestError);
    const requestError = error as JevRequestError;
    expect(requestError.field).toBe('model');
    expect(requestError.message).toContain('[redacted]');
    expect(requestError.message).not.toContain(API_KEY);
    expect(requestError.message).not.toContain(sampleState.testCaseId);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('maps any other non-2xx status to JevResponseError carrying the status, without retrying', async () => {
    const { fetchMock, gateway } = fixture();
    fetchMock.mockResolvedValue(jsonResponse(500, { error: { message: 'internal' } }));

    const error = await gateway.evaluate(sampleRequest).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(JevResponseError);
    expect((error as JevResponseError).status).toBe(500);
    expect((error as JevResponseError).attempts).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('evaluate — retry on 429/529', () => {
  it('retries a 429 once then succeeds, using full-jitter exponential backoff', async () => {
    const { fetchMock, gateway, sleepCalls } = fixture({ retry: { random: () => 0.5 } });
    fetchMock
      .mockResolvedValueOnce(jsonResponse(429, {}))
      .mockResolvedValueOnce(jsonResponse(200, validSuccessBody));

    const result = await gateway.evaluate(sampleRequest);

    expect(result.attempts).toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // initialBackoffMs (500) * 2^0 = 500; full jitter at random()=0.5 -> 250.
    expect(sleepCalls).toEqual([250]);
  });

  it('retries a 529 the same way as a 429', async () => {
    const { fetchMock, gateway } = fixture({ retry: { random: () => 1 } });
    fetchMock
      .mockResolvedValueOnce(jsonResponse(529, {}))
      .mockResolvedValueOnce(jsonResponse(200, validSuccessBody));

    const result = await gateway.evaluate(sampleRequest);

    expect(result.attempts).toBe(2);
  });

  it('honors a numeric retry-after header (seconds)', async () => {
    const { fetchMock, gateway, sleepCalls } = fixture();
    fetchMock
      .mockResolvedValueOnce(jsonResponse(429, {}, { 'retry-after': '2' }))
      .mockResolvedValueOnce(jsonResponse(200, validSuccessBody));

    await gateway.evaluate(sampleRequest);

    expect(sleepCalls).toEqual([2_000]);
  });

  it('honors an HTTP-date retry-after header', async () => {
    const nowMs = 1_700_000_000_000;
    const retryAtMs = nowMs + 5_000;
    const { fetchMock, gateway, sleepCalls } = fixture({ now: () => nowMs });
    fetchMock
      .mockResolvedValueOnce(jsonResponse(429, {}, { 'retry-after': new Date(retryAtMs).toUTCString() }))
      .mockResolvedValueOnce(jsonResponse(200, validSuccessBody));

    await gateway.evaluate(sampleRequest);

    expect(sleepCalls).toEqual([5_000]);
  });

  it('caps an absurdly large retry-after value at maxBackoffMs', async () => {
    const { fetchMock, gateway, sleepCalls } = fixture({ retry: { maxBackoffMs: 2_000 } });
    fetchMock
      .mockResolvedValueOnce(jsonResponse(429, {}, { 'retry-after': '999999' }))
      .mockResolvedValueOnce(jsonResponse(200, validSuccessBody));

    await gateway.evaluate(sampleRequest);

    expect(sleepCalls).toEqual([2_000]);
  });

  it('exhausts bounded retries and throws the last typed error, carrying the total attempt count', async () => {
    const { fetchMock, gateway } = fixture({ retry: { maxRetries: 2, random: () => 0 } });
    // A fresh Response per call: a Response body can only be read once, and this
    // gateway reads it inside every attempt (see `attemptOnce`'s module doc).
    fetchMock.mockImplementation(async () => jsonResponse(429, {}));

    const error = await gateway.evaluate(sampleRequest).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(JevRateLimitError);
    expect((error as JevRateLimitError).attempts).toBe(3);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

/**
 * A scripted `now` stub for latency tests (P6-1): returns each of `values` in order, one per
 * call, and throws if called more times than `values` has entries — an over-call is exactly the
 * kind of drift (an extra or missing `nowFn()` call site) this task's latency instrumentation
 * must not introduce, so it must fail loudly rather than silently returning `undefined`/`NaN`.
 */
function scriptedNow(values: readonly number[]): () => number {
  let index = 0;
  return () => {
    if (index >= values.length) {
      throw new Error(`scriptedNow: called more times (${index + 1}) than the ${values.length} scripted values allow`);
    }
    const value = values[index]!;
    index += 1;
    return value;
  };
}

describe('evaluate — latency measurement (P6-1)', () => {
  it('measures a single successful attempt\'s whole-call latency and its own one-entry per-attempt latency, via the injectable clock', async () => {
    const now = scriptedNow([
      1_700_000_000_000, // evaluate() call start
      1_700_000_000_000, // attempt 1 start
      1_700_000_000_120, // attempt 1 end -> 120ms
      1_700_000_000_300, // evaluate() call end -> 300ms total
    ]);
    const { fetchMock, gateway } = fixture({ now });
    fetchMock.mockResolvedValue(jsonResponse(200, validSuccessBody));

    const result = await gateway.evaluate(sampleRequest);

    expect(result.attempts).toBe(1);
    expect(result.attemptLatenciesMs).toEqual([120]);
    expect(result.latencyMs).toBe(300);
  });

  it(
    'on a retried request, records one latency entry per HTTP attempt and a whole-call total that '
    + 'includes the backoff wait between them — telling "genuinely slow" apart from "fast but throttled"',
    async () => {
      const now = scriptedNow([
        1_700_000_000_000, // evaluate() call start
        1_700_000_000_000, // attempt 1 (429) start
        1_700_000_000_050, // attempt 1 end -> 50ms
        1_700_000_000_600, // attempt 2 start (after the backoff sleep)
        1_700_000_000_650, // attempt 2 end -> 50ms
        1_700_000_000_700, // evaluate() call end -> 700ms total
      ]);
      const { fetchMock, gateway } = fixture({ now, retry: { random: () => 0 } });
      fetchMock
        .mockResolvedValueOnce(jsonResponse(429, {}))
        .mockResolvedValueOnce(jsonResponse(200, validSuccessBody));

      const result = await gateway.evaluate(sampleRequest);

      expect(result.attempts).toBe(2);
      // Every per-attempt latency is fast (50ms each) — sum 100ms — but the whole-call total
      // (700ms) is far larger, because it also covers the backoff wait between attempts. A
      // caller that only looked at the per-attempt numbers would wrongly conclude the provider
      // answered quickly every time; the whole-call total is what actually tells this case apart
      // from a genuinely slow provider.
      expect(result.attemptLatenciesMs).toEqual([50, 50]);
      expect(result.latencyMs).toBe(700);
      expect(result.latencyMs).not.toBe((result.attemptLatenciesMs ?? []).reduce((sum, ms) => sum + ms, 0));
    },
  );
});

describe('evaluate — timeout', () => {
  it('throws JevTimeoutError when the request hangs past timeoutMs, without retrying', async () => {
    const hangingFetch = makeHangingFetch();
    const gateway = createJevHttpGateway({
      apiKey: API_KEY,
      fetch: hangingFetch as unknown as JevFetch,
      timeoutMs: 10,
      // This test's own sleep resolves the timeout wait immediately (simulating
      // elapsed time) rather than waiting for cancellation, since it is the one
      // test that wants the timeout branch to actually fire.
      sleep: async () => {},
    });

    const error = await gateway.evaluate(sampleRequest).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(JevTimeoutError);
    expect((error as JevTimeoutError).timeoutMs).toBe(10);
    expect((error as JevTimeoutError).attempts).toBe(1);
    expect(hangingFetch).toHaveBeenCalledTimes(1);
  });

  it('throws JevTimeoutError (not JevResponseError) when the timeout lands mid body-read', async () => {
    // The response headers arrive fine; only the body stream hangs until aborted.
    // Proves the timeout guard covers the body read, not just obtaining headers —
    // aborting only after headers arrive would tear down this stream and turn a
    // real timeout into a bogus "invalid JSON" JevResponseError instead.
    const streamingFetch = vi.fn<JevFetch>().mockImplementation(
      (_url: string | URL | Request, init?: RequestInit) => Promise.resolve(
        new Response(
          new ReadableStream({
            start(controller) {
              init?.signal?.addEventListener('abort', () => {
                controller.error(new DOMException('The operation was aborted.', 'AbortError'));
              }, { once: true });
            },
          }),
          { status: 200 },
        ),
      ),
    );
    const gateway = createJevHttpGateway({
      apiKey: API_KEY,
      fetch: streamingFetch as unknown as JevFetch,
      timeoutMs: 10,
      sleep: async () => {},
    });

    const error = await gateway.evaluate(sampleRequest).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(JevTimeoutError);
  });

  it('(real timers) throws JevTimeoutError from the production default sleep, no sleep override', async () => {
    const hangingFetch = makeHangingFetch();
    const gateway = createJevHttpGateway({
      apiKey: API_KEY,
      fetch: hangingFetch as unknown as JevFetch,
      timeoutMs: 5,
      // No `sleep` override: exercises the real `defaultSleep` (real `setTimeout`,
      // cancel-on-abort, listener cleanup) instead of an injected stub. Fast and
      // non-flaky because the hanging fetch only ever settles via the abort it
      // waits for — there is no second clock to race against.
    });

    const error = await gateway.evaluate(sampleRequest).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(JevTimeoutError);
    expect(hangingFetch).toHaveBeenCalledTimes(1);
  });

  it('(real timers) retries a 429 using the production default sleep for backoff, no sleep override', async () => {
    const fetchMock = vi.fn<JevFetch>()
      .mockResolvedValueOnce(jsonResponse(429, {}))
      .mockResolvedValueOnce(jsonResponse(200, validSuccessBody));
    const gateway = createJevHttpGateway({
      apiKey: API_KEY,
      fetch: fetchMock as unknown as JevFetch,
      retry: { initialBackoffMs: 1, maxBackoffMs: 5, random: () => 1 },
      // No `sleep` override here either: the ~1-5ms real backoff wait is fast
      // enough to keep this deterministic and quick.
    });

    const result = await gateway.evaluate(sampleRequest);

    expect(result.attempts).toBe(2);
  });
});

describe('evaluate — abort', () => {
  it('throws JevAbortError with attempts=0 when the caller signal is already aborted', async () => {
    const { fetchMock, gateway } = fixture();
    const controller = new AbortController();
    controller.abort();

    const error = await gateway.evaluate(sampleRequest, { signal: controller.signal }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(JevAbortError);
    expect((error as JevAbortError).attempts).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('throws JevAbortError when the caller aborts mid-flight', async () => {
    const hangingFetch = makeHangingFetch();
    const gateway = createJevHttpGateway({
      apiKey: API_KEY,
      fetch: hangingFetch as unknown as JevFetch,
      timeoutMs: TIMEOUT_SENTINEL_MS,
      sleep: makeSleepStub(TIMEOUT_SENTINEL_MS, []),
    });
    const controller = new AbortController();

    const pending = gateway.evaluate(sampleRequest, { signal: controller.signal });
    controller.abort();
    const error = await pending.catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(JevAbortError);
    expect((error as JevAbortError).attempts).toBe(1);
  });
});

describe('evaluate — malformed / partial responses', () => {
  it('throws JevResponseError for a non-JSON body', async () => {
    const { fetchMock, gateway } = fixture();
    fetchMock.mockResolvedValue(new Response('not json {{', { status: 200 }));

    await expect(gateway.evaluate(sampleRequest)).rejects.toBeInstanceOf(JevResponseError);
  });

  it('throws JevResponseError when usage is missing finite token counts', async () => {
    const { fetchMock, gateway } = fixture();
    fetchMock.mockResolvedValue(jsonResponse(200, { ...validSuccessBody, usage: { input_tokens: 'a lot' } }));

    await expect(gateway.evaluate(sampleRequest)).rejects.toBeInstanceOf(JevResponseError);
  });

  it('throws JevResponseError naming a question id missing from the answers', async () => {
    const { fetchMock, gateway } = fixture();
    const partialAnswers: Record<string, unknown> = { ...validAnswers };
    delete partialAnswers['dimension.quality'];
    fetchMock.mockResolvedValue(jsonResponse(200, { ...validSuccessBody, answers: partialAnswers }));

    const error = await gateway.evaluate(sampleRequest).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(JevResponseError);
    expect((error as JevResponseError).questionId).toBe('dimension.quality');
  });

  it('throws JevResponseError for an unknown answer type, naming the question id', async () => {
    const { fetchMock, gateway } = fixture();
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        ...validSuccessBody,
        answers: { ...validAnswers, 'dimension.applicable': { type: 'choice', value: 'yes' } },
      }),
    );

    const error = await gateway.evaluate(sampleRequest).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(JevResponseError);
    expect((error as JevResponseError).questionId).toBe('dimension.applicable');
  });

  it('throws JevResponseError for a non-finite noul value', async () => {
    const { fetchMock, gateway } = fixture();
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        ...validSuccessBody,
        answers: { ...validAnswers, 'dimension.applicable': { type: 'noul', noul: Number.NaN } },
      }),
    );

    await expect(gateway.evaluate(sampleRequest)).rejects.toBeInstanceOf(JevResponseError);
  });

  it('throws JevResponseError when probabilities is not a finite map', async () => {
    const { fetchMock, gateway } = fixture();
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        ...validSuccessBody,
        answers: {
          ...validAnswers,
          'dimension.quality': { ...validAnswers['dimension.quality'], probabilities: { '0': 'high' } },
        },
      }),
    );

    await expect(gateway.evaluate(sampleRequest)).rejects.toBeInstanceOf(JevResponseError);
  });

  it('throws JevResponseError when the response answers an unrequested question id', async () => {
    const { fetchMock, gateway } = fixture();
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        ...validSuccessBody,
        answers: { ...validAnswers, 'not-requested.quality': { type: 'noul', noul: 0.1 } },
      }),
    );

    const error = await gateway.evaluate(sampleRequest).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(JevResponseError);
    expect((error as JevResponseError).questionId).toBe('not-requested.quality');
  });
});

function assertNeverLeaksKey(subject: unknown): void {
  const asError = subject instanceof Error ? subject : undefined;
  if (asError) {
    expect(asError.message).not.toContain(API_KEY);
    expect(asError.stack ?? '').not.toContain(API_KEY);
    expect(String(asError)).not.toContain(API_KEY);
  }
  expect(JSON.stringify(subject) ?? '').not.toContain(API_KEY);
}

describe('secret hygiene', () => {
  it('never leaks the api key from any typed error, across every mapped failure', async () => {
    const scenarios: Array<() => Promise<unknown>> = [
      async () => createJevHttpGateway({ fetch: vi.fn() as unknown as JevFetch }),
      async () => {
        const { fetchMock, gateway } = fixture();
        fetchMock.mockResolvedValue(jsonResponse(401, { error: { message: `bad key ${API_KEY}` } }));
        return gateway.evaluate(sampleRequest);
      },
      async () => {
        const { fetchMock, gateway } = fixture();
        fetchMock.mockResolvedValue(jsonResponse(422, { error: { field: 'model', message: API_KEY } }));
        return gateway.evaluate(sampleRequest);
      },
      async () => {
        const { fetchMock, gateway } = fixture({ retry: { maxRetries: 0 } });
        fetchMock.mockResolvedValue(jsonResponse(429, {}));
        return gateway.evaluate(sampleRequest);
      },
      async () => {
        const { fetchMock, gateway } = fixture({ retry: { maxRetries: 0 } });
        fetchMock.mockResolvedValue(jsonResponse(529, {}));
        return gateway.evaluate(sampleRequest);
      },
      async () => {
        const { fetchMock, gateway } = fixture();
        fetchMock.mockResolvedValue(new Response('not json', { status: 200 }));
        return gateway.evaluate(sampleRequest);
      },
      async () => {
        const { fetchMock, gateway } = fixture();
        fetchMock.mockResolvedValue(jsonResponse(500, { error: { message: `internal failure near key ${API_KEY}` } }));
        return gateway.evaluate(sampleRequest);
      },
      async () => {
        // A transport/proxy failure that echoes the Authorization header back
        // into its own thrown error message — the realistic leak vector for
        // the network-error path, not this adapter's own interpolation.
        const { fetchMock, gateway } = fixture();
        fetchMock.mockRejectedValue(new Error(`connect failed: Authorization: Bearer ${API_KEY}`));
        return gateway.evaluate(sampleRequest);
      },
      async () => {
        const hangingFetch = makeHangingFetch();
        const gateway = createJevHttpGateway({
          apiKey: API_KEY,
          fetch: hangingFetch as unknown as JevFetch,
          timeoutMs: 10,
          sleep: async () => {},
        });
        return gateway.evaluate(sampleRequest);
      },
      async () => {
        const hangingFetch = makeHangingFetch();
        const gateway = createJevHttpGateway({
          apiKey: API_KEY,
          fetch: hangingFetch as unknown as JevFetch,
          timeoutMs: TIMEOUT_SENTINEL_MS,
          sleep: makeSleepStub(TIMEOUT_SENTINEL_MS, []),
        });
        const controller = new AbortController();
        const pending = gateway.evaluate(sampleRequest, { signal: controller.signal });
        controller.abort();
        return pending;
      },
    ];

    for (const scenario of scenarios) {
      const outcome = await scenario().then(
        (value) => value,
        (error: unknown) => error,
      );
      const error: JevGatewayError = outcome as JevGatewayError;
      expect(error).toBeInstanceOf(Error);
      assertNeverLeaksKey(error);
    }
  });

  it('never leaks the api key when the gateway object itself is stringified', () => {
    const { gateway } = fixture();

    expect(JSON.stringify(gateway)).not.toContain(API_KEY);
    expect(String(gateway)).not.toContain(API_KEY);
    expect(Object.keys(gateway)).not.toContain('apiKey');
  });
});
