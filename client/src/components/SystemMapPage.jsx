/**
 * Peta Sistem — the live 3D map as a full page (edge to edge, any desktop size).
 * by Wisnu Alfian Nur Ashar
 */

import { useState } from 'react';
import DashboardLayout from './DashboardLayout';
import SystemMap from './systemmap/SystemMap';
import './systemmap/systemmap.css';

export default function SystemMapPage() {
  const [mode, setMode] = useState('simple');
  const [demoTick, setDemoTick] = useState(0);
  return (
    <DashboardLayout>
      <div className="sm-page">
        <div className="sm-page-bar">
          <div>
            <h1>Peta Sistem</h1>
            <p>Setiap pesan dari semua kanal, jalur modelnya, alasannya, dan sisa kuota — realtime.</p>
          </div>
          <div className="sm-page-actions">
            <span className="af-view-tabs" role="tablist" aria-label="Mode tampilan">
              <button role="tab" aria-selected={mode === 'simple'} className={mode === 'simple' ? 'on' : ''} onClick={() => setMode('simple')}>Mode Dasar</button>
              <button role="tab" aria-selected={mode === 'tech'} className={mode === 'tech' ? 'on' : ''} onClick={() => setMode('tech')}>Mode Teknis</button>
            </span>
            <button type="button" className="sm-hud-btn solid" onClick={() => setDemoTick((n) => n + 1)}>▶ Simulasi Demo</button>
          </div>
        </div>
        <div className="sm-page-body">
          <SystemMap mode={mode} demoTick={demoTick} />
        </div>
      </div>
    </DashboardLayout>
  );
}
