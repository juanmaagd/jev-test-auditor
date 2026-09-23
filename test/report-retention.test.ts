import { describe, expect, it } from 'vitest';
import { REPORT_RETENTION_LIMIT, selectReportsForRetention, type RetainedReportEntry } from '../src/domain/report-retention.js';

function entry(id: string, recordedAtMs: number): RetainedReportEntry {
  return { id, recordedAtMs };
}

describe('selectReportsForRetention: pure retention selection over recorded time', () => {
  it('retains every entry and removes none when the count is at or under the limit', () => {
    const entries = [entry('a', 1), entry('b', 2), entry('c', 3)];
    const result = selectReportsForRetention(entries, 5);
    expect(result.retain.map((e) => e.id)).toEqual(['c', 'b', 'a']);
    expect(result.remove).toEqual([]);
  });

  it('keeps the newest `limit` entries by recordedAtMs and removes the rest, oldest first among the removed', () => {
    const entries = [
      entry('oldest', 1),
      entry('older', 2),
      entry('mid', 3),
      entry('newer', 4),
      entry('newest', 5),
      entry('extra-1', 6),
      entry('extra-2', 7),
    ];
    const result = selectReportsForRetention(entries, 5);
    expect(result.retain.map((e) => e.id)).toEqual(['extra-2', 'extra-1', 'newest', 'newer', 'mid']);
    expect(result.remove.map((e) => e.id)).toEqual(['older', 'oldest']);
  });

  it('defaults to REPORT_RETENTION_LIMIT (5) when no limit is given', () => {
    expect(REPORT_RETENTION_LIMIT).toBe(5);
    const entries = Array.from({ length: 7 }, (_, index) => entry(`id-${index}`, index));
    const result = selectReportsForRetention(entries);
    expect(result.retain).toHaveLength(5);
    expect(result.remove).toHaveLength(2);
  });

  it('breaks a tie on identical recordedAtMs deterministically by id, descending', () => {
    const entries = [entry('b', 100), entry('a', 100), entry('c', 100)];
    const result = selectReportsForRetention(entries, 2);
    expect(result.retain.map((e) => e.id)).toEqual(['c', 'b']);
    expect(result.remove.map((e) => e.id)).toEqual(['a']);
  });

  it('returns empty retain/remove for an empty input', () => {
    const result = selectReportsForRetention([]);
    expect(result).toEqual({ retain: [], remove: [] });
  });

  it('never mutates the input array', () => {
    const entries = [entry('a', 1), entry('b', 2)];
    const copy = [...entries];
    selectReportsForRetention(entries, 1);
    expect(entries).toEqual(copy);
  });
});
