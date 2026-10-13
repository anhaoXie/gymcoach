import { describe, expect, it } from 'vitest';
import { measurementSchema, observationSchema, runBundleSchema } from './schema';

describe('maintainer record schemas (version 1)', () => {
  it('accepts a known measurement with a unit and an unknown one with a reason', () => {
    expect(measurementSchema.parse({ status: 'known', value: 1200, unit: 'tokens' })).toBeTruthy();
    expect(measurementSchema.parse({ status: 'unknown', reason: 'not recorded' })).toBeTruthy();
  });

  it('rejects an unknown without a reason, a known without a unit, and a negative value', () => {
    expect(measurementSchema.safeParse({ status: 'unknown' }).success).toBe(false);
    expect(measurementSchema.safeParse({ status: 'unknown', reason: '' }).success).toBe(false);
    expect(measurementSchema.safeParse({ status: 'known', value: 3 }).success).toBe(false);
    expect(measurementSchema.safeParse({ status: 'known', value: -1, unit: 'usd' }).success).toBe(
      false,
    );
    // A bare zero is not a measurement: unknown must be said, not implied.
    expect(measurementSchema.safeParse(0).success).toBe(false);
  });

  it('rejects extra fields so private text cannot ride along in a record', () => {
    expect(
      measurementSchema.safeParse({ status: 'unknown', reason: 'x', body: 'pasted text' }).success,
    ).toBe(false);
    expect(observationSchema.safeParse({ status: 'known', value: 'Claude Opus 5.5' }).success).toBe(
      false,
    );
  });

  it('rejects a bundle from another schema version', () => {
    expect(runBundleSchema.safeParse({ schemaVersion: 2 }).success).toBe(false);
  });
});
