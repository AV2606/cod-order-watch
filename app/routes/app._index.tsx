import type { ReactNode } from "react";
import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import db from "../db.server";

function formatMoney(amount: string, currency: string) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(
    // Intl accepts decimal strings, so no Number() round-trip is needed.
    amount as unknown as number,
  );
}

function parseGateways(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((g): g is string => typeof g === "string")
      : [];
  } catch {
    return [];
  }
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  // Per-shop isolation: the shop comes from the verified session and every query filters by it.
  const shop = session.shop;

  const [total, cod, valueByCurrency, recent] = await Promise.all([
    db.order.count({ where: { shop } }),
    db.order.count({ where: { shop, isCod: true } }),
    // Group by currency: summing across currencies would be meaningless.
    db.order.groupBy({
      by: ["currency"],
      where: { shop },
      _sum: { totalPrice: true },
      orderBy: { currency: "asc" },
    }),
    db.order.findMany({
      where: { shop },
      orderBy: { orderCreatedAt: "desc" },
      take: 20,
    }),
  ]);

  return {
    total,
    cod,
    // Guard against 0/0: no orders means no percentage, not "NaN%".
    codShare: total === 0 ? null : `${((cod / total) * 100).toFixed(1)}%`,
    totals: valueByCurrency.map((row) =>
      formatMoney((row._sum.totalPrice ?? 0).toString(), row.currency),
    ),
    orders: recent.map((order) => ({
      id: order.id,
      name: order.name,
      // Formatted on the server in UTC so server and client render identical text.
      createdAt: `${order.orderCreatedAt.toISOString().slice(0, 16).replace("T", " ")} UTC`,
      total: formatMoney(order.totalPrice.toString(), order.currency),
      gateways: parseGateways(order.gateways).join(", ") || "—",
      isCod: order.isCod,
    })),
  };
};

function StatTile({ label, children }: { label: string; children: ReactNode }) {
  return (
    <s-box padding="base" borderWidth="base" borderRadius="base">
      <s-stack direction="block" gap="small-300">
        <s-text color="subdued">{label}</s-text>
        {children}
      </s-stack>
    </s-box>
  );
}

export default function Index() {
  const { total, cod, codShare, totals, orders } =
    useLoaderData<typeof loader>();

  return (
    <s-page heading="COD order watch">
      {total === 0 ? (
        <s-section heading="No orders yet">
          <s-paragraph>
            No orders yet — create a test order in your Shopify admin (Orders →
            Create order, or place one through the storefront with Cash on
            Delivery) and it will show up here within seconds.
          </s-paragraph>
        </s-section>
      ) : (
        <>
          <s-section heading="Overview">
            <s-grid
              gridTemplateColumns="repeat(auto-fit, minmax(180px, 1fr))"
              gap="base"
            >
              <StatTile label="Total orders">
                <s-heading>{total}</s-heading>
              </StatTile>
              <StatTile label="COD orders">
                <s-heading>{cod}</s-heading>
              </StatTile>
              <StatTile label="COD share">
                <s-heading>{codShare}</s-heading>
              </StatTile>
              <StatTile label="Total order value">
                {totals.map((amount) => (
                  <s-heading key={amount}>{amount}</s-heading>
                ))}
              </StatTile>
            </s-grid>
          </s-section>

          <s-section heading="Last 20 orders" padding="none">
            <s-table>
              <s-table-header-row>
                <s-table-header listSlot="primary">Order</s-table-header>
                <s-table-header>Created</s-table-header>
                <s-table-header>Total</s-table-header>
                <s-table-header>Payment gateways</s-table-header>
                <s-table-header>COD</s-table-header>
              </s-table-header-row>
              <s-table-body>
                {orders.map((order) => (
                  <s-table-row key={order.id}>
                    <s-table-cell>{order.name}</s-table-cell>
                    <s-table-cell>{order.createdAt}</s-table-cell>
                    <s-table-cell>{order.total}</s-table-cell>
                    <s-table-cell>{order.gateways}</s-table-cell>
                    <s-table-cell>
                      {order.isCod ? (
                        <s-badge tone="warning">COD</s-badge>
                      ) : (
                        <s-badge>Prepaid</s-badge>
                      )}
                    </s-table-cell>
                  </s-table-row>
                ))}
              </s-table-body>
            </s-table>
          </s-section>
        </>
      )}
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
