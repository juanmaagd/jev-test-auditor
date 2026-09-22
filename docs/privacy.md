# Privacy and Security Guarantees

`jev-test-auditor` is designed as a local-first, privacy-conscious audit pipeline for JavaScript and TypeScript test suites. This document outlines the security architecture, data handling practices, and invariants enforced across the codebase.

---

## 1. The Never-Execute Invariant for Audited Code

A foundational guarantee of `jev-test-auditor` is that **audited code is never executed**:

- **Lexical and Structural Parsing Only**: Test files and referenced source files are parsed into Abstract Syntax Trees (ASTs) with the TypeScript compiler API (`ts.createSourceFile`). They are analyzed purely as static text and syntax structures.
- **No Imports or Evaluations**: The audit pipeline never uses `import()`, `require()`, `eval()`, `new Function()`, or any test runner engine (Jest, Vitest, Node test runner) on the audited codebase.
- **No Project Scripts**: No `package.json` scripts, build steps, or setup hooks are run during audit discovery or extraction.
- **Bounded Benchmark Isolation**: Real execution exists solely for the tool's internal benchmark fixture corpus (`test/fixtures/corpus/`) via the standalone `benchmark` CLI. This execution is confined to isolated subprocesses with timeout and memory bounds. Static boundary tests (`test/benchmark-cli-boundary.test.ts`) formally prove that the oracle runner and benchmark execution modules are completely unreachable from the `audit` CLI.

---

## 2. Zero Telemetry and Local-First Persistence

`jev-test-auditor` respects developer privacy and organizational code confidentiality:

- **No Telemetry**: There are no analytics, usage pings, crash reporting beacons, or background phone-home calls.
- **Local SQLite Storage**: All audit run metadata, checkpoints, and content-addressed cache entries are stored in a local SQLite database (defaulting to `.jev-audit/audit.sqlite` or as configured). No run history or cache data is synchronized to remote servers.
- **Offline by Default**: Discovery, extraction, structural validation, and cost estimation (`audit --dry-run`) operate 100% offline without requiring network access or credentials.
- **Opt-In Evaluation**: Network communication occurs only when the user explicitly provides `--evaluate`. In that mode, requests are dispatched solely to TypeSafe's Jev model endpoint via the configured API key.

---

## 3. Evidence Minimization and Data Boundaries

When `--evaluate` is explicitly enabled, the tool sends targeted evidence bundles rather than whole source repositories:

- **Minimal Fragments**: Evidence extraction extracts only the specific test body and narrowly related helper or production function/class declarations referenced by the test.
- **Budget Enforcements**:
  - Each fragment is capped at `maxFragmentBytes` (default 4 KiB).
  - Each total bundle per test case is capped at `maxBundleBytes` (default 16 KiB).
  - Overflowing code is truncated cleanly at line boundaries; oversized files are omitted with structured warnings.
- **Default Deny List**: Sensitive patterns are rejected before file read operations:
  - Secrets and environment files: `.env*`, `*.pem`, `*.key`, `*.cert`, `credentials*`.
  - Dependency and build directories: `**/node_modules/**`, `**/dist/**`, `**/build/**`, `**/.git/**`.
  - Custom patterns can be appended via configuration (`evidence.deny`), but default protections cannot be disabled.
- **Path Containment**: Path resolution enforces `fs.realpath` containment to prevent symlinks from escaping the repository root.
- **Explicit Provenance**: Where context cannot be shared or resolved, structured metadata (`denied`, `unresolved`, `omitted`, `truncated`) instructs the model that information was withheld, avoiding speculative guesses.

---

## 4. Credential Management

- **Storage Precedence**: The tool first checks the `TYPESAFE_API_KEY` environment variable. If absent, it checks the local credentials file managed by `jev-test-auditor auth login`.
- **Restrictive File Modes**: On POSIX systems, `credentials.json` is created with mode `0o600` (owner read/write only) inside a directory with mode `0o700`. Loose permissions cause the tool to fail closed until permissions are repaired.
- **No Command-Line Leakage**: `auth login` accepts keys through interactive terminal prompts (without echoing keystrokes) or via piped standard input. Keys are never accepted as command-line arguments to prevent leakage into shell history and process tables.
- **Sanitized Diagnostics**: API keys are never included in error messages, logs, JSON reports, or progress outputs.

---

## 5. Self-Contained Offline Artifacts

- **HTML Reports**: Reports generated via `audit --evaluate --html <path>` are standalone single-file documents.
- **Zero External Assets**: CSS styles, JavaScript behavior, and the canonical JSON payload are fully inlined. Viewing an audit report requires no internet connection and contacts no CDN or external font server.
