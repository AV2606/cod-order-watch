# 0. Before you write code (~10 min)
Nothing is committed yet. Check .mcp.json, .cursor/ and .gemini/ for tokens, add them to .gitignore if they're just your tooling, then commit the scaffold as-is: chore: scaffold from Shopify React Router template. That gives reviewers a clean baseline to diff against.
Make sure shopify app dev runs, installs on your dev store, and the template page loads. On the store, turn on Settings > Payments > Manual payment methods > Cash on Delivery.
# 1. Strip the template and fix config (~15 min)
In shopify.app.toml:

Change scopes to read_orders, or read_orders,write_orders if you pick the tagging bonus.
Delete the demo product.metafields and metaobjects blocks.
Add the orders/create subscription at /webhooks/orders/create. Keep api_version = "2027-01" as generated.
Delete app/routes/app.additional.tsx and the demo product mutation in app/routes/app._index.tsx, so there's no dead code.

Likely snag: order webhooks contain protected customer data. If deliveries never arrive, go to the Dev Dashboard → your app → API access and request protected customer data access (the basic level is enough). Write down in the README whether this happened.

Restart dev and accept the config sync. Commit.

# 2. Data model (~20 min)
Add to prisma/schema.prisma:


model Order {
  id           String   @id @default(cuid())
  shop         String
  shopifyId    String          // orders/create payload id (BigInt as string)
  name         String
  totalPrice   Decimal         // or String; never Float for money
  currency     String
  gateways     String          // JSON array or comma-joined
  isCod        Boolean
  orderCreatedAt DateTime
  receivedAt   DateTime @default(now())
  @@unique([shop, shopifyId])
  @@index([shop, orderCreatedAt])
}

model WebhookEvent {
  webhookId  String   @id      // X-Shopify-Webhook-Id
  shop       String
  topic      String
  processedAt DateTime @default(now())
  @@index([shop])
}
That's two layers of idempotency:

WebhookEvent: the same delivery retried gets caught by its webhook ID. This is what the task asks for.
@@unique([shop, shopifyId]): a different webhook ID for the same order still can't create a second row.
Run npx prisma migrate dev --name orders. Commit.

# 3. COD rule as a pure function (~15 min)
Put app/lib/cod.server.ts → isCodOrder({ payment_gateway_names, financial_status }) there:

COD if any gateway name, lowercased, contains "cash".
or financial_status === "pending" and a gateway is manual, meaning "manual" or a name that isn't a known online processor. Decide exactly what counts as manual and document it.
Also add a mapOrderPayload(payload) that validates the fields and returns typed data. Don't trust the payload's shape: use defensive parsing and drop bad events with a log line. Small pure functions are easy to test and easy to explain.

# 4. orders/create handler (~45 min). This is 30% of the grade
Create app/routes/webhooks.orders.create.tsx with this flow:

const { shop, topic, payload, session } = await authenticate.webhook(request). Be ready to explain this. It reads request.text() (the raw bytes), computes HMAC-SHA256 with the app's client secret, base64-encodes it, and compares it to X-Shopify-Hmac-Sha256 with a constant-time compare (timingSafeEqual). If the check fails it throws a 401 Response. The raw body matters because re-serialising parsed JSON changes whitespace, key order and unicode escapes, so the signature would no longer match.
Unknown shop: if there's no session, the app isn't installed or was uninstalled. Log it and return 200 without storing anything. Returning 200 stops retries for an event you'll never process.
Read X-Shopify-Webhook-Id. If it's missing, log and return 200 (or 400).
Run one prisma.$transaction: create the WebhookEvent row, then upsert the Order. If the event insert fails with a unique violation (P2002), it's a duplicate: log "duplicate delivery, skipping" and return 200.
Any other error: log it with context (shop, webhookId, orderId) and decide how to respond. Recommendation: return 500 so Shopify retries, which is safe because the handler is idempotent. That's a good point to make in the presentation.
On "fast 200": a single SQLite write takes milliseconds, well inside Shopify's 5-second timeout, so doing it inline is fine. Say plainly that at scale you'd verify, enqueue, return 200, and process in a worker.
Test it with shopify app webhook trigger (fire it twice, watch the duplicate log line) and with a real order from the admin. Commit.

# 5. app/uninstalled (~10 min)
Extend the existing webhooks.app.uninstalled.tsx to delete Order, WebhookEvent and Session rows for the shop in one transaction. It must be idempotent too, because it can be delivered twice. Commit.

# 6. Dashboard (~45 min)
In app/routes/app._index.tsx, the loader calls authenticate.admin(request) and gets the shop from session.shop. Every query filters by that shop, which is your per-shop isolation.

Stats: use count, count with isCod, and a sum of totalPrice. If a shop has more than one currency, group by currency rather than adding them together, and mention it.
Last 20 orders: orderBy orderCreatedAt desc, take 20.
UI: use the Polaris web components the template already uses (s-page, s-section, s-table). Show 4 stat tiles plus the table.
Empty state: on a fresh install, show "No orders yet — create a test order…" instead of 0/0 = NaN%. Graders check for this.
Commit.

# 7. Bonus: HMAC unit test (~30 min)
Pick this bonus. It reinforces the 30% webhook area and also covers the "at least one meaningful test" requirement.

Add vitest.
Test a fixed payload, secret and expected signature (precompute it once with crypto.createHmac). Cover:
a valid signature is accepted
a tampered body is rejected
a wrong secret is rejected
a missing header is rejected
re-serialised JSON is rejected, which proves the raw-body point
Simplest honest approach: build a Request and call authenticate.webhook with test env vars set. Alternative: write a small verifyShopifyHmac(rawBody, header, secret) helper and test that, but only if the handler actually uses it. Otherwise it's dead code.
Also add tests for isCodOrder. They're cheap and show off the rule.
Commit.

# 8. README (~25 min)
Cover these:

How to run: prereqs, npm i, shopify app dev, enabling COD, triggering a webhook.
The COD rule.
Key decisions: authenticate.webhook, the two idempotency layers, inline write vs. queue, 500-to-retry, Decimal for money.
Actual time spent. Keep a running log from now on.
What you'd do with more time and what you left out: orders/updated, compliance webhooks, tagging, backfilling past orders, pagination, multi-currency totals.
The 10,000-merchants answer:
Postgres instead of SQLite.
A queue (SQS/BullMQ) between the webhook and the DB write.
EventBridge or Pub/Sub delivery instead of HTTP.
A TTL to prune WebhookEvent.
Precomputed per-shop counters instead of a COUNT(*) on every page load.
Reconciliation jobs that catch missed webhooks using orders(query: "created_at:>…").
Rate-limit-aware Admin API calls.
Commit.

# 9. Rehearse the demo (~20 min)
Run through it in this order:

Create an order on the dev store; it shows up on the dashboard.
Fire the same webhook twice; the count stays the same. Show the log line and the WebhookEvent row in npx prisma studio.
Send a bad signature with curl → 401.
Walk through the handler.
Uninstall → the rows are gone.
If you have time to spare: orders/updated reuses the same upsert, so it's about 20 minutes of work, but only do it after everything above is done.

I can start on steps 0–2 now if you like.