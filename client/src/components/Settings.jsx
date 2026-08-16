/**
 * Settings Component - Enterprise v2.0
 * by Wisnu Alfian Nur Ashar
 */

import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import DashboardLayout from './DashboardLayout';

const inputStyle = {
  width: '100%',
  padding: '10px 12px',
  fontSize: '14px',
  border: '1px solid var(--border-primary)',
  borderRadius: 'var(--radius-md)',
  background: 'var(--bg-tertiary)',
  color: 'var(--text-primary)',
  outline: 'none',
  fontFamily: 'inherit',
  transition: 'border-color var(--transition-fast)',
};

const labelStyle = {
  fontSize: '13px',
  fontWeight: '600',
  color: 'var(--text-secondary)',
  marginBottom: '6px',
  display: 'block',
};

export default function Settings() {
  const navigate = useNavigate();
  const [providers, setProviders] = useState({});
  const [msg, setMsg] = useState(null);
  const [pname, setPname] = useState('');
  const [plabel, setPlabel] = useState('');
  const [purl, setPurl] = useState('');
  const [pkey, setPkey] = useState('');
  const [pformat, setPformat] = useState('openai');
  const [ptestModel, setPtestModel] = useState('');
  const [testing, setTesting] = useState(false);
  const [mProvider, setMProvider] = useState('');
  const [mModel, setMModel] = useState('');
  const [mFamily, setMFamily] = useState('');
  const [mValidating, setMValidating] = useState(false);

  const loadProviders = useCallback(async () => {
    try {
      const r = await fetch('/api/providers');
      const d = await r.json();
      setProviders(d.providers || {});
    } catch {}
  }, []);

  useEffect(() => { loadProviders(); }, [loadProviders]);

  const testProvider = async () => {
    if (!pname || !purl || !pkey || !ptestModel) {
      setMsg({ type: 'error', text: 'Please fill all required fields' });
      return;
    }
    setTesting(true);
    setMsg(null);
    try {
      const r = await fetch('/api/providers/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: pname, baseUrl: purl, apiKey: pkey, format: pformat, testModel: ptestModel }),
      });
      const d = await r.json();
      if (d.success) {
        setMsg({ type: 'success', text: d.message || 'Connection successful!' });
        const addR = await fetch('/api/providers', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: pname, label: plabel || pname, baseUrl: purl, apiKey: pkey, format: pformat }),
        });
        const addD = await addR.json();
        if (addD.success) {
          setPname(''); setPlabel(''); setPurl(''); setPkey(''); setPtestModel('');
          loadProviders();
        } else {
          setMsg({ type: 'error', text: addD.error || 'Failed to add provider' });
        }
      } else {
        setMsg({ type: 'error', text: d.error || 'Connection failed' });
      }
    } catch (e) {
      setMsg({ type: 'error', text: e.message });
    } finally {
      setTesting(false);
    }
  };

  const validateModel = async () => {
    if (!mProvider || !mModel) {
      setMsg({ type: 'error', text: 'Please select a provider and enter a model ID' });
      return;
    }
    setMValidating(true);
    setMsg(null);
    try {
      const r = await fetch('/api/providers/validate-model', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ providerName: mProvider, modelId: mModel }),
      });
      const d = await r.json();
      if (d.success) {
        const addR = await fetch('/api/providers/model', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ providerName: mProvider, modelId: mModel, family: mFamily || undefined }),
        });
        const addD = await addR.json();
        if (addD.success) {
          setMsg({ type: 'success', text: `Model ${mModel} added successfully!` });
          setMModel(''); setMFamily('');
          loadProviders();
        } else {
          setMsg({ type: 'error', text: addD.error || 'Failed to add model' });
        }
      } else {
        setMsg({ type: 'error', text: d.error || 'Model validation failed' });
      }
    } catch (e) {
      setMsg({ type: 'error', text: e.message });
    } finally {
      setMValidating(false);
    }
  };

  const removeModel = async (providerName, modelId) => {
    try {
      await fetch(`/api/providers/${providerName}/model/${encodeURIComponent(modelId)}`, { method: 'DELETE' });
      loadProviders();
    } catch {}
  };

  const pKeys = Object.keys(providers);

  return (
    <DashboardLayout>
      <div style={{ padding: '20px', maxWidth: '1200px', margin: '0 auto', width: '100%' }}>
        {/* Header with Icon */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '16px' }}>
          <span style={{ fontSize: '24px' }}>⚙️</span>
          <h1 style={{ fontSize: '20px', fontWeight: '600', color: 'var(--text-primary)', margin: 0 }}>Settings</h1>
        </div>

        {/* Alert */}
        {msg && (
          <div style={{
            padding: '10px 14px',
            borderRadius: '8px',
            marginBottom: '16px',
            fontSize: '13px',
            fontWeight: '500',
            background: msg.type === 'success' ? 'var(--success-bg)' : 'var(--error-bg)',
            color: msg.type === 'success' ? 'var(--success)' : 'var(--error)',
            border: `1px solid ${msg.type === 'success' ? 'var(--success)' : 'var(--error)'}`,
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
          }}>
            {msg.type === 'success' ? '✓' : '✕'} {msg.text}
          </div>
        )}

        {/* Add Provider Section */}
        <div style={{
          background: 'var(--bg-secondary)',
          border: '1px solid var(--border-primary)',
          borderRadius: '12px',
          padding: '18px',
          marginBottom: '16px',
          boxShadow: 'var(--shadow-sm)',
        }}>
          <h2 style={{ fontSize: '16px', fontWeight: '600', color: 'var(--text-primary)', marginBottom: '6px' }}>
            Add New Provider
          </h2>
          <p style={{ fontSize: '13px', color: 'var(--text-secondary)', marginBottom: '16px' }}>
            Connect a custom AI provider with an OpenAI-compatible API.
          </p>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginBottom: '12px' }}>
            <div>
              <label style={labelStyle}>Provider Name *</label>
              <input style={inputStyle} placeholder="e.g. my-provider" value={pname} onChange={e => setPname(e.target.value)}
                onFocus={e => e.target.style.borderColor = 'var(--brand-primary)'}
                onBlur={e => e.target.style.borderColor = 'var(--border-primary)'} />
            </div>
            <div>
              <label style={labelStyle}>Display Label</label>
              <input style={inputStyle} placeholder="e.g. My Provider" value={plabel} onChange={e => setPlabel(e.target.value)}
                onFocus={e => e.target.style.borderColor = 'var(--brand-primary)'}
                onBlur={e => e.target.style.borderColor = 'var(--border-primary)'} />
            </div>
          </div>

          <div style={{ marginBottom: '12px' }}>
            <label style={labelStyle}>Base URL *</label>
            <input style={inputStyle} placeholder="https://api.example.com/v1" value={purl} onChange={e => setPurl(e.target.value)}
              onFocus={e => e.target.style.borderColor = 'var(--brand-primary)'}
              onBlur={e => e.target.style.borderColor = 'var(--border-primary)'} />
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginBottom: '12px' }}>
            <div>
              <label style={labelStyle}>API Key *</label>
              <input style={inputStyle} type="password" placeholder="sk-..." value={pkey} onChange={e => setPkey(e.target.value)}
                onFocus={e => e.target.style.borderColor = 'var(--brand-primary)'}
                onBlur={e => e.target.style.borderColor = 'var(--border-primary)'} />
            </div>
            <div>
              <label style={labelStyle}>Test Model *</label>
              <input style={inputStyle} placeholder="e.g. gpt-4o-mini" value={ptestModel} onChange={e => setPtestModel(e.target.value)}
                onFocus={e => e.target.style.borderColor = 'var(--brand-primary)'}
                onBlur={e => e.target.style.borderColor = 'var(--border-primary)'} />
            </div>
          </div>

          <div style={{ marginBottom: '16px' }}>
            <label style={labelStyle}>Format</label>
            <select style={{ ...inputStyle, cursor: 'pointer' }} value={pformat} onChange={e => setPformat(e.target.value)}>
              <option value="openai">OpenAI Compatible</option>
              <option value="anthropic">Anthropic</option>
              <option value="google">Google</option>
            </select>
          </div>

          <button
            onClick={testProvider}
            disabled={testing}
            style={{
              padding: '8px 20px',
              background: testing ? 'var(--bg-tertiary)' : 'var(--brand-gradient)',
              color: testing ? 'var(--text-secondary)' : 'white',
              border: 'none',
              borderRadius: '8px',
              fontSize: '13px',
              fontWeight: '600',
              cursor: testing ? 'not-allowed' : 'pointer',
              transition: 'all var(--transition-fast)',
              boxShadow: testing ? 'none' : 'var(--shadow-sm)',
            }}
          >
            {testing ? 'Testing connection...' : 'Test & Add Provider'}
          </button>
        </div>

        {/* Existing Providers */}
        {pKeys.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            <h2 style={{ fontSize: '16px', fontWeight: '600', color: 'var(--text-primary)' }}>
              Configured Providers
            </h2>

            {pKeys.map(k => {
              const p = providers[k];
              return (
                <div key={k} style={{
                  background: 'var(--bg-secondary)',
                  border: '1px solid var(--border-primary)',
                  borderRadius: '12px',
                  padding: '16px',
                  boxShadow: 'var(--shadow-sm)',
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px', flexWrap: 'wrap', gap: '8px' }}>
                    <div>
                      <div style={{ fontSize: '15px', fontWeight: '600', color: 'var(--text-primary)' }}>{p.label || k}</div>
                      <div style={{ fontSize: '12px', color: 'var(--text-tertiary)', marginTop: '2px' }}>{p.baseUrl}</div>
                    </div>
                    <span style={{
                      fontSize: '11px',
                      fontWeight: '600',
                      color: 'var(--success)',
                      background: 'var(--success-bg)',
                      padding: '3px 10px',
                      borderRadius: '12px',
                      border: '1px solid var(--success)',
                    }}>
                      Active
                    </span>
                  </div>

                  {/* Models */}
                  {(p.models || []).length > 0 && (
                    <div style={{ marginBottom: '12px' }}>
                      <div style={{ fontSize: '11px', fontWeight: '600', color: 'var(--text-tertiary)', marginBottom: '8px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                        Models ({(p.models || []).length})
                      </div>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                        {(p.models || []).map(m => (
                          <span key={m.id || m} style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: '4px',
                            fontSize: '12px',
                            fontWeight: '500',
                            color: 'var(--text-secondary)',
                            background: 'var(--bg-tertiary)',
                            border: '1px solid var(--border-secondary)',
                            padding: '3px 10px',
                            borderRadius: 'var(--radius-full)',
                          }}>
                            {m.id || m}
                            <button
                              onClick={() => removeModel(k, m.id || m)}
                              style={{
                                background: 'none',
                                border: 'none',
                                cursor: 'pointer',
                                color: 'var(--text-tertiary)',
                                fontSize: '14px',
                                lineHeight: 1,
                                padding: '0 0 0 2px',
                              }}
                              onMouseEnter={e => e.currentTarget.style.color = 'var(--error)'}
                              onMouseLeave={e => e.currentTarget.style.color = 'var(--text-tertiary)'}
                            >
                              &times;
                            </button>
                          </span>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Add Model Form */}
                  <div style={{
                    borderTop: '1px solid var(--border-secondary)',
                    paddingTop: '12px',
                    display: 'flex',
                    gap: '8px',
                    flexWrap: 'wrap',
                    alignItems: 'flex-end'
                  }}>
                    <div style={{ flex: '1 1 150px' }}>
                      <label style={{ ...labelStyle, fontSize: '11px' }}>Model ID</label>
                      <input
                        style={{ ...inputStyle, padding: '7px 10px', fontSize: '13px' }}
                        placeholder="e.g. gpt-4o"
                        value={mProvider === k ? mModel : ''}
                        onChange={e => { setMProvider(k); setMModel(e.target.value); }}
                        onFocus={e => e.target.style.borderColor = 'var(--brand-primary)'}
                        onBlur={e => e.target.style.borderColor = 'var(--border-primary)'}
                      />
                    </div>
                    <div style={{ flex: '1 1 120px' }}>
                      <label style={{ ...labelStyle, fontSize: '11px' }}>Family (optional)</label>
                      <input
                        style={{ ...inputStyle, padding: '7px 10px', fontSize: '13px' }}
                        placeholder="e.g. OpenAI"
                        value={mProvider === k ? mFamily : ''}
                        onChange={e => { setMProvider(k); setMFamily(e.target.value); }}
                        onFocus={e => e.target.style.borderColor = 'var(--brand-primary)'}
                        onBlur={e => e.target.style.borderColor = 'var(--border-primary)'}
                      />
                    </div>
                    <button
                      onClick={() => { setMProvider(k); validateModel(); }}
                      disabled={mValidating}
                      style={{
                        padding: '8px 14px',
                        background: 'var(--bg-tertiary)',
                        border: '1px solid var(--border-primary)',
                        borderRadius: '8px',
                        color: 'var(--text-secondary)',
                        fontSize: '13px',
                        fontWeight: '600',
                        cursor: mValidating ? 'not-allowed' : 'pointer',
                        transition: 'all var(--transition-fast)',
                        whiteSpace: 'nowrap',
                      }}
                      onMouseEnter={e => { if (!mValidating) { e.currentTarget.style.background = 'var(--brand-gradient)'; e.currentTarget.style.color = 'white'; e.currentTarget.style.borderColor = 'transparent'; } }}
                      onMouseLeave={e => { e.currentTarget.style.background = 'var(--bg-tertiary)'; e.currentTarget.style.color = 'var(--text-secondary)'; e.currentTarget.style.borderColor = 'var(--border-primary)'; }}
                    >
                      {mValidating ? 'Validating...' : '+ Add Model'}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {pKeys.length === 0 && (
          <div style={{
            textAlign: 'center',
            color: 'var(--text-tertiary)',
            fontSize: '13px',
            padding: '24px',
            background: 'var(--bg-secondary)',
            borderRadius: '12px',
            border: '1px dashed var(--border-primary)',
          }}>
            No custom providers added yet. Add one above to get started.
          </div>
        )}
      </div>
    </DashboardLayout>
  );
}
