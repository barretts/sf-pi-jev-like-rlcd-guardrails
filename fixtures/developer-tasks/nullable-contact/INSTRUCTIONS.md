# Repair nullable contact summaries

The contact import can provide `null` for either the display name or email. Repair `src/contact.ts` while keeping the exported input and output types and the function signature.

The summary must trim a present display name, trim and lowercase a present email, and represent an absent or blank email as `null`. Choose the label from the first nonblank value in this order: trimmed display name, normalized email, `Anonymous contact`. A display name keeps its original letter case. A missing email must never become an empty string or the literal text `null`. Do not mutate the contact or weaken its nullable types.

Only `src/contact.ts` may change. Compile with the repository's TypeScript executable using `--project tsconfig.json`, then run `node --test tests/contact.test.mjs`. Compiler and behavioral checks must both pass.
