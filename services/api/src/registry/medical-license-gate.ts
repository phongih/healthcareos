/**
 * HCOS | Cổng giấy phép khám chữa bệnh: tổ chức chưa được duyệt giấy phép (medical_license_status != 'approved')
 * không được đăng ký bệnh nhân thật. Môi trường dữ liệu giả (HCOS_TRAINING_ENV=1) được miễn để phục vụ thực tập.
 * Trạng thái không xác định (kể cả tổ chức không tồn tại) coi như chưa duyệt: fail-closed.
 */
import { ClinicalError } from '../clinical/encounter.service';

export function assertMayReceiveRealPatients(status: string, trainingEnv: boolean): void {
  if (trainingEnv || status === 'approved') return;
  throw new ClinicalError(
    'INVALID_STATE',
    'Tổ chức chưa được duyệt giấy phép khám chữa bệnh; chưa thể đăng ký bệnh nhân thật.',
    { reason: 'MEDICAL_LICENSE_REQUIRED' },
  );
}
