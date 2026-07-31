export type BrazilianTaxIdType = 'cpf' | 'cnpj';

export interface ValidBrazilianTaxId {
  normalized: string;
  type: BrazilianTaxIdType;
}

/** Strip punctuation/spaces before validation or persistence. */
export function normalizeBrazilianTaxId(value: string): string {
  return value.replace(/\D/g, '');
}

function hasRepeatedDigits(value: string): boolean {
  return /^(\d)\1+$/.test(value);
}

function calculateCheckDigit(base: string, weights: readonly number[]): number {
  const sum = weights.reduce(
    (total, weight, index) => total + Number(base[index]) * weight,
    0
  );
  const remainder = sum % 11;
  return remainder < 2 ? 0 : 11 - remainder;
}

export function isValidCpf(value: string): boolean {
  const digits = normalizeBrazilianTaxId(value);
  if (digits.length !== 11 || hasRepeatedDigits(digits)) return false;

  const first = calculateCheckDigit(
    digits.slice(0, 9),
    [10, 9, 8, 7, 6, 5, 4, 3, 2]
  );
  if (first !== Number(digits[9])) return false;

  const second = calculateCheckDigit(
    digits.slice(0, 10),
    [11, 10, 9, 8, 7, 6, 5, 4, 3, 2]
  );
  return second === Number(digits[10]);
}

export function isValidCnpj(value: string): boolean {
  const digits = normalizeBrazilianTaxId(value);
  if (digits.length !== 14 || hasRepeatedDigits(digits)) return false;

  const first = calculateCheckDigit(
    digits.slice(0, 12),
    [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]
  );
  if (first !== Number(digits[12])) return false;

  const second = calculateCheckDigit(
    digits.slice(0, 13),
    [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]
  );
  return second === Number(digits[13]);
}

export function validateBrazilianTaxId(
  value: string
): ValidBrazilianTaxId | null {
  const normalized = normalizeBrazilianTaxId(value);
  if (isValidCpf(normalized)) return { normalized, type: 'cpf' };
  if (isValidCnpj(normalized)) return { normalized, type: 'cnpj' };
  return null;
}
