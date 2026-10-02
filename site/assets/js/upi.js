// UPI apps offered on phones in the "Buy me a coffee" dialog, and the links
// that open them. Pure functions, unit-tested in tests/js/upi.test.mjs.
//
// UPI apps reject payment links (upi://pay?pa=…) to a personal UPI ID: the
// app opens with the details filled in, but the payment fails. Scanning the
// QR code or typing the UPI ID works, because the payment then starts inside
// the app. So these links only open the app, and the dialog copies the UPI
// ID for the visitor to paste.
//
// iPhone: each app's own URL scheme, as listed in the Razorpay and Juspay iOS
// integration docs (Safari asks "Open in …?"). The generic upi:// scheme
// cannot be used there: iOS hands it to a single app, often WhatsApp.
// Android: the app's Play Store page, which has an Open button when the app is
// installed. Web pages can only open apps through links the app registers,
// and the UPI apps' links are payment links.

export const UPI_APPS = [
  {
    id: 'gpay', name: 'Google Pay', mark: 'G', color: '#1a73e8',
    ios: 'tez', android: 'com.google.android.apps.nbu.paisa.user', payTo: 'Pay UPI ID or number',
  },
  { id: 'slice', name: 'slice', mark: 's', color: '#4c1d95', ios: 'slice-upi', android: 'indwin.c3.shareapp' },
  { id: 'phonepe', name: 'PhonePe', mark: 'Pe', color: '#5f259f', ios: 'phonepe', android: 'com.phonepe.app' },
  { id: 'paytm', name: 'Paytm', mark: 'P', color: '#002e6e', ios: 'paytmmp', android: 'net.one97.paytm' },
  { id: 'cred', name: 'CRED', mark: 'C', color: '#171717', ios: 'credpay', android: 'com.dreamplug.androidapp' },
  { id: 'bhim', name: 'BHIM', mark: 'B', color: '#c2410c', ios: 'bhim', android: 'in.org.npci.upiapp' },
];

/** 'ios', 'android' or null (desktop and anything else), from `navigator`. */
export function mobilePlatform({ userAgent = '', platform = '', maxTouchPoints = 0 } = {}) {
  // iPadOS Safari reports itself as a Mac, but with a touch screen.
  if (/iPhone|iPad|iPod/i.test(userAgent) || (platform === 'MacIntel' && maxTouchPoints > 1)) return 'ios';
  if (/Android/i.test(userAgent)) return 'android';
  return null;
}

/** The link that opens `app` on `platform`, or null where apps cannot be opened. */
export function appLink(app, platform) {
  if (platform === 'ios') return `${app.ios}://`;
  if (platform === 'android') return `https://play.google.com/store/apps/details?id=${encodeURIComponent(app.android)}`;
  return null;
}
