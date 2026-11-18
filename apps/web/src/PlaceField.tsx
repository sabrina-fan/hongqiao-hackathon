import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import type { PlaceOption } from '@nextstop/core';
import { ApiError, searchPlaces } from './api.js';

type Results =
  | { kind: 'idle' | 'pending' }
  | { kind: 'ready'; options: PlaceOption[] }
  | { kind: 'failed'; message: string };
interface Props {
  id: string;
  label: string;
  placeholder: string;
  value: PlaceOption | null;
  onSelect: (place: PlaceOption | null) => void;
  onSessionExpired: (error: unknown) => boolean;
}
export function PlaceField({ id, label, placeholder, value, onSelect, onSessionExpired }: Props) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [results, setResults] = useState<Results>({ kind: 'idle' });
  const reportSession = useRef(onSessionExpired);
  reportSession.current = onSessionExpired;
  const term = query.trim();
  useEffect(() => {
    if (!open || value || !term) return;
    const controller = new AbortController();
    setResults({ kind: 'pending' });
    const timer = setTimeout(async () => {
      try {
        const options = await searchPlaces(term, controller.signal);
        if (!controller.signal.aborted) {
          setResults({ kind: 'ready', options });
          setActive(0);
        }
      } catch (error) {
        if (!controller.signal.aborted && !reportSession.current(error))
          setResults({
            kind: 'failed',
            message: error instanceof ApiError ? error.message : '地点搜索失败，请重试。',
          });
      }
    }, 300);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [term, open, value]);
  const options = open && results.kind === 'ready' ? results.options : [];
  const listId = `${id}-options`;
  function choose(place: PlaceOption) {
    setOpen(false);
    setQuery('');
    setResults({ kind: 'idle' });
    onSelect(place);
  }
  function keyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Escape') setOpen(false);
    else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      setOpen(true);
      setActive((index) =>
        Math.max(0, Math.min(options.length - 1, index + (event.key === 'ArrowUp' ? -1 : 1))),
      );
    } else if (event.key === 'Enter' && options[active]) {
      event.preventDefault();
      choose(options[active]);
    }
  }
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        type="text"
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={options.length > 0}
        aria-controls={options.length ? listId : undefined}
        aria-activedescendant={options[active] ? `${listId}-${active}` : undefined}
        value={value?.name ?? query}
        placeholder={placeholder}
        maxLength={100}
        autoComplete="off"
        onChange={(event) => {
          setQuery(event.target.value);
          setResults({ kind: 'idle' });
          setOpen(true);
          onSelect(null);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={keyDown}
      />
      <div className="hints" aria-live="polite">
        {value && (
          <span className="picked">
            已选择 {value.name}
            {value.address && ` · ${value.address}`}
          </span>
        )}
        {open && !value && results.kind === 'pending' && '搜索中…'}
        {open && !value && results.kind === 'ready' && !options.length && '没有匹配的地点'}
        {open && results.kind === 'failed' && <span role="alert">{results.message}</span>}
      </div>
      {options.length > 0 && (
        <ul className="options" role="listbox" id={listId} aria-label={`${label}搜索结果`}>
          {options.map((place, index) => (
            <li
              key={place.id}
              role="option"
              id={`${listId}-${index}`}
              aria-selected={active === index}
              className={index === active ? 'active' : undefined}
              onPointerDown={(event) => event.preventDefault()}
              onClick={() => choose(place)}
              onMouseEnter={() => setActive(index)}
            >
              <span className="option-name">{place.name}</span>
              {place.address && <span className="option-addr">{place.address}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
