import { useState, useEffect, useContext } from 'react';
import { PinContext, useDpt } from '../contexts.ts';
import { Badge, Btn, Spinner, TabBar } from '../primitives.jsx';
import { IconGroupAddr } from '../icons.jsx';
import { EditableRtfField } from '../rtf.jsx';
import { GANetworkDiagram } from '../diagram.jsx';
import { PinTelegramFeed } from './PinTelegramFeed.jsx';

export function GAPinPanel({
  C,
  COLMAP: _COLMAP,
  ga,
  linkedDevices,
  busConnected,
  gaTelegrams,
  gaMap,
  devMap,
  spaces,
  allCOs,
  onWrite,
  activeProjectId: _activeProjectId,
  onUpdateGA,
  onGroupJump,
}) {
  const pin = useContext(PinContext);
  const dpt = useDpt();
  const [writeVal, setWriteVal] = useState('');
  const [writeDpt, setWriteDpt] = useState(ga.dpt?.split('.')[0] || '1');
  const [sending, setSending] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState(ga.name);
  const [editDpt, setEditDpt] = useState(ga.dpt || '');
  const [saving, setSaving] = useState(false);
  const [gaTab, setGaTab] = useState(
    () => localStorage.getItem('knx-pin-tab-ga') || 'overview',
  );
  const handleGaTab = (t) => {
    setGaTab(t);
    localStorage.setItem('knx-pin-tab-ga', t);
  };
  useEffect(() => {
    setEditing(false);
  }, [ga.address]);
  const spaceMap = Object.fromEntries((spaces || []).map((s) => [s.id, s]));
  const _spacePath = (spaceId) => {
    const parts = [];
    let cur = spaceMap[spaceId];
    while (cur) {
      if (cur.type !== 'Building') parts.unshift(cur.name);
      cur = cur.parent_id ? spaceMap[cur.parent_id] : null;
    }
    return parts.join(' › ');
  };

  const handleSend = async (val) => {
    const v = val ?? writeVal;
    if ((!v && v !== 0) || !onWrite) return;
    setSending(true);
    try {
      await onWrite(ga.address, String(v), writeDpt);
      if (val === undefined) setWriteVal('');
    } catch (_) {}
    setSending(false);
  };

  const handleSave = async () => {
    if (!editName.trim() || !onUpdateGA) return;
    setSaving(true);
    try {
      await onUpdateGA(ga.id, { name: editName.trim(), dpt: editDpt });
      setEditing(false);
    } catch (e) {
      console.error(e);
    }
    setSaving(false);
  };

  return (
    <div style={{ padding: 24 }}>
      <div style={{ width: '100%' }}>
        {/* Header */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            marginBottom: 20,
          }}
        >
          <span style={{ color: C.purple }}>
            <IconGroupAddr size={26} />
          </span>
          <div style={{ flex: 1 }}>
            <div
              onClick={pin ? () => pin('ga', ga.address) : undefined}
              style={{
                fontFamily: "'DM Mono',monospace",
                fontWeight: 700,
                fontSize: 20,
                color: C.text,
                cursor: pin ? 'pointer' : 'default',
              }}
            >
              {ga.address}
            </div>
            {editing ? (
              <div
                style={{
                  display: 'flex',
                  gap: 6,
                  alignItems: 'center',
                  flexWrap: 'wrap',
                  marginTop: 4,
                }}
              >
                <input
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  autoFocus
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleSave();
                    if (e.key === 'Escape') setEditing(false);
                  }}
                  style={{
                    background: C.inputBg,
                    border: `1px solid ${C.accent}`,
                    borderRadius: 4,
                    padding: '4px 8px',
                    color: C.text,
                    fontSize: 12,
                    fontFamily: 'monospace',
                    flex: 1,
                    minWidth: 120,
                  }}
                />
                <input
                  value={editDpt}
                  onChange={(e) => setEditDpt(e.target.value)}
                  placeholder="DPT (e.g. 1.001)"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleSave();
                    if (e.key === 'Escape') setEditing(false);
                  }}
                  style={{
                    background: C.inputBg,
                    border: `1px solid ${C.border2}`,
                    borderRadius: 4,
                    padding: '4px 8px',
                    color: C.text,
                    fontSize: 11,
                    fontFamily: 'monospace',
                    width: 120,
                  }}
                />
                <Btn
                  onClick={handleSave}
                  disabled={saving || !editName.trim()}
                  color={C.green}
                >
                  {saving ? <Spinner /> : 'Save'}
                </Btn>
                <Btn onClick={() => setEditing(false)} color={C.dim}>
                  Cancel
                </Btn>
              </div>
            ) : (
              <div
                onClick={
                  onUpdateGA
                    ? () => {
                        setEditName(ga.name);
                        setEditDpt(ga.dpt || '');
                        setEditing(true);
                      }
                    : undefined
                }
                style={{
                  fontSize: 12,
                  color: C.muted,
                  marginTop: 2,
                  cursor: onUpdateGA ? 'pointer' : 'default',
                }}
                title={onUpdateGA ? 'Click to edit' : undefined}
              >
                {ga.name}
              </div>
            )}
          </div>
          {ga.dpt && (
            <span title={dpt.hover(ga.dpt)}>
              <Badge label={dpt.display(ga.dpt)} color={C.purple} />
            </span>
          )}
        </div>
        {/* Tab bar */}
        <TabBar
          C={C}
          active={gaTab}
          onChange={handleGaTab}
          tabs={[
            { id: 'overview', label: 'OVERVIEW' },
            { id: 'telegrams', label: 'MONITOR' },
          ]}
        />

        {/* Overview tab */}
        {gaTab === 'overview' && (
          <>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(3,1fr)',
                gap: 10,
                marginBottom: 20,
              }}
            >
              <div
                onClick={() => onGroupJump?.(ga.main, null)}
                style={{
                  background: C.surface,
                  border: `1px solid ${C.border}`,
                  borderRadius: 4,
                  padding: '8px 12px',
                  cursor: 'pointer',
                }}
              >
                <div style={{ fontSize: 9, color: C.dim, marginBottom: 3 }}>
                  Main Group
                </div>
                <div
                  className="pa"
                  data-pin="1"
                  style={{ fontSize: 10, color: C.purple, display: 'inline' }}
                >
                  {ga.main} — {ga.main_group_name || ''}
                </div>
              </div>
              <div
                onClick={() => onGroupJump?.(ga.main, ga.middle)}
                style={{
                  background: C.surface,
                  border: `1px solid ${C.border}`,
                  borderRadius: 4,
                  padding: '8px 12px',
                  cursor: 'pointer',
                }}
              >
                <div style={{ fontSize: 9, color: C.dim, marginBottom: 3 }}>
                  Middle Group
                </div>
                <div
                  className="pa"
                  data-pin="1"
                  style={{ fontSize: 10, color: C.purple, display: 'inline' }}
                >
                  {ga.middle} — {ga.middle_group_name || ''}
                </div>
              </div>
              <SubNameCard ga={ga} C={C} onUpdateGA={onUpdateGA} />
            </div>
            <EditableRtfField
              label="DESCRIPTION"
              value={ga.description || ''}
              C={C}
              onSave={
                onUpdateGA ? (v) => onUpdateGA(ga.id, { description: v }) : null
              }
            />
            <EditableRtfField
              label="COMMENT"
              value={ga.comment || ''}
              C={C}
              onSave={
                onUpdateGA ? (v) => onUpdateGA(ga.id, { comment: v }) : null
              }
            />
            {linkedDevices.length > 0 && (
              <GANetworkDiagram
                ga={ga}
                linkedDevices={linkedDevices}
                allCOs={allCOs}
                C={C}
                gaTelegrams={gaTelegrams}
              />
            )}
            {busConnected && (
              <div
                style={{
                  background: C.surface,
                  border: `1px solid ${C.border}`,
                  borderRadius: 6,
                  padding: '12px 16px',
                  marginBottom: 20,
                }}
              >
                <div
                  style={{
                    fontSize: 10,
                    color: C.dim,
                    letterSpacing: '0.08em',
                    marginBottom: 10,
                  }}
                >
                  SEND TELEGRAM
                </div>
                <div
                  style={{
                    display: 'flex',
                    gap: 8,
                    alignItems: 'center',
                    flexWrap: 'wrap',
                  }}
                >
                  <select
                    value={writeDpt}
                    onChange={(e) => setWriteDpt(e.target.value)}
                    style={{
                      background: C.inputBg,
                      border: `1px solid ${C.border}`,
                      borderRadius: 4,
                      padding: '6px 10px',
                      color: C.text,
                      fontSize: 11,
                      fontFamily: 'inherit',
                    }}
                  >
                    {[
                      ['1', 'DPT 1 — Bool'],
                      ['2', 'DPT 2 — Bool+C'],
                      ['5', 'DPT 5 — 0–255'],
                      ['9', 'DPT 9 — Float'],
                      ['14', 'DPT 14 — Float32'],
                    ].map(([v, l]) => (
                      <option key={v} value={v}>
                        {l}
                      </option>
                    ))}
                  </select>
                  {writeDpt === '1' ? (
                    <div style={{ display: 'flex', gap: 6 }}>
                      <Btn
                        onClick={() => handleSend('1')}
                        color={C.green}
                        disabled={sending}
                      >
                        On
                      </Btn>
                      <Btn
                        onClick={() => handleSend('0')}
                        color={C.red}
                        disabled={sending}
                      >
                        Off
                      </Btn>
                      <Btn
                        onClick={() => handleSend(writeVal === '1' ? '0' : '1')}
                        disabled={sending}
                      >
                        Toggle
                      </Btn>
                    </div>
                  ) : (
                    <>
                      <input
                        value={writeVal}
                        onChange={(e) => setWriteVal(e.target.value)}
                        onKeyDown={(e) => e.key === 'Enter' && handleSend()}
                        type="number"
                        min={writeDpt === '5' ? 0 : undefined}
                        max={writeDpt === '5' ? 255 : undefined}
                        step={['9', '14'].includes(writeDpt) ? 0.01 : 1}
                        placeholder="value"
                        style={{
                          background: C.inputBg,
                          border: `1px solid ${C.border2}`,
                          borderRadius: 4,
                          padding: '6px 10px',
                          color: C.text,
                          fontSize: 11,
                          fontFamily: 'monospace',
                          width: 120,
                        }}
                      />
                      <Btn
                        onClick={() => handleSend()}
                        disabled={sending || writeVal === ''}
                        color={C.accent}
                      >
                        {sending ? (
                          <>
                            <Spinner /> Sending…
                          </>
                        ) : (
                          '▶ Send'
                        )}
                      </Btn>
                    </>
                  )}
                </div>
              </div>
            )}
          </>
        )}

        {/* Telegrams tab */}
        {gaTab === 'telegrams' && (
          <PinTelegramFeed
            telegrams={gaTelegrams}
            gaMap={gaMap}
            devMap={devMap}
            spaces={spaces}
          />
        )}
      </div>
    </div>
  );
}

function SubNameCard({ ga, C, onUpdateGA }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(ga.name);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    setEditing(false);
    setName(ga.name);
  }, [ga.id]);

  const save = async () => {
    if (!name.trim() || !onUpdateGA) return;
    setSaving(true);
    try {
      await onUpdateGA(ga.id, { name: name.trim() });
      setEditing(false);
    } catch (_) {}
    setSaving(false);
  };

  return (
    <div
      style={{
        background: C.surface,
        border: `1px solid ${C.border}`,
        borderRadius: 4,
        padding: '8px 12px',
      }}
    >
      <div style={{ fontSize: 9, color: C.dim, marginBottom: 3 }}>Sub</div>
      {editing ? (
        <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
          <span style={{ fontSize: 10, color: C.text }}>{ga.sub} —</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
            onKeyDown={(e) => {
              if (e.key === 'Enter') save();
              if (e.key === 'Escape') setEditing(false);
            }}
            style={{
              background: C.inputBg,
              border: `1px solid ${C.accent}`,
              borderRadius: 3,
              padding: '2px 6px',
              color: C.text,
              fontSize: 10,
              fontFamily: 'inherit',
              flex: 1,
              minWidth: 60,
            }}
          />
          <Btn onClick={save} disabled={saving || !name.trim()} color={C.green}>
            {saving ? <Spinner /> : 'Save'}
          </Btn>
          <Btn
            onClick={() => {
              setEditing(false);
              setName(ga.name);
            }}
            color={C.dim}
          >
            Cancel
          </Btn>
        </div>
      ) : (
        <div
          onClick={
            onUpdateGA
              ? () => {
                  setName(ga.name);
                  setEditing(true);
                }
              : undefined
          }
          style={{
            fontSize: 10,
            color: C.text,
            cursor: onUpdateGA ? 'text' : 'default',
          }}
          title={onUpdateGA ? 'Click to rename' : undefined}
        >
          {ga.sub} — {ga.name}
        </div>
      )}
    </div>
  );
}
