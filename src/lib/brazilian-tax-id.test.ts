import { describe, expect, it } from 'vitest';
import {
  isValidCnpj,
  isValidCpf,
  normalizeBrazilianTaxId,
  validateBrazilianTaxId,
} from './brazilian-tax-id';

describe('Brazilian CPF/CNPJ validation', () => {
  it('normalizes punctuation and accepts valid CPFs', () => {
    expect(normalizeBrazilianTaxId('529.982.247-25')).toBe('52998224725');
    expect(isValidCpf('529.982.247-25')).toBe(true);
    expect(validateBrazilianTaxId('529.982.247-25')).toEqual({
      normalized: '52998224725',
      type: 'cpf',
    });
  });

  it('rejects CPF checksum, length and repeated-digit failures', () => {
    expect(isValidCpf('529.982.247-24')).toBe(false);
    expect(isValidCpf('123')).toBe(false);
    expect(isValidCpf('111.111.111-11')).toBe(false);
  });

  it('normalizes punctuation and accepts valid CNPJs', () => {
    expect(isValidCnpj('04.252.011/0001-10')).toBe(true);
    expect(validateBrazilianTaxId('04.252.011/0001-10')).toEqual({
      normalized: '04252011000110',
      type: 'cnpj',
    });
  });

  it('rejects CNPJ checksum, length and repeated-digit failures', () => {
    expect(isValidCnpj('04.252.011/0001-11')).toBe(false);
    expect(isValidCnpj('1234567890123')).toBe(false);
    expect(isValidCnpj('00.000.000/0000-00')).toBe(false);
  });
});
