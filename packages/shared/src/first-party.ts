// Gutad first-party selling: Gutad's own locations (organization kind PLATFORM) are sold through the same
// catalog, search and checkout as merchants. They differ in three ways, all set from the admin panel:
// money (Gutad is the seller of record: no commission, no payout), labels, and how search ranks them.

export const FIRST_PARTY_ORG_KIND = 'PLATFORM';

export const FIRST_PARTY_RANKING_MODES = ['NEUTRAL', 'BOOST', 'PINNED', 'EXCLUDED'] as const;
export type FirstPartyRankingMode = (typeof FIRST_PARTY_RANKING_MODES)[number];
export const FIRST_PARTY_RANKING_LABELS: Record<FirstPartyRankingMode, string> = {
  NEUTRAL: 'Neutral: same rules as every merchant',
  BOOST: 'Boost: move Gutad results up a number of places',
  PINNED: 'Pinned: fixed positions on the first page',
  EXCLUDED: 'Excluded: not in search (direct links still work)',
};

export interface FirstPartyRules {
  /** Kill switch. false hides Gutad's own locations everywhere and blocks new orders from them. */
  enabled: boolean;
  ranking: FirstPartyRankingMode;
  /** BOOST: how many places a Gutad result may move up (never above sponsored results). */
  boostPositions: number;
  /** PINNED: 1-based positions among the first page's organic (unsponsored) results. */
  pinSlots: number[];
  /** At most this share of the first page may be Gutad results (100 = no cap). */
  maxFirstPageSharePct: number;
  /** Whether Gutad locations may take sponsored placements (bids). */
  allowSponsored: boolean;
  /** Customer-facing label on cards, the location page and checkout. */
  label: string;
  /** Commission rate a merchant would have paid on the same sales; used only in reports. */
  shadowCommissionBps: number;
}

export interface FirstPartyPolicy extends FirstPartyRules {
  /** Overrides per city (lower-case city name). */
  cities: Record<string, Partial<FirstPartyRules>>;
}

export const DEFAULT_FIRST_PARTY_POLICY: FirstPartyPolicy = {
  enabled: true,
  ranking: 'NEUTRAL',
  boostPositions: 3,
  pinSlots: [],
  maxFirstPageSharePct: 30,
  allowSponsored: false,
  label: 'Sold by Gutad',
  shadowCommissionBps: 1500,
  cities: {},
};

/** The rules that apply in a city: the global policy with that city's overrides on top. */
export function firstPartyRulesFor(p: FirstPartyPolicy, city?: string | null): FirstPartyRules {
  const { cities, ...base } = { ...DEFAULT_FIRST_PARTY_POLICY, ...p };
  const over = city ? cities?.[city.trim().toLowerCase()] : undefined;
  return { ...base, ...(over || {}) };
}

/** Plain-language summary for the public ranking-policy page and the admin preview. */
export function describeFirstPartyRules(r: FirstPartyRules): string[] {
  const out: string[] = [];
  if (!r.enabled) return ['Gutad is not selling its own food right now.'];
  out.push(`Food Gutad sells itself is always labelled "${r.label}".`);
  if (r.ranking === 'NEUTRAL') out.push('Gutad results are ranked by exactly the same rules as every restaurant.');
  if (r.ranking === 'BOOST') out.push(`Gutad results can move up at most ${r.boostPositions} place${r.boostPositions === 1 ? '' : 's'} and never above sponsored results.`);
  if (r.ranking === 'PINNED') out.push(r.pinSlots.length ? `Gutad results may take position${r.pinSlots.length === 1 ? '' : 's'} ${r.pinSlots.join(', ')} among the first page's unsponsored results.` : 'No positions are reserved for Gutad.');
  if (r.ranking === 'EXCLUDED') out.push('Gutad results are left out of search.');
  if (r.ranking !== 'EXCLUDED' && r.maxFirstPageSharePct < 100) out.push(`Gutad results take at most ${r.maxFirstPageSharePct}% of the first page.`);
  out.push(r.allowSponsored ? 'Gutad may buy sponsored placements on the same terms as restaurants; they are marked Sponsored.' : 'Gutad does not buy sponsored placements.');
  out.push("Gutad's own kitchens never see individual restaurants' sales, menu performance or customer data.");
  return out;
}

export interface RankableResult {
  firstParty?: boolean;
  sponsored?: boolean;
}

/**
 * Applies the first-party rules to results already sorted by the neutral ranking. Returns a new list and, for each
 * moved or removed result, the reason (shown in the admin preview). Pure: the same input always gives the same order.
 */
export function applyFirstPartyRanking<T extends RankableResult>(sorted: T[], r: FirstPartyRules, pageSize: number): { items: T[]; why: Map<T, string[]> } {
  const why = new Map<T, string[]>();
  const note = (i: T, s: string) => why.set(i, [...(why.get(i) || []), s]);
  if (!r.enabled || r.ranking === 'EXCLUDED') {
    return { items: sorted.filter((i) => !i.firstParty), why };
  }
  let list = [...sorted];
  const leadSponsored = () => { let n = 0; while (n < list.length && list[n].sponsored) n++; return n; };

  if (r.ranking === 'BOOST' && r.boostPositions > 0) {
    for (let idx = 0; idx < list.length; idx++) {
      const it = list[idx];
      if (!it.firstParty || it.sponsored) continue;
      let to = idx;
      let moved = 0;
      while (to > 0 && moved < r.boostPositions && !list[to - 1].sponsored && !list[to - 1].firstParty) { to--; moved++; }
      if (to !== idx) {
        list.splice(idx, 1);
        list.splice(to, 0, it);
        note(it, `boosted up ${moved} place${moved === 1 ? '' : 's'}`);
      }
    }
  }

  if (r.ranking === 'PINNED' && r.pinSlots.length) {
    const slots = [...new Set(r.pinSlots.filter((s) => Number.isInteger(s) && s >= 1 && s <= pageSize))].sort((a, b) => a - b);
    const fp = list.filter((i) => i.firstParty && !i.sponsored);
    const pinned = fp.slice(0, slots.length);
    if (pinned.length) {
      list = list.filter((i) => !pinned.includes(i));
      const base = leadSponsored();
      pinned.forEach((it, k) => {
        const at = Math.min(base + slots[k] - 1, list.length);
        list.splice(at, 0, it);
        note(it, `pinned to organic position ${slots[k]}`);
      });
    }
  }

  const pct = Math.max(0, Math.min(100, r.maxFirstPageSharePct));
  if (pct < 100) {
    const allowed = Math.floor((pct / 100) * pageSize);
    const first = list.slice(0, pageSize);
    const fpFirst = first.filter((i) => i.firstParty);
    if (fpFirst.length > allowed) {
      const demote = fpFirst.slice(allowed);
      const rest = list.filter((i) => !demote.includes(i));
      // the first page fills with the next results; demoted Gutad results open page two in their order
      list = [...rest.slice(0, pageSize), ...demote, ...rest.slice(pageSize)];
      for (const d of demote) note(d, `moved off the first page (Gutad share capped at ${pct}%)`);
    }
  }
  return { items: list, why };
}
