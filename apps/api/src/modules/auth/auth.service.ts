import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as argon2 from 'argon2';
import { and, eq, isNull } from 'drizzle-orm';
import { DB, Db } from '../../db/db.module';
import { accountRecoveryTokens, addresses, consents, orgMemberships, refreshTokens, users } from '../../db/schema';
import { CryptoService } from '../../core/crypto.service';
import { NotifyService } from '../../core/notify.service';
import { loadConfig } from '../../config/config';
import { addDays, token } from '../../common/utils';
import type { JwtPayload, RoleName } from '../../common/auth';

@Injectable()
export class AuthService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly jwt: JwtService,
    private readonly crypto: CryptoService,
    private readonly notify: NotifyService,
  ) {}

  async register(input: { email: string; password: string; name?: string; phone?: string; marketingConsent?: boolean }) {
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
    return this.issueTokens(user.id);
  }

  async login(email: string, password: string) {
    const [user] = await this.db.select().from(users).where(eq(users.email, email.toLowerCase().trim())).limit(1);
    if (!user?.passwordHash) throw new UnauthorizedException('Invalid credentials');
    const ok = await argon2.verify(user.passwordHash, password);
    if (!ok) throw new UnauthorizedException('Invalid credentials');
    return this.issueTokens(user.id);
  }

  /** Guest checkout identity: an account keyed by email without password; can be upgraded later via register. */
  async guest(input: { email: string; name?: string; phone?: string }) {
    const email = input.email.toLowerCase().trim();
    const [existing] = await this.db.select().from(users).where(eq(users.email, email)).limit(1);
    if (existing && !existing.isGuest) throw new ConflictException('An account exists for this email; please sign in');
    const user =
      existing ??
      (await this.db.insert(users).values({ email, name: input.name ?? null, phone: input.phone ?? null, isGuest: true }).returning())[0];
    return this.issueTokens(user.id, true);
  }

  async refresh(refreshToken: string) {
    const hash = this.crypto.sha256(refreshToken);
    const [row] = await this.db
      .select()
      .from(refreshTokens)
      .where(and(eq(refreshTokens.tokenHash, hash), isNull(refreshTokens.revokedAt)))
      .limit(1);
    if (!row || row.expiresAt < new Date()) throw new UnauthorizedException('Refresh token invalid');
    await this.db.update(refreshTokens).set({ revokedAt: new Date() }).where(eq(refreshTokens.id, row.id));
    return this.issueTokens(row.userId);
  }

  async logout(refreshToken: string) {
    const hash = this.crypto.sha256(refreshToken);
    await this.db.update(refreshTokens).set({ revokedAt: new Date() }).where(eq(refreshTokens.tokenHash, hash));
  }

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
      await tx.update(refreshTokens).set({ revokedAt: new Date() }).where(eq(refreshTokens.userId, row.userId));
    });
  }

  async me(userId: string) {
    const [user] = await this.db.select().from(users).where(eq(users.id, userId)).limit(1);
    if (!user) throw new NotFoundException();
    const memberships = await this.db.select().from(orgMemberships).where(eq(orgMemberships.userId, userId));
    const addrs = await this.db.select().from(addresses).where(eq(addresses.userId, userId));
    const { passwordHash: _ph, ...safe } = user;
    return { ...safe, memberships, addresses: addrs };
  }

  async updateProfile(userId: string, input: Partial<{ name: string; phone: string; locale: string; timezone: string; dietaryNotes: string; marketingConsent: boolean; smsConsent: boolean }>) {
    const [user] = await this.db.update(users).set(input).where(eq(users.id, userId)).returning();
    if (input.marketingConsent !== undefined) {
      await this.db.insert(consents).values({ userId, purpose: 'marketing_email', granted: input.marketingConsent, source: 'profile' });
    }
    if (input.smsConsent !== undefined) {
      await this.db.insert(consents).values({ userId, purpose: 'marketing_sms', granted: input.smsConsent, source: 'profile' });
    }
    const { passwordHash: _ph, ...safe } = user;
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

  /** Builds the JWT with org memberships embedded so guards can authorize without DB hits. */
  async issueTokens(userId: string, isGuest = false) {
    const [user] = await this.db.select().from(users).where(eq(users.id, userId)).limit(1);
    if (!user) throw new NotFoundException();
    const memberships = await this.db.select().from(orgMemberships).where(eq(orgMemberships.userId, userId));
    const orgs: JwtPayload['orgs'] = {};
    for (const m of memberships) {
      const cur = orgs[m.organizationId] || { roles: [], locationIds: [] };
      cur.roles.push(m.role as RoleName);
      cur.locationIds = m.locationIds.length === 0 || cur.locationIds.length === 0 ? [] : Array.from(new Set([...cur.locationIds, ...m.locationIds]));
      orgs[m.organizationId] = cur;
    }
    const payload: JwtPayload = { sub: user.id, email: user.email, roles: user.roles as RoleName[], orgs, isGuest: isGuest || user.isGuest };
    const accessToken = await this.jwt.signAsync(payload);
    const raw = token(32);
    await this.db.insert(refreshTokens).values({
      userId,
      tokenHash: this.crypto.sha256(raw),
      expiresAt: addDays(new Date(), loadConfig().REFRESH_TOKEN_TTL_DAYS),
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
      },
    };
  }
}
