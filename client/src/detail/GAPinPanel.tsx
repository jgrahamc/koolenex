import { useState, useEffect, useContext } from 'react';
import { dptInput, sendDptOptions } from '../dpt.ts';
import type {
  Device,
  EnrichedGA,
  ComObjectWithDevice,
  Space,
} from '../../../shared/types.ts';
import type { ProjectActions } from '../contexts.ts';
import type { FeedTelegram } from './PinTelegramFeed.tsx';
import { PinContext, useDpt } from '../contexts.ts';
import { Badge, Btn, Spinner, TabBar } from '../primitives.tsx';
import { IconGroupAddr } from '../icons.tsx';
import { EditableRtfField } from '../rtf.tsx';
import { GANetworkDiagram } from '../diagram.tsx';
import { PinTelegramFeed } from './PinTelegramFeed.tsx';
import styles from './GAPinPanel.module.css';

interface GAPinPanelProps {
  COLMAP: Record<string, string>;
  ga: EnrichedGA;
  linkedDevices: Device[];
  busConnected: boolean;
  gaTelegrams: FeedTelegram[];
  gaMap: Record<string, EnrichedGA>;
  devMap: Record<string, Device>;
  spaces: Space[];
  allCOs: ComObjectWithDevice[];
  onWrite: ((ga: string, value: unknown, dpt?: string) => void) | null;
  activeProjectId: number | null;
  onUpdateGA: ProjectActions['updateGA'] | null;
  onGroupJump: ((main: number, middle: number | null) => void) | null;
}

export function GAPinPanel({
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
}: GAPinPanelProps) {
  const pin = useContext(PinContext);
  const dpt = useDpt();
  const [writeVal, setWriteVal] = useState('');
  // The GA's own DPT, in full ('9.007', not '9') so an enum DPT can offer
  // its real values. useState alone was not enough: this panel stays mounted
  // when a different GA is pinned, so it kept the first GA's DPT - which is
  // what "the send box isn't picking up the DPT" was.
  const [writeDpt, setWriteDpt] = useState(ga.dpt || '1.001');
  const [sending, setSending] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState(ga.name);
  const [editDpt, setEditDpt] = useState(ga.dpt || '');
  const [saving, setSaving] = useState(false);
  const [gaTab, setGaTab] = useState(
    () => localStorage.getItem('knx-pin-tab-ga') || 'overview',
  );
  const handleGaTab = (t: string) => {
    setGaTab(t);
    localStorage.setItem('knx-pin-tab-ga', t);
  };
  useEffect(() => {
    setEditing(false);
    setWriteDpt(ga.dpt || '1.001');
    setWriteVal('');
  }, [ga.address, ga.dpt]);
  // What control the value takes, from the DPT actually selected.
  const writeInput = dptInput(writeDpt);

  const handleSend = async (val?: string) => {
    const v = val ?? writeVal;
    if ((!v && v !== '0') || !onWrite) return;
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
    <div className={styles.panel}>
      <div className={styles.inner}>
        {/* Header */}
        <div className={styles.header}>
          <span className={styles.headerIcon}>
            <IconGroupAddr size={26} />
          </span>
          <div className={styles.headerFlex}>
            <div
              onClick={pin ? () => pin('ga', ga.address) : undefined}
              className={pin ? styles.addressClickable : styles.address}
            >
              {ga.address}
            </div>
            {editing ? (
              <div className={styles.editRow}>
                <input
                  value={editName}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                    setEditName(e.target.value)
                  }
                  autoFocus
                  onKeyDown={(e: React.KeyboardEvent<HTMLInputElement>) => {
                    if (e.key === 'Enter') handleSave();
                    if (e.key === 'Escape') setEditing(false);
                  }}
                  className={styles.editInput}
                />
                <input
                  value={editDpt}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                    setEditDpt(e.target.value)
                  }
                  placeholder="DPT (e.g. 1.001)"
                  onKeyDown={(e: React.KeyboardEvent<HTMLInputElement>) => {
                    if (e.key === 'Enter') handleSave();
                    if (e.key === 'Escape') setEditing(false);
                  }}
                  className={styles.editDptInput}
                />
                <Btn
                  onClick={handleSave}
                  disabled={saving || !editName.trim()}
                  color="var(--green)"
                >
                  {saving ? <Spinner /> : 'Save'}
                </Btn>
                <Btn onClick={() => setEditing(false)} color="var(--dim)">
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
                className={onUpdateGA ? styles.gaNameClickable : styles.gaName}
                title={onUpdateGA ? 'Click to edit' : undefined}
              >
                {ga.name}
              </div>
            )}
          </div>
          {ga.dpt && (
            <span title={dpt.hover(ga.dpt)}>
              <Badge label={dpt.display(ga.dpt)} color="var(--purple)" />
            </span>
          )}
        </div>
        {/* Tab bar */}
        <TabBar
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
            <div className={styles.grid3}>
              <div
                onClick={() => onGroupJump?.(ga.main_g, null)}
                className={styles.groupCard}
              >
                <div className={styles.groupLabel}>Main Group</div>
                <div className={`pa ${styles.groupValueLink}`} data-pin="1">
                  {ga.main_g} &mdash; {ga.main_group_name || ''}
                </div>
              </div>
              <div
                onClick={() => onGroupJump?.(ga.main_g, ga.middle_g)}
                className={styles.groupCard}
              >
                <div className={styles.groupLabel}>Middle Group</div>
                <div className={`pa ${styles.groupValueLink}`} data-pin="1">
                  {ga.middle_g} &mdash; {ga.middle_group_name || ''}
                </div>
              </div>
              <SubNameCard ga={ga} onUpdateGA={onUpdateGA} />
            </div>
            <EditableRtfField
              label="DESCRIPTION"
              value={ga.description || ''}
              onSave={
                onUpdateGA
                  ? (v: string) => onUpdateGA(ga.id, { description: v })
                  : undefined
              }
            />
            <EditableRtfField
              label="COMMENT"
              value={ga.comment || ''}
              onSave={
                onUpdateGA
                  ? (v: string) => onUpdateGA(ga.id, { comment: v })
                  : undefined
              }
            />
            {linkedDevices.length > 0 && (
              <GANetworkDiagram
                ga={ga}
                linkedDevices={linkedDevices}
                allCOs={allCOs}
                gaTelegrams={gaTelegrams}
              />
            )}
            {busConnected && (
              <div className={styles.sendCard}>
                <div className={styles.sendLabel}>SEND TELEGRAM</div>
                <div className={styles.sendRow}>
                  <select
                    value={writeDpt}
                    onChange={(e: React.ChangeEvent<HTMLSelectElement>) =>
                      setWriteDpt(e.target.value)
                    }
                    className={styles.sendSelect}
                  >
                    {sendDptOptions(ga.dpt).map(([v, l]) => (
                      <option key={v} value={v}>
                        {l}
                      </option>
                    ))}
                  </select>
                  {writeInput.kind === 'bool' ? (
                    <div className={styles.boolBtns}>
                      <Btn
                        onClick={() => handleSend('1')}
                        color="var(--green)"
                        disabled={sending}
                      >
                        On
                      </Btn>
                      <Btn
                        onClick={() => handleSend('0')}
                        color="var(--red)"
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
                      {writeInput.kind === 'enum' ? (
                        <select
                          value={writeVal}
                          onChange={(e: React.ChangeEvent<HTMLSelectElement>) =>
                            setWriteVal(e.target.value)
                          }
                          className={styles.sendSelect}
                        >
                          <option value="">value…</option>
                          {Object.entries(writeInput.enums || {}).map(
                            ([v, label]) => (
                              <option key={v} value={v}>
                                {v} — {label}
                              </option>
                            ),
                          )}
                        </select>
                      ) : (
                        <input
                          value={writeVal}
                          onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                            setWriteVal(e.target.value)
                          }
                          onKeyDown={(
                            e: React.KeyboardEvent<HTMLInputElement>,
                          ) => e.key === 'Enter' && handleSend()}
                          type={writeInput.kind === 'text' ? 'text' : 'number'}
                          min={writeInput.min}
                          max={writeInput.max}
                          step={writeInput.kind === 'float' ? 0.01 : 1}
                          placeholder={
                            writeInput.unit
                              ? `value (${writeInput.unit})`
                              : 'value'
                          }
                          className={styles.sendInput}
                        />
                      )}
                      <Btn
                        onClick={() => handleSend()}
                        disabled={sending || writeVal === ''}
                        color="var(--accent)"
                      >
                        {sending ? (
                          <>
                            <Spinner /> Sending&hellip;
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

interface SubNameCardProps {
  ga: EnrichedGA;
  onUpdateGA: ProjectActions['updateGA'] | null;
}

function SubNameCard({ ga, onUpdateGA }: SubNameCardProps) {
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
    <div className={`${styles.groupCard} ${styles.groupCardDefault}`}>
      <div className={styles.groupLabel}>Sub</div>
      {editing ? (
        <div className={styles.subEditRow}>
          <span className={styles.subText}>{ga.sub_g} &mdash;</span>
          <input
            value={name}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
              setName(e.target.value)
            }
            autoFocus
            onKeyDown={(e: React.KeyboardEvent<HTMLInputElement>) => {
              if (e.key === 'Enter') save();
              if (e.key === 'Escape') setEditing(false);
            }}
            className={styles.subEditInput}
          />
          <Btn
            onClick={save}
            disabled={saving || !name.trim()}
            color="var(--green)"
          >
            {saving ? <Spinner /> : 'Save'}
          </Btn>
          <Btn
            onClick={() => {
              setEditing(false);
              setName(ga.name);
            }}
            color="var(--dim)"
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
          className={
            onUpdateGA ? styles.subDisplayClickable : styles.subDisplay
          }
          title={onUpdateGA ? 'Click to rename' : undefined}
        >
          {ga.sub_g} &mdash; {ga.name}
        </div>
      )}
    </div>
  );
}
