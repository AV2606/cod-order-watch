import { describe, expect, it } from "vitest";
import { isCodOrder, mapOrderPayload } from "../app/lib/cod.server";

describe("isCodOrder", () => {
  it("is COD when a gateway name contains 'cash' (case-insensitive)", () => {
    expect(
      isCodOrder({
        payment_gateway_names: ["Cash on Delivery (COD)"],
        financial_status: "paid",
      }),
    ).toBe(true);
    expect(
      isCodOrder({ payment_gateway_names: ["CASH"], financial_status: "paid" }),
    ).toBe(true);
  });

  it("is COD when pending and the gateway is the literal 'manual'", () => {
    expect(
      isCodOrder({
        payment_gateway_names: ["manual"],
        financial_status: "pending",
      }),
    ).toBe(true);
  });

  it("is COD when pending and the gateway is a custom manual method (renamed COD)", () => {
    expect(
      isCodOrder({
        payment_gateway_names: ["Pay at the door"],
        financial_status: "pending",
      }),
    ).toBe(true);
  });

  it("is not COD for pending orders on a known online processor", () => {
    expect(
      isCodOrder({
        payment_gateway_names: ["shopify_payments"],
        financial_status: "pending",
      }),
    ).toBe(false);
    expect(
      isCodOrder({
        payment_gateway_names: ["PayPal Express Checkout"],
        financial_status: "pending",
      }),
    ).toBe(false);
  });

  it("is not COD for paid orders on a manual gateway without 'cash' in the name", () => {
    expect(
      isCodOrder({
        payment_gateway_names: ["manual"],
        financial_status: "paid",
      }),
    ).toBe(false);
  });

  it("is not COD for ordinary prepaid orders", () => {
    expect(
      isCodOrder({
        payment_gateway_names: ["shopify_payments"],
        financial_status: "paid",
      }),
    ).toBe(false);
  });

  it("tolerates missing or garbage input", () => {
    expect(isCodOrder({})).toBe(false);
    expect(
      isCodOrder({ payment_gateway_names: "cash", financial_status: "pending" }),
    ).toBe(false);
    expect(
      isCodOrder({ payment_gateway_names: [null, 5], financial_status: "pending" }),
    ).toBe(false);
  });

  it("is COD when pending with an empty gateway list (admin order left unpaid)", () => {
    expect(
      isCodOrder({ payment_gateway_names: [], financial_status: "pending" }),
    ).toBe(true);
  });

  it("is not COD when paid with an empty gateway list", () => {
    expect(
      isCodOrder({ payment_gateway_names: [], financial_status: "paid" }),
    ).toBe(false);
  });
});

describe("mapOrderPayload", () => {
  const valid = {
    id: 5678901234567,
    name: "#1001",
    total_price: "129.50",
    currency: "USD",
    created_at: "2026-10-01T10:00:00Z",
    payment_gateway_names: ["Cash on Delivery (COD)"],
    financial_status: "pending",
  };

  it("maps a valid payload to typed data", () => {
    const result = mapOrderPayload(valid);
    expect(result).toEqual({
      ok: true,
      data: {
        shopifyId: "5678901234567",
        name: "#1001",
        totalPrice: "129.50",
        currency: "USD",
        gateways: ["Cash on Delivery (COD)"],
        isCod: true,
        orderCreatedAt: new Date("2026-10-01T10:00:00Z"),
      },
    });
  });

  it("keeps money as a decimal string", () => {
    const result = mapOrderPayload({ ...valid, total_price: "0.10" });
    expect(result.ok && result.data.totalPrice).toBe("0.10");
  });

  it.each([
    ["null payload", null],
    ["array payload", []],
    ["missing id", { ...valid, id: undefined }],
    ["float id", { ...valid, id: 1.5 }],
    ["empty name", { ...valid, name: " " }],
    ["negative price", { ...valid, total_price: "-5.00" }],
    ["non-numeric price", { ...valid, total_price: "abc" }],
    ["bad currency", { ...valid, currency: "usd" }],
    ["bad date", { ...valid, created_at: "yesterday" }],
    ["gateways not an array", { ...valid, payment_gateway_names: "cash" }],
  ])("rejects %s", (_label, payload) => {
    expect(mapOrderPayload(payload).ok).toBe(false);
  });
});
