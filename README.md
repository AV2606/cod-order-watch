# TIME LOG
time of start: 8:15 AM

| Step | Time |
| --- | --- |
| Scaffold, config, dev store | 8:45 |
| Data model, COD rule, webhook handler, uninstall cleanup (written with Claude Code, unit tests green at ~09:00) | 9:00 |
| Dashboard | 9:00 |
| Tests | 9:00 |
| README, end-to-end testing on the dev store, demo rehearsal | 9:20 |
| **Total** | _fill in_ |

# COD Order Watch

An embedded Shopify app (React Router + Prisma/SQLite) that listens to `orders/create`, flags **Cash on Delivery** orders, stores them per shop, and shows a dashboard: total orders, COD orders, COD share, total value, and the last 20 orders.

## How to run

Prerequisites: Node >= 22.12, the [Shopify CLI](https://shopify.dev/docs/apps/tools/cli/getting-started), a Partner/Dev Dashboard account and a development store.

```shell
npm install
npx prisma migrate dev      # creates prisma/dev.sqlite and applies migrations
shopify app dev             # starts the tunnel, syncs shopify.app.toml, installs on the dev store
```

1. On the dev store enable **Settings → Payments → Manual payment methods → Cash on Delivery**.
2. Open the app from the CLI (press `P`) and approve the install and the config sync.
3. Create an order in the admin (Orders → Create order, payment: Cash on Delivery) or check out on the storefront. It appears on the dashboard within seconds.

### Triggering a webhook manually

```shell
shopify app webhook trigger --topic orders/create --api-version 2027-01 \
  --delivery-method http --address https://<your-tunnel>/webhooks/orders/create \
  --client-secret <app client secret>
```

Run it twice to see `duplicate delivery, skipping` in the server log (note: the CLI generates a new webhook id per trigger, so to see a *true* retry, replay the same request with curl, including the same `X-Shopify-Webhook-Id`). Inspect rows with `npx prisma studio`.

Bad signature (should return `401`):

```shell
curl -i -X POST https://<your-tunnel>/webhooks/orders/create \
  -H "Content-Type: application/json" \
  -H "X-Shopify-Topic: orders/create" \
  -H "X-Shopify-Shop-Domain: <shop>.myshopify.com" \
  -H "X-Shopify-Webhook-Id: test-1" \
  -H "X-Shopify-Hmac-Sha256: AAAA" \
  -d '{"id":1}'
```

### Tests

```shell
npm test
```

- `tests/webhook-hmac.test.ts` calls the real `authenticate.webhook` with real `Request`s: valid signature accepted; tampered body, wrong secret, and re-serialised JSON rejected with 401; missing header rejected with 400. The signature is a fixed vector, precomputed once with `crypto.createHmac`.
- `tests/cod.test.ts` covers the COD rule and the payload validation.

### Protected customer data

Order webhooks contain protected customer data. _Fill in after testing: whether deliveries arrived without requesting access, or whether you had to request protected customer data access (basic level) in the Dev Dashboard → API access._

## The COD rule (`app/lib/cod.server.ts`)

An order is COD if either:

1. any `payment_gateway_names` entry, lowercased, contains `"cash"` (e.g. "Cash on Delivery (COD)"); or
2. `financial_status === "pending"` **and** at least one gateway is *manual*: the literal `"manual"`, or any name that is not a known online processor (`shopify_payments`, `paypal`, `stripe`, `klarna`, `bogus`, …).

Rule 2 exists because merchants can rename their manual payment method ("Pay at the door"), so matching "cash" alone would miss it.

**Known limits:** other manual methods that stay `pending` (bank deposit, money order) are classified as COD; an order with no gateway at all is *not* COD; the processor list is a hand-kept allowlist. Matching is substring-based, because gateway names are free-form.

## Key decisions

- **`authenticate.webhook`** reads the raw body with `request.text()`, computes HMAC-SHA256 with the client secret, base64-encodes it and compares to `X-Shopify-Hmac-Sha256` in constant time; a mismatch throws a 401 `Response`. The raw bytes matter: re-serialising parsed JSON changes whitespace, key order and unicode escapes, so the signature would no longer match (there is a test for exactly this).
- **Two idempotency layers**, written in one transaction: `WebhookEvent.webhookId` (primary key = `X-Shopify-Webhook-Id`) catches a retried delivery; `@@unique([shop, shopifyId])` plus `upsert` means a *different* webhook id for the same order still cannot create a second row. A duplicate is detected from the unique violation (`P2002`) and acknowledged with 200.
- **Status codes:** no session for the shop → 200 and store nothing (app isn't installed; retrying is pointless). Malformed payload → 200 plus a log line (it will never become valid). Any other failure → **500**, so Shopify retries; that is safe because the handler is idempotent.
- **Inline write vs. queue:** the handler writes to SQLite inline. That takes milliseconds, well inside Shopify's 5-second timeout. At scale: verify, enqueue, return 200, process in a worker.
- **Money:** `Decimal` in the schema, never `Float`, and prices travel as decimal strings. Caveat: SQLite has no native decimal type, so Prisma stores it as a floating-point column there; this becomes exact on Postgres.
- **Per-shop isolation:** the dashboard takes the shop from the authenticated session and every query filters by it.
- **Multiple currencies:** order value is grouped by currency instead of summing across currencies.
- **Uninstall:** `app/uninstalled` deletes `Order`, `WebhookEvent` and `Session` rows for the shop in one transaction; re-delivery is a no-op.

## What I left out / would do with more time

`orders/updated` (reuses the same upsert, roughly 20 minutes), the mandatory compliance webhooks (`customers/data_request`, `customers/redact`, `shop/redact`), tagging COD orders in Shopify, backfilling past orders, pagination of the order table, converting multi-currency totals, an integration test for the handler against a throwaway database.

## If this had 10,000 merchants

- Postgres instead of SQLite.
- A queue (SQS / BullMQ) between the webhook and the DB write: verify, enqueue, 200.
- EventBridge or Pub/Sub delivery instead of HTTP.
- A TTL job to prune `WebhookEvent`.
- Precomputed per-shop counters instead of `COUNT(*)` on every page load.
- Reconciliation jobs that catch missed webhooks using `orders(query: "created_at:>…")`.
- Rate-limit-aware Admin API calls.
