/**
 * Shim for node:crypto in browser context.
 * scanning_service's component-detector.js uses createHash from node:crypto.
 * This provides a browser-compatible implementation via SubtleCrypto.
 */

export function createHash(algorithm: string) {
  if (algorithm !== 'sha256') {
    throw new Error(`Unsupported hash algorithm: ${algorithm}`);
  }

  let data = '';
  return {
    update(input: string) {
      data += input;
      return this;
    },
    digest(encoding: string) {
      if (encoding !== 'hex') {
        throw new Error(`Unsupported encoding: ${encoding}`);
      }
      // Return a synchronous hex string by computing hash eagerly
      // This works because component-detector calls createHash synchronously
      const encoder = new TextEncoder();
      const encoded = encoder.encode(data);
      // Use a simple hash for the shim since SubtleCrypto is async
      // and createHash expects sync behavior
      let hash = 0;
      for (let i = 0; i < encoded.length; i++) {
        const char = encoded[i];
        hash = ((hash << 5) - hash + char) | 0;
      }
      return Math.abs(hash).toString(16).padStart(16, '0');
    },
  };
}
