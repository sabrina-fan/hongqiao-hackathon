import { useEffect, useState } from 'react';
import type {
  RadarCandidate,
  RadarExclusion,
  RadarFeedback,
  RadarOutcome,
  RadarView,
  RoutePoint,
} from '@nextstop/core';
import { PickCard } from './RadarScreens.js';
import { RadarFeedbackSheet } from './RadarFeedback.js';
import { RadarRoutePreview } from './RadarRoutePreview.js';
import './radar-recommendations.css';

type Recommendations = Extract<RadarOutcome, { kind: 'recommendations' }>;
type Option = { id: string; name: string; point: RoutePoint; marker: string };
const exclusionLabel: Record<RadarExclusion['reason'], string> = {
  time_or_distance: '时间或步行距离超过上限',
  route_unverified: '路线待核验',
  booking_required: '需要预约凭据',
  closed: '预计到访时段不营业',
};

function CandidateMap({
  candidates,
  selected,
  disabled,
  onSelect,
}: {
  candidates: RadarCandidate[];
  selected: string;
  disabled: boolean;
  onSelect: (id: string) => void;
}) {
  const active = candidates.find(({ place }) => place.id === selected);
  const markers = active?.markers;
  if (!markers || candidates.some((candidate) => !candidate.markers)) {
    return (
      <p className="note" role="status">
        地图预览暂不可用，仍可使用下方列表。
      </p>
    );
  }
  const options: Option[] = candidates.flatMap(({ place, markers: points }, index) =>
    points
      ? [{ id: place.id, name: place.name, point: points.destination, marker: String(index + 1) }]
      : [],
  );
  const anchors = [
    { id: 'origin', point: markers.origin, label: '起点' },
    ...(markers.next ? [{ id: 'next', point: markers.next, label: '下一站' }] : []),
  ];
  const points = [...options, ...anchors].map(({ point }) => point);
  const west = Math.min(...points.map(({ longitude }) => longitude));
  const east = Math.max(...points.map(({ longitude }) => longitude));
  const south = Math.min(...points.map(({ latitude }) => latitude));
  const north = Math.max(...points.map(({ latitude }) => latitude));
  const project = ({ longitude, latitude }: RoutePoint) => ({
    x: east > west ? 12 + (76 * (longitude - west)) / (east - west) : 50,
    y: north > south ? 82 - (64 * (latitude - south)) / (north - south) : 50,
  });
  const style = (point: RoutePoint) => {
    const { x, y } = project(point);
    return { left: `${x}%`, top: `${y}%` };
  };
  const schematicStops = [
    markers.origin,
    markers.destination,
    ...(markers.next ? [markers.next] : []),
  ].map(project);
  // Exact overlapping pins cannot be independently tapped. The numbered list takes over.
  if (
    new Set(options.map(({ point }) => `${point.longitude},${point.latitude}`)).size <
    options.length
  ) {
    return (
      <p className="note" role="status">
        地图标记重合，请在下方列表选择地点。
      </p>
    );
  }
  return (
    <figure className="radar-route-preview candidate-preview">
      <div className="radar-route-points radar-candidate-map" role="group" aria-label="候选地图">
        {schematicStops.slice(1).map((stop, index) => {
          const previous = schematicStops[index];
          if (!previous) return null;
          const dx = stop.x - previous.x;
          const dy = (stop.y - previous.y) / 1.78;
          return (
            <span
              key={index}
              className="radar-map-segment"
              aria-hidden="true"
              style={{
                left: `${previous.x}%`,
                top: `${previous.y}%`,
                width: `${Math.hypot(dx, dy)}%`,
                rotate: `${Math.atan2(dy, dx)}rad`,
              }}
            />
          );
        })}
        {anchors.map(({ id, label, point }) => (
          <span className="radar-map-anchor" key={id} style={style(point)}>
            {label}
          </span>
        ))}
        {options.map(({ id, name, point, marker }) => (
          <button
            className="radar-map-pin"
            key={id}
            type="button"
            style={style(point)}
            aria-label={`地图标记 ${name}`}
            aria-pressed={id === selected}
            disabled={disabled}
            title={name}
            onClick={() => onSelect(id)}
          >
            {marker}
          </button>
        ))}
      </div>
      <figcaption>高德坐标 · 连线仅示意 · {active.place.name}</figcaption>
    </figure>
  );
}

export function RadarExclusions({ entries }: { entries: RadarExclusion[] | undefined }) {
  if (!entries?.length) return null;
  return (
    <details className="radar-exclusions">
      <summary>未推荐地点（{entries.length}）</summary>
      <ul>
        {entries.map(({ place, reason }) => (
          <li key={place.id}>
            {place.name} · {exclusionLabel[reason]}
          </li>
        ))}
      </ul>
    </details>
  );
}

export function RadarRecommendations({
  view,
  outcome,
  writable,
  historical,
  accepting,
  updating,
  onReject,
  onConfirm,
  onEdit,
  onRecalculate,
}: {
  view: RadarView;
  outcome: Recommendations;
  writable: boolean;
  historical: boolean;
  accepting: boolean;
  updating: boolean;
  onReject?: (id: string, reason: RadarFeedback['reason']) => void;
  onConfirm: (id: string) => void;
  onEdit: () => void;
  onRecalculate: () => void;
}) {
  const [selected, setSelected] = useState(outcome.best.choice.poi_id);
  const [at, setAt] = useState(Date.now);
  const pick =
    [outcome.best, ...outcome.alternatives].find(({ choice }) => choice.poi_id === selected) ??
    outcome.best;
  const candidate = view.candidates?.find(({ place }) => place.id === selected);
  useEffect(() => {
    const next = view.candidates
      ?.map(({ valid_until }) => Date.parse(valid_until))
      .filter((time) => time > at)
      .sort((a, b) => a - b)[0];
    if (next === undefined) return;
    const timer = window.setTimeout(() => setAt(Date.now()), Math.max(1, next - Date.now()));
    return () => window.clearTimeout(timer);
  }, [view.candidates, at]);
  const expired =
    view.evidence_status === 'stale' ||
    Boolean(candidate && Date.parse(candidate.valid_until) <= at);
  const disabled = accepting || updating;
  return (
    <>
      {view.candidates ? (
        <CandidateMap
          candidates={view.candidates}
          selected={selected}
          disabled={disabled}
          onSelect={setSelected}
        />
      ) : (
        <RadarRoutePreview view={view} />
      )}
      <div className="between title-row">
        <h2>为你找到的选择</h2>
        <small>高德步行估算</small>
      </div>
      <PickCard
        pick={pick}
        view={view}
        candidate={candidate}
        primary={selected === outcome.best.choice.poi_id}
        expired={expired}
        accepting={accepting}
        writable={writable && !updating}
        historical={historical}
        changeAction={
          onReject && (
            <RadarFeedbackSheet
              name={candidate?.place.name ?? view.destination.name}
              disabled={disabled}
              onReject={(reason) => onReject(pick.choice.poi_id, reason)}
            />
          )
        }
        onConfirm={() => onConfirm(pick.choice.poi_id)}
        onEdit={onEdit}
        onRecalculate={onRecalculate}
      />
      {view.candidates && view.candidates.length > 1 && (
        <div className="radar-card-list" role="group" aria-label="推荐卡片">
          {view.candidates
            .map((entry, index) => ({ entry, index }))
            .sort(
              (a, b) =>
                Number(a.entry.place.id === outcome.best.choice.poi_id) -
                Number(b.entry.place.id === outcome.best.choice.poi_id),
            )
            .map(({ entry: { place, valid_until }, index }) => (
              <button
                className="panel radar-card-choice"
                type="button"
                key={place.id}
                aria-pressed={place.id === selected}
                disabled={accepting}
                onClick={() => setSelected(place.id)}
              >
                <span className="radar-card-number" aria-hidden="true">
                  {index + 1}
                </span>
                <span>
                  <strong>{place.name}</strong>
                  <small>
                    {Date.parse(valid_until) <= at
                      ? '证据已过期'
                      : index === 0
                        ? '优先推荐'
                        : '备选'}
                  </small>
                </span>
              </button>
            ))}
        </div>
      )}
      <RadarExclusions entries={view.excluded} />
    </>
  );
}
