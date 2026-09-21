# Contributing to jev-test-auditor

Thank you for contributing to `jev-test-auditor`. This guide outlines development practices, architectural boundaries, and contribution standards to keep the codebase robust, maintainable, and deterministic.

---

## 1. Prerequisites and Setup

- **Node.js**: Requires Node.js `>= 22.13.0`. The persistence engine uses the built-in `node:sqlite` module without experimental flags.
- **Package Manager**: `npm`.

Clone the repository and install dependencies:

```bash
git clone <repo-url>
cd jev-test-auditor
npm ci
```

---

## 2. Quality Gates and Commands

All contributions must pass the following verification checks:

```bash
# Run unit, integration, and boundary tests (Vitest)
npm test

# Type-check TypeScript sources
npm run typecheck

# Lint TypeScript and configuration files
npm run lint

# Compile to dist/
npm run build
```

To test the compiled CLI locally:

```bash
node dist/cli/index.js --help
node dist/cli/index.js audit
```

---

## 3. Strict Test-Driven Development (TDD)

`jev-test-auditor` enforces strict TDD:

1. **RED**: Write a failing test exercising a public seam or observable outcome before writing production logic.
2. **GREEN**: Implement the minimal production code necessary to satisfy the test.
3. **REFACTOR**: Clean up structure and readability while keeping all tests green.

### Testing Rules
- **Public Seams**: Test behavior through public domain interfaces and application ports. Avoid testing private functions or internal class state.
- **Boundary Fakes**: Use deterministic in-memory fakes rather than heavy mocking frameworks.
- **Determinism**: Tests must never rely on wall-clock timing, ambient environment variables, or unseeded random state.
- **Never Execute Audited Code**: Unit and integration tests for discovery, extraction, and evidence selection must never execute or evaluate test fixtures.

---

## 4. Architectural Boundaries

Dependencies point strictly **inward**:

```
[CLI] ──> [Adapters] ──> [Application] ──> [Domain]
```

- **Domain (`src/domain/`)**: Pure business logic, entities, rubrics, and port interfaces. Must **never** import from CLI, adapters, filesystem (`node:fs`), child processes, or external network libraries.
- **Application (`src/application/`)**: Use cases and orchestration logic. Depends only on domain interfaces and ports.
- **Adapters (`src/adapters/`)**: Concrete implementations of domain ports (e.g., SQLite persistence, Babel AST parser, TypeSafe HTTP gateway).
- **CLI (`src/cli/`)**: Command-line arguments parsing, terminal rendering, and dependency wiring.

Architectural boundaries and forbidden imports are validated on every run by automated tests (`test/boundary.test.ts` and `test/benchmark-cli-boundary.test.ts`).

### Architecture Diagram
`docs/architecture.html` is generated from `docs/architecture.archify.json`. Never edit the HTML file directly; update the JSON source and regenerate.

---

## 5. Commit Guidelines

- **Conventional Commits**: All commit messages must follow the [Conventional Commits](https://www.conventionalcommits.org/) specification:
  - `feat: ...` for new features or user-facing changes.
  - `fix: ...` for bug fixes.
  - `docs: ...` for documentation changes.
  - `test: ...` for test additions or modifications.
  - `refactor: ...` for code structure changes without behavior alteration.
  - `chore: ...` for maintenance and dependency updates.
- **Attribution Policy**: Commit messages must remain clean and standard. Do **not** add `Co-Authored-By` or AI attribution trailers.
