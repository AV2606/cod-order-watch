import { beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Exercises the real `authenticate.webhook` from app/shopify.server.ts, the same function
 * the orders/create route calls first, with a real Request carrying real headers.
 * Only the database-backed pieces are stubbed, so no SQLite or Prisma client is needed.
 */

// Env must exist before app/shopify.server.ts is imported (it reads it at module load).
vi.hoisted(() => {
  process.env.SHOPIFY_API_KEY = "test_key";
  process.env.SHOPIFY_API_SECRET = "test_secret";
  process.env.SHOPIFY_APP_URL = "https://example.com";
  process.env.SCOPES = "read_orders";
});

vi.mock("../app/db.server", () => ({ default: {} }));
vi.mock("@shopify/shopify-app-session-storage-prisma", () => ({
  PrismaSessionStorage: class {
    storeSession = async () => true;
    loadSession = async () => undefined;
    deleteSession = async () => true;
    deleteSessions = async () => true;
    findSessionsByShop = async () => [];
  },
}));

// Fixed vector, precomputed once with:
//   crypto.createHmac("sha256", "test_secret").update(BODY, "utf8").digest("base64")
// Deliberately pretty-printed with an inline array and a non-ASCII character, so that
// JSON.parse -> JSON.stringify produces *different bytes* than the original.
const BODY = `{
  "id": 5678901234567,
  "name": "#1001",
  "total_price": "129.50",
  "currency": "USD",
  "created_at": "2026-10-01T10:00:00Z",
  "payment_gateway_names": ["Cash on Delivery (COD)"],
  "financial_status": "pending",
  "note": "café"
}`;
const VALID_SIGNATURE = "w1+KfpPo/O2rVyDt/Q39ury5KQewHVPCbYORhtaygjY=";
const OTHER_SECRET_SIGNATURE = "YRpex8HrOp4yTod/0hlOBcGiXM0T9nidHQAdIiQ4FTI=";

function webhookRequest(body: string, signature: string | null) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-shopify-topic": "orders/create",
    "x-shopify-shop-domain": "test-shop.myshopify.com",
    "x-shopify-api-version": "2027-01",
    "x-shopify-webhook-id": "b54557e4-bdd9-4b37-8a5f-bf7d70bcd043",
  };
  if (signature !== null) headers["x-shopify-hmac-sha256"] = signature;
  return new Request("https://example.com/webhooks/orders/create", {
    method: "POST",
    headers,
    body,
  });
}

async function statusOfRejection(request: Request) {
  try {
    await authenticate.webhook(request);
  } catch (thrown) {
    if (thrown instanceof Response) return thrown.status;
    throw thrown;
  }
  return null; // accepted
}

let authenticate: typeof import("../app/shopify.server").authenticate;

beforeAll(async () => {
  ({ authenticate } = await import("../app/shopify.server"));
});

describe("authenticate.webhook HMAC verification", () => {
  it("accepts a valid signature over the raw body", async () => {
    const result = await authenticate.webhook(
      webhookRequest(BODY, VALID_SIGNATURE),
    );
    expect(result.shop).toBe("test-shop.myshopify.com");
    expect(result.topic).toBe("ORDERS_CREATE"); // the library normalises the topic header
    expect(result.webhookId).toBe("b54557e4-bdd9-4b37-8a5f-bf7d70bcd043");
    expect(result.payload).toMatchObject({ id: 5678901234567, name: "#1001" });
  });

  it("rejects a tampered body with 401", async () => {
    const tampered = BODY.replace("129.50", "1.00");
    expect(await statusOfRejection(webhookRequest(tampered, VALID_SIGNATURE))).toBe(
      401,
    );
  });

  it("rejects a signature made with the wrong secret with 401", async () => {
    expect(
      await statusOfRejection(webhookRequest(BODY, OTHER_SECRET_SIGNATURE)),
    ).toBe(401);
  });

  it("rejects a request with no signature header", async () => {
    expect(await statusOfRejection(webhookRequest(BODY, null))).toBe(400);
  });

  it("rejects re-serialised JSON, proving the raw body is what gets signed", async () => {
    const reserialised = JSON.stringify(JSON.parse(BODY));
    // Same data, different bytes: parse + stringify changes whitespace.
    expect(JSON.parse(reserialised)).toEqual(JSON.parse(BODY));
    expect(reserialised).not.toBe(BODY);

    expect(
      await statusOfRejection(webhookRequest(reserialised, VALID_SIGNATURE)),
    ).toBe(401);
  });
});
