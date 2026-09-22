import { readFile, writeFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { exampleAuditReport } from '../examples/report-fixture.js';
import { renderAuditReportHtml } from '../src/domain/html-report.js';

const examplePath = new URL('../examples/audit-report.html', import.meta.url);

describe('examples/audit-report.html', () => {
  it('matches the renderer, so style iteration happens in the renderer and this file stays a preview', async () => {
    const rendered = renderAuditReportHtml(exampleAuditReport());
    if (process.env['UPDATE_REPORT_EXAMPLE'] === '1') await writeFile(examplePath, rendered);
    expect(await readFile(examplePath, 'utf8')).toBe(rendered);
  });
});
