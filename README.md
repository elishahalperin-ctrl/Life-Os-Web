# Life OS web app

The browser app for the private Life OS vault: view and edit it from any device, including an iPad with no Obsidian.

This repo only hosts the app on GitHub Pages. It holds **no notes and no secrets**. The app talks straight to GitHub's API with a token you paste in on your own device, and every save is a commit to the private vault repo.

- Built from `web/` in the vault repo at commit `c0b6557`. Change the app there, then copy it here; do not edit these files directly.
- Setup, the token and the security model are documented in the vault repo's `web/README.md`.
- The page's Content-Security-Policy is in `index.html` (GitHub Pages cannot send the `_headers` file).
