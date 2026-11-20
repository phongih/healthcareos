/**
 * STAGING / THỰC TẬP: sinh dữ liệu giả nhưng giống thật, đi qua ĐÚNG các API của HealthcareOS.
 *
 * Mỗi thao tác chạy bằng token của chính tài khoản thực tập phụ trách (lễ tân đăng ký, bác sĩ khám,
 * thủ kho nhập, dược sĩ cấp phát, quản lý tạo policy). Vì vậy kiểm tra quyền, RLS, audit hash-chain,
 * sổ cái kho và chống gửi trùng đều chạy như khi người thật thao tác.
 * Token ký bằng khoá RSA sinh tạm trong tiến trình này; khoá không rời bộ nhớ, API thật không tin khoá này.
 *
 *   HCOS_DATABASE_URL=postgres://hcos_api:...@127.0.0.1:5432/hcos npx tsx scripts/seed-training.ts
 *
 * Chạy lại an toàn: phần nào đã có (theo MRN, tên thuốc, tên kho, tên policy) thì bỏ qua.
 * Dữ liệu giả có dấu hiệu nhận biết: MRN bắt đầu "TT", CCCD bắt đầu "099" (không phải mã tỉnh), SĐT đầu "0120" (đầu số đã thu hồi).
 * Lịch hẹn online giả dùng SĐT đầu "01209".
 */
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { SignJWT } from 'jose';
import pg from 'pg';

import { PgAuditSink } from '../packages/security/src/pg-audit-sink';
import type { PgPoolLike } from '../packages/security/src/tenant-context';
import { ClinicalEncounterService, PgClinicalUnitOfWork } from '../services/api/src/clinical/encounter.service';
import { createApiHandler } from '../services/api/src/http/server';
import { AccessPolicyService, PgAccessPolicyUnitOfWork } from '../services/api/src/iam/access-policy.service';
import { PgPharmacyUnitOfWork, PharmacyInventoryService } from '../services/api/src/pharmacy/inventory.service';
import { PgPrescriptionUnitOfWork, PrescriptionService } from '../services/api/src/clinical/prescription.service';
import { BookingService, PgBookingUnitOfWork, PublicBookingService, periodOpen, vnNow } from '../services/api/src/clinical/booking.service';
import { PgQueueBoard, PgQueueUnitOfWork, QueueService } from '../services/api/src/clinical/queue.service';
import type { RateLimiter } from '../services/api/src/http/booking-routes';
import { PersonRegistryService, PgRegistryUnitOfWork } from '../services/api/src/registry/person-registry.service';

// ---------------------------------------------------------------------------
// Cấu hình
// ---------------------------------------------------------------------------
interface Account { username: string; id: string; displayName: string; roles: string[]; policy?: string }
const cfg = JSON.parse(readFileSync(new URL('../deploy/staging/training/accounts.json', import.meta.url), 'utf8')) as {
  tenantId: string; organizationId: string; accounts: Account[];
};
const T = cfg.tenantId;
const ORG = cfg.organizationId;
const acc = (u: string): Account => {
  const a = cfg.accounts.find((x) => x.username === u);
  if (!a) throw new Error(`accounts.json thiếu ${u}`);
  return a;
};

const N_PATIENTS = Number(process.env['TT_PATIENTS'] ?? 40);
const ISS = 'urn:hcos:seed-training';
const AUD = 'hcos-api';
const ICD10 = 'http://hl7.org/fhir/sid/icd-10';
const LOINC = 'http://loinc.org';
const UCUM = 'http://unitsofmeasure.org';
const CCCD_SYSTEM = 'https://moh.gov.vn/cccd';
const MRN_SYSTEM = `urn:hcos:mrn:${ORG}`;

// PRNG cố định để mỗi lần chạy sinh cùng một bộ dữ liệu.
let seed = 20261120;
const rnd = (): number => {
  seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
const int = (a: number, b: number): number => a + Math.floor(rnd() * (b - a + 1));
const dec = (a: number, b: number, d = 1): number => Number((a + rnd() * (b - a)).toFixed(d));
const digits = (n: number): string => Array.from({ length: n }, () => int(0, 9)).join('');

// ---------------------------------------------------------------------------
// Dữ liệu mẫu
// ---------------------------------------------------------------------------
const FAMILY = ['Nguyễn', 'Trần', 'Lê', 'Phạm', 'Hoàng', 'Huỳnh', 'Phan', 'Vũ', 'Võ', 'Đặng', 'Bùi', 'Đỗ', 'Hồ', 'Ngô', 'Dương', 'Lý'];
const MALE = [['Văn', 'An'], ['Văn', 'Bình'], ['Minh', 'Châu'], ['Quốc', 'Dũng'], ['Hữu', 'Đức'], ['Thanh', 'Hải'], ['Gia', 'Huy'], ['Đức', 'Khánh'], ['Hoàng', 'Long'], ['Văn', 'Nam'], ['Minh', 'Phúc'], ['Tấn', 'Sang'], ['Văn', 'Tài'], ['Quang', 'Vinh']];
const FEMALE = [['Thị', 'Anh'], ['Ngọc', 'Bích'], ['Thị', 'Cúc'], ['Thu', 'Dung'], ['Thị', 'Hạnh'], ['Thanh', 'Hương'], ['Thị', 'Lan'], ['Mỹ', 'Linh'], ['Thị', 'Mai'], ['Kim', 'Ngân'], ['Thị', 'Oanh'], ['Phương', 'Thảo'], ['Thị', 'Trang'], ['Bảo', 'Vy']];

/** meds: [thuốc, liều mỗi lần, lần/ngày, số ngày] — số lượng = tích ba số. */
interface Dx { code: string; display: string; reason: string; vitals: 'fever' | 'htn' | 'normal'; meds: Array<[string, number, number, number]> }
const DX: readonly Dx[] = [
  { code: 'J06.9', display: 'Nhiễm trùng đường hô hấp trên cấp', reason: 'Sốt, ho, sổ mũi 2 ngày', vitals: 'fever', meds: [['Paracetamol 500', 1, 2, 5], ['Loratadin 10', 1, 1, 7]] },
  { code: 'J02.9', display: 'Viêm họng cấp', reason: 'Đau họng, nuốt vướng', vitals: 'fever', meds: [['Amoxicillin 500', 1, 2, 7], ['Paracetamol 500', 1, 2, 5]] },
  { code: 'J20.9', display: 'Viêm phế quản cấp', reason: 'Ho đờm 5 ngày', vitals: 'fever', meds: [['Amoxicillin 500', 1, 2, 7], ['Salbutamol 2', 1, 2, 5]] },
  { code: 'I10', display: 'Tăng huyết áp vô căn', reason: 'Tái khám huyết áp định kỳ', vitals: 'htn', meds: [['Amlodipin 5', 1, 1, 30]] },
  { code: 'E11.9', display: 'Đái tháo đường type 2 không biến chứng', reason: 'Tái khám đường huyết', vitals: 'normal', meds: [['Metformin 850', 1, 2, 30]] },
  { code: 'E78.5', display: 'Rối loạn lipid máu', reason: 'Kết quả mỡ máu cao', vitals: 'normal', meds: [['Atorvastatin 20', 1, 1, 30]] },
  { code: 'K29.7', display: 'Viêm dạ dày', reason: 'Đau thượng vị, ợ chua', vitals: 'normal', meds: [['Omeprazol 20', 1, 2, 7], ['Domperidon 10', 1, 2, 5]] },
  { code: 'A09', display: 'Tiêu chảy và viêm dạ dày ruột', reason: 'Tiêu chảy 3 lần/ngày', vitals: 'fever', meds: [['Oresol', 1, 2, 3], ['Berberin 100', 2, 2, 5]] },
  { code: 'M54.5', display: 'Đau thắt lưng', reason: 'Đau lưng sau khi mang vác', vitals: 'normal', meds: [['Ibuprofen 400', 1, 2, 5]] },
  { code: 'N39.0', display: 'Nhiễm trùng đường tiết niệu', reason: 'Tiểu buốt, tiểu rắt', vitals: 'fever', meds: [['Cefuroxim 500', 1, 2, 7]] },
  { code: 'L30.9', display: 'Viêm da', reason: 'Ngứa, mẩn đỏ cánh tay', vitals: 'normal', meds: [['Loratadin 10', 1, 1, 10]] },
  { code: 'H10.9', display: 'Viêm kết mạc', reason: 'Đỏ mắt, cộm mắt', vitals: 'normal', meds: [['Vitamin C 500', 1, 1, 10]] },
];

const MEDS = [
  { brandName: 'Paracetamol 500', genericName: 'Paracetamol', strength: '500mg', form: 'viên nén', unitOfMeasure: 'viên', cost: 300 },
  { brandName: 'Amoxicillin 500', genericName: 'Amoxicillin', strength: '500mg', form: 'viên nang', unitOfMeasure: 'viên', cost: 900 },
  { brandName: 'Cefuroxim 500', genericName: 'Cefuroxim', strength: '500mg', form: 'viên nén bao phim', unitOfMeasure: 'viên', cost: 4200 },
  { brandName: 'Ibuprofen 400', genericName: 'Ibuprofen', strength: '400mg', form: 'viên nén', unitOfMeasure: 'viên', cost: 500 },
  { brandName: 'Loratadin 10', genericName: 'Loratadin', strength: '10mg', form: 'viên nén', unitOfMeasure: 'viên', cost: 400 },
  { brandName: 'Omeprazol 20', genericName: 'Omeprazol', strength: '20mg', form: 'viên nang', unitOfMeasure: 'viên', cost: 700 },
  { brandName: 'Domperidon 10', genericName: 'Domperidon', strength: '10mg', form: 'viên nén', unitOfMeasure: 'viên', cost: 350 },
  { brandName: 'Metformin 850', genericName: 'Metformin', strength: '850mg', form: 'viên nén', unitOfMeasure: 'viên', cost: 600 },
  { brandName: 'Amlodipin 5', genericName: 'Amlodipin', strength: '5mg', form: 'viên nén', unitOfMeasure: 'viên', cost: 450 },
  { brandName: 'Atorvastatin 20', genericName: 'Atorvastatin', strength: '20mg', form: 'viên nén bao phim', unitOfMeasure: 'viên', cost: 1500 },
  { brandName: 'Salbutamol 2', genericName: 'Salbutamol', strength: '2mg', form: 'viên nén', unitOfMeasure: 'viên', cost: 250 },
  { brandName: 'Oresol', genericName: 'Natri clorid, kali clorid, glucose', strength: '4,1g', form: 'thuốc bột', unitOfMeasure: 'gói', cost: 2000 },
  { brandName: 'Berberin 100', genericName: 'Berberin', strength: '100mg', form: 'viên nén', unitOfMeasure: 'viên', cost: 150 },
  { brandName: 'Vitamin C 500', genericName: 'Acid ascorbic', strength: '500mg', form: 'viên nén', unitOfMeasure: 'viên', cost: 200 },
] as const;

const NURSE_POLICY = {
  name: 'Điều dưỡng — che CCCD, chỉ ghi sinh hiệu',
  description: 'Thực tập: điều dưỡng xem hồ sơ nhưng không thấy CCCD/định danh; được đăng ký bệnh nhân và ghi sinh hiệu.',
  rules: [
    { action: 'patient:read', hiddenFields: ['identifiers'] }, { action: 'encounter:read' }, { action: 'patient:register' },
    { action: 'observation:write' }, { action: 'queue:read' },
  ],
};

// ---------------------------------------------------------------------------
// API thật chạy trong tiến trình
// ---------------------------------------------------------------------------
const url = process.env['HCOS_DATABASE_URL'];
if (!url) throw new Error('Thiếu HCOS_DATABASE_URL (role hcos_api, không phải superuser)');
const pgPool = new pg.Pool({ connectionString: url, max: 4 });
const pool = pgPool as unknown as PgPoolLike;
const audit = new PgAuditSink(pool);
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const handler = createApiHandler({
  tenant: { issuer: ISS, audience: AUD, key: publicKey as never, algorithms: ['RS256'] },
  clinical: new ClinicalEncounterService({ uow: new PgClinicalUnitOfWork(pool), audit }),
  registry: new PersonRegistryService({ uow: new PgRegistryUnitOfWork(pool), audit }),
  accessPolicies: new AccessPolicyService({ uow: new PgAccessPolicyUnitOfWork(pool), audit }),
  pharmacy: new PharmacyInventoryService({ uow: new PgPharmacyUnitOfWork(pool), audit }),
  prescriptions: new PrescriptionService({ uow: new PgPrescriptionUnitOfWork(pool), audit }),
  queue: new QueueService({ uow: new PgQueueUnitOfWork(pool), audit }),
  queueBoard: new PgQueueBoard(pool),
  bookings: new BookingService({ uow: new PgBookingUnitOfWork(pool), audit }),
  publicBooking: new PublicBookingService({ pool, audit }),
  // Seed gọi cổng công khai nhiều lần từ cùng một IP: bỏ giới hạn tần suất trong tiến trình này.
  rateLimiter: { take: () => true } as unknown as RateLimiter,
});
const server = createServer((req, res) => void handler(req, res));
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

const tokens = new Map<string, string>();
async function token(username: string): Promise<string> {
  const a = acc(username);
  let t = tokens.get(username);
  if (!t) {
    t = await new SignJWT({ tenant_id: T, org_ids: [ORG], org_id: ORG, roles: a.roles, typ: 'Bearer', azp: 'seed-training' })
      .setProtectedHeader({ alg: 'RS256' }).setIssuer(ISS).setAudience(AUD).setSubject(a.id)
      .setIssuedAt().setExpirationTime('2h').setJti(randomUUID()).sign(privateKey as never);
    tokens.set(username, t);
  }
  return t;
}

class HttpError extends Error {
  constructor(readonly status: number, readonly body: string) { super(`HTTP ${status}: ${body.slice(0, 300)}`); }
}
async function call<R = any>(as: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ data: R; headers: Headers }> {
  const fhir = path.startsWith('/fhir/');
  const r = await fetch(BASE + path, {
    method,
    headers: {
      authorization: `Bearer ${await token(as)}`,
      accept: fhir ? 'application/fhir+json' : 'application/json',
      ...(body !== undefined ? { 'content-type': fhir ? 'application/fhir+json' : 'application/json' } : {}),
      ...headers,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await r.text();
  if (!r.ok) throw new HttpError(r.status, text);
  return { data: (text ? JSON.parse(text) : null) as R, headers: r.headers };
}

const stats: Record<string, number> = {};
const bump = (k: string, n = 1) => { stats[k] = (stats[k] ?? 0) + n; };

// ---------------------------------------------------------------------------
// 1. Danh mục thuốc + kho (thủ kho)
// ---------------------------------------------------------------------------
async function seedPharmacy(): Promise<{ medId: Map<string, string>; counterId: string }> {
  const KHO = 'tt.thukho1';
  const existing = (await call<{ medications: Array<{ medicationId: string; brandName: string }> }>(KHO, 'GET', '/api/pharmacy/medications?_count=200')).data.medications;
  const medId = new Map(existing.map((m) => [m.brandName, m.medicationId]));
  for (const m of MEDS) {
    if (medId.has(m.brandName)) continue;
    const { cost: _c, ...body } = m;
    const r = await call<{ medicationId: string }>(KHO, 'POST', '/api/pharmacy/medications', body);
    medId.set(m.brandName, r.data.medicationId);
    bump('thuốc mới');
  }

  const locs = (await call<{ locations: Array<{ locationId: string; name: string; type: string }> }>(KHO, 'GET', `/api/pharmacy/locations?organization=${ORG}`)).data.locations;
  const ensureLoc = async (name: string, type: string): Promise<{ id: string }> => {
    const l = locs.find((x) => x.name === name);
    if (l) return { id: l.locationId };
    const r = await call<{ locationId: string }>(KHO, 'POST', '/api/pharmacy/locations', { organizationId: ORG, name, type });
    bump('kho mới');
    return { id: r.data.locationId };
  };
  const main = await ensureLoc('Kho tổng', 'main_warehouse');
  const counter = await ensureLoc('Quầy cấp phát thực tập', 'dispensary_counter');

  // Khoá chống gửi trùng cố định theo kho + số lô: chạy lại thì API trả bản cũ (replay) hoặc 422 (ngày hết hạn đã khác),
  // không bao giờ cộng kho lần hai.
  const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
  const receive = async (locationId: string, m: (typeof MEDS)[number], batch: string, expiry: string, qty: number) => {
    try {
      const r = await call(KHO, 'POST', '/api/pharmacy/receipts',
        { medicationId: medId.get(m.brandName), locationId, batchNumber: batch, expiryDate: expiry, unitCost: m.cost, quantity: qty },
        { 'idempotency-key': `tt-receipt-${locationId}-${batch}` });
      bump(r.headers.get('idempotent-replayed') ? 'lô đã nhập (bỏ qua)' : 'lô nhập');
    } catch (e) {
      if (e instanceof HttpError && e.status === 422 && e.body.includes('IDEMPOTENCY_KEY_REUSED')) return void bump('lô đã nhập (bỏ qua)');
      throw e;
    }
  };
  for (const [i, m] of MEDS.entries()) {
    const code = m.brandName.split(' ')[0]!.slice(0, 4).toUpperCase();
    const n = String(i + 1).padStart(2, '0');
    await receive(main.id, m, `TT-${code}-K${n}`, day(int(400, 900)), int(5, 20) * 100);
    // Mỗi thuốc 2 lô ở quầy: 1 lô cận hạn (để thực hành FEFO và cảnh báo), 1 lô hạn xa.
    await receive(counter.id, m, `TT-${code}-Q${n}A`, day(int(20, 75)), int(3, 8) * 10);
    await receive(counter.id, m, `TT-${code}-Q${n}B`, day(int(300, 720)), int(2, 5) * 100);
  }
  return { medId, counterId: counter.id };
}

// ---------------------------------------------------------------------------
// 2. Bệnh nhân (lễ tân) + đợt khám (bác sĩ) + sinh hiệu + chẩn đoán + cấp phát (dược sĩ)
// ---------------------------------------------------------------------------
function vitals(kind: Dx['vitals'], age: number): Array<[string, string, string, number]> {
  const temp = kind === 'fever' ? dec(37.8, 39.2) : dec(36.4, 37.1);
  const sys = kind === 'htn' ? int(145, 170) : int(105, 130) + (age > 60 ? 10 : 0);
  const dia = kind === 'htn' ? int(88, 100) : int(65, 82);
  return [
    ['8310-5', 'Nhiệt độ', 'Cel', temp],
    ['8867-4', 'Mạch', '/min', kind === 'fever' ? int(90, 110) : int(66, 88)],
    ['8480-6', 'Huyết áp tâm thu', 'mm[Hg]', sys],
    ['8462-4', 'Huyết áp tâm trương', 'mm[Hg]', dia],
    ['59408-5', 'SpO₂', '%', int(95, 99)],
    ['29463-7', 'Cân nặng', 'kg', age < 12 ? dec(15, 40) : dec(45, 78)],
  ];
}

async function seedClinical(medId: Map<string, string>, counterId: string): Promise<void> {
  const LETAN = ['tt.letan1', 'tt.letan2'];
  const BACSI = ['tt.bacsi1', 'tt.bacsi2'];
  const today = new Date();
  // Giờ làm việc theo giờ Việt Nam (UTC+7), 07:30–16:30.
  const vnTime = (daysAgo: number): string => {
    const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - daysAgo, 0, 30 + int(0, 540), int(0, 59)));
    return (d > today ? new Date(today.getTime() - int(5, 90) * 60_000) : d).toISOString();
  };

  for (let i = 1; i <= N_PATIENTS; i++) {
    const male = rnd() < 0.5;
    const [middle, given] = pick(male ? MALE : FEMALE);
    const family = pick(FAMILY);
    const year = int(1948, 2020);
    const age = today.getUTCFullYear() - year;
    const birthDate = `${year}-${String(int(1, 12)).padStart(2, '0')}-${String(int(1, 28)).padStart(2, '0')}`;
    const mrn = `TT${String(i).padStart(5, '0')}`;
    const cccd = rnd() < 0.8 ? `099${digits(9)}` : null;
    const phone = rnd() < 0.7 ? `0120${digits(6)}` : null;
    // Số lần khám và chẩn đoán được rút trước, để chạy lại vẫn ra cùng dữ liệu dù có bỏ qua.
    const visits = Array.from({ length: rnd() < 0.35 ? 2 : 1 }, () => ({ dx: pick(DX), extra: rnd() < 0.25 ? pick(DX) : null, doc: pick(BACSI), daysAgo: int(1, 30) }));
    // ~20% bệnh nhân có đợt khám đang mở hôm nay để thực hành; 3 đợt trong số đó có sẵn đơn chờ cấp (seedPendingPrescriptions).
    const openToday = i % 5 === 0;

    const found = (await call<{ entry?: unknown[] }>(LETAN[0]!, 'GET', `/fhir/Patient?organization=${ORG}&mrn=${mrn}&_count=1`)).data;
    if (found.entry?.length) { bump('bệnh nhân đã có (bỏ qua)'); continue; }

    let patientId: string;
    try {
      const r = await call<{ id: string }>(pick(LETAN), 'POST', '/fhir/Patient', {
        resourceType: 'Patient',
        name: [{ family, given: [middle, given] }],
        gender: male ? 'male' : 'female',
        birthDate,
        ...(phone ? { telecom: [{ system: 'phone', value: phone }] } : {}),
        identifier: [
          { type: { text: 'mrn' }, system: MRN_SYSTEM, value: mrn },
          ...(cccd ? [{ type: { text: 'national_id' }, system: CCCD_SYSTEM, value: cccd }] : []),
        ],
        managingOrganization: { reference: `Organization/${ORG}` },
      });
      patientId = r.data.id;
      bump('bệnh nhân');
    } catch (e) {
      if (e instanceof HttpError && e.status === 409) { bump('bệnh nhân trùng (bỏ qua)'); continue; }
      throw e;
    }

    const all = openToday ? [...visits.slice(0, 1).map((v) => ({ ...v, daysAgo: 0 }))] : visits;
    for (const v of all) {
      const open = v.daysAgo === 0;
      const enc = await call<{ id: string; meta: { versionId: string } }>(v.doc, 'POST', '/fhir/Encounter', {
        resourceType: 'Encounter',
        class: { system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode', code: 'AMB' },
        subject: { reference: `Patient/${patientId}` },
        serviceProvider: { reference: `Organization/${ORG}` },
        reasonCode: [{ text: v.dx.reason }],
        period: { start: vnTime(v.daysAgo) },
      });
      const encounterId = enc.data.id;
      bump(open ? 'đợt khám đang mở' : 'đợt khám');
      const ref = { subject: { reference: `Patient/${patientId}` }, encounter: { reference: `Encounter/${encounterId}` } };

      for (const [code, display, unit, value] of vitals(v.dx.vitals, age)) {
        await call(v.doc, 'POST', '/fhir/Observation', {
          resourceType: 'Observation', status: 'final', ...ref,
          code: { coding: [{ system: LOINC, code, display }] },
          valueQuantity: { value, unit, system: UCUM, code: unit },
        });
        bump('sinh hiệu');
      }
      if (open) continue; // Đợt khám hôm nay: để học viên tự chẩn đoán, kê, cấp phát, đóng.

      for (const dx of [v.dx, ...(v.extra && v.extra.code !== v.dx.code ? [v.extra] : [])]) {
        await call(v.doc, 'POST', '/fhir/Condition', {
          resourceType: 'Condition', ...ref,
          code: { coding: [{ system: ICD10, code: dx.code, display: dx.display }] },
        });
        bump('chẩn đoán');
      }
      // Bác sĩ kê đơn, dược sĩ cấp theo từng dòng đơn, rồi bác sĩ đóng đợt khám.
      const rx = await prescribe(v.doc, encounterId, v.dx, medId);
      for (const item of rx.items) {
        await call('tt.duocsi1', 'POST', '/api/pharmacy/dispenses',
          { medicationId: item.medicationId, locationId: counterId, encounterId, quantity: item.quantityPrescribed, prescriptionItemId: item.itemId },
          { 'idempotency-key': `tt-dispense-${item.itemId}` });
        bump('lần cấp phát theo đơn');
      }
      const cur = await call<{ meta: { versionId: string } }>(v.doc, 'GET', `/fhir/Encounter/${encounterId}`);
      await call(v.doc, 'POST', `/fhir/Encounter/${encounterId}/$close`, undefined, { 'if-match': `W/"${cur.data.meta.versionId}"` });
    }
  }
}

interface RxItem { itemId: string; medicationId: string; quantityPrescribed: number }
async function prescribe(doctor: string, encounterId: string, dx: Dx, medId: Map<string, string>): Promise<{ items: RxItem[] }> {
  const r = await call<{ items: RxItem[] }>(doctor, 'POST', '/api/prescriptions', {
    encounterId,
    note: dx.vitals === 'htn' || dx.code === 'E11.9' || dx.code === 'E78.5' ? 'Tái khám sau 30 ngày' : 'Tái khám nếu không đỡ sau 3 ngày',
    items: dx.meds.map(([brand, dose, perDay, days]) => ({
      medicationId: medId.get(brand),
      doseQuantity: dose,
      doseUnit: MEDS.find((m) => m.brandName === brand)!.unitOfMeasure,
      frequencyPerDay: perDay,
      durationDays: days,
      quantity: Math.ceil(dose * perDay * days),
      instructions: brand === 'Omeprazol 20' ? 'uống trước ăn 30 phút' : 'uống sau ăn',
    })),
  });
  bump('đơn thuốc');
  return r.data;
}

/**
 * Đơn chờ cấp để dược sĩ thực hành: bác sĩ phụ trách kê đơn cho một số đợt khám đang mở (nếu đợt đó chưa có đơn).
 * Chạy được cả trên dữ liệu đã seed từ trước (chỉ thêm đơn còn thiếu).
 */
const PENDING_MRNS = ['TT00030', 'TT00035', 'TT00040'];
async function seedPendingPrescriptions(medId: Map<string, string>): Promise<void> {
  const byId = new Map(cfg.accounts.map((a) => [a.id, a.username]));
  for (const mrn of PENDING_MRNS) {
    const pts = (await call<{ entry?: Array<{ resource: { id: string } }> }>('tt.bacsi1', 'GET', `/fhir/Patient?organization=${ORG}&mrn=${mrn}&_count=1`)).data;
    const patientId = pts.entry?.[0]?.resource.id;
    if (!patientId) continue;
    const encs = (await call<{ entry?: Array<{ resource: { id: string; status: string; reasonCode?: Array<{ text?: string }>; participant?: Array<{ individual?: { reference?: string } }> } }> }>(
      'tt.bacsi1', 'GET', `/fhir/Encounter?patient=${patientId}`)).data.entry ?? [];
    const open = encs.map((e) => e.resource).find((e) => e.status === 'in-progress');
    if (!open) continue;
    const doctor = byId.get(open.participant?.[0]?.individual?.reference?.split('/')[1] ?? '');
    if (!doctor) continue;
    const existing = (await call<{ prescriptions: unknown[] }>(doctor, 'GET', `/api/prescriptions?encounter=${open.id}`)).data.prescriptions;
    if (existing.length > 0) { bump('đơn chờ cấp đã có (bỏ qua)'); continue; }
    const dx = DX.find((d) => d.reason === open.reasonCode?.[0]?.text) ?? DX[0]!;
    await prescribe(doctor, open.id, dx, medId);
    bump('đơn chờ cấp');
  }
}

// ---------------------------------------------------------------------------
// 2b. Hàng đợi: 2 phòng khám, màn hình gọi số, số chờ hôm nay để bác sĩ tập gọi số
// ---------------------------------------------------------------------------
const ROOMS = [['N1', 'Phòng khám Nội 1'], ['N2', 'Phòng khám Nội 2']] as const;
/** Bệnh nhân KHÔNG có đợt khám đang mở (đợt đang mở là TT00005, TT00010, …). */
const QUEUE_MRNS = ['TT00001', 'TT00002', 'TT00003', 'TT00004', 'TT00006', 'TT00007', 'TT00008', 'TT00009'];
const DISPLAY_NAME = 'Màn hình sảnh chờ (thực tập)';

async function seedQueue(): Promise<void> {
  const QL = 'tt.quanly1';
  const LT = 'tt.letan1';
  const sps = (await call<{ servicePoints: Array<{ servicePointId: string; code: string }> }>(QL, 'GET', `/api/service-points?organization=${ORG}`)).data.servicePoints;
  const spId = new Map(sps.map((x) => [x.code, x.servicePointId]));
  for (const [code, name] of ROOMS) {
    if (spId.has(code)) continue;
    const r = await call<{ servicePointId: string }>(QL, 'POST', '/api/service-points', { organizationId: ORG, code, name });
    spId.set(code, r.data.servicePointId);
    bump('phòng khám');
  }

  const displays = (await call<{ displays: Array<{ name: string; isActive: boolean }> }>(QL, 'GET', `/api/queue/displays?organization=${ORG}`)).data.displays;
  if (!displays.some((d) => d.isActive && d.name === DISPLAY_NAME)) {
    const r = await call<{ key: string }>(QL, 'POST', '/api/queue/displays', { organizationId: ORG, name: DISPLAY_NAME });
    bump('màn hình gọi số');
    console.log(`Màn hình gọi số (chỉ in MỘT lần, mở trên TV): ${process.env['TT_PUBLIC_ORIGIN'] ?? 'https://smart.id.vn'}/app/#/board/${r.data.key}`);
  }

  // Số chờ hôm nay: chỉ cấp cho bệnh nhân chưa có số nào hôm nay (chạy lại trong ngày không cấp thêm).
  const today = (await call<{ tickets: Array<{ patientId: string }> }>(LT, 'GET', `/api/queue?organization=${ORG}`)).data.tickets;
  const has = new Set(today.map((t) => t.patientId));
  const now = new Date();
  for (const [i, mrn] of QUEUE_MRNS.entries()) {
    const pt = (await call<{ entry?: Array<{ resource: { id: string; birthDate?: string } }> }>(LT, 'GET', `/fhir/Patient?organization=${ORG}&mrn=${mrn}&_count=1`)).data.entry?.[0]?.resource;
    if (!pt) continue;
    if (has.has(pt.id)) { bump('số thứ tự đã có (bỏ qua)'); continue; }
    const age = pt.birthDate ? now.getFullYear() - Number(pt.birthDate.slice(0, 4)) : 40;
    const priorityReason = age < 6 ? 'child_under_6' : age >= 75 ? 'elderly_75' : null;
    await call(LT, 'POST', '/api/queue/tickets', { servicePointId: spId.get(ROOMS[i % 2]![0]), patientId: pt.id, priorityReason });
    bump('số thứ tự');
  }
}

// ---------------------------------------------------------------------------
// 2c. Đặt lịch online: sức chứa mỗi buổi, đường dẫn cổng, vài lịch hẹn để lễ tân tập check-in
// ---------------------------------------------------------------------------
const BOOKING_SLUG = process.env['TT_BOOKING_SLUG'] ?? 'thuc-tap';
const BOOKING_CAPACITY = 10;
/** Lịch hẹn của người đã có hồ sơ (tập chọn hồ sơ cũ) — chọn bệnh nhân không nằm trong hàng đợi mẫu. */
const BOOKING_EXISTING_MRNS = ['TT00011', 'TT00012'];
const BOOKING_NEW = [
  { familyName: 'Trịnh Văn', givenName: 'Toàn', birthDate: '1988-04-12', sex: 'male', reason: 'Đau đầu, chóng mặt 3 ngày' },
  { familyName: 'Lâm Thị', givenName: 'Hoa', birthDate: '1946-09-30', sex: 'female', reason: 'Tái khám huyết áp' },
  { familyName: 'Mai Gia', givenName: 'Bảo', birthDate: '2022-01-15', sex: 'male', reason: 'Sốt 1 ngày, quấy khóc' },
];

async function seedBooking(): Promise<void> {
  const QL = 'tt.quanly1';
  const LT = 'tt.letan1';
  const sps = (await call<{ servicePoints: Array<{ servicePointId: string; code: string; bookingCapacity: number; version: number }> }>(QL, 'GET', `/api/service-points?organization=${ORG}`)).data.servicePoints;
  for (const sp of sps.filter((x) => ROOMS.some(([c]) => c === x.code) && x.bookingCapacity === 0)) {
    await call(QL, 'POST', `/api/service-points/${sp.servicePointId}/booking-capacity`, { capacity: BOOKING_CAPACITY }, { 'if-match': `W/"${sp.version}"` });
    bump('sức chứa đặt lịch');
  }
  const portal = (await call<{ portal: { slug: string; isActive: boolean } | null }>(QL, 'GET', `/api/booking-portal?organization=${ORG}`)).data.portal;
  const slug = portal?.slug ?? (await call<{ slug: string }>(QL, 'POST', '/api/booking-portal', { organizationId: ORG, slug: BOOKING_SLUG })).data.slug;
  if (!portal) bump('cổng đặt lịch');
  console.log(`Trang đặt lịch online (công khai): ${process.env['TT_PUBLIC_ORIGIN'] ?? 'https://smart.id.vn'}/app/#/book/${slug}`);

  // Buổi gần nhất còn nhận lịch (hôm nay nếu còn kịp, nếu không thì ngày làm việc kế tiếp).
  const now = new Date();
  let date = vnNow(now).date;
  let period: 'morning' | 'afternoon' | null = null;
  for (let d = 0; d < 8 && !period; d++) {
    const t = new Date(`${vnNow(now).date}T00:00:00Z`);
    t.setUTCDate(t.getUTCDate() + d);
    date = t.toISOString().slice(0, 10);
    period = periodOpen(date, 'morning', now) ? 'morning' : periodOpen(date, 'afternoon', now) ? 'afternoon' : null;
  }
  if (!period) return;
  const existing = (await call<{ bookings: Array<{ phone: string }> }>(LT, 'GET', `/api/bookings?organization=${ORG}&date=${date}`)).data.bookings;
  if (existing.some((b) => b.phone.startsWith('01209'))) {
    bump('lịch hẹn đã có (bỏ qua)');
    return;
  }
  const people: Array<{ familyName: string; givenName: string; birthDate: string; sex: string; reason: string; nationalId?: string }> = [];
  for (const mrn of BOOKING_EXISTING_MRNS) {
    const pt = (await call<{ entry?: Array<{ resource: { name?: Array<{ family?: string; given?: string[] }>; birthDate?: string; gender?: string } }> }>(
      LT, 'GET', `/fhir/Patient?organization=${ORG}&mrn=${mrn}&_count=1`)).data.entry?.[0]?.resource;
    const n = pt?.name?.[0];
    if (!pt?.birthDate || !n?.family || !n.given?.length) continue;
    people.push({ familyName: n.family, givenName: n.given.join(' '), birthDate: pt.birthDate, sex: pt.gender ?? 'unknown', reason: 'Tái khám (đặt online)' });
  }
  people.push(...BOOKING_NEW);
  const opts = (await (await fetch(`${BASE}/api/public/booking/${slug}/options`)).json()) as { consentVersion: string; rooms: Array<{ servicePointId: string; code: string }> };
  const codes: string[] = [];
  for (const [i, p] of people.entries()) {
    const room = opts.rooms[i % opts.rooms.length];
    if (!room) break;
    const r = await fetch(`${BASE}/api/public/booking/${slug}/bookings`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...p, servicePointId: room.servicePointId, visitDate: date, period, phone: `01209${String(10000 + i).slice(-5)}`, consent: true, consentVersion: opts.consentVersion }),
    });
    const text = await r.text();
    if (!r.ok) throw new HttpError(r.status, text);
    codes.push(`${(JSON.parse(text) as { code: string }).code} (${room.code}, ${p.familyName} ${p.givenName})`);
    bump('lịch hẹn online');
  }
  console.log(`Lịch hẹn mẫu ${period === 'morning' ? 'sáng' : 'chiều'} ${date} — mã để tập check-in (dữ liệu giả):`);
  for (const c of codes) console.log(`  ${c}`);
}

// ---------------------------------------------------------------------------
// 3. Access policy cho điều dưỡng (quản lý)
// ---------------------------------------------------------------------------
async function seedPolicy(): Promise<void> {
  const QL = 'tt.quanly1';
  const policies = (await call<{ policies: Array<{ policyId: string; name: string; status: string }> }>(QL, 'GET', '/api/access-policies')).data.policies;
  let p = policies.find((x) => x.name === NURSE_POLICY.name && x.status === 'active') as
    | { policyId: string; name: string; status: string; version: number; rules: Array<{ action: string }> }
    | undefined;
  if (!p) {
    p = (await call<NonNullable<typeof p>>(QL, 'POST', '/api/access-policies', NURSE_POLICY)).data;
    bump('policy');
  } else {
    // Policy tạo từ bản seed cũ: bổ sung các luật còn thiếu (vd. queue:read từ HCOS-F6), giữ nguyên luật đã có.
    const have = new Set(p.rules.map((r) => r.action));
    const missing = NURSE_POLICY.rules.filter((r) => !have.has(r.action));
    if (missing.length > 0) {
      await call(QL, 'POST', `/api/access-policies/${p.policyId}/revise`, { rules: [...p.rules, ...missing] }, { 'if-match': `W/"${p.version}"` });
      bump('policy bổ sung luật');
    }
  }
  const ms = (await call<{ memberships: Array<{ membership: { membershipId: string; userId: string; version: number; accessPolicyId: string | null } }> }>(
    QL, 'GET', `/api/memberships?organization=${ORG}`)).data.memberships;
  for (const a of cfg.accounts.filter((x) => x.policy === 'nurse')) {
    for (const { membership: m } of ms.filter((x) => x.membership.userId === a.id)) {
      if (m.accessPolicyId === p.policyId) continue;
      await call(QL, 'POST', `/api/memberships/${m.membershipId}/access-policy`, { policyId: p.policyId }, { 'if-match': `W/"${m.version}"` });
      bump('gán policy');
    }
  }
}

try {
  const { medId, counterId } = await seedPharmacy();
  await seedClinical(medId, counterId);
  await seedPendingPrescriptions(medId);
  await seedPolicy();
  await seedQueue();
  await seedBooking();
  console.log('Xong. Kết quả:');
  for (const [k, v] of Object.entries(stats)) console.log(`  ${k.padEnd(28)} ${v}`);
} catch (e) {
  console.error('LỖI:', e instanceof Error ? e.message : e);
  console.error('Kết quả đến lúc lỗi:', JSON.stringify(stats));
  process.exitCode = 1;
} finally {
  server.close();
  await pgPool.end();
}
