// Users, Roles & Permissions (IAM) checks (imported by smoke.mjs): custom roles and the permission matrix, action
// narrowing, invitations, live role changes, temporary/scheduled/acting access, access requests, scope and data
// restrictions, approval authority, dual control and superadmin safeguards, login lockout, sessions, suspension,
// offboarding, bulk import, access reviews, service accounts & API keys, security alerts and audit.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function iamChecks({ call, check, A, C, o1 }) {
  console.log('\n── IAM: users, roles & permissions');
  const stamp = Date.now();
  const PW = process.env.ADMIN_PASSWORD || 'admin12345';
  const UP = { password: PW };
  const R = 'IAM smoke test';
  const API = process.env.API_URL || 'http://localhost:4000';
  const me = (await call('GET', '/auth/me', undefined, A)).json;

  const ov = (await call('GET', '/admin/iam/overview', undefined, A)).json;
  check('IAM overview counts staff, roles and superadmins', ov.users >= 1 && ov.roles >= 9 && ov.superadmins >= 1, ov);
  const roles = (await call('GET', '/admin/iam/roles', undefined, A)).json;
  const sys = (k) => roles.find((r) => r.key === k);
  check('built-in roles are seeded as system roles with their matrix', sys('PLATFORM_ADMIN')?.kind === 'SYSTEM' && sys('SUPPORT')?.permissions.includes('support:refund') && sys('PLATFORM_ADMIN').privileged, roles.map((r) => r.key));
  const lockedEdit = await call('PATCH', `/admin/iam/roles/${sys('PLATFORM_ADMIN').id}`, { description: 'x', reason: R }, A);
  check('the superadmin role cannot be edited', lockedEdit.status === 403 && lockedEdit.json.code === 'ROLE_LOCKED', lockedEdit.json);

  // custom roles
  const mkRole = async (name, permissions, extra = {}) => (await call('POST', '/admin/iam/roles', { name: `${name} ${stamp}`, permissions, reason: R, ...extra }, A)).json;
  const viewer = await mkRole('Customer viewer', ['customers:view', 'orders:view', 'field.pii:view', 'field.pii:export']);
  check('custom role created with a matrix', viewer.id && viewer.kind === 'CUSTOM' && viewer.key.startsWith('custom-'), viewer);
  const dup = (await call('POST', `/admin/iam/roles/${viewer.id}/duplicate`, { name: `Viewer copy ${stamp}`, reason: R }, A)).json;
  check('duplicating a role copies its permissions', dup.id && dup.id !== viewer.id && dup.permissions.length === viewer.permissions.length, dup);
  const badPerm = await call('POST', '/admin/iam/roles', { name: `Bad ${stamp}`, permissions: ['orders:fly'], reason: R }, A);
  check('unknown permissions are rejected', badPerm.status === 400, badPerm.json);
  const exporter = await mkRole('Customer exporter', ['customers:view', 'customers:export', 'field.pii:view', 'field.pii:export']);
  const basic = await mkRole('Basic viewer', ['customers:view']);
  const finView = await mkRole('Finance viewer', ['finance:view']);
  const accessMgr = await mkRole('Access manager', ['security:view', 'security:edit', 'security:manage_access', 'customers:view']);
  const approver = await mkRole('Limited approver', ['approvals:approve', 'support:view', 'support:create', 'support:edit', 'support:refund', 'orders:view'], { approvalLimits: { DISCOUNT: 1000, REFUND: 1000 } });

  // invitations
  const invite = async (tag, roleIds, extra = {}) => {
    const email = `iam-${tag}-${stamp}@example.com`;
    const r = (await call('POST', '/admin/iam/users', { email, name: `IAM ${tag}`, title: 'Analyst', department: 'Ops', roleIds, reason: R, stepUp: UP, ...extra }, A)).json;
    return { email, id: r.user?.id, link: r.inviteLink, res: r };
  };
  const accept = async (u) => {
    const tok = new URL(u.link).searchParams.get('token');
    return (await call('POST', '/auth/invite/accept', { token: tok, password: 'staffpass12345', name: u.email.split('@')[0] })).json;
  };
  const v = await invite('viewer', [viewer.id]);
  check('creating staff sends an invitation with the roles', v.id && v.link?.includes('/account/invite?token=') && v.res.assignments?.length === 1, v.res);
  const listed = (await call('GET', '/admin/iam/users?q=iam-viewer', undefined, A)).json;
  check('invited staff show as INVITED with their role and profile', listed.some((x) => x.id === v.id && x.status === 'INVITED' && x.title === 'Analyst' && x.roles.some((r) => r.roleId === viewer.id && r.primary)), listed);
  const peek = (await call('GET', `/auth/invite/${new URL(v.link).searchParams.get('token')}`)).json;
  check('invitation link can be checked before accepting', peek.valid && peek.email === v.email, peek);
  const vs = await accept(v);
  check('accepting the invitation sets a password and signs in with live permissions', vs.accessToken && vs.user.staff && vs.user.finePermissions?.includes('customers:view') && vs.user.permissions.includes('customers.read'), vs.user);
  const V = vs.accessToken;
  const reuse = await call('POST', '/auth/invite/accept', { token: new URL(v.link).searchParams.get('token'), password: 'staffpass12345' });
  check('an invitation link works once', reuse.status === 400, reuse.status);

  // action narrowing: view without export
  const dir = await call('GET', '/admin/customers?limit=5', undefined, V);
  const exp = await call('GET', '/admin/customers/export.csv', undefined, V);
  check('view permission opens the list but export needs customers:export', dir.status === 200 && exp.status === 403 && String(exp.json?.message).includes('customers:export'), [dir.status, exp.status, exp.json]);
  const sec = await call('GET', '/admin/iam/users', undefined, V);
  check('staff without security:view cannot open users & roles', sec.status === 403, sec.status);

  // live matrix change (no re-login) with step-up
  const noUp = await call('PUT', '/admin/iam/matrix', { changes: [{ roleId: viewer.id, permission: 'customers:export', granted: true }], reason: R }, A);
  const badUp = await call('PUT', '/admin/iam/matrix', { changes: [{ roleId: viewer.id, permission: 'customers:export', granted: true }], reason: R, stepUp: { password: 'wrong-password' } }, A);
  check('matrix changes need step-up verification', noUp.status === 403 && noUp.json.code === 'STEP_UP_REQUIRED' && badUp.status === 403, [noUp.json, badUp.status]);
  const saved = await call('PUT', '/admin/iam/matrix', { changes: [{ roleId: viewer.id, permission: 'customers:export', granted: true }], reason: R, stepUp: UP }, A);
  const exp2 = await call('GET', '/admin/customers/export.csv', undefined, V);
  check('granting a permission in the matrix applies at once, without signing in again', saved.status === 200 && exp2.status === 200, [saved.status, exp2.status]);
  await call('PUT', '/admin/iam/matrix', { changes: [{ roleId: viewer.id, permission: 'customers:export', granted: false }], reason: R, stepUp: UP }, A);
  const exp3 = await call('GET', '/admin/customers/export.csv', undefined, V);
  check('removing it applies at once too', exp3.status === 403, exp3.status);

  // self-assignment & escalation
  const selfA = await call('POST', '/admin/iam/assignments', { userIds: [me.id], roleId: viewer.id, reason: R }, A);
  check('nobody can assign roles to themselves', selfA.status === 403 && selfA.json.code === 'SELF_ASSIGNMENT', selfA.json);
  const m = await invite('manager', [accessMgr.id]);
  const M = (await accept(m)).accessToken;
  const esc = await call('POST', '/admin/iam/assignments', { userIds: [v.id], roleId: sys('FINANCE').id, reason: R }, M);
  check('an access manager cannot grant permissions they do not hold', esc.status === 403 && esc.json.code === 'PRIVILEGE_ESCALATION', esc.json);
  const okAssign = await call('POST', '/admin/iam/assignments', { userIds: [v.id], roleId: basic.id, reason: R }, M);
  check('…but can grant roles within their own permissions', okAssign.status === 201 || okAssign.status === 200, okAssign.json);

  // temporary, scheduled, primary, bulk and acting access
  const temp = await call('POST', '/admin/iam/assignments', { userIds: [v.id], roleId: exporter.id, endsAt: new Date(Date.now() + 3000).toISOString(), reason: R }, A);
  const during = await call('GET', '/admin/customers/export.csv', undefined, V);
  await sleep(3500);
  const after = await call('GET', '/admin/customers/export.csv', undefined, V);
  check('time-limited access works until it ends, then stops by itself', temp.json.assignments?.[0]?.kind === 'TEMPORARY' && during.status === 200 && after.status === 403, [during.status, after.status]);
  const sched = (await call('POST', '/admin/iam/assignments', { userIds: [v.id], roleId: finView.id, startsAt: new Date(Date.now() + 3600_000).toISOString(), endsAt: new Date(Date.now() + 7200_000).toISOString(), reason: R }, A)).json;
  const vUser = (await call('GET', `/admin/iam/users/${v.id}`, undefined, A)).json;
  check('scheduled access shows as scheduled and grants nothing yet', vUser.roles.some((r) => r.roleId === finView.id && r.state === 'SCHEDULED') && (await call('GET', '/accounting/receivables', undefined, V)).status === 403, vUser.roles);
  await call('POST', `/admin/iam/assignments/${sched.assignments[0].id}/revoke`, { reason: R }, A);
  const p1 = await invite('bulk1', []), p2 = await invite('bulk2', []);
  const bulk = (await call('POST', '/admin/iam/assignments', { userIds: [p1.id, p2.id], roleId: viewer.id, isPrimary: true, responsibility: 'Customer care analytics', reason: R }, A)).json;
  check('bulk assignment gives several people a role with a primary responsibility', bulk.assignments?.length === 2 && bulk.assignments.every((a) => a.isPrimary && a.responsibility === 'Customer care analytics'), bulk);
  const acting = (await call('POST', '/admin/iam/assignments/acting', { userId: p2.id, forUserId: m.id, endsAt: new Date(Date.now() + 86400_000).toISOString(), reason: 'Covering while on leave' }, A)).json;
  check('acting-manager access mirrors another person’s roles until a set date', acting.assignments?.length >= 1 && acting.assignments.every((a) => a.kind === 'ACTING' && a.actingForUserId === m.id && a.endsAt), acting);

  // access requests
  const reqd = (await call('GET', '/iam/requestable-roles', undefined, V)).json;
  check('staff see requestable roles (never superadmin)', reqd.some((r) => r.id === exporter.id) && !reqd.some((r) => r.key === 'PLATFORM_ADMIN'), reqd.length);
  const ar = (await call('POST', '/iam/access-requests', { roleId: exporter.id, justification: 'Monthly churn export for the board deck', durationHours: 2 }, V)).json;
  const selfDecide = await call('POST', `/iam/access-requests/${ar.id}/approve`, {}, V);
  check('staff can request access with a justification and cannot approve it themselves', ar.status === 'PENDING' && selfDecide.status === 403, [ar.status, selfDecide.status]);
  const dupReq = await call('POST', '/iam/access-requests', { roleId: exporter.id, justification: 'Monthly churn export for the board deck' }, V);
  check('duplicate pending requests are refused', dupReq.status === 409, dupReq.status);
  const appr = (await call('POST', `/iam/access-requests/${ar.id}/approve`, { note: 'OK for this week' }, A)).json;
  const who = (await call('GET', '/iam/whoami', undefined, V)).json;
  check('an approved request grants the role for the requested time', appr.status === 'APPROVED' && appr.assignmentId && who.permissions.includes('customers:export'), [appr, who.permissions]);
  const ar2 = (await call('POST', '/iam/access-requests', { roleId: finView.id, justification: 'Want to see the finance numbers' }, V)).json;
  const rej = (await call('POST', `/iam/access-requests/${ar2.id}/reject`, { note: 'Not needed for your job' }, A)).json;
  const mine = (await call('GET', '/iam/access-requests?mine=true', undefined, V)).json;
  check('rejected requests keep their status and note for the requester', rej.status === 'REJECTED' && mine.some((x) => x.id === ar2.id && x.status === 'REJECTED' && x.decisionNote), mine.map((x) => x.status));

  // effective access & explanations
  const eff = (await call('GET', `/admin/iam/users/${v.id}/effective`, undefined, A)).json;
  const cell = (res, act) => eff.matrix.find((x) => x.resource === res)?.actions.find((a) => a.action === act);
  check('effective-access preview combines roles and explains each cell', cell('customers', 'view')?.granted && cell('customers', 'view').via.length >= 1 && !cell('finance', 'approve')?.granted && cell('finance', 'approve').reasons.includes('No role grants it'), [cell('customers', 'view'), cell('finance', 'approve')]);
  const why = (await call('GET', `/admin/iam/explain?userId=${v.id}&permission=finance:approve`, undefined, A)).json;
  check('explain says why access is denied', why.allowed === false && why.reasons.some((r) => r.includes('grants finance:approve')), why);

  // scope & sensitivity ceiling, live
  await call('PUT', `/admin/iam/users/${v.id}/scope`, { maxSensitivity: 'INTERNAL', teams: ['SUPPORT'], reason: R }, A);
  const capped = await call('GET', '/admin/customers?limit=5', undefined, V);
  const whyCap = (await call('GET', `/admin/iam/explain?userId=${v.id}&permission=customers:view`, undefined, A)).json;
  check('a data-sensitivity ceiling removes confidential modules at once and is explained', capped.status === 403 && whyCap.allowed === false && whyCap.reasons.some((r) => r.includes('ceiling')), [capped.status, whyCap.reasons]);
  await call('PUT', `/admin/iam/users/${v.id}/scope`, { reason: R }, A);
  check('clearing the scope restores access', (await call('GET', '/admin/customers?limit=5', undefined, V)).status === 200);

  // data-level restrictions
  const f = await invite('finview', [finView.id]);
  const F = (await accept(f)).accessToken;
  const pnl = await call('GET', '/accounting/pnl', undefined, F);
  check('financial reports need the financial-reports data permission', pnl.status === 403 && pnl.json.code === 'FIELD_RESTRICTED', pnl.json);
  await call('PATCH', `/admin/iam/roles/${finView.id}`, { permissions: ['finance:view', 'field.financials:view'], reason: R, stepUp: UP }, A);
  check('…and open once it is granted', (await call('GET', '/accounting/pnl', undefined, F)).status === 200);

  // approval authority
  const sup = await invite('support', [sys('SUPPORT').id]);
  const S = (await accept(sup)).accessToken;
  const ap = await invite('approver', [approver.id]);
  const AP = (await accept(ap)).accessToken;
  let limitOk = false, limitInfo = null;
  if (o1?.id) {
    const inc = (await call('POST', '/incidents', { orderId: o1.id, category: 'DAMAGED', description: 'IAM smoke: bag torn' }, C)).json;
    const pend = (await call('POST', `/incidents/${inc.id}/resolve`, { owner: 'PLATFORM', remedy: 'CREDIT', remedyCents: 7500, note: 'Photos show damage' }, S)).json;
    const list = (await call('GET', '/approvals?status=PENDING', undefined, AP)).json;
    const over = await call('POST', `/approvals/${pend.approval?.id}/approve`, {}, AP);
    limitInfo = { pend: pend.status, canDecide: list.find?.((x) => x.id === pend.approval?.id)?.canDecide, over: over.json };
    limitOk = pend.status === 'PENDING_APPROVAL' && over.status === 403;
    await call('POST', `/approvals/${pend.approval?.id}/reject`, { note: 'IAM smoke cleanup' }, A);
  }
  check('approval authority: a request above the approver’s limit cannot be approved by them', limitOk, limitInfo);

  // dual control and superadmin safeguards
  const s2 = await invite('super2', []);
  const S2 = (await accept(s2)).accessToken;
  const grant2 = (await call('POST', '/admin/iam/assignments', { userIds: [s2.id], roleId: sys('PLATFORM_ADMIN').id, reason: R, stepUp: UP }, A)).json;
  check('a superadmin grant with step-up applies directly while dual control is off', grant2.assignments?.length === 1, grant2);
  const noStep = await call('POST', '/admin/iam/assignments', { userIds: [v.id], roleId: sys('PLATFORM_ADMIN').id, reason: R }, A);
  check('superadmin grants need step-up verification', noStep.status === 403 && noStep.json.code === 'STEP_UP_REQUIRED', noStep.json);
  const nonAdmin = await call('POST', '/admin/iam/assignments', { userIds: [v.id], roleId: sys('PLATFORM_ADMIN').id, reason: R, stepUp: { password: 'staffpass12345' } }, M);
  check('only superadmins can grant superadmin', nonAdmin.status === 403, nonAdmin.json);
  await call('PATCH', '/admin/iam/policy', { requireSecondApprover: true, reason: R, stepUp: UP }, A);
  const s3 = await invite('super3', []);
  await accept(s3);
  const dual = (await call('POST', '/admin/iam/assignments', { userIds: [s3.id], roleId: sys('PLATFORM_ADMIN').id, reason: R, stepUp: UP }, A)).json;
  const ownDecide = await call('POST', `/approvals/${dual.approval?.id}/approve`, {}, A);
  const nonSuper = await call('POST', `/approvals/${dual.approval?.id}/approve`, {}, M);
  const second = (await call('POST', `/approvals/${dual.approval?.id}/approve`, { note: 'Confirmed with the CTO' }, S2)).json;
  const s3eff = (await call('GET', `/admin/iam/users/${s3.id}/effective`, undefined, A)).json;
  check('with dual control on, a new superadmin needs a second superadmin’s approval', dual.status === 'PENDING_APPROVAL' && ownDecide.status === 403 && nonSuper.status === 403 && second.status === 'EXECUTED' && s3eff.superadmin, { dual: dual.status, own: ownDecide.status, other: nonSuper.status, second: second.status, sa: s3eff.superadmin });
  const privRole = await call('PATCH', `/admin/iam/roles/${dup.id}`, { permissions: [...dup.permissions, 'security:manage_access', 'security:view'], reason: R, stepUp: UP }, A);
  check('adding privileged permissions to a role also waits for a second superadmin', privRole.json.status === 'PENDING_APPROVAL', privRole.json);
  await call('POST', `/approvals/${privRole.json.approval?.id}/reject`, { note: 'IAM smoke cleanup' }, S2);
  await call('PATCH', '/admin/iam/policy', { requireSecondApprover: false, superadminGranters: [s2.id], reason: R, stepUp: UP }, A);
  const notGranter = await call('POST', '/admin/iam/assignments', { userIds: [v.id], roleId: sys('PLATFORM_ADMIN').id, reason: R, stepUp: UP }, A);
  check('superadmin grants can be limited to named granters', notGranter.status === 403 && notGranter.json.code === 'SUPERADMIN_GRANTER', notGranter.json);
  await call('PATCH', '/admin/iam/policy', { superadminGranters: [], reason: R, stepUp: UP }, A);
  const meAssign = (await call('GET', `/admin/iam/users/${me.id}`, undefined, A)).json.assignments?.find((a) => a.roleKey === 'PLATFORM_ADMIN' && a.state === 'ACTIVE');
  const selfRemove = await call('POST', `/admin/iam/assignments/${meAssign?.id}/revoke`, { reason: R, stepUp: UP }, A);
  check('superadmins cannot remove their own superadmin role', selfRemove.status === 400, selfRemove.json);

  // login lockout
  const lk = await invite('lock', [viewer.id]);
  await accept(lk);
  for (let i = 0; i < 5; i++) await call('POST', '/auth/login', { email: lk.email, password: 'wrong-password' });
  const locked = await call('POST', '/auth/login', { email: lk.email, password: 'staffpass12345' });
  check('repeated failed sign-ins lock the account, even for the right password', locked.status === 403 && locked.json.code === 'ACCOUNT_LOCKED', locked.json);
  await call('POST', `/admin/iam/users/${lk.id}/unlock`, {}, A);
  const unlocked = await call('POST', '/auth/login', { email: lk.email, password: 'staffpass12345' });
  const events = (await call('GET', `/admin/iam/login-events?userId=${lk.id}`, undefined, A)).json;
  check('an administrator can unlock it; every attempt is in the sign-in log', unlocked.status === 200 || unlocked.status === 201 ? events.some((e) => e.outcome === 'LOCKED') && events.some((e) => e.outcome === 'SUCCESS') : false, [unlocked.status, events.map((e) => e.outcome)]);

  // sessions, suspension, archive
  const sess = (await call('GET', `/admin/iam/sessions?userId=${v.id}`, undefined, A)).json;
  check('active sessions are listed per person', sess.length >= 1 && sess[0].email === v.email, sess.length);
  await call('POST', `/admin/iam/sessions/${sess[0].id}/revoke`, { reason: R }, A);
  check('revoking a session signs that device out at once', (await call('GET', '/iam/whoami', undefined, V)).status === 401);
  const V2 = (await call('POST', '/auth/login', { email: v.email, password: 'staffpass12345' })).json.accessToken;
  await call('POST', `/admin/iam/users/${v.id}/status`, { status: 'SUSPENDED', reason: R, until: new Date(Date.now() + 86400_000).toISOString() }, A);
  const susTok = await call('GET', '/iam/whoami', undefined, V2);
  const susLogin = await call('POST', '/auth/login', { email: v.email, password: 'staffpass12345' });
  check('suspending an account blocks its tokens and sign-in immediately', susTok.status === 401 && susLogin.json.code === 'ACCOUNT_SUSPENDED', [susTok.status, susLogin.json]);
  await call('POST', `/admin/iam/users/${v.id}/status`, { status: 'ACTIVE', reason: R }, A);
  check('reactivating restores sign-in', [200, 201].includes((await call('POST', '/auth/login', { email: v.email, password: 'staffpass12345' })).status));
  const selfStatus = await call('POST', `/admin/iam/users/${me.id}/status`, { status: 'DISABLED', reason: R, stepUp: UP }, A);
  check('nobody can change their own status', selfStatus.status === 400, selfStatus.json);
  await call('POST', `/admin/iam/users/${p1.id}/status`, { status: 'ARCHIVED', reason: R }, A);
  const arch = (await call('GET', `/admin/iam/users/${p1.id}`, undefined, A)).json;
  check('archiving ends all roles and invitations', arch.status === 'ARCHIVED' && arch.assignments.every((a) => a.state !== 'ACTIVE'), arch.assignments?.map((a) => a.state));

  // invitations: resend & revoke
  const pend = await invite('pending', [viewer.id]);
  const resent = (await call('POST', `/admin/iam/users/${pend.id}/resend-invite`, {}, A)).json;
  const oldPeek = (await call('GET', `/auth/invite/${new URL(pend.link).searchParams.get('token')}`)).json;
  check('resending an invitation replaces the old link', resent.invitation?.sentCount === 2 && !oldPeek.valid && resent.inviteLink !== pend.link, [resent.invitation, oldPeek]);

  // bulk import
  const rows = [{ email: `iam-imp1-${stamp}@example.com`, name: 'Imp One', roles: ['SUPPORT'] }, { email: `iam-imp2-${stamp}@example.com`, roles: [viewer.name] }, { email: `iam-imp3-${stamp}@example.com`, roles: ['NO_SUCH_ROLE'] }, { email: 'not-an-email', roles: [] }];
  const dry = (await call('POST', '/admin/iam/users/import', { rows, dryRun: true, reason: R }, A)).json;
  const imp = (await call('POST', '/admin/iam/users/import', { rows, reason: R }, A)).json;
  check('bulk import validates rows (dry run) and creates the valid ones', dry.errors === 2 && dry.created === 0 && imp.created === 2 && imp.errors === 2, { dry: dry.results?.map((r) => r.status), imp: imp.results?.map((r) => r.status) });

  // roles in use can't be archived
  const inUse = await call('POST', `/admin/iam/roles/${viewer.id}/archive`, { reason: R }, A);
  const unusedRole = await mkRole('Unused', ['orders:view']);
  const archived = await call('POST', `/admin/iam/roles/${unusedRole.id}/archive`, { reason: R }, A);
  const restored = await call('POST', `/admin/iam/roles/${unusedRole.id}/restore`, { reason: R }, A);
  check('only unused roles can be archived; archived roles can be restored', inUse.status === 409 && archived.status < 300 && restored.status < 300, [inUse.status, archived.status, restored.status]);

  // access review
  const rev = (await call('POST', '/admin/iam/reviews', { name: `Review ${stamp}`, dueInDays: 7, roleIds: [viewer.id, sys('PLATFORM_ADMIN').id] }, A)).json;
  const revD = (await call('GET', `/admin/iam/reviews/${rev.id}`, undefined, A)).json;
  const own = revD.items.find((i) => i.userId === me.id);
  const ownD = own ? await call('POST', `/admin/iam/reviews/${rev.id}/items/${own.id}`, { decision: 'KEEP' }, A) : { status: 403 };
  const pIt = revD.items.find((i) => i.userId === p2.id);
  const revoke = (await call('POST', `/admin/iam/reviews/${rev.id}/items/${pIt?.id}`, { decision: 'REVOKE', note: 'No longer on the team' }, A)).json;
  const p2After = (await call('GET', `/admin/iam/users/${p2.id}`, undefined, A)).json;
  const early = await call('POST', `/admin/iam/reviews/${rev.id}/complete`, {}, A);
  check('access review lists holders with flags; reviewers cannot review themselves; revoke removes access', rev.items >= 2 && revD.items.some((i) => i.flags.length) && ownD.status === 403 && revoke.decision === 'REVOKE' && p2After.assignments.filter((a) => a.roleId === viewer.id).every((a) => a.state !== 'ACTIVE') && early.status === 409, { items: rev.items, own: ownD.status, early: early.status });

  // offboarding with work transfer
  const ob = (await call('POST', `/admin/iam/users/${m.id}/offboard`, { reason: 'Left the company', transferToUserId: me.id }, A)).json;
  const obLogin = await call('POST', '/auth/login', { email: m.email, password: 'staffpass12345' });
  check('offboarding disables the account, ends roles and sessions, and hands over work', ob.roles >= 1 && ob.transferTo === me.id && obLogin.status === 403 && (await call('GET', '/iam/whoami', undefined, M)).status === 401, [ob, obLogin.status]);

  // service accounts & API keys
  const svcSec = await call('POST', '/admin/iam/service-accounts', { name: `Bad svc ${stamp}`, permissions: ['security:view'], reason: R }, A);
  check('service accounts can never hold security permissions', svcSec.status === 400, svcSec.json);
  const svc = (await call('POST', '/admin/iam/service-accounts', { name: `POS sync ${stamp}`, permissions: ['orders:view', 'catalog:view'], reason: R }, A)).json;
  const key = (await call('POST', `/admin/iam/service-accounts/${svc.id}/keys`, { name: 'primary', expiresInDays: 30 }, A)).json;
  const kWho = (await call('GET', '/iam/whoami', undefined, key.key)).json;
  const kSec = await call('GET', '/admin/iam/users', undefined, key.key);
  check('an API key acts as its service account with only its permissions', key.key?.startsWith('gsk_') && kWho.serviceAccountId === svc.id && kWho.permissions.includes('orders:view') && kSec.status === 403, [kWho, kSec.status]);
  const tooLong = await call('POST', `/admin/iam/service-accounts/${svc.id}/keys`, { name: 'forever', expiresInDays: 3650 }, A);
  check('API keys must expire within the policy limit', tooLong.status === 400, tooLong.status);
  const rot = (await call('POST', `/admin/iam/keys/${key.id}/rotate`, { graceHours: 1 }, A)).json;
  const oldStill = (await call('GET', '/iam/whoami', undefined, key.key)).status;
  const newWorks = (await call('GET', '/iam/whoami', undefined, rot.key)).status;
  check('rotation issues a new key and keeps the old one for a short grace period', rot.key && rot.key !== key.key && oldStill === 200 && newWorks === 200 && new Date(rot.previousKeyExpiresAt) < new Date(Date.now() + 2 * 3600_000), [oldStill, newWorks]);
  await call('DELETE', `/admin/iam/keys/${key.id}?reason=compromised`, undefined, A);
  check('revoking a key stops it at once', (await call('GET', '/iam/whoami', undefined, key.key)).status === 401);
  await call('PATCH', `/admin/iam/service-accounts/${svc.id}`, { status: 'DISABLED', reason: R }, A);
  check('disabling a service account stops all its keys', (await call('GET', '/iam/whoami', undefined, rot.key)).status === 401);
  check('a made-up key is rejected', (await call('GET', '/iam/whoami', undefined, 'gsk_notarealkey')).status === 401);

  // security notifications, CSV export, audit
  const alerts = (await call('GET', '/admin/iam/alerts?open=true', undefined, A)).json;
  const types = new Set(alerts.map((a) => a.type));
  check('security alerts cover new superadmins, privilege increases, lockouts and API access', ['NEW_SUPERADMIN', 'PRIVILEGE_INCREASE', 'ACCOUNT_LOCKED', 'API_KEY', 'OFFBOARDING'].every((t) => types.has(t)), [...types]);
  const acked = (await call('POST', '/admin/iam/alerts/all/ack', {}, A)).json;
  check('alerts can be acknowledged', acked.acknowledged >= 5, acked);
  const csvRes = await fetch(`${API}/admin/iam/users/export.csv`, { headers: { Authorization: `Bearer ${A}` } });
  const csv = await csvRes.text();
  check('staff directory exports as CSV (needs security:export)', csvRes.status === 200 && csv.startsWith('email,name,status') && csv.includes(v.email), csv.slice(0, 80));
  const aud = (await call('GET', '/admin/audit/search?action=iam.&limit=1000', undefined, A)).json;
  const acts = new Set(aud.map((x) => x.action));
  check('the audit trail records invitations, role and permission changes, and requests with who and why', ['iam.invite.send', 'iam.invite.accept', 'iam.role.create', 'iam.role.permissions', 'iam.assignment.create', 'iam.request.approve', 'iam.user.offboard'].every((a) => acts.has(a)) && aud.every((x) => x.actorEmail || x.action.startsWith('iam.invite.accept') || !x.actorId), [...acts]);
  const logins = (await call('GET', '/admin/iam/login-events?outcome=LOCKED', undefined, A)).json;
  check('sign-in log can be filtered by outcome', logins.length >= 1 && logins.every((e) => e.outcome === 'LOCKED'), logins.length);
}
