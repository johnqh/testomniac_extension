/**
 * Network Guard - Runtime Network Call Interceptor
 *
 * Defense-in-depth layer that monitors and logs network calls.
 * Works alongside CSP to provide visibility into potential security issues.
 */

const GUARD_WORKER_URL =
  import.meta.env.VITE_GUARD_WORKER_URL || 'https://guard-worker.testomniac.workers.dev';

const APP_NAME = 'testomniac_extension';

/**
 * Allowed domain patterns for network requests.
 */
const ALLOWED_DOMAINS = [
  // Local development
  'localhost',
  '127.0.0.1',
  '192.168.68.66', // LM Studio

  // Testomniac API
  'testomniac.io',
  'testomniac.workers.dev',

  // AI providers
  'anthropic.com',
] as const;

interface SecurityAlert {
  appName: string;
  type: 'unauthorized_fetch' | 'unauthorized_xhr' | 'unauthorized_websocket';
  url: string;
  hostname: string;
  timestamp: number;
  stack?: string;
  appVersion: string;
}

function isAllowedHost(hostname: string): boolean {
  return ALLOWED_DOMAINS.some(
    (domain) => hostname === domain || hostname.endsWith(`.${domain}`)
  );
}

function getReportEndpoint(): string {
  return `${GUARD_WORKER_URL}/alert`;
}

function reportViolation(alert: SecurityAlert): void {
  const endpoint = getReportEndpoint();

  if (typeof navigator !== 'undefined' && navigator.sendBeacon) {
    try {
      navigator.sendBeacon(endpoint, JSON.stringify(alert));
    } catch {
      console.error('[NetworkGuard] Failed to send beacon:', alert);
    }
  } else {
    fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(alert),
      keepalive: true,
    }).catch(() => {
      console.error('[NetworkGuard] Failed to report violation:', alert);
    });
  }
}

function createAlert(
  type: SecurityAlert['type'],
  url: string,
  hostname: string
): SecurityAlert {
  return {
    appName: APP_NAME,
    type,
    url,
    hostname,
    timestamp: Date.now(),
    stack: new Error().stack,
    appVersion: chrome?.runtime?.getManifest?.()?.version || 'unknown',
  };
}

function handleUnauthorizedCall(
  type: 'fetch' | 'xhr',
  url: string,
  hostname: string
): void {
  const alertType = type === 'fetch' ? 'unauthorized_fetch' : 'unauthorized_xhr';

  console.warn(
    `[NetworkGuard] Unauthorized ${type.toUpperCase()} to:`,
    { url, hostname }
  );

  reportViolation(createAlert(alertType, url, hostname));
}

/**
 * Initialize the network guard by overriding fetch and XMLHttpRequest.
 */
export function initNetworkGuard(): void {
  console.log('[NetworkGuard] Initializing network security monitor...');

  const originalFetch = globalThis.fetch;

  // Override fetch
  globalThis.fetch = function (
    input: RequestInfo | URL,
    init?: RequestInit
  ): Promise<Response> {
    try {
      const url = input instanceof Request ? input.url : input.toString();
      const parsedUrl = new URL(url, globalThis.location?.href || undefined);
      const hostname = parsedUrl.hostname;

      if (!isAllowedHost(hostname)) {
        handleUnauthorizedCall('fetch', url, hostname);
      }
    } catch (error) {
      console.warn('[NetworkGuard] Failed to parse URL:', error);
    }

    return originalFetch.apply(globalThis, [input, init]);
  };

  // Only override XMLHttpRequest if it exists (not available in service workers)
  if (typeof XMLHttpRequest !== 'undefined') {
    const OriginalXHR = globalThis.XMLHttpRequest;

    globalThis.XMLHttpRequest = class extends OriginalXHR {
      open(
        method: string,
        url: string | URL,
        async: boolean = true,
        username?: string | null,
        password?: string | null
      ): void {
        try {
          const urlString = url.toString();
          const parsedUrl = new URL(urlString, globalThis.location?.href || undefined);
          const hostname = parsedUrl.hostname;

          if (!isAllowedHost(hostname)) {
            handleUnauthorizedCall('xhr', urlString, hostname);
          }
        } catch (error) {
          console.warn('[NetworkGuard] Failed to parse XHR URL:', error);
        }

        super.open(method, url, async, username ?? undefined, password ?? undefined);
      }
    } as typeof XMLHttpRequest;

    Object.freeze(globalThis.XMLHttpRequest);
  }

  Object.freeze(globalThis.fetch);

  console.log('[NetworkGuard] Network security monitor initialized');
}

export const getAllowedDomains = (): readonly string[] => ALLOWED_DOMAINS;
