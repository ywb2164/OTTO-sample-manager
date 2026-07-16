# Updater signing keys

`otto-updater.key.pub` is the public development key referenced by `tauri.conf.json`.

Private `*.key` files are ignored by Git. Before the first public release, store the private key and its password in the repository's `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` secrets. If a production key replaces this development key, update the public key in `tauri.conf.json` in the same release; losing the matching private key prevents all later in-app updates.
