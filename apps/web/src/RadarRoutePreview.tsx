import type { RadarView } from '@nextstop/core';

export function RadarRoutePreview({ view }: { view: RadarView }) {
  const markers = view.markers;
  if (!markers) return null;
  const stops = [
    { label: '起点', point: markers.origin },
    { label: view.destination.name, point: markers.destination },
    ...(markers.next ? [{ label: '固定下一站', point: markers.next }] : []),
  ];
  const longitudes = stops.map(({ point }) => point.longitude);
  const latitudes = stops.map(({ point }) => point.latitude);
  const west = Math.min(...longitudes);
  const south = Math.min(...latitudes);
  const width = Math.max(...longitudes) - west;
  const height = Math.max(...latitudes) - south;
  return (
    <figure className="radar-route-preview">
      <div className="radar-route-points" aria-hidden="true">
        {stops.map(({ label, point }, index) => (
          <span
            key={index}
            className="radar-route-point"
            title={label}
            style={{
              left: `${width ? 18 + (64 * (point.longitude - west)) / width : 50}%`,
              top: `${height ? 76 - (52 * (point.latitude - south)) / height : 50}%`,
            }}
          >
            {index + 1}
          </span>
        ))}
      </div>
      <figcaption>
        <span>高德坐标 · 位置示意</span>
        <ol>
          {stops.map(({ label }, index) => (
            <li key={index}>{label}</li>
          ))}
        </ol>
      </figcaption>
    </figure>
  );
}
