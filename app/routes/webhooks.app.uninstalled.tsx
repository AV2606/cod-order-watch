import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  // Remove everything we hold for this shop in one transaction, so a failure can't leave
  // a half-deleted shop. deleteMany on already-empty tables is a no-op, which makes this
  // idempotent: webhooks can be delivered twice, or after the data is already gone.
  await db.$transaction([
    db.order.deleteMany({ where: { shop } }),
    db.webhookEvent.deleteMany({ where: { shop } }),
    db.session.deleteMany({ where: { shop } }),
  ]);

  return new Response();
};
