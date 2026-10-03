// Tests for phone detection (used by the "Buy me a coffee" dialog).
// Run with:  node --test "tests/js/*.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mobilePlatform } from '../../site/assets/js/device.js';

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
