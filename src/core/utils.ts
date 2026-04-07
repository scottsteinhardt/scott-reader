/**
 * Consolidated word count utility.
 * Handles HTML tag stripping and whitespace normalization.
 */
export function countWords(text: string | null | undefined): number {
  if (!text) return 0
  // Strip HTML tags, limit processing for very large inputs, 
  // and split by whitespace to count tokens.
  return text
    .slice(0, 50000)
    .replace(/<[^>]+>/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean).length
}

/**
 * MD5 implementation for environments without WebCrypto MD5 support (like Cloudflare Workers).
 * Pure-JS implementation of RFC 1321.
 * 
 * Algorithm overview:
 * 1. Append padding bits (0x80 followed by zeros)
 * 2. Append 64-bit length of original message
 * 3. Process message in 512-bit (64-byte) blocks
 * 4. Use 4 auxiliary functions (F, G, H, I) and 64 constants (K)
 */
export function md5(str: string): string {
  const utf8 = new TextEncoder().encode(str)
  const len = utf8.length
  // Message must be a multiple of 512 bits (64 bytes) after padding
  const msgLen = Math.ceil((len + 9) / 64) * 64
  const msg = new Uint8Array(msgLen)
  msg.set(utf8)
  
  // 1. Append padding: 0x80 bit (10000000) then zeros
  msg[len] = 0x80
  
  // 2. Append length in bits as 64-bit little-endian
  const lb = len * 8
  msg[msgLen - 8] = lb & 0xff
  msg[msgLen - 7] = (lb >>> 8) & 0xff
  msg[msgLen - 6] = (lb >>> 16) & 0xff
  msg[msgLen - 5] = (lb >>> 24) & 0xff

  // Initial MD Buffer (RFC 1321 Section 3.3)
  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476

  // Step 4. Processing in 512-bit blocks (RFC 1321 Section 3.4)
  // Constants K[i] = floor(abs(sin(i+1)) * 2^32)
  // prettier-ignore
  const K = [
    0xd76aa478,0xe8c7b756,0x242070db,0xc1bdceee,0xf57c0faf,0x4787c62a,0xa8304613,0xfd469501,
    0x698098d8,0x8b44f7af,0xffff5bb1,0x895cd7be,0x6b901122,0xfd987193,0xa679438e,0x49b40821,
    0xf61e2562,0xc040b340,0x265e5a51,0xe9b6c7aa,0xd62f105d,0x02441453,0xd8a1e681,0xe7d3fbc8,
    0x21e1cde6,0xc33707d6,0xf4d50d87,0x455a14ed,0xa9e3e905,0xfcefa3f8,0x676f02d9,0x8d2a4c8a,
    0xfffa3942,0x8771f681,0x6d9d6122,0xfde5380c,0xa4beea44,0x4bdecfa9,0xf6bb4b60,0xbebfbc70,
    0x289b7ec6,0xeaa127fa,0xd4ef3085,0x04881d05,0xd9d4d039,0xe6db99e5,0x1fa27cf8,0xc4ac5665,
    0xf4292244,0x432aff97,0xab9423a7,0xfc93a039,0x655b59c3,0x8f0ccc92,0xffeff47d,0x85845dd1,
    0x6fa87e4f,0xfe2ce6e0,0xa3014314,0x4e0811a1,0xf7537e82,0xbd3af235,0x2ad7d2bb,0xeb86d391,
  ]
  const S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21]
  const add = (x: number, y: number) => (x + y) | 0
  const rotl = (x: number, n: number) => (x << n) | (x >>> (32 - n))

  for (let i = 0; i < msgLen; i += 64) {
    const M: number[] = []
    // Convert block to sixteen 32-bit words
    for (let j = 0; j < 16; j++) {
      M.push(msg[i+j*4]! | (msg[i+j*4+1]! << 8) | (msg[i+j*4+2]! << 16) | (msg[i+j*4+3]! << 24))
    }
    let a = a0, b = b0, c = c0, d = d0
    for (let j = 0; j < 64; j++) {
      let F: number, g: number
      // Auxiliary functions
      if (j < 16)      { F = (b & c) | (~b & d); g = j }
      else if (j < 32) { F = (d & b) | (~d & c); g = (5 * j + 1) % 16 }
      else if (j < 48) { F = b ^ c ^ d;           g = (3 * j + 5) % 16 }
      else             { F = c ^ (b | ~d);         g = (7 * j) % 16 }
      const s = S[Math.floor(j / 16) * 4 + j % 4]!
      const t = add(add(add(a, F), M[g]!), K[j]!)
      a = d; d = c; c = b; b = add(b, rotl(t, s))
    }
    a0 = add(a0, a); b0 = add(b0, b); c0 = add(c0, c); d0 = add(d0, d)
  }

  // Final 128-bit digest as 32 hex characters
  const h32 = (n: number) =>
    Array.from({ length: 4 }, (_, i) => ((n >>> (i * 8)) & 0xff).toString(16).padStart(2, '0')).join('')
  return h32(a0) + h32(b0) + h32(c0) + h32(d0)
}
