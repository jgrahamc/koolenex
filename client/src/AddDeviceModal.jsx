import { useState, useMemo } from 'react';
import { useC } from './theme.ts';

// Compute next available device number on a line
function nextDeviceNum(devices, area, line) {
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

// Flatten space tree into indented options
function flattenSpaces(spaces) {
  const nodeMap = {};
  for (const s of spaces) nodeMap[s.id] = { ...s, children: [] };
  const roots = [];
  for (const s of spaces) {
    if (s.parent_id && nodeMap[s.parent_id])
      nodeMap[s.parent_id].children.push(nodeMap[s.id]);
    else roots.push(nodeMap[s.id]);
  }
  const result = [];
  const walk = (nodes, depth) => {
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

export function AddDeviceModal({ data, defaults = {}, onAdd, onClose }) {
  const C = useC();
  const { devices = [], spaces = [] } = data || {};

  // Build manufacturer → model list from existing devices
  const mfrTree = useMemo(() => {
    const map = {};
    for (const d of devices) {
      if (!d.manufacturer) continue;
      if (!map[d.manufacturer]) map[d.manufacturer] = {};
      const key = d.model || '(unknown)';
      if (!map[d.manufacturer][key]) {
        map[d.manufacturer][key] = {
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
        models: mfr.models.filter((m) => m.medium === defaults.medium),
      }))
      .filter((mfr) => mfr.models.length > 0);
  }, [mfrTree, defaults.medium]);

  const flatSpaces = useMemo(() => flattenSpaces(spaces), [spaces]);

  // If manufacturer+model pre-selected, lock the device type picker
  const typeFixed = !!(defaults.model || defaults.manufacturer);

  // Form state
  const [selectedMfr, setSelectedMfr] = useState(defaults.manufacturer || '');
  const [selectedModel, setSelectedModel] = useState(defaults.model || '');
  const [name, setName] = useState(defaults.name || defaults.model || '');
  const [area, setArea] = useState(defaults.area ?? 1);
  const [line, setLine] = useState(defaults.line ?? 1);
  const [devNum, setDevNum] = useState(() => {
    const a = defaults.area ?? 1,
      l = defaults.line ?? 1;
    return nextDeviceNum(devices, a, l) ?? 1;
  });
  const [spaceId, setSpaceId] = useState(defaults.space_id || '');
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');

  // When model is selected, auto-fill name
  const handleModelSelect = (mfr, model) => {
    setSelectedMfr(mfr.name);
    setSelectedModel(model.name);
    if (!name) setName(model.name);
  };

  // When area or line changes, recompute next device number
  const handleAreaChange = (a) => {
    setArea(a);
    setDevNum(nextDeviceNum(devices, a, line) ?? 1);
  };
  const handleLineChange = (l) => {
    setLine(l);
    setDevNum(nextDeviceNum(devices, area, l) ?? 1);
  };

  // Get selected model info
  const modelInfo = useMemo(() => {
    if (!selectedMfr || !selectedModel) return null;
    const mfr = filteredTree.find((m) => m.name === selectedMfr);
    return mfr?.models.find((m) => m.name === selectedModel) || null;
  }, [selectedMfr, selectedModel, filteredTree]);

  // Filtered models for search
  const sq = search.toLowerCase();
  const searchResults = useMemo(() => {
    if (!sq) return filteredTree;
    return filteredTree
      .map((mfr) => ({
        ...mfr,
        models: mfr.models.filter(
          (m) =>
            m.name.toLowerCase().includes(sq) ||
            mfr.name.toLowerCase().includes(sq) ||
            (m.order_number && m.order_number.toLowerCase().includes(sq)),
        ),
      }))
      .filter((mfr) => mfr.models.length > 0);
  }, [filteredTree, sq]);

  // Validation
  const address = `${area}.${line}.${devNum}`;
  const addressExists = devices.some((d) => d.individual_address === address);
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

  const inputStyle = {
    background: C.inputBg,
    border: `1px solid ${C.border2}`,
    borderRadius: 4,
    padding: '5px 8px',
    color: C.text,
    fontSize: 11,
    fontFamily: 'inherit',
  };

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.55)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 2000,
      }}
      onClick={onClose}
    >
      <div
        style={{
          background: C.surface,
          border: `1px solid ${C.border2}`,
          borderRadius: 8,
          padding: 20,
          width: 480,
          maxHeight: '80vh',
          display: 'flex',
          flexDirection: 'column',
          boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          style={{
            fontSize: 12,
            fontWeight: 600,
            color: C.text,
            marginBottom: 14,
          }}
        >
          Add Device
        </div>

        {/* Device type picker — hidden when type is pre-selected */}
        {typeFixed ? (
          <div style={{ marginBottom: 14 }}>
            <div
              style={{
                fontSize: 9,
                color: C.dim,
                letterSpacing: '0.08em',
                marginBottom: 4,
              }}
            >
              DEVICE TYPE
            </div>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                padding: '6px 8px',
                background: C.bg,
                border: `1px solid ${C.border}`,
                borderRadius: 4,
              }}
            >
              {modelInfo && (
                <DeviceTypeIcon
                  type={modelInfo.device_type}
                  size={11}
                  style={{ color: C.muted }}
                />
              )}
              <span style={{ fontSize: 10, color: C.text }}>
                {selectedMfr}
                {selectedModel ? ` — ${selectedModel}` : ''}
              </span>
              {modelInfo?.order_number && (
                <span style={{ fontSize: 9, color: C.dim, marginLeft: 'auto' }}>
                  {modelInfo.order_number}
                </span>
              )}
            </div>
          </div>
        ) : (
          <>
            <div
              style={{
                fontSize: 9,
                color: C.dim,
                letterSpacing: '0.08em',
                marginBottom: 4,
              }}
            >
              DEVICE TYPE
            </div>
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search manufacturer, model, or order number..."
              style={{ ...inputStyle, width: '100%', marginBottom: 6 }}
            />
            <div
              style={{
                maxHeight: 150,
                overflow: 'auto',
                border: `1px solid ${C.border}`,
                borderRadius: 4,
                marginBottom: 14,
              }}
            >
              {searchResults.length === 0 && (
                <div
                  style={{
                    padding: 12,
                    fontSize: 10,
                    color: C.dim,
                    textAlign: 'center',
                  }}
                >
                  No matching device types
                </div>
              )}
              {searchResults.map((mfr) => (
                <div key={mfr.name}>
                  <div
                    style={{
                      fontSize: 9,
                      color: C.dim,
                      padding: '4px 8px',
                      background: C.bg,
                      borderBottom: `1px solid ${C.border}`,
                    }}
                  >
                    {mfr.name}
                  </div>
                  {mfr.models.map((m) => {
                    const isSel =
                      selectedMfr === mfr.name && selectedModel === m.name;
                    return (
                      <div
                        key={m.name}
                        onClick={() => handleModelSelect(mfr, m)}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 6,
                          padding: '4px 8px',
                          cursor: 'pointer',
                          background: isSel ? `${C.accent}20` : 'transparent',
                          borderBottom: `1px solid ${C.border}`,
                        }}
                        className="rh"
                      >
                        <DeviceTypeIcon
                          type={m.device_type}
                          size={11}
                          style={{ color: C.muted }}
                        />
                        <span
                          style={{
                            fontSize: 10,
                            color: isSel ? C.accent : C.text,
                          }}
                        >
                          {m.name}
                        </span>
                        {m.order_number && (
                          <span
                            style={{
                              fontSize: 9,
                              color: C.dim,
                              marginLeft: 'auto',
                            }}
                          >
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
                style={{
                  padding: '4px 8px',
                  cursor: 'pointer',
                  fontSize: 10,
                  color: C.muted,
                  background:
                    !selectedMfr && !selectedModel
                      ? `${C.accent}20`
                      : 'transparent',
                }}
                className="rh"
              >
                Generic device (no type)
              </div>
            </div>
          </>
        )}

        {/* Name */}
        <div
          style={{
            fontSize: 9,
            color: C.dim,
            letterSpacing: '0.08em',
            marginBottom: 4,
          }}
        >
          NAME
        </div>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Device name"
          style={{ ...inputStyle, width: '100%', marginBottom: 14 }}
        />

        {/* Address */}
        <div
          style={{
            fontSize: 9,
            color: C.dim,
            letterSpacing: '0.08em',
            marginBottom: 4,
          }}
        >
          INDIVIDUAL ADDRESS
          {addressExists && (
            <span style={{ color: C.red, marginLeft: 8 }}>already exists</span>
          )}
        </div>
        <div
          style={{
            display: 'flex',
            gap: 6,
            alignItems: 'center',
            marginBottom: 14,
          }}
        >
          <input
            type="number"
            min={1}
            max={15}
            value={area}
            onChange={(e) => handleAreaChange(+e.target.value)}
            disabled={areaFixed}
            style={{ ...inputStyle, width: 50, textAlign: 'center' }}
          />
          <span style={{ color: C.dim }}>.</span>
          <input
            type="number"
            min={0}
            max={15}
            value={line}
            onChange={(e) => handleLineChange(+e.target.value)}
            disabled={lineFixed}
            style={{ ...inputStyle, width: 50, textAlign: 'center' }}
          />
          <span style={{ color: C.dim }}>.</span>
          <input
            type="number"
            min={1}
            max={255}
            value={devNum}
            onChange={(e) => setDevNum(+e.target.value)}
            style={{ ...inputStyle, width: 60, textAlign: 'center' }}
          />
          <span style={{ fontSize: 9, color: C.dim, marginLeft: 4 }}>
            next: {nextDeviceNum(devices, area, line) ?? 'full'}
          </span>
        </div>

        {/* Location */}
        <div
          style={{
            fontSize: 9,
            color: C.dim,
            letterSpacing: '0.08em',
            marginBottom: 4,
          }}
        >
          LOCATION
        </div>
        <select
          value={spaceId}
          onChange={(e) => setSpaceId(+e.target.value || '')}
          style={{ ...inputStyle, width: '100%', marginBottom: 14 }}
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
        {error && (
          <div style={{ fontSize: 10, color: C.red, marginBottom: 8 }}>
            {error}
          </div>
        )}

        {/* Buttons */}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <Btn onClick={onClose} color={C.dim}>
            Cancel
          </Btn>
          <Btn onClick={handleSubmit} color={C.accent} disabled={addressExists}>
            Add Device
          </Btn>
        </div>
      </div>
    </div>
  );
}
