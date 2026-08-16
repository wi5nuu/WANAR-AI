import { useState, useEffect, useCallback } from 'react';

const PROVIDER_MAP = {
  openagentic: { label: 'OpenAgentic', key: 'openagentic', hasRoute: false },
  nvidia:      { label: 'NVIDIA',      key: 'nvidia',      hasRoute: false },
  puter:       { label: 'Puter.js',    key: 'puter',       hasRoute: false },
  vector:      { label: 'VectorEngine',key: 'vector',      hasRoute: false },
};

export function useConfig() {
  const [config, setConfig] = useState(null);
  const [usage, setUsage] = useState(null);
  const [provider, setProvider] = useState(
    () => localStorage.getItem('wanar_provider') || 'openagentic'
  );
  const [model, setModel] = useState(
    () => localStorage.getItem('wanar_model') || ''
  );
  const [route, setRoute] = useState('');

  const load = useCallback(async () => {
    try {
      const [cr, tr] = await Promise.all([
        fetch('/api/config'),
        fetch('/api/token-usage'),
      ]);
      setConfig(await cr.json());
      setUsage(await tr.json());
    } catch (e) {}
  }, []);

  useEffect(() => { load(); }, [load]);

  // Auto-select default model when provider or config changes
  useEffect(() => {
    if (!config) return;
    const info = PROVIDER_MAP[provider];
    if (!info) return;
    const cfg = config[info.key];
    if (!cfg) return;
    const ids = cfg.models.map(m => m.id || m);
    if (!ids.includes(model)) {
      const defaultModel = cfg.defaultModel || ids[0] || '';
      setModel(defaultModel);
      localStorage.setItem('wanar_model', defaultModel);
    }
  }, [config, provider]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSetProvider = useCallback((p) => {
    setProvider(p);
    localStorage.setItem('wanar_provider', p);
  }, []);

  const handleSetModel = useCallback((m) => {
    setModel(m);
    localStorage.setItem('wanar_model', m);
  }, []);

  const providerInfo = PROVIDER_MAP[provider] || PROVIDER_MAP.openagentic;
  const providerConfig = config ? config[providerInfo.key] : null;

  return {
    config,
    usage,
    provider,
    setProvider: handleSetProvider,
    model,
    setModel: handleSetModel,
    route,
    setRoute,
    loadConfig: load,
    providerInfo,
    providerConfig,
    PROVIDER_MAP,
  };
}
