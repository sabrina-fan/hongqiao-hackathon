import { readRecentTrip } from './offline-trip.js';
import './trip.css';

export function OfflineTrip() {
  const trip = readRecentTrip();
  return (
    <section className="trip">
      <p className="note" role="status">
        {trip
          ? '离线回读 · 路线、营业与预约信息已过期，恢复联网后重新核验。'
          : '暂时离线，本机没有可回读的行程。'}
      </p>
      {trip && (
        <div className="panel padded-panel">
          <h2>{trip.day?.destination ?? '雷达行程'}</h2>
          {trip.day && (
            <p>
              {trip.day.date} · {trip.day.start}–{trip.day.end}
            </p>
          )}
          <ul>
            {[...trip.arrangements]
              .sort((a, b) => a.start.localeCompare(b.start))
              .map((item) => (
                <li key={item.arrangement_id}>
                  {item.start}–{item.end} · {item.name}
                  {item.locked ? '（已锁定）' : ''}
                </li>
              ))}
            {trip.stops.map((stop) => (
              <li key={stop.stop_id}>{stop.name}</li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
