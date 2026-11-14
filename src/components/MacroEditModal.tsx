import React, { useEffect, useState } from 'react';
import { LineEnding, MacroItem } from '../storage/preferencesStore';

interface MacroEditModalProps {
  macro: MacroItem | null;
  onClose: () => void;
  onSave: (updated: MacroItem) => void;
}

const LINE_ENDINGS: LineEnding[] = ['CRLF', 'LF', 'CR', 'RAW'];

export const MacroEditModal: React.FC<MacroEditModalProps> = ({ macro, onClose, onSave }) => {
  const [label, setLabel] = useState('');
  const [payload, setPayload] = useState('');
  const [lineEnding, setLineEnding] = useState<LineEnding>('CRLF');

  useEffect(() => {
    if (macro) {
      setLabel(macro.label);
      setPayload(macro.payload);
      setLineEnding(macro.lineEnding);
    }
  }, [macro]);

  if (!macro) return null;

  const handleSave = (ev: React.FormEvent) => {
    ev.preventDefault();
    onSave({
      id: macro.id,
      label: label.trim() || macro.label,
      payload,
      lineEnding,
    });
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal-card"
        role="dialog"
        aria-modal="true"
        aria-label="Edit macro"
        onClick={(ev) => ev.stopPropagation()}
      >
        <h2 className="modal-title">Edit Macro</h2>
        <form onSubmit={handleSave} className="modal-form">
          <label className="modal-label">
            Label
            <input
              type="text"
              className="modal-input"
              value={label}
              onChange={(ev) => setLabel(ev.target.value)}
              maxLength={16}
              required
            />
          </label>

          <label className="modal-label">
            Command Payload
            <input
              type="text"
              className="modal-input modal-mono"
              value={payload}
              onChange={(ev) => setPayload(ev.target.value)}
              autoCorrect="off"
              autoCapitalize="none"
              spellCheck={false}
            />
          </label>

          <div className="modal-label">
            Line Ending
            <div className="framing-row">
              {LINE_ENDINGS.map((le) => (
                <button
                  key={le}
                  type="button"
                  className={`baud-chip ${lineEnding === le ? 'active' : ''}`}
                  onClick={() => setLineEnding(le)}
                >
                  {le}
                </button>
              ))}
            </div>
          </div>

          <div className="modal-actions">
            <button type="button" className="btn-pill" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="btn-send">
              Save
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

