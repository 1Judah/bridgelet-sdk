# Webhook Subscription Lifecycle

Reference for the create / pause / update / delete semantics of the
`/webhooks` endpoints. For payload shapes and signing, see
[`webhook-events.md`](./webhook-events.md) and
[`webhook-verification.md`](./webhook-verification.md). For the request and
response fields, see [`api-reference.md`](./api-reference.md).

## State model

A subscription has one meaningful piece of state: `isActive`.

| `isActive` | Meaning                                                     | Receives deliveries | In `GET /webhooks` |
| ---------- | ----------------------------------------------------------- | ------------------- | ------------------ |
| `true`     | Active                                                      | Yes                 | Yes                |
| `false`    | Paused (`PUT` with `isActive: false`) or deleted (`DELETE`) | No                  | No                 |

There is no separate `deleted` flag. Pausing and deleting set the same column;
they differ only in intent and in how you undo them.

## `DELETE /webhooks/:id` is a soft delete

This is the part most often misread from the controller alone, so stating it
plainly: **`DELETE` does not remove the row.**

`WebhooksService.remove()` sets `isActive = false` and saves. The row stays in
the `webhooks` table with its original `id`.

Consequences:

- The `webhook_deliveries` rows referencing it survive (they cascade only on a
  real row delete, via `ON DELETE CASCADE`). Delivery history is preserved,
  which is what makes post-incident debugging possible.
- The subscription disappears from `GET /webhooks`, because that endpoint
  filters to `isActive = true`. Absent from the listing does **not** mean the
  row is gone.
- The subscription stops receiving events immediately, since
  `triggerEvent()` also filters on `isActive = true`.
- `DELETE` is idempotent in effect: deleting an already-deleted subscription
  leaves the same state, provided the row still exists.
- There is no endpoint that hard-deletes a subscription or purges its
  delivery history. If you need the row gone for data-minimisation reasons,
  that is currently a database-level operation — raise it, do not work around
  it.

### Undoing a delete

`PUT /webhooks/:id` with `{ "isActive": true }` reactivates it, because a
delete is just an `isActive = false`. The `id` is unchanged, so the same URL
keeps working. This is the intended way to "undelete".

## Pausing versus deleting

They are the same operation mechanically. Choose based on intent:

| You want to…                | Use                                    |
| --------------------------- | -------------------------------------- |
| Stop deliveries temporarily | `PUT { "isActive": false }`            |
| Stop deliveries permanently | `DELETE /webhooks/:id`                 |
| Resume after a pause        | `PUT { "isActive": true }`             |
| Resume after a delete       | `PUT { "isActive": true }` — same call |

`PUT` is the more descriptive choice for a pause because it leaves an audit
trail of the intent; `DELETE` is the conventional REST verb for "I am done
with this". Neither loses the row.

## Rotating the secret

`PUT /webhooks/:id` with `{ "secret": "..." }` replaces the signing key
immediately. There is **no window in which both the old and new secret
verify** — rotate your receiver in the same deploy, or it will start
rejecting deliveries.

Secrets are encrypted at rest and are write-only over the API: there is no way
to read the current value back, so a lost secret must be rotated rather than
recovered. See [`webhook-verification.md`](./webhook-verification.md).

## Listing and pagination

`GET /webhooks` returns active subscriptions only, ordered deterministically by
`createdAt` then `id`, so paging with a fixed `limit`/`offset` is stable —
paging without a deterministic order would let a row appear on two pages or
none.

- `limit` — default 50, clamped to 1–100.
- `offset` — default 0, clamped to 0–100000.
- Non-integer values (`abc`, `1.5`, empty) are a `400` rather than a 500 from
  the query builder.
- `total` is the count of **active** subscriptions before pagination is
  applied, so it does not change as you page.

Because deleted subscriptions are excluded from both the page and `total`, a
subscription deleted mid-pagination shifts subsequent offsets. If you are
paging a large set, filter by a stable key on your side rather than assuming
the offset space is frozen.

## Related

- [`webhook-events.md`](./webhook-events.md) — the event catalogue and payload
  shapes.
- [`webhook-verification.md`](./webhook-verification.md) — HMAC signing,
  rotation, and delivery records.
- [`api-reference.md`](./api-reference.md) — the full endpoint reference.

## Verification notes

- **Delivery signing (#750):** outbound deliveries are signed with an HMAC of the payload using `webhook.secret`; integrators verify it as described in `docs/webhook-verification.md`. Attempts are recorded in the `WebhookDelivery` entity (`src/modules/webhooks/entities/webhook-delivery.entity.ts`).
- **`PUT /webhooks/:id` (#751):** `UpdateWebhookDto` accepts `url`, `events`, `description`, `isActive` and `secret` (rotation); both new fields are validated.
- **`DELETE /webhooks/:id` (#752):** soft delete — the row is deactivated (`isActive=false`) so delivery history is retained, consistent with `GET /webhooks` returning only active subscriptions. See `docs/api-reference.md`.
- **CRUD integration test (#753):** `webhooks.controller.integration.spec.ts` exercises create → list → update → delete against a test repository.
