/**
 * Dish customization engine shared by the API (validation and pricing), web and mobile (live price and checks).
 * Quantities are sent as repeated option ids, so carts, quotes and orders keep their existing shape:
 *   ["mushroom", "mushroom"] = two mushroom portions.
 *
 * Selection types
 *   CHOICE   legacy restaurant groups: pick between minSelect and maxSelect distinct options
 *   SINGLE   choose one (radio cards / segmented buttons); a default option applies when nothing is chosen
 *   LEVEL    None / Light / Standard / Extra style single choice
 *   MULTI    checkboxes with visible prices; minSelect..maxSelect distinct options
 *   QUANTITY −/+ portions per option (up to maxQty each); minSelect..maxSelect total portions
 *   INCLUDED locked components shown for transparency; never selectable or charged
 * Conditional groups (parentOptionId) apply only when that option is chosen. Option rules override the
 * price, the max quantity or availability of an option when another option is chosen (e.g. size Large).
 */

export const MOD_SELECTION_TYPES = ['CHOICE', 'SINGLE', 'LEVEL', 'MULTI', 'QUANTITY', 'INCLUDED'] as const;
export type ModSelectionType = (typeof MOD_SELECTION_TYPES)[number];

export interface ModOptionRule { maxQty?: number; priceCents?: number; hidden?: boolean }

export interface ModOption {
  id: string;
  name: string;
  priceCents: number;
  soldOut?: boolean;
  isDefault?: boolean;
  maxQty?: number;
  portionDesc?: string | null;
  prepMinutesDelta?: number;
  addsAllergens?: string[];
  removesDietaryTags?: string[];
  locked?: boolean;
  description?: string | null;
  searchTerms?: string[];
  /** keyed by another option id: applies while that option is chosen */
  rules?: Record<string, ModOptionRule>;
}

export interface ModGroup {
  id: string;
  name: string;
  minSelect: number;
  maxSelect: number;
  required: boolean;
  selectionType?: ModSelectionType;
  parentOptionId?: string | null;
  description?: string | null;
  templateKey?: string | null;
  /** the dish's approved extras (found through ingredient search) */
  isExtras?: boolean;
  options: ModOption[];
}

export interface ChosenModifier { id: string; name: string; qty: number; unitPriceCents: number; priceCents: number; groupId: string }

export interface CustomizationResult {
  ok: boolean;
  errors: string[];
  chosen: ChosenModifier[];
  /** per dish unit */
  modifiersCents: number;
  allergens: string[];
  dietaryTags: string[];
  /** dietary labels the selections removed (e.g. shrimp removes "vegetarian") */
  removedDietaryTags: string[];
  prepMinutesDelta: number;
  /** ids of groups that apply to the current selection (conditional groups included only when unlocked) */
  activeGroupIds: string[];
  /** option ids as the API expects them (defaults filled in, quantities repeated) */
  optionIds: string[];
}

/** Allergens that make dietary labels false regardless of what the chef typed. */
const ALLERGEN_BREAKS: Record<string, string[]> = {
  milk: ['vegan', 'dairy_free'],
  egg: ['vegan'],
  fish: ['vegetarian', 'vegan'],
  shellfish: ['vegetarian', 'vegan'],
  wheat: ['gluten_free'],
  gluten: ['gluten_free'],
  peanuts: ['nut_free'],
  tree_nuts: ['nut_free'],
};

export const isSelectableType = (t: ModSelectionType | undefined) => t !== 'INCLUDED';

function count(ids: string[]) {
  const m = new Map<string, number>();
  for (const id of ids) m.set(id, (m.get(id) || 0) + 1);
  return m;
}

export function evaluateCustomization(itemName: string, groups: ModGroup[], optionIds: string[], base: { allergens: string[]; dietaryTags: string[] } = { allergens: [], dietaryTags: [] }): CustomizationResult {
  const errors: string[] = [];
  const counts = count(optionIds);
  const owner = new Map<string, { g: ModGroup; o: ModOption }>();
  for (const g of groups) for (const o of g.options) owner.set(o.id, { g, o });
  for (const id of counts.keys()) if (!owner.has(id)) errors.push(`Unknown option for ${itemName}`);

  // legacy groups ignore repeats, as before
  for (const g of groups) if ((g.selectionType || 'CHOICE') === 'CHOICE') for (const o of g.options) if ((counts.get(o.id) || 0) > 1) counts.set(o.id, 1);
  // locked components are never chosen
  for (const g of groups) for (const o of g.options) if (o.locked || g.selectionType === 'INCLUDED') counts.delete(o.id);

  const selected = () => new Set([...counts.keys()].filter((id) => (counts.get(id) || 0) > 0));
  const active: ModGroup[] = [];
  for (const g of groups) {
    const t = g.selectionType || 'CHOICE';
    const on = !g.parentOptionId || selected().has(g.parentOptionId);
    if (!on) {
      const stray = g.options.filter((o) => counts.has(o.id));
      if (stray.length) {
        const parent = owner.get(g.parentOptionId!)?.o.name;
        errors.push(`${stray[0].name} is only available with ${parent || 'another choice'}`);
        for (const o of stray) counts.delete(o.id);
      }
      continue;
    }
    active.push(g);
    if ((t === 'SINGLE' || t === 'LEVEL') && !g.options.some((o) => counts.has(o.id))) {
      const d = g.options.find((o) => o.isDefault && !o.soldOut);
      if (d) counts.set(d.id, 1);
    }
  }

  const sel = selected();
  const ruleFor = (o: ModOption): ModOptionRule => {
    let r: ModOptionRule = {};
    for (const [when, rule] of Object.entries(o.rules || {})) if (sel.has(when)) r = { ...r, ...rule };
    return r;
  };

  const chosen: ChosenModifier[] = [];
  let prep = 0;
  const addAllergens = new Set<string>();
  const removeTags = new Set<string>();
  for (const g of active) {
    const t = g.selectionType || 'CHOICE';
    if (t === 'INCLUDED') continue;
    const picks = g.options.filter((o) => (counts.get(o.id) || 0) > 0);
    const distinct = picks.length;
    const total = picks.reduce((a, o) => a + (counts.get(o.id) || 0), 0);
    const min = Math.max(g.minSelect, g.required ? 1 : 0);
    if (t === 'SINGLE' || t === 'LEVEL') {
      if (distinct > 1) errors.push(`${itemName}: choose one ${g.name}`);
      if (picks.some((o) => (counts.get(o.id) || 0) > 1)) errors.push(`${itemName}: choose one ${g.name}`);
      if (distinct < min) errors.push(`${itemName}: choose ${g.name}`);
    } else if (t === 'QUANTITY') {
      if (total < min) errors.push(`${itemName}: add at least ${min} ${g.name}`);
      if (g.maxSelect > 0 && total > g.maxSelect) errors.push(`${itemName}: at most ${g.maxSelect} ${g.name} in total`);
    } else {
      if (picks.some((o) => (counts.get(o.id) || 0) > 1)) errors.push(`${itemName}: ${g.name} options can be chosen once each`);
      if (distinct < min) errors.push(min === 1 ? `${itemName}: choose ${g.name}` : `${itemName}: choose at least ${min} ${g.name}`);
      if (distinct > g.maxSelect) errors.push(`${itemName}: choose at most ${g.maxSelect} ${g.name}`);
    }
    for (const o of picks) {
      const r = ruleFor(o);
      const qty = t === 'QUANTITY' ? counts.get(o.id) || 0 : 1;
      const maxQty = r.maxQty ?? o.maxQty ?? (t === 'QUANTITY' ? 10 : 1);
      if (r.hidden) errors.push(`${o.name} is not available with your other choices`);
      if (o.soldOut) errors.push(`${o.name} is sold out`);
      if (t === 'QUANTITY' && qty > maxQty) errors.push(`${o.name}: at most ${maxQty}`);
      const unit = r.priceCents ?? o.priceCents;
      chosen.push({ id: o.id, name: o.name, qty, unitPriceCents: unit, priceCents: unit * qty, groupId: g.id });
      prep += (o.prepMinutesDelta || 0) * qty;
      for (const a of o.addsAllergens || []) addAllergens.add(a);
      for (const d of o.removesDietaryTags || []) removeTags.add(d);
    }
  }
  const allergens = Array.from(new Set([...base.allergens, ...addAllergens]));
  for (const a of addAllergens) for (const d of ALLERGEN_BREAKS[a] || []) removeTags.add(d);
  const dietaryTags = base.dietaryTags.filter((d) => !removeTags.has(d));
  const optionIds2 = chosen.flatMap((c) => Array(c.qty).fill(c.id) as string[]);
  return {
    ok: errors.length === 0,
    errors: Array.from(new Set(errors)),
    chosen,
    modifiersCents: chosen.reduce((a, c) => a + c.priceCents, 0),
    allergens,
    dietaryTags,
    removedDietaryTags: base.dietaryTags.filter((d) => removeTags.has(d)),
    prepMinutesDelta: prep,
    activeGroupIds: active.map((g) => g.id),
    optionIds: optionIds2,
  };
}

/** Human label for a chosen modifier ("Mushrooms ×2"). */
export const modifierLabel = (c: { name: string; qty?: number }) => (c.qty && c.qty > 1 ? `${c.name} ×${c.qty}` : c.name);

// ───────────────────────── chef option builder ─────────────────────────

/** A dish's option configuration as the chef edits it (materialized into modifier groups on approval). */
export interface OptionsConfigGroup {
  id: string;
  name: string;
  selectionType: Exclude<ModSelectionType, 'CHOICE'>;
  required: boolean;
  minSelect: number;
  maxSelect: number;
  description?: string | null;
  templateKey?: string | null;
  parentOptionId?: string | null;
  options: (Omit<ModOption, 'soldOut'> & { soldOut?: boolean })[];
}

const uuid = () => (globalThis.crypto && 'randomUUID' in globalThis.crypto ? globalThis.crypto.randomUUID() : `${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 10)}-4${Math.random().toString(16).slice(2, 5)}-a${Math.random().toString(16).slice(2, 5)}-${Math.random().toString(16).slice(2, 14).padEnd(12, '0')}`);

const opt = (name: string, priceCents = 0, extra: Partial<ModOption> = {}) => ({ id: uuid(), name, priceCents, ...extra });

/** Reusable starting points; the chef edits names, prices and limits afterwards. */
export const CHEF_OPTION_TEMPLATES: { key: string; label: string; hint: string; build: () => OptionsConfigGroup }[] = [
  { key: 'portion', label: 'Portion size', hint: 'Regular / Large', build: () => ({ id: uuid(), name: 'Portion size', selectionType: 'SINGLE', required: true, minSelect: 1, maxSelect: 1, templateKey: 'portion', options: [opt('Regular', 0, { isDefault: true }), opt('Large', 500, { portionDesc: '+50%' })] }) },
  { key: 'protein', label: 'Choose protein', hint: 'Beef / Chicken / …', build: () => ({ id: uuid(), name: 'Protein', selectionType: 'SINGLE', required: true, minSelect: 1, maxSelect: 1, templateKey: 'protein', options: [opt('Beef', 0, { isDefault: true }), opt('Chicken', 0), opt('Shrimp', 400, { addsAllergens: ['shellfish'] })] }) },
  { key: 'spice', label: 'Spice level', hint: 'Mild / Medium / Hot', build: () => ({ id: uuid(), name: 'Spice level', selectionType: 'LEVEL', required: true, minSelect: 1, maxSelect: 1, templateKey: 'spice', options: [opt('Mild'), opt('Medium', 0, { isDefault: true }), opt('Hot')] }) },
  { key: 'sauce', label: 'Sauce amount', hint: 'None / Light / Standard / Extra', build: () => ({ id: uuid(), name: 'Sauce', selectionType: 'LEVEL', required: true, minSelect: 1, maxSelect: 1, templateKey: 'sauce', options: [opt('None'), opt('Light'), opt('Standard', 0, { isDefault: true }), opt('Extra', 150)] }) },
  { key: 'cheese', label: 'Cheese amount', hint: 'None / Standard / Extra', build: () => ({ id: uuid(), name: 'Cheese', selectionType: 'LEVEL', required: true, minSelect: 1, maxSelect: 1, templateKey: 'cheese', options: [opt('None'), opt('Standard', 0, { isDefault: true }), opt('Extra', 200, { addsAllergens: ['milk'] })] }) },
  { key: 'toppings', label: 'Extra toppings', hint: '−/+ portions with prices', build: () => ({ id: uuid(), name: 'Extra toppings', selectionType: 'QUANTITY', required: false, minSelect: 0, maxSelect: 4, templateKey: 'toppings', options: [opt('Mushrooms', 150, { maxQty: 2, portionDesc: '30 g' }), opt('Basil', 50, { maxQty: 2 })] }) },
  { key: 'remove', label: 'Leave out', hint: 'Remove ingredients, free', build: () => ({ id: uuid(), name: 'Leave out', selectionType: 'MULTI', required: false, minSelect: 0, maxSelect: 3, templateKey: 'remove', options: [opt('No onion'), opt('No garlic')] }) },
  { key: 'included', label: 'Included, not adjustable', hint: 'Locked base components', build: () => ({ id: uuid(), name: 'Included', selectionType: 'INCLUDED', required: false, minSelect: 0, maxSelect: 0, templateKey: 'included', description: 'Mixed into the base; cannot be removed individually.', options: [opt('Base sauce ingredients', 0, { locked: true })] }) },
];

export const newOptionId = uuid;

/** Problems in a chef's option configuration (shown in the builder and enforced by the API). */
export function validateOptionsConfig(groups: OptionsConfigGroup[]): string[] {
  const errs: string[] = [];
  const seen = new Set<string>();
  const optionIds = new Set<string>();
  groups.forEach((g, gi) => {
    const label = g.name?.trim() || `Group ${gi + 1}`;
    if (!g.name?.trim()) errs.push(`Group ${gi + 1}: name it`);
    if (seen.has(g.id)) errs.push(`${label}: duplicate id`);
    seen.add(g.id);
    const selectable = g.options.filter((o) => !o.locked);
    if (g.selectionType !== 'INCLUDED' && !selectable.length) errs.push(`${label}: add at least one option`);
    if (g.selectionType === 'INCLUDED' && g.options.some((o) => o.priceCents)) errs.push(`${label}: included components cannot have a price`);
    if ((g.selectionType === 'SINGLE' || g.selectionType === 'LEVEL') && g.options.filter((o) => o.isDefault).length > 1) errs.push(`${label}: only one default`);
    if (g.minSelect < 0 || g.maxSelect < 0) errs.push(`${label}: limits cannot be negative`);
    if (g.selectionType !== 'INCLUDED' && g.maxSelect > 0 && g.minSelect > g.maxSelect) errs.push(`${label}: minimum is above maximum`);
    if (g.parentOptionId && !optionIds.has(g.parentOptionId)) errs.push(`${label}: “only when” must point to an option in an earlier group`);
    for (const o of g.options) {
      if (!o.name?.trim()) errs.push(`${label}: every option needs a name`);
      if (o.priceCents < 0 || o.priceCents > 50_000) errs.push(`${label} · ${o.name}: price must be $0–$500`);
      if (o.maxQty !== undefined && (o.maxQty < 1 || o.maxQty > 20)) errs.push(`${label} · ${o.name}: max quantity 1–20`);
      for (const k of Object.keys(o.rules || {})) if (!optionIds.has(k) && !g.options.some((x) => x.id === k)) errs.push(`${label} · ${o.name}: a rule points to an unknown option`);
    }
    for (const o of g.options) optionIds.add(o.id);
  });
  return Array.from(new Set(errs));
}

/** What the customer would see as the starting price and checks for a configuration (used in the live preview). */
export function configToGroups(cfg: OptionsConfigGroup[]): ModGroup[] {
  return cfg.map((g) => ({ ...g, options: g.options.map((o) => ({ ...o })) }));
}
