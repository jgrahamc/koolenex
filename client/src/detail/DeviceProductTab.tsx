import { localizedModel } from '../dpt.ts';
import styles from './DeviceProductTab.module.css';

interface DeviceProductTabProps {
  dev: any;
  C: any;
}

export function DeviceProductTab({ dev, C: _C }: DeviceProductTabProps) {
  const searchQuery =
    [dev.manufacturer, dev.order_number || dev.model]
      .filter(Boolean)
      .join(' ') + ' manual';
  const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(searchQuery)}`;

  return (
    <div className={styles.wrapper}>
      {/* Product info */}
      <div className={styles.card}>
        <div className={styles.heading}>PRODUCT INFO</div>
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
            <div key={label} className={styles.row}>
              <span className={styles.rowLabel}>{label}</span>
              <span className={styles.rowValue}>{value}</span>
            </div>
          ))}
        <div className={styles.linkRow}>
          <a
            href={searchUrl}
            target="_blank"
            rel="noopener noreferrer"
            className={styles.link}
          >
            Search for product manual &rarr;
          </a>
        </div>
      </div>
    </div>
  );
}
