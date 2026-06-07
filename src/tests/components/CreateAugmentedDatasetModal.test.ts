/**
 * Regression tests for CreateAugmentedDatasetModal dataset config building.
 *
 * Bug: annotation_file_id was passed through parseInt() before being sent to
 * the backend. AnnotationFile.id is a UUID string (e.g. "550e8400-e29b-41d4-
 * a716-446655440000"). parseInt("550e8400-...") === 550, which does not match
 * any annotation file in the database — resulting in 0 classes / 0 instances
 * in the augmented dataset.
 */
import { describe, it, expect } from 'vitest';

// ---------------------------------------------------------------------------
// Pure helper that mirrors the datasetConfigs construction in handleSubmit.
// We extract and test it here without rendering the full modal.
// ---------------------------------------------------------------------------
interface SelectionLike {
  dataset: { id: number };
  collectionId: string | null;
  annotationFileId: string | null;
}

function buildDatasetConfigs(selections: SelectionLike[]) {
  return selections.map(sel => ({
    dataset_id: sel.dataset.id,
    collection_id: sel.collectionId ? parseInt(sel.collectionId, 10) : null,
    annotation_file_id: sel.annotationFileId || null,  // UUID string — must NOT be parseInt'd
  }));
}

const UUID_LEADING_DIGITS = '550e8400-e29b-41d4-a716-446655440000';
const UUID_LEADING_LETTERS = 'aabbccdd-1234-5678-9abc-def012345678';
const UUID_PURE_ALPHA = 'aabbccdd-eeff-aabb-ccdd-eeffaabbccdd';

describe('buildDatasetConfigs — annotation_file_id must be sent as UUID string', () => {
  it('preserves a UUID that starts with digits', () => {
    const configs = buildDatasetConfigs([
      { dataset: { id: 7 }, collectionId: null, annotationFileId: UUID_LEADING_DIGITS },
    ]);
    expect(configs[0].annotation_file_id).toBe(UUID_LEADING_DIGITS);
    // Guard: parseInt would have mangled this to 550 — make sure it is NOT a number
    expect(typeof configs[0].annotation_file_id).toBe('string');
  });

  it('preserves a UUID that starts with letters', () => {
    const configs = buildDatasetConfigs([
      { dataset: { id: 3 }, collectionId: null, annotationFileId: UUID_LEADING_LETTERS },
    ]);
    expect(configs[0].annotation_file_id).toBe(UUID_LEADING_LETTERS);
    expect(typeof configs[0].annotation_file_id).toBe('string');
  });

  it('preserves a UUID that is entirely hex letters', () => {
    const configs = buildDatasetConfigs([
      { dataset: { id: 5 }, collectionId: null, annotationFileId: UUID_PURE_ALPHA },
    ]);
    expect(configs[0].annotation_file_id).toBe(UUID_PURE_ALPHA);
  });

  it('maps null annotationFileId to null (no annotation selected)', () => {
    const configs = buildDatasetConfigs([
      { dataset: { id: 2 }, collectionId: '42', annotationFileId: null },
    ]);
    expect(configs[0].annotation_file_id).toBeNull();
  });

  it('correctly parses collectionId as an integer (collectionId IS numeric)', () => {
    const configs = buildDatasetConfigs([
      { dataset: { id: 1 }, collectionId: '99', annotationFileId: UUID_LEADING_DIGITS },
    ]);
    expect(configs[0].collection_id).toBe(99);
    expect(typeof configs[0].collection_id).toBe('number');
  });

  it('produces the correct dataset_id', () => {
    const configs = buildDatasetConfigs([
      { dataset: { id: 42 }, collectionId: null, annotationFileId: null },
    ]);
    expect(configs[0].dataset_id).toBe(42);
  });

  it('handles multiple selections independently', () => {
    const configs = buildDatasetConfigs([
      { dataset: { id: 1 }, collectionId: '10', annotationFileId: UUID_LEADING_DIGITS },
      { dataset: { id: 2 }, collectionId: null,  annotationFileId: UUID_LEADING_LETTERS },
      { dataset: { id: 3 }, collectionId: '20', annotationFileId: null },
    ]);
    expect(configs[0].annotation_file_id).toBe(UUID_LEADING_DIGITS);
    expect(configs[1].annotation_file_id).toBe(UUID_LEADING_LETTERS);
    expect(configs[2].annotation_file_id).toBeNull();
    expect(configs[0].collection_id).toBe(10);
    expect(configs[1].collection_id).toBeNull();
    expect(configs[2].collection_id).toBe(20);
  });
});

describe('parseInt regression — demonstrates the old bug', () => {
  it('parseInt of a digit-leading UUID does NOT equal the full UUID string', () => {
    // This test documents what the old buggy code produced.
    // parseInt("550e8400-...") === 550, which is wrong.
    const mangled = parseInt(UUID_LEADING_DIGITS);
    expect(mangled).toBe(550);
    expect(String(mangled)).not.toBe(UUID_LEADING_DIGITS);
  });

  it('parseInt of a letter-leading UUID returns NaN', () => {
    // When UUID starts with letters, parseInt returns NaN → JSON.stringify → null
    // That silently disables the annotation filter instead of using the right file.
    const mangled = parseInt(UUID_LEADING_LETTERS);
    expect(Number.isNaN(mangled)).toBe(true);
  });
});
