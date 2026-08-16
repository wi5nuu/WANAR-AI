/**
 * InputBar Component - Enterprise v2.0 with File Attachment
 * by Wisnu Alfian Nur Ashar
 */

import { useRef, useEffect, useState, useCallback } from 'react';

const ACCEPTED_TYPES = [
  'image/*',
  '.pdf', '.txt', '.md', '.csv', '.json', '.xml', '.yaml', '.yml',
  '.js', '.jsx', '.ts', '.tsx', '.py', '.java', '.cpp', '.c', '.cs',
  '.html', '.css', '.scss', '.sql', '.sh', '.bat', '.env',
  '.doc', '.docx', '.ppt', '.pptx', '.xls', '.xlsx',
  '.zip', '.tar', '.gz',
].join(',');

const MAX_FILES = 10;
const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20MB per file

function FileIcon({ type }) {
  if (type.startsWith('image/')) return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/>
      <polyline points="21 15 16 10 5 21"/>
    </svg>
  );
  if (type.includes('pdf')) return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>
    </svg>
  );
  if (type.includes('spreadsheet') || type.includes('excel') || type.includes('csv')) return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="16" y2="17"/>
    </svg>
  );
  if (type.includes('presentation') || type.includes('powerpoint')) return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/>
    </svg>
  );
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>
    </svg>
  );
}

function formatBytes(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

export default function InputBar({
  onSend,
  processing,
  onStop,
  route,
  onRouteChange,
  hasRoute,
  attachments,
  onAttachmentsChange,
  provider,
  model,
  providers,
  models,
  onProviderChange,
  onModelChange,
}) {
  const textareaRef = useRef(null);
  const fileInputRef = useRef(null);
  const modelPickerRef = useRef(null);
  const [inputValue, setInputValue] = useState('');
  const [dragOver, setDragOver] = useState(false);
  const [showModelPicker, setShowModelPicker] = useState(false);

  // Close popover when clicking outside
  useEffect(() => {
    if (!showModelPicker) return;
    const handler = (e) => {
      if (modelPickerRef.current && !modelPickerRef.current.contains(e.target)) {
        setShowModelPicker(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showModelPicker]);

  useEffect(() => { textareaRef.current?.focus(); }, []);
  useEffect(() => { if (!processing) textareaRef.current?.focus(); }, [processing]);

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (inputValue.trim() || (attachments && attachments.length > 0)) {
        onSend();
        setInputValue('');
        if (textareaRef.current) textareaRef.current.style.height = 'auto';
      }
    }
  };

  const handleInput = (e) => {
    setInputValue(e.target.value);
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 200) + 'px';
  };

  const handleSend = () => {
    if ((inputValue.trim() || (attachments && attachments.length > 0)) && !processing) {
      onSend();
      setInputValue('');
      if (textareaRef.current) textareaRef.current.style.height = 'auto';
    }
  };

  const addFiles = useCallback((files) => {
    const current = attachments || [];
    const newFiles = Array.from(files).filter(f => {
      if (f.size > MAX_FILE_SIZE) { alert(`File "${f.name}" terlalu besar. Maksimal 20MB.`); return false; }
      if (current.length >= MAX_FILES) { alert(`Maksimal ${MAX_FILES} file sekaligus.`); return false; }
      if (current.find(x => x.name === f.name && x.size === f.size)) return false;
      return true;
    });
    if (newFiles.length === 0) return;
    const updated = [...current, ...newFiles].slice(0, MAX_FILES);
    onAttachmentsChange?.(updated);
  }, [attachments, onAttachmentsChange]);

  const removeFile = (index) => {
    const updated = (attachments || []).filter((_, i) => i !== index);
    onAttachmentsChange?.(updated);
  };

  const handleFileInput = (e) => {
    addFiles(e.target.files);
    e.target.value = '';
  };

  const handleDragOver = (e) => { e.preventDefault(); setDragOver(true); };
  const handleDragLeave = (e) => { e.preventDefault(); setDragOver(false); };
  const handleDrop = (e) => {
    e.preventDefault();
    setDragOver(false);
    const files = [];
    if (e.dataTransfer.items) {
      for (const item of e.dataTransfer.items) {
        if (item.kind === 'file') files.push(item.getAsFile());
      }
    } else {
      for (const f of e.dataTransfer.files) files.push(f);
    }
    if (files.length) addFiles(files);
  };

  const handlePaste = (e) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    const files = [];
    for (const item of items) {
      if (item.kind === 'file') files.push(item.getAsFile());
    }
    if (files.length) addFiles(files);
  };

  const hasAttachments = attachments && attachments.length > 0;
  const canSend = (inputValue.trim() || hasAttachments) && !processing;

  return (
    <div
      className="input-container"
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      style={{ position: 'relative' }}
    >
      {/* Drag overlay */}
      {dragOver && (
        <div style={{
          position: 'absolute', inset: 0, zIndex: 10,
          background: 'var(--brand-primary-alpha, rgba(99,102,241,0.08))',
          border: '2px dashed var(--brand-primary)',
          borderRadius: '12px',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          pointerEvents: 'none',
        }}>
          <span style={{ color: 'var(--brand-primary)', fontWeight: 600, fontSize: '14px' }}>
            Drop files here
          </span>
        </div>
      )}

      <div className="input-wrapper">
        {/* File Attachments Preview */}
        {hasAttachments && (
          <div style={{
            display: 'flex', flexWrap: 'wrap', gap: '6px',
            padding: '8px 12px 4px', borderBottom: '1px solid var(--border-secondary)',
          }}>
            {attachments.map((file, i) => (
              <div key={i} style={{
                display: 'flex', alignItems: 'center', gap: '5px',
                padding: '4px 8px', borderRadius: '6px',
                background: 'var(--bg-tertiary)', border: '1px solid var(--border-primary)',
                fontSize: '12px', color: 'var(--text-secondary)', maxWidth: '200px',
              }}>
                {file.type.startsWith('image/') ? (
                  <img
                    src={URL.createObjectURL(file)}
                    alt={file.name}
                    style={{ width: '20px', height: '20px', objectFit: 'cover', borderRadius: '3px' }}
                  />
                ) : (
                  <span style={{ color: 'var(--brand-primary)', flexShrink: 0 }}>
                    <FileIcon type={file.type} />
                  </span>
                )}
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                  {file.name}
                </span>
                <span style={{ color: 'var(--text-tertiary)', flexShrink: 0, fontSize: '10px' }}>
                  {formatBytes(file.size)}
                </span>
                <button
                  onClick={() => removeFile(i)}
                  style={{
                    background: 'none', border: 'none', cursor: 'pointer',
                    color: 'var(--text-tertiary)', padding: '0 2px', flexShrink: 0,
                    display: 'flex', alignItems: 'center',
                  }}
                  title="Remove file"
                  aria-label={`Remove ${file.name}`}
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                  </svg>
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Input Bar */}
        <div className="input-bar">
          <textarea
            ref={textareaRef}
            className="input-textarea"
            placeholder={hasAttachments ? "Add a message (optional)..." : "Type a message or drop files here..."}
            rows={1}
            value={inputValue}
            onChange={handleInput}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            disabled={processing}
            aria-label="Message input"
          />

          <div className="input-actions">
            {/* Hidden file input */}
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept={ACCEPTED_TYPES}
              style={{ display: 'none' }}
              onChange={handleFileInput}
              aria-label="File input"
            />

            {/* Attach Button */}
            <button
              className="input-btn"
              onClick={() => fileInputRef.current?.click()}
              disabled={processing || (attachments?.length >= MAX_FILES)}
              title={`Attach files (images, PDF, code, docs, etc.) — max ${MAX_FILES} files, 20MB each`}
              aria-label="Attach file"
              style={{
                opacity: processing || (attachments?.length >= MAX_FILES) ? 0.5 : 1,
                cursor: processing || (attachments?.length >= MAX_FILES) ? 'not-allowed' : 'pointer',
                position: 'relative',
              }}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/>
              </svg>
              {hasAttachments && (
                <span style={{
                  position: 'absolute', top: '0px', right: '0px',
                  background: 'var(--brand-primary)', color: '#fff',
                  borderRadius: '50%', width: '14px', height: '14px',
                  fontSize: '9px', display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontWeight: 700, lineHeight: 1,
                }}>
                  {attachments.length}
                </span>
              )}
            </button>

            {/* AI Model Selector Button */}
            {(providers?.length > 0 || models?.length > 0) && (
              <div ref={modelPickerRef} style={{ position: 'relative' }}>
                <button
                  className="input-btn"
                  onClick={() => setShowModelPicker(p => !p)}
                  title={`Provider: ${provider || '-'} · Model: ${model || '-'}`}
                  aria-label="Select AI model"
                  style={{
                    position: 'relative',
                    background: showModelPicker ? 'var(--brand-primary)' : 'transparent',
                    color: showModelPicker ? 'white' : 'currentColor',
                    borderRadius: 8,
                  }}
                >
                  {/* Sparkle / AI icon */}
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 2L9.5 9.5 2 12l7.5 2.5L12 22l2.5-7.5L22 12l-7.5-2.5z"/>
                  </svg>
                  {/* Active indicator dot */}
                  <span style={{
                    position: 'absolute', bottom: '2px', right: '2px',
                    width: 6, height: 6, borderRadius: '50%',
                    background: '#22c55e', border: '1px solid var(--bg-primary)',
                  }} />
                </button>

                {/* Popover */}
                {showModelPicker && (
                  <div style={{
                    position: 'absolute', bottom: 'calc(100% + 10px)', right: 0,
                    background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)',
                    borderRadius: 12, padding: 16, minWidth: 260,
                    boxShadow: '0 8px 32px rgba(0,0,0,0.2)', zIndex: 1000,
                  }}>
                    <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 12 }}>
                      AI Model
                    </div>

                    {/* Provider selector */}
                    <div style={{ marginBottom: 12 }}>
                      <label style={{ fontSize: 11, color: 'var(--text-tertiary)', display: 'block', marginBottom: 5 }}>Provider</label>
                      <select
                        value={provider || ''}
                        onChange={e => { onProviderChange?.(e.target.value); }}
                        style={{
                          width: '100%', padding: '7px 10px', fontSize: 12, fontWeight: 600,
                          background: 'var(--bg-tertiary)', border: '1px solid var(--border-primary)',
                          borderRadius: 8, color: 'var(--text-primary)', cursor: 'pointer',
                          outline: 'none',
                        }}
                      >
                        {(providers || []).map(p => (
                          <option key={p.key} value={p.key}>{p.label}</option>
                        ))}
                      </select>
                    </div>

                    {/* Model selector */}
                    <div>
                      <label style={{ fontSize: 11, color: 'var(--text-tertiary)', display: 'block', marginBottom: 5 }}>Model</label>
                      <select
                        value={model || ''}
                        onChange={e => { onModelChange?.(e.target.value); }}
                        style={{
                          width: '100%', padding: '7px 10px', fontSize: 12, fontWeight: 600,
                          background: 'var(--bg-tertiary)', border: '1px solid var(--border-primary)',
                          borderRadius: 8, color: 'var(--text-primary)', cursor: 'pointer',
                          outline: 'none',
                        }}
                      >
                        {(models || []).map(m => (
                          <option key={m.id || m} value={m.id || m}>{m.name || m.id || m}</option>
                        ))}
                      </select>
                    </div>

                    {/* Current selection summary */}
                    <div style={{ marginTop: 12, paddingTop: 10, borderTop: '1px solid var(--border-primary)', fontSize: 11, color: 'var(--text-tertiary)' }}>
                      <span style={{ color: 'var(--brand-primary)', fontWeight: 600 }}>{provider}</span>
                      {' · '}
                      <span style={{ color: 'var(--text-secondary)' }}>{model}</span>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Stop / Send */}
            {processing ? (
              <button className="input-btn" onClick={onStop} title="Stop generation" aria-label="Stop">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                  <rect x="6" y="6" width="12" height="12" rx="1"/>
                </svg>
              </button>
            ) : (
              <button
                className="input-btn input-btn-send"
                onClick={handleSend}
                disabled={!canSend}
                title="Send message (Enter)"
                aria-label="Send"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="22" y1="2" x2="11" y2="13"/>
                  <polygon points="22 2 15 22 11 13 2 9 22 2"/>
                </svg>
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
