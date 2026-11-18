import type { AnonymousData } from '@nextstop/core';
import { useEffect, useState, type ReactNode } from 'react';
import { ApiError, createSession } from './api.js';
import {
  deleteData,
  downloadData,
  readAnonymousData,
  type DeleteTarget,
} from './settings-client.js';
import './settings.css';

const emptyData: AnonymousData = { trips: [], places: [], uploads: [] };
const eraseAll: DeleteTarget = { kind: 'all' };

function SettingsSection({
  icon,
  title,
  hint,
  children,
}: {
  icon: string;
  title: string;
  hint: string;
  children: ReactNode;
}) {
  return (
    <details className="settings-row">
      <summary>
        <span className="settings-icon" aria-hidden="true">
          {icon}
        </span>
        <span>
          <strong>{title}</strong>
          <small>{hint}</small>
        </span>
        <span className="settings-chevron" aria-hidden="true">
          ›
        </span>
      </summary>
      <div className="settings-content">{children}</div>
    </details>
  );
}

function deleteMessage(target: DeleteTarget) {
  if (target.kind === 'all')
    return '删除当前访客的全部旅行、收藏、上传与本机离线行程。此操作无法撤销。';
  if (target.kind === 'image')
    return `删除「${target.label}」的原图、副本与来源记录。已确认的收藏会保留。`;
  return `删除「${target.label}」和该旅行独占的 ${target.exclusive} 张截图及派生记录。${target.shared} 张共享截图、已确认的收藏和其他旅行会保留。`;
}

function messageOf(error: unknown) {
  return error instanceof ApiError && error.status < 500 ? error.message : '服务暂不可用，请重试。';
}

export function SettingsPanel({ available }: { available: boolean }) {
  const [data, setData] = useState<AnonymousData | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [target, setTarget] = useState<DeleteTarget | null>(null);
  const [busy, setBusy] = useState(false);
  const [readError, setReadError] = useState('');
  const [actionError, setActionError] = useState('');
  const [notice, setNotice] = useState('');

  useEffect(() => {
    if (!available) {
      setData(null);
      return;
    }
    const controller = new AbortController();
    const { signal } = controller;
    setReadError('');
    void createSession(signal)
      .then(() => readAnonymousData(signal))
      .then(
        (value) => {
          if (!signal.aborted) setData(value);
        },
        (error: unknown) => {
          if (!signal.aborted) setReadError(messageOf(error));
        },
      );
    return () => controller.abort();
  }, [available, attempt]);

  function confirm(target: DeleteTarget) {
    setTarget(target);
    setActionError('');
    setNotice('');
  }

  async function run(action: () => Promise<void>, errorPrefix: string) {
    if (busy || !available) return;
    setBusy(true);
    setActionError('');
    setNotice('');
    try {
      await action();
    } catch (error) {
      setActionError(`${errorPrefix} ${messageOf(error)}`);
    } finally {
      setBusy(false);
    }
  }

  const sharedImages = new Set(
    data?.places.flatMap(({ sources }) => sources.map(({ import_id }) => import_id)),
  );
  return (
    <section className="settings-screen">
      <header className="settings-header">
        <div className="brand">
          <img src="/prototype/assets/logo.webp" alt="" />
          <span>
            NEXTSTOP <small>/ 下一站</small>
          </span>
        </div>
        <h1>我的</h1>
        <p>个人设置与数据管理</p>
      </header>
      <div className="settings-body">
        <section className="settings-guest">
          <strong>匿名使用 · 轻量出行助手</strong>
          <p>无需注册。你可以查看、导出或删除自己的数据。</p>
        </section>
        <div className="settings-group">
          <SettingsSection icon="☷" title="本次偏好与反馈" hint="仅当前雷达会话生效">
            <p>当前版本暂未开放反馈清除。</p>
          </SettingsSection>
          <SettingsSection icon="⌖" title="位置与隐私" hint="仅在主动使用定位时申请权限">
            <p>雷达使用一次性定位来计算路线，也支持手动选择出发地。应用不会持续在后台定位。</p>
            <p>
              上传攻略截图会保存原图及规范化副本，并将规范化图片交给已配置的识别服务。上传前请遮盖姓名、人脸、订单和联系方式。
            </p>
          </SettingsSection>
          <SettingsSection icon="▧" title="上传记录" hint="查看与删除自己上传的截图">
            {data &&
              (data.uploads.length ? (
                <ul className="settings-list">
                  {data.uploads.map((image) => (
                    <li key={image.import_id}>
                      <a
                        href={`/api/v1/${image.batch_id ? `import-batches/${encodeURIComponent(image.batch_id)}/items/` : 'imports/'}${encodeURIComponent(image.import_id)}/image`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {image.name || '攻略截图'}
                      </a>
                      <button
                        type="button"
                        className="settings-danger"
                        disabled={busy}
                        onClick={() =>
                          confirm({
                            kind: 'image',
                            id: image.import_id,
                            label: image.name || '攻略截图',
                          })
                        }
                      >
                        删除截图
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p>暂无上传记录。</p>
              ))}
          </SettingsSection>
          <a href="#library" className="settings-link">
            <span className="settings-icon" aria-hidden="true">
              ✎
            </span>
            <span>
              <strong>地点纠错</strong>
              <small>打开收藏详情，选择地图候选并确认更正</small>
            </span>
            <span className="settings-chevron" aria-hidden="true">
              ›
            </span>
          </a>
        </div>
        <div className="settings-group">
          <SettingsSection icon="▦" title="旅行数据" hint="管理或删除已保存旅行">
            {data &&
              (data.trips.length ? (
                <ul className="settings-list">
                  {data.trips.map((trip) => {
                    const name = trip.day
                      ? `${trip.day.destination} · ${trip.day.date}`
                      : '雷达行程';
                    const images = data.uploads.filter(({ trip_id }) => trip_id === trip.trip_id);
                    const shared = images.filter(({ import_id }) =>
                      sharedImages.has(import_id),
                    ).length;
                    return (
                      <li key={trip.trip_id}>
                        <span>{name}</span>
                        <button
                          type="button"
                          className="settings-danger"
                          disabled={busy}
                          onClick={() =>
                            confirm({
                              kind: 'trip',
                              id: trip.trip_id,
                              label: name,
                              exclusive: images.length - shared,
                              shared,
                            })
                          }
                        >
                          删除旅行
                        </button>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <p>暂无旅行。</p>
              ))}
          </SettingsSection>
          <SettingsSection
            icon="◇"
            title="第三方导航与数据说明"
            hint="外部地图、识别服务与保留方式"
          >
            <p>
              搜索地点和计算路线使用高德地图。主动打开导航会把目的地交给高德 App
              或网页，由其处理后续导航。
            </p>
            <p>
              匿名会话 Cookie 有效期为 30
              天。当前部署的原图、副本、识别记录和旅行保存在应用的数据目录，等待手动删除，当前版本没有自动过期清理。识别和地图供应商按其各自的条款处理数据。
            </p>
            <p>
              本机只保存最近查看的已保存行程用于弱网回读。离线时路线、营业和预约信息会标为过期。
            </p>
          </SettingsSection>
          <button
            className="settings-link"
            type="button"
            disabled={!available || !data || busy}
            onClick={() =>
              void run(async () => {
                await downloadData();
                setNotice('已开始下载匿名数据。');
              }, '导出失败。')
            }
          >
            <span className="settings-icon" aria-hidden="true">
              ↓
            </span>
            <span>
              <strong>导出匿名数据</strong>
              <small>下载旅行、收藏和可用的来源记录（JSON）</small>
            </span>
            <span className="settings-chevron" aria-hidden="true">
              ›
            </span>
          </button>
        </div>
        {!available && <p className="note">联网后可以查看和管理个人数据。</p>}
        {available && !data && !readError && <p role="status">正在读取个人数据…</p>}
        {readError && (
          <div className="note">
            <p role="alert">{readError}</p>
            <button
              type="button"
              className="secondary"
              onClick={() => setAttempt((value) => value + 1)}
            >
              重试读取
            </button>
          </div>
        )}
        {target ? (
          <section
            className="panel padded-panel settings-confirm"
            aria-labelledby="delete-data-title"
          >
            <h2 id="delete-data-title">确认删除数据</h2>
            <p>{deleteMessage(target)}</p>
            {actionError && <p role="alert">{actionError}</p>}
            <div className="settings-confirm-actions">
              <button
                type="button"
                className="secondary"
                disabled={busy}
                onClick={() => {
                  setTarget(null);
                  setActionError('');
                }}
              >
                取消
              </button>
              <button
                type="button"
                className="settings-danger"
                disabled={busy || !available}
                onClick={() =>
                  void run(async () => {
                    await deleteData(target);
                    setTarget(null);
                    setNotice(
                      target.kind === 'all'
                        ? '已删除全部匿名数据。'
                        : target.kind === 'trip'
                          ? '已删除此旅行。'
                          : '已删除此截图。',
                    );
                    if (target.kind === 'all') {
                      setData(emptyData);
                      setReadError('');
                    } else {
                      setData(null);
                      setAttempt((value) => value + 1);
                    }
                  }, '删除未能确认。可重试同一次删除。')
                }
              >
                {busy ? '正在删除…' : actionError ? '重试删除' : '确认删除'}
              </button>
            </div>
          </section>
        ) : (
          <button
            type="button"
            className="settings-danger settings-erase"
            disabled={!available || busy}
            onClick={() => confirm(eraseAll)}
          >
            删除全部匿名数据
          </button>
        )}
        {!target && actionError && (
          <p className="note" role="alert">
            {actionError}
          </p>
        )}
        {notice && (
          <p className="note" role="status">
            {notice}
          </p>
        )}
      </div>
    </section>
  );
}
