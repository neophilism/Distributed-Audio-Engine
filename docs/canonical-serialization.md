# Canonical inputs and v1 compatibility

`DAE-JSON-v1` documents the existing engine encoding: ECMAScript finite-number serialization, unnormalized Unicode strings, UTF-16 code-unit property sorting and preserved array order. This is a bounded safe-integer subset of [RFC 8785](https://www.rfc-editor.org/rfc/rfc8785). Exact money or arbitrary-precision quantities use decimal strings under their owning contract.

The hardening preserves bytes for valid existing engine records. It rejects lone surrogates, unsafe integer numbers, hidden/symbol fields, accessors, sparse arrays, cycles, nesting over 64 levels, over 100,000 values and encodings over 1 MiB. Runtime objects must be ordinary data; this is not a sandbox for hostile JavaScript proxies.

Use `parseCanonicalJson` at untrusted JSON text boundaries. It rejects duplicate object members, including escaped aliases, before any digest/signature input is built. Calling ordinary `JSON.parse` first cannot recover discarded duplicates. The parser returns null-prototype objects, accepts ordinary JSON whitespace and validates the resulting restricted values. It does not require input text already to be canonical.

The controls, attachments and device histories retain their existing v1 domains and encodings. This local contract does not claim interoperability with every upstream assessment digest. The standard remains pinned to `dea8f54cab9130da86a71f36de553766a978daf2`; any future upstream digest/profile migration needs an explicit version, compatibility vectors and preserved historical verification. The authenticated parent/key channel remains an integration prerequisite.
