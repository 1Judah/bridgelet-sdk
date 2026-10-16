/**
 * Canonical catalogue of webhook event names.
 *
 * These names were previously defined in three unrelated places and nowhere
 * authoritative: string literals at each `webhooksService.triggerEvent(...)` call
 * site, the Swagger `example` arrays in the create/update DTOs, and the prose in
 * `docs/webhook-events.md`. Nothing linked them, so they could drift apart
 * silently.
 *
 * Declaring the list once means `CreateWebhookDto`/`UpdateWebhookDto` can reject an
 * unknown event name at the API boundary. Previously `events` was validated only as
 * an array of strings, so a subscription to `"account.craeted"` or `"nonsense"` was
 * accepted, stored, and then never fired — with no error anywhere for the operator
 * to notice by (#913).
 *
 * Keep in sync with `docs/webhook-events.md`, which documents each payload shape.
 */
export const WEBHOOK_EVENTS = [
  'account.created',
  'account.expired',
  'sweep.completed',
  'sweep.partial',
  'sweep.failed',
] as const;

export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

/** Ready-made `class-validator` message so both DTOs report it identically. */
export const WEBHOOK_EVENTS_MESSAGE =
  `events must contain only known event names: ${WEBHOOK_EVENTS.join(', ')}`;