/**
 * Tải file. HCOS-F18: mọi file chứa dữ liệu của hệ thống do MÁY CHỦ tạo (POST /api/exports) — ghi nhật ký xuất,
 * có dấu người xuất và SHA-256. Trình duyệt chỉ nhận file và lưu xuống; không tự dựng file từ dữ liệu.
 */
import { api, ApiError } from './api';

function save(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export interface ExportResult { exportId: string; fileName: string; contentType: string; sha256: string; byteSize: number; rowCount: number; containsPersonal: boolean }

/**
 * Xuất qua máy chủ. Nếu file có dữ liệu cá nhân mà chưa ghi mục đích, máy chủ trả PURPOSE_REQUIRED => hỏi mục đích rồi gửi lại.
 * Trả null nếu người dùng huỷ.
 */
export async function exportFile(dataset: string, params: Record<string, unknown> = {}, purposeHint = ''): Promise<ExportResult | null> {
  let purpose: string | undefined;
  for (;;) {
    try {
      const r = await api<ExportResult & { base64: string }>('POST', '/api/exports', { body: { dataset, params, ...(purpose ? { purpose } : {}) } });
      const bin = atob(r.data.base64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      save(r.data.fileName, new Blob([bytes], { type: r.data.contentType }));
      const { base64: _omit, ...meta } = r.data;
      return meta;
    } catch (e) {
      if (e instanceof ApiError && e.detail === 'PURPOSE_REQUIRED') {
        const p = prompt('File này có dữ liệu cá nhân. Mục đích xuất (ghi vào nhật ký xuất, tối thiểu 5 ký tự):', purpose ?? purposeHint);
        if (p === null) return null;
        purpose = p.trim();
        continue;
      }
      throw e;
    }
  }
}
