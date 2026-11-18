import {
  IMPORT_BATCH_MAX_IMAGES,
  IMPORT_IMAGE_MAX_BYTES,
  type ConfirmBatch,
  type ImportBatch,
  type ImportBatchItem,
  type Wishlist,
} from '@nextstop/core';
import { useEffect, useState } from 'react';
import { ApiError } from './api.js';
import { BatchReview, imageStatus, type ImageAction } from './BatchReview.js';
import {
  batchImagePath,
  editBatchItem,
  getBatch,
  removeBatchItem,
  saveBatchChoices,
  uploadBatch,
} from './import-batch-client.js';
import type { Choices, ReviewableImage } from './import-batch-review.js';
import { batchPointerKey as lastBatchKey } from './offline-trip.js';
import { getWishlist } from './wishlist-client.js';
import './import-batch.css';
const messageOf = (error: unknown) =>
  error instanceof ApiError ? error.message : '服务暂不可用，请重试。';
function lastBatch() {
  try {
    return sessionStorage.getItem(lastBatchKey);
  } catch {
    return null;
  }
}
function rememberBatch(id: string) {
  try {
    sessionStorage.setItem(lastBatchKey, id);
  } catch {
    /* The current screen can still use the batch. */
  }
}

function forgetBatch(id: string) {
  try {
    if (sessionStorage.getItem(lastBatchKey) === id) sessionStorage.removeItem(lastBatchKey);
  } catch {
    /* The current screen can still reset. */
  }
}

type SelectedImage = { id: string; file: File };

function LocalThumbnail({ file }: { file: File }) {
  const [src, setSrc] = useState('');
  useEffect(() => {
    const url = URL.createObjectURL(file);
    setSrc(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);
  return src && <img src={src} alt="" />;
}

function BatchProgress({
  batch,
  busy,
  edit,
  openReview,
}: {
  batch: ImportBatch;
  busy: boolean;
  edit: (item: ImportBatchItem, action: 'retry' | 'remove') => void;
  openReview: () => void;
}) {
  const total = batch.items.length;
  const processing = batch.items.filter(({ kind }) => kind === 'processing').length;
  const failures = batch.items.filter(({ kind }) => kind === 'failed' || kind === 'invalid').length;
  const ended = total - processing;
  const reviewable = batch.items.some(({ kind }) => kind === 'ready' || kind === 'failed');
  return (
    <>
      <div className="batch-drop batch-uploaded">
        <span className="upload-mark" aria-hidden="true">
          ✓
        </span>
        <strong>攻略截图已上传</strong>
        <small>可移除截图、重试或查看已处理结果</small>
      </div>
      <h2 className="batch-grid-heading">本批次 {total} 张截图</h2>
      <ul className="batch-grid">
        {batch.items.map((item) => (
          <li key={item.import_id}>
            <div className="batch-thumb">
              {item.kind !== 'invalid' && (
                <img src={batchImagePath(batch.batch_id, item.import_id)} alt="" />
              )}
              {item.kind !== 'saved' && (
                <button
                  className="batch-remove"
                  type="button"
                  aria-label={`移除 ${item.name}`}
                  disabled={busy}
                  onClick={() => edit(item, 'remove')}
                >
                  ×
                </button>
              )}
              {item.kind !== 'failed' && (
                <span className={`batch-image-status status-${item.kind}`}>
                  {imageStatus(item)}
                </span>
              )}
              {item.kind === 'failed' && (
                <button
                  className="batch-retry"
                  type="button"
                  aria-label={`重试 ${item.name}`}
                  disabled={busy}
                  onClick={() => edit(item, 'retry')}
                >
                  重试
                </button>
              )}
            </div>
            <span className="batch-filename" title={item.name}>
              {item.kind === 'failed' ? imageStatus(item) : item.name || '截图'}
            </span>
          </li>
        ))}
      </ul>
      <div className="panel batch-progress" role="status">
        <div className="library-between">
          <strong>{processing > 0 ? '正在提取地点…' : '本批次处理结束'}</strong>
          <span>
            已结束 {ended} / {total}
          </span>
        </div>
        {total > 0 && <progress max={total} value={ended} aria-label="已结束的截图" />}
        <p>
          已处理 {ended - failures} 张 · 处理中 {processing} 张 · 失败 {failures} 张
        </p>
      </div>
      <p className="note batch-source-note">确认后可从收藏核对截图来源。</p>
      <button
        className="primary full cta"
        type="button"
        disabled={!reviewable || busy}
        onClick={openReview}
      >
        {processing > 0 ? '查看已处理结果' : '查看识别结果'}
      </button>
    </>
  );
}

export function ImportBatchPanel({
  canRecognize,
  onBack,
  onManual,
}: {
  canRecognize: boolean;
  onBack: () => void;
  onManual: () => void;
}) {
  const [files, setFiles] = useState<SelectedImage[]>([]);
  const [batch, setBatch] = useState<ImportBatch | null>(null);
  const [resumable, setResumable] = useState(lastBatch);
  const [reviewing, setReviewing] = useState(false);
  const [choices, setChoices] = useState<Choices>(new Map());
  const [wishlist, setWishlist] = useState<Wishlist | null>(null);
  const [pending, setPending] = useState('');
  const busy = Boolean(pending);
  const [failure, setFailure] = useState('');
  const [pollError, setPollError] = useState('');
  const [notice, setNotice] = useState('');
  const batchId = batch?.batch_id;
  const processing = batch?.items.some(({ kind }) => kind === 'processing') ?? false;

  function acceptBatch(next: ImportBatch) {
    setBatch((prior) =>
      prior?.batch_id === next.batch_id && prior.revision > next.revision ? prior : next,
    );
  }

  useEffect(() => {
    document.getElementById('screen')?.scrollTo(0, 0);
  }, [batchId, reviewing]);

  useEffect(() => {
    if (!batchId || !processing) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function poll(id: string) {
      try {
        const current = await getBatch(id, controller.signal);
        if (controller.signal.aborted) return;
        setPollError('');
        // A late poll cannot restore a batch after its removal receipt reset the screen.
        setBatch((prior) =>
          prior?.batch_id === id && prior.revision <= current.revision ? current : prior,
        );
      } catch (error) {
        if (!controller.signal.aborted) setPollError(`无法刷新进度。${messageOf(error)}`);
      }
      if (!controller.signal.aborted) timer = setTimeout(() => void poll(id), 750);
    }
    timer = setTimeout(() => void poll(batchId), 400);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [batchId, processing]);

  async function run(message: string, action: () => Promise<void>) {
    if (busy) return;
    setPending(message);
    setFailure('');
    setNotice('');
    try {
      await action();
    } catch (error) {
      setFailure(messageOf(error));
      if (batchId && error instanceof ApiError && error.code === 'IMPORT_STALE') {
        try {
          acceptBatch(await getBatch(batchId));
          if (reviewing) setWishlist(await getWishlist());
        } catch (error) {
          setFailure(`读取最新结果失败。${messageOf(error)}`);
        }
      }
    } finally {
      setPending('');
    }
  }

  function choose(item: ReviewableImage, poiId: string) {
    setChoices((prior) =>
      new Map(prior).set(item.import_id, { reviewRevision: item.review.revision, poiId }),
    );
  }
  function edit(item: ImportBatchItem, action: ImageAction | { action: 'retry' }) {
    if (!batch) return;
    const message = {
      search: '正在搜索地点…',
      retry: '正在重试识别…',
      skip: '正在跳过截图…',
      remove: '正在移除截图…',
    }[action.action];
    void run(message, async () => {
      const input = { id: batch.batch_id, imageId: item.import_id, revision: batch.revision };
      const next =
        action.action === 'remove'
          ? await removeBatchItem(input)
          : await editBatchItem({ ...input, ...action });
      if (!next) {
        forgetBatch(input.id);
        setResumable((prior) => (prior === input.id ? null : prior));
        setBatch(null);
        setReviewing(false);
        setChoices(new Map());
        setWishlist(null);
        setPollError('');
        setNotice('截图已移除。');
        return;
      }
      acceptBatch(next);
      setChoices((prior) => {
        const next = new Map(prior);
        next.delete(item.import_id);
        return next;
      });
    });
  }
  function confirm(input: ConfirmBatch) {
    if (!batch) return;
    void run('正在保存收藏…', async () => {
      acceptBatch(await saveBatchChoices(batch.batch_id, input));
      setNotice(`已保存 ${input.selections.length} 张来源，新增 ${input.new_count} 处收藏。`);
      setWishlist(null);
      setWishlist(await getWishlist());
    });
  }
  function openReview() {
    setReviewing(true);
    void run('正在读取核对结果…', async () => setWishlist(await getWishlist()));
  }
  function back() {
    if (reviewing) {
      setReviewing(false);
      setFailure('');
    } else onBack();
  }
  function addFiles(incoming: FileList | null) {
    const next = [...(incoming ?? [])];
    const supported = next.filter(
      (file) =>
        file.size <= IMPORT_IMAGE_MAX_BYTES && ['image/jpeg', 'image/png'].includes(file.type),
    );
    const slots = IMPORT_BATCH_MAX_IMAGES - files.length;
    const accepted = supported.slice(0, slots).map((file) => ({ id: crypto.randomUUID(), file }));
    setFiles((prior) => [...prior, ...accepted]);
    const messages = [];
    if (next.length > supported.length) messages.push('已略过非 PNG / JPEG 或超过 5 MB 的图片。');
    if (supported.length > slots) messages.push(`每批最多 ${IMPORT_BATCH_MAX_IMAGES} 张。`);
    setFailure(messages.join(''));
  }
  const stage = reviewing ? 2 : batch ? 1 : 0;
  return (
    <section className={`library-screen batch-screen${reviewing ? ' batch-review-screen' : ''}`}>
      <header className="bar library-heading">
        <button
          className="library-back"
          type="button"
          aria-label={reviewing ? '返回批次进度' : '返回灵感库'}
          onClick={back}
          disabled={busy}
        ></button>
        <h1>{reviewing ? '确认识别的地点' : '导入攻略截图'}</h1>
      </header>
      <ol className="batch-steps" aria-label="导入步骤">
        {['上传截图', 'AI 提取地点', '统一确认'].map((step, index) => (
          <li
            key={step}
            aria-current={index === stage ? 'step' : undefined}
            className={index < stage && (index !== 1 || !processing) ? 'complete' : undefined}
          >
            {step}
          </li>
        ))}
      </ol>
      {failure && (
        <p className="note batch-error state-card state-error" role="alert">
          {failure}
        </p>
      )}
      {batch && pollError && (
        <p className="note batch-error state-card state-error" role="alert">
          {pollError}
        </p>
      )}
      <div role="status">
        {(pending || notice) && (
          <p className="note state-card" data-state={pending ? 'pending' : 'success'}>
            {pending || notice}
          </p>
        )}
      </div>
      {!batch && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (!files.length) return;
            void run('正在上传并校验截图…', async () => {
              const next = await uploadBatch(files.map(({ file }) => file));
              rememberBatch(next.batch_id);
              setResumable(next.batch_id);
              setFiles([]);
              acceptBatch(next);
            });
          }}
        >
          <p className="note" id="batch-privacy">
            上传前请遮挡不想分享的昵称、人脸、订单或联系方式。截图会发送给视觉服务识别苏州地点，确认后可从收藏查看来源。
          </p>
          {!canRecognize && (
            <p className="note">自动识别暂未配置，上传后可以手动搜索并保留截图来源。</p>
          )}
          <label className="library-drop batch-drop">
            <span className="upload-mark" aria-hidden="true">
              ⇧
            </span>
            <strong>{files.length ? '继续添加截图' : '批量上传攻略截图'}</strong>
            <small>攻略、地图截图或旅行笔记</small>
            <small>PNG 或 JPEG · 每张最多 5 MB · 每批最多 {IMPORT_BATCH_MAX_IMAGES} 张</small>
            <input
              type="file"
              accept="image/png,image/jpeg"
              aria-label="选择攻略截图"
              aria-describedby="batch-privacy"
              multiple
              disabled={busy}
              onChange={(event) => {
                addFiles(event.currentTarget.files);
                event.currentTarget.value = '';
              }}
            />
          </label>
          {files.length > 0 && (
            <>
              <h2 className="batch-grid-heading">已选择 {files.length} 张图片</h2>
              <ul className="batch-grid">
                {files.map(({ id, file }) => (
                  <li key={id}>
                    <div className="batch-thumb">
                      <LocalThumbnail file={file} />
                      <button
                        className="batch-remove"
                        type="button"
                        disabled={busy}
                        aria-label={`移除 ${file.name}`}
                        onClick={() => setFiles((prior) => prior.filter((item) => item.id !== id))}
                      >
                        ×
                      </button>
                    </div>
                    <span className="batch-filename" title={file.name}>
                      {file.name}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
          <button className="primary full cta" type="submit" disabled={!files.length || busy}>
            {busy ? '正在上传并校验…' : '上传并识别'}
          </button>
          {resumable && (
            <button
              className="secondary full"
              type="button"
              disabled={busy}
              onClick={() =>
                void run('正在读取上次导入…', async () => {
                  try {
                    acceptBatch(await getBatch(resumable));
                  } catch (error) {
                    if (error instanceof ApiError && error.status === 404) setResumable(null);
                    throw error;
                  }
                })
              }
            >
              继续上次导入
            </button>
          )}
          <button className="secondary full" type="button" disabled={busy} onClick={onManual}>
            手动搜索地点
          </button>
        </form>
      )}
      {batch &&
        (reviewing ? (
          <>
            {failure && (
              <button
                className="secondary full"
                type="button"
                disabled={busy}
                onClick={() =>
                  void run('正在读取核对结果…', async () => {
                    acceptBatch(await getBatch(batch.batch_id));
                    setWishlist(await getWishlist());
                  })
                }
              >
                刷新核对结果
              </button>
            )}
            <BatchReview
              batch={batch}
              choices={choices}
              choose={choose}
              edit={edit}
              wishlist={wishlist}
              busy={busy}
              confirm={confirm}
              onBack={onBack}
            />
          </>
        ) : (
          <BatchProgress
            batch={batch}
            busy={busy}
            edit={(item, action) => edit(item, { action })}
            openReview={openReview}
          />
        ))}
    </section>
  );
}
