/**
 * Message types for extension communication
 */

export enum MessageType {
  // Test control
  START_TEST = 'START_TEST',
  STOP_TEST = 'STOP_TEST',
  PAUSE_TEST = 'PAUSE_TEST',
  RESUME_TEST = 'RESUME_TEST',

  // Page analysis
  ANALYZE_PAGE = 'ANALYZE_PAGE',
  PAGE_CONTENT = 'PAGE_CONTENT',

  // Test execution
  EXECUTE_ACTION = 'EXECUTE_ACTION',
  ACTION_RESULT = 'ACTION_RESULT',
  CAPTURE_SCREENSHOT = 'CAPTURE_SCREENSHOT',
  SCREENSHOT_CAPTURED = 'SCREENSHOT_CAPTURED',

  // Status updates
  TEST_STATUS = 'TEST_STATUS',
  TEST_COMPLETE = 'TEST_COMPLETE',
  ISSUE_DETECTED = 'ISSUE_DETECTED',

  // Error handling
  ERROR = 'ERROR',
}

export enum MessageTarget {
  BACKGROUND = 'BACKGROUND',
  CONTENT_SCRIPT = 'CONTENT_SCRIPT',
  POPUP = 'POPUP',
}

export interface BaseMessage {
  id: string;
  type: MessageType;
  target: MessageTarget;
  timestamp: number;
}

export interface StartTestMessage extends BaseMessage {
  type: MessageType.START_TEST;
  payload: {
    url: string;
    configId?: string;
  };
}

export interface AnalyzePageMessage extends BaseMessage {
  type: MessageType.ANALYZE_PAGE;
  payload: {
    testRunId: string;
    stepNumber: number;
  };
}

export interface PageContentMessage extends BaseMessage {
  type: MessageType.PAGE_CONTENT;
  payload: {
    url: string;
    title: string;
    html: string;
    screenshot?: string;
    consoleErrors: string[];
    networkErrors: string[];
  };
}

export interface ExecuteActionMessage extends BaseMessage {
  type: MessageType.EXECUTE_ACTION;
  payload: {
    actionType: 'click' | 'type' | 'select' | 'navigate' | 'scroll' | 'wait';
    selector?: string;
    value?: string;
    description: string;
  };
}

export interface ActionResultMessage extends BaseMessage {
  type: MessageType.ACTION_RESULT;
  payload: {
    success: boolean;
    error?: string;
    screenshot?: string;
  };
}

export interface IssueDetectedMessage extends BaseMessage {
  type: MessageType.ISSUE_DETECTED;
  payload: {
    type: 'console_error' | 'network_error' | 'blank_screen' | 'ui_anomaly';
    severity: 'low' | 'medium' | 'high' | 'critical';
    title: string;
    description: string;
    screenshot?: string;
    metadata?: Record<string, unknown>;
  };
}

export type ExtensionMessage =
  | StartTestMessage
  | AnalyzePageMessage
  | PageContentMessage
  | ExecuteActionMessage
  | ActionResultMessage
  | IssueDetectedMessage;

/**
 * Generate unique message ID
 */
export function generateMessageId(): string {
  return `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

/**
 * Create a message with common fields
 */
export function createMessage<T extends ExtensionMessage>(
  type: T['type'],
  target: MessageTarget,
  payload: T['payload']
): T {
  return {
    id: generateMessageId(),
    type,
    target,
    timestamp: Date.now(),
    payload,
  } as T;
}
