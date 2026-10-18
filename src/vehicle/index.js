/**
 * src/vehicle/index.js
 *
 * Composition root + process-wide handle for motorcycle care.
 *
 * @author Wisnu Alfian Nur Ashar
 */

import { createVehicleStore } from './store.js';
import { VehicleService } from './service.js';

let instance = null;

/**
 * @param {object} deps
 * @param {object} deps.db
 * @param {object} [deps.location]  location module ({ store, service }) for GPS comparisons
 * @param {Function} [deps.now]
 * @param {object} [deps.env]
 * @param {Function} [deps.deliver]
 * @param {Function} [deps.memory]
 */
export function createVehicle({ db, location = null, now = () => Date.now(), env = process.env, deliver = null, memory = null }) {
  const store = createVehicleStore(db);
  const service = new VehicleService({ store, location: location?.service || null, now, env, deliver, memory });
  return { store, service };
}

export function initVehicle(deps) {
  if (!instance) instance = createVehicle(deps);
  return instance;
}

export function getVehicle() {
  return instance;
}

export function _resetVehicle() {
  instance?.service?.stop();
  instance = null;
}
