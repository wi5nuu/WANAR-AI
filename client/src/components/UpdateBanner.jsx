import { useEffect } from 'react';
import { hardRefresh, cleanRefreshParam, useVersionWatcher } from '../lib/refresh.js';

/** Appears when the server has a newer build than the one this tab loaded. */
export default function UpdateBanner() {
  const { updateAvailable, dismiss } = useVersionWatcher();
  useEffect(() => { cleanRefreshParam(); }, []);
  if (!updateAvailable) return null;
  return (
    <div className="update-banner" role="status" aria-live="polite">
      <span>Versi baru tersedia.</span>
      <button type="button" className="update-banner-btn" onClick={hardRefresh}>Muat ulang</button>
      <button type="button" className="update-banner-x" onClick={dismiss} aria-label="Tutup">Nanti</button>
    </div>
  );
}
