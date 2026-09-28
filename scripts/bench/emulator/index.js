/**
 * The scene emulator's public surface.
 *
 * Importing it registers every material, document, effect, family and
 * session. A new one is one import line below; the bench app and the runner
 * discover them through {@link familyIds} / {@link sessionIds} and never change.
 */

import "./materials.js";
import "./documents.js";
import "./effects.js";
import "./family-f1.js";
import "./family-f2.js";
import "./family-f3.js";
import "./family-f4.js";
import "./family-f5.js";
import "./family-f6.js";
import "./family-f7.js";
import "./session.js";

export {
  applyEffects,
  buildFrame,
  buildScene,
  calibrationParams,
  cameras,
  describeFamilies,
  familyIds,
  FRAME_SIZES,
  frameSize,
  groundTruth,
  projectContent,
  referenceCamera,
  registerEffect,
  registerFamily,
  SceneMaker,
  withContent,
} from "./scene.js";
export { documentContent, documentTypes, registerDocument } from "./documents.js";
export { materialNames, registerMaterial } from "./materials.js";
export {
  buildSession,
  describeSessions,
  loopedFrame,
  loopedTime,
  poseAt,
  registerSession,
  renderedFrameCount,
  SESSION_FRAME_MS,
  sessionAt,
  sessionIds,
  sessionTruth,
  stillGeometry,
  tremorAt,
  tremorModel,
} from "./session.js";
export { previewFocal, SessionRenderer } from "./stream.js";
