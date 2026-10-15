-- CreateTable
CREATE TABLE "Order" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "shopifyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "totalPrice" DECIMAL NOT NULL,
    "currency" TEXT NOT NULL,
    "gateways" TEXT NOT NULL,
    "isCod" BOOLEAN NOT NULL,
    "orderCreatedAt" DATETIME NOT NULL,
    "receivedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "WebhookEvent" (
    "webhookId" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "processedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "Order_shop_orderCreatedAt_idx" ON "Order"("shop", "orderCreatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Order_shop_shopifyId_key" ON "Order"("shop", "shopifyId");

-- CreateIndex
CREATE INDEX "WebhookEvent_shop_idx" ON "WebhookEvent"("shop");
