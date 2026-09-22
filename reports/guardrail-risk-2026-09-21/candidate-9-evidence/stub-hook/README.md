# C9 host hook and Pi SDK stub receipts

These receipts came from focused tests on the clean, committed SF Pi C9 host on
2026-09-22. The host was `4f7fae07f7c04a7ca9f4fdbabc4594a20a8f1d2a`
(tree `4bdbee05cbd490ff3d0f99db43a5133b08a90186`). Its baseline was
`4f901db9c3f5076ea0305dea33ad6e8856e467da`; the matching
`integrations/sf-pi-guardrail/candidate9-sf-pi-from-4f901db9.patch` in Jev has
SHA-256 `cf5a24e73a0b8b88575e096b6325e3f50e75829522c189d50578eaf2ed7119b8`.
The C9 risk baseline SHA-256 was
`4c4f874ef4f19988e7a7db84055ebf28c6d25813723acf2c807934e2c8f15421`.

The focused command was:

```sh
npm test -- --run extensions/sf-guardrail/tests/jev-risk-workflows.test.ts extensions/sf-guardrail/tests/jev-risk-sdk.test.ts extensions/sf-guardrail/tests/jev-risk-hook.test.ts --testTimeout=10000
```

All three test files passed: 51 tests passed and one real local-model arm was
skipped. `hook-workflows.json` records the direct Pi hook comparison with
in-memory stub tools. `sdk-workflows.json` records off/shadow dispatch through
`AgentSession.prompt` and the Pi extension runner. `sdk-representative.json`
records matched off/shadow/enforce workflows with scripted predictions,
counter-only tools, approvals, audit, and fallback checks. In that scripted
run, shadow preserved the off-mode nine accepted operations and three
confirmations. The enforce branch uses a test-only qualified stub.

The receipts contain authored generic operations and no local absolute paths,
email addresses, URLs, or credential-like values; they were copied byte for
byte after inspection. The SHA-256 inventory covers each receipt and this
README. These tests establish C9 **host integration behavior** only. They do
not score a C9 model, establish a model latency result, qualify enforcement,
or execute external operations. A fitted C9 model still needs its own real
shadow bridge and Pi SDK counter-tool run, followed by the prospective and
held-out gates before any enforcement claim.
