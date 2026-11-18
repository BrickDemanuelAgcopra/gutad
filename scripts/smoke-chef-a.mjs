// Chef Network Phase 1 checks (imported by smoke.mjs): resumable chef application with autosave, documents by
// kitchen type, photos, submission gate and automated checks, reviewer assignment, corrections, document review,
// approval provisioning (organization, seller, kitchen location, profile, CHEF role), payouts, availability,
// public directory, suspension, rejection and appeal, access control.

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 0x1f, 0x15, 0xc4, 0x89, 0, 0, 0, 0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0, 1, 0, 0, 5, 0, 1, 0x0d, 0x0a, 0x2d, 0xb4, 0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);
const PDF = new TextEncoder().encode('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');

export async function chefPhaseA({ call, check, A, C, API }) {
  console.log('\n── Chef Network A: onboarding & approval');
  const stamp = Date.now();
  const upload = async (path, token, fields, bytes, type, name) => {
    const fd = new FormData();
    for (const [k, v] of Object.entries(fields || {})) fd.append(k, v);
    fd.append('file', new Blob([bytes], { type }), name);
    const res = await fetch(`${API}${path}`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fd });
    let json; const t = await res.text(); try { json = JSON.parse(t); } catch { json = t; }
    return { status: res.status, json };
  };
  const register = async (tag) => {
    const email = `chef-${tag}-${stamp}@example.com`;
    const r = (await call('POST', '/auth/register', { email, password: 'chefpass12345', name: `Chef ${tag}`, phone: '+15550199' })).json;
    return { email, token: r.accessToken };
  };
  const expiry = new Date(Date.now() + 365 * 86400000).toISOString().slice(0, 10);

  const cfg = (await call('GET', '/public/chef-network/config')).json;
  check('chef network config lists steps, kitchen types and document rules', cfg.steps?.length === 9 && cfg.kitchenTypes?.COTTAGE_HOME && cfg.requirements?.some((r) => r.key === 'FOOD_HANDLER'), cfg);

  const ap = await register('a');
  const T = ap.token;
  const started = (await call('POST', '/chef/application', undefined, T)).json;
  check('anyone with an account can start a chef application (draft, resumable)', started.status === 'DRAFT' && started.editable && started.progress?.total === 9, started);
  const again = (await call('POST', '/chef/application', undefined, T)).json;
  check('starting again resumes the same application', again.id === started.id, again);
  const early = await call('POST', '/chef/application/submit', undefined, T);
  check('an incomplete application cannot be submitted (missing fields per step)', early.status === 400 && early.json.code === 'APPLICATION_INCOMPLETE' && early.json.missing?.length > 0, early.json);

  const portrait = await upload('/chef/photos', T, {}, PNG, 'image/png', 'me.png');
  check('chef uploads a portrait photo', portrait.status === 201 && portrait.json.id, portrait.json);
  const fakePhoto = await upload('/chef/photos', T, {}, PDF, 'image/png', 'fake.png');
  check('a file that is not really an image is refused', fakePhoto.status === 400, fakePhoto.json);

  const step = (k, body, tok = T) => call('PUT', `/chef/application/steps/${k}`, body, tok);
  let s = (await step('account', { phone: '+1 (555) 019-9001', agreed: true })).json;
  check('autosave: account step stores phone and the agreement acceptance', s.data?.account?.agreedAt && s.data.account.agreementVersion === cfg.agreementVersion && s.progress.steps.find((x) => x.key === 'account').complete, s.data?.account);
  await step('identity', { legalName: 'Ana Applicant', displayName: `Chef Ana ${stamp}`, businessType: 'INDIVIDUAL' });
  const badPortrait = await step('profile', { portraitFileId: globalThis.crypto.randomUUID() });
  check('a profile cannot reference a photo the chef did not upload', badPortrait.status === 400, badPortrait.json);
  await step('profile', { bio: 'Home-style Ghanaian stews, jollof and grilled tilapia, cooked in a licensed kitchen.', cuisines: ['Ghanaian', 'West African'], experienceYears: 6, languages: ['English', 'Twi'], portraitFileId: portrait.json.id, serviceCity: 'New York', serviceRegion: 'ny' });
  s = (await step('kitchen', { kitchenType: 'COMMERCIAL', operatorName: 'Ana Foods LLC', addressLine1: '10 Test St', city: 'New York', region: 'ny', postalCode: '10001', pickupAccess: 'Side door, buzz 2', dailyCapacity: 25, equipment: ['range', 'convection oven'] })).json;
  const needed = s.requirements.filter((r) => r.required).map((r) => r.key).sort();
  check('documents requested follow the kitchen type (commercial: permit, no home-kitchen permit)', needed.includes('KITCHEN_PERMIT') && !needed.includes('HOME_KITCHEN_PERMIT') && needed.includes('FOOD_HANDLER'), needed);
  check('region is normalized and the step is complete', s.region === 'NY' && s.progress.steps.find((x) => x.key === 'kitchen').complete, { region: s.region });
  await step('operating', { cookingDays: [1, 3, 5], cutoffHour: 12, minLeadDays: 1, dailyCapacity: 20, scheduledOrders: true, instantOrders: false, pickup: true, delivery: true, maxAdvanceDays: 30 });
  await step('payments', { country: 'US', earningsAgreementAccepted: true });
  await step('menu', { dishes: [{ name: 'Jollof rice', priceCents: 1400, portion: '1 tray (600 g)', allergens: [], mode: 'FIXED' }] });
  await step('readiness', { packagingAck: true, handlingTrainingAck: true, allergenTrainingAck: true });
  const unknownStep = await step('nope', { x: 1 });
  check('unknown steps are refused', unknownStep.status === 400, unknownStep.json);

  const badKey = await upload('/chef/application/documents', T, { requirementKey: 'NOT_A_DOC' }, PDF, 'application/pdf', 'x.pdf');
  check('an unknown document type is refused', badKey.status === 400, badKey.json);
  const noExpiry = await upload('/chef/application/documents', T, { requirementKey: 'FOOD_HANDLER' }, PDF, 'application/pdf', 'fh.pdf');
  check('documents that expire need their expiry date', noExpiry.status === 400, noExpiry.json);
  const docIds = {};
  for (const key of needed) {
    const r = await upload('/chef/application/documents', T, { requirementKey: key, expiresAt: expiry }, PDF, 'application/pdf', `${key}.pdf`);
    docIds[key] = r.json.id;
  }
  check('chef uploads every required document', Object.values(docIds).every(Boolean), docIds);
  const mine = (await call('GET', '/chef/application', undefined, T)).json;
  check('progress reaches 100% when every step is complete', mine.progress.percent === 100 && mine.progress.ready, mine.progress);

  const sub = (await call('POST', '/chef/application/submit', undefined, T)).json;
  check('submission runs automated checks and moves to Submitted', sub.status === 'SUBMITTED' && sub.autoCheck?.complete && sub.submittedAt, sub);
  const locked = await step('menu', { dishes: [] });
  check('a submitted application is locked for editing', locked.status === 409 && locked.json.code === 'APPLICATION_LOCKED', locked.json);

  const custList = await call('GET', '/admin/chef-applications', undefined, C);
  check('chef applications are staff-only', custList.status === 403, custList.status);
  const list = (await call('GET', '/admin/chef-applications?status=SUBMITTED', undefined, A)).json;
  check('admin queue lists the submitted application with completeness', list.items.some((x) => x.id === sub.id && x.percentComplete === 100) && list.counts.SUBMITTED >= 1, list.counts);
  const asg = (await call('POST', `/admin/chef-applications/${sub.id}/assign`, {}, A)).json;
  check('reviewer assignment moves the application to In review', asg.status === 'IN_REVIEW' && asg.reviewerId, asg);
  const tooSoon = await call('POST', `/admin/chef-applications/${sub.id}/decide`, { decision: 'APPROVE', reason: 'Looks great overall' }, A);
  check('approval needs every required document approved first', tooSoon.status === 400 && tooSoon.json.code === 'DOCS_MISSING', tooSoon.json);

  const ch = (await call('POST', `/admin/chef-applications/${sub.id}/changes`, { steps: ['menu'], note: 'Please add the allergens and a second dish.' }, A)).json;
  check('reviewer requests corrections on specific steps', ch.status === 'CHANGES_REQUESTED' && ch.correctionSteps.includes('menu'), ch);
  const fix = (await step('menu', { dishes: [{ name: 'Jollof rice', priceCents: 1400, portion: '1 tray (600 g)', allergens: [] }, { name: 'Groundnut soup', priceCents: 1600, portion: '1 quart', allergens: ['peanuts'] }] })).json;
  check('the chef can edit again after a correction request', fix.data.menu.dishes.length === 2, fix.status);
  const resub = (await call('POST', '/chef/application/submit', undefined, T)).json;
  check('resubmission goes back to the queue', resub.status === 'SUBMITTED' && resub.history.some((h) => h.action === 'RESUBMITTED'), resub.status);

  const detail = (await call('GET', `/admin/chef-applications/${sub.id}`, undefined, A)).json;
  check('admin detail shows applicant, documents and step progress', detail.applicant?.email === ap.email && detail.documents.length >= needed.length && detail.progress.steps.length === 9, detail.applicant);
  const rejNoNote = await call('POST', `/admin/chef-documents/${docIds.FOOD_HANDLER}/review`, { status: 'REJECTED' }, A);
  check('rejecting a document needs a note for the chef', rejNoNote.status === 400, rejNoNote.json);
  for (const id of Object.values(docIds)) await call('POST', `/admin/chef-documents/${id}/review`, { status: 'APPROVED' }, A);
  const docFile = await fetch(`${API}/chef/files/${detail.documents[0].fileId}`, { headers: { Authorization: `Bearer ${A}` } });
  check('reviewers can open private chef documents', docFile.status === 200 && (docFile.headers.get('content-type') || '').includes('pdf'), docFile.status);
  const docFileC = await fetch(`${API}/chef/files/${detail.documents[0].fileId}`, { headers: { Authorization: `Bearer ${C}` } });
  check('other customers cannot open chef documents', docFileC.status === 403, docFileC.status);
  const lnk = (await call('GET', `/chef/files/${detail.documents[0].fileId}/link`, undefined, A)).json;
  const local = (u) => u.replace(/^https?:\/\/[^/]+/, API);
  const viaLink = await fetch(local(lnk.url));
  const badLink = await fetch(local(lnk.url).replace(/sig=[^&]+/, 'sig=forged'));
  check('reviewers get a short-lived signed link for phones; forged links fail', viaLink.status === 200 && badLink.status === 403, { ok: viaLink.status, bad: badLink.status });
  const lnkC = await call('GET', `/chef/files/${detail.documents[0].fileId}/link`, undefined, C);
  check('no signed link for people without access', lnkC.status === 403, lnkC.status);

  const appr = (await call('POST', `/admin/chef-applications/${sub.id}/decide`, { decision: 'APPROVE', reason: 'Kitchen permit and food handler card verified' }, A)).json;
  check('approval provisions the chef organization, kitchen location and profile', appr.status === 'APPROVED' && appr.organization?.kind === 'CHEF' && appr.location?.chefKitchen === true && appr.location?.isPaused === true && appr.profile?.slug, { status: appr.status, org: appr.organization, loc: appr.location?.chefKitchen });

  const relog = (await call('POST', '/auth/login', { email: ap.email, password: 'chefpass12345' })).json;
  const CT = relog.accessToken;
  const meUser = (await call('GET', '/auth/me', undefined, CT)).json;
  check('the approved chef gets the CHEF role', (meUser.roles || meUser.user?.roles || []).includes('CHEF'), meUser.roles || meUser.user?.roles);
  let me = (await call('GET', '/chef/me', undefined, CT)).json;
  check('chef dashboard shows profile, kitchen, payouts and a checklist', me.profile?.displayName === `Chef Ana ${stamp}` && me.location?.chefKitchen !== false && me.checklist?.length === 4 && me.payouts?.state === 'NOT_STARTED', me.checklist);
  const openEarly = await call('POST', '/chef/me/availability', { accepting: true }, CT);
  check('availability cannot open before payouts are connected', openEarly.status === 400 && openEarly.json.code === 'PAYOUTS_REQUIRED', openEarly.json);
  const pay = (await call('POST', '/chef/me/payouts', undefined, CT)).json;
  check('payouts connect through the payment provider’s hosted onboarding', pay.accountId && ['COMPLETE', 'PENDING'].includes(pay.state), pay);
  me = (await call('POST', '/chef/me/availability', { accepting: true }, CT)).json;
  check('chef opens availability: profile accepting, kitchen live and unpaused', me.profile?.acceptingOrders === true && me.location?.isPaused === false && me.location?.status === 'LIVE', { p: me.profile?.acceptingOrders, l: me.location });
  const dir = (await call('GET', '/public/chefs?region=NY')).json;
  check('the public chef directory lists accepting chefs (including demo Bestie Carlos)', dir.some((c) => c.slug === me.profile.slug) && dir.some((c) => c.slug === 'chef-carlos'), dir.map((c) => c.slug));
  const pub = (await call('GET', `/public/chefs/${me.profile.slug}`)).json;
  check('public chef page shows identity, cuisines and verified credentials (no documents)', pub.displayName === me.profile.displayName && pub.portraitUrl && pub.verifiedCredentials.includes('FOOD_HANDLER') && !('legalName' in pub), pub);
  const photo = await fetch(pub.portraitUrl.replace(/^https?:\/\/[^/]+/, API));
  check('portrait photos are publicly served', photo.status === 200 && (photo.headers.get('content-type') || '').includes('image/png'), photo.status);
  const otherMe = await call('GET', '/chef/me', undefined, C);
  check('a non-chef has no chef dashboard', otherMe.status === 404 && otherMe.json.code === 'NOT_A_CHEF', otherMe.json);

  const susp = await call('POST', `/admin/chefs/${me.profile.id}/status`, { status: 'SUSPENDED', reason: 'Quality review after complaints' }, A);
  const dir2 = (await call('GET', '/public/chefs?region=NY')).json;
  check('suspending a chef removes them from the directory and pauses the kitchen', susp.status === 201 && !dir2.some((c) => c.slug === me.profile.slug), susp.json);
  const reopen = await call('POST', '/chef/me/availability', { accepting: true }, CT);
  check('a suspended chef cannot reopen availability', reopen.status === 403 && reopen.json.code === 'CHEF_NOT_ACTIVE', reopen.json);
  await call('POST', `/admin/chefs/${me.profile.id}/status`, { status: 'ACTIVE', reason: 'Review complete, reinstated' }, A);

  // rejection and appeal
  const bp = await register('b');
  const B = bp.token;
  await call('POST', '/chef/application', undefined, B);
  const stepB = (k, body) => step(k, body, B);
  await stepB('account', { phone: '+15550199002', agreed: true });
  await stepB('identity', { legalName: 'Bo Baker', displayName: `Chef Bo ${stamp}`, businessType: 'BUSINESS', businessName: 'Bo Bakes LLC' });
  const p2 = await upload('/chef/photos', B, {}, PNG, 'image/png', 'bo.png');
  await stepB('profile', { bio: 'Celebration cakes and Thanksgiving pies from a home kitchen with a cottage-food permit.', cuisines: ['Bakery & desserts'], portraitFileId: p2.json.id, serviceCity: 'Albany', serviceRegion: 'NY' });
  const k2 = (await stepB('kitchen', { kitchenType: 'COTTAGE_HOME', operatorName: 'Bo Baker', addressLine1: '5 Home Rd', city: 'Albany', region: 'NY', postalCode: '12207', pickupAccess: 'Front porch', dailyCapacity: 6 })).json;
  const need2 = k2.requirements.filter((r) => r.required).map((r) => r.key);
  check('a home kitchen must provide a home-kitchen permit instead of a commercial permit', need2.includes('HOME_KITCHEN_PERMIT') && !need2.includes('KITCHEN_PERMIT'), need2);
  for (const key of need2) await upload('/chef/application/documents', B, { requirementKey: key, expiresAt: expiry }, PDF, 'application/pdf', `${key}.pdf`);
  await stepB('operating', { cookingDays: [4, 5], cutoffHour: 18, minLeadDays: 3, dailyCapacity: 4, scheduledOrders: true, pickup: true, maxAdvanceDays: 60 });
  await stepB('payments', { earningsAgreementAccepted: true });
  await stepB('menu', { dishes: [{ name: 'Pumpkin pie', priceCents: 3200, portion: '9-inch pie, serves 8', allergens: ['wheat', 'milk', 'egg'] }] });
  await stepB('readiness', { packagingAck: true, handlingTrainingAck: true, allergenTrainingAck: true });
  const subB = (await call('POST', '/chef/application/submit', undefined, B)).json;
  const noReason = await call('POST', `/admin/chef-applications/${subB.id}/decide`, { decision: 'REJECT', reason: 'no' }, A);
  check('decisions need a reason', noReason.status === 400, noReason.status);
  const rej = (await call('POST', `/admin/chef-applications/${subB.id}/decide`, { decision: 'REJECT', reason: 'Meals with dairy fillings are outside the cottage-food permit' }, A)).json;
  check('reviewer declines with a reason', rej.status === 'REJECTED' && rej.decisionReason, rej.status);
  const appeal = (await call('POST', '/chef/application/appeal', { note: 'My county permit was updated to cover refrigerated pies; new permit attached.' }, B)).json;
  check('a declined chef can appeal; the appeal returns to the queue', appeal.status === 'APPEALED' && appeal.appealNote, appeal.status);
  const wl = (await call('POST', `/admin/chef-applications/${subB.id}/decide`, { decision: 'WAITLIST', reason: 'Not onboarding home bakers in Albany yet' }, A)).json;
  check('an appealed application can be waitlisted', wl.status === 'WAITLISTED', wl.status);

  const req = (await call('POST', '/admin/chef-requirements', { key: 'nyc_dohmh_permit', label: 'NYC DOHMH permit', regions: ['ny'], kitchenTypes: ['COMMERCIAL'], required: false, needsExpiry: true }, A)).json;
  check('admins add document rules by state and kitchen type', req.key === 'NYC_DOHMH_PERMIT' && req.regions[0] === 'NY', req);
  const custReq = await call('POST', '/admin/chef-requirements', { key: 'X1', label: 'Xx' }, C);
  check('document rules are staff-only', custReq.status === 403, custReq.status);
  const carlos = (await call('GET', '/public/chefs/chef-carlos')).json;
  check('demo Bestie Carlos is live in the Chef Network', carlos.displayName === 'Bestie Carlos' && carlos.acceptingOrders, carlos);
  return { chefToken: CT, chefProfile: me.profile };
}
