/**
 * Pure helpers for the orders/create webhook: COD classification and payload validation.
 * No I/O here so everything is trivially unit-testable.
 */

/**
 * Online processors / wallets. A *pending* order paid through one of these is
 * "authorised but not captured" or similar, not cash on delivery.
 * Matching is a lowercase substring check because gateway names are free-form
 * (e.g. "shopify_payments", "PayPal Express Checkout", "Stripe").
 */
const KNOWN_ONLINE_PROCESSORS = [
  "shopify_payments",
  "shop_pay",
  "paypal",
  "stripe",
  "authorize_net",
  "braintree",
  "adyen",
  "klarna",
  "afterpay",
  "affirm",
  "amazon",
  "apple_pay",
  "google_pay",
  "bogus", // Shopify's test gateway
] as const;

export interface CodInput {
  payment_gateway_names?: unknown;
  financial_status?: unknown;
}

function gatewayList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((g): g is string => typeof g === "string")
    .map((g) => g.trim().toLowerCase())
    .filter(Boolean);
}

/** A gateway is "manual" if it is Shopify's literal "manual" or not a known online processor. */
function isManualGateway(gateway: string): boolean {
  if (gateway === "manual") return true;
  return !KNOWN_ONLINE_PROCESSORS.some((p) => gateway.includes(p));
}

/**
 * COD rule (documented in the README):
 *  1. Any gateway name containing "cash" (case-insensitive) is COD,
 *     e.g. "Cash on Delivery (COD)".
 *  2. Otherwise, the order is COD when financial_status is "pending" AND at least one
 *     gateway is manual (the literal "manual", or anything that is not a known online
 *     processor). Merchants can rename their COD method, so rule 1 alone would miss it.
 *
 * Known false positive: other manual methods that also stay "pending" (bank deposit,
 * money order) are classified as COD. An order with no gateway at all is not COD.
 */
export function isCodOrder({
  payment_gateway_names,
  financial_status,
}: CodInput): boolean {
  const gateways = gatewayList(payment_gateway_names);

  if (gateways.some((g) => g.includes("cash"))) return true;

  return financial_status === "pending" && gateways.some(isManualGateway);
}

export interface MappedOrder {
  shopifyId: string;
  name: string;
  /** Decimal string, e.g. "129.50". Kept as a string so no float ever touches the value. */
  totalPrice: string;
  currency: string;
  gateways: string[];
  isCod: boolean;
  orderCreatedAt: Date;
}

export type MapResult =
  | { ok: true; data: MappedOrder }
  | { ok: false; reason: string };

const DECIMAL_RE = /^\d+(\.\d+)?$/;
const CURRENCY_RE = /^[A-Z]{3}$/;

/**
 * Validate an untrusted orders/create payload and return typed data.
 * The HMAC proves the payload came from Shopify, not that its shape is what we expect
 * (API version changes, partial payloads), so we still parse defensively.
 */
export function mapOrderPayload(payload: unknown): MapResult {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return { ok: false, reason: "payload is not an object" };
  }
  const p = payload as Record<string, unknown>;

  // Ids are JSON numbers today; accept digit-only strings too. Always carried as a string.
  let shopifyId: string;
  if (typeof p.id === "number" && Number.isSafeInteger(p.id) && p.id > 0) {
    shopifyId = String(p.id);
  } else if (typeof p.id === "string" && /^\d+$/.test(p.id)) {
    shopifyId = p.id;
  } else {
    return { ok: false, reason: "invalid id" };
  }

  if (typeof p.name !== "string" || p.name.trim() === "") {
    return { ok: false, reason: "invalid name" };
  }

  const rawPrice =
    typeof p.total_price === "number" ? String(p.total_price) : p.total_price;
  if (typeof rawPrice !== "string" || !DECIMAL_RE.test(rawPrice)) {
    return { ok: false, reason: "invalid total_price" };
  }

  if (typeof p.currency !== "string" || !CURRENCY_RE.test(p.currency)) {
    return { ok: false, reason: "invalid currency" };
  }

  if (typeof p.created_at !== "string") {
    return { ok: false, reason: "invalid created_at" };
  }
  const orderCreatedAt = new Date(p.created_at);
  if (Number.isNaN(orderCreatedAt.getTime())) {
    return { ok: false, reason: "invalid created_at" };
  }

  if (
    p.payment_gateway_names !== undefined &&
    !Array.isArray(p.payment_gateway_names)
  ) {
    return { ok: false, reason: "invalid payment_gateway_names" };
  }
  const gateways = Array.isArray(p.payment_gateway_names)
    ? p.payment_gateway_names.filter((g): g is string => typeof g === "string")
    : [];

  return {
    ok: true,
    data: {
      shopifyId,
      name: p.name,
      totalPrice: rawPrice,
      currency: p.currency,
      gateways,
      isCod: isCodOrder({
        payment_gateway_names: gateways,
        financial_status: p.financial_status,
      }),
      orderCreatedAt,
    },
  };
}
