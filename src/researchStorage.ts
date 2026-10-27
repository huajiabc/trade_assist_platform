import { exportResearchState, type MarketState } from '../shared/marketState';
import { partitionResearchHistory, type ResearchArchive } from '../shared/researchRetention';

// A separate key namespace preserves the existing IndexedDB v1 store and workspaces.
const NAME = 'pa-smc-research', STORE = 'workspaces';
const archivePrefix = (key: string) => 'archive:' + key + ':';
const writes = new Map<string, Promise<MarketState>>();
function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onerror = () => reject(new Error('浏览器研究存储不可用，请导出当前研究记录备份。'));
    request.onsuccess = () => resolve(request.result);
  });
}
function storageError(error: DOMException | null) {
  return new Error(error?.name === 'QuotaExceededError'
    ? '浏览器本地空间不足，历史归档未完成；当前记录仍保留在内存，请导出备份并释放浏览器存储空间。'
    : '研究记录保存或归档失败；当前记录仍保留在内存，请重试或导出备份。');
}
async function persist(key: string, input: MarketState): Promise<MarketState> {
  const db = await database();
  try {
    return await new Promise<MarketState>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite'), store = tx.objectStore(STORE);
      let saved = input;
      const request = store.get(key);
      request.onsuccess = () => {
        try {
          const previous = request.result as MarketState | undefined;
          if (previous?.sessionId === input.sessionId && previous.version > input.version) { saved = previous; return; }
          if (previous?.sessionId === input.sessionId && previous.version === input.version
            && previous.archive?.throughVersion === input.version && (previous.archive?.chunks ?? 0) > (input.archive?.chunks ?? 0)) { saved = previous; return; }
          const partition = partitionResearchHistory(input);
          saved = partition.state;
          const existingArchive = previous?.sessionId === input.sessionId && (previous.archive?.chunks ?? 0) > (saved.archive?.chunks ?? 0)
            ? previous.archive : saved.archive;
          if (existingArchive !== saved.archive) saved = { ...saved, archive: existingArchive };
          if (partition.archive) {
            const archive: ResearchArchive = { ...partition.archive, id: crypto.randomUUID() };
            store.put(archive, archivePrefix(key) + archive.id);
            saved = { ...saved, archive: { format: 'research-archive-1.0', chunks: (existingArchive?.chunks ?? 0) + 1,
              lastArchivedAt: archive.archivedAt, throughVersion: archive.throughVersion } };
          }
          // Archive and reduced working state commit atomically. On failure the
          // caller keeps the complete in-memory state and can still export it.
          store.put(saved, key);
        } catch { tx.abort(); }
      };
      tx.oncomplete = () => resolve(saved);
      tx.onabort = tx.onerror = () => reject(storageError(tx.error));
    });
  } finally { db.close(); }
}
export function saveResearchState(key: string, state: MarketState): Promise<MarketState> {
  const task = (writes.get(key) ?? Promise.resolve()).catch(() => undefined).then(() => persist(key, state));
  writes.set(key, task);
  void task.finally(() => { if (writes.get(key) === task) writes.delete(key); }).catch(() => undefined);
  return task;
}
export async function loadResearchState(key: string): Promise<MarketState | null> {
  const db = await database();
  try {
    return await new Promise((resolve, reject) => {
      const request = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
      request.onerror = () => reject(new Error('本地研究记录读取失败。'));
      request.onsuccess = () => {
        const state = request.result;
        if (state === undefined) return resolve(null);
        if (state?.schemaVersion !== 'market-state-1.0' || !Array.isArray(state.events) || !Array.isArray(state.history)
          || !state.bundle || !state.snapshots || !Array.isArray(state.plans)) return reject(new Error('本地研究记录版本或结构不支持，请保留记录并导出备份。'));
        resolve(state);
      };
    });
  } finally { db.close(); }
}
/** User-initiated export reads the working state and all archives in one stable
 * transaction. It remains available if persisting the latest state failed. */
export async function exportStoredResearchState(key: string, state: MarketState) {
  let persisted = true;
  try { await saveResearchState(key, state); } catch { persisted = false; }
  const db = await database();
  try {
    return await new Promise<ReturnType<typeof exportResearchState> & { archiveFormat: 'research-archive-1.0'; archives: ResearchArchive[] }>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly'), store = tx.objectStore(STORE), archives: ResearchArchive[] = [];
      let current = state;
      const request = store.get(key);
      request.onsuccess = () => {
        const saved = request.result as MarketState | undefined;
        if (persisted && saved?.sessionId === state.sessionId && saved.version >= state.version) current = saved;
      };
      const prefix = archivePrefix(key), cursor = store.openCursor(IDBKeyRange.bound(prefix, prefix + '\uffff'));
      cursor.onsuccess = () => { const next = cursor.result; if (next) { archives.push(next.value); next.continue(); } };
      tx.oncomplete = () => resolve({ ...exportResearchState(current), archiveFormat: 'research-archive-1.0', archives,
        semantics: '工作区保留当前状态和计划；archives保留自动归档的原始快照、事实版本、策略评估、解释和事件。按sessionId、结构ID及原始版本/时间关联，归档不提前确认结构，不改写价位，不代表成交。' });
      tx.onabort = tx.onerror = () => reject(storageError(tx.error));
    });
  } finally { db.close(); }
}
export async function clearResearchState(key: string): Promise<void> {
  await writes.get(key)?.catch(() => undefined);
  const db = await database();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(key); // Existing archive chunks remain preserved.
      tx.oncomplete = () => resolve();
      tx.onabort = tx.onerror = () => reject(new Error('当前研究记录清理失败。'));
    });
  } finally { db.close(); }
}
