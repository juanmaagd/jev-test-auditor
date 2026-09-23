import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RUBRIC_V2 } from '../src/domain/rubric.js';

/**
 * `skills/jev-test-audit/references/dimensions.md` explains, in plain language, what each
 * `RUBRIC_V2` dimension checks and what to do about a misleading/weak verdict — a fixer subagent
 * reads only the sections for its file's failing dimensions (see `fixer-brief.md`). This test is
 * the guide's sync check: it fails the moment a rubric dimension's id or label goes missing from
 * the guide, so the two can never quietly drift apart.
 */
const GUIDE_PATH = join(process.cwd(), 'skills', 'jev-test-audit', 'references', 'dimensions.md');

describe('skills/jev-test-audit/references/dimensions.md', () => {
  it('covers every RUBRIC_V2 dimension by id and label', async () => {
    const guide = await readFile(GUIDE_PATH, 'utf8');
    expect(RUBRIC_V2.dimensions.length).toBeGreaterThan(0);
    for (const dimension of RUBRIC_V2.dimensions) {
      expect(guide, `missing dimension id "${dimension.id}"`).toContain(dimension.id);
      expect(guide, `missing dimension label "${dimension.label}"`).toContain(dimension.label);
    }
  });

  it('gives every dimension a "what it checks", "misleading", "weak", and "typical fixes" section', async () => {
    const guide = await readFile(GUIDE_PATH, 'utf8');
    const sections = guide.split(/^## /mu).slice(1);
    expect(sections).toHaveLength(RUBRIC_V2.dimensions.length);
    for (const section of sections) {
      expect(section).toMatch(/what it checks/iu);
      expect(section).toMatch(/misleading/iu);
      expect(section).toMatch(/weak/iu);
      expect(section).toMatch(/typical fixes?/iu);
    }
  });
});
