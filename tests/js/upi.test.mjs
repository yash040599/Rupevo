// Tests for the UPI app links in the "Buy me a coffee" dialog.
// Run with:  node --test "tests/js/*.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { UPI_APPS, appLink, mobilePlatform } from '../../site/assets/js/upi.js';

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1';
const SAMSUNG = 'Mozilla/5.0 (Linux; Android 15; SM-S928B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/28.0 Chrome/130.0.0.0 Mobile Safari/537.36';
const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15';
const WINDOWS = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

test('platform: iPhone, iPad (which reports a Mac), Android, and desktops', () => {
  assert.equal(mobilePlatform({ userAgent: IPHONE, platform: 'iPhone', maxTouchPoints: 5 }), 'ios');
  assert.equal(mobilePlatform({ userAgent: MAC, platform: 'MacIntel', maxTouchPoints: 5 }), 'ios');
  assert.equal(mobilePlatform({ userAgent: SAMSUNG, platform: 'Linux armv8l', maxTouchPoints: 5 }), 'android');
  assert.equal(mobilePlatform({ userAgent: MAC, platform: 'MacIntel', maxTouchPoints: 0 }), null);
  assert.equal(mobilePlatform({ userAgent: WINDOWS, platform: 'Win32', maxTouchPoints: 10 }), null);
  assert.equal(mobilePlatform(), null);
});

test('Google Pay and slice are offered, and every app is complete', () => {
  const ids = UPI_APPS.map((a) => a.id);
  assert.ok(ids.includes('gpay') && ids.includes('slice'));
  assert.equal(new Set(ids).size, ids.length);
  for (const app of UPI_APPS) {
    assert.match(app.ios, /^[a-z][a-z0-9.+-]*$/, `${app.id}: iOS URL scheme`);
    assert.match(app.android, /^[a-z][\w]*(\.[a-z_][\w]*)+$/i, `${app.id}: Android package`);
    assert.ok(app.name && app.mark && /^#[0-9a-f]{6}$/i.test(app.color), `${app.id}: label`);
  }
});

test('iPhone links open the app through its own scheme', () => {
  const gpay = UPI_APPS.find((a) => a.id === 'gpay');
  const slice = UPI_APPS.find((a) => a.id === 'slice');
  assert.equal(appLink(gpay, 'ios'), 'tez://');
  assert.equal(appLink(slice, 'ios'), 'slice-upi://');
});

test('Android links open the Play Store page of the app', () => {
  const gpay = UPI_APPS.find((a) => a.id === 'gpay');
  assert.equal(appLink(gpay, 'android'),
    'https://play.google.com/store/apps/details?id=com.google.android.apps.nbu.paisa.user');
  assert.equal(appLink(gpay, null), null);
});

test('no link is a payment link: UPI apps reject those for personal UPI IDs', () => {
  for (const app of UPI_APPS) {
    for (const platform of ['ios', 'android']) {
      const link = appLink(app, platform);
      assert.doesNotMatch(link, /^upi:/i, `${app.id} on ${platform}`);
      assert.doesNotMatch(link, /[?&](pa|am|pn)=|\/pay\b/i, `${app.id} on ${platform}`);
    }
  }
});
