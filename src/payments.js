// Payments provider boundary. The mock provider records transfers in memory.
// Replace with a real provider (bank-account verification, ACH or push-to-card payouts)
// by implementing the same two methods. Idempotency keys make retries safe.
export function mockProvider() {
  const transfers = new Map();
  return {
    name: "mock",
    async createTransfer({ amountCents, merchantId, idempotencyKey }) {
      if (transfers.has(idempotencyKey)) return transfers.get(idempotencyKey);
      const t = { ref: `mock_tr_${transfers.size + 1}`, amountCents, merchantId, status: "sent" };
      transfers.set(idempotencyKey, t);
      return t;
    },
    list() {
      return [...transfers.values()];
    },
  };
}
