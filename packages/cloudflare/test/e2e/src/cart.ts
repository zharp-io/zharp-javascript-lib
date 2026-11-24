export interface Line {
  sku: string;
  quantity: number;
  price?: { amount: number };
}

/** The total of a cart; a line without a price is a bug the test relies on. */
export function cartTotal(lines: Line[]): number {
  let total = 0;
  for (const line of lines) {
    total += line.quantity * line.price!.amount;
  }
  return total;
}
