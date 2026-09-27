import { BadRequestException, createParamDecorator, ExecutionContext } from '@nestjs/common';
import { SLUG } from '../utils';

/** Tenant scope: every request must name its workspace in X-Workspace-Id. */
export const WorkspaceId = createParamDecorator((_: unknown, ctx: ExecutionContext): string => {
  const value = ctx.switchToHttp().getRequest().headers['x-workspace-id'];
  const slug = typeof value === 'string' ? value.toLowerCase() : '';
  if (!SLUG.test(slug)) {
    throw new BadRequestException('X-Workspace-Id header must be a workspace slug, e.g. "acme"');
  }
  return slug;
});
