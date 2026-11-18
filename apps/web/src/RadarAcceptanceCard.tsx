import { useState } from 'react';
import type { RadarAcceptance } from '@nextstop/core';
import './radar-acceptance.css';

export type UndoState = { kind: 'idle' | 'pending' } | { kind: 'failed'; message: string };

function amapLink({ destination, point }: RadarAcceptance, launchApp: boolean) {
  const url = new URL(point ? 'https://uri.amap.com/navigation' : 'https://uri.amap.com/search');
  if (point) {
    url.searchParams.set('to', `${point.longitude},${point.latitude},${destination.name}`);
    url.searchParams.set('mode', 'walk');
    url.searchParams.set('coordinate', 'gaode');
  } else {
    url.searchParams.set(
      'keyword',
      [destination.name, destination.address].filter(Boolean).join(' '),
    );
    url.searchParams.set('city', '苏州');
  }
  url.searchParams.set('callnative', launchApp ? '1' : '0');
  return url.href;
}

export function RadarAcceptanceCard({
  acceptance,
  undo,
  onUndo,
}: {
  acceptance: RadarAcceptance;
  undo: UndoState;
  onUndo: () => void;
}) {
  const [copyStatus, setCopyStatus] = useState('');
  const { destination, receipt, status } = acceptance;
  const address = destination.address.trim();
  async function copyAddress() {
    try {
      await navigator.clipboard.writeText(address);
      setCopyStatus('地址已复制。');
    } catch {
      setCopyStatus('无法自动复制，请长按上方地址手动复制。');
    }
  }
  return (
    <article className="panel padded-panel radar-acceptance">
      <p role="status" className="radar-acceptance-status">
        {status === 'added' ? '已加入行程' : '已撤销本次加入'}：{receipt.stop.name}
      </p>
      {status === 'added' && (
        <>
          <span className="badge lime">已选择</span>
          <p className="muted">{address || '地图未提供地址。'}</p>
          <a
            className="primary full"
            href={amapLink(acceptance, true)}
            target="_blank"
            rel="noreferrer"
          >
            打开导航 · 高德地图
          </a>
          <div className="radar-acceptance-fallbacks">
            <a
              className="secondary"
              href={amapLink(acceptance, false)}
              target="_blank"
              rel="noreferrer"
            >
              网页地图
            </a>
            {address && (
              <button className="secondary" type="button" onClick={() => void copyAddress()}>
                复制地址
              </button>
            )}
          </div>
          {copyStatus && (
            <p className="muted" role="status">
              {copyStatus}
            </p>
          )}
          {undo.kind === 'failed' && <p role="alert">撤销未能确认。{undo.message}</p>}
        </>
      )}
      <div className="radar-acceptance-actions">
        <a href="#trip" className="secondary">
          查看行程 →
        </a>
        {status === 'added' && (
          <button
            className="secondary"
            type="button"
            disabled={undo.kind === 'pending'}
            onClick={onUndo}
          >
            {undo.kind === 'pending'
              ? '正在撤销…'
              : undo.kind === 'failed'
                ? '重试撤销'
                : '撤销本次加入'}
          </button>
        )}
      </div>
    </article>
  );
}
