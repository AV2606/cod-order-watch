import type { ActionFunctionArgs } from "react-router";
import { Prisma } from "@prisma/client";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { mapOrderPayload } from "../lib/cod.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  // 1. Verify. authenticate.webhook reads the RAW body (request.text()), computes
  //    HMAC-SHA256 with the app secret, base64-encodes it and compares it to
  //    X-Shopify-Hmac-Sha256 in constant time. On mismatch it throws a 401 Response;
  //    on missing/invalid headers a 400. Raw bytes matter: re-serialising parsed JSON
  //    changes whitespace/key order/unicode escapes and the signature would no longer match.
  const { shop, topic, payload, session, webhookId } =
    await authenticate.webhook(request);

  // 2. Unknown shop: not installed (or already uninstalled). Nothing to store, and a
  //    non-2xx would make Shopify retry an event we will never process. Ack with 200.
  if (!session) {
    console.warn(`[orders/create] no session for ${shop}, ignoring`);
    return new Response();
  }

  // 3. Don't trust the shape. A malformed payload will never become valid on retry,
  //    so log it and return 200 instead of looping Shopify's retry schedule.
  const mapped = mapOrderPayload(payload);
  if (!mapped.ok) {
    console.error(
      `[orders/create] dropping invalid payload shop=${shop} webhookId=${webhookId}: ${mapped.reason}`,
    );
    return new Response();
  }
  const order = mapped.data;

  // 4. One transaction: record the delivery, then upsert the order.
  //    Layer 1: WebhookEvent.webhookId is the primary key, so a retried delivery fails here.
  //    Layer 2: @@unique([shop, shopifyId]) + upsert means a *different* webhook id for the
  //    same order still cannot create a second row.
  try {
    await db.$transaction([
      db.webhookEvent.create({ data: { webhookId, shop, topic } }),
      db.order.upsert({
        where: { shop_shopifyId: { shop, shopifyId: order.shopifyId } },
        create: {
          shop,
          shopifyId: order.shopifyId,
          name: order.name,
          totalPrice: order.totalPrice,
          currency: order.currency,
          gateways: JSON.stringify(order.gateways),
          isCod: order.isCod,
          orderCreatedAt: order.orderCreatedAt,
        },
        update: {
          name: order.name,
          totalPrice: order.totalPrice,
          currency: order.currency,
          gateways: JSON.stringify(order.gateways),
          isCod: order.isCod,
          orderCreatedAt: order.orderCreatedAt,
        },
      }),
    ]);
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002" &&
      (await db.webhookEvent.findUnique({ where: { webhookId } }))
    ) {
      // Same delivery seen before. The transaction rolled back, nothing changed.
      console.log(
        `[orders/create] duplicate delivery, skipping shop=${shop} webhookId=${webhookId} orderId=${order.shopifyId}`,
      );
      return new Response();
    }

    // Anything else (DB down, a unique race on Order, ...): 500 so Shopify retries.
    // Retrying is safe because the whole handler is idempotent.
    console.error(
      `[orders/create] failed shop=${shop} webhookId=${webhookId} orderId=${order.shopifyId}`,
      error,
    );
    return new Response(null, { status: 500 });
  }

  console.log(
    `[orders/create] stored order ${order.name} shop=${shop} webhookId=${webhookId} cod=${order.isCod}`,
  );
  return new Response();
};
