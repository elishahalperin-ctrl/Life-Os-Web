# Vendored libraries

Copied unmodified from the npm packages, pinned to releases more than two weeks old. They are served from this
folder so no third-party script ever runs on the same page as your GitHub token.

| File | Package | Version | SHA-256 |
|---|---|---|---|
| marked.umd.js | marked (MIT) | 18.0.14 | 21568877a938d2c4e7d74e27f18e60da96bb73a68809610ca39216e1efebae62 |
| purify.min.js | dompurify (Apache-2.0 or MPL-2.0) | 3.4.16 | 2c90a9b46d6463f26038a29b686e82bc91de01fdac9d5229e7cfe3b360134ea2 |

To update: `npm pack <package>@<version>`, copy `lib/marked.umd.js` and `dist/purify.min.js`, update this table.
