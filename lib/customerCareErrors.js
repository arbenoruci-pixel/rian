export function customerCareFailure(error) {
  const code = String(error?.code || error?.message || '');
  const status = Number(error?.httpStatus || error?.status || 0);
  // Only a definite application rejection permits editing a failed intent.
  // A lost response or an expired session must retain its idempotency key.
  const rejected = code.startsWith('CUSTOMER_') && [400,403,404,409].includes(status);
  const message = status === 403 && rejected
    ? 'Ky rol nuk mund t’i ndryshojë shënimet e kësaj porosie.'
    : status === 404 && rejected
      ? 'Klienti ose porosia nuk u gjet. Rifresko profilin.'
      : status === 409 && rejected
        ? 'Të dhënat e klientit kanë konflikt. Rifresko profilin para ruajtjes.'
        : status === 400 && rejected
          ? 'Kontrollo vlerësimin dhe shënimin, pastaj ruaje përsëri.'
          : 'Shënimet nuk u ngarkuan. Provo përsëri kur të kthehet lidhja ose hyrja.';
  return { rejected, message };
}
