/**
 * src/location/index.js
 *
 * Composition root + process-wide handle for the tracking module, following the
 * same shape as worklog/automation: create*, init*, get*, _reset*.
 *
 * @author Wisnu Alfian Nur Ashar
 */

import { createLocationStore } from './store.js';
import { LocationService } from './service.js';
import { createGeocoder } from './geocode.js';

let instance = null;

/**
 * @param {object} deps
 * @param {object} deps.db
 * @param {object} [deps.env]
 * @param {Function} [deps.now]
 * @param {Function} [deps.deliver]   async ({kind, text, priority}) => {channel, ok, error}
 * @param {Function} [deps.memory]    hook into personal memory
 * @param {Function} [deps.fetchImpl] for tests
 */
export function createLocation({ db, env = process.env, now = () => Date.now(), deliver = null, memory = null, fetchImpl = globalThis.fetch, log = () => {} }) {
  const store = createLocationStore(db);
  const geocodeEnabled = String(env.LOCATION_GEOCODE || 'on').toLowerCase() !== 'off';
  const geocoder = geocodeEnabled
    ? createGeocoder({
      store,
      settings: () => store.settings.get(),
      fetchImpl,
      now,
      env,
      log,
    })
    : null;
  const service = new LocationService({ store, geocoder, now, env, deliver, memory });
  return { store, service, geocoder };
}

export function initLocation(deps) {
  if (!instance) instance = createLocation(deps);
  return instance;
}

export function getLocation() {
  return instance;
}

export function _resetLocation() {
  instance?.service?.stop();
  instance = null;
}
