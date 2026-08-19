import { validateSync } from 'class-validator';
import { Money } from './money';
import { IsMoneyString } from './is-money-string.validator';

class Probe {
  @IsMoneyString()
  amount!: unknown;
}

const isValid = (amount: unknown): boolean => {
  const probe = new Probe();
  probe.amount = amount;
  return validateSync(probe).length === 0;
};

describe('Money.normalize', () => {
  it.each([
    ['0.1', '0.10'],
    ['100', '100.00'],
    ['100.5', '100.50'],
    ['0.01', '0.01'],
    ['9999999999.99', '9999999999.99'],
  ])('normalizes %s to %s', (input, expected) => {
    expect(Money.normalize(input)).toBe(expected);
  });

  it.each(['', 'abc', '40.555', '-5.00', '1e3', '10,00'])('rejects %s', (input) => {
    expect(() => Money.normalize(input)).toThrow(TypeError);
  });

  it('rejects a JS number', () => {
    expect(() => Money.normalize(100 as unknown as string)).toThrow(TypeError);
  });
});

describe('Money.negate', () => {
  it('negates without ever becoming a JS number', () => {
    expect(Money.negate('40.00')).toBe('-40.00');
    expect(Money.negate('0.1')).toBe('-0.10');
    expect(Money.negate('0.00')).toBe('0.00');
  });
});

describe('Money.toMinor / equals', () => {
  it('converts to exact minor units', () => {
    expect(Money.toMinor('100.00')).toBe(10000n);
    expect(Money.toMinor('0.1')).toBe(10n);
    // The classic float failure: 0.1 + 0.2 !== 0.3 as doubles. Exact here.
    expect(Money.toMinor('0.1') + Money.toMinor('0.2')).toBe(Money.toMinor('0.30'));
  });

  it('compares by value, not by formatting', () => {
    expect(Money.equals('5', '5.00')).toBe(true);
    expect(Money.equals('5.00', '5.01')).toBe(false);
  });
});

describe('@IsMoneyString', () => {
  it('accepts positive money strings', () => {
    expect(isValid('0.01')).toBe(true);
    expect(isValid('100.00')).toBe(true);
    expect(isValid('9999999999.99')).toBe(true);
  });

  it('rejects a JSON number — the float firewall', () => {
    expect(isValid(100)).toBe(false);
    expect(isValid(40.5)).toBe(false);
  });

  it.each(['', 'abc', '40.555', '0', '0.00', '-5.00', '10000000000.00'])('rejects %s', (input) => {
    expect(isValid(input)).toBe(false);
  });

  it('rejects null and undefined', () => {
    expect(isValid(null)).toBe(false);
    expect(isValid(undefined)).toBe(false);
  });
});
