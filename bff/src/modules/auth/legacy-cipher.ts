/**
 * 舊單一入口密碼演算法(DATABASE.md §9.1、PRD Q18;移植自舊系統 App_Code/GSCLib.cs 的 Cipher.Encrypt):
 *   md5 = MD5(UTF8(金鑰字串 + 伺服器常數));前 8 bytes 為 DES 金鑰、後 8 bytes 為 IV
 *   以 DES-CBC、PKCS7 填補加密 UTF8(密碼),輸出 Base64,與 LoginData.PNum 字串相等即相符
 *
 * 單一 DES 不在 Node.js 預設的 OpenSSL 3 中,這裡以純 JS 實作,不啟用整個程序的 legacy provider(PRD §14.1)。
 * 只做加密比對、不提供解密。兩個常數字串由 Docker secret 提供(config.legacyPortal),不寫入程式與版控。
 */
import { createHash } from 'node:crypto';

const PC1 = [
  57, 49, 41, 33, 25, 17, 9, 1, 58, 50, 42, 34, 26, 18, 10, 2, 59, 51, 43, 35, 27, 19, 11, 3, 60, 52, 44, 36, 63, 55, 47, 39, 31, 23, 15, 7, 62, 54, 46, 38, 30,
  22, 14, 6, 61, 53, 45, 37, 29, 21, 13, 5, 28, 20, 12, 4,
];
const PC2 = [
  14, 17, 11, 24, 1, 5, 3, 28, 15, 6, 21, 10, 23, 19, 12, 4, 26, 8, 16, 7, 27, 20, 13, 2, 41, 52, 31, 37, 47, 55, 30, 40, 51, 45, 33, 48, 44, 49, 39, 56, 34,
  53, 46, 42, 50, 36, 29, 32,
];
const SHIFTS = [1, 1, 2, 2, 2, 2, 2, 2, 1, 2, 2, 2, 2, 2, 2, 1];
const IP = [
  58, 50, 42, 34, 26, 18, 10, 2, 60, 52, 44, 36, 28, 20, 12, 4, 62, 54, 46, 38, 30, 22, 14, 6, 64, 56, 48, 40, 32, 24, 16, 8, 57, 49, 41, 33, 25, 17, 9, 1, 59,
  51, 43, 35, 27, 19, 11, 3, 61, 53, 45, 37, 29, 21, 13, 5, 63, 55, 47, 39, 31, 23, 15, 7,
];
const FP = [
  40, 8, 48, 16, 56, 24, 64, 32, 39, 7, 47, 15, 55, 23, 63, 31, 38, 6, 46, 14, 54, 22, 62, 30, 37, 5, 45, 13, 53, 21, 61, 29, 36, 4, 44, 12, 52, 20, 60, 28, 35,
  3, 43, 11, 51, 19, 59, 27, 34, 2, 42, 10, 50, 18, 58, 26, 33, 1, 41, 9, 49, 17, 57, 25,
];
const E = [
  32, 1, 2, 3, 4, 5, 4, 5, 6, 7, 8, 9, 8, 9, 10, 11, 12, 13, 12, 13, 14, 15, 16, 17, 16, 17, 18, 19, 20, 21, 20, 21, 22, 23, 24, 25, 24, 25, 26, 27, 28, 29, 28,
  29, 30, 31, 32, 1,
];
const P = [16, 7, 20, 21, 29, 12, 28, 17, 1, 15, 23, 26, 5, 18, 31, 10, 2, 8, 24, 14, 32, 27, 3, 9, 19, 13, 30, 6, 22, 11, 4, 25];
const S = [
  [
    14, 4, 13, 1, 2, 15, 11, 8, 3, 10, 6, 12, 5, 9, 0, 7, 0, 15, 7, 4, 14, 2, 13, 1, 10, 6, 12, 11, 9, 5, 3, 8, 4, 1, 14, 8, 13, 6, 2, 11, 15, 12, 9, 7, 3, 10,
    5, 0, 15, 12, 8, 2, 4, 9, 1, 7, 5, 11, 3, 14, 10, 0, 6, 13,
  ],
  [
    15, 1, 8, 14, 6, 11, 3, 4, 9, 7, 2, 13, 12, 0, 5, 10, 3, 13, 4, 7, 15, 2, 8, 14, 12, 0, 1, 10, 6, 9, 11, 5, 0, 14, 7, 11, 10, 4, 13, 1, 5, 8, 12, 6, 9, 3,
    2, 15, 13, 8, 10, 1, 3, 15, 4, 2, 11, 6, 7, 12, 0, 5, 14, 9,
  ],
  [
    10, 0, 9, 14, 6, 3, 15, 5, 1, 13, 12, 7, 11, 4, 2, 8, 13, 7, 0, 9, 3, 4, 6, 10, 2, 8, 5, 14, 12, 11, 15, 1, 13, 6, 4, 9, 8, 15, 3, 0, 11, 1, 2, 12, 5, 10,
    14, 7, 1, 10, 13, 0, 6, 9, 8, 7, 4, 15, 14, 3, 11, 5, 2, 12,
  ],
  [
    7, 13, 14, 3, 0, 6, 9, 10, 1, 2, 8, 5, 11, 12, 4, 15, 13, 8, 11, 5, 6, 15, 0, 3, 4, 7, 2, 12, 1, 10, 14, 9, 10, 6, 9, 0, 12, 11, 7, 13, 15, 1, 3, 14, 5, 2,
    8, 4, 3, 15, 0, 6, 10, 1, 13, 8, 9, 4, 5, 11, 12, 7, 2, 14,
  ],
  [
    2, 12, 4, 1, 7, 10, 11, 6, 8, 5, 3, 15, 13, 0, 14, 9, 14, 11, 2, 12, 4, 7, 13, 1, 5, 0, 15, 10, 3, 9, 8, 6, 4, 2, 1, 11, 10, 13, 7, 8, 15, 9, 12, 5, 6, 3,
    0, 14, 11, 8, 12, 7, 1, 14, 2, 13, 6, 15, 0, 9, 10, 4, 5, 3,
  ],
  [
    12, 1, 10, 15, 9, 2, 6, 8, 0, 13, 3, 4, 14, 7, 5, 11, 10, 15, 4, 2, 7, 12, 9, 5, 6, 1, 13, 14, 0, 11, 3, 8, 9, 14, 15, 5, 2, 8, 12, 3, 7, 0, 4, 10, 1, 13,
    11, 6, 4, 3, 2, 12, 9, 5, 15, 10, 11, 14, 1, 7, 6, 0, 8, 13,
  ],
  [
    4, 11, 2, 14, 15, 0, 8, 13, 3, 12, 9, 7, 5, 10, 6, 1, 13, 0, 11, 7, 4, 9, 1, 10, 14, 3, 5, 12, 2, 15, 8, 6, 1, 4, 11, 13, 12, 3, 7, 14, 10, 15, 6, 8, 0, 5,
    9, 2, 6, 11, 13, 8, 1, 4, 10, 7, 9, 5, 0, 15, 14, 2, 3, 12,
  ],
  [
    13, 2, 8, 4, 6, 15, 11, 1, 10, 9, 3, 14, 5, 0, 12, 7, 1, 15, 13, 8, 10, 3, 7, 4, 12, 5, 6, 11, 0, 14, 9, 2, 7, 11, 4, 1, 9, 12, 14, 2, 0, 6, 10, 13, 15, 3,
    5, 8, 2, 1, 14, 7, 4, 10, 8, 13, 15, 12, 9, 0, 3, 5, 6, 11,
  ],
];

type Bits = number[];

function toBits(bytes: Uint8Array): Bits {
  const out: Bits = [];
  for (const b of bytes) for (let i = 7; i >= 0; i--) out.push((b >> i) & 1);
  return out;
}

function toBytes(bits: Bits): Buffer {
  const out = Buffer.alloc(bits.length / 8);
  for (let i = 0; i < bits.length; i++) out[i >> 3]! |= bits[i]! << (7 - (i & 7));
  return out;
}

const permute = (bits: Bits, table: number[]): Bits => table.map((i) => bits[i - 1]!);
const xor = (a: Bits, b: Bits): Bits => a.map((v, i) => v ^ b[i]!);
const rotl = (bits: Bits, n: number): Bits => bits.slice(n).concat(bits.slice(0, n));

/** 16 個 48 bit 子金鑰(金鑰的同位元位元不使用) */
function subkeys(key: Uint8Array): Bits[] {
  const cd = permute(toBits(key), PC1);
  let c = cd.slice(0, 28);
  let d = cd.slice(28);
  return SHIFTS.map((n) => {
    c = rotl(c, n);
    d = rotl(d, n);
    return permute(c.concat(d), PC2);
  });
}

function feistel(r: Bits, k: Bits): Bits {
  const x = xor(permute(r, E), k);
  const out: Bits = [];
  for (let i = 0; i < 8; i++) {
    const b = x.slice(i * 6, i * 6 + 6);
    const v = S[i]![((b[0]! << 1) | b[5]!) * 16 + ((b[1]! << 3) | (b[2]! << 2) | (b[3]! << 1) | b[4]!)]!;
    out.push((v >> 3) & 1, (v >> 2) & 1, (v >> 1) & 1, v & 1);
  }
  return permute(out, P);
}

/** DES 單一區塊(8 bytes)加密 */
export function desEncryptBlock(block: Uint8Array, keys: Bits[]): Buffer {
  const bits = permute(toBits(block), IP);
  let l = bits.slice(0, 32);
  let r = bits.slice(32);
  for (const k of keys) [l, r] = [r, xor(l, feistel(r, k))];
  return toBytes(permute(r.concat(l), FP));
}

/** DES-CBC + PKCS7(與 .NET DESCryptoServiceProvider 預設相同) */
export function desCbcEncrypt(plain: Uint8Array, key: Uint8Array, iv: Uint8Array): Buffer {
  if (key.length !== 8 || iv.length !== 8) throw new Error('DES 金鑰與 IV 需為 8 bytes');
  const keys = subkeys(key);
  const pad = 8 - (plain.length % 8);
  const data = Buffer.concat([Buffer.from(plain), Buffer.alloc(pad, pad)]);
  const out: Buffer[] = [];
  let prev: Uint8Array = iv;
  for (let i = 0; i < data.length; i += 8) {
    const block = data.subarray(i, i + 8).map((b, j) => b ^ prev[j]!);
    prev = desEncryptBlock(block, keys);
    out.push(prev as Buffer);
  }
  return Buffer.concat(out);
}

/** 舊單一入口密碼密文(Base64);keyString + serverKey 為舊系統的兩個常數字串 */
export function legacyEncrypt(password: string, keyString: string, serverKey: string): string {
  const md5 = createHash('md5')
    .update(Buffer.from(keyString + serverKey, 'utf8'))
    .digest();
  return desCbcEncrypt(Buffer.from(password, 'utf8'), md5.subarray(0, 8), md5.subarray(8, 16)).toString('base64');
}
