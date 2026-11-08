import { ArgumentMetadata, BadRequestException, Injectable, PipeTransform } from '@nestjs/common';
import { ZodSchema } from 'zod';

/** Validates request bodies/queries against a zod schema; returns the parsed, typed value. */
@Injectable()
export class ZodPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodSchema<T>) {}
  transform(value: unknown, _meta: ArgumentMetadata): T {
    const r = this.schema.safeParse(value);
    if (!r.success) {
      throw new BadRequestException(r.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`));
    }
    return r.data;
  }
}

export const zod = <T>(schema: ZodSchema<T>) => new ZodPipe(schema);
