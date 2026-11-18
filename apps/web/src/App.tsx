import { capabilitiesValidator, readyValidator } from '@nextstop/core';
import type { Capabilities } from '@nextstop/core';
import { useEffect, useState } from 'react';
import { RadarPanel } from './RadarPanel.js';
import { LibraryPanel } from './LibraryPanel.js';

type Page = 'radar' | 'library' | 'trip' | 'settings';
const tabs: readonly { page: Page; label: string }[] = [
  { page: 'radar', label: '机会雷达' },
  { page: 'library', label: '灵感库' },
  { page: 'trip', label: '我的行程' },
  { page: 'settings', label: '我的' },
];

function currentPage() {
  return tabs.find(({ page }) => `#${page}` === window.location.hash)?.page ?? 'radar';
}

type Connection =
  | { kind: 'loading' }
  | { kind: 'ready'; capabilities: Capabilities }
  | { kind: 'failed' };

async function readHealth<T>(
  path: string,
  signal: AbortSignal,
  check: (body: unknown) => body is T,
) {
  const response = await fetch(path, { signal });
  if (!response.ok) throw new Error('Service unavailable');
  const body: unknown = await response.json();
  if (!check(body)) throw new Error('Invalid service response');
  return body;
}

export function App() {
  const [page, setPage] = useState(currentPage);
  useEffect(() => {
    function navigate() {
      setPage(currentPage());
      document.getElementById('screen')?.scrollTo(0, 0);
    }
    window.addEventListener('hashchange', navigate);
    return () => window.removeEventListener('hashchange', navigate);
  }, []);

  const [connection, setConnection] = useState<Connection>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    let disposed = false;
    setConnection({ kind: 'loading' });
    async function check() {
      try {
        const [, capabilities] = await Promise.all([
          readHealth('/health/ready', controller.signal, readyValidator.check),
          readHealth('/health/capabilities', controller.signal, capabilitiesValidator.check),
        ]);
        if (!disposed) setConnection({ kind: 'ready', capabilities });
      } catch {
        if (!disposed) setConnection({ kind: 'failed' });
      } finally {
        controller.abort();
        clearTimeout(timeout);
      }
    }
    void check();
    return () => {
      disposed = true;
      clearTimeout(timeout);
      controller.abort();
    };
  }, [attempt]);

  return (
    <div className="shell">
      <main id="screen">
        {connection.kind === 'ready' && (
          <RadarPanel
            capabilities={connection.capabilities}
            page={page === 'radar' || page === 'trip' ? page : null}
          />
        )}
        {connection.kind !== 'ready' && (page === 'radar' || page === 'trip') && (
          <header className="bar">
            <h1>{page === 'radar' ? '机会雷达' : '我的行程'}</h1>
          </header>
        )}
        {page === 'library' && connection.kind === 'ready' && (
          <LibraryPanel
            canImport={connection.capabilities.imports}
            canRead={connection.capabilities.trip_writes}
            canRecognize={connection.capabilities.model_calls}
          />
        )}
        {page === 'library' && connection.kind !== 'ready' && (
          <header className="bar">
            <h1>我的灵感库</h1>
          </header>
        )}
        {page === 'settings' && (
          <section className="profile-top">
            <h1>我的</h1>
            <p>访客模式 · 使用当前浏览器保存你的行程</p>
            <p>偏好及数据管理功能尚未开放。</p>
          </section>
        )}
        {(page === 'settings' || connection.kind !== 'ready') && (
          <section className="panel service padded-panel" aria-labelledby="service-heading">
            <h2 id="service-heading">服务连接</h2>
            <p role="status" className={`connection ${connection.kind}`}>
              {connection.kind === 'loading'
                ? '正在检查连接…'
                : connection.kind === 'ready'
                  ? '服务连接正常'
                  : '连接失败，请确认后端已启动'}
            </p>
            {connection.kind === 'ready' && (
              <p className="muted">
                雷达接口：{connection.capabilities.radar ? '已开放' : '待配置'} · 导入接口：
                {connection.capabilities.imports ? '已开放' : '待接入'}
              </p>
            )}
            <button
              className="secondary"
              type="button"
              onClick={() => setAttempt((value) => value + 1)}
              disabled={connection.kind === 'loading'}
            >
              重新检查连接 <span aria-hidden="true">↻</span>
            </button>
          </section>
        )}
      </main>
      <nav id="tabs" aria-label="一级导航">
        {tabs.map((tab) => (
          <a
            key={tab.page}
            href={`#${tab.page}`}
            aria-current={tab.page === page ? 'page' : undefined}
          >
            <span className={`nav-icon nav-${tab.page}`} aria-hidden="true" />
            {tab.label}
          </a>
        ))}
      </nav>
    </div>
  );
}
