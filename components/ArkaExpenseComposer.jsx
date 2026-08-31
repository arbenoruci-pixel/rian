'use client';

import { useEffect, useMemo, useRef } from 'react';

const BUSINESS_PRESETS = [
  { label: 'NAFTË', value: 'NAFTË' },
  { label: 'PARKING', value: 'PARKING' },
  { label: 'MATERIALE', value: 'MATERIALE PUNE' },
  { label: 'SERVIS', value: 'SERVIS / MIRËMBAJTJE' },
  { label: 'TRANSPORT', value: 'TRANSPORT / TAKSI' },
  { label: 'TJETËR', value: '' },
];

const QUICK_AMOUNTS = [5, 10, 20, 50];

function parseAmount(value) {
  const raw = String(value ?? '').trim().replace(/\s/g, '').replace(',', '.');
  const amount = Number(raw);
  return Number.isFinite(amount) && amount > 0 ? amount : 0;
}

function formatMoney(value) {
  const amount = Number(value || 0);
  return new Intl.NumberFormat('de-DE', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Number.isFinite(amount) ? amount : 0);
}

function cleanStaffOptions(rows = []) {
  const byPin = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const pin = String(row?.pin || '').trim();
    if (!pin) continue;
    byPin.set(pin, {
      pin,
      name: String(row?.name || row?.full_name || pin).trim() || pin,
    });
  }
  return [...byPin.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export default function ArkaExpenseComposer({
  open,
  busy = false,
  actor = null,
  title = '',
  amount = '',
  dateKey = '',
  todayKey = '',
  yesterdayKey = '',
  requestType = 'BUSINESS_EXPENSE',
  beneficiaryPin = '',
  beneficiaryName = '',
  staffOptions = [],
  error = '',
  onTitleChange,
  onAmountChange,
  onDateChange,
  onRequestTypeChange,
  onBeneficiaryChange,
  onClose,
  onSubmit,
}) {
  const titleRef = useRef(null);
  const amountRef = useRef(null);
  const closeRef = useRef(onClose);
  const busyRef = useRef(busy);

  closeRef.current = onClose;
  busyRef.current = busy;

  const staff = useMemo(() => cleanStaffOptions(staffOptions), [staffOptions]);
  const amountNumber = parseAmount(amount);
  const cleanTitle = String(title || '').trim();
  const isBusiness = requestType === 'BUSINESS_EXPENSE';
  const isPersonalOther = requestType === 'PERSONAL_OTHER';
  const isPersonal = !isBusiness;
  const selectedBeneficiary = staff.find((row) => row.pin === String(beneficiaryPin || '').trim()) || null;
  const beneficiaryLabel = isPersonalOther
    ? String(beneficiaryName || selectedBeneficiary?.name || beneficiaryPin || '').trim()
    : String(actor?.name || actor?.pin || 'PUNËTORI').trim();
  const canSubmit = cleanTitle.length >= 2
    && amountNumber > 0
    && (!isPersonalOther || String(beneficiaryPin || '').trim());

  const descriptionStep = isBusiness || isPersonalOther ? 3 : 2;
  const amountStep = descriptionStep + 1;
  // ARKA_EXPENSE_MOBILE_PRO_V2:COMPOSER

  useEffect(() => {
    if (!open || typeof window === 'undefined') return undefined;

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const focusTimer = window.setTimeout(() => {
      const target = cleanTitle ? amountRef.current : titleRef.current;
      try { target?.focus?.(); } catch {}
    }, 180);

    const onKeyDown = (event) => {
      if (event.key !== 'Escape' || busyRef.current) return;
      closeRef.current?.();
    };
    window.addEventListener('keydown', onKeyDown);

    return () => {
      window.clearTimeout(focusTimer);
      window.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [open]);

  if (!open) return null;

  function changeRequestType(nextType) {
    onRequestTypeChange?.(nextType);
    if (nextType !== 'PERSONAL_OTHER') {
      onBeneficiaryChange?.({ pin: '', name: '' });
    }
    if (nextType !== 'BUSINESS_EXPENSE' && !cleanTitle) {
      onTitleChange?.('AVANS PERSONAL');
    }
  }

  function choosePreset(value) {
    onRequestTypeChange?.('BUSINESS_EXPENSE');
    onBeneficiaryChange?.({ pin: '', name: '' });
    onTitleChange?.(value);
    window.setTimeout(() => {
      try { (value ? amountRef.current : titleRef.current)?.focus?.(); } catch {}
    }, 40);
  }

  function chooseBeneficiary(pin) {
    const cleanPin = String(pin || '').trim();
    const target = staff.find((row) => row.pin === cleanPin);
    onBeneficiaryChange?.({
      pin: cleanPin,
      name: target?.name || cleanPin,
    });
  }

  function handleBackdrop(event) {
    if (event.target !== event.currentTarget || busy) return;
    onClose?.();
  }

  return (
    <div className="arkaExpenseComposerBackdrop" role="presentation" onMouseDown={handleBackdrop}>
      <form
        className="arkaExpenseComposer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="arka-expense-composer-title"
        onSubmit={(event) => {
          event.preventDefault();
          if (!busy) onSubmit?.();
        }}
      >
        <header className="arkaExpenseComposerHeader">
          <div>
            <div className="arkaExpenseComposerEyebrow">ARKA • KËRKESË E RE</div>
            <h2 id="arka-expense-composer-title">REGJISTRO SHPENZIM</h2>
            <p>Plotësoje në pak hapa. Kërkesa ruhet dhe shkon për miratim.</p>
          </div>
          <button
            type="button"
            className="arkaExpenseComposerClose"
            onClick={onClose}
            disabled={busy}
            aria-label="Mbylle formularin"
          >
            ×
          </button>
        </header>

        <div className="arkaExpenseComposerBody">
          <section className="arkaExpenseStep">
            <div className="arkaExpenseStepTitle"><span>1</span><b>LLOJI I SHPENZIMIT</b></div>
            <div className="arkaExpenseTypeGrid">
              <button
                type="button"
                className={`arkaExpenseTypeCard ${isBusiness ? 'active business' : ''}`}
                onClick={() => changeRequestType('BUSINESS_EXPENSE')}
                disabled={busy}
              >
                <strong>BIZNES</strong>
                <small>Naftë, parking, materiale, servis</small>
              </button>
              <button
                type="button"
                className={`arkaExpenseTypeCard ${isPersonal ? 'active personal' : ''}`}
                onClick={() => changeRequestType('PERSONAL_SELF')}
                disabled={busy}
              >
                <strong>PERSONAL / AVANS</strong>
                <small>Për vete ose për një koleg</small>
              </button>
            </div>

            {isPersonal ? (
              <div className="arkaExpenseScopeGrid">
                <button
                  type="button"
                  className={requestType === 'PERSONAL_SELF' ? 'active' : ''}
                  onClick={() => changeRequestType('PERSONAL_SELF')}
                  disabled={busy}
                >
                  PËR MUA
                </button>
                <button
                  type="button"
                  className={requestType === 'PERSONAL_OTHER' ? 'active' : ''}
                  onClick={() => changeRequestType('PERSONAL_OTHER')}
                  disabled={busy}
                >
                  PËR DIKË TJETËR
                </button>
              </div>
            ) : null}
          </section>

          {isBusiness ? (
            <section className="arkaExpenseStep compact">
              <div className="arkaExpenseStepTitle"><span>2</span><b>ZGJIDH SHPEJT</b></div>
              <div className="arkaExpensePresetGrid">
                {BUSINESS_PRESETS.map((item) => {
                  const active = item.value && cleanTitle.toUpperCase() === item.value.toUpperCase();
                  return (
                    <button
                      key={item.label}
                      type="button"
                      className={active ? 'active' : ''}
                      onClick={() => choosePreset(item.value)}
                      disabled={busy}
                    >
                      {item.label}
                    </button>
                  );
                })}
              </div>
            </section>
          ) : null}

          {isPersonalOther ? (
            <section className="arkaExpenseStep">
              <div className="arkaExpenseStepTitle"><span>2</span><b>ZGJIDH PERSONIN</b></div>
              {staff.length ? (
                <label className="arkaExpenseFieldGroup">
                  <span>PUNËTORI</span>
                  <select
                    className="arkaExpenseSelect"
                    value={String(beneficiaryPin || '')}
                    onChange={(event) => chooseBeneficiary(event.target.value)}
                    disabled={busy}
                  >
                    <option value="">ZGJIDH NGA LISTA</option>
                    {staff.map((row) => (
                      <option key={row.pin} value={row.pin}>{row.name} • PIN {row.pin}</option>
                    ))}
                  </select>
                </label>
              ) : (
                <div className="arkaExpenseManualPersonGrid">
                  <label className="arkaExpenseFieldGroup">
                    <span>PIN-I</span>
                    <input
                      className="arkaExpenseTextInput"
                      inputMode="numeric"
                      value={String(beneficiaryPin || '')}
                      onChange={(event) => onBeneficiaryChange?.({ pin: event.target.value, name: beneficiaryName })}
                      placeholder="P.SH. 2020"
                      disabled={busy}
                    />
                  </label>
                  <label className="arkaExpenseFieldGroup">
                    <span>EMRI</span>
                    <input
                      className="arkaExpenseTextInput"
                      value={String(beneficiaryName || '')}
                      onChange={(event) => onBeneficiaryChange?.({ pin: beneficiaryPin, name: event.target.value })}
                      placeholder="EMRI I PUNËTORIT"
                      disabled={busy}
                    />
                  </label>
                </div>
              )}
              {beneficiaryLabel ? <div className="arkaExpenseSelectedPerson">PËR: <b>{beneficiaryLabel.toUpperCase()}</b>{beneficiaryPin ? ` • PIN ${beneficiaryPin}` : ''}</div> : null}
            </section>
          ) : null}

          <section className="arkaExpenseStep">
            <div className="arkaExpenseStepTitle"><span>{descriptionStep}</span><b>PËRSHKRIMI</b></div>
            <label className="arkaExpenseFieldGroup">
              <span>ÇFARË U PAGUA?</span>
              <input
                ref={titleRef}
                className="arkaExpenseTextInput large"
                value={title}
                onChange={(event) => onTitleChange?.(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    amountRef.current?.focus?.();
                  }
                }}
                placeholder={isBusiness ? 'P.SH. NAFTË PËR FURGON' : 'P.SH. AVANS PERSONAL'}
                maxLength={80}
                autoComplete="off"
                autoCapitalize="sentences"
                enterKeyHint="next"
                disabled={busy}
              />
            </label>
          </section>

          <section className="arkaExpenseStep amountStep">
            <div className="arkaExpenseStepTitle"><span>{amountStep}</span><b>SHUMA</b></div>
            <div className="arkaExpenseAmountWrap">
              <span>€</span>
              <input
                ref={amountRef}
                value={amount}
                onChange={(event) => onAmountChange?.(event.target.value)}
                inputMode="decimal"
                pattern="[0-9]*[.,]?[0-9]*"
                placeholder="0.00"
                autoComplete="off"
                enterKeyHint="done"
                disabled={busy}
              />
            </div>
            <div className="arkaExpenseQuickAmounts">
              {QUICK_AMOUNTS.map((value) => (
                <button
                  key={value}
                  type="button"
                  className={amountNumber === value ? 'active' : ''}
                  onClick={() => onAmountChange?.(String(value))}
                  disabled={busy}
                >
                  €{value}
                </button>
              ))}
            </div>
          </section>

          <section className="arkaExpenseStep compact">
            <div className="arkaExpenseStepTitle"><b>DATA E SHPENZIMIT</b></div>
            <div className="arkaExpenseDateChoice">
              <button
                type="button"
                className={dateKey === todayKey ? 'active' : ''}
                onClick={() => onDateChange?.(todayKey)}
                disabled={busy}
              >
                SOT
              </button>
              <button
                type="button"
                className={dateKey === yesterdayKey ? 'active' : ''}
                onClick={() => onDateChange?.(yesterdayKey)}
                disabled={busy}
              >
                DJE
              </button>
            </div>
          </section>

          {error ? <div className="arkaExpenseComposerError" role="alert">{error}</div> : null}

          <section className="arkaExpensePreview">
            <div className="arkaExpensePreviewTitle">PËRMBLEDHJE</div>
            <div><span>TIPI</span><b>{isBusiness ? 'SHPENZIM BIZNESI' : 'PERSONAL / AVANS'}</b></div>
            {isPersonal ? <div><span>PËR</span><b>{beneficiaryLabel || '—'}</b></div> : null}
            <div><span>PËRSHKRIMI</span><b>{cleanTitle || '—'}</b></div>
            <div><span>DATA</span><b>{dateKey === yesterdayKey ? 'DJE' : 'SOT'}</b></div>
            <div className="total"><span>SHUMA</span><b>€{formatMoney(amountNumber)}</b></div>
          </section>
        </div>

        <footer className="arkaExpenseComposerFooter">
          <button type="button" className="secondary" onClick={onClose} disabled={busy}>ANULO</button>
          <button
            type="submit"
            className="primary"
            disabled={busy}
            aria-disabled={!canSubmit ? 'true' : undefined}
          >
            {busy ? 'DUKE RUAJTUR...' : `DËRGO PËR MIRATIM${amountNumber > 0 ? ` • €${formatMoney(amountNumber)}` : ''}`}
          </button>
        </footer>
      </form>
    </div>
  );
}
