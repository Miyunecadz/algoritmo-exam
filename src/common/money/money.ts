/**
 * Money primitives.
 *
 * Money is a decimal string everywhere in this codebase: `numeric(12,2)` in Postgres, `string` in
 * TypeScript, `string` in JSON. This module exists only to normalise and sign those strings at the
 * boundary. It deliberately offers no `add` and no `compare` — every sum and every comparison in
 * this system happens in SQL, inside the transaction that needs it, where Postgres does exact
 * decimal arithmetic for us. There is no `parseFloat` and no `Number(...)` anywhere below.
 */

/** `numeric(12,2)` holds at most 9,999,999,999.99. */
export const MONEY_PATTERN = /^\d{1,10}(\.\d{1,2})?$/;

export class Money {
  /** `"0.1"` -> `"0.10"`, `"100"` -> `"100.00"`. Throws on anything that is not a money string. */
  static normalize(value: string): string {
    if (typeof value !== 'string' || !MONEY_PATTERN.test(value)) {
      throw new TypeError(`Not a money string: ${JSON.stringify(value)}`);
    }
    const [whole, fraction = ''] = value.split('.');
    return `${whole}.${fraction.padEnd(2, '0')}`;
  }

  /** `"40.00"` -> `"-40.00"`. Pure string work — the value never becomes a JS number. */
  static negate(value: string): string {
    const normalized = Money.normalize(value);
    return normalized === '0.00' ? normalized : `-${normalized}`;
  }

  /** Minor units (centavos) as a `bigint`. Used for exact equality checks in TypeScript. */
  static toMinor(value: string): bigint {
    const [whole, fraction] = Money.normalize(value).split('.');
    return BigInt(whole) * 100n + BigInt(fraction);
  }

  /** True when both strings denote the same amount, regardless of formatting (`"5"` === `"5.00"`). */
  static equals(a: string, b: string): boolean {
    return Money.toMinor(a) === Money.toMinor(b);
  }

  /** Cheap, allocation-free predicate used by the class-validator constraint. */
  static isPositiveMoneyString(value: unknown): value is string {
    if (typeof value !== 'string' || !MONEY_PATTERN.test(value)) return false;
    return Money.toMinor(value) > 0n;
  }
}
