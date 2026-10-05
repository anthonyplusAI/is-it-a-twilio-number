# Is this a Twilio number?

A public checker for a phone number's **Twilio carrier signal**. Enter a US 10-digit number or an international number with its `+` country code. The server uses [Twilio Lookup v2 Line Type Intelligence](https://www.twilio.com/docs/lookup/v2-api/line-type-intelligence) to request carrier information.

## Understanding the result

| Result | Meaning |
| --- | --- |
| Twilio appears in carrier data | Lookup returned a carrier name containing Twilio. This is a clue, not proof that Twilio hosts the number. |
| Another carrier appears | Lookup returned a different carrier. The number may still use Twilio services. |
| No carrier name returned | Lookup returned no usable carrier name, so there is no carrier signal to assess. |

There is no public Twilio API that definitively answers whether **any** number belongs to **any** Twilio customer. The [IncomingPhoneNumbers API](https://www.twilio.com/docs/phone-numbers/api/incomingphonenumber-resource) lists numbers in the authenticated account. [Hosted numbers](https://www.twilio.com/docs/numbers-and-senders/port-host) can keep their original carrier while using Twilio services. Lookup carrier data is unavailable for some line types, and Canadian Line Type Intelligence requires separate approval.

For a quick check of a US number, [Twilio also offers an SMS lookup](https://www.twilio.com/en-us/phone-numbers): text the number to **+1 (855) 747-7626**.

## Development

Requires Node.js 22 or later.

```bash
npm ci
npm test
```

The web app and included command-line checker require operator-side configuration to perform live lookups. The API applies quotas to public requests and does not store submitted phone numbers.

This is an independent utility and is not affiliated with Twilio. The header and favicon use the unmodified [Twilio bug SVG](https://www.twilio.com/assets/icons/twilio-icon.svg) with the project owner's authorization; the page includes Twilio's trademark notice.
