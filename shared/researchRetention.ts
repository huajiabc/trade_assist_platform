import type { Candle } from './market';
import type { MarketState } from './marketState';
import { RESEARCH_FRAMES } from './researchData';

export const RESEARCH_RETENTION = {
  snapshotsHigh: 48, snapshotsPerFrame: 8,
  eventsHigh: 4000, eventsRecent: 1600,
  historyHigh: 160, historyRecent: 64,
  evaluationsHigh: 96, evaluationsRecent: 24,
  interpretationsRecent: 8, factsHigh: 6000, factVersionsRecent: 2,
} as const;

export interface ResearchArchive {
  format: 'research-archive-1.0'; id: string; sessionId: string; symbol: string;
  archivedAt: number; throughVersion: number;
  snapshots: MarketState['snapshots']; facts: MarketState['facts'];
  events: MarketState['events']; history: MarketState['history'];
  evaluations: MarketState['evaluations']; interpretation: MarketState['interpretation'];
}
export interface ResearchArchiveSummary {
  format: 'research-archive-1.0'; chunks: number; lastArchivedAt: number; throughVersion: number;
}

const capacityNotice = (text: string) => text.startsWith('达到本地会话容量上限');
/** Migrate the old latch without changing a snapshot, version, AI interpretation,
 * price or position association. Real data-revision warnings remain intact. */
export function recoverResearchCapacity(state: MarketState): MarketState {
  if (!state.capacityReached && !state.needsReview.some(capacityNotice)) return state;
  return { ...state, capacityReached: false, needsReview: state.needsReview.filter(r => !capacityNotice(r)) };
}

/** Actual observed rows only. An internal gap in the newest input remains a gap;
 * archived rows must not silently fill an exchange correction/deletion. */
export function researchMinuteHistory(state: MarketState): Candle[] {
  const rows = new Map((state.trackingCandles ?? []).map(c => [c.timestamp, c]));
  const originalPlanFrames = new Set(state.plans.flatMap(p => p.versions.map(v => v.snapshotIds['1m'])));
  for (const frame of Object.values(state.snapshots).filter(f => f.timeframe === '1m')
    .sort((a, b) => (a.lastClosedTime ?? 0) - (b.lastClosedTime ?? 0) || a.observedAt - b.observedAt)) {
    for (const candle of frame.candles) {
      // An immutable plan-origin frame is deliberately old. It must not undo
      // newer raw observations retained when surrounding snapshots were archived.
      if (!originalPlanFrames.has(frame.id) || !rows.has(candle.timestamp)) rows.set(candle.timestamp, candle);
    }
  }
  const current = state.bundle.frames['1m'].candles;
  const times = new Set(current.map(c => c.timestamp));
  for (const time of rows.keys()) if (time >= (current[0]?.timestamp ?? Infinity)
    && time <= (current.at(-1)?.timestamp ?? -Infinity) && !times.has(time)) rows.delete(time);
  for (const candle of current) rows.set(candle.timestamp, candle);
  return [...rows.values()].sort((a, b) => a.timestamp - b.timestamp);
}

/** Tracking already stops after at most 300 pre-trigger + 300 post-trigger bars.
 * Preserve that exact raw evidence, independent of the rolling chart window. */
function trackingEvidence(state: MarketState): Candle[] {
  const ranges = state.plans.map(plan => plan.versions.at(-1)!.setup).map(setup => ({
    start: setup.anchorTime,
    end: setup.anchorTime + ((setup.tracking?.expiresAfterBars ?? 300) + 300) * 60,
  }));
  return ranges.length ? researchMinuteHistory(state).filter(c => ranges.some(r => c.timestamp > r.start && c.timestamp <= r.end)) : [];
}

/** Pure partition. Nothing here deletes persisted data. The caller must write
 * the archive AND the reduced workspace in the same successful transaction. */
export function partitionResearchHistory(input: MarketState, now = Date.now()): { state: MarketState; archive: Omit<ResearchArchive, 'id'> | null } {
  const state = recoverResearchCapacity(input), limits = RESEARCH_RETENTION;
  const needsArchive = input.capacityReached || Object.keys(state.snapshots).length > limits.snapshotsHigh
    || state.events.length > limits.eventsHigh || state.history.length > limits.historyHigh
    || state.evaluations.length > limits.evaluationsHigh || state.interpretation.length > limits.interpretationsRecent * 2
    || Object.keys(state.facts).length > limits.factsHigh
    || Object.values(state.facts).some(r => r.versions.length > 24);
  if (!needsArchive) return { state, archive: null };

  const interpretation = state.interpretation.slice(-limits.interpretationsRecent);
  const pinnedSnapshots = new Set(RESEARCH_FRAMES.map(tf => state.bundle.frames[tf].id));
  const pinnedEvents = new Set(state.plans.flatMap(p => p.versions.flatMap(v => v.eventIds)));
  const pinnedFacts = new Set(state.plans.flatMap(p => p.versions.flatMap(v => v.setup.structureIds)));
  for (const review of interpretation) {
    review.value.frames.forEach(f => f.evidenceIds.forEach(id => pinnedFacts.add(id)));
    review.value.conflicts.forEach(c => c.evidenceIds.forEach(id => pinnedFacts.add(id)));
    review.value.strategyReviews.forEach(c => c.opposingEvidenceIds.forEach(id => pinnedFacts.add(id)));
    review.value.positionReviews.forEach(p => [...p.evidenceIds, ...p.targetStructureIds, ...(p.stopStructureId ? [p.stopStructureId] : [])].forEach(id => pinnedFacts.add(id)));
  }
  for (const plan of state.plans) for (const version of plan.versions) Object.values(version.snapshotIds).forEach(id => pinnedSnapshots.add(id));
  const reviewBundles = new Set(interpretation.map(r => r.snapshotId));
  for (const row of state.history) if (reviewBundles.has(row.bundleId)) Object.values(row.frameIds).forEach(id => pinnedSnapshots.add(id));
  for (const tf of RESEARCH_FRAMES) Object.values(state.snapshots).filter(f => f.timeframe === tf)
    .sort((a, b) => b.observedAt - a.observedAt || (b.lastClosedTime ?? 0) - (a.lastClosedTime ?? 0))
    .slice(0, limits.snapshotsPerFrame).forEach(f => pinnedSnapshots.add(f.id));

  const events = state.events.filter((e, i) => i >= state.events.length - limits.eventsRecent || e.planId !== null || pinnedEvents.has(e.id));
  const eventIds = new Set(events.map(e => e.id));
  events.forEach(e => e.factIds.forEach(id => pinnedFacts.add(id)));
  const snapshots: MarketState['snapshots'] = {}, oldSnapshots: MarketState['snapshots'] = {};
  for (const [id, frame] of Object.entries(state.snapshots)) (pinnedSnapshots.has(id) ? snapshots : oldSnapshots)[id] = frame;
  const facts: MarketState['facts'] = {}, oldFacts: MarketState['facts'] = {};
  for (const [id, record] of Object.entries(state.facts)) {
    if (record.current || pinnedFacts.has(id)) {
      facts[id] = { ...record, versions: record.versions.slice(-limits.factVersionsRecent) };
      const older = record.versions.slice(0, -limits.factVersionsRecent);
      if (older.length) oldFacts[id] = { ...record, versions: older };
    } else oldFacts[id] = record;
  }
  const history = state.history.filter((h, i) => i >= state.history.length - limits.historyRecent || reviewBundles.has(h.bundleId));
  const keptHistory = new Set(history);
  const archive: Omit<ResearchArchive, 'id'> = {
    format: 'research-archive-1.0', sessionId: state.sessionId, symbol: state.symbol, archivedAt: now, throughVersion: state.version,
    snapshots: oldSnapshots, facts: oldFacts, events: state.events.filter(e => !eventIds.has(e.id)),
    history: state.history.filter(h => !keptHistory.has(h)), evaluations: state.evaluations.slice(0, -limits.evaluationsRecent),
    interpretation: state.interpretation.slice(0, -limits.interpretationsRecent),
  };
  const hasData = Object.keys(oldSnapshots).length || Object.keys(oldFacts).length || archive.events.length
    || archive.history.length || archive.evaluations.length || archive.interpretation.length;
  if (!hasData) return { state, archive: null };
  return { state: { ...state, snapshots, facts, events, history,
    evaluations: state.evaluations.slice(-limits.evaluationsRecent), interpretation,
    trackingCandles: trackingEvidence(state) }, archive };
}
