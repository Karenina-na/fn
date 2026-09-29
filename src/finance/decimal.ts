/** Exact finite decimal used for quantities, prices and fees. */
export class Decimal {
  private constructor(readonly coefficient: bigint, readonly scale: number) {}

  static parse(value: string): Decimal {
    if (!/^-?\d+(?:\.\d+)?$/.test(value)) throw new Error(`invalid decimal: ${value}`);
    const negative = value.startsWith('-');
    const [whole, fractional = ''] = (negative ? value.slice(1) : value).split('.');
    const coefficient = BigInt(`${negative ? '-' : ''}${whole}${fractional}`);
    return Decimal.normalize(coefficient, fractional.length);
  }

  static zero(): Decimal { return new Decimal(0n, 0); }

  private static normalize(coefficient: bigint, scale: number): Decimal {
    if (coefficient === 0n) return Decimal.zero();
    while (scale > 0 && coefficient % 10n === 0n) { coefficient /= 10n; scale--; }
    return new Decimal(coefficient, scale);
  }

  add(other: Decimal): Decimal {
    const scale = Math.max(this.scale, other.scale);
    return Decimal.normalize(this.coefficient * 10n ** BigInt(scale - this.scale) + other.coefficient * 10n ** BigInt(scale - other.scale), scale);
  }

  subtract(other: Decimal): Decimal { return this.add(other.negate()); }
  negate(): Decimal { return Decimal.normalize(-this.coefficient, this.scale); }
  multiply(other: Decimal): Decimal { return Decimal.normalize(this.coefficient * other.coefficient, this.scale + other.scale); }
  compare(other: Decimal): number {
    const difference = this.subtract(other).coefficient;
    return difference < 0n ? -1 : difference > 0n ? 1 : 0;
  }
  isZero(): boolean { return this.coefficient === 0n; }
  isPositive(): boolean { return this.coefficient > 0n; }

  toString(): string {
    if (this.scale === 0) return this.coefficient.toString();
    const negative = this.coefficient < 0n;
    const digits = (negative ? -this.coefficient : this.coefficient).toString().padStart(this.scale + 1, '0');
    return `${negative ? '-' : ''}${digits.slice(0, -this.scale)}.${digits.slice(-this.scale)}`;
  }
}
