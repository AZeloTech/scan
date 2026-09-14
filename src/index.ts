/**
 * `@azelotech/scan` — a document scanner as a React component.
 *
 * This module must stay free of side effects at import. Hosts mock it in their
 * test suites, and a static-export consumer will evaluate it during prerender,
 * where there is no `document`, no `navigator.mediaDevices` and no place to put
 * a Worker. Everything that touches the platform happens inside the component,
 * after mount. `scripts/check-dist.mjs` fails the build if that slips.
 */

export { ScanFlow } from "./ScanFlow";

export type {
  ScanFlowProps,
  ScanResult,
  ScanEvent,
  ScanStep,
  ScanQuality,
  ScanErrorCode,
  ScanCancelReason,
  ScanIntake,
  ScanLang,
} from "./types";
