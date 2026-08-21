// Cart — BUG: duplicates not merged.
export class Cart {
  constructor() { this._items = []; } // [{id, qty}]
  addItem(id, qty = 1) {
    this._items.push({ id, qty }); // BUG: no dedupe
  }
  removeItem(id, qty = 1) {
    const i = this._items.findIndex((it) => it.id === id);
    if (i >= 0) {
      this._items[i].qty -= qty;
      if (this._items[i].qty <= 0) this._items.splice(i, 1);
    }
  }
  getItems() { return this._items; }
  // calculateTotal needs pricing integration — TODO
  calculateTotal(prices) {
    return this._items.reduce((sum, it) => sum + (prices[it.id] ?? 0) * it.qty, 0);
  }
}
