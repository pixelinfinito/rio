# SARIF 2.1.0 JSON schema

`sarif-schema-2.1.0.json` is the official OASIS schema for SARIF 2.1.0 (errata 01), copied unchanged from the OASIS SARIF TC repository (`oasis-tcs/sarif-spec`, `sarif-2.1/schema/sarif-schema-2.1.0.json`; its `id` is `https://docs.oasis-open.org/sarif/sarif/v2.1.0/errata01/os/schemas/sarif-schema-2.1.0.json`). SHA-256: `c3b4bb2d6093897483348925aaa73af03b3e3f4bd4ca38cef26dcb4212a2682e`.

It is test data only: `crates/rio-core/tests/sarif.rs` validates every rendered fixture against it, so the "validates against the official SARIF 2.1.0 schema" requirement of `docs/sarif-mapping.md` is checked on every test run without network access.

Copyright © OASIS Open 2020. All Rights Reserved. The schema is governed by the [OASIS IPR Policy](https://www.oasis-open.org/policies-guidelines/ipr), under which this document may be copied and furnished to others.
