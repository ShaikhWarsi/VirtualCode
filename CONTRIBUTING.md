# Contributing

Thanks for considering contributing to virtualcode!

## Getting Started

```bash
git clone https://github.com/ShaikhWarsi/VirtualCode.git
cd VirtualCode
npm install
npm run build
```

## Pull Requests

1. Fork the repo and create a feature branch from `master`.
2. Run `npm run typecheck` to verify types.
3. Run `npm run build` to ensure the project compiles.
4. Open a PR with a clear description of the change.

## Guidelines

- Keep error messages user-friendly (no stack traces).
- Wrap all async handler bodies in try/catch.
- Use `sanitizeUI()` for any error text shown to users.
- Avoid adding emoji to user-facing messages.
