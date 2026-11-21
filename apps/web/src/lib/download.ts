/** Tải file trong trình duyệt (tách khỏi xlsx.ts để phần ghi file test được ở Node). */
export function downloadXlsx(filename: string, data: Uint8Array): void {
  const blob = new Blob([data.slice().buffer as ArrayBuffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Tải file văn bản (vd. hồ sơ Markdown). */
export function downloadText(filename: string, text: string, type = 'text/markdown;charset=utf-8'): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
