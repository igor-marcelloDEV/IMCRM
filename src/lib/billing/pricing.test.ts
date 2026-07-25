import { describe, it, expect } from "vitest";
import { computePrice, centsToReais, formatPriceCents } from "./pricing";

describe("computePrice", () => {
  it("charges full price for boleto/credit_card with no coupon", () => {
    expect(computePrice(14990, "boleto", null)).toEqual({
      baseCents: 14990,
      finalCents: 14990,
      discount: null,
      savedCents: 0,
    });
    expect(computePrice(14990, "credit_card", null)).toEqual({
      baseCents: 14990,
      finalCents: 14990,
      discount: null,
      savedCents: 0,
    });
  });

  it("applies the 10% PIX discount when no coupon is present", () => {
    const result = computePrice(14990, "pix", null);
    expect(result.discount).toBe("pix");
    expect(result.finalCents).toBe(13491); // 14990 * 0.9 = 13491
    expect(result.savedCents).toBe(1499);
  });

  it("a coupon always wins over the PIX discount — never both", () => {
    const result = computePrice(14990, "pix", { discountType: "percentage", discountValue: 20 });
    expect(result.discount).toBe("coupon");
    expect(result.finalCents).toBe(11992); // 14990 - 20% = 11992
  });

  it("supports a flat (fixed) coupon amount", () => {
    const result = computePrice(14990, "boleto", { discountType: "fixed", discountValue: 50 });
    expect(result.discount).toBe("coupon");
    expect(result.finalCents).toBe(9990); // 14990 - 5000 cents
  });

  it("never goes negative when a fixed coupon exceeds the price", () => {
    const result = computePrice(4990, "boleto", { discountType: "fixed", discountValue: 100 });
    expect(result.finalCents).toBe(0);
  });
});

describe("centsToReais", () => {
  it("converts cents to a decimal reais amount", () => {
    expect(centsToReais(14990)).toBe(149.9);
    expect(centsToReais(100)).toBe(1);
  });
});

describe("formatPriceCents", () => {
  it("formats cents as a currency string", () => {
    expect(formatPriceCents(14990, "BRL")).toContain("149");
    expect(formatPriceCents(14990, "BRL")).toContain("90");
  });

  it("falls back gracefully on an invalid currency code", () => {
    expect(() => formatPriceCents(14990, "NOT_A_CODE")).not.toThrow();
  });
});
