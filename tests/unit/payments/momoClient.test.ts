import { describe, it, expect } from 'vitest';
import { normalizeGhanaPhone, isMtnGhanaNumber } from '../../../src/payments/momoClient.js';

describe('normalizeGhanaPhone', () => {
  it('should normalize local format (0XXXXXXXXX)', () => {
    expect(normalizeGhanaPhone('0241234567')).toBe('233241234567');
  });

  it('should normalize international format (233XXXXXXXXX)', () => {
    expect(normalizeGhanaPhone('233241234567')).toBe('233241234567');
  });

  it('should normalize +233 format', () => {
    expect(normalizeGhanaPhone('+233241234567')).toBe('233241234567');
  });

  it('should normalize without leading 0 (9 digits)', () => {
    expect(normalizeGhanaPhone('241234567')).toBe('233241234567');
  });

  it('should strip whitespace and dashes', () => {
    expect(normalizeGhanaPhone('024 123 4567')).toBe('233241234567');
    expect(normalizeGhanaPhone('024-123-4567')).toBe('233241234567');
  });

  it('should strip parentheses', () => {
    expect(normalizeGhanaPhone('(024) 1234567')).toBe('233241234567');
  });

  it('should reject invalid lengths', () => {
    expect(() => normalizeGhanaPhone('12345')).toThrow('Invalid Ghanaian phone number');
    expect(() => normalizeGhanaPhone('02412345678901')).toThrow('Invalid Ghanaian phone number');
  });

  it('should reject invalid prefixes', () => {
    expect(() => normalizeGhanaPhone('0101234567')).toThrow('Invalid Ghana mobile prefix');
  });

  it('should handle various MTN prefixes', () => {
    expect(normalizeGhanaPhone('0241234567')).toBe('233241234567');
    expect(normalizeGhanaPhone('0251234567')).toBe('233251234567');
    expect(normalizeGhanaPhone('0551234567')).toBe('233551234567');
  });

  it('should handle Vodafone prefixes', () => {
    expect(normalizeGhanaPhone('0201234567')).toBe('233201234567');
    expect(normalizeGhanaPhone('0501234567')).toBe('233501234567');
  });
});

describe('isMtnGhanaNumber', () => {
  it('should return true for MTN numbers', () => {
    expect(isMtnGhanaNumber('0241234567')).toBe(true);
    expect(isMtnGhanaNumber('0251234567')).toBe(true);
    expect(isMtnGhanaNumber('0531234567')).toBe(true);
    expect(isMtnGhanaNumber('0541234567')).toBe(true);
    expect(isMtnGhanaNumber('0551234567')).toBe(true);
    expect(isMtnGhanaNumber('0591234567')).toBe(true);
  });

  it('should return true for MTN numbers in international format', () => {
    expect(isMtnGhanaNumber('233241234567')).toBe(true);
    expect(isMtnGhanaNumber('+233551234567')).toBe(true);
  });

  it('should return false for non-MTN numbers', () => {
    expect(isMtnGhanaNumber('0201234567')).toBe(false); // Vodafone
    expect(isMtnGhanaNumber('0261234567')).toBe(false); // AirtelTigo
    expect(isMtnGhanaNumber('0501234567')).toBe(false); // Vodafone
  });

  it('should return false for invalid numbers', () => {
    expect(isMtnGhanaNumber('12345')).toBe(false);
    expect(isMtnGhanaNumber('')).toBe(false);
    expect(isMtnGhanaNumber('not-a-number')).toBe(false);
  });
});
