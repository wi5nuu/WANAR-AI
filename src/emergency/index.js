/**
 * src/emergency/index.js
 *
 * Composition root + process-wide handle for the emergency module.
 *
 * @author Wisnu Alfian Nur Ashar
 */

import { createEmergencyStore } from './store.js';
import { EmergencyService } from './service.js';

let instance = null;

/**
 * @param {object} deps
 * @param {object} deps.db
 * @param {object} [deps.location]   location module ({ store, service })
 * @param {object} [deps.channels]   { telegram(chatId,text), whatsapp(phone,text), email({to,subject,text}), webhook(payload) }
 * @param {Function} [deps.ownerNotify]
 * @param {Function} [deps.now]
 * @param {object} [deps.env]
 * @param {Function} [deps.memory]
 */
export function createEmergency({ db, location = null, channels = {}, ownerNotify = null, now = () => Date.now(), env = process.env, memory = null, log = null }) {
  const store = createEmergencyStore(db);
  const service = new EmergencyService({ store, location: location?.service || null, channels, ownerNotify, now, env, memory, log });
  return { store, service };
}

export function initEmergency(deps) {
  if (!instance) instance = createEmergency(deps);
  return instance;
}

export function getEmergency() {
  return instance;
}

export function _resetEmergency() {
  instance?.service?.stop();
  instance = null;
}
