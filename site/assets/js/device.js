// Which kind of phone the page is on. Pure, unit-tested in tests/js/device.test.mjs.

/** 'ios', 'android' or null (desktop and anything else), from `navigator`. */
export function mobilePlatform({ userAgent = '', platform = '', maxTouchPoints = 0 } = {}) {
  // iPadOS Safari reports itself as a Mac, but with a touch screen.
  if (/iPhone|iPad|iPod/i.test(userAgent) || (platform === 'MacIntel' && maxTouchPoints > 1)) return 'ios';
  if (/Android/i.test(userAgent)) return 'android';
  return null;
}
