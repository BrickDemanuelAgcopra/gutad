import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { CurrentUser, JwtPayload, Public } from '../../common/auth';
import { zod } from '../../common/zod.pipe';
import { AuthService, SessionMeta } from './auth.service';

const deviceIdOf = (r: Request) => { const d = String(r.headers['x-device-id'] || ''); return /^[A-Za-z0-9_-]{8,128}$/.test(d) ? d : null; }; // 10.4-D
const meta = (r: Request): SessionMeta => ({ ip: r.ip || null, userAgent: (r.headers['user-agent'] as string) || null, client: (r.headers['x-client'] as string) || null, deviceId: deviceIdOf(r) });
const CodeDto = z.object({ code: z.string().min(6).max(12) });

const RegisterDto = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  name: z.string().min(1).optional(),
  phone: z.string().optional(),
  marketingConsent: z.boolean().optional(),
});
const LoginDto = z.object({ email: z.string().email(), password: z.string() });
const GuestDto = z.object({ email: z.string().email(), name: z.string().optional(), phone: z.string().optional() });
const RefreshDto = z.object({ refreshToken: z.string() });
const RecoverDto = z.object({ email: z.string().email() });
const CompleteRecoverDto = z.object({ token: z.string(), password: z.string().min(8) });
const ProfileDto = z.object({
  name: z.string().optional(),
  phone: z.string().optional(),
  locale: z.string().optional(),
  timezone: z.string().optional(),
  dietaryNotes: z.string().optional(),
  marketingConsent: z.boolean().optional(),
  smsConsent: z.boolean().optional(),
});
const PushTokenDto = z.object({ token: z.string() });
export const AddressDto = z.object({
  label: z.string().optional(),
  line1: z.string().min(1),
  line2: z.string().optional(),
  city: z.string().min(1),
  region: z.string().min(1),
  postalCode: z.string().min(1),
  country: z.string().default('US'),
  lat: z.number().optional(),
  lng: z.number().optional(),
  instructions: z.string().optional(),
  isDefault: z.boolean().optional(),
});

@ApiTags('01 Accounts & access')
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public() @Post('register') register(@Req() r: Request, @Body(zod(RegisterDto)) b: z.infer<typeof RegisterDto>) { return this.auth.register(b, meta(r)); }
  @Public() @Post('login') login(@Req() r: Request, @Body(zod(LoginDto)) b: z.infer<typeof LoginDto>) { return this.auth.login(b.email, b.password, meta(r)); }
  @Public() @Post('mfa/verify') mfaVerify(@Body(zod(z.object({ challengeToken: z.string(), code: z.string().min(6).max(12) }))) b: { challengeToken: string; code: string }) { return this.auth.verifyMfaChallenge(b.challengeToken, b.code); }
  @Public() @Get('sso/config') ssoConfig() { return this.auth.ssoConfig(); }
  @Public() @Post('sso/start') ssoStart(@Req() r: Request, @Body(zod(z.object({ returnTo: z.string().max(200).optional() }).optional())) b?: { returnTo?: string }) { return this.auth.ssoStart(meta(r), { returnTo: b?.returnTo }); }
  @Public() @Get('sso/return') ssoReturn(@Query('state') state: string) { return this.auth.ssoReturn(String(state || '')); }
  @Public() @Post('sso/callback') ssoCallback(@Body(zod(z.object({ code: z.string(), state: z.string(), verifier: z.string().max(200).optional() }))) b: { code: string; state: string; verifier?: string }) { return this.auth.ssoCallback(b.code, b.state, b.verifier); }
  @Public() @Post('guest') guest(@Req() r: Request, @Body(zod(GuestDto)) b: z.infer<typeof GuestDto>) { return this.auth.guest(b, meta(r)); }
  @Public() @Post('refresh') refresh(@Body(zod(RefreshDto)) b: z.infer<typeof RefreshDto>) { return this.auth.refresh(b.refreshToken); }
  @Public() @Post('logout') async logout(@Body(zod(RefreshDto)) b: z.infer<typeof RefreshDto>) { await this.auth.logout(b.refreshToken); return { ok: true }; }
  @Public() @Post('recover') async recover(@Body(zod(RecoverDto)) b: z.infer<typeof RecoverDto>) { await this.auth.requestRecovery(b.email); return { ok: true }; }
  @Public() @Post('recover/complete') async complete(@Body(zod(CompleteRecoverDto)) b: z.infer<typeof CompleteRecoverDto>) { await this.auth.completeRecovery(b.token, b.password); return { ok: true }; }

  @ApiBearerAuth() @Post('reissue') reissue(@CurrentUser() u: JwtPayload) { return this.auth.reissue(u); }
  @ApiBearerAuth() @Get('sessions') sessions(@CurrentUser() u: JwtPayload) { return this.auth.listSessions(u.sub, u.sid); }
  @ApiBearerAuth() @Delete('sessions/:id') revokeSession(@CurrentUser() u: JwtPayload, @Param('id') id: string) { return this.auth.revokeSession(u, id); }
  @ApiBearerAuth() @Post('sessions/revoke-others') revokeOthers(@CurrentUser() u: JwtPayload) { return this.auth.revokeAllSessions(u.sub, 'signed out other devices', u.sid); }
  @ApiBearerAuth() @Post('mfa/setup') mfaSetup(@CurrentUser() u: JwtPayload) { return this.auth.mfaSetup(u); }
  @ApiBearerAuth() @Post('mfa/enable') mfaEnable(@CurrentUser() u: JwtPayload, @Body(zod(CodeDto)) b: { code: string }) { return this.auth.mfaEnable(u, b.code); }
  @ApiBearerAuth() @Post('mfa/disable') mfaDisable(@CurrentUser() u: JwtPayload, @Body(zod(CodeDto)) b: { code: string }) { return this.auth.mfaDisable(u, b.code); }
  @ApiBearerAuth() @Get('me') me(@CurrentUser() u: JwtPayload) { return this.auth.me(u.sub); }
  @ApiBearerAuth() @Patch('me') update(@CurrentUser() u: JwtPayload, @Body(zod(ProfileDto)) b: z.infer<typeof ProfileDto>) { return this.auth.updateProfile(u.sub, b); }
  @ApiBearerAuth() @Post('me/push-token') push(@CurrentUser() u: JwtPayload, @Body(zod(PushTokenDto)) b: z.infer<typeof PushTokenDto>) { return this.auth.registerPushToken(u.sub, b.token); }
  @ApiBearerAuth() @Post('me/addresses') addAddress(@CurrentUser() u: JwtPayload, @Body(zod(AddressDto)) b: z.infer<typeof AddressDto>) { return this.auth.addAddress(u.sub, b); }
  @ApiBearerAuth() @Delete('me/addresses/:id') delAddress(@CurrentUser() u: JwtPayload, @Param('id') id: string) { return this.auth.deleteAddress(u.sub, id); }
}
