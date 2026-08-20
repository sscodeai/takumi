export class Counter {
  constructor() { this.v = 0; }
  increment() { this.v += 1; return this.v; }
  get() { return this.v; }
}
