import { describe, expect, it } from 'vitest';
import { desCbcEncrypt, legacyEncrypt } from '../../src/modules/auth/legacy-cipher.js';

describe('舊單一入口 DES 演算法(DATABASE.md §9.1、W3-4.16)', () => {
  it('DES 標準測試向量(FIPS 46 範例:金鑰 133457799BBCDFF1)', () => {
    // CBC + IV 全 0 的第一個區塊 = ECB;PKCS7 會再補一個區塊,只比對第一個
    const out = desCbcEncrypt(Buffer.from('0123456789ABCDEF', 'hex'), Buffer.from('133457799BBCDFF1', 'hex'), Buffer.alloc(8));
    expect(out.subarray(0, 8).toString('hex').toUpperCase()).toBe('85E813540F0AB405');
    expect(out.length).toBe(16);
  });

  // 期望值以 `node --openssl-legacy-provider` 的 des-cbc 產生(測試用金鑰,非舊系統常數)
  it.each([
    ['abc12345', 'test-key', 'test-server', 'sNPv7i7jVGJy0Hq8fElYbg=='],
    ['', 'k', 's', 'S8bJXZ3NCTw='],
    ['12345678', 'k2', 's2', 'MBBy8q6rtr9KOSdBjfgzsQ=='],
    ['密碼Pass1', '金鑰', 'SRV', '5hB3DFowIV9J2HgeqjgOUQ=='],
  ])('與 OpenSSL des-cbc 相同:%s', (pw, key, server, expected) => expect(legacyEncrypt(pw, key, server)).toBe(expected));

  it('金鑰或 IV 長度錯誤時丟出例外', () => expect(() => desCbcEncrypt(Buffer.from('x'), Buffer.alloc(7), Buffer.alloc(8))).toThrow());
});
