import { BadRequestException, createParamDecorator, ExecutionContext } from '@nestjs/common';

const KEY = /^[A-Za-z0-9._:-]{1,128}$/;

/** The client's Idempotency-Key: required, so a retry can never be mistaken for a new request. */
export const IdempotencyKey = createParamDecorator((_: unknown, ctx: ExecutionContext): string => {
  const value = ctx.switchToHttp().getRequest().headers['idempotency-key'];
  if (typeof value !== 'string' || !KEY.test(value)) {
    throw new BadRequestException('Idempotency-Key header is required (1-128 chars: letters, digits, . _ : -)');
  }
  return value;
});
