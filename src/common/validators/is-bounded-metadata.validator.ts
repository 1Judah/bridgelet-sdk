import { registerDecorator, ValidationOptions } from 'class-validator';
import {
  METADATA_MAX_BYTES,
  METADATA_MAX_DEPTH,
} from '../utils/metadata-sanitizer.util.js';

function depthOf(value: unknown, depth = 0): number {
  if (
    depth > METADATA_MAX_DEPTH ||
    value === null ||
    typeof value !== 'object'
  ) {
    return depth;
  }
  return Math.max(
    depth,
    ...Object.values(value).map((v) => depthOf(v, depth + 1)),
  );
}

/**
 * Rejects metadata whose serialised size or nesting depth is too large
 * *before* it is parsed/buffered by sanitizeMetadata() (issue #640).
 *
 * Re-verified against #701: this class-validator decorator runs during DTO
 * validation, ahead of sanitizeMetadata() in AccountsService.create(), so an
 * oversized/deeply-nested payload is rejected with a 400 before it is ever
 * buffered or walked by the sanitizer.
 *
 * Verified for #853: `CreateAccountDto.metadata` is decorated with
 * `@IsBoundedMetadata()`, so the size (`METADATA_MAX_BYTES`) and depth
 * (`METADATA_MAX_DEPTH`) bounds are enforced by class-validator before the
 * payload reaches `sanitizeMetadata()`.
 */
export function IsBoundedMetadata(options?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: 'isBoundedMetadata',
      target: object.constructor,
      propertyName,
      options: {
        message:
          `${propertyName} must serialise to at most ${METADATA_MAX_BYTES} ` +
          `bytes and nest no deeper than ${METADATA_MAX_DEPTH} levels`,
        ...options,
      },
      validator: {
        validate(value: unknown) {
          if (value === undefined || value === null) return true;
          if (typeof value !== 'object') return false;
          const size = Buffer.byteLength(JSON.stringify(value), 'utf8');
          return (
            size <= METADATA_MAX_BYTES && depthOf(value) <= METADATA_MAX_DEPTH
          );
        },
      },
    });
  };
}
