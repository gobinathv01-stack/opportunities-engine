/** Short lowercase key: used for workspace ids ("acme") and stage keys ("contacted"). */
export const SLUG = /^[a-z0-9][a-z0-9-]{1,31}$/;
export const SLUG_MESSAGE = 'must be a short lowercase key such as "contacted" (2-32 chars: a-z, 0-9, "-")';
