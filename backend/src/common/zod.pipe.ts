import { PipeTransform } from '@nestjs/common';
import { z } from 'zod';
import { ApiError } from './api-error.js';

/** Valide body / query avec un schéma zod, erreur 400 VALIDATION_ERROR sinon. */
export class ZodPipe<T extends z.ZodType> implements PipeTransform<
  unknown,
  z.infer<T>
> {
  constructor(private readonly schema: T) {}

  transform(value: unknown): z.infer<T> {
    const parsed = this.schema.safeParse(value ?? {});
    if (!parsed.success) {
      throw new ApiError(
        'VALIDATION_ERROR',
        'Requête invalide',
        parsed.error.issues.map((i) => ({
          field: i.path.join('.'),
          message: i.message,
        })),
      );
    }
    return parsed.data;
  }
}

export const zIsoDate = z.iso
  .datetime({ offset: true })
  .transform((s) => new Date(s));
export const zDeviceId = z
  .string()
  .regex(/^SX-[A-Z0-9]{3,16}$/, 'device_id invalide');
export const zUuid = z.uuid();
