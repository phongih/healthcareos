/** Phiên làm việc: người dùng (/api/me), organization đang chọn, vai trò tại organization đó. */
import { createContext, useContext } from 'react';

import type { Role } from './roles';
export { can, ROLE_LABEL, type Role } from './roles';

export interface Me {
  user: { userId: string; displayName: string | null; email: string | null };
  memberships: Array<{
    membershipId: string;
    organization: { organizationId: string; name: string; type: string };
    role: Role;
    accessPolicyId: string | null;
  }>;
}

export interface Session {
  me: Me;
  orgId: string;
  setOrgId: (id: string) => void;
  /** Vai trò tại organization đang chọn (tenant_admin tính ở mọi organization). */
  roles: ReadonlySet<Role>;
  /** Có ít nhất một membership bị access policy giới hạn tại organization đang chọn. */
  restricted: boolean;
}

export const SessionContext = createContext<Session | null>(null);

export function useSession(): Session {
  const s = useContext(SessionContext);
  if (!s) throw new Error('SessionContext missing');
  return s;
}

export function organizationsOf(me: Me): Array<{ organizationId: string; name: string }> {
  const m = new Map<string, string>();
  for (const x of me.memberships) if (x.role !== 'tenant_admin') m.set(x.organization.organizationId, x.organization.name);
  for (const x of me.memberships) if (!m.has(x.organization.organizationId)) m.set(x.organization.organizationId, x.organization.name);
  return [...m].map(([organizationId, name]) => ({ organizationId, name }));
}

export function rolesAt(me: Me, orgId: string): Set<Role> {
  return new Set(me.memberships.filter((m) => m.organization.organizationId === orgId || m.role === 'tenant_admin').map((m) => m.role));
}

