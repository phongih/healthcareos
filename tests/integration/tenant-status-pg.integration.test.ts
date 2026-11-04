/**
 * HCOS-P0-ENG-001 | PgTenantStatusLookup + PgAuditSink trên PostgreSQL thật, role hcos_app (RLS hiệu lực).
 * Chạy: HCOS_IT=1 PGHOST=… PGPORT=… PGUSER=… ; tự tạo DB `hcos_ts_<pid>`.
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { asTenantId, type CorrelationId, type NewAuditEvent } from '../../packages/domain/src/s0-contracts';
import { PgAuditSink } from '../../packages/security/src/pg-audit-sink';
import { PgTenantStatusLookup } from '../../packages/security/src/pg-tenant-status';
import { psqlPool } from './psql-pool';

const ENABLED = process.env['HCOS_IT'] === '1';
const DB = `hcos_ts_${process.pid}`;
const MIG = fileURLToPath(new URL('../../infrastructure/database/migrations', import.meta.url));
const uid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const TA = asTenantId(uid(1)); // active
const TS = asTenantId(uid(2)); // suspended
const TX = asTenantId(uid(3)); // không tồn tại

const su = (sql: string, db = DB) => execFileSync('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-d', db, '-c', sql], { encoding: 'utf8' });
const scalar = (sql: string) => execFileSync('psql', ['-X', '-tA', '-d', DB, '-c', sql], { encoding: 'utf8' }).trim();

const run = ENABLED ? describe : (describe as unknown as { skip: typeof describe }).skip;

run('PgTenantStatusLookup / PgAuditSink', () => {
  beforeAll(() => {
    su(`CREATE DATABASE ${DB}`, 'postgres');
    for (const f of ['001_s0_init.sql', '002_s1_clinical_init.sql', '003_person_registry.sql']) {
      execFileSync('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-d', DB, '-f', `${MIG}/${f}`]);
    }
    su(`INSERT INTO iam.tenants(tenant_id,code,name,status) VALUES ('${TA}','ta','A','active'),('${TS}','ts','S','suspended')`);
  });
  afterAll(() => {
    try { su(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`, 'postgres'); } catch { /* best effort */ }
  });

  it('returns the real status per tenant and null for unknown tenants', async () => {
    const lookup = new PgTenantStatusLookup(psqlPool({ database: DB }));
    expect(await lookup.getStatus(TA)).toBe('active');
    expect(await lookup.getStatus(TS)).toBe('suspended');
    expect(await lookup.getStatus(TX)).toBeNull();
  });

  it('audit sink writes denied events in their own transaction under RLS, hash-chain intact', async () => {
    const sink = new PgAuditSink(psqlPool({ database: DB }));
    const ev = (tenantId: typeof TA): NewAuditEvent => ({
      tenantId, actor: { type: 'user', id: 'sub-x' }, organizationId: null, action: 'person.merge', resourceType: 'Person',
      resourceId: null, personId: null, patientId: null, outcome: 'denied', correlationId: 'c-1' as CorrelationId,
      sourceIp: null, userAgent: null, payload: { code: 'FORBIDDEN' },
    });
    await sink.record(ev(TA));
    await sink.record(ev(TA));
    expect(scalar(`SELECT count(*) FROM platform.audit_events WHERE tenant_id='${TA}' AND outcome='denied'`)).toBe('2');
    // Hash-chain liền mạch.
    expect(scalar(`WITH o AS (SELECT prev_hash, lag(event_hash) OVER (ORDER BY occurred_at, event_id) e FROM platform.audit_events WHERE tenant_id='${TA}')
                   SELECT count(*) FROM o WHERE e IS NOT NULL AND prev_hash <> e`)).toBe('0');
  });
});
