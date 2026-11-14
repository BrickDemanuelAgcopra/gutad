// Admin platform, phase A checks (imported by smoke.mjs): staff roles & permissions, reasons, sessions,
// MFA, approval engine (refunds, bank changes, sensitive settings), staff scopes, emergency & support access, audit.
import { createHmac } from 'node:crypto';

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function b32(s) {
  let bits = 0, value = 0; const out = [];
  for (const ch of s.toUpperCase().replace(/[^A-Z2-7]/g, '')) { value = (value << 5) | B32.indexOf(ch); bits += 5; if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; } }
  return Buffer.from(out);
}
export function totp(secret, at = Date.now()) {
  const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(Math.floor(at / 30000)));
  const h = createHmac('sha1', b32(secret)).update(msg).digest(); const o = h[h.length - 1] & 0xf;
  return ((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).toString().padStart(6, '0');
}

export async function adminPhaseA({ call, check, A, O, C, o1, demoOrgId }) {
  console.log('\n── Admin platform A: access, approvals, sessions, MFA');
  const stamp = Date.now();
  const mk = async (tag) => {
    const email = `${tag}-${stamp}@example.com`;
    await call('POST', '/auth/register', { email, password: 'staffpass12345', name: tag });
    return email;
  };
  const login = async (email, pw = 'staffpass12345') => (await call('POST', '/auth/login', { email, password: pw })).json;
  const supEmail = await mk('support'), opsEmail = await mk('ops'), admin2Email = await mk('admin2'), finEmail = await mk('finance');

  // roles need a reason
  const noReason = await call('POST', '/admin/security/staff/roles', { email: supEmail, roles: ['SUPPORT'] }, A);
  check('staff role change requires a reason', noReason.status === 400 || noReason.status === 403, noReason.json);
  for (const [email, roles] of [[supEmail, ['SUPPORT']], [opsEmail, ['OPERATIONS']], [admin2Email, ['PLATFORM_ADMIN']], [finEmail, ['FINANCE']]]) {
    await call('POST', '/admin/security/staff/roles', { email, roles, reason: 'Smoke test staffing', stepUp: { password: process.env.ADMIN_PASSWORD || 'admin12345' } }, A);
  }
  const sup = await login(supEmail);
  check('support login carries admin-console permissions', sup.user?.permissions?.includes('support.manage') && !sup.user.permissions.includes('security.manage'), sup.user?.permissions);
  const S = sup.accessToken;
  const forbidden = await call('GET', '/admin/security/staff', undefined, S);
  check('support cannot open staff & access', forbidden.status === 403, forbidden.status);
  const staffList = (await call('GET', '/admin/security/staff', undefined, A)).json;
  check('staff directory lists the new staff with roles', Array.isArray(staffList) && staffList.some((x) => x.email === supEmail && x.roles.includes('SUPPORT')), staffList?.length);
  const custRoles = await call('POST', '/admin/security/staff/roles', { email: supEmail, roles: ['PLATFORM_ADMIN'], reason: 'escalate myself' }, C);
  check('customers cannot grant staff roles', custRoles.status === 403, custRoles.status);

  // sessions
  const sess = (await call('GET', '/auth/sessions', undefined, S)).json;
  check('sessions list shows the current session', Array.isArray(sess) && sess.some((x) => x.current), sess);
  const extra = await login(supEmail);
  const sess2 = (await call('GET', '/auth/sessions', undefined, S)).json;
  const other = sess2.find((x) => !x.current);
  await call('DELETE', `/auth/sessions/${other.id}`, undefined, S);
  const afterRevoke = await call('GET', '/auth/me', undefined, extra.accessToken);
  const refreshDead = await call('POST', '/auth/refresh', { refreshToken: extra.refreshToken });
  check('revoked session: access token and refresh token stop working', afterRevoke.status === 401 && refreshDead.status === 401, [afterRevoke.status, refreshDead.status]);

  // MFA (TOTP)
  const setup = (await call('POST', '/auth/mfa/setup', {}, S)).json;
  const enabled = (await call('POST', '/auth/mfa/enable', { code: totp(setup.secret) }, S)).json;
  check('MFA enrolment returns recovery codes', enabled.recoveryCodes?.length === 8 && enabled.user?.mfaEnabled, enabled.user);
  const ch = (await call('POST', '/auth/login', { email: supEmail, password: 'staffpass12345' })).json;
  check('login with MFA returns a challenge, not tokens', ch.mfaRequired && ch.challengeToken && !ch.accessToken, ch);
  const bad = await call('POST', '/auth/mfa/verify', { challengeToken: ch.challengeToken, code: '000000' });
  const good = (await call('POST', '/auth/mfa/verify', { challengeToken: ch.challengeToken, code: totp(setup.secret) })).json;
  check('wrong code rejected, right code signs in', bad.status === 401 && good.accessToken, [bad.status, !!good.accessToken]);
  const rc = (await call('POST', '/auth/login', { email: supEmail, password: 'staffpass12345' })).json;
  const viaRecovery = (await call('POST', '/auth/mfa/verify', { challengeToken: rc.challengeToken, code: enabled.recoveryCodes[0] })).json;
  const rc2 = (await call('POST', '/auth/login', { email: supEmail, password: 'staffpass12345' })).json;
  const reused = await call('POST', '/auth/mfa/verify', { challengeToken: rc2.challengeToken, code: enabled.recoveryCodes[0] });
  check('recovery code works once', !!viaRecovery.accessToken && reused.status === 401, reused.status);
  const S2 = good.accessToken;

  // MFA required for a role → console locked until enrolled
  await call('PATCH', '/admin/security/settings', { mfaRequiredRoles: ['OPERATIONS'], reason: 'Smoke: require MFA for operations' }, A);
  const ops = await login(opsEmail);
  const opsLocked = await call('GET', '/approvals/summary', undefined, ops.accessToken);
  const opsBlocked = await call('GET', '/admin/structure', undefined, ops.accessToken);
  check('role that requires MFA gets no console access until enrolled', ops.user.mfaSetupRequired && ops.user.permissions.length === 0 && opsBlocked.status === 403, { req: ops.user.mfaSetupRequired, st: opsBlocked.status, s: opsLocked.status });
  const opsSetup = (await call('POST', '/auth/mfa/setup', {}, ops.accessToken)).json;
  const opsOn = (await call('POST', '/auth/mfa/enable', { code: totp(opsSetup.secret) }, ops.accessToken)).json;
  const opsOk = await call('GET', '/admin/structure', undefined, opsOn.accessToken);
  check('after enrolling MFA the console opens', opsOk.status === 200 && opsOn.user.permissions.includes('ops.manage'), opsOk.status);
  await call('PATCH', '/admin/security/settings', { mfaRequiredRoles: [], reason: 'Smoke: reset MFA policy' }, A);
  const OPS = opsOn.accessToken;

  // approvals: refund over the support limit (repeat compensation on o1 also forces approval)
  const inc = (await call('POST', '/incidents', { orderId: o1.id, category: 'DAMAGED', description: 'Bag arrived crushed' }, C)).json;
  const pend = (await call('POST', `/incidents/${inc.id}/resolve`, { owner: 'PLATFORM', remedy: 'CREDIT', remedyCents: 7500, note: 'Customer sent photos of the damage' }, S2)).json;
  check('refund above the support limit becomes an approval request', pend.status === 'PENDING_APPROVAL' && pend.approval?.kind === 'REFUND', pend);
  const self = await call('POST', `/approvals/${pend.approval.id}/approve`, {}, S2);
  check('requester cannot approve their own request', self.status === 403, self.json);
  const custApprove = await call('POST', `/approvals/${pend.approval.id}/approve`, {}, C);
  check('customers cannot approve', custApprove.status === 403, custApprove.status);
  const approved = (await call('POST', `/approvals/${pend.approval.id}/approve`, { note: 'Photos confirm damage' }, A)).json;
  const incAfter = (await call('GET', `/incidents/${inc.id}`, undefined, A)).json;
  check('approval executes the remedy once', approved.status === 'EXECUTED' && incAfter.incident.status === 'RESOLVED' && incAfter.incident.remedyCents === 7500, { a: approved.status, i: incAfter.incident?.status });
  const again = await call('POST', `/approvals/${pend.approval.id}/approve`, {}, A);
  check('decided approvals cannot be approved twice', again.status === 409, again.status);
  const small = (await call('POST', '/incidents', { orderId: o1.id, category: 'OTHER', description: 'Napkins missing' }, C)).json;
  const rejectNoNote = (await call('POST', `/incidents/${small.id}/resolve`, { owner: 'PLATFORM', remedy: 'CREDIT', remedyCents: 100, note: 'goodwill' }, S2)).json;
  const rej = await call('POST', `/approvals/${rejectNoNote.approval?.id}/reject`, { note: 'Already compensated twice' }, A);
  check('repeat compensation needs approval and can be rejected with a note', rejectNoNote.status === 'PENDING_APPROVAL' && rej.json.status === 'REJECTED', [rejectNoNote.status, rej.json.status]);

  // two-person bank change
  const org = (await call('GET', `/organizations/${demoOrgId}`, undefined, O)).json;
  const seller = org.legalSellers[0];
  const newLast4 = String(1000 + (stamp % 9000));
  const bank = (await call('POST', `/legal-sellers/${seller.id}/bank-change`, { beneficiaryName: 'Demo Bistro Holdings LLC', bankLast4: newLast4, reason: 'Switched banks' }, O)).json;
  check('bank-account change waits for approval', bank.status === 'PENDING_APPROVAL' && bank.approval.kind === 'BANK_ACCOUNT_CHANGE', bank);
  const sellerMid = (await call('GET', `/organizations/${demoOrgId}`, undefined, O)).json.legalSellers.find((x) => x.id === seller.id);
  const ownerApprove = await call('POST', `/approvals/${bank.approval.id}/approve`, {}, O);
  const supApprove = await call('POST', `/approvals/${bank.approval.id}/approve`, {}, S2);
  check('merchant and support cannot approve bank changes', sellerMid.bankLast4 !== newLast4 && ownerApprove.status === 403 && supApprove.status === 403, [sellerMid.bankLast4, ownerApprove.status, supApprove.status]);
  const fin = await login(finEmail);
  const finOk = (await call('POST', `/approvals/${bank.approval.id}/approve`, { note: 'Verified by phone with the owner' }, fin.accessToken)).json;
  const sellerAfter = (await call('GET', `/organizations/${demoOrgId}`, undefined, O)).json.legalSellers.find((x) => x.id === seller.id);
  check('finance approval applies the bank change', finOk.status === 'EXECUTED' && sellerAfter.bankLast4 === newLast4, [finOk.status, sellerAfter.bankLast4]);

  // sensitive settings: second platform admin
  const setReq = (await call('POST', '/admin/settings', { key: 'fees.smoke_test', value: { bps: 100 }, reason: 'Smoke: sensitive setting' }, A)).json;
  check('sensitive setting becomes an approval request', setReq.status === 'PENDING_APPROVAL', setReq);
  const a2 = await login(admin2Email);
  const setOk = (await call('POST', `/approvals/${setReq.approval.id}/approve`, {}, a2.accessToken)).json;
  const settings = (await call('GET', '/admin/settings', undefined, A)).json;
  check('second admin approval writes the setting', setOk.status === 'EXECUTED' && settings.settings['fees.smoke_test']?.bps === 100, setOk.status);

  // staff scope: operations limited to the shared kitchen's organization
  const orgs = (await call('GET', '/admin/tenants', undefined, A)).json;
  const kitchenOrg = orgs.find((r) => r.org.id !== demoOrgId)?.org;
  const opsUser = staffList.find((x) => x.email === opsEmail) || (await call('GET', '/admin/security/staff', undefined, A)).json.find((x) => x.email === opsEmail);
  await call('PUT', `/admin/security/staff/${opsUser.id}/scope`, { organizationIds: [kitchenOrg.id], maxSensitivity: 'INTERNAL', reason: 'Smoke: food hall operations only' }, A);
  const opsCh = (await call('POST', '/auth/login', { email: opsEmail, password: 'staffpass12345' })).json;
  const opsScoped = (await call('POST', '/auth/mfa/verify', { challengeToken: opsCh.challengeToken, code: totp(opsSetup.secret) })).json;
  const inScope = await call('GET', `/organizations/${kitchenOrg.id}`, undefined, opsScoped.accessToken);
  const outScope = await call('GET', `/organizations/${demoOrgId}`, undefined, opsScoped.accessToken);
  check('scoped staff reach only their organizations', inScope.status === 200 && outScope.status === 403, [inScope.status, outScope.status]);
  check('sensitivity ceiling removes confidential permissions', opsScoped.user && !opsScoped.user.permissions.includes('overview.read') && opsScoped.user.permissions.includes('ops.read'), opsScoped.user?.permissions);

  // emergency access
  const tooShort = await call('POST', '/access-grants/emergency', { roles: ['FINANCE'], minutes: 30, reason: 'urgent' }, S2);
  const noAdmin = await call('POST', '/access-grants/emergency', { roles: ['PLATFORM_ADMIN'], minutes: 30, reason: 'Payouts are failing, need to look now' }, S2);
  check('emergency access needs a real reason and cannot grant platform admin', tooShort.status === 400 && noAdmin.status === 403, [tooShort.status, noAdmin.status]);
  const em = (await call('POST', '/access-grants/emergency', { roles: ['FINANCE'], minutes: 30, reason: 'Payouts are failing, need to look now', ticketRef: 'INC-42' }, S2)).json;
  check('emergency access elevates the session for a limited time', em.user?.elevated?.roles?.includes('FINANCE') && em.user.permissions.includes('finance.manage'), em.user?.elevated);
  const E = em.accessToken;
  await call('GET', '/finance/unmatched', undefined, E);
  const grants = (await call('GET', '/access-grants?kind=EMERGENCY&unreviewed=true', undefined, A)).json;
  check('security sees unreviewed emergency grants', grants.some((g) => g.id === em.grant.id), grants.length);
  const selfReview = await call('POST', `/access-grants/${em.grant.id}/review`, { note: 'fine' }, S2);
  const review = await call('POST', `/access-grants/${em.grant.id}/review`, { note: 'Justified: payout incident INC-42' }, A);
  check('someone else reviews the emergency grant', selfReview.status === 403 && review.status === 201, [selfReview.status, review.status]);
  const ended = (await call('POST', `/access-grants/${em.grant.id}/end`, {}, E)).json;
  check('ending emergency access drops the extra permissions', ended.ok && !ended.user.elevated && !ended.user.permissions.includes('finance.manage'), ended.user?.permissions);

  // support access ("view as merchant")
  const sa = (await call('POST', '/access-grants/support', { organizationId: demoOrgId, minutes: 30, reason: 'Merchant called about missing orders' }, S2)).json;
  check('support access session starts with a reason', sa.user?.supportAccess?.organizationId === demoOrgId && sa.user.supportAccess.readOnly, sa.user?.supportAccess);
  const loc = (await call('GET', `/organizations/${demoOrgId}`, undefined, sa.accessToken)).json.locations[0];
  const roPause = await call('POST', `/locations/${loc.id}/pause`, { minutes: 5, reason: 'test' }, sa.accessToken);
  check('read-only support access blocks changes', roPause.status === 403 && roPause.json.code === 'SUPPORT_READ_ONLY', roPause.json);

  // structure & regions
  const reg = (await call('POST', '/admin/regions', { code: `SMK${String(stamp).slice(-4)}`, name: 'Smoke Region' }, A)).json;
  await call('POST', `/admin/locations/${loc.id}/region`, { regionId: reg.id }, A);
  const st = (await call('GET', '/admin/structure', undefined, A)).json;
  check('structure groups locations by region with food halls and merchants', st.regions?.some((r) => r.region?.id === reg.id && (r.merchants.some((m) => m.locations.some((l) => l.id === loc.id)) || r.foodHalls.some((l) => l.id === loc.id))) && st.counts.foodHalls >= 1, st.counts);
  await call('POST', `/admin/locations/${loc.id}/region`, { regionId: null }, A);

  // audit trail with reasons and grant tags
  const aud = (await call('GET', `/admin/audit/search?entityType=user&action=iam.assignment&withReason=true`, undefined, A)).json;
  check('audit search returns who, what and why', aud.some((x) => x.reason === 'Smoke test staffing' && x.actorEmail), aud.slice(0, 2));
  const tagged = (await call('GET', `/admin/audit/search?action=access.emergency`, undefined, A)).json;
  check('emergency activity is in the audit trail', tagged.some((x) => x.entityId === em.grant.id), tagged.length);
  const csvRes = await fetch(`${process.env.API_URL || 'http://localhost:4000'}/admin/audit/export.csv?action=iam.assignment`, { headers: { Authorization: `Bearer ${A}` } });
  const csv = await csvRes.text();
  check('audit export is a CSV with reasons', csvRes.status === 200 && csv.startsWith('createdAt,actorEmail,action') && csv.includes('Smoke test staffing'), csv.slice(0, 120));

  // disable = revoke everything
  const supUser = (await call('GET', '/admin/security/staff', undefined, A)).json.find((x) => x.email === supEmail);
  await call('POST', `/admin/security/staff/${supUser.id}/disable`, { reason: 'Smoke: offboarded' }, A);
  const dead = await call('GET', '/auth/me', undefined, S2);
  const relog = await call('POST', '/auth/login', { email: supEmail, password: 'staffpass12345' });
  check('disabling staff ends sessions and blocks sign-in', dead.status === 401 && relog.status === 403, [dead.status, relog.status]);
  const summary = (await call('GET', '/approvals/summary', undefined, A)).json;
  check('approval summary counts pending requests', typeof summary.pending === 'number', summary);
}
