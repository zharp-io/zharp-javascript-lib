// The application a fixture bundle is built from: checkout() fails inside cart.js.
import { total } from './cart.js';

export function checkout() {
  return total([{ price: 1 }, null]);
}
