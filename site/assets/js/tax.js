// Tax section pages: shared chrome, the financial-year slider and trivia, and
// the "request a company" form.
import { esc } from './core.js';
import { renderFyProgress } from './fy.js';
import { openContactModal } from './mail.js';
import { renderShell } from './shell.js';
import { pageSeed, renderTrivia } from './trivia.js';

renderShell('tax', { showCurrency: false });

// Different pages start on different items, so moving between steps of the
// flow shows something new. Tax pages mix tax facts with market stories.
document.querySelectorAll('[data-fy-progress]').forEach((el) => renderFyProgress(el));
document.querySelectorAll('[data-trivia]').forEach((el) => renderTrivia(el, { seed: pageSeed(), pool: el.dataset.trivia || 'all' }));

function openCompanyRequest(broker) {
  openContactModal({
    title: 'Request another company',
    intro: `<p>Hold RSUs of a different employer at ${esc(broker)}? Tell me which company —
      I'll get an email, and new guides are added based on requests.</p>`,
    fields: [
      { id: 'company', label: 'Company', required: true, maxlength: 80,
        placeholder: 'e.g. Google, Amazon, Salesforce' },
      { id: 'ticker', label: 'Stock ticker', maxlength: 12, placeholder: 'e.g. GOOGL' },
      { id: 'note', label: 'Note', type: 'textarea', maxlength: 500,
        placeholder: 'Anything that would help, e.g. you also have ESPP shares' },
    ],
    submitLabel: 'Send request',
    successMessage: 'Request sent — thank you!',
    compose: ({ company, ticker, note }) => {
      const tick = ticker.toUpperCase();
      return {
        subject: `Rupevo RSU tax: please add ${company}${tick ? ` (${tick})` : ''} at ${broker}`,
        message: [
          'Company request for the RSU tax guide.',
          '',
          `Company: ${company}`,
          `Ticker: ${tick || '(not given)'}`,
          `Broker: ${broker}`,
          `Page: ${window.location.href}`,
          '',
          `Note from visitor: ${note || '(none)'}`,
        ].join('\n'),
        extra: { request_type: 'company', company, ticker: tick, broker },
      };
    },
  });
}

document.querySelectorAll('[data-request-company]').forEach((btn) => {
  btn.addEventListener('click', () => openCompanyRequest(btn.dataset.requestCompany || 'your broker'));
});
