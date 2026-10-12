/**
 * src/automation/runtime.js
 *
 * Process-wide handle to the automation module, so agent tools (which only
 * receive `(name, args)`) can reach the same scheduler/engine the web server
 * runs. The server calls `initAutomation()` once at boot.
 *
 * @author Wisnu Alfian Nur Ashar
 */

import { createAutomation } from './index.js';

let instance = null;

export function initAutomation(deps) {
  if (!instance) instance = createAutomation(deps);
  return instance;
}

export function getAutomation() {
  return instance;
}

/** Test helper. */
export function _resetAutomation() {
  instance?.scheduler?.stop();
  instance = null;
}
