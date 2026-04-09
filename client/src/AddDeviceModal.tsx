import { useState, useMemo } from 'react';
import { Btn } from './primitives.tsx';
import { DeviceTypeIcon } from './icons.tsx';
import styles from './AddDeviceModal.module.css';

// Compute next available device number on a line
function nextDeviceNum(devices: any[], area: number, line: number) {
  const used = new Set(
    devices
      .filter((d) => d.area === area && d.line === line)
      .map((d) => parseInt(d.individual_address.split('.')[2])),
  );
  for (let i = 1; i <= 255; i++) {
    if (!used.has(i)) return i;
  }
  return null;
}

interface SpaceNode {
  id: number;
  name: string;
  type: string;
  parent_id: number | null;
  sort_order?: number;
}

interface FlatSpace {
  id: number;
  name: string;
  type: string;
  depth: number;
}

// Flatten space tree into indented options
function flattenSpaces(spaces: SpaceNode[]): FlatSpace[] {
  const nodeMap: Record<
    number,
    SpaceNode & { children: (SpaceNode & { children: any[] })[] }
  > = {};
  for (const s of spaces) nodeMap[s.id] = { ...s, children: [] };
  const roots: (typeof nodeMap)[number][] = [];
  for (const s of spaces) {
    const parent = s.parent_id != null ? nodeMap[s.parent_id] : undefined;
    if (parent) parent.children.push(nodeMap[s.id]!);
    else roots.push(nodeMap[s.id]!);
  }
  const result: FlatSpace[] = [];
  const walk = (nodes: typeof roots, depth: number) => {
    for (const n of nodes.sort(
      (a, b) =>
        (a.sort_order ?? 0) - (b.sort_order ?? 0) ||
        a.name.localeCompare(b.name),
    )) {
      result.push({ id: n.id, name: n.name, type: n.type, depth });
      walk(n.children, depth + 1);
    }
  };
  walk(roots, 0);
  return result;
}

interface AddDeviceModalProps {
  data: any;
  defaults?: any;
  onAdd: (body: any) => Promise<any>;
  onClose: () => void;
}

export function AddDeviceModal({
  data,
  defaults = {},
  onAdd,
  onClose,
}: AddDeviceModalProps) {
  const { devices = [], spaces = [] } = data || {};

  // Build manufacturer → model list from existing devices
  const mfrTree = useMemo(() => {
    const map: Record<string, Record<string, any>> = {};
    for (const d of devices) {
      if (!d.manufacturer) continue;
      if (!map[d.manufacturer]) map[d.manufacturer] = {};
      const mfrMap = map[d.manufacturer]!;
      const key = d.model || '(unknown)';
      if (!mfrMap[key]) {
        mfrMap[key] = {
          model: d.model,
          device_type: d.device_type,
          order_number: d.order_number || '',
          medium: d.medium || 'TP',
          description: d.description || '',
          product_ref: d.product_ref || '',
        };
      }
    }
    return Object.entries(map)
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([mfr, models]) => ({
        name: mfr,
        models: Object.entries(models)
          .sort((a, b) => a[0].localeCompare(b[0]))
          .map(([name, info]) => ({ name, ...info })),
      }));
  }, [devices]);

  // Filter by medium if specified
  const filteredTree = useMemo(() => {
    if (!defaults.medium) return mfrTree;
    return mfrTree
      .map((mfr) => ({
        ...mfr,
        models: mfr.models.filter((m: any) => m.medium === defaults.medium),
      }))
      .filter((mfr) => mfr.models.length > 0);
  }, [mfrTree, defaults.medium]);

  const flatSpaces = useMemo(() => flattenSpaces(spaces), [spaces]);

  // If manufacturer+model pre-selected, lock the device type picker
  const typeFixed = !!(defaults.model || defaults.manufacturer);

  // Form state
  const [selectedMfr, setSelectedMfr] = useState<string>(
    defaults.manufacturer || '',
  );
  const [selectedModel, setSelectedModel] = useState<string>(
    defaults.model || '',
  );
  const [name, setName] = useState<string>(
    defaults.name || defaults.model || '',
  );
  const [area, setArea] = useState<number>(defaults.area ?? 1);
  const [line, setLine] = useState<number>(defaults.line ?? 1);
  const [devNum, setDevNum] = useState<number>(() => {
    const a = defaults.area ?? 1,
      l = defaults.line ?? 1;
    return nextDeviceNum(devices, a, l) ?? 1;
  });
  const [spaceId, setSpaceId] = useState<number | string>(
    defaults.space_id || '',
  );
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');

  // When model is selected, auto-fill name
  const handleModelSelect = (mfr: any, model: any) => {
    setSelectedMfr(mfr.name);
    setSelectedModel(model.name);
    if (!name) setName(model.name);
  };

  // When area or line changes, recompute next device number
  const handleAreaChange = (a: number) => {
    setArea(a);
    setDevNum(nextDeviceNum(devices, a, line) ?? 1);
  };
  const handleLineChange = (l: number) => {
    setLine(l);
    setDevNum(nextDeviceNum(devices, area, l) ?? 1);
  };

  // Get selected model info
  const modelInfo = useMemo(() => {
    if (!selectedMfr || !selectedModel) return null;
    const mfr = filteredTree.find((m) => m.name === selectedMfr);
    return mfr?.models.find((m: any) => m.name === selectedModel) || null;
  }, [selectedMfr, selectedModel, filteredTree]);

  // Filtered models for search
  const sq = search.toLowerCase();
  const searchResults = useMemo(() => {
    if (!sq) return filteredTree;
    return filteredTree
      .map((mfr) => ({
        ...mfr,
        models: mfr.models.filter(
          (m: any) =>
            m.name.toLowerCase().includes(sq) ||
            mfr.name.toLowerCase().includes(sq) ||
            (m.order_number && m.order_number.toLowerCase().includes(sq)),
        ),
      }))
      .filter((mfr) => mfr.models.length > 0);
  }, [filteredTree, sq]);

  // Validation
  const address = `${area}.${line}.${devNum}`;
  const addressExists = devices.some(
    (d: any) => d.individual_address === address,
  );
  const areaFixed = defaults.area != null;
  const lineFixed = defaults.line != null;

  const handleSubmit = async () => {
    if (addressExists) {
      setError('Address already exists');
      return;
    }
    if (!name.trim()) {
      setError('Name is required');
      return;
    }
    setError('');

    const body = {
      individual_address: address,
      name: name.trim(),
      area,
      line,
      manufacturer: selectedMfr || '',
      model: selectedModel || '',
      device_type: modelInfo?.device_type || 'generic',
      order_number: modelInfo?.order_number || '',
      medium: modelInfo?.medium || defaults.medium || 'TP',
      product_ref: modelInfo?.product_ref || '',
      space_id: spaceId || null,
    };

    const device = await onAdd(body);
    if (device) onClose();
  };

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div
        className={styles.modal}
        onClick={(e: React.MouseEvent) => e.stopPropagation()}
      >
        <div className={styles.modalTitle}>Add Device</div>

        {/* Device type picker -- hidden when type is pre-selected */}
        {typeFixed ? (
          <div className={styles.typeFixedWrap}>
            <div className={styles.fieldLabel}>DEVICE TYPE</div>
            <div className={styles.typeFixedBox}>
              {modelInfo && (
                <DeviceTypeIcon
                  type={modelInfo.device_type}
                  size={11}
                  style={{ color: 'var(--muted)' }}
                />
              )}
              <span className={styles.typeFixedName}>
                {selectedMfr}
                {selectedModel ? ` — ${selectedModel}` : ''}
              </span>
              {modelInfo?.order_number && (
                <span className={styles.typeFixedOrder}>
                  {modelInfo.order_number}
                </span>
              )}
            </div>
          </div>
        ) : (
          <>
            <div className={styles.fieldLabel}>DEVICE TYPE</div>
            <input
              value={search}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                setSearch(e.target.value)
              }
              placeholder="Search manufacturer, model, or order number..."
              className={styles.searchInput}
            />
            <div className={styles.typeList}>
              {searchResults.length === 0 && (
                <div className={styles.typeListEmpty}>
                  No matching device types
                </div>
              )}
              {searchResults.map((mfr) => (
                <div key={mfr.name}>
                  <div className={styles.mfrHeader}>{mfr.name}</div>
                  {mfr.models.map((m: any) => {
                    const isSel =
                      selectedMfr === mfr.name && selectedModel === m.name;
                    return (
                      <div
                        key={m.name}
                        onClick={() => handleModelSelect(mfr, m)}
                        className={`rh ${isSel ? styles.modelRowSelected : styles.modelRow}`}
                      >
                        <DeviceTypeIcon
                          type={m.device_type}
                          size={11}
                          style={{ color: 'var(--muted)' }}
                        />
                        <span
                          className={
                            isSel
                              ? styles.modelNameSelected
                              : styles.modelNameDefault
                          }
                        >
                          {m.name}
                        </span>
                        {m.order_number && (
                          <span className={styles.modelOrder}>
                            {m.order_number}
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>
              ))}
              {/* Generic option */}
              <div
                onClick={() => {
                  setSelectedMfr('');
                  setSelectedModel('');
                  setName(name || 'New Device');
                }}
                className={`rh ${!selectedMfr && !selectedModel ? styles.genericOptionSelected : styles.genericOption}`}
              >
                Generic device (no type)
              </div>
            </div>
          </>
        )}

        {/* Name */}
        <div className={styles.fieldLabel}>NAME</div>
        <input
          value={name}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
            setName(e.target.value)
          }
          placeholder="Device name"
          className={styles.nameInput}
        />

        {/* Address */}
        <div className={styles.fieldLabel}>
          INDIVIDUAL ADDRESS
          {addressExists && (
            <span className={styles.addrConflict}>already exists</span>
          )}
        </div>
        <div className={styles.addressWrap}>
          <input
            type="number"
            min={1}
            max={15}
            value={area}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
              handleAreaChange(+e.target.value)
            }
            disabled={areaFixed}
            className={styles.addrInput}
          />
          <span className={styles.addrDot}>.</span>
          <input
            type="number"
            min={0}
            max={15}
            value={line}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
              handleLineChange(+e.target.value)
            }
            disabled={lineFixed}
            className={styles.addrInput}
          />
          <span className={styles.addrDot}>.</span>
          <input
            type="number"
            min={1}
            max={255}
            value={devNum}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
              setDevNum(+e.target.value)
            }
            className={styles.addrInputWide}
          />
          <span className={styles.addrNext}>
            next: {nextDeviceNum(devices, area, line) ?? 'full'}
          </span>
        </div>

        {/* Location */}
        <div className={styles.fieldLabel}>LOCATION</div>
        <select
          value={spaceId}
          onChange={(e: React.ChangeEvent<HTMLSelectElement>) =>
            setSpaceId(+e.target.value || '')
          }
          className={styles.selectField}
        >
          <option value="">— None —</option>
          {flatSpaces.map((s) => (
            <option key={s.id} value={s.id}>
              {'  '.repeat(s.depth)}
              {s.name} ({s.type})
            </option>
          ))}
        </select>

        {/* Error */}
        {error && <div className={styles.error}>{error}</div>}

        {/* Buttons */}
        <div className={styles.actions}>
          <Btn onClick={onClose} color="var(--dim)">
            Cancel
          </Btn>
          <Btn
            onClick={handleSubmit}
            color="var(--accent)"
            disabled={addressExists}
          >
            Add Device
          </Btn>
        </div>
      </div>
    </div>
  );
}
