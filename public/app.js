const form = document.querySelector('#lookup-form');
const input = document.querySelector('#phone-number');
const button = document.querySelector('#check-button');
const buttonLabel = document.querySelector('#button-label');
const result = document.querySelector('#result');
const previewNotice = document.querySelector('#preview-notice');
const isFilePreview = window.location.protocol === 'file:';

document.querySelector('#year').textContent = new Date().getFullYear();
if (isFilePreview) previewNotice.hidden = false;

const resultCopy = {
  twilio_signal: {
    title: 'Twilio appears in carrier data',
    summary: 'Lookup returned a carrier name containing Twilio. This is a clue, not proof that Twilio hosts the number.',
    caveat: 'This check cannot identify who uses the number or which Twilio services are active.',
  },
  no_signal: {
    title: 'Another carrier appears',
    summary: 'Lookup returned a different carrier. The number may still use Twilio services.',
    caveat: 'Hosted numbers can keep their existing carrier while using Twilio Messaging.',
  },
  unavailable: {
    title: 'No carrier name returned',
    summary: 'Lookup returned no usable carrier name, so there is no carrier signal to assess.',
    caveat: 'Some number types do not include carrier data. Canadian carrier data needs separate authorization.',
  },
};

function element(tagName, className, text) {
  const node = document.createElement(tagName);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function heading(title) {
  const wrap = element('div', 'result-heading');
  const marker = element('span', 'result-marker');
  marker.setAttribute('aria-hidden', 'true');
  wrap.append(marker, element('h3', '', title));
  return wrap;
}

function showMessage(state, title, summary) {
  result.hidden = false;
  result.dataset.state = state;
  result.setAttribute('role', state === 'error' ? 'alert' : 'status');
  result.setAttribute('aria-live', state === 'error' ? 'assertive' : 'polite');
  result.replaceChildren(heading(title), element('p', 'result-summary', summary));
}

function readableLineType(value) {
  if (!value) return 'Not returned';
  const names = {
    fixedVoip: 'Fixed VoIP',
    nonFixedVoip: 'Non-fixed VoIP',
    tollFree: 'Toll-free',
    sharedCost: 'Shared cost',
  };
  return names[value] || value.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]/g, ' ');
}

function detail(label, value) {
  const item = element('div');
  item.append(element('dt', '', label), element('dd', '', value));
  return item;
}

function showLookup(data) {
  const copy = resultCopy[data.status];
  if (!copy) {
    showMessage('error', 'Result unavailable', 'The lookup returned an unexpected result. Please try again later.');
    return;
  }

  result.hidden = false;
  result.dataset.state = data.status;
  result.setAttribute('role', 'status');
  result.setAttribute('aria-live', 'polite');

  const summary = typeof data.reason === 'string' && data.reason.trim() ? data.reason.trim() : copy.summary;
  const details = element('dl', 'result-details');
  details.append(
    detail('Number checked', data.e164 || data.nationalFormat || 'Not returned'),
    detail('Carrier returned by Lookup', data.carrierName || 'Not returned'),
    detail('Line type', readableLineType(data.lineType)),
  );
  result.replaceChildren(
    heading(copy.title),
    element('p', 'result-summary', summary),
    details,
    element('p', 'result-caveat', copy.caveat),
  );
}

function showApiError(response, data) {
  const message = typeof data?.error?.message === 'string' && data.error.message.trim() ? data.error.message.trim() : null;
  let title = 'Lookup unavailable';
  let fallback = 'The carrier check could not be completed. Please try again later.';

  if (response.status === 400 || response.status === 422) {
    title = 'Check the phone number';
    fallback = 'Use a 10-digit US number or include + and the country code for an international number.';
    input.setAttribute('aria-invalid', 'true');
    input.focus();
  } else if (response.status === 429) {
    title = 'Rate limit reached';
    fallback = 'This site has reached its lookup limit. Please try again later.';
  }

  showMessage('error', title, message || fallback);
}

input.addEventListener('input', () => {
  input.removeAttribute('aria-invalid');
  result.hidden = true;
  result.replaceChildren();
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const phoneNumber = input.value.trim();
  if (!phoneNumber) {
    input.setAttribute('aria-invalid', 'true');
    input.focus();
    showMessage('error', 'Enter a phone number', 'Use a 10-digit US number or include + and the country code for an international number.');
    return;
  }

  if (isFilePreview) {
    showMessage('error', 'Preview only', 'This file preview cannot run lookups. Complete the setup in the README, start the app, and open its local address.');
    return;
  }

  button.disabled = true;
  buttonLabel.textContent = 'Checking…';
  form.setAttribute('aria-busy', 'true');
  showMessage('loading', 'Checking carrier record', 'This usually takes a few seconds.');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25000);
  try {
    const response = await fetch('/api/check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phoneNumber }),
      signal: controller.signal,
      credentials: 'same-origin',
    });
    const data = await response.json().catch(() => null);
    if (input.value.trim() !== phoneNumber) return;
    if (!response.ok) {
      showApiError(response, data);
    } else if (data && typeof data === 'object') {
      showLookup(data);
    } else {
      showMessage('error', 'Result unavailable', 'The lookup returned an unreadable result. Please try again later.');
    }
  } catch (error) {
    if (input.value.trim() !== phoneNumber) return;
    const summary = error.name === 'AbortError'
      ? 'The lookup took too long. Please try again shortly.'
      : 'The carrier check could not connect. Check your connection and try again.';
    showMessage('error', 'Lookup unavailable', summary);
  } finally {
    clearTimeout(timeout);
    button.disabled = false;
    buttonLabel.textContent = 'Check number';
    form.removeAttribute('aria-busy');
  }
});
