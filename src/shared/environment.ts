function logEnv(step: string, details?: Record<string, unknown>): void {
  console.log('[Environment]', step, details ?? {});
}

export type EnvironmentChoice = 'production' | 'staging' | 'qa' | 'custom';
export type EnvironmentKind = 'local' | 'shared';

export interface EnvironmentOption {
  value: EnvironmentChoice;
  label: string;
}

export interface UrlEnvironmentInfo {
  hostname: string | null;
  isLocalEnvironment: boolean;
}

export interface EnvironmentContext extends UrlEnvironmentInfo {
  kind: EnvironmentKind;
  label: string;
}

export const LOCAL_ENV_HOSTS = new Set(['localhost', '127.0.0.1']);

export const environmentOptions: EnvironmentOption[] = [
  { value: 'production', label: 'Production' },
  { value: 'staging', label: 'Staging' },
  { value: 'qa', label: 'QA' },
  { value: 'custom', label: 'Custom Label' },
];

export function getUrlEnvironmentInfo(url: string | null): UrlEnvironmentInfo {
  if (!url) {
    return {
      hostname: null,
      isLocalEnvironment: false,
    };
  }

  try {
    const parsed = new URL(url);
    return {
      hostname: parsed.hostname,
      isLocalEnvironment: LOCAL_ENV_HOSTS.has(parsed.hostname),
    };
  } catch (err) {
    logEnv('url-parse:failed', {
      url,
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      hostname: null,
      isLocalEnvironment: false,
    };
  }
}

export function resolveEnvironmentContext(
  url: string | null,
  selectedEnvironment: EnvironmentChoice,
  customEnvironmentLabel: string
): EnvironmentContext {
  const info = getUrlEnvironmentInfo(url);

  if (info.isLocalEnvironment) {
    return {
      ...info,
      kind: 'local',
      label: 'local',
    };
  }

  return {
    ...info,
    kind: 'shared',
    label:
      selectedEnvironment === 'custom'
        ? customEnvironmentLabel.trim()
        : selectedEnvironment,
  };
}
