/**
 * src/memory/index.js
 *
 * Composition root + process-wide handle for personal memory (the small,
 * owner-controlled facts, separate from owner-context.js which is the live
 * system snapshot).
 *
 * @author Wisnu Alfian Nur Ashar
 */

import { createPersonalMemory } from './personal.js';

let instance = null;

export function createMemory({ db, now = () => Date.now() } = {}) {
  const service = createPersonalMemory({ db, now });
  return { store: service.store, service };
}

export function initMemory(deps) {
  if (!instance) instance = createMemory(deps);
  return instance;
}

export function getMemory() {
  return instance;
}

export function _resetMemory() {
  instance = null;
}
