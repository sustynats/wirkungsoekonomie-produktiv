// A capability-bearing entry page must not acquire global scripts or forms.
export const BOOKING_VERIFICATION_ROUTE = 'w/natalie-weber/anfrage-bestaetigen/index.html';

export function preserveBookingVerificationShell(relative, html) {
  if (relative !== BOOKING_VERIFICATION_ROUTE) return false;
  if (!html.includes('<meta name="woek-booking-verification">')
      || !/<meta\s+name="robots"\s+content="noindex, nofollow, noarchive"\s*\/?\s*>/.test(html)
      || !/<meta\s+name="referrer"\s+content="no-referrer"\s*\/?\s*>/.test(html)) {
    throw new Error('BOOKING_VERIFICATION_ISOLATION_MARKERS_REQUIRED');
  }
  return true;
}
