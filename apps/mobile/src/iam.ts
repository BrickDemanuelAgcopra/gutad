import { when } from './api';

/** IAM (users, roles & permissions) shapes returned by /admin/iam and /iam routes, as used on mobile. */
export interface IamRole { assignmentId: string | null; roleId: string | null; key: string; name: string; kind: string; primary: boolean; endsAt: string | null; state: string }
export interface IamUser { id: string; email: string; name: string | null; status: string; statusReason?: string | null; title: string | null; department: string | null; team?: string | null; mfaEnabled: boolean; lastLoginAt: string | null; lastSeenAt: string | null; sessions: number; inactive: boolean; suspendedUntil?: string | null; roles: IamRole[] }
export interface AccessRequest { id: string; requesterId: string; requesterEmail: string; requesterName: string | null; roleName: string; roleKey: string; privileged: boolean; justification: string; durationHours: number | null; status: string; decisionNote: string | null; createdAt: string; expiresAt: string; canDecide: boolean }

export const hours = (h: number | null) => (h ? (h % 24 === 0 ? `${h / 24} day(s)` : `${h} hour(s)`) : 'permanent');
export const roleText = (r: { name: string; primary?: boolean; endsAt: string | null; state?: string }) => `${r.name}${r.primary ? ' (primary)' : ''}${r.endsAt ? ` until ${when(r.endsAt)}` : ''}${r.state === 'SCHEDULED' ? ' (scheduled)' : ''}`;
