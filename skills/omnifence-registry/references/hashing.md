# Hash an email for the Shared Registry

Every member must turn an email into exactly the same digest, or the registry cannot match a user
across platforms. This file copies normalisation version `1` from
https://docs.omnifence.ai/registry/hashing. The drift check runs the implementation below against the
published test vectors, so this copy cannot silently disagree with the docs.

Put this in **one** module (for example `registry-hash.mjs`) and use it for every check and every
report. If the checks and the reports hash differently, nothing ever matches.

## The rules

Apply these steps in order:

1. Remove whitespace from the start and end. Apply Unicode NFKC normalisation. Convert to lowercase.
2. If whitespace remains inside the value, it is not an email.
3. Split the value at the **last** `@` into a local part and a domain. If either part is empty, the
   value is not an email.
4. If the domain ends with one `.`, remove it. If the domain is then empty, the value is not an email.
5. If the domain is `googlemail.com`, change it to `gmail.com`.
6. If the domain is one of the providers below, remove everything from the first `+` in the local
   part:

   `gmail.com`, `outlook.com`, `hotmail.com`, `live.com`, `msn.com`, `icloud.com`, `me.com`,
   `mac.com`, `proton.me`, `protonmail.com`, `pm.me`, `fastmail.com`, `fastmail.fm`

7. If the domain is `gmail.com`, remove every `.` from the local part.
8. If the local part is now empty, the value is not an email.
9. Join the local part, `@` and the domain. Hash the result with SHA-256, and encode the digest as
   **lowercase hexadecimal** (64 characters).

Step 1 lowercases the whole address, including the local part. Almost no mail system treats the local
part as case-sensitive, and if the hash kept case, a user could avoid a report by changing the case
of one letter.

If a value is not an email after these steps, do not check it and do not report it.

The rules only join spellings that a mail provider delivers to the same inbox. Do not add rules of
your own: joining two different inboxes makes two different people match, and a false match can
refuse an innocent person a service.

## Reference implementation

JavaScript (Node.js 18 or later). Port it line for line to another language if the codebase needs it,
and keep the test below.

```javascript
import { createHash } from 'node:crypto';

const PLUS_ADDRESSING_DOMAINS = new Set([
  'gmail.com',
  'outlook.com',
  'hotmail.com',
  'live.com',
  'msn.com',
  'icloud.com',
  'me.com',
  'mac.com',
  'proton.me',
  'protonmail.com',
  'pm.me',
  'fastmail.com',
  'fastmail.fm',
]);

export function normaliseEmail(raw) {
  const value = raw.trim().normalize('NFKC').toLowerCase();
  const at = value.lastIndexOf('@');
  if (at <= 0 || at === value.length - 1 || /\s/.test(value)) return null;

  let local = value.slice(0, at);
  let domain = value.slice(at + 1);
  if (domain.endsWith('.')) domain = domain.slice(0, -1);
  if (!domain) return null;
  if (domain === 'googlemail.com') domain = 'gmail.com';

  if (PLUS_ADDRESSING_DOMAINS.has(domain)) {
    const plus = local.indexOf('+');
    if (plus >= 0) local = local.slice(0, plus);
  }
  if (domain === 'gmail.com') local = local.replaceAll('.', '');
  return local ? `${local}@${domain}` : null;
}

export function registryDigest(email) {
  const normalised = normaliseEmail(email);
  return normalised && createHash('sha256').update(normalised).digest('hex');
}
```

## Test vectors

| Input                           | Normalised              | SHA-256                                                            |
| ------------------------------- | ----------------------- | ------------------------------------------------------------------ |
| `Jane.Doe@Example.com`          | `jane.doe@example.com`  | `86e0b9e56c17cc4d12387e1949b85053fbe73bc3ce5a1188713a9d300cc6133d` |
| `␠␠jane.doe@example.com␠␠`      | `jane.doe@example.com`  | `86e0b9e56c17cc4d12387e1949b85053fbe73bc3ce5a1188713a9d300cc6133d` |
| `J.a.n.e.D.o.e+promo@gmail.com` | `janedoe@gmail.com`     | `d6117306485ed0e50afab3ac871e98f81699151f30281527d63ff5f233656c69` |
| `janedoe@googlemail.com`        | `janedoe@gmail.com`     | `d6117306485ed0e50afab3ac871e98f81699151f30281527d63ff5f233656c69` |
| `jane+news@outlook.com`         | `jane@outlook.com`      | `5a0b70300b36ef454b660f484ad2a9353e2b4e199f623fe55789406eb07055f5` |
| `jane+news@example.com`         | `jane+news@example.com` | `5a70ec8b461e4cac30f3a4b74cc1281e8ae664423f94429b738152ca14d81b77` |
| `jane-news@yahoo.com`           | `jane-news@yahoo.com`   | `394afddf1f3a96c4f742ab6ca3c470a1b8a5eb386eddcb27e9ca88ce2df71355` |
| `jane.doe@example.com.`         | `jane.doe@example.com`  | `86e0b9e56c17cc4d12387e1949b85053fbe73bc3ce5a1188713a9d300cc6133d` |
| `ＪＡＮＥ@example.com`          | `jane@example.com`      | `8c87b489ce35cf2e2f39f80e282cb2e804932a56a213983eeeb428407d43b52d` |
| `+tag@gmail.com`                | Not an email            | None                                                               |
| `not-an-email`                  | Not an email            | None                                                               |
| `@example.com`                  | Not an email            | None                                                               |

In the input column, `␠` marks a space character.

Add a unit test in the codebase's test framework that runs every row: each input must give the
SHA-256 column exactly, and each "Not an email" row must give `null` (or the language's equivalent).
Write the test before you wire any API call.

## Mistakes to avoid

- Hashing the raw email instead of the normalised value.
- Sending uppercase hex or base64. The API accepts only 64 lowercase hex characters
  (`400 INVALID_REQUEST` otherwise).
- Hashing twice. Hash the normalised email once and send that hex digest.
- Applying the Gmail dot rule to every domain. `first.last+news@company.com` stays unchanged.
- Splitting at the first `@`. Split at the last one.
- Sending, logging, or storing the plaintext email anywhere on the registry path. Only the digest
  leaves the application.

Every check response carries `normalisation_version`. If it is not `1`, stop and tell the user: the
rules changed and this file is out of date.
