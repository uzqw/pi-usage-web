# Contributing to pi-usage-web

Thanks for your interest in improving pi-usage-web!

## How to contribute

1. Fork the repo and create a branch from `main`.
2. Make your change. Keep it small and focused — one feature or
   fix per pull request.
3. Verify locally:

   ```sh
   cd ui && npm install && npm run build   # must pass
   node fetcher/fetch.mjs --once            # must complete without errors
   ```

4. Open a pull request describing what changed and why.

## Code style

- `ui/` is a single-file React app (Vite + TypeScript): no router, no
  component library, plain CSS in `App.css`. New UI belongs in
  `App.tsx` following the same style.
- `pb_hooks/` is plain PocketBase JavaScript (goja). Keep routes
  self-contained; top-level declarations are not reliably shared across
  hook invocations.
- `fetcher/` is plain Node ESM, no build step.
- Format numbers for humans: tokens use compact K/M/B units, money
  uses two-decimal USD.

## Reporting issues

Open a GitHub issue with the PocketBase version, the browser, and
console/network errors. Never paste credentials, cookies, or API keys
into an issue.

## Security

This project reads local credential files by design (that is how the
fetcher talks to providers). If you find a way credentials could leak
out of the machine (logs, snapshots, error messages), open a private
security advisory instead of a public issue.

## License

By contributing, you agree that your contributions are licensed under
the [MIT License](LICENSE).