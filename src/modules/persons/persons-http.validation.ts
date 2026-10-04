import { BadRequestException, Injectable, type PipeTransform } from '@nestjs/common';
import { z } from 'zod';

export const pinSchema = z.string().regex(/^[A-Za-z0-9]{1,24}$/);
const name = z
  .string()
  .refine((value) => !/[\t\r\n\x00]/.test(value))
  .transform((value) => value.trim())
  .pipe(z.string().min(1).max(100));
const externalId = z.string().max(255).nullable().optional();
export const createPersonSchema = z.object({ pin: pinSchema, name, externalId }).strict();
export const updatePersonSchema = z
  .object({ name: name.optional(), externalId })
  .strict()
  .refine((value) => Object.keys(value).length > 0);
export const targetsSchema = z
  .object({
    deviceSns: z
      .array(z.string().regex(/^[A-Za-z0-9]{1,64}$/))
      .min(1)
      .max(100)
      .refine((values) => new Set(values).size === values.length),
  })
  .strict();

export class SchemaPipe implements PipeTransform {
  constructor(private readonly schema: z.ZodTypeAny) {}
  transform(input: unknown) {
    const result = this.schema.safeParse(input);
    if (!result.success) throw new BadRequestException('Invalid request');
    return result.data;
  }
}
@Injectable()
export class PersonPinPipe extends SchemaPipe {
  constructor() {
    super(pinSchema);
  }
}
