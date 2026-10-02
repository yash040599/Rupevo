// Site-wide settings. Everything here is public (it ships to every visitor),
// so never put a secret in this file.
export const SITE = {
  name: 'Rupevo',
  year: 2026,

  // GitHub repo + workflow the admin "Analyse now" button dispatches.
  repo: {
    owner: 'yash040599',
    name: 'Rupevo',
    branch: 'main',
    workflow: 'refresh-data.yml',
  },

  // Refresh requests are delivered by Web3Forms (https://web3forms.com).
  // Paste the access key emailed to the maintainer to enable in-page sending.
  // Web3Forms keys are designed to be public: a key can only email its owner.
  // While empty, the "Request refresh" button falls back to a mailto: link.
  web3formsKey: '',

  // Assembled at runtime so the address is not sitting in the HTML for scrapers.
  contact: { user: 'yash040599', domain: 'gmail.com' },

  // "Buy me a coffee" via UPI — next step. Leave `id` empty until the UPI ID
  // (e.g. name@okhdfcbank) is ready; the button shows "coming soon" meanwhile.
  upi: { id: '', payee: 'Rupevo' },

  // A visitor can send one refresh request per page per this many hours.
  requestCooldownHours: 6,
};
