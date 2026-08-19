export interface MeasurementReceipt {
  schemaVersion: number;
  runId: string;
  rootFingerprint: string;
  language: string;
  operationClass: string;
  startedAtMonotonicMs: number;
  finishedAtMonotonicMs: number;
  connectionDurationMs: number;
  childLifetimeMs: number | null;
  initializationDurationMs: number | null;
  requestLatencyMs: number | null;
  bridgePid: number | null;
  ownedChildPid: number | null;
  bridgeOwnedCpuMs: number | null;
  bridgeOwnedMemoryBytes: number | null;
  restartCount: number | null;
  recoveryFailures: number | null;
  controlState: string;
  reasonCodes: string[];
  outcome: string;
}

export interface MeasurementBridge {
  pid: number;
  run?: () => Promise<Record<string, number | null>>;
  close?: () => void | Promise<void | Record<string, number | null>>;
  waitForExit?: (timeoutMs?: number) => Promise<boolean>;
  forceClose?: (expectedIdentity: unknown, inspector: unknown) => boolean | Promise<boolean>;
  metrics?: () => Record<string, number | null> | Promise<Record<string, number | null>>;
}

export interface MaterializedBridge extends MeasurementBridge {
  run: () => Promise<Record<string, number | null>>;
  close: () => void | Promise<void | Record<string, number | null>>;
  waitForExit: (timeoutMs?: number) => Promise<boolean>;
  forceClose: (expectedIdentity: unknown, inspector: unknown) => boolean | Promise<boolean>;
  metrics: () => Record<string, number | null> | Promise<Record<string, number | null>>;
}

export interface MeasurementOptions {
  root?: string;
  tempRoot?: string;
  language?: string;
  operationClass?: string;
  controlState?: string;
  controlObserved?: boolean;
  controlSimultaneous?: boolean;
  workload?: boolean;
  r21Outcome?: string;
  launchRecord?: unknown;
  launchRecordPath?: string;
  randomBytesImpl?: (size: number) => Buffer;
  clock?: { now: () => number };
  launcher?: (record: unknown, context: Record<string, unknown>) => Promise<MeasurementBridge>;
  processInspector?: {
    snapshot: (pid: number, context: { phase?: string }) => Promise<Record<string, unknown>>;
  };
}

export const measurementReceiptKeys: string[];

export class MeasurementHarnessError extends Error {
  code: string;
  constructor(code: string, message?: string);
}

export function runMeasurement(options?: MeasurementOptions): Promise<MeasurementReceipt>;
export function validateReceipt(receipt: MeasurementReceipt): MeasurementReceipt;
export function createDefaultProcessInspector(): {
  snapshot: (pid: number) => Promise<Record<string, unknown>>;
};
export function launchMaterializedBridge(record: unknown, context: Record<string, unknown>): Promise<MaterializedBridge>;
