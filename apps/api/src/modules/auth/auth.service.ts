import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as argon2 from 'argon2';
import { createPublicKey, randomInt, verify as cryptoVerify, type JsonWebKey } from 'node:crypto';
import { and, desc, eq, gt, inArray, isNull, or, sql } from 'drizzle-orm';
import { BLOCKED_STATUSES, DEFAULT_ACCESS_POLICY, isStaffRole, type AccessPolicy } from '@gutad/shared';
import { DB, Db } from '../../db/db.module';
import { accessGrants, accountRecoveryTokens, addresses, consents, orgMemberships, refreshTokens, staffProfiles, userDevices, userSessions, users } from '../../db/schema';
import { CryptoService } from '../../core/crypto.service';
import { NotifyService } from '../../core/notify.service';
import { RedisService } from '../../core/redis.service';
import { SettingsService } from '../../core/settings.service';
import { AuditService } from '../../core/audit.service';
import { AclService } from '../../core/acl.service';
import { SecurityEventsService } from '../../core/security-events.service';
import { loadConfig } from '../../config/config';
import { addDays, token } from '../../common/utils';
import { finePermissionsOf, permissionsOf, type JwtPayload, type RoleName } from '../../common/auth';
import { newTotpSecret, otpauthUrl, verifyTotp } from '../../common/totp';

export interface SessionMeta { client?: string | null; ip?: string | null; userAgent?: string | null; /** 10.4-D client-generated device id (X-Device-Id) */ deviceId?: string | null }

/** Session policy (setting `security.sessions`). Staff sessions are shorter and expire when idle. */
export const SESSION_DEFAULTS = { staffTokenMinutes: 720, staffIdleMinutes: 480, staffMaxHours: 72 };
export interface SsoConfig { enabled: boolean; issuer: string; clientId: string; clientSecretEnc?: string; redirectUri: string; /** 2.4c-M optional custom-scheme redirect registered with the IdP for the mobile app */ mobileRedirectUri?: string; allowedDomains: string[]; label: string }
/** 2.4c-M deep links an SSO sign-in may return to (the mobile app scheme). */
const SSO_APP_RETURN = /^gutad:\/\/[A-Za-z0-9/_-]*$/;

const ACCESS_TOKEN_MAX_SECONDS = 7 * 86400;

@Injectable()
export class AuthService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly jwt: JwtService,
    private readonly crypto: CryptoService,
    private readonly notify: NotifyService,
    private readonly redis: RedisService,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
    private readonly acl: AclService,
    private readonly events: SecurityEventsService,
  ) {}

  private blockedMessage(status: string) {
    if (status === 'SUSPENDED') return { message: 'This account is suspended', code: 'ACCOUNT_SUSPENDED' };
    if (status === 'ARCHIVED') return { message: 'This account has been archived', code: 'ACCOUNT_ARCHIVED' };
    return { message: 'This account has been disabled', code: 'ACCOUNT_DISABLED' };
  }

  policy() {
    return this.settings.getObject<AccessPolicy>('security.access_policy', DEFAULT_ACCESS_POLICY);
  }

  /** Failed-attempt counters per account and per IP; locks the account after `maxLoginAttempts`. */
  private async loginFailed(email: string, meta: SessionMeta, userId: string | null, reason: string, method = 'pwd') {
    const p = await this.policy();
    const k = `login:fail:${email}`;
    const n = await this.redis.client.incr(k).catch(() => 0);
    if (n === 1) await this.redis.client.expire(k, p.lockMinutes * 60).catch(() => undefined);
    if (meta.ip) {
      const ik = `login:fail:ip:${meta.ip}`;
      const m = await this.redis.client.incr(ik).catch(() => 0);
      if (m === 1) await this.redis.client.expire(ik, p.lockMinutes * 60).catch(() => undefined);
    }
    const locked = n >= p.maxLoginAttempts;
    await this.events.recordLogin({ userId, email, outcome: locked ? 'LOCKED' : method === 'mfa' ? 'MFA_FAILURE' : 'FAILURE', method, reason, ip: meta.ip, userAgent: meta.userAgent, suspicious: locked });
    if (locked && n === p.maxLoginAttempts) {
      await this.redis.client.set(`login:lock:${email}`, '1', 'EX', p.lockMinutes * 60).catch(() => undefined);
      if (userId) await this.events.raise({ type: 'ACCOUNT_LOCKED', severity: 'HIGH', title: `Account locked after ${n} failed sign-ins: ${email}`, detail: `Last attempt from ${meta.ip || 'unknown IP'}. It unlocks in ${p.lockMinutes} minutes, or unlock it in Users, roles & permissions.`, subjectUserId: userId, data: { ip: meta.ip }, dedupeKey: `lock:${email}:${Math.floor(Date.now() / (p.lockMinutes * 60_000))}` });
    }
  }

  private async assertNotLocked(email: string, meta: SessionMeta) {
    const p = await this.policy();
    const locked = await this.redis.client.exists(`login:lock:${email}`).catch(() => 0);
    if (locked) {
      await this.events.recordLogin({ email, outcome: 'BLOCKED', reason: 'account locked', ip: meta.ip, userAgent: meta.userAgent });
      throw new ForbiddenException({ message: `Too many failed sign-ins. Try again in ${p.lockMinutes} minutes or ask an administrator to unlock the account.`, code: 'ACCOUNT_LOCKED' });
    }
    if (meta.ip) {
      const n = Number(await this.redis.client.get(`login:fail:ip:${meta.ip}`).catch(() => 0)) || 0;
      if (n >= p.ipMaxAttempts) {
        await this.events.recordLogin({ email, outcome: 'BLOCKED', reason: 'ip throttled', ip: meta.ip, userAgent: meta.userAgent, suspicious: true });
        throw new ForbiddenException({ message: 'Too many failed sign-ins from this network. Try again later.', code: 'IP_THROTTLED' });
      }
    }
  }

  async unlock(email: string) {
    await this.redis.del(`login:lock:${email}`, `login:fail:${email}`).catch(() => undefined);
  }

  /** Successful sign-in bookkeeping: counters reset, event logged, staff last-login updated, new-IP alert for staff. */
  private async loginSucceeded(userId: string, email: string, meta: SessionMeta, method: string) {
    await this.redis.del(`login:fail:${email}`).catch(() => undefined);
    const acl = await this.acl.get(userId).catch(() => null);
    let suspicious = false;
    if (acl?.staff) {
      suspicious = await this.events.isNewIp(userId, meta.ip).catch(() => false);
      await this.db.insert(staffProfiles).values({ userId, lastLoginAt: new Date(), lastLoginIp: meta.ip ?? null }).onConflictDoUpdate({ target: staffProfiles.userId, set: { lastLoginAt: new Date(), lastLoginIp: meta.ip ?? null, inactiveFlaggedAt: null } });
    }
    await this.events.recordLogin({ userId, email, outcome: 'SUCCESS', method, ip: meta.ip, userAgent: meta.userAgent, suspicious });
    if (suspicious) await this.events.raise({ type: 'SUSPICIOUS_LOGIN', severity: acl?.superadmin ? 'HIGH' : 'MEDIUM', title: `Staff sign-in from a new network: ${email}`, detail: `${meta.ip} · ${meta.userAgent?.slice(0, 120) || 'unknown device'}. Not seen for this account in 30 days.`, subjectUserId: userId, data: { ip: meta.ip, userAgent: meta.userAgent }, dedupeKey: `newip:${userId}:${meta.ip}` });
  }

  /** Stronger verification for critical changes: a current TOTP code when MFA is on, otherwise the password. */
  async verifyStepUp(userId: string, proof?: { code?: string; password?: string } | null) {
    const [u] = await this.db.select().from(users).where(eq(users.id, userId)).limit(1);
    if (!u) throw new UnauthorizedException();
    const fail = () => new ForbiddenException({ message: u.mfaEnabledAt ? 'Enter a current code from your authenticator app to confirm this change' : 'Enter your password to confirm this change', code: 'STEP_UP_REQUIRED', method: u.mfaEnabledAt ? 'totp' : 'password' });
    if (!proof) throw fail();
    if (u.mfaEnabledAt && u.mfaSecret) {
      if (!proof.code || !verifyTotp(this.crypto.decrypt(u.mfaSecret), proof.code)) throw fail();
    } else if (u.passwordHash) {
      if (!proof.password || !(await argon2.verify(u.passwordHash, proof.password))) throw fail();
    } else throw new ForbiddenException({ message: 'Turn on two-factor authentication to make critical changes', code: 'STEP_UP_REQUIRED', method: 'totp' });
    await this.audit.log({ actorId: userId, action: 'auth.step_up', entityType: 'user', entityId: userId });
  }

  async register(input: { email: string; password: string; name?: string; phone?: string; marketingConsent?: boolean }, meta: SessionMeta = {}) {
    const email = input.email.toLowerCase().trim();
    const [existing] = await this.db.select().from(users).where(eq(users.email, email)).limit(1);
    if (existing && !existing.isGuest) throw new ConflictException('Email already registered');
    const passwordHash = await argon2.hash(input.password);
    let user;
    if (existing?.isGuest) {
      [user] = await this.db
        .update(users)
        .set({ passwordHash, name: input.name ?? existing.name, phone: input.phone ?? existing.phone, isGuest: false, marketingConsent: !!input.marketingConsent })
        .where(eq(users.id, existing.id))
        .returning();
    } else {
      [user] = await this.db
        .insert(users)
        .values({ email, passwordHash, name: input.name ?? null, phone: input.phone ?? null, marketingConsent: !!input.marketingConsent })
        .returning();
    }
    if (input.marketingConsent) {
      await this.db.insert(consents).values({ userId: user.id, purpose: 'marketing_email', granted: true, source: 'register' });
    }
    if (!user.emailVerifiedAt) await this.sendEmailVerification(user.id).catch(() => undefined);
    return this.startSession(user.id, ['pwd'], meta);
  }

  /** Password sign-in. Accounts with MFA get a short-lived challenge instead of tokens. */
  async login(email: string, password: string, meta: SessionMeta = {}) {
    const em = email.toLowerCase().trim();
    await this.assertNotLocked(em, meta);
    const [user] = await this.db.select().from(users).where(eq(users.email, em)).limit(1);
    if (!user?.passwordHash) {
      await this.loginFailed(em, meta, user?.id ?? null, user ? 'no password set' : 'unknown account');
      throw new UnauthorizedException('Invalid credentials');
    }
    const ok = await argon2.verify(user.passwordHash, password);
    if (!ok) {
      await this.loginFailed(em, meta, user.id, 'wrong password');
      throw new UnauthorizedException('Invalid credentials');
    }
    if (BLOCKED_STATUSES.includes(user.status)) {
      await this.events.recordLogin({ userId: user.id, email: em, outcome: 'BLOCKED', reason: user.status.toLowerCase(), ip: meta.ip, userAgent: meta.userAgent });
      throw new ForbiddenException(this.blockedMessage(user.status));
    }
    if (user.mfaEnabledAt && user.mfaSecret) {
      const challengeToken = token(24);
      await this.redis.setJson(`mfa:ch:${challengeToken}`, { userId: user.id, meta, tries: 0 }, 300);
      return { mfaRequired: true as const, challengeToken };
    }
    await this.loginSucceeded(user.id, em, meta, 'pwd');
    return this.startSession(user.id, ['pwd'], meta);
  }

  async verifyMfaChallenge(challengeToken: string, code: string) {
    const key = `mfa:ch:${challengeToken}`;
    const ch = await this.redis.getJson<{ userId: string; meta: SessionMeta; tries: number }>(key);
    if (!ch) throw new UnauthorizedException('Sign-in expired, start again');
    if (ch.tries >= 5) {
      await this.redis.del(key);
      throw new UnauthorizedException('Too many attempts, start again');
    }
    const [user] = await this.db.select().from(users).where(eq(users.id, ch.userId)).limit(1);
    if (!user?.mfaSecret) throw new UnauthorizedException();
    if (!(await this.checkSecondFactor(user, code))) {
      await this.redis.setJson(key, { ...ch, tries: ch.tries + 1 }, 300);
      await this.loginFailed(user.email, ch.meta, user.id, 'wrong MFA code', 'mfa');
      throw new UnauthorizedException({ message: 'Incorrect code', code: 'MFA_INVALID' });
    }
    await this.redis.del(key);
    if (BLOCKED_STATUSES.includes(user.status)) throw new ForbiddenException(this.blockedMessage(user.status));
    await this.loginSucceeded(user.id, user.email, ch.meta, 'mfa');
    return this.startSession(user.id, ['pwd', 'mfa'], ch.meta);
  }

  /** TOTP code, or a one-time recovery code (consumed on use). */
  private async checkSecondFactor(user: typeof users.$inferSelect, code: string): Promise<boolean> {
    if (!user.mfaSecret) return false;
    if (verifyTotp(this.crypto.decrypt(user.mfaSecret), code)) return true;
    const h = this.crypto.sha256((code || '').trim().toUpperCase());
    if (user.mfaRecoveryCodes.includes(h)) {
      await this.db.update(users).set({ mfaRecoveryCodes: user.mfaRecoveryCodes.filter((c) => c !== h) }).where(eq(users.id, user.id));
      await this.audit.log({ actorId: user.id, action: 'mfa.recovery_code_used', entityType: 'user', entityId: user.id });
      return true;
    }
    return false;
  }

  /** Guest checkout identity: an account keyed by email without password; can be upgraded later via register. */
  async guest(input: { email: string; name?: string; phone?: string }, meta: SessionMeta = {}) {
    const email = input.email.toLowerCase().trim();
    const [existing] = await this.db.select().from(users).where(eq(users.email, email)).limit(1);
    if (existing && !existing.isGuest) throw new ConflictException('An account exists for this email; please sign in');
    const user =
      existing ??
      (await this.db.insert(users).values({ email, name: input.name ?? null, phone: input.phone ?? null, isGuest: true }).returning())[0];
    return this.startSession(user.id, [], meta, true);
  }

  async refresh(refreshToken: string) {
    const hash = this.crypto.sha256(refreshToken);
    const [row] = await this.db
      .select()
      .from(refreshTokens)
      .where(and(eq(refreshTokens.tokenHash, hash), isNull(refreshTokens.revokedAt)))
      .limit(1);
    if (!row || row.expiresAt < new Date()) throw new UnauthorizedException('Refresh token invalid');
    const [user] = await this.db.select().from(users).where(eq(users.id, row.userId)).limit(1);
    if (!user || BLOCKED_STATUSES.includes(user.status)) throw new UnauthorizedException('Account disabled');
    let sessionId = row.sessionId;
    if (sessionId) {
      const [s] = await this.db.select().from(userSessions).where(eq(userSessions.id, sessionId)).limit(1);
      if (!s || s.revokedAt || s.expiresAt < new Date()) throw new UnauthorizedException('Session ended');
      if ((await this.acl.get(user.id)).staff) {
        const policy = await this.settings.getObject('security.sessions', SESSION_DEFAULTS);
        if (Date.now() - s.lastSeenAt.getTime() > policy.staffIdleMinutes * 60_000) {
          await this.revokeSessionRow(s.id, 'idle timeout');
          throw new UnauthorizedException({ message: 'Signed out after inactivity', code: 'SESSION_IDLE' });
        }
      }
      await this.db.update(userSessions).set({ lastSeenAt: new Date() }).where(eq(userSessions.id, s.id));
    } else {
      // tokens issued before sessions existed: adopt them into a session
      sessionId = (await this.createSession(row.userId, ['pwd'], {})).id;
    }
    await this.db.update(refreshTokens).set({ revokedAt: new Date() }).where(eq(refreshTokens.id, row.id));
    return this.issueTokens(row.userId, false, sessionId);
  }

  async logout(refreshToken: string) {
    const hash = this.crypto.sha256(refreshToken);
    const [row] = await this.db.update(refreshTokens).set({ revokedAt: new Date() }).where(eq(refreshTokens.tokenHash, hash)).returning();
    if (row?.sessionId) await this.revokeSessionRow(row.sessionId, 'signed out');
  }

  // ───── sessions ─────

  private async createSession(userId: string, amr: string[], meta: SessionMeta) {
    const staff = (await this.acl.compute(userId)).staff;
    const policy = await this.settings.getObject('security.sessions', SESSION_DEFAULTS);
    const expiresAt = staff ? new Date(Date.now() + policy.staffMaxHours * 3600_000) : addDays(new Date(), loadConfig().REFRESH_TOKEN_TTL_DAYS);
    const [s] = await this.db.insert(userSessions).values({ userId, amr, client: meta.client ?? null, ip: meta.ip ?? null, userAgent: meta.userAgent?.slice(0, 300) ?? null, expiresAt }).returning();
    if (meta.deviceId) await this.recordDevice(userId, meta).catch(() => undefined); // a signal only: never blocks sign-in
    return s;
  }

  /** 10.4-D remember the (hashed) device this account signed in from; feeds duplicate-account detection. */
  private async recordDevice(userId: string, meta: SessionMeta) {
    const deviceHash = this.crypto.sha256(`device:${meta.deviceId}`);
    await this.db
      .insert(userDevices)
      .values({ userId, deviceHash, client: meta.client?.slice(0, 40) ?? null, userAgent: meta.userAgent?.slice(0, 300) ?? null })
      .onConflictDoUpdate({ target: [userDevices.userId, userDevices.deviceHash], set: { lastSeenAt: new Date(), signIns: sql`${userDevices.signIns} + 1`, client: meta.client?.slice(0, 40) ?? null, userAgent: meta.userAgent?.slice(0, 300) ?? null } });
  }

  async startSession(userId: string, amr: string[], meta: SessionMeta, isGuest = false) {
    const s = await this.createSession(userId, amr, meta);
    return this.issueTokens(userId, isGuest, s.id);
  }

  async listSessions(userId: string, currentSid?: string) {
    const rows = await this.db
      .select()
      .from(userSessions)
      .where(and(eq(userSessions.userId, userId), isNull(userSessions.revokedAt), gt(userSessions.expiresAt, new Date())))
      .orderBy(desc(userSessions.lastSeenAt))
      .limit(50);
    return rows.map((r) => ({ id: r.id, amr: r.amr, client: r.client, userAgent: r.userAgent, ip: r.ip, lastSeenAt: r.lastSeenAt, createdAt: r.createdAt, expiresAt: r.expiresAt, current: r.id === currentSid }));
  }

  /** Ends a session now: refresh tokens die and its access tokens are rejected by the guard. */
  async revokeSessionRow(sessionId: string, reason: string) {
    await this.db.update(userSessions).set({ revokedAt: new Date(), revokedReason: reason }).where(and(eq(userSessions.id, sessionId), isNull(userSessions.revokedAt)));
    await this.db.update(refreshTokens).set({ revokedAt: new Date() }).where(and(eq(refreshTokens.sessionId, sessionId), isNull(refreshTokens.revokedAt)));
    await this.redis.client.set(`sess:revoked:${sessionId}`, '1', 'EX', ACCESS_TOKEN_MAX_SECONDS).catch(() => undefined);
  }

  async revokeSession(user: JwtPayload, sessionId: string) {
    const [s] = await this.db.select().from(userSessions).where(eq(userSessions.id, sessionId)).limit(1);
    if (!s || s.userId !== user.sub) throw new NotFoundException();
    await this.revokeSessionRow(sessionId, 'signed out by user');
    await this.audit.log({ actorId: user.sub, action: 'session.revoke', entityType: 'user_session', entityId: sessionId });
    return { ok: true };
  }

  /** Revoke every session of a user (optionally keeping one). Also revokes legacy refresh tokens. */
  async revokeAllSessions(userId: string, reason: string, keepSid?: string) {
    const rows = await this.db.select({ id: userSessions.id }).from(userSessions).where(and(eq(userSessions.userId, userId), isNull(userSessions.revokedAt)));
    for (const r of rows) if (r.id !== keepSid) await this.revokeSessionRow(r.id, reason);
    await this.db.update(refreshTokens).set({ revokedAt: new Date() }).where(and(eq(refreshTokens.userId, userId), isNull(refreshTokens.revokedAt), isNull(refreshTokens.sessionId)));
    return { revoked: rows.filter((r) => r.id !== keepSid).length };
  }

  // ───── MFA (TOTP) ─────

  async mfaSetup(user: JwtPayload) {
    const [u] = await this.db.select().from(users).where(eq(users.id, user.sub)).limit(1);
    if (!u) throw new NotFoundException();
    if (u.mfaEnabledAt) throw new BadRequestException('Two-factor authentication is already on');
    const secret = newTotpSecret();
    await this.db.update(users).set({ mfaSecret: this.crypto.encrypt(secret) }).where(eq(users.id, u.id));
    return { secret, otpauthUrl: otpauthUrl(secret, u.email) };
  }

  async mfaEnable(user: JwtPayload, code: string) {
    const [u] = await this.db.select().from(users).where(eq(users.id, user.sub)).limit(1);
    if (!u?.mfaSecret) throw new BadRequestException('Start setup first');
    if (u.mfaEnabledAt) throw new BadRequestException('Two-factor authentication is already on');
    if (!verifyTotp(this.crypto.decrypt(u.mfaSecret), code)) throw new BadRequestException({ message: 'Incorrect code', code: 'MFA_INVALID' });
    const recovery = Array.from({ length: 8 }, () => token(6).replace(/[-_]/g, 'X').slice(0, 8).toUpperCase());
    await this.db.update(users).set({ mfaEnabledAt: new Date(), mfaRecoveryCodes: recovery.map((c) => this.crypto.sha256(c)) }).where(eq(users.id, u.id));
    if (user.sid) await this.db.update(userSessions).set({ amr: ['pwd', 'mfa'] }).where(eq(userSessions.id, user.sid));
    await this.audit.log({ actorId: u.id, action: 'mfa.enable', entityType: 'user', entityId: u.id });
    const tokens = await this.reissue(user);
    return { recoveryCodes: recovery, ...tokens };
  }

  async mfaDisable(user: JwtPayload, code: string) {
    const [u] = await this.db.select().from(users).where(eq(users.id, user.sub)).limit(1);
    if (!u?.mfaEnabledAt) throw new BadRequestException('Two-factor authentication is off');
    if (!(await this.checkSecondFactor(u, code))) throw new BadRequestException({ message: 'Incorrect code', code: 'MFA_INVALID' });
    await this.db.update(users).set({ mfaEnabledAt: null, mfaSecret: null, mfaRecoveryCodes: [] }).where(eq(users.id, u.id));
    await this.audit.log({ actorId: u.id, action: 'mfa.disable', entityType: 'user', entityId: u.id });
    return { ok: true };
  }

  /** New tokens for the current session (after MFA, grants or role changes). */
  async reissue(user: JwtPayload) {
    if (user.sid) {
      const [s] = await this.db.select().from(userSessions).where(eq(userSessions.id, user.sid)).limit(1);
      if (!s || s.revokedAt) throw new UnauthorizedException('Session ended');
      return this.issueTokens(user.sub, !!user.isGuest, user.sid);
    }
    return this.startSession(user.sub, user.amr || ['pwd'], {});
  }

  // ───── SSO (OpenID Connect, authorization code) ─────

  async ssoConfig() {
    const c = await this.settings.get<SsoConfig | null>('security.sso', null);
    return { enabled: !!c?.enabled && !!c.issuer && !!c.clientId, label: c?.label || 'Single sign-on' };
  }

  private async oidc(c: SsoConfig) {
    const cached = await this.redis.getJson<{ authorization_endpoint: string; token_endpoint: string; jwks_uri: string; issuer: string }>(`sso:disc:${c.issuer}`);
    if (cached) return cached;
    const res = await fetch(`${c.issuer.replace(/\/$/, '')}/.well-known/openid-configuration`);
    if (!res.ok) throw new BadRequestException('Identity provider unavailable');
    const d = (await res.json()) as { authorization_endpoint: string; token_endpoint: string; jwks_uri: string; issuer: string };
    await this.redis.setJson(`sso:disc:${c.issuer}`, d, 3600);
    return d;
  }

  /**
   * 2.4c-M mobile apps pass `returnTo` (their deep link, e.g. gutad://auth/sso). The identity provider redirects to
   * `mobileRedirectUri` when configured (a custom-scheme redirect registered with the IdP), otherwise to the web
   * callback, which forwards code and state to the app. The app also gets a one-time `verifier` that must accompany
   * the code, so a code intercepted on the way back can't be redeemed by anyone else.
   */
  async ssoStart(meta: SessionMeta, opts: { returnTo?: string } = {}) {
    const c = await this.settings.get<SsoConfig | null>('security.sso', null);
    if (!c?.enabled) throw new BadRequestException('Single sign-on is not configured');
    const returnTo = opts.returnTo || null;
    if (returnTo && !SSO_APP_RETURN.test(returnTo) && !(loadConfig().NODE_ENV !== 'production' && /^exps?:\/\/[^\s]+$/.test(returnTo))) throw new BadRequestException('Unsupported app return link');
    const d = await this.oidc(c);
    const state = token(16);
    const nonce = token(16);
    const verifier = returnTo ? token(24) : null;
    const redirectUri = returnTo && c.mobileRedirectUri ? c.mobileRedirectUri : c.redirectUri;
    await this.redis.setJson(`sso:state:${state}`, { nonce, meta, returnTo, redirectUri, verifierHash: verifier ? this.crypto.sha256(verifier) : null }, 600);
    const q = new URLSearchParams({ response_type: 'code', client_id: c.clientId, redirect_uri: redirectUri, scope: 'openid email profile', state, nonce });
    return { url: `${d.authorization_endpoint}?${q}`, ...(verifier ? { state, verifier, redirectUri } : {}) };
  }

  /** 2.4c-M the web callback asks where a sign-in started; app sign-ins are forwarded to the app with code and state. */
  async ssoReturn(state: string) {
    const st = await this.redis.getJson<{ returnTo?: string | null }>(`sso:state:${state}`);
    return { returnTo: st?.returnTo || null };
  }

  async ssoCallback(code: string, state: string, verifier?: string) {
    const c = await this.settings.get<SsoConfig | null>('security.sso', null);
    if (!c?.enabled) throw new BadRequestException('Single sign-on is not configured');
    const st = await this.redis.getJson<{ nonce: string; meta: SessionMeta; redirectUri?: string; verifierHash?: string | null }>(`sso:state:${state}`);
    if (!st) throw new UnauthorizedException('Sign-in expired, start again');
    await this.redis.del(`sso:state:${state}`);
    if (st.verifierHash && (!verifier || this.crypto.sha256(verifier) !== st.verifierHash)) throw new UnauthorizedException('Finish signing in on the device that started it');
    const d = await this.oidc(c);
    const body = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: st.redirectUri || c.redirectUri, client_id: c.clientId, client_secret: c.clientSecretEnc ? this.crypto.decrypt(c.clientSecretEnc) : '' });
    const tr = await fetch(d.token_endpoint, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
    if (!tr.ok) throw new UnauthorizedException('Identity provider rejected the sign-in');
    const { id_token } = (await tr.json()) as { id_token?: string };
    if (!id_token) throw new UnauthorizedException('No identity token');
    const claims = await this.verifyIdToken(id_token, d.jwks_uri, d.issuer, c.clientId, st.nonce);
    const email = String(claims.email || '').toLowerCase();
    if (!email || claims.email_verified === false) throw new UnauthorizedException('Identity provider did not return a verified email');
    const domain = email.split('@')[1];
    if (c.allowedDomains.length && !c.allowedDomains.map((x) => x.toLowerCase()).includes(domain)) throw new ForbiddenException('Email domain not allowed for single sign-on');
    const [user] = await this.db.select().from(users).where(eq(users.email, email)).limit(1);
    if (!user || BLOCKED_STATUSES.includes(user.status)) {
      await this.events.recordLogin({ userId: user?.id ?? null, email, outcome: 'BLOCKED', method: 'sso', reason: user ? user.status.toLowerCase() : 'no account', ip: st.meta?.ip, userAgent: st.meta?.userAgent });
      throw new ForbiddenException('No active Gutad account for this identity. Ask an administrator to add you.');
    }
    await this.audit.log({ actorId: user.id, action: 'auth.sso_login', entityType: 'user', entityId: user.id, after: { issuer: d.issuer } });
    await this.loginSucceeded(user.id, email, st.meta || {}, 'sso');
    return this.startSession(user.id, ['sso'], st.meta);
  }

  private async verifyIdToken(jwt: string, jwksUri: string, issuer: string, audience: string, nonce: string): Promise<Record<string, unknown>> {
    const [h, p, sig] = jwt.split('.');
    if (!h || !p || !sig) throw new UnauthorizedException('Malformed identity token');
    const header = JSON.parse(Buffer.from(h, 'base64url').toString()) as { kid?: string; alg?: string };
    if (header.alg !== 'RS256') throw new UnauthorizedException('Unsupported token algorithm');
    const jwks = (await (await fetch(jwksUri)).json()) as { keys: (JsonWebKey & { kid?: string })[] };
    const jwk = jwks.keys.find((k) => k.kid === header.kid) || jwks.keys[0];
    if (!jwk) throw new UnauthorizedException('Signing key not found');
    const ok = cryptoVerify('RSA-SHA256', Buffer.from(`${h}.${p}`), createPublicKey({ key: jwk, format: 'jwk' }), Buffer.from(sig, 'base64url'));
    if (!ok) throw new UnauthorizedException('Identity token signature invalid');
    const claims = JSON.parse(Buffer.from(p, 'base64url').toString()) as Record<string, unknown>;
    const aud = claims.aud;
    if (claims.iss !== issuer) throw new UnauthorizedException('Wrong token issuer');
    if (!(aud === audience || (Array.isArray(aud) && aud.includes(audience)))) throw new UnauthorizedException('Wrong token audience');
    if (typeof claims.exp !== 'number' || claims.exp * 1000 < Date.now()) throw new UnauthorizedException('Identity token expired');
    if (claims.nonce !== nonce) throw new UnauthorizedException('Nonce mismatch');
    return claims;
  }

  // ───── email verification ─────

  /** Emails a 6-digit code and a one-click link (both valid 24h). Resends are limited to one a minute and 10 a day. */
  async sendEmailVerification(userId: string) {
    const [user] = await this.db.select().from(users).where(eq(users.id, userId)).limit(1);
    if (!user) throw new NotFoundException();
    if (user.emailVerifiedAt) return { alreadyVerified: true };
    if ((await this.redis.incrWindow(`emailverify:cool:${userId}`, 60)) > 1) throw new BadRequestException({ message: 'Please wait a minute before requesting another code', code: 'VERIFY_COOLDOWN' });
    if ((await this.redis.incrWindow(`emailverify:day:${userId}`, 86_400)) > 10) throw new BadRequestException({ message: 'Too many codes requested today. Try again tomorrow.', code: 'VERIFY_LIMIT' });
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const raw = token(24);
    await this.redis.setJson(`emailverify:code:${userId}`, { codeHash: this.crypto.sha256(code), tokenHash: this.crypto.sha256(raw), email: user.email, attempts: 0 }, 86_400);
    await this.redis.setJson(`emailverify:tok:${this.crypto.sha256(raw)}`, { userId, email: user.email }, 86_400);
    await this.notify.queue({
      userId,
      template: 'account.verify_email',
      payload: { code, name: user.name, link: `${loadConfig().PUBLIC_WEB_URL}/account/verify?token=${raw}` },
      channels: ['EMAIL'],
    });
    return { sent: true };
  }

  /** Confirms the signed-in user's email with the 6-digit code. Five wrong tries void the code. */
  async verifyEmailCode(userId: string, code: string) {
    const key = `emailverify:code:${userId}`;
    const st = await this.redis.getJson<{ codeHash: string; tokenHash: string; email: string; attempts: number }>(key);
    const [user] = await this.db.select().from(users).where(eq(users.id, userId)).limit(1);
    if (!user) throw new NotFoundException();
    if (user.emailVerifiedAt) return { verified: true };
    if (!st || st.email !== user.email) throw new BadRequestException({ message: 'This code has expired. Send a new one.', code: 'VERIFY_EXPIRED' });
    if (this.crypto.sha256(code.trim()) !== st.codeHash) {
      if (st.attempts + 1 >= 5) await this.redis.del(key, `emailverify:tok:${st.tokenHash}`);
      else await this.redis.setJson(key, { ...st, attempts: st.attempts + 1 }, 86_400);
      throw new BadRequestException({ message: st.attempts + 1 >= 5 ? 'Too many wrong codes. Send a new one.' : 'That code is not right. Check the email and try again.', code: 'VERIFY_INVALID' });
    }
    await this.markEmailVerified(userId, st.tokenHash);
    return { verified: true };
  }

  /** Confirms an email from the link in the verification email; works signed out. */
  async verifyEmailToken(rawToken: string) {
    const tokenHash = this.crypto.sha256(rawToken);
    const st = await this.redis.getJson<{ userId: string; email: string }>(`emailverify:tok:${tokenHash}`);
    if (!st) throw new BadRequestException({ message: 'This link is invalid or has expired. Sign in to get a new one.', code: 'VERIFY_EXPIRED' });
    const [user] = await this.db.select().from(users).where(eq(users.id, st.userId)).limit(1);
    if (!user || user.email !== st.email) throw new BadRequestException({ message: 'This link is invalid or has expired. Sign in to get a new one.', code: 'VERIFY_EXPIRED' });
    if (!user.emailVerifiedAt) await this.markEmailVerified(user.id, tokenHash);
    return { verified: true, email: user.email };
  }

  private async markEmailVerified(userId: string, tokenHash: string) {
    await this.db.update(users).set({ emailVerifiedAt: new Date() }).where(eq(users.id, userId));
    await this.redis.del(`emailverify:code:${userId}`, `emailverify:tok:${tokenHash}`);
    await this.audit.log({ actorId: userId, action: 'auth.email_verified', entityType: 'user', entityId: userId });
  }

  // ───── recovery & profile ─────

  async requestRecovery(email: string) {
    const [user] = await this.db.select().from(users).where(eq(users.email, email.toLowerCase().trim())).limit(1);
    if (!user) return; // do not reveal existence
    const raw = token(24);
    await this.db.insert(accountRecoveryTokens).values({ userId: user.id, tokenHash: this.crypto.sha256(raw), expiresAt: addDays(new Date(), 1) });
    await this.notify.queue({
      userId: user.id,
      template: 'account.recovery',
      payload: { link: `${loadConfig().PUBLIC_WEB_URL}/account/recover?token=${raw}` },
      channels: ['EMAIL'],
    });
  }

  async completeRecovery(rawToken: string, newPassword: string) {
    const [row] = await this.db
      .select()
      .from(accountRecoveryTokens)
      .where(and(eq(accountRecoveryTokens.tokenHash, this.crypto.sha256(rawToken)), isNull(accountRecoveryTokens.usedAt)))
      .limit(1);
    if (!row || row.expiresAt < new Date()) throw new BadRequestException('Recovery link invalid or expired');
    await this.db.transaction(async (tx) => {
      await tx.update(users).set({ passwordHash: await argon2.hash(newPassword), isGuest: false }).where(eq(users.id, row.userId));
      await tx.update(accountRecoveryTokens).set({ usedAt: new Date() }).where(eq(accountRecoveryTokens.id, row.id));
    });
    await this.revokeAllSessions(row.userId, 'password reset');
  }

  async me(userId: string) {
    const [user] = await this.db.select().from(users).where(eq(users.id, userId)).limit(1);
    if (!user) throw new NotFoundException();
    const memberships = await this.db.select().from(orgMemberships).where(eq(orgMemberships.userId, userId));
    const addrs = await this.db.select().from(addresses).where(eq(addresses.userId, userId));
    const { passwordHash: _ph, mfaSecret: _ms, mfaRecoveryCodes: rc, ...safe } = user;
    // whether an unexpired verification code is out, so the app can say "we sent a code" only when one was sent
    const emailCodeSent = !user.emailVerifiedAt && !!(await this.redis.getJson<{ email: string }>(`emailverify:code:${userId}`).then((st) => st?.email === user.email));
    return { ...safe, mfaRecoveryCodesLeft: rc.length, memberships, addresses: addrs, emailCodeSent };
  }

  async updateProfile(userId: string, input: Partial<{ name: string; phone: string; locale: string; timezone: string; dietaryNotes: string; marketingConsent: boolean; smsConsent: boolean }>) {
    const [user] = await this.db.update(users).set(input).where(eq(users.id, userId)).returning();
    if (input.marketingConsent !== undefined) {
      await this.db.insert(consents).values({ userId, purpose: 'marketing_email', granted: input.marketingConsent, source: 'profile' });
    }
    if (input.smsConsent !== undefined) {
      await this.db.insert(consents).values({ userId, purpose: 'marketing_sms', granted: input.smsConsent, source: 'profile' });
    }
    const { passwordHash: _ph, mfaSecret: _ms, mfaRecoveryCodes: _rc, ...safe } = user;
    return safe;
  }

  async registerPushToken(userId: string, pushToken: string) {
    const [user] = await this.db.select().from(users).where(eq(users.id, userId)).limit(1);
    if (!user) throw new NotFoundException();
    const tokens = Array.from(new Set([...user.pushTokens, pushToken])).slice(-5);
    await this.db.update(users).set({ pushTokens: tokens }).where(eq(users.id, userId));
    return { ok: true };
  }

  async addAddress(userId: string, input: typeof addresses.$inferInsert) {
    if (input.isDefault) await this.db.update(addresses).set({ isDefault: false }).where(eq(addresses.userId, userId));
    const [row] = await this.db.insert(addresses).values({ ...input, userId }).returning();
    return row;
  }

  async deleteAddress(userId: string, id: string) {
    await this.db.delete(addresses).where(and(eq(addresses.id, id), eq(addresses.userId, userId)));
    return { ok: true };
  }

  // ───── tokens ─────

  /** Builds the JWT with memberships, staff scope, MFA state and active grants embedded so guards can authorize without DB hits. */
  async issueTokens(userId: string, isGuest = false, sessionId?: string) {
    const [user] = await this.db.select().from(users).where(eq(users.id, userId)).limit(1);
    if (!user) throw new NotFoundException();
    if (!sessionId) sessionId = (await this.createSession(userId, ['pwd'], {})).id;
    const [session] = await this.db.select().from(userSessions).where(eq(userSessions.id, sessionId)).limit(1);
    const amr = session?.amr || [];
    const memberships = await this.db.select().from(orgMemberships).where(eq(orgMemberships.userId, userId));
    const orgs: JwtPayload['orgs'] = {};
    for (const m of memberships) {
      const cur = orgs[m.organizationId] || { roles: [], locationIds: [] };
      cur.roles.push(m.role as RoleName);
      cur.locationIds = m.locationIds.length === 0 || cur.locationIds.length === 0 ? [] : Array.from(new Set([...cur.locationIds, ...m.locationIds]));
      orgs[m.organizationId] = cur;
    }
    await this.acl.invalidate(userId);
    const acl = await this.acl.get(userId);
    const blocked = BLOCKED_STATUSES.includes(user.status);
    const roles = [...user.roles.filter((r) => !isStaffRole(r)), ...(blocked ? [] : acl.staffRoles)] as RoleName[];
    const staff = acl.staff;
    const payload: JwtPayload = { sub: user.id, email: user.email, roles, orgs, isGuest: isGuest || user.isGuest, sid: sessionId, amr };
    const grants = await this.db
      .select()
      .from(accessGrants)
      .where(and(eq(accessGrants.userId, userId), isNull(accessGrants.revokedAt), gt(accessGrants.expiresAt, new Date())))
      .orderBy(desc(accessGrants.createdAt));
    const emergency = grants.find((g) => g.kind === 'EMERGENCY');
    if (emergency && !blocked) payload.elev = { roles: emergency.roles as RoleName[], until: emergency.expiresAt.toISOString(), gid: emergency.id };
    const support = grants.find((g) => g.kind === 'SUPPORT' && g.organizationId);
    if (support) payload.sup = { org: support.organizationId!, until: support.expiresAt.toISOString(), ro: support.readOnly === 1, gid: support.id };
    if (staff || payload.elev) {
      payload.scope = acl.scope;
      if (acl.mfaRequired && !amr.includes('mfa') && !amr.includes('sso')) payload.mfaPending = true;
    }
    const live = { ...payload, acl };
    const policy = await this.settings.getObject('security.sessions', SESSION_DEFAULTS);
    const accessToken = await this.jwt.signAsync(payload, staff ? { expiresIn: policy.staffTokenMinutes * 60 } : {});
    const raw = token(32);
    await this.db.insert(refreshTokens).values({
      userId,
      sessionId,
      tokenHash: this.crypto.sha256(raw),
      expiresAt: session?.expiresAt || addDays(new Date(), loadConfig().REFRESH_TOKEN_TTL_DAYS),
    });
    return {
      accessToken,
      refreshToken: raw,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        roles: user.roles,
        merchantIds: Object.keys(orgs),
        locationIds: Object.values(orgs).flatMap((o) => o.locationIds),
        memberRoles: Object.fromEntries(Object.entries(orgs).map(([k, v]) => [k, v.roles])),
        permissions: permissionsOf(live),
        finePermissions: finePermissionsOf(live),
        staff,
        accessRoles: acl.roles.map((r) => ({ id: r.id, key: r.key, name: r.name, primary: r.primary, endsAt: r.endsAt })),
        elevated: payload.elev ? { roles: payload.elev.roles, until: payload.elev.until, grantId: payload.elev.gid } : null,
        supportAccess: payload.sup ? { organizationId: payload.sup.org, until: payload.sup.until, readOnly: payload.sup.ro, grantId: payload.sup.gid } : null,
        mfaEnabled: !!user.mfaEnabledAt,
        mfaSetupRequired: !!payload.mfaPending && !user.mfaEnabledAt,
      },
    };
  }
}
