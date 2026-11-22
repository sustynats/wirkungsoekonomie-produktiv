import test from 'node:test';
import assert from 'node:assert/strict';
import {BOOKING_VERIFICATION_ROUTE, preserveBookingVerificationShell} from './booking-verification-shell.mjs';

const valid = '<!doctype html><html><head><meta name="woek-booking-verification"><meta name="robots" content="noindex, nofollow, noarchive"><meta name="referrer" content="no-referrer"></head><body>Bestätigung</body></html>';

test('only the exact private interaction entry is preserved', () => {
  assert.equal(preserveBookingVerificationShell(BOOKING_VERIFICATION_ROUTE, valid), true);
  assert.equal(preserveBookingVerificationShell('w/natalie-weber/index.html', valid), false);
  assert.equal(preserveBookingVerificationShell('wirkungsticker/index.html', valid), false);
});

test('missing page marker fails closed for the exact entry', () => {
  assert.throws(() => preserveBookingVerificationShell(BOOKING_VERIFICATION_ROUTE,
    valid.replace('<meta name="woek-booking-verification">', '')), /ISOLATION_MARKERS_REQUIRED/);
});

test('the entry cannot lose noindex without blocking normalization', () => {
  assert.throws(() => preserveBookingVerificationShell(BOOKING_VERIFICATION_ROUTE,
    valid.replace('noindex, nofollow, noarchive', 'index, follow')), /ISOLATION_MARKERS_REQUIRED/);
});

test('the entry cannot lose its no-referrer policy', () => {
  assert.throws(() => preserveBookingVerificationShell(BOOKING_VERIFICATION_ROUTE,
    valid.replace('content="no-referrer"', 'content="origin"')), /ISOLATION_MARKERS_REQUIRED/);
});
