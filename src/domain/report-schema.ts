/**
 * The canonical report's published JSON Schema (Phase 6, task P6-2), plus a small hand-rolled
 * validator — deliberately NOT a runtime dependency (`ajv` or similar): this package ships zero
 * runtime dependencies as a stated posture, and a full JSON Schema implementation is far more
 * machinery than validating one fixed, internally-produced shape needs. The validator supports
 * exactly the subset of JSON Schema (draft-07-shaped) `REPORT_JSON_SCHEMA` below actually uses —
 * `type` (a string or an array of strings, for a nullable/union field), `enum`, `properties` +
 * `required` + `additionalProperties` for objects, and `items` for arrays — nothing else. It is
 * used at test time only (`test/report.test.ts`) to prove `buildAuditReport`'s output actually
 * matches its own published contract; nothing in the CLI's runtime path calls it.
 *
 * `docs/report-schema.json` is the published, checked-in copy of {@link REPORT_JSON_SCHEMA} —
 * `test/report.test.ts` asserts the two are byte-for-byte the same JSON, so they can never
 * silently drift apart.
 */

export type JsonSchemaType = 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null';

export interface JsonSchema {
  readonly type?: JsonSchemaType | readonly JsonSchemaType[];
  readonly enum?: readonly unknown[];
  readonly properties?: Readonly<Record<string, JsonSchema>>;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean;
  readonly items?: JsonSchema;
}

export interface SchemaValidationResult {
  readonly valid: boolean;
  /** One message per violation, each naming the exact failing path (`$.foo.bar[2].baz`) — never a bare `false` a caller cannot act on. */
  readonly errors: readonly string[];
}

function jsonTypeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function matchesType(value: unknown, type: JsonSchemaType): boolean {
  if (type === 'integer') return typeof value === 'number' && Number.isInteger(value);
  return jsonTypeOf(value) === type;
}

function validateNode(schema: JsonSchema, value: unknown, path: string, errors: string[]): void {
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((type) => matchesType(value, type))) {
      errors.push(`${path}: expected type ${types.join(' | ')}, got ${jsonTypeOf(value)}`);
      return;
    }
  }

  if (schema.enum !== undefined && !schema.enum.includes(value)) {
    errors.push(`${path}: value ${JSON.stringify(value)} is not one of ${JSON.stringify(schema.enum)}`);
  }

  if (schema.properties !== undefined && jsonTypeOf(value) === 'object') {
    const object = value as Readonly<Record<string, unknown>>;
    for (const key of schema.required ?? []) {
      if (!(key in object)) errors.push(`${path}.${key}: required property is missing`);
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(object)) {
        if (!(key in schema.properties)) errors.push(`${path}.${key}: unexpected property (additionalProperties is false)`);
      }
    }
    for (const [key, propertySchema] of Object.entries(schema.properties)) {
      if (key in object) validateNode(propertySchema, object[key], `${path}.${key}`, errors);
    }
  }

  if (schema.items !== undefined && Array.isArray(value)) {
    value.forEach((item, index) => validateNode(schema.items as JsonSchema, item, `${path}[${index}]`, errors));
  }
}

/** Validates `value` against `schema`, returning every violation found (never stopping at the first) — see this module's own doc for the supported keyword subset. */
export function validateAgainstSchema(schema: JsonSchema, value: unknown): SchemaValidationResult {
  const errors: string[] = [];
  validateNode(schema, value, '$', errors);
  return { valid: errors.length === 0, errors };
}

const CLASSIFICATION_LEVEL_ENUM = ['misleading', 'weak', 'acceptable', 'strong'] as const;
const OVERALL_STATUS_ENUM = ['healthy', 'weak', 'misleading', 'needs-review'] as const;
const DIMENSION_STATUS_ENUM = ['judged', 'not-applicable', 'needs-review'] as const;
const DIMENSION_REASON_ENUM = ['low-confidence', 'missing-answer', 'boundary-straddle'] as const;
const CACHE_STATUS_ENUM = ['cached', 'fresh', 'not-evaluated'] as const;
const CLASSIFICATION_CACHE_STATUS_ENUM = ['cached', 'fresh'] as const;

const skippedTotalsSchema: JsonSchema = {
  type: 'object',
  required: ['total', 'byReason'],
  additionalProperties: false,
  properties: {
    total: { type: 'integer' },
    byReason: {
      type: 'object',
      required: ['skip', 'todo', 'evidence-unavailable'],
      additionalProperties: false,
      properties: {
        skip: { type: 'integer' },
        todo: { type: 'integer' },
        'evidence-unavailable': { type: 'integer' },
      },
    },
  },
};

const usageSchema: JsonSchema = {
  type: 'object',
  required: ['inputTokens', 'outputTokens'],
  additionalProperties: false,
  properties: {
    inputTokens: { type: 'integer' },
    outputTokens: { type: 'integer' },
  },
};

const evaluationTotalsSchema: JsonSchema = {
  type: 'object',
  required: ['evaluated', 'cached', 'failed', 'skipped', 'usage', 'statusCounts', 'modelMismatches'],
  additionalProperties: false,
  properties: {
    evaluated: { type: 'integer' },
    cached: { type: 'integer' },
    failed: { type: 'integer' },
    skipped: skippedTotalsSchema,
    usage: usageSchema,
    statusCounts: {
      type: 'object',
      required: ['healthy', 'weak', 'misleading', 'needs-review'],
      additionalProperties: false,
      properties: {
        healthy: { type: 'integer' },
        weak: { type: 'integer' },
        misleading: { type: 'integer' },
        'needs-review': { type: 'integer' },
      },
    },
    respondedModel: { type: 'string' },
    modelMismatches: { type: 'integer' },
  },
};

const discoveredFileSchema: JsonSchema = {
  type: 'object',
  required: ['path', 'framework', 'testCaseCount', 'dynamicMetadataCount', 'evidenceBundleCount'],
  additionalProperties: false,
  properties: {
    path: { type: 'string' },
    framework: { type: 'string' },
    testCaseCount: { type: 'integer' },
    dynamicMetadataCount: { type: 'integer' },
    evidenceBundleCount: { type: 'integer' },
  },
};

const excludedFileSchema: JsonSchema = {
  type: 'object',
  required: ['path', 'reason'],
  additionalProperties: false,
  properties: {
    path: { type: 'string' },
    reason: { type: 'string' },
  },
};

const discoveryTotalsSchema: JsonSchema = {
  type: 'object',
  required: [
    'files', 'excluded', 'testCases', 'dynamicMetadata', 'diagnostics', 'unsupportedFrameworkFiles',
    'evidenceBundles', 'evidenceFragments', 'evidenceTruncatedFragments', 'evidenceOmitted', 'evidenceDenied', 'evidenceUnresolved',
  ],
  additionalProperties: false,
  properties: {
    files: { type: 'integer' },
    excluded: { type: 'integer' },
    testCases: { type: 'integer' },
    dynamicMetadata: { type: 'integer' },
    diagnostics: { type: 'integer' },
    unsupportedFrameworkFiles: { type: 'integer' },
    evidenceBundles: { type: 'integer' },
    evidenceFragments: { type: 'integer' },
    evidenceTruncatedFragments: { type: 'integer' },
    evidenceOmitted: { type: 'integer' },
    evidenceDenied: { type: 'integer' },
    evidenceUnresolved: { type: 'integer' },
  },
};

const discoverySchema: JsonSchema = {
  type: 'object',
  required: ['files', 'excluded', 'totals'],
  additionalProperties: false,
  properties: {
    files: { type: 'array', items: discoveredFileSchema },
    excluded: { type: 'array', items: excludedFileSchema },
    totals: discoveryTotalsSchema,
  },
};

const latencySummarySchema: JsonSchema = {
  type: 'object',
  required: ['measuredTestCases'],
  additionalProperties: false,
  properties: {
    measuredTestCases: { type: 'integer' },
    totalMs: { type: 'number' },
    meanMs: { type: 'number' },
    minMs: { type: 'number' },
    maxMs: { type: 'number' },
  },
};

const cacheStatusEntrySchema: JsonSchema = {
  type: 'object',
  required: ['testCaseId', 'repositoryRelativePath', 'name', 'status'],
  additionalProperties: false,
  properties: {
    testCaseId: { type: 'string' },
    repositoryRelativePath: { type: 'string' },
    name: { type: 'string' },
    status: { type: 'string', enum: CACHE_STATUS_ENUM },
  },
};

const deniedEvidenceSchema: JsonSchema = {
  type: 'object',
  required: ['repositoryRelativePath', 'rule'],
  additionalProperties: false,
  properties: {
    repositoryRelativePath: { type: 'string' },
    rule: { type: 'string' },
  },
};

const unresolvedEvidenceSchema: JsonSchema = {
  type: 'object',
  required: ['specifier', 'reason'],
  additionalProperties: false,
  properties: {
    specifier: { type: 'string' },
    reason: { type: 'string' },
  },
};

const omittedEvidenceSchema: JsonSchema = {
  type: 'object',
  required: ['repositoryRelativePath', 'reason'],
  additionalProperties: false,
  properties: {
    repositoryRelativePath: { type: 'string' },
    symbol: { type: 'string' },
    reason: { type: 'string' },
  },
};

const evidenceProvenanceSchema: JsonSchema = {
  type: 'object',
  required: ['fragments', 'truncatedFragments', 'denied', 'unresolved', 'omitted'],
  additionalProperties: false,
  properties: {
    fragments: { type: 'integer' },
    truncatedFragments: { type: 'integer' },
    denied: { type: 'array', items: deniedEvidenceSchema },
    unresolved: { type: 'array', items: unresolvedEvidenceSchema },
    omitted: { type: 'array', items: omittedEvidenceSchema },
  },
};

const probabilitiesSchema: JsonSchema = {
  type: 'object',
  required: ['0', '1', '2', '3'],
  additionalProperties: false,
  properties: {
    '0': { type: 'number' },
    '1': { type: 'number' },
    '2': { type: 'number' },
    '3': { type: 'number' },
  },
};

const dimensionJudgmentSchema: JsonSchema = {
  type: 'object',
  required: ['dimensionId', 'dimensionLabel', 'applicable', 'status'],
  additionalProperties: false,
  properties: {
    dimensionId: { type: 'string' },
    dimensionLabel: { type: 'string' },
    applicable: { type: 'boolean' },
    applicabilityProbability: { type: 'number' },
    level: { type: 'string', enum: CLASSIFICATION_LEVEL_ENUM },
    score: { type: 'number' },
    confidence: { type: 'number' },
    status: { type: 'string', enum: DIMENSION_STATUS_ENUM },
    reason: { type: 'string', enum: DIMENSION_REASON_ENUM },
    probabilities: probabilitiesSchema,
    deficientMass: { type: 'number' },
    acceptableMass: { type: 'number' },
    criticalMass: { type: 'number' },
  },
};

const classificationFindingSchema: JsonSchema = {
  type: 'object',
  required: ['testCaseId', 'repositoryRelativePath', 'name', 'dimensionId', 'dimensionLabel', 'status'],
  additionalProperties: false,
  properties: {
    testCaseId: { type: 'string' },
    repositoryRelativePath: { type: 'string' },
    name: { type: 'string' },
    dimensionId: { type: 'string' },
    dimensionLabel: { type: 'string' },
    level: { type: 'string', enum: CLASSIFICATION_LEVEL_ENUM },
    score: { type: 'number' },
    confidence: { type: 'number' },
    applicabilityProbability: { type: 'number' },
    status: { type: 'string', enum: DIMENSION_STATUS_ENUM },
    reason: { type: 'string', enum: DIMENSION_REASON_ENUM },
    probabilities: probabilitiesSchema,
    deficientMass: { type: 'number' },
    acceptableMass: { type: 'number' },
    criticalMass: { type: 'number' },
  },
};

const modelSchema: JsonSchema = {
  type: 'object',
  required: ['requested', 'responded', 'matchesPin'],
  additionalProperties: false,
  properties: {
    requested: { type: 'string' },
    responded: { type: 'string' },
    matchesPin: { type: 'boolean' },
  },
};

const latencyEntrySchema: JsonSchema = {
  type: 'object',
  required: ['latencyMs'],
  additionalProperties: false,
  properties: {
    latencyMs: { type: 'number' },
    attemptLatenciesMs: { type: 'array', items: { type: 'number' } },
  },
};

const classificationEntrySchema: JsonSchema = {
  type: 'object',
  required: [
    'testCaseId', 'repositoryRelativePath', 'name', 'status', 'dimensions', 'findings',
    'policyVersion', 'rubricVersion', 'model', 'usage', 'cache', 'evidence',
  ],
  additionalProperties: false,
  properties: {
    testCaseId: { type: 'string' },
    repositoryRelativePath: { type: 'string' },
    name: { type: 'string' },
    status: { type: 'string', enum: OVERALL_STATUS_ENUM },
    dimensions: { type: 'array', items: dimensionJudgmentSchema },
    findings: { type: 'array', items: classificationFindingSchema },
    policyVersion: { type: 'integer' },
    rubricVersion: { type: 'integer' },
    model: modelSchema,
    usage: usageSchema,
    cache: { type: 'string', enum: CLASSIFICATION_CACHE_STATUS_ENUM },
    latency: latencyEntrySchema,
    evidence: evidenceProvenanceSchema,
  },
};

const diagnosticSchema: JsonSchema = {
  type: 'object',
  required: ['code', 'message', 'severity'],
  additionalProperties: false,
  properties: {
    path: { type: 'string' },
    code: { type: 'string' },
    message: { type: 'string' },
    severity: { type: 'string' },
  },
};

const resumeSchema: JsonSchema = {
  type: 'object',
  required: ['runId', 'outstanding', 'reused'],
  additionalProperties: false,
  properties: {
    runId: { type: 'string' },
    outstanding: { type: 'integer' },
    reused: { type: 'integer' },
  },
};

/** The canonical report's published JSON Schema — see this module's own doc. Mirrored byte-for-byte at `docs/report-schema.json` (`test/report.test.ts` enforces the two stay identical). */
export const REPORT_JSON_SCHEMA: JsonSchema = {
  type: 'object',
  required: [
    'reportVersion', 'rootDir', 'reportingOnly', 'complete', 'versions', 'modelRequested',
    'discovery', 'totals', 'latency', 'cacheStatus', 'classifications', 'diagnostics',
  ],
  additionalProperties: false,
  properties: {
    reportVersion: { type: 'integer' },
    rootDir: { type: 'string' },
    runId: { type: 'string' },
    reportingOnly: { type: 'boolean' },
    complete: { type: 'boolean' },
    incompleteReason: { type: 'string' },
    versions: {
      type: 'object',
      required: ['storeSchema', 'rubric', 'policy'],
      additionalProperties: false,
      properties: {
        storeSchema: { type: 'integer' },
        rubric: { type: 'integer' },
        policy: { type: 'integer' },
      },
    },
    modelRequested: { type: 'string' },
    discovery: discoverySchema,
    totals: evaluationTotalsSchema,
    latency: latencySummarySchema,
    cacheStatus: { type: 'array', items: cacheStatusEntrySchema },
    classifications: { type: 'array', items: classificationEntrySchema },
    diagnostics: { type: 'array', items: diagnosticSchema },
    resume: resumeSchema,
  },
};
