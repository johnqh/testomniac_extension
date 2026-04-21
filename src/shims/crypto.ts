/**
 * Browser shim for node:crypto.
 * Provides createHash using Web Crypto API for compatibility with
 * scanning service modules that import from node:crypto.
 */

class BrowserHash {
  private data: Uint8Array[] = [];

  constructor(_algorithm: string) {
    // Algorithm parameter accepted for API compatibility but not used in shim
  }

  update(input: string): this {
    this.data.push(new TextEncoder().encode(input));
    return this;
  }

  digest(encoding: 'hex'): string {
    // Synchronous fallback: use a simple hash for build compatibility.
    // The extension's own code uses SubtleCrypto (async) for actual hashing.
    // This shim only exists so the unused page-utils code doesn't crash at import time.
    let hash = 0;
    for (const chunk of this.data) {
      for (let i = 0; i < chunk.length; i++) {
        hash = ((hash << 5) - hash + chunk[i]) | 0;
      }
    }
    if (encoding === 'hex') {
      return Math.abs(hash).toString(16).padStart(16, '0');
    }
    return String(hash);
  }
}

export function createHash(algorithm: string): BrowserHash {
  return new BrowserHash(algorithm);
}
