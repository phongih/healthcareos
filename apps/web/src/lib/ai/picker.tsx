/**
 * HCOS-F11 | Ô tìm kiếm mờ cục bộ (Native AI): gõ không dấu / sai chính tả / viết tắt, chọn bằng chuột hoặc ↑ ↓ Enter.
 * Không gọi máy chủ; người dùng luôn là người chọn.
 */
import { useMemo, useState, type ReactNode } from 'react';

import { search, type Indexed } from './fuzzy';

export function FuzzyPicker<T>({
  index, onPick, render, placeholder, label, limit = 8, ariaLabel,
}: {
  index: readonly Indexed<T>[];
  onPick: (item: T) => void;
  render: (item: T) => ReactNode;
  placeholder?: string;
  label?: string;
  limit?: number;
  ariaLabel?: string;
}) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [listId] = useState(() => `fz-${Math.random().toString(36).slice(2, 10)}`);
  const hits = useMemo(() => (q.trim() ? search(index, q, limit) : []), [index, q, limit]);
  const pick = (x: T) => {
    onPick(x);
    setQ('');
    setOpen(false);
  };
  return (
    <div className="fuzzy">
      {label && <span className="field-label">{label}</span>}
      <input
        type="search"
        role="combobox"
        aria-label={ariaLabel ?? label ?? placeholder}
        aria-expanded={open && hits.length > 0}
        aria-controls={listId}
        aria-autocomplete="list"
        placeholder={placeholder}
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
          setActive(0);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={(e: { key: string; preventDefault(): void }) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setActive((a) => Math.min(a + 1, hits.length - 1));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setActive((a) => Math.max(a - 1, 0));
          } else if (e.key === 'Enter' && open && hits[active]) {
            e.preventDefault();
            pick(hits[active]!.item);
          } else if (e.key === 'Escape') {
            setOpen(false);
          }
        }}
      />
      {open && q.trim() && (
        <ul className="fuzzy-list" role="listbox" id={listId}>
          {hits.length === 0 ? (
            <li className="muted">Không thấy — thử gõ khác (không dấu, viết tắt, mã).</li>
          ) : (
            hits.map((h, i) => (
              <li
                key={i}
                role="option"
                aria-selected={i === active}
                className={i === active ? 'active' : ''}
                onMouseDown={(e: { preventDefault(): void }) => {
                  e.preventDefault();
                  pick(h.item);
                }}
                onMouseEnter={() => setActive(i)}
              >
                {render(h.item)}
                <span className="fuzzy-why">{h.why}</span>
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}
