import { localizedModel } from '../dpt.ts';

interface DeviceProductTabProps {
  dev: any;
  C: any;
}

export function DeviceProductTab({ dev, C }: DeviceProductTabProps) {
  const searchQuery =
    [dev.manufacturer, dev.order_number || dev.model]
      .filter(Boolean)
      .join(' ') + ' manual';
  const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(searchQuery)}`;

  return (
    <div style={{ marginTop: 16 }}>
      {/* Product info */}
      <div
        style={{
          background: C.surface,
          border: `1px solid ${C.border}`,
          borderRadius: 8,
          padding: 16,
          marginBottom: 16,
        }}
      >
        <div
          style={{
            fontSize: 11,
            color: C.accent,
            fontWeight: 600,
            letterSpacing: '0.08em',
            marginBottom: 12,
          }}
        >
          PRODUCT INFO
        </div>
        {(
          [
            ['Manufacturer', dev.manufacturer],
            ['Model', localizedModel(dev)],
            ['Order Number', dev.order_number],
            ['Serial Number', dev.serial_number],
            ['Bus Current', dev.bus_current ? dev.bus_current + ' mA' : null],
            ['Width', dev.width_mm ? dev.width_mm + ' mm' : null],
            ['Rail Mounted', dev.is_rail_mounted ? 'Yes' : null],
          ] as [string, string | null][]
        )
          .filter(([, v]) => v)
          .map(([label, value]) => (
            <div
              key={label}
              style={{ display: 'flex', fontSize: 11, marginBottom: 5 }}
            >
              <span style={{ color: C.dim, width: 110, flexShrink: 0 }}>
                {label}
              </span>
              <span style={{ color: C.muted }}>{value}</span>
            </div>
          ))}
        <div style={{ marginTop: 12 }}>
          <a
            href={searchUrl}
            target="_blank"
            rel="noopener noreferrer"
            style={{
              fontSize: 11,
              color: C.accent,
              textDecoration: 'none',
              padding: '6px 12px',
              border: `1px solid ${C.accent}40`,
              borderRadius: 4,
              display: 'inline-block',
            }}
          >
            Search for product manual &rarr;
          </a>
        </div>
      </div>
    </div>
  );
}
