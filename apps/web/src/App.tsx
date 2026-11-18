import { capabilitiesValidator, readyValidator } from '@nextstop/core';
import type { Capabilities } from '@nextstop/core';
import { useEffect, useState } from 'react';
import { RadarPanel } from './RadarPanel.js';

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
    <main>
      <header>
        <a className="brand" href="/" aria-label="下一站首页">
          <span className="brand-mark" aria-hidden="true">
            ↗
          </span>{' '}
          下一站
        </a>
        <span className="preview">苏州 · 步行</span>
      </header>
      <section className="intro">
        <p className="eyebrow">NEXTSTOP / 现在去哪</p>
        <h1>
          给旅途中的空档，
          <br />
          找一个合适的下一站。
        </h1>
        <p className="lead">选个想去的地点，算一算眼前的空档够不够步行前往和停留。</p>
      </section>
      {connection.kind === 'ready' && <RadarPanel capabilities={connection.capabilities} />}
      <section className="panel service" aria-labelledby="service-heading">
        <div className="panel-heading">
          <h2 id="service-heading">服务连接</h2>
        </div>
        <p role="status" className={`connection ${connection.kind}`}>
          <span className="dot" aria-hidden="true" />
          {connection.kind === 'loading'
            ? '正在检查连接…'
            : connection.kind === 'ready'
              ? '服务连接正常'
              : '连接失败，请确认后端已启动'}
        </p>
        {connection.kind === 'ready' && (
          <p className="detail">
            雷达接口：{connection.capabilities.radar ? '已开放' : '待配置'} · 导入接口：
            {connection.capabilities.imports ? '已开放' : '待接入'}
          </p>
        )}
        <button
          type="button"
          onClick={() => setAttempt((value) => value + 1)}
          disabled={connection.kind === 'loading'}
        >
          重新检查连接 <span aria-hidden="true">↻</span>
        </button>
      </section>
      <footer>
        NextStop · 苏州首站 <span>每一次推荐，都从真实证据开始。</span>
      </footer>
    </main>
  );
}
